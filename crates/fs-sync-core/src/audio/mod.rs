use std::fs::File;
use std::path::{Path, PathBuf};

use crate::error::AudioImportError;
use crate::runtime::{AudioImportEvent, AudioImportRuntime};
use chrono::{DateTime, Utc};

const AUDIO_FORMATS: [&str; 3] = ["audio.mp3", "audio.wav", "audio.ogg"];
const AUDIO_TMP_FILES: [&str; 1] = ["audio.mp3.tmp"];
const RECORDING_MANIFEST_FILE: &str = "audio.recording.json";

#[derive(Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AudioSourceMetadata {
    pub created_at: Option<String>,
    pub modified_at: Option<String>,
    pub duration_ms: Option<u64>,
}

pub fn exists(session_dir: &Path) -> std::io::Result<bool> {
    recover_interrupted_audio(session_dir);

    AUDIO_FORMATS
        .iter()
        .map(|format| session_dir.join(format))
        .try_fold(false, |acc, path| {
            std::fs::exists(&path).map(|exists| acc || exists)
        })
}

pub fn delete(session_dir: &Path) -> std::io::Result<()> {
    tracing::info!(
        session_dir = %session_dir.display(),
        manifest_exists = session_dir.join(RECORDING_MANIFEST_FILE).exists(),
        "audio_delete_requested"
    );

    for format in AUDIO_FORMATS.into_iter().chain(AUDIO_TMP_FILES) {
        let path = session_dir.join(format);
        if std::fs::exists(&path).unwrap_or(false) {
            tracing::info!(
                path = %path.display(),
                size = file_size(&path),
                "audio_delete_removing_file"
            );
            std::fs::remove_file(&path)?;
            sync_dir(&path);
        }
    }
    Ok(())
}

pub fn path(session_dir: &Path) -> Option<PathBuf> {
    recover_interrupted_audio(session_dir);

    let audio_path = AUDIO_FORMATS
        .iter()
        .map(|format| session_dir.join(format))
        .find(|path| path.exists());

    match &audio_path {
        Some(path) => {
            tracing::info!(
                session_dir = %session_dir.display(),
                audio_path = %path.display(),
                audio_size = file_size(path),
                "audio_path_resolved"
            );
        }
        None => {
            tracing::warn!(
                session_dir = %session_dir.display(),
                manifest_exists = session_dir.join(RECORDING_MANIFEST_FILE).exists(),
                mp3_exists = session_dir.join("audio.mp3").exists(),
                wav_exists = session_dir.join("audio.wav").exists(),
                ogg_exists = session_dir.join("audio.ogg").exists(),
                tmp_mp3_exists = session_dir.join("audio.mp3.tmp").exists(),
                "audio_path_missing"
            );
            log_recording_manifest(session_dir);
        }
    }

    audio_path
}

pub fn source_metadata(source_path: &Path) -> std::io::Result<AudioSourceMetadata> {
    use hypr_audio_utils::Source;

    let metadata = std::fs::metadata(source_path)?;
    let created_at = metadata.created().ok().map(system_time_to_iso);
    let modified_at = metadata.modified().ok().map(system_time_to_iso);
    let duration_ms = hypr_audio_utils::source_from_path(source_path)
        .ok()
        .and_then(|source| source.total_duration())
        .and_then(|duration| u64::try_from(duration.as_millis()).ok());

    Ok(AudioSourceMetadata {
        created_at,
        modified_at,
        duration_ms,
    })
}

