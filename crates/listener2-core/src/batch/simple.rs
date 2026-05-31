use std::path::Path;

use hypr_audio_utils::Source;
use owhisper_client::{
    AdapterKind, AquaVoiceAdapter, ArgmaxAdapter, AssemblyAIAdapter, BatchSttAdapter,
    DeepgramAdapter, ElevenLabsAdapter, FireworksAdapter, GladiaAdapter, HyprnoteAdapter,
    MistralAdapter, OpenAIAdapter, PyannoteAdapter, SonioxAdapter,
};
use tracing::Instrument;

use super::{BatchParams, BatchRunMode, BatchRunOutput, format_user_friendly_error, session_span};

const SONIQO_BATCH_SAMPLE_RATE: u32 = 16_000;
const SONIQO_ALIGNMENT_MAX_WORD_SECONDS: f64 = 2.5;
const SONIQO_ALIGNMENT_MAX_PRESPEECH_SECONDS: f64 = 1.0;
const SONIQO_ACTIVE_WINDOW_SECONDS: f64 = 0.1;
const SONIQO_ACTIVE_RMS_THRESHOLD: f32 = 0.003;
const SONIQO_ACTIVE_MIN_SPAN_SECONDS: f64 = 0.25;

macro_rules! dispatch_batch {
    ($ak:expr, $params:expr, $lp:expr,
     { $($var:ident => $adapter:ty),+ $(,)? },
     unsupported: [$($unsup:ident),* $(,)?]
    ) => {
        match $ak {
            $(AdapterKind::$var => {
                run_direct_batch::<$adapter>(&AdapterKind::$var.to_string(), $params, $lp).await
            })+
            $(AdapterKind::$unsup => {
                Err(crate::BatchFailure::DirectBatchUnsupported {
                    provider: AdapterKind::$unsup.to_string(),
                }.into())
            })*
        }
    };
}

pub(super) async fn run_direct_batch_for_adapter_kind(
    adapter_kind: AdapterKind,
    params: BatchParams,
    listen_params: owhisper_interface::ListenParams,
) -> crate::Result<BatchRunOutput> {
    dispatch_batch!(adapter_kind, params, listen_params, {
        Argmax => ArgmaxAdapter,
        Deepgram => DeepgramAdapter,
        Soniox => SonioxAdapter,
        AssemblyAI => AssemblyAIAdapter,
        Fireworks => FireworksAdapter,
        OpenAI => OpenAIAdapter,
        Gladia => GladiaAdapter,
        ElevenLabs => ElevenLabsAdapter,
        Pyannote => PyannoteAdapter,
        Mistral => MistralAdapter,
        Hyprnote => HyprnoteAdapter,
        AquaVoice => AquaVoiceAdapter,
    }, unsupported: [DashScope, Cactus])
}

async fn run_direct_batch<A: BatchSttAdapter>(
    provider: &str,
    params: BatchParams,
    listen_params: owhisper_interface::ListenParams,
) -> crate::Result<BatchRunOutput> {
    let span = session_span(&params.session_id);

    async {
        let client = owhisper_client::BatchClient::<A>::builder()
            .api_base(params.base_url.clone())
            .api_key(params.api_key.clone())
            .params(listen_params)
            .build();

        tracing::debug!("transcribing file: {}", params.file_path);
        let response = match client.transcribe_file(&params.file_path).await {
            Ok(response) => response,
            Err(err) => {
                let raw_error = format!("{err:?}");
                let message = format_user_friendly_error(&raw_error);
                tracing::error!(
                    error = %raw_error,
                    hyprnote.error.user_message = %message,
                    "batch transcription failed"
                );
                return Err(crate::BatchFailure::DirectRequestFailed {
                    provider: provider.to_string(),
                    message,
                }
                .into());
            }
        };
        tracing::info!("batch transcription completed");

        Ok(BatchRunOutput {
            session_id: params.session_id,
            mode: BatchRunMode::Direct,
            response,
        })
    }
    .instrument(span)
    .await
}

