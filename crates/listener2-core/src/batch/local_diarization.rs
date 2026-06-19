use hypr_audio_utils::Source;
use hypr_pyannote_local::embedding::EmbeddingExtractor;
use hypr_transcribe_core::{TARGET_SAMPLE_RATE, split_resampled_channels};
use owhisper_interface::{ListenParams, batch};

use super::BatchRunOutput;

const MIN_DIARIZATION_TURN_SECONDS: f64 = 0.25;
const PAUSE_TURN_GAP_SECONDS: f64 = 0.75;
const MIN_SENTENCE_TURN_SECONDS: f64 = 1.5;
const MAX_DIARIZATION_TURN_SECONDS: f64 = 6.0;
const MIN_AUTO_SPEAKER_SECONDS: f64 = 3.0;
const MIN_STABLE_SPEAKER_RUN_SECONDS: f64 = 5.0;
const MAX_PRE_STABLE_ISLAND_SECONDS: f64 = 8.0;
const PRE_STABLE_ISLAND_GAP_SECONDS: f64 = 20.0;
const MAX_AUTO_SPEAKERS: usize = 2;
const SPEAKER_SIMILARITY_THRESHOLD: f32 = 0.70;
const DEBUG_ENV: &str = "LOCAL_DIARIZATION_DEBUG";
const THRESHOLD_ENV: &str = "LOCAL_DIARIZATION_SIMILARITY_THRESHOLD";

pub(super) fn diarize_local_batch_output(
    mut output: BatchRunOutput,
    audio_path: &str,
    params: &ListenParams,
) -> BatchRunOutput {
    let channel_samples = match load_channel_samples(audio_path) {
        Ok(samples) => samples,
        Err(error) => {
            tracing::warn!(error = %error, "local_diarization_audio_load_failed");
            return output;
        }
    };

    for (channel_idx, channel) in output.response.results.channels.iter_mut().enumerate() {
        if !should_diarize_channel(channel_idx, channel_samples.len()) {
            continue;
        }

        let Some(samples) = channel_samples.get(channel_idx) else {
            continue;
        };

        for alternative in &mut channel.alternatives {
            let words = std::mem::take(&mut alternative.words);
            alternative.words = diarize_words_for_channel(words, samples, params, channel_idx);
        }
    }

    output
}

fn load_channel_samples(audio_path: &str) -> Result<Vec<Vec<f32>>, Box<dyn std::error::Error>> {
    let source = hypr_audio_utils::source_from_path(audio_path)?;
    let channel_count = u16::from(source.channels()).max(1) as usize;
    let resampled = hypr_audio_utils::resample_audio(source, TARGET_SAMPLE_RATE)?;
    Ok(split_resampled_channels(&resampled, channel_count))
}

fn diarize_words_for_channel(
    mut words: Vec<batch::Word>,
    samples: &[f32],
    params: &ListenParams,
    channel_idx: usize,
) -> Vec<batch::Word> {
    if words.len() < 2 || samples.is_empty() {
        return words;
    }

    if should_keep_existing_speaker_labels(&words, params) {
        return words;
    }

    debug_word_timeline(channel_idx, samples, &words);

    let turns = word_turns(&words);
    if turns.len() < 2 {
        return words;
    }

    let force_speaker_count = params.num_speakers.is_some();
    let target_speakers = target_speaker_count(params, turns.len());
    if target_speakers <= 1 {
        return words;
    }

    let mut assignments = match compute_turn_speakers(
        &turns,
        samples,
        target_speakers,
        force_speaker_count,
        channel_idx,
    ) {
        Ok(assignments) => assignments,
        Err(error) => {
            tracing::warn!(error = %error, "local_diarization_failed");
            return words;
        }
    };

    assignments = post_process_assignments(&turns, assignments, force_speaker_count);

    apply_turn_speakers_to_words(&mut words, &turns, &assignments);

    words
}

fn should_keep_existing_speaker_labels(words: &[batch::Word], params: &ListenParams) -> bool {
    let existing_speakers = words
        .iter()
        .filter_map(|word| word.speaker)
        .collect::<std::collections::BTreeSet<_>>();

    if existing_speakers.is_empty() {
        return false;
    }

    match params.num_speakers {
        Some(requested) => existing_speakers.len() == requested as usize,
        None => true,
    }
}

fn should_diarize_channel(channel_idx: usize, channel_count: usize) -> bool {
    channel_count == 1 || channel_idx != 0
}

#[derive(Debug, Clone)]
struct WordTurn {
    word_range: std::ops::Range<usize>,
    start: f64,
    end: f64,
}