pub fn import_to_session(
    runtime: &dyn AudioImportRuntime,
    session_id: &str,
    session_dir: &Path,
    source_path: &Path,
) -> Result<PathBuf, AudioImportError> {
    runtime.emit(AudioImportEvent::Started {
        session_id: session_id.to_string(),
    });

    std::fs::create_dir_all(session_dir)?;

    let target_path = session_dir.join("audio.mp3");
    let tmp_path = session_dir.join("audio.mp3.tmp");
    tracing::info!(
        session_id,
        session_dir = %session_dir.display(),
        source_path = %source_path.display(),
        target_path = %target_path.display(),
        tmp_path = %tmp_path.display(),
        source_size = file_size(source_path),
        "audio_import_started"
    );

    let on_progress = {
        let session_id = session_id.to_string();
        let mut last_emitted: f64 = 0.0;
        let mut last_time = std::time::Instant::now();
        move |percentage: f64| {
            let now = std::time::Instant::now();
            if (percentage - last_emitted) >= 0.01
                || now.duration_since(last_time).as_millis() >= 100
            {
                runtime.emit(AudioImportEvent::Progress {
                    session_id: session_id.clone(),
                    percentage,
                });
                last_emitted = percentage;
                last_time = now;
            }
        }
    };

    let result = hypr_audio_norm::normalize_file(
        source_path,
        &tmp_path,
        &target_path,
        None,
        Some(on_progress),
    )
    .map(|_| ());
    match result {
        Ok(()) => {
            let final_path = target_path;
            sync_file(&final_path);
            sync_dir(&final_path);
            tracing::info!(
                session_id,
                target_path = %final_path.display(),
                target_size = file_size(&final_path),
                "audio_import_completed"
            );
            runtime.emit(AudioImportEvent::Completed {
                session_id: session_id.to_string(),
            });
            Ok(final_path.to_path_buf())
        }
        Err(error) => {
            if tmp_path.exists() {
                tracing::warn!(
                    session_id,
                    tmp_path = %tmp_path.display(),
                    tmp_size = file_size(&tmp_path),
                    error = %error,
                    "audio_import_failed_removing_tmp"
                );
                let _ = std::fs::remove_file(&tmp_path);
            }
            tracing::error!(
                session_id,
                source_path = %source_path.display(),
                target_path = %target_path.display(),
                error = %error,
                "audio_import_failed"
            );
            runtime.emit(AudioImportEvent::Failed {
                session_id: session_id.to_string(),
                error: error.to_string(),
            });
            Err(error.into())
        }
    }
}

pub fn import_audio(
    source_path: &Path,
    tmp_path: &Path,
    target_path: &Path,
) -> Result<PathBuf, hypr_audio_norm::Error> {
    hypr_audio_norm::normalize_file(source_path, tmp_path, target_path, None, None::<fn(f64)>)
}

fn system_time_to_iso(time: std::time::SystemTime) -> String {
    DateTime::<Utc>::from(time).to_rfc3339()
}

fn recover_interrupted_audio(session_dir: &Path) {
    let target_path = session_dir.join("audio.mp3");
    let wav_path = session_dir.join("audio.wav");
    let tmp_path = session_dir.join("audio.mp3.tmp");

    if target_path.exists() || wav_path.exists() || !tmp_path.exists() {
        return;
    }

    let tmp_size = file_size(&tmp_path).unwrap_or(0);
    if tmp_size == 0 {
        tracing::warn!(
            session_dir = %session_dir.display(),
            tmp_path = %tmp_path.display(),
            "audio_recovery_zero_byte_tmp_retained_for_diagnostics"
        );
        log_recording_manifest(session_dir);
        return;
    }

    match std::fs::rename(&tmp_path, &target_path) {
        Ok(()) => {
            sync_file(&target_path);
            sync_dir(&target_path);
            tracing::warn!(
                session_dir = %session_dir.display(),
                recovered_path = %target_path.display(),
                recovered_size = file_size(&target_path),
                "audio_recovery_promoted_tmp_mp3"
            );
        }
        Err(error) => {
            tracing::error!(
                session_dir = %session_dir.display(),
                tmp_path = %tmp_path.display(),
                target_path = %target_path.display(),
                tmp_size,
                error = %error,
                "audio_recovery_promote_tmp_failed"
            );
            log_recording_manifest(session_dir);
        }
    }
}

fn log_recording_manifest(session_dir: &Path) {
    let manifest_path = session_dir.join(RECORDING_MANIFEST_FILE);
    if !manifest_path.exists() {
        return;
    }

    match std::fs::read_to_string(&manifest_path) {
        Ok(contents) => {
            tracing::warn!(
                manifest_path = %manifest_path.display(),
                manifest_size = contents.len(),
                manifest = %contents,
                "audio_recording_manifest_present"
            );
        }
        Err(error) => {
            tracing::warn!(
                manifest_path = %manifest_path.display(),
                error = %error,
                "audio_recording_manifest_read_failed"
            );
        }
    }
}

fn file_size(path: &Path) -> Option<u64> {
    std::fs::metadata(path).ok().map(|metadata| metadata.len())
}

fn sync_file(path: &Path) {
    match File::open(path).and_then(|file| file.sync_all()) {
        Ok(()) => {}
        Err(error) => {
            tracing::warn!(
                path = %path.display(),
                error = %error,
                "audio_sync_file_failed"
            );
        }
    }
}

