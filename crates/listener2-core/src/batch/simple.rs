use std::path::PathBuf;

use hypr_audio_utils::Source;
use owhisper_client::{
    AdapterKind, AquaVoiceAdapter, ArgmaxAdapter, AssemblyAIAdapter, BatchSttAdapter,
    DeepgramAdapter, ElevenLabsAdapter, FireworksAdapter, GladiaAdapter, HyprnoteAdapter,
    MistralAdapter, OpenAIAdapter, PyannoteAdapter, SonioxAdapter,
};
use tracing::Instrument;

use super::{BatchParams, BatchRunMode, BatchRunOutput, format_user_friendly_error, session_span};

const SONIQO_BATCH_SAMPLE_RATE: u32 = 16_000;

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

        let prepared_audio = prepare_soniqo_batch_audio(&file_path)?;
        let transcribe_path = prepared_audio
            .as_ref()
            .map(|file| file.path().to_path_buf())
            .unwrap_or_else(|| PathBuf::from(&file_path));
        tracing::info!(
            hyprnote.file.path = %file_path,
            hyprnote.soniqo.transcribe_path = %transcribe_path.display(),
            hyprnote.soniqo.audio_preprocessed = prepared_audio.is_some(),
            "soniqo_batch_transcription_start"
        );

        let transcribed = tokio::task::spawn_blocking(move || {
            let _prepared_audio = prepared_audio;
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

        tracing::info!(
            hyprnote.stt.transcript_chars = transcribed.text.chars().count(),
            hyprnote.stt.duration_seconds = transcribed.duration_seconds,
            "soniqo_batch_transcription_completed"
        );

        let response = hypr_transcribe_soniqo::batch_response_from_text(
            model,
            transcribed.text,
            transcribed.duration_seconds,
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

fn prepare_soniqo_batch_audio(path: &str) -> crate::Result<Option<tempfile::NamedTempFile>> {
    let source = hypr_audio_utils::source_from_path(path).map_err(|err| {
        let raw_error = err.to_string();
        crate::BatchFailure::AudioMetadataReadFailed {
            message: format_user_friendly_error(&raw_error),
        }
    })?;
    let channels = u16::from(source.channels()).max(1) as usize;
    let sample_rate = u32::from(source.sample_rate());

    if channels == 1 && sample_rate == SONIQO_BATCH_SAMPLE_RATE {
        tracing::info!(
            hyprnote.file.path = %path,
            hyprnote.audio.channels = channels,
            hyprnote.audio.sample_rate_hz = sample_rate,
            "soniqo_batch_audio_passthrough"
        );
        return Ok(None);
    }

    let samples =
        hypr_audio_utils::resample_audio(source, SONIQO_BATCH_SAMPLE_RATE).map_err(|err| {
            crate::BatchFailure::DirectRequestFailed {
                provider: "soniqo".to_string(),
                message: format_user_friendly_error(&err.to_string()),
            }
        })?;
    let mono_samples = hypr_audio_utils::mono_frames(samples.into_iter(), channels)
        .map(|sample| sample.clamp(-1.0, 1.0))
        .collect::<Vec<_>>();

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
    for sample in mono_samples.iter().copied() {
        writer
            .write_sample(sample)
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

    tracing::info!(
        hyprnote.file.path = %path,
        hyprnote.soniqo.prepared_path = %prepared.path().display(),
        hyprnote.audio.source_channels = channels,
        hyprnote.audio.source_sample_rate_hz = sample_rate,
        hyprnote.audio.prepared_sample_count = mono_samples.len(),
        "soniqo_batch_audio_prepared"
    );

    Ok(Some(prepared))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prepare_soniqo_batch_audio_mixes_stereo_channels() {
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

        let prepared = prepare_soniqo_batch_audio(path.to_str().unwrap())
            .unwrap()
            .expect("stereo audio should be prepared");
        let mut reader = hound::WavReader::open(prepared.path()).unwrap();
        assert_eq!(reader.spec().channels, 1);
        assert_eq!(reader.spec().sample_rate, SONIQO_BATCH_SAMPLE_RATE);

        let max_abs = reader
            .samples::<f32>()
            .map(|sample| sample.unwrap().abs())
            .fold(0.0f32, f32::max);
        assert!(max_abs > 0.01, "speaker channel should survive downmix");
    }
}