fn word_turns(words: &[batch::Word]) -> Vec<WordTurn> {
    let mut turns = Vec::new();
    let mut start_idx = 0usize;

    for (idx, word) in words.iter().enumerate().skip(1) {
        let previous_end = words[idx - 1].end;
        let gap = word.start - previous_end;
        if gap > PAUSE_TURN_GAP_SECONDS {
            push_turn(
                &mut turns,
                start_idx..idx,
                words[start_idx].start,
                previous_end,
            );
            start_idx = idx;
            continue;
        }

        let start = words[start_idx].start;
        let end = word.end;
        if idx + 1 < words.len() && should_split_turn_at_word(word, end - start) {
            push_turn(&mut turns, start_idx..idx + 1, start, end);
            start_idx = idx + 1;
        }
    }

    if start_idx < words.len() {
        push_turn(
            &mut turns,
            start_idx..words.len(),
            words[start_idx].start,
            words[words.len() - 1].end,
        );
    }
    turns
}

fn should_split_turn_at_word(word: &batch::Word, duration: f64) -> bool {
    if duration >= MAX_DIARIZATION_TURN_SECONDS {
        return true;
    }

    duration >= MIN_SENTENCE_TURN_SECONDS && ends_sentence(word)
}

fn ends_sentence(word: &batch::Word) -> bool {
    let text = word
        .punctuated_word
        .as_deref()
        .unwrap_or(word.word.as_str())
        .trim_end_matches(|ch: char| ch == '"' || ch == '\'' || ch == ')' || ch == ']');

    text.ends_with('.') || text.ends_with('!') || text.ends_with('?')
}

fn push_turn(turns: &mut Vec<WordTurn>, word_range: std::ops::Range<usize>, start: f64, end: f64) {
    if end - start >= MIN_DIARIZATION_TURN_SECONDS {
        turns.push(WordTurn {
            word_range,
            start,
            end,
        });
    }
}

fn target_speaker_count(params: &ListenParams, turn_count: usize) -> usize {
    let requested = params
        .num_speakers
        .or(params.max_speakers)
        .map(|value| value as usize);
    let min_speakers = (params.min_speakers.unwrap_or(1) as usize).min(turn_count);
    requested
        .unwrap_or_else(|| MAX_AUTO_SPEAKERS.min(turn_count))
        .clamp(min_speakers, turn_count)
}

fn compute_turn_speakers(
    turns: &[WordTurn],
    samples: &[f32],
    target_speakers: usize,
    force_speaker_count: bool,
    channel_idx: usize,
) -> Result<Vec<usize>, hypr_pyannote_local::Error> {
    let mut extractor = EmbeddingExtractor::new();
    let mut embeddings = Vec::with_capacity(turns.len());

    for (turn_idx, turn) in turns.iter().enumerate() {
        let start = seconds_to_sample(turn.start, samples.len());
        let end = seconds_to_sample(turn.end, samples.len());
        debug_turn_window(channel_idx, turn_idx, turn, start, end, samples.len());
        if start >= end {
            continue;
        }
        embeddings.push(extractor.compute(samples[start..end].iter().copied())?);
    }

    if embeddings.len() != turns.len() {
        return Ok(vec![0; turns.len()]);
    }

    let assignments = cluster_embeddings(
        &embeddings,
        target_speakers,
        force_speaker_count,
        channel_idx,
    );
    debug_assignments(channel_idx, turns, &assignments);

    Ok(assignments)
}

fn debug_enabled() -> bool {
    std::env::var(DEBUG_ENV)
        .is_ok_and(|value| !value.is_empty() && value != "0" && value != "false")
}

fn debug_word_timeline(channel_idx: usize, samples: &[f32], words: &[batch::Word]) {
    if !debug_enabled() {
        return;
    }

    let audio_duration = samples.len() as f64 / TARGET_SAMPLE_RATE as f64;
    tracing::info!(
        hyprnote.audio.channel = channel_idx,
        hyprnote.audio.duration_seconds = audio_duration,
        hyprnote.audio.samples = samples.len(),
        hyprnote.stt.words = words.len(),
        hyprnote.stt.first_word = %words.first().map(|word| word.word.as_str()).unwrap_or(""),
        hyprnote.stt.first_start = words.first().map(|word| word.start),
        hyprnote.stt.first_end = words.first().map(|word| word.end),
        hyprnote.stt.last_word = %words.last().map(|word| word.word.as_str()).unwrap_or(""),
        hyprnote.stt.last_start = words.last().map(|word| word.start),
        hyprnote.stt.last_end = words.last().map(|word| word.end),
        "local_diarization_word_timeline"
    );
}