pub(super) async fn run_soniqo_batch(
    params: BatchParams,
    listen_params: owhisper_interface::ListenParams,
) -> crate::Result<BatchRunOutput> {
    let span = session_span(&params.session_id);

    async {
        let model = listen_params
            .model
            .as_deref()
            .ok_or_else(|| crate::BatchFailure::DirectRequestFailed {
                provider: "soniqo".to_string(),
                message: "Missing Soniqo model.".to_string(),
            })?
            .parse::<hypr_transcribe_soniqo::SoniqoModel>()
            .map_err(|e| crate::BatchFailure::DirectRequestFailed {
                provider: "soniqo".to_string(),
                message: e.to_string(),
            })?;

        let file_path = params.file_path.clone();
        let language = listen_params
            .languages
            .first()
            .map(hypr_language::Language::bcp47_code);

        let prepared_channels = prepare_soniqo_batch_audio(&file_path)?;
        tracing::info!(
            hyprnote.file.path = %file_path,
            hyprnote.soniqo.audio_prepared_channels = prepared_channels.len(),
            "soniqo_batch_transcription_start"
        );

        let channel_count = prepared_channels.len() as u32;
        let mut transcripts = Vec::with_capacity(prepared_channels.len());
        for prepared_channel in prepared_channels {
            let channel_idx = prepared_channel.channel_idx as i32;
            let transcribe_path = prepared_channel.path().to_path_buf();
            let language = language.clone();
            tracing::info!(
                hyprnote.soniqo.channel = channel_idx,
                hyprnote.soniqo.transcribe_path = %transcribe_path.display(),
                "soniqo_batch_channel_transcription_start"
            );

            let mut transcribed = tokio::task::spawn_blocking(move || {
                hypr_transcribe_soniqo::transcribe_file(model, transcribe_path, language.as_deref())
            })
            .await
            .map_err(|e| crate::BatchFailure::DirectRequestFailed {
                provider: "soniqo".to_string(),
                message: format!("Soniqo transcription task failed: {e}"),
            })?
            .map_err(|e| {
                let raw_error = e.to_string();
                crate::BatchFailure::DirectRequestFailed {
                    provider: "soniqo".to_string(),
                    message: format_user_friendly_error(&raw_error),
                }
            })?;
            repair_soniqo_alignment(&mut transcribed, &prepared_channel.profile);

            tracing::info!(
                hyprnote.soniqo.channel = channel_idx,
                hyprnote.stt.transcript_chars = transcribed.text.chars().count(),
                hyprnote.stt.duration_seconds = transcribed.duration_seconds,
                hyprnote.stt.aligned_words = transcribed.words.len(),
                "soniqo_batch_channel_transcription_completed"
            );
            transcripts.push((channel_idx, transcribed));
        }

        tracing::info!("soniqo_batch_transcription_completed");

        let response = hypr_transcribe_soniqo::batch_response_from_transcripts(
            model,
            transcripts,
            channel_count,
        );

        Ok(BatchRunOutput {
            session_id: params.session_id,
            mode: BatchRunMode::Direct,
            response,
        })
    }
    .instrument(span)
    .await
}

struct PreparedSoniqoChannel {
    channel_idx: usize,
    file: tempfile::NamedTempFile,
    profile: SoniqoChannelProfile,
}

impl PreparedSoniqoChannel {
    fn path(&self) -> &Path {
        self.file.path()
    }
}

#[derive(Clone)]
struct SoniqoChannelProfile {
    active_spans: Vec<ActiveSpan>,
}

#[derive(Debug, Clone, Copy)]
struct ActiveSpan {
    start: f64,
    end: f64,
}

fn prepare_soniqo_batch_audio(path: &str) -> crate::Result<Vec<PreparedSoniqoChannel>> {
    let source = hypr_audio_utils::source_from_path(path).map_err(|err| {
        let raw_error = err.to_string();
        crate::BatchFailure::AudioMetadataReadFailed {
            message: format_user_friendly_error(&raw_error),
        }
    })?;
    let channels = u16::from(source.channels()).max(1) as usize;
    let sample_rate = u32::from(source.sample_rate());

    let samples =
        hypr_audio_utils::resample_audio(source, SONIQO_BATCH_SAMPLE_RATE).map_err(|err| {
            crate::BatchFailure::DirectRequestFailed {
                provider: "soniqo".to_string(),
                message: format_user_friendly_error(&err.to_string()),
            }
        })?;
    let channel_samples = if channels <= 1 {
        vec![samples]
    } else {
        hypr_audio_utils::deinterleave(&samples, channels)
    };

    let mut prepared_channels = Vec::with_capacity(channel_samples.len());
    for (channel_idx, samples) in channel_samples.into_iter().enumerate() {
        let profile = SoniqoChannelProfile::from_samples(&samples);
        let prepared = write_soniqo_channel_file(&samples)?;
        tracing::info!(
            hyprnote.file.path = %path,
            hyprnote.soniqo.prepared_path = %prepared.path().display(),
            hyprnote.audio.source_channel = channel_idx,
            hyprnote.audio.source_channels = channels,
            hyprnote.audio.source_sample_rate_hz = sample_rate,
            hyprnote.audio.prepared_sample_count = samples.len(),
            "soniqo_batch_audio_channel_prepared"
        );
        prepared_channels.push(PreparedSoniqoChannel {
            channel_idx,
            file: prepared,
            profile,
        });
    }

    Ok(prepared_channels)
}

impl SoniqoChannelProfile {
    fn from_samples(samples: &[f32]) -> Self {
        Self {
            active_spans: active_spans(samples),
        }
    }
}

