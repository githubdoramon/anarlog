use std::{future::Future, path::PathBuf, pin::Pin};

use crate::BatchEvent;
use crate::DenoiseEvent;

#[derive(Debug, Clone)]
pub struct SoniqoAlignmentRequest {
    pub audio_path: PathBuf,
    pub text: String,
    pub language: Option<String>,
}

pub trait BatchRuntime: Send + Sync + 'static {
    fn emit(&self, event: BatchEvent);

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