fn debug_turn_window(
    channel_idx: usize,
    turn_idx: usize,
    turn: &WordTurn,
    sample_start: usize,
    sample_end: usize,
    sample_count: usize,
) {
    if !debug_enabled() {
        return;
    }

    tracing::info!(
        hyprnote.audio.channel = channel_idx,
        hyprnote.diarization.turn = turn_idx,
        hyprnote.diarization.word_start = turn.word_range.start,
        hyprnote.diarization.word_end = turn.word_range.end,
        hyprnote.diarization.start_seconds = turn.start,
        hyprnote.diarization.end_seconds = turn.end,
        hyprnote.diarization.sample_start = sample_start,
        hyprnote.diarization.sample_end = sample_end,
        hyprnote.audio.samples = sample_count,
        "local_diarization_turn_window"
    );
}

fn debug_assignments(channel_idx: usize, turns: &[WordTurn], assignments: &[usize]) {
    if !debug_enabled() {
        return;
    }

    for (turn_idx, (turn, speaker)) in turns.iter().zip(assignments).enumerate() {
        tracing::info!(
            hyprnote.audio.channel = channel_idx,
            hyprnote.diarization.turn = turn_idx,
            hyprnote.diarization.word_start = turn.word_range.start,
            hyprnote.diarization.word_end = turn.word_range.end,
            hyprnote.diarization.start_seconds = turn.start,
            hyprnote.diarization.end_seconds = turn.end,
            hyprnote.diarization.speaker = speaker,
            "local_diarization_turn_assignment"
        );
    }
}

fn seconds_to_sample(seconds: f64, sample_count: usize) -> usize {
    ((seconds.max(0.0) * TARGET_SAMPLE_RATE as f64).round() as usize).min(sample_count)
}

fn cluster_embeddings(
    embeddings: &[Vec<f32>],
    target_speakers: usize,
    force_speaker_count: bool,
    channel_idx: usize,
) -> Vec<usize> {
    if embeddings.is_empty() {
        return Vec::new();
    }

    let threshold = speaker_similarity_threshold();
    let normalized_embeddings = embeddings
        .iter()
        .map(|embedding| normalize(embedding))
        .collect::<Vec<_>>();
    let mut centroids = initialize_centroids(
        &normalized_embeddings,
        target_speakers,
        force_speaker_count,
        threshold,
        channel_idx,
    );

    if centroids.len() == 1 {
        return vec![0; embeddings.len()];
    }

    let mut assignments = vec![0; embeddings.len()];
    for _ in 0..8 {
        let mut changed = false;
        for (idx, embedding) in normalized_embeddings.iter().enumerate() {
            let speaker = nearest_centroid(embedding, &centroids);
            changed |= assignments[idx] != speaker;
            assignments[idx] = speaker;
        }

        centroids = recompute_centroids(&normalized_embeddings, &assignments, centroids.len());
        if !changed {
            break;
        }
    }

    assignments
}

fn initialize_centroids(
    normalized_embeddings: &[Vec<f32>],
    target_speakers: usize,
    force_speaker_count: bool,
    threshold: f32,
    channel_idx: usize,
) -> Vec<Vec<f32>> {
    let mut centroids = Vec::new();

    if force_speaker_count && target_speakers > 1 && normalized_embeddings.len() > 1 {
        let (left, right) = farthest_pair(normalized_embeddings);
        centroids.push(normalized_embeddings[left].clone());
        centroids.push(normalized_embeddings[right].clone());
    } else if let Some(first) = normalized_embeddings.first() {
        centroids.push(first.clone());
    }

    while centroids.len() < target_speakers && centroids.len() < normalized_embeddings.len() {
        let Some((idx, best_similarity)) =
            farthest_from_centroids(normalized_embeddings, &centroids)
        else {
            break;
        };
        let creates_speaker = force_speaker_count || best_similarity < threshold;
        debug_centroid_decision(
            channel_idx,
            idx,
            centroids.len(),
            target_speakers,
            threshold,
            best_similarity,
            creates_speaker,
            force_speaker_count,
        );

        if !creates_speaker {
            break;
        }

        centroids.push(normalized_embeddings[idx].clone());
    }

    centroids
}

fn farthest_pair(embeddings: &[Vec<f32>]) -> (usize, usize) {
    let mut best = (0usize, 1usize);
    let mut best_similarity = f32::INFINITY;

    for left in 0..embeddings.len() {
        for right in left + 1..embeddings.len() {
            let similarity = cosine_similarity(&embeddings[left], &embeddings[right]);
            if similarity < best_similarity {
                best = (left, right);
                best_similarity = similarity;
            }
        }
    }

    best
}

fn farthest_from_centroids(
    embeddings: &[Vec<f32>],
    centroids: &[Vec<f32>],
) -> Option<(usize, f32)> {
    embeddings
        .iter()
        .enumerate()
        .map(|(idx, embedding)| {
            let best_similarity = centroids
                .iter()
                .map(|centroid| cosine_similarity(embedding, centroid))
                .fold(f32::NEG_INFINITY, f32::max);
            (idx, best_similarity)
        })
        .min_by(|(_, left), (_, right)| {
            left.partial_cmp(right).unwrap_or(std::cmp::Ordering::Equal)
        })
}

