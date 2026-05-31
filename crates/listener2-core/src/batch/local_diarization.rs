use hypr_audio_utils::Source;
use hypr_pyannote_local::embedding::EmbeddingExtractor;
use hypr_transcribe_core::{TARGET_SAMPLE_RATE, split_resampled_channels};
use owhisper_interface::{ListenParams, batch};

use super::BatchRunOutput;

const MIN_DIARIZATION_TURN_SECONDS: f64 = 0.8;
const MAX_AUTO_SPEAKERS: usize = 4;
const SPEAKER_SIMILARITY_THRESHOLD: f32 = 0.80;
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
    if words.len() < 2 || samples.is_empty() || words.iter().any(|word| word.speaker.is_some()) {
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

    let assignments = match compute_turn_speakers(
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

    if assignments.iter().all(|speaker| *speaker == assignments[0]) {
        return words;
    }

    for (turn, speaker) in turns.iter().zip(assignments) {
        for word in &mut words[turn.word_range.clone()] {
            word.speaker = Some(speaker);
        }
    }

    words
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
    let mut start = words[0].start;
    let mut end = words[0].end;

    for (idx, word) in words.iter().enumerate().skip(1) {
        let gap = word.start - end;
        if gap > 0.75 {
            push_turn(&mut turns, start_idx..idx, start, end);
            start_idx = idx;
            start = word.start;
        }
        end = word.end;
    }

    push_turn(&mut turns, start_idx..words.len(), start, end);
    turns
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
    let mut centroids = vec![normalize(&embeddings[0])];
    for (idx, embedding) in embeddings.iter().enumerate().skip(1) {
        let normalized = normalize(embedding);
        let best_similarity = centroids
            .iter()
            .map(|centroid| cosine_similarity(&normalized, centroid))
            .fold(f32::NEG_INFINITY, f32::max);
        let creates_speaker = centroids.len() < target_speakers
            && (force_speaker_count || best_similarity < threshold);
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

        if creates_speaker {
            centroids.push(normalized);
        }
    }

    if centroids.len() == 1 {
        return vec![0; embeddings.len()];
    }

    let mut assignments = vec![0; embeddings.len()];
    for _ in 0..8 {
        let mut changed = false;
        for (idx, embedding) in embeddings.iter().enumerate() {
            let normalized = normalize(embedding);
            let speaker = nearest_centroid(&normalized, &centroids);
            changed |= assignments[idx] != speaker;
            assignments[idx] = speaker;
        }

        centroids = recompute_centroids(embeddings, &assignments, centroids.len());
        if !changed {
            break;
        }
    }

    assignments
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

    #[test]
    fn word_turns_split_on_pause_and_drop_short_turns() {
        let turns = word_turns(&[
            word(0.0, 0.5),
            word(0.55, 1.2),
            word(2.2, 2.5),
            word(3.5, 4.5),
        ]);

        assert_eq!(turns.len(), 2);
        assert_eq!(turns[0].word_range, 0..2);
        assert_eq!(turns[1].word_range, 3..4);
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