fn sync_dir(path: &Path) {
    if let Some(parent) = path.parent()
        && let Err(error) = File::open(parent).and_then(|dir| dir.sync_all())
    {
        tracing::warn!(
            path = %parent.display(),
            error = %error,
            "audio_sync_dir_failed"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use assert_fs::TempDir;
    use hypr_audio_utils::Source;

    const MIN_MP3_BYTES: u64 = 1024;

    macro_rules! test_import_audio {
        ($($name:ident: $path:expr),* $(,)?) => {
            $(
                #[test]
                fn $name() {
                    let source_path = std::path::Path::new($path);
                    let temp = TempDir::new().unwrap();
                    let tmp_path = temp.path().join("tmp.mp3");
                    let target_path = temp.path().join("target.mp3");

                    let result = import_audio(source_path, &tmp_path, &target_path);
                    assert!(result.is_ok(), "import failed: {:?}", result.err());
                    assert!(target_path.exists());

                    let size = std::fs::metadata(&target_path).unwrap().len();
                    assert!(
                        size > MIN_MP3_BYTES,
                        "Output too small ({size} bytes), likely empty audio"
                    );
                }
            )*
        };
    }

    test_import_audio! {
        test_import_wav: hypr_data::english_1::AUDIO_PATH,
        test_import_mp3: hypr_data::english_1::AUDIO_MP3_PATH,
        test_import_mp4: hypr_data::english_1::AUDIO_MP4_PATH,
        test_import_m4a: hypr_data::english_1::AUDIO_M4A_PATH,
        test_import_ogg: hypr_data::english_1::AUDIO_OGG_PATH,
        test_import_flac: hypr_data::english_1::AUDIO_FLAC_PATH,
        test_import_aac: hypr_data::english_1::AUDIO_AAC_PATH,
        test_import_aiff: hypr_data::english_1::AUDIO_AIFF_PATH,
        test_import_caf: hypr_data::english_1::AUDIO_CAF_PATH,
    }

    #[test]
    fn test_import_stereo_mp3() {
        let source_path = std::path::Path::new(hypr_data::english_10::AUDIO_MP3_PATH);
        let temp = TempDir::new().unwrap();
        let tmp_path = temp.path().join("tmp.mp3");
        let target_path = temp.path().join("target.mp3");

        let result = import_audio(source_path, &tmp_path, &target_path);
        assert!(result.is_ok(), "import failed: {:?}", result.err());
        assert!(target_path.exists());

        let size = std::fs::metadata(&target_path).unwrap().len();
        assert!(
            size > MIN_MP3_BYTES,
            "Output too small ({size} bytes), likely empty audio"
        );

        let decoder = hypr_audio_utils::source_from_path(&target_path).unwrap();
        let channels: u16 = decoder.channels().into();
        assert_eq!(channels, 2, "stereo input should produce stereo output");
    }

    #[test]
    fn test_import_problem_m4a() {
        let source = match std::env::var("PROBLEM_M4A") {
            Ok(p) => PathBuf::from(p),
            Err(_) => return,
        };
        let temp = TempDir::new().unwrap();
        let result = import_audio(
            &source,
            &temp.path().join("tmp.mp3"),
            &temp.path().join("out.mp3"),
        );
        assert!(result.is_ok(), "import failed: {:?}", result.err());
    }

    #[test]
    fn test_import_problem2_m4a() {
        let source = match std::env::var("PROBLEM2_M4A") {
            Ok(p) => PathBuf::from(p),
            Err(_) => return,
        };
        let temp = TempDir::new().unwrap();
        let result = import_audio(
            &source,
            &temp.path().join("tmp.mp3"),
            &temp.path().join("out.mp3"),
        );
        assert!(result.is_ok(), "import failed: {:?}", result.err());
    }

    #[test]
    fn path_recovers_tmp_mp3_when_no_final_audio_exists() {
        let temp = TempDir::new().unwrap();
        let session_dir = temp.path();
        let tmp_path = session_dir.join("audio.mp3.tmp");
        let target_path = session_dir.join("audio.mp3");
        std::fs::write(&tmp_path, b"partial-but-nonempty").unwrap();

        let resolved = path(session_dir);

        assert_eq!(resolved.as_deref(), Some(target_path.as_path()));
        assert!(target_path.exists());
        assert!(!tmp_path.exists());
    }
}