fn merge_short_lived_speakers(turns: &[WordTurn], assignments: Vec<usize>) -> Vec<usize> {
    if turns.len() != assignments.len() || assignments.is_empty() {
        return assignments;
    }

    let speaker_count = assignments.iter().copied().max().unwrap_or(0) + 1;
    if speaker_count <= 1 {
        return assignments;
    }

    let mut durations = vec![0.0; speaker_count];
    let mut turn_counts = vec![0usize; speaker_count];
    for (turn, speaker) in turns.iter().zip(&assignments) {
        durations[*speaker] += (turn.end - turn.start).max(0.0);
        turn_counts[*speaker] += 1;
    }

    let dominant_speaker = durations
        .iter()
        .enumerate()
        .max_by(|(_, left), (_, right)| {
            left.partial_cmp(right).unwrap_or(std::cmp::Ordering::Equal)
        })
        .map(|(speaker, _)| speaker)
        .unwrap_or(0);

    let mut merged = assignments.clone();
    for speaker in 0..speaker_count {
        let is_short_lived =
            turn_counts[speaker] <= 1 || durations[speaker] < MIN_AUTO_SPEAKER_SECONDS;
        if !is_short_lived {
            continue;
        }

        let replacement = nearest_stable_neighbor(turns, &assignments, speaker, &durations)
            .unwrap_or(if speaker == dominant_speaker {
                nearest_other_speaker(&durations, speaker).unwrap_or(dominant_speaker)
            } else {
                dominant_speaker
            });

        for (idx, assigned) in assignments.iter().enumerate() {
            if *assigned == speaker {
                merged[idx] = replacement;
            }
        }
    }

    compact_speaker_indexes(merged)
}

#[derive(Debug, Clone, PartialEq)]
struct SpeakerRun {
    turn_range: std::ops::Range<usize>,
    speaker: usize,
    start: f64,
    end: f64,
    duration: f64,
}

fn merge_pre_stable_speaker_islands(turns: &[WordTurn], assignments: Vec<usize>) -> Vec<usize> {
    if turns.len() != assignments.len() || assignments.is_empty() {
        return assignments;
    }

    let runs = speaker_runs(turns, &assignments);
    if runs.len() < 2 {
        return assignments;
    }

    let speaker_count = assignments.iter().copied().max().unwrap_or(0) + 1;
    let mut first_stable_start = vec![None; speaker_count];
    let mut durations = vec![0.0; speaker_count];

    for run in &runs {
        durations[run.speaker] += run.duration;
        if run.duration >= MIN_STABLE_SPEAKER_RUN_SECONDS
            && first_stable_start[run.speaker].is_none()
        {
            first_stable_start[run.speaker] = Some(run.start);
        }
    }

    let dominant_speaker = durations
        .iter()
        .enumerate()
        .max_by(|(_, left), (_, right)| {
            left.partial_cmp(right).unwrap_or(std::cmp::Ordering::Equal)
        })
        .map(|(speaker, _)| speaker)
        .unwrap_or(0);

    let mut merged = assignments.clone();
    for (run_idx, run) in runs.iter().enumerate() {
        let Some(first_stable_start) = first_stable_start[run.speaker] else {
            continue;
        };

        let is_pre_stable_island = run.end + PRE_STABLE_ISLAND_GAP_SECONDS < first_stable_start
            && run.duration <= MAX_PRE_STABLE_ISLAND_SECONDS;
        if !is_pre_stable_island {
            continue;
        }

        let replacement =
            nearest_run_speaker(&runs, run_idx).unwrap_or(if run.speaker == dominant_speaker {
                nearest_other_speaker(&durations, run.speaker).unwrap_or(dominant_speaker)
            } else {
                dominant_speaker
            });

        for idx in run.turn_range.clone() {
            merged[idx] = replacement;
        }
    }

    compact_speaker_indexes(merged)
}

fn speaker_runs(turns: &[WordTurn], assignments: &[usize]) -> Vec<SpeakerRun> {
    if turns.is_empty() || assignments.is_empty() {
        return Vec::new();
    }

    let mut runs = Vec::new();
    let mut start_idx = 0usize;
    let mut speaker = assignments[0];

    for idx in 1..assignments.len() {
        if assignments[idx] == speaker {
            continue;
        }

        runs.push(build_speaker_run(turns, assignments, start_idx..idx));
        start_idx = idx;
        speaker = assignments[idx];
    }

    runs.push(build_speaker_run(
        turns,
        assignments,
        start_idx..assignments.len(),
    ));
    runs
}

