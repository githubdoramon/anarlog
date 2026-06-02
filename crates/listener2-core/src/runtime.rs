use std::{future::Future, path::PathBuf, pin::Pin};

use crate::BatchEvent;
use crate::DenoiseEvent;

#[derive(Debug, Clone)]
pub struct SoniqoAlignmentRequest {
    pub audio_path: PathBuf,
    pub text: String,
    pub language: Option<String>,
}

#[derive(Debug, Clone)]
pub struct SoniqoTranscriptionRequest {
    pub model: hypr_transcribe_soniqo::SoniqoModel,
    pub audio_path: PathBuf,
    pub language: Option<String>,
}

pub trait BatchRuntime: Send + Sync + 'static {
    fn emit(&self, event: BatchEvent);

    fn transcribe_soniqo(
        &self,
        request: SoniqoTranscriptionRequest,
    ) -> Pin<Box<dyn Future<Output = Result<hypr_transcribe_soniqo::FileTranscript, String>> + Send>>
    {
        Box::pin(async move {
            tokio::task::spawn_blocking(move || {
                hypr_transcribe_soniqo::transcribe_file(
                    request.model,
                    request.audio_path,
                    request.language.as_deref(),
                )
            })
            .await
            .map_err(|error| error.to_string())?
            .map_err(|error| error.to_string())
        })
    }

    fn align_soniqo(
        &self,
        _request: SoniqoAlignmentRequest,
    ) -> Pin<
        Box<dyn Future<Output = Result<Vec<hypr_transcribe_soniqo::AlignedWord>, String>> + Send>,
    > {
        Box::pin(async { Err("Soniqo aligner sidecar unavailable".to_string()) })
    }
}

pub trait DenoiseRuntime: Send + Sync + 'static {
    fn emit(&self, event: DenoiseEvent);
}