fn repair_soniqo_alignment(
    transcript: &mut hypr_transcribe_soniqo::FileTranscript,
    profile: &SoniqoChannelProfile,
) {
    if transcript.words.is_empty()
        || profile.active_spans.is_empty()
        || !soniqo_alignment_is_suspicious(&transcript.words, profile)
    {
        return;
    }

    let original_first_start = transcript.words.first().map(|word| word.start);
    let original_last_end = transcript.words.last().map(|word| word.end);
    redistribute_words_over_active_spans(&mut transcript.words, &profile.active_spans);

    tracing::warn!(
        hyprnote.stt.words = transcript.words.len(),
        hyprnote.stt.original_first_start = original_first_start,
        hyprnote.stt.original_last_end = original_last_end,
        hyprnote.stt.repaired_first_start = transcript.words.first().map(|word| word.start),
        hyprnote.stt.repaired_last_end = transcript.words.last().map(|word| word.end),
        "soniqo_batch_alignment_repaired"
    );
}

fn soniqo_alignment_is_suspicious(
    words: &[hypr_transcribe_soniqo::AlignedWord],
    profile: &SoniqoChannelProfile,
) -> bool {
    let Some(first_active) = profile.active_spans.first() else {
        return false;
    };

    let starts_too_early = words.first().is_some_and(|word| {
        word.start + SONIQO_ALIGNMENT_MAX_PRESPEECH_SECONDS < first_active.start
    });
    let has_huge_word = words
        .iter()
        .any(|word| word.end - word.start > SONIQO_ALIGNMENT_MAX_WORD_SECONDS);

    starts_too_early || has_huge_word
}

fn redistribute_words_over_active_spans(
    words: &mut [hypr_transcribe_soniqo::AlignedWord],
    spans: &[ActiveSpan],
) {
    let mut word_indexes_by_span = vec![Vec::new(); spans.len()];

    for (word_idx, word) in words.iter().enumerate() {
        let midpoint = (word.start + word.end) / 2.0;
        let span_idx = nearest_span(midpoint, spans);
        word_indexes_by_span[span_idx].push(word_idx);
    }

    for (span, word_indexes) in spans.iter().zip(word_indexes_by_span) {
        if word_indexes.is_empty() {
            continue;
        }

        let duration = (span.end - span.start).max(0.05);
        let word_count = word_indexes.len();
        let step = duration / word_count as f64;
        for (offset, word_idx) in word_indexes.into_iter().enumerate() {
            let start = span.start + step * offset as f64;
            let end = if offset + 1 == word_count {
                span.end
            } else {
                (start + step).min(span.end)
            };
            words[word_idx].start = start;
            words[word_idx].end = end.max(start + 0.05);
        }
    }
}

fn nearest_span(seconds: f64, spans: &[ActiveSpan]) -> usize {
    spans
        .iter()
        .enumerate()
        .min_by(|(_, left), (_, right)| {
            distance_to_span(seconds, left)
                .partial_cmp(&distance_to_span(seconds, right))
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .map(|(idx, _)| idx)
        .unwrap_or(0)
}

fn distance_to_span(seconds: f64, span: &ActiveSpan) -> f64 {
    if seconds < span.start {
        span.start - seconds
    } else if seconds > span.end {
        seconds - span.end
    } else {
        0.0
    }
}

fn active_spans(samples: &[f32]) -> Vec<ActiveSpan> {
    let window = (SONIQO_BATCH_SAMPLE_RATE as f64 * SONIQO_ACTIVE_WINDOW_SECONDS).round() as usize;
    let window = window.max(1);
    let mut spans = Vec::new();
    let mut active_start = None;

    for start in (0..samples.len()).step_by(window) {
        let end = (start + window).min(samples.len());
        let rms = rms(&samples[start..end]);
        if rms > SONIQO_ACTIVE_RMS_THRESHOLD {
            active_start.get_or_insert(start);
        } else if let Some(span_start) = active_start.take() {
            push_active_span(&mut spans, span_start, start);
        }
    }

    if let Some(span_start) = active_start {
        push_active_span(&mut spans, span_start, samples.len());
    }

    spans
}

fn push_active_span(spans: &mut Vec<ActiveSpan>, start_sample: usize, end_sample: usize) {
    let start = start_sample as f64 / SONIQO_BATCH_SAMPLE_RATE as f64;
    let end = end_sample as f64 / SONIQO_BATCH_SAMPLE_RATE as f64;
    if end - start >= SONIQO_ACTIVE_MIN_SPAN_SECONDS {
        spans.push(ActiveSpan { start, end });
    }
}

fn rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }

    let sum = samples.iter().map(|sample| sample * sample).sum::<f32>();
    (sum / samples.len() as f32).sqrt()
}