fn build_speaker_run(
    turns: &[WordTurn],
    assignments: &[usize],
    turn_range: std::ops::Range<usize>,
) -> SpeakerRun {
    let speaker = assignments[turn_range.start];
    let start = turns[turn_range.start].start;
    let end = turns[turn_range.end - 1].end;
    let duration = turns[turn_range.clone()]
        .iter()
        .map(|turn| (turn.end - turn.start).max(0.0))
        .sum();

    SpeakerRun {
        turn_range,
        speaker,
        start,
        end,
        duration,
    }
}

fn nearest_run_speaker(runs: &[SpeakerRun], run_idx: usize) -> Option<usize> {
    let run = runs.get(run_idx)?;

    let previous = runs[..run_idx]
        .iter()
        .rev()
        .find(|candidate| candidate.speaker != run.speaker);
    let next = runs[run_idx + 1..]
        .iter()
        .find(|candidate| candidate.speaker != run.speaker);

    match (previous, next) {
        (Some(previous), Some(next)) => {
            let previous_distance = (run.start - previous.end).max(0.0);
            let next_distance = (next.start - run.end).max(0.0);
            Some(if previous_distance <= next_distance {
                previous.speaker
            } else {
                next.speaker
            })
        }
        (Some(previous), None) => Some(previous.speaker),
        (None, Some(next)) => Some(next.speaker),
        (None, None) => None,
    }
}

fn apply_turn_speakers_to_words(
    words: &mut [batch::Word],
    turns: &[WordTurn],
    assignments: &[usize],
) {
    if turns.is_empty() || assignments.is_empty() {
        return;
    }

    let mut speaker_by_word = vec![None; words.len()];
    for (turn, speaker) in turns.iter().zip(assignments) {
        for word_idx in turn.word_range.clone() {
            speaker_by_word[word_idx] = Some(*speaker);
        }
    }

    for (word_idx, word) in words.iter_mut().enumerate() {
        let speaker =
            speaker_by_word[word_idx].or_else(|| nearest_turn_speaker(word, turns, assignments));
        if let Some(speaker) = speaker {
            word.speaker = Some(speaker);
        }
    }
}

fn post_process_assignments(
    turns: &[WordTurn],
    assignments: Vec<usize>,
    force_speaker_count: bool,
) -> Vec<usize> {
    if force_speaker_count {
        return assignments;
    }

    merge_pre_stable_speaker_islands(turns, merge_short_lived_speakers(turns, assignments))
}

