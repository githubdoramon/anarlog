use std::str::FromStr;

use hypr_audio_utils::Source;
use hypr_embedding::{EMBEDDING_DIM, EmbeddingExtractor};
use hypr_transcribe_core::{TARGET_SAMPLE_RATE, split_resampled_channels};
use hypr_transcription_core::listener2 as core;

use crate::listener2::Listener2PluginExt;
use crate::{TranscriptionParams, VoiceEmbeddingObservation, VoiceEmbeddingWindow};

#[tauri::command]
#[specta::specta]
pub async fn start_transcription<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    params: TranscriptionParams,
) -> Result<(), String> {
    app.listener2()
        .start_transcription(params)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn stop_transcription<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    session_id: String,
) -> Result<(), String> {
    app.listener2().stop_transcription(session_id).await;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn parse_subtitle<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    path: String,
) -> Result<core::Subtitle, String> {
    app.listener2().parse_subtitle(path)
}

#[tauri::command]
#[specta::specta]
pub async fn export_to_vtt<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    session_id: String,
    words: Vec<core::VttWord>,
) -> Result<String, String> {
    app.listener2().export_to_vtt(session_id, words)
}

#[tauri::command]
#[specta::specta]
pub async fn run_denoise<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    params: core::DenoiseParams,
) -> Result<(), String> {
    app.listener2()
        .run_denoise(params)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn is_supported_languages_batch<R: tauri::Runtime>(
    _app: tauri::AppHandle<R>,
    provider: String,
    model: Option<String>,
    languages: Vec<String>,
) -> Result<bool, String> {
    let languages_parsed = languages
        .iter()
        .map(|s| hypr_language::Language::from_str(s))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("unknown_language: {}", e))?;

    core::is_supported_languages_batch(&provider, model.as_deref(), &languages_parsed)
}

#[tauri::command]
#[specta::specta]
pub async fn suggest_providers_for_languages_batch<R: tauri::Runtime>(
    _app: tauri::AppHandle<R>,
    languages: Vec<String>,
) -> Result<Vec<String>, String> {
    let languages_parsed = languages
        .iter()
        .map(|s| hypr_language::Language::from_str(s))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("unknown_language: {}", e))?;

    Ok(core::suggest_providers_for_languages_batch(
        &languages_parsed,
    ))
}

#[tauri::command]
#[specta::specta]
pub async fn list_documented_language_codes_batch<R: tauri::Runtime>(
    _app: tauri::AppHandle<R>,
) -> Result<Vec<String>, String> {
    Ok(core::list_documented_language_codes_batch())
}

#[tauri::command]
#[specta::specta]
pub async fn extract_voice_embeddings<R: tauri::Runtime>(
    _app: tauri::AppHandle<R>,
    audio_path: String,
    windows: Vec<VoiceEmbeddingWindow>,
) -> Result<Vec<VoiceEmbeddingObservation>, String> {
    tokio::task::spawn_blocking(move || extract_voice_embeddings_sync(&audio_path, &windows))
        .await
        .map_err(|e| e.to_string())?
}

fn extract_voice_embeddings_sync(
    audio_path: &str,
    windows: &[VoiceEmbeddingWindow],
) -> Result<Vec<VoiceEmbeddingObservation>, String> {
    if windows.is_empty() {
        return Ok(Vec::new());
    }

    let source = hypr_audio_utils::source_from_path(audio_path).map_err(|e| e.to_string())?;
    let channel_count = u16::from(source.channels()).max(1) as usize;
    let resampled =
        hypr_audio_utils::resample_audio(source, TARGET_SAMPLE_RATE).map_err(|e| e.to_string())?;
    let channel_samples = split_resampled_channels(&resampled, channel_count);
    if channel_samples.is_empty() {
        return Ok(Vec::new());
    }

    let mut extractor = EmbeddingExtractor::new().map_err(|e| e.to_string())?;
    let mut observations = Vec::new();

    for window in windows {
        let channel_idx = if window.channel >= 0 {
            (window.channel as usize).min(channel_samples.len().saturating_sub(1))
        } else {
            0
        };
        let Some(samples) = channel_samples.get(channel_idx) else {
            continue;
        };

        let start = ms_to_sample(window.start_ms, samples.len());
        let end = ms_to_sample(window.end_ms, samples.len());
        if end <= start {
            continue;
        }

        let Some(embedding) = extractor
            .compute_optional(&samples[start..end])
            .map_err(|e| e.to_string())?
        else {
            continue;
        };

        observations.push(VoiceEmbeddingObservation {
            id: window.id.clone(),
            speaker_id: window.speaker_id.clone(),
            embedding,
            embedding_model: "pyannote_wespeaker_onnx".to_string(),
            embedding_dim: EMBEDDING_DIM as u32,
            start_ms: window.start_ms,
            end_ms: window.end_ms,
            duration_ms: window.end_ms.saturating_sub(window.start_ms),
            channel: window.channel,
            speaker_index: window.speaker_index,
            word_count: window.word_count,
        });
    }

    Ok(observations)
}

fn ms_to_sample(ms: i64, sample_count: usize) -> usize {
    ((ms.max(0) as f64 / 1000.0 * TARGET_SAMPLE_RATE as f64).round() as usize).min(sample_count)
}