fn write_soniqo_channel_file(samples: &[f32]) -> crate::Result<tempfile::NamedTempFile> {
    let prepared = tempfile::Builder::new()
        .prefix("soniqo-batch-mono-")
        .suffix(".wav")
        .tempfile()
        .map_err(|err| crate::BatchFailure::DirectRequestFailed {
            provider: "soniqo".to_string(),
            message: format!("Failed to create temporary Soniqo audio file: {err}"),
        })?;

    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: SONIQO_BATCH_SAMPLE_RATE,
        bits_per_sample: 32,
        sample_format: hound::SampleFormat::Float,
    };
    let mut writer = hound::WavWriter::create(prepared.path(), spec).map_err(|err| {
        crate::BatchFailure::DirectRequestFailed {
            provider: "soniqo".to_string(),
            message: format!("Failed to write temporary Soniqo audio file: {err}"),
        }
    })?;
    for sample in samples.iter().copied() {
        writer
            .write_sample(sample.clamp(-1.0, 1.0))
            .map_err(|err| crate::BatchFailure::DirectRequestFailed {
                provider: "soniqo".to_string(),
                message: format!("Failed to write temporary Soniqo audio sample: {err}"),
            })?;
    }
    writer
        .finalize()
        .map_err(|err| crate::BatchFailure::DirectRequestFailed {
            provider: "soniqo".to_string(),
            message: format!("Failed to finalize temporary Soniqo audio file: {err}"),
        })?;

    Ok(prepared)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prepare_soniqo_batch_audio_splits_stereo_channels() {
        let temp_dir = tempfile::tempdir().unwrap();
        let path = temp_dir.path().join("speaker-only.wav");
        let spec = hound::WavSpec {
            channels: 2,
            sample_rate: 48_000,
            bits_per_sample: 32,
            sample_format: hound::SampleFormat::Float,
        };
        let mut writer = hound::WavWriter::create(&path, spec).unwrap();
        for index in 0..4_800 {
            writer.write_sample(0.0f32).unwrap();
            let speaker_sample = if index % 64 < 32 { 0.5f32 } else { -0.5f32 };
            writer.write_sample(speaker_sample).unwrap();
        }
        writer.finalize().unwrap();

        let prepared = prepare_soniqo_batch_audio(path.to_str().unwrap()).unwrap();
        assert_eq!(prepared.len(), 2);

        let mut reader = hound::WavReader::open(prepared[0].path()).unwrap();
        assert_eq!(reader.spec().channels, 1);
        assert_eq!(reader.spec().sample_rate, SONIQO_BATCH_SAMPLE_RATE);
        let direct_mic_max_abs = reader
            .samples::<f32>()
            .map(|sample| sample.unwrap().abs())
            .fold(0.0f32, f32::max);
        assert!(
            direct_mic_max_abs < 0.01,
            "direct mic channel should stay isolated"
        );

        let mut reader = hound::WavReader::open(prepared[1].path()).unwrap();
        let max_abs = reader
            .samples::<f32>()
            .map(|sample| sample.unwrap().abs())
            .fold(0.0f32, f32::max);
        assert!(max_abs > 0.01, "speaker channel should be preserved");
    }

    #[test]
    fn active_spans_ignore_short_noise() {
        let mut samples = vec![0.0; SONIQO_BATCH_SAMPLE_RATE as usize * 3];
        samples[1_600..2_400].fill(0.01);
        samples[16_000..24_000].fill(0.01);

        let spans = active_spans(&samples);

        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].start, 1.0);
        assert_eq!(spans[0].end, 1.5);
    }

    #[test]
    fn repairs_words_that_start_before_real_speech() {
        let profile = SoniqoChannelProfile {
            active_spans: vec![
                ActiveSpan {
                    start: 5.2,
                    end: 7.0,
                },
                ActiveSpan {
                    start: 10.6,
                    end: 11.5,
                },
            ],
        };
        let mut transcript = hypr_transcribe_soniqo::FileTranscript {
            text: "Bom dia next".to_string(),
            duration_seconds: 13.56,
            words: vec![
                aligned_word("Bom", 1.12, 1.12),
                aligned_word("dia", 1.28, 6.4),
                aligned_word("next", 7.6, 11.36),
            ],
        };

        repair_soniqo_alignment(&mut transcript, &profile);

        assert!(transcript.words[0].start >= 5.2);
        assert!(transcript.words[1].end <= 7.0);
        assert!(transcript.words[2].start >= 10.6);
        assert!(transcript.words[2].end <= 11.5);
    }

    fn aligned_word(word: &str, start: f64, end: f64) -> hypr_transcribe_soniqo::AlignedWord {
        hypr_transcribe_soniqo::AlignedWord {
            word: word.to_string(),
            start,
            end,
            confidence: 1.0,
        }
    }
}