fn nearest_turn_speaker(
    word: &batch::Word,
    turns: &[WordTurn],
    assignments: &[usize],
) -> Option<usize> {
    turns
        .iter()
        .zip(assignments)
        .min_by(|(left_turn, _), (right_turn, _)| {
            distance_to_turn(word, left_turn)
                .partial_cmp(&distance_to_turn(word, right_turn))
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .map(|(_, speaker)| *speaker)
}

fn distance_to_turn(word: &batch::Word, turn: &WordTurn) -> f64 {
    if word.end <= turn.start {
        turn.start - word.end
    } else if turn.end <= word.start {
        word.start - turn.end
    } else {
        0.0
    }
}

fn nearest_stable_neighbor(
    turns: &[WordTurn],
    assignments: &[usize],
    speaker: usize,
    durations: &[f64],
) -> Option<usize> {
    let mut best: Option<(usize, f64)> = None;

    for (idx, turn) in turns.iter().enumerate() {
        if assignments[idx] != speaker {
            continue;
        }

        for (other_idx, other_turn) in turns.iter().enumerate() {
            let other_speaker = assignments[other_idx];
            if other_speaker == speaker || durations[other_speaker] < MIN_AUTO_SPEAKER_SECONDS {
                continue;
            }

            let distance = if other_turn.end <= turn.start {
                turn.start - other_turn.end
            } else if turn.end <= other_turn.start {
                other_turn.start - turn.end
            } else {
                0.0
            };

            if best.is_none_or(|(_, best_distance)| distance < best_distance) {
                best = Some((other_speaker, distance));
            }
        }
    }

    best.map(|(speaker, _)| speaker)
}

fn nearest_other_speaker(durations: &[f64], speaker: usize) -> Option<usize> {
    durations
        .iter()
        .enumerate()
        .filter(|(idx, _)| *idx != speaker)
        .max_by(|(_, left), (_, right)| {
            left.partial_cmp(right).unwrap_or(std::cmp::Ordering::Equal)
        })
        .map(|(idx, _)| idx)
}

fn compact_speaker_indexes(assignments: Vec<usize>) -> Vec<usize> {
    let mut next = 0usize;
    let mut remap = std::collections::HashMap::new();

    assignments
        .into_iter()
        .map(|speaker| {
            *remap.entry(speaker).or_insert_with(|| {
                let current = next;
                next += 1;
                current
            })
        })
        .collect()
}

fn speaker_similarity_threshold() -> f32 {
    std::env::var(THRESHOLD_ENV)
        .ok()
        .and_then(|value| value.parse::<f32>().ok())
        .filter(|value| (0.0..=1.0).contains(value))
        .unwrap_or(SPEAKER_SIMILARITY_THRESHOLD)
}

#[allow(clippy::too_many_arguments)]
fn debug_centroid_decision(
    channel_idx: usize,
    turn_idx: usize,
    centroid_count: usize,
    target_speakers: usize,
    threshold: f32,
    best_similarity: f32,
    creates_speaker: bool,
    force_speaker_count: bool,
) {
    if !debug_enabled() {
        return;
    }

    tracing::info!(
        hyprnote.audio.channel = channel_idx,
        hyprnote.diarization.turn = turn_idx,
        hyprnote.diarization.centroids = centroid_count,
        hyprnote.diarization.target_speakers = target_speakers,
        hyprnote.diarization.threshold = threshold,
        hyprnote.diarization.best_similarity = best_similarity,
        hyprnote.diarization.creates_speaker = creates_speaker,
        hyprnote.diarization.force_speaker_count = force_speaker_count,
        "local_diarization_centroid_decision"
    );
}

fn nearest_centroid(embedding: &[f32], centroids: &[Vec<f32>]) -> usize {
    centroids
        .iter()
        .enumerate()
        .max_by(|(_, a), (_, b)| {
            cosine_similarity(embedding, a)
                .partial_cmp(&cosine_similarity(embedding, b))
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .map(|(idx, _)| idx)
        .unwrap_or(0)
}

fn recompute_centroids(
    embeddings: &[Vec<f32>],
    assignments: &[usize],
    speaker_count: usize,
) -> Vec<Vec<f32>> {
    let dim = embeddings.first().map(Vec::len).unwrap_or(0);
    let mut sums = vec![vec![0.0; dim]; speaker_count];
    let mut counts = vec![0usize; speaker_count];

    for (embedding, speaker) in embeddings.iter().zip(assignments) {
        counts[*speaker] += 1;
        for (sum, value) in sums[*speaker].iter_mut().zip(normalize(embedding)) {
            *sum += value;
        }
    }

    sums.into_iter()
        .zip(counts)
        .map(|(sum, count)| {
            if count == 0 {
                sum
            } else {
                normalize(
                    &sum.into_iter()
                        .map(|value| value / count as f32)
                        .collect::<Vec<_>>(),
                )
            }
        })
        .collect()
}

fn normalize(values: &[f32]) -> Vec<f32> {
    let norm = values.iter().map(|value| value * value).sum::<f32>().sqrt();

    if norm <= f32::EPSILON || !norm.is_finite() {
        return values.to_vec();
    }

    values.iter().map(|value| value / norm).collect()
}

fn cosine_similarity(left: &[f32], right: &[f32]) -> f32 {
    left.iter().zip(right).map(|(a, b)| a * b).sum::<f32>()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn word(start: f64, end: f64) -> batch::Word {
        batch::Word {
            word: "word".to_string(),
            start,
            end,
            confidence: 1.0,
            channel: 0,
            speaker: None,
            punctuated_word: None,
        }
    }

    fn punctuated_word(start: f64, end: f64, text: &str) -> batch::Word {
        batch::Word {
            word: text.trim_end_matches(['.', '!', '?']).to_string(),
            start,
            end,
            confidence: 1.0,
            channel: 0,
            speaker: None,
            punctuated_word: Some(text.to_string()),
        }
    }

    #[test]
    fn word_turns_split_on_pause_and_keep_short_utterances() {
        let turns = word_turns(&[
            word(0.0, 0.5),
            word(0.55, 1.2),
            word(2.2, 2.5),
            word(3.5, 4.5),
        ]);

        assert_eq!(turns.len(), 3);
        assert_eq!(turns[0].word_range, 0..2);
        assert_eq!(turns[1].word_range, 2..3);
        assert_eq!(turns[2].word_range, 3..4);
    }

    #[test]
    fn word_turns_split_long_continuous_speech() {
        let turns = word_turns(&[
            word(0.0, 1.0),
            word(1.1, 2.0),
            word(2.1, 3.0),
            word(3.1, 4.0),
            word(4.1, 5.0),
            word(5.1, 6.2),
            word(6.3, 7.0),
        ]);

        assert_eq!(turns.len(), 2);
        assert_eq!(turns[0].word_range, 0..6);
        assert_eq!(turns[1].word_range, 6..7);
    }

    #[test]
    fn word_turns_split_at_sentence_boundary() {
        let turns = word_turns(&[
            punctuated_word(0.0, 0.8, "Good"),
            punctuated_word(0.9, 1.7, "morning."),
            punctuated_word(1.8, 2.3, "Yes"),
            punctuated_word(2.4, 3.0, "exactly."),
        ]);

        assert_eq!(turns.len(), 2);
        assert_eq!(turns[0].word_range, 0..2);
        assert_eq!(turns[1].word_range, 2..4);
    }

    #[test]
    fn target_speaker_count_respects_bounds() {
        let params = ListenParams {
            num_speakers: Some(3),
            min_speakers: Some(4),
            ..Default::default()
        };

        assert_eq!(target_speaker_count(&params, 2), 2);
    }

    #[test]
    fn diarization_preserves_direct_mic_in_dual_capture() {
        assert!(!should_diarize_channel(0, 2));
        assert!(should_diarize_channel(1, 2));
        assert!(should_diarize_channel(0, 1));
    }

    #[test]
    fn forced_speaker_count_overrides_mismatched_existing_labels() {
        let mut words = vec![word(0.0, 1.0), word(2.0, 3.0)];
        words[0].speaker = Some(0);
        words[1].speaker = Some(0);

        assert!(!should_keep_existing_speaker_labels(
            &words,
            &ListenParams {
                num_speakers: Some(2),
                ..Default::default()
            },
        ));
    }

    #[test]
    fn keeps_existing_labels_when_forced_count_matches() {
        let mut words = vec![word(0.0, 1.0), word(2.0, 3.0)];
        words[0].speaker = Some(0);
        words[1].speaker = Some(1);

        assert!(should_keep_existing_speaker_labels(
            &words,
            &ListenParams {
                num_speakers: Some(2),
                ..Default::default()
            },
        ));
    }

    #[test]
    fn cluster_embeddings_separates_distant_vectors() {
        let assignments = cluster_embeddings(
            &[
                vec![1.0, 0.0],
                vec![0.95, 0.05],
                vec![0.0, 1.0],
                vec![0.05, 0.95],
            ],
            2,
            false,
            0,
        );

        assert_eq!(assignments[0], assignments[1]);
        assert_eq!(assignments[2], assignments[3]);
        assert_ne!(assignments[0], assignments[2]);
    }

    #[test]
    fn forced_cluster_uses_global_farthest_pair() {
        let assignments = cluster_embeddings(
            &[
                vec![1.0, 0.0],
                vec![0.98, 0.02],
                vec![0.0, 1.0],
                vec![0.03, 0.97],
            ],
            2,
            true,
            0,
        );

        assert_eq!(assignments[0], assignments[1]);
        assert_eq!(assignments[2], assignments[3]);
        assert_ne!(assignments[0], assignments[2]);
    }

    #[test]
    fn merge_short_lived_speakers_rejoins_single_turn_split() {
        let turns = vec![
            WordTurn {
                word_range: 0..1,
                start: 0.0,
                end: 5.0,
            },
            WordTurn {
                word_range: 1..2,
                start: 6.0,
                end: 7.0,
            },
            WordTurn {
                word_range: 2..3,
                start: 8.0,
                end: 13.0,
            },
        ];

        let assignments = merge_short_lived_speakers(&turns, vec![0, 1, 0]);

        assert_eq!(assignments, vec![0, 0, 0]);
    }

    #[test]
    fn merge_short_lived_speakers_keeps_stable_speakers() {
        let turns = vec![
            WordTurn {
                word_range: 0..1,
                start: 0.0,
                end: 5.0,
            },
            WordTurn {
                word_range: 1..2,
                start: 6.0,
                end: 10.0,
            },
            WordTurn {
                word_range: 2..3,
                start: 11.0,
                end: 15.0,
            },
            WordTurn {
                word_range: 3..4,
                start: 16.0,
                end: 20.0,
            },
        ];

        let assignments = merge_short_lived_speakers(&turns, vec![0, 1, 0, 1]);

        assert_eq!(assignments, vec![0, 1, 0, 1]);
    }

    #[test]
    fn merge_pre_stable_speaker_islands_removes_early_false_entry() {
        let turns = vec![
            WordTurn {
                word_range: 0..1,
                start: 0.0,
                end: 6.0,
            },
            WordTurn {
                word_range: 1..2,
                start: 8.0,
                end: 10.0,
            },
            WordTurn {
                word_range: 2..3,
                start: 12.0,
                end: 18.0,
            },
            WordTurn {
                word_range: 3..4,
                start: 60.0,
                end: 67.0,
            },
            WordTurn {
                word_range: 4..5,
                start: 69.0,
                end: 75.0,
            },
        ];

        let assignments = merge_pre_stable_speaker_islands(&turns, vec![0, 1, 0, 1, 0]);

        assert_eq!(assignments, vec![0, 0, 0, 1, 0]);
    }

    #[test]
    fn forced_speaker_count_keeps_pre_stable_islands() {
        let turns = vec![
            WordTurn {
                word_range: 0..1,
                start: 0.0,
                end: 6.0,
            },
            WordTurn {
                word_range: 1..2,
                start: 8.0,
                end: 10.0,
            },
            WordTurn {
                word_range: 2..3,
                start: 12.0,
                end: 18.0,
            },
            WordTurn {
                word_range: 3..4,
                start: 60.0,
                end: 67.0,
            },
            WordTurn {
                word_range: 4..5,
                start: 69.0,
                end: 75.0,
            },
        ];
        let assignments = vec![0, 1, 0, 1, 0];
        let merged = post_process_assignments(&turns, assignments.clone(), true);

        assert_eq!(merged, assignments);
    }

    #[test]
    fn apply_turn_speakers_fills_words_without_turns_from_nearest_turn() {
        let mut words = vec![word(0.0, 1.0), word(1.1, 1.2), word(2.0, 3.0)];
        let turns = vec![
            WordTurn {
                word_range: 0..1,
                start: 0.0,
                end: 1.0,
            },
            WordTurn {
                word_range: 2..3,
                start: 2.0,
                end: 3.0,
            },
        ];

        apply_turn_speakers_to_words(&mut words, &turns, &[0, 1]);

        assert_eq!(words[0].speaker, Some(0));
        assert_eq!(words[1].speaker, Some(0));
        assert_eq!(words[2].speaker, Some(1));
    }

    #[test]
    #[ignore = "requires local pyannote embedding model assets"]
    fn diarization_smoke_assigns_real_speaker_indexes() {
        let female = read_fixture_samples("female_welcome_1.mp3");
        let male = read_fixture_samples("male_welcome_1.mp3");
        let silence = vec![0.0; TARGET_SAMPLE_RATE as usize];

        let mut samples = Vec::new();
        let female_start = push_segment(&mut samples, &female);
        samples.extend_from_slice(&silence);
        let male_start = push_segment(&mut samples, &male);
        samples.extend_from_slice(&silence);
        let female_again_start = push_segment(&mut samples, &female);

        let audio = tempfile::Builder::new()
            .prefix("diarization-smoke-")
            .suffix(".wav")
            .tempfile()
            .unwrap();
        write_wav(audio.path(), &samples);

        let output = BatchRunOutput {
            session_id: "session".to_string(),
            mode: super::super::BatchRunMode::Direct,
            response: batch::Response {
                metadata: serde_json::json!({}),
                results: batch::Results {
                    channels: vec![batch::Channel {
                        alternatives: vec![batch::Alternatives {
                            transcript: "female male female".to_string(),
                            confidence: 1.0,
                            words: vec![
                                word(
                                    female_start as f64 / TARGET_SAMPLE_RATE as f64,
                                    (female_start + female.len()) as f64
                                        / TARGET_SAMPLE_RATE as f64,
                                ),
                                word(
                                    male_start as f64 / TARGET_SAMPLE_RATE as f64,
                                    (male_start + male.len()) as f64 / TARGET_SAMPLE_RATE as f64,
                                ),
                                word(
                                    female_again_start as f64 / TARGET_SAMPLE_RATE as f64,
                                    (female_again_start + female.len()) as f64
                                        / TARGET_SAMPLE_RATE as f64,
                                ),
                            ],
                        }],
                    }],
                },
            },
        };

        let output = diarize_local_batch_output(
            output,
            audio.path().to_str().unwrap(),
            &ListenParams {
                num_speakers: Some(2),
                ..Default::default()
            },
        );
        let words = &output.response.results.channels[0].alternatives[0].words;

        assert_eq!(words[0].speaker, words[2].speaker);
        assert_ne!(words[0].speaker, words[1].speaker);
        assert!(words.iter().all(|word| word.speaker.is_some()));
    }

    fn read_fixture_samples(name: &str) -> Vec<f32> {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../pyannote-local/src/data")
            .join(name);
        let source = hypr_audio_utils::source_from_path(path).unwrap();
        hypr_audio_utils::resample_audio(source, TARGET_SAMPLE_RATE).unwrap()
    }

    fn push_segment(samples: &mut Vec<f32>, segment: &[f32]) -> usize {
        let start = samples.len();
        samples.extend_from_slice(segment);
        start
    }

    fn write_wav(path: &std::path::Path, samples: &[f32]) {
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: TARGET_SAMPLE_RATE,
            bits_per_sample: 32,
            sample_format: hound::SampleFormat::Float,
        };
        let mut writer = hound::WavWriter::create(path, spec).unwrap();
        for sample in samples {
            writer.write_sample(*sample).unwrap();
        }
        writer.finalize().unwrap();
    }
}
