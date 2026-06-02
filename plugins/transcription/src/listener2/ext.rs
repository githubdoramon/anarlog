use std::sync::Arc;
use std::time::{Duration, Instant};

use hypr_transcription_core::listener2 as core;
use tauri_plugin_shell::process::{Command, CommandEvent};
use tauri_plugin_sidecar2::Sidecar2PluginExt;
use tauri_specta::Event;
use tokio::task::JoinHandle;

use crate::{
    BatchSessionControl, BatchSessionEntry, BatchSessionRegistry, BatchTerminalState,
    TranscriptionEvent, TranscriptionParams,
};

const BATCH_IDLE_TIMEOUT: Duration = Duration::from_secs(60);
const SONIQO_ALIGNMENT_TIMEOUT: Duration = Duration::from_secs(90);
const SONIQO_TRANSCRIPTION_TIMEOUT: Duration = Duration::from_secs(60 * 60);
const SONIQO_TRANSCRIPTION_HEARTBEAT: Duration = Duration::from_secs(5);

struct SidecarOutput {
    code: Option<i32>,
    signal: Option<i32>,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

impl SidecarOutput {
    fn success(&self) -> bool {
        self.code == Some(0) && self.signal.is_none()
    }

    fn status_summary(&self) -> String {
        format!("code={:?}, signal={:?}", self.code, self.signal)
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SoniqoAlignmentOutput {
    #[serde(default)]
    words: Vec<hypr_transcribe_soniqo::AlignedWord>,
    error: Option<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SoniqoTranscriptionOutput {
    text: String,
    duration_seconds: f64,
    #[serde(default)]
    words: Vec<hypr_transcribe_soniqo::AlignedWord>,
    error: Option<String>,
}

pub struct Listener2<'a, R: tauri::Runtime, M: tauri::Manager<R>> {
    manager: &'a M,
    _runtime: std::marker::PhantomData<fn() -> R>,
}

impl<'a, R: tauri::Runtime, M: tauri::Manager<R>> Listener2<'a, R, M> {
    pub async fn start_transcription(
        &self,
        params: TranscriptionParams,
    ) -> Result<(), core::Error> {
        let state = self.manager.state::<crate::SharedState>();
        let guard = state.lock().await;
        let app = guard.app.clone();
        drop(guard);

        let registry = self
            .manager
            .state::<Arc<BatchSessionRegistry>>()
            .inner()
            .clone();
        let session_id = params.session_id.clone();

        {
            let mut sessions = registry
                .sessions
                .lock()
                .expect("batch session registry poisoned");
            if let Some(entry) = sessions.get(&session_id) {
                let state = *entry
                    .control
                    .terminal_state
                    .lock()
                    .expect("batch terminal state poisoned");
                if state == BatchTerminalState::Running {
                    return Err(core::Error::BatchError(
                        "session already running".to_string(),
                    ));
                }

                sessions.remove(&session_id);
            }
        }

        let (last_activity_tx, _) = tokio::sync::watch::channel(Instant::now());
        let control = Arc::new(BatchSessionControl {
            cancellation_token: tokio_util::sync::CancellationToken::new(),
            last_activity_tx,
            terminal_state: std::sync::Mutex::new(BatchTerminalState::Running),
        });

        {
            let mut sessions = registry
                .sessions
                .lock()
                .expect("batch session registry poisoned");
            sessions.insert(
                session_id.clone(),
                BatchSessionEntry {
                    control: control.clone(),
                    abort_handle: None,
                },
            );
        }

        let runtime = Arc::new(TauriBatchRuntime {
            app: app.clone(),
            control: control.clone(),
        });

        let task = tokio::spawn({
            let runtime = runtime.clone();
            let registry = registry.clone();
            let control = control.clone();
            let session_id = session_id.clone();
            async move {
                let _ = core::run_batch(runtime, params.into()).await;
                finish_batch_session(&registry, &session_id, &control);
            }
        });
        let abort_handle = task.abort_handle();

        let is_running = {
            let mut sessions = registry
                .sessions
                .lock()
                .expect("batch session registry poisoned");
            let Some(entry) = sessions.get_mut(&session_id) else {
                abort_handle.abort();
                return Ok(());
            };

            if !Arc::ptr_eq(&entry.control, &control) {
                abort_handle.abort();
                return Err(core::Error::BatchError(
                    "session already running".to_string(),
                ));
            }

            entry.abort_handle = Some(abort_handle.clone());

            *control
                .terminal_state
                .lock()
                .expect("batch terminal state poisoned")
                == BatchTerminalState::Running
        };

        if !is_running {
            remove_batch_session(&registry, &session_id, &control);
            return Ok(());
        }

        spawn_idle_timeout_monitor(app, registry, session_id, control, abort_handle);

        Ok(())
    }

    pub async fn stop_transcription(&self, session_id: String) {
        let state = self.manager.state::<crate::SharedState>();
        let guard = state.lock().await;
        let app = guard.app.clone();
        drop(guard);

        let registry = self
            .manager
            .state::<Arc<BatchSessionRegistry>>()
            .inner()
            .clone();
        stop_batch_session(&app, &registry, &session_id);
    }

    pub async fn run_denoise(&self, params: core::DenoiseParams) -> Result<(), core::Error> {
        let state = self.manager.state::<crate::SharedState>();
        let guard = state.lock().await;
        let app = guard.app.clone();
        drop(guard);

        let runtime = Arc::new(TauriDenoiseRuntime { app });
        core::run_denoise(runtime, params).await
    }

    pub fn parse_subtitle(&self, path: String) -> Result<core::Subtitle, String> {
        core::parse_subtitle_from_path(path)
    }

    pub fn export_to_vtt(
        &self,
        session_id: String,
        words: Vec<core::VttWord>,
    ) -> Result<String, String> {
        use tauri_plugin_settings::SettingsPluginExt;

        let base = self
            .manager
            .settings()
            .vault_base()
            .map_err(|e| e.to_string())?;
        let session_dir = base.join("sessions").join(&session_id);

        std::fs::create_dir_all(&session_dir).map_err(|e| e.to_string())?;

        let vtt_path = session_dir.join("transcript.vtt");

        core::export_words_to_vtt_file(words, &vtt_path)?;
        Ok(vtt_path.to_string())
    }
}

pub trait Listener2PluginExt<R: tauri::Runtime> {
    fn listener2(&self) -> Listener2<'_, R, Self>
    where
        Self: tauri::Manager<R> + Sized;
}

impl<R: tauri::Runtime, T: tauri::Manager<R>> Listener2PluginExt<R> for T {
    fn listener2(&self) -> Listener2<'_, R, Self>
    where
        Self: Sized,
    {
        Listener2 {
            manager: self,
            _runtime: std::marker::PhantomData,
        }
    }
}

struct TauriBatchRuntime {
    app: tauri::AppHandle,
    control: Arc<BatchSessionControl>,
}

impl core::BatchRuntime for TauriBatchRuntime {
    fn emit(&self, event: core::BatchEvent) {
        if !should_emit_event(&self.control, &event) {
            return;
        }

        if matches!(
            event,
            core::BatchEvent::BatchResponseStreamed { .. } | core::BatchEvent::BatchResponse { .. }
        ) {
            let _ = self.control.last_activity_tx.send(Instant::now());
        }

        if let core::BatchEvent::BatchCompleted { .. } = event {
            return;
        }
        let _ = TranscriptionEvent::from(event).emit(&self.app);
    }

    fn align_soniqo(
        &self,
        request: core::SoniqoAlignmentRequest,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<
                    Output = Result<Vec<hypr_transcribe_soniqo::AlignedWord>, String>,
                > + Send,
        >,
    > {
        let app = self.app.clone();
        Box::pin(async move {
            let audio_path = request.audio_path.to_string_lossy().into_owned();
            let mut cmd = match app.sidecar2().sidecar("char-sidecar-soniqo-aligner") {
                Ok(cmd) => cmd.args(["--audio", &audio_path, "--text", &request.text]),
                Err(error) => {
                    tracing::error!(
                        hyprnote.file.path = %audio_path,
                        error = %error,
                        "soniqo_alignment_sidecar_create_failed"
                    );
                    return Err(error.to_string());
                }
            };

            if let Some(language) = request.language.as_deref() {
                cmd = cmd.args(["--language", language]);
            }

            let output = run_sidecar_with_timeout(cmd, SONIQO_ALIGNMENT_TIMEOUT, None)
                .await
                .map_err(|error| format!("Soniqo aligner sidecar failed: {error}"))?;

            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);

            if !output.success() {
                let error = sidecar_error_message(&output, &stdout, &stderr);
                tracing::error!(
                    hyprnote.file.path = %audio_path,
                    hyprnote.sidecar.status = %output.status_summary(),
                    error = %error,
                    "soniqo_alignment_sidecar_failed"
                );
                return Err(format!("Soniqo aligner sidecar failed: {error}"));
            }

            let parsed: SoniqoAlignmentOutput = parse_sidecar_json(&stdout)?;
            if let Some(error) = parsed.error {
                return Err(error);
            }

            Ok(parsed.words)
        })
    }

    fn transcribe_soniqo(
        &self,
        request: core::SoniqoTranscriptionRequest,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<Output = Result<hypr_transcribe_soniqo::FileTranscript, String>>
                + Send,
        >,
    > {
        let app = self.app.clone();
        let last_activity_tx = self.control.last_activity_tx.clone();
        Box::pin(async move {
            let audio_path = request.audio_path.to_string_lossy().into_owned();
            let started_at = Instant::now();
            tracing::info!(
                hyprnote.soniqo.model = request.model.as_str(),
                hyprnote.file.path = %audio_path,
                "soniqo_transcription_sidecar_start"
            );
            let mut cmd = match app.sidecar2().sidecar("char-sidecar-soniqo-transcriber") {
                Ok(cmd) => cmd.args(["--model", request.model.as_str(), "--audio", &audio_path]),
                Err(error) => {
                    tracing::error!(
                        hyprnote.soniqo.model = request.model.as_str(),
                        hyprnote.file.path = %audio_path,
                        error = %error,
                        "soniqo_transcription_sidecar_create_failed"
                    );
                    return Err(error.to_string());
                }
            };

            if let Some(language) = request.language.as_deref() {
                cmd = cmd.args(["--language", language]);
            }

            let output = run_sidecar_with_timeout(
                cmd,
                SONIQO_TRANSCRIPTION_TIMEOUT,
                Some((SONIQO_TRANSCRIPTION_HEARTBEAT, last_activity_tx)),
            )
            .await?;

            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            tracing::info!(
                hyprnote.soniqo.model = request.model.as_str(),
                hyprnote.file.path = %audio_path,
                hyprnote.sidecar.status = %output.status_summary(),
                hyprnote.sidecar.elapsed_ms = started_at.elapsed().as_millis(),
                hyprnote.sidecar.stdout_bytes = output.stdout.len(),
                hyprnote.sidecar.stderr_bytes = output.stderr.len(),
                "soniqo_transcription_sidecar_finished"
            );

            if !output.success() {
                let error = sidecar_error_message(&output, &stdout, &stderr);
                tracing::error!(
                    hyprnote.soniqo.model = request.model.as_str(),
                    hyprnote.file.path = %audio_path,
                    hyprnote.sidecar.status = %output.status_summary(),
                    error = %error,
                    "soniqo_transcription_sidecar_failed"
                );
                return Err(format!("Soniqo transcription sidecar failed: {error}"));
            }

            let parsed: SoniqoTranscriptionOutput = parse_sidecar_json(&stdout)?;
            if let Some(error) = parsed.error {
                return Err(error);
            }

            Ok(hypr_transcribe_soniqo::FileTranscript {
                text: parsed.text,
                duration_seconds: parsed.duration_seconds,
                words: parsed.words,
            })
        })
    }
}

struct TauriDenoiseRuntime {
    app: tauri::AppHandle,
}

impl core::DenoiseRuntime for TauriDenoiseRuntime {
    fn emit(&self, event: core::DenoiseEvent) {
        let _ = event.emit(&self.app);
    }
}

fn should_emit_event(control: &BatchSessionControl, event: &core::BatchEvent) -> bool {
    let state = *control
        .terminal_state
        .lock()
        .expect("batch terminal state poisoned");
    state == BatchTerminalState::Running
        || matches!(
            (state, event),
            (
                BatchTerminalState::Finished,
                core::BatchEvent::BatchResponse { .. }
            )
        )
}

fn mark_terminal_state(control: &BatchSessionControl, next: BatchTerminalState) -> bool {
    let mut state = control
        .terminal_state
        .lock()
        .expect("batch terminal state poisoned");
    if *state != BatchTerminalState::Running {
        return false;
    }
    *state = next;
    control.cancellation_token.cancel();
    true
}

fn finish_batch_session(
    registry: &Arc<BatchSessionRegistry>,
    session_id: &str,
    control: &Arc<BatchSessionControl>,
) {
    {
        let mut state = control
            .terminal_state
            .lock()
            .expect("batch terminal state poisoned");
        if *state == BatchTerminalState::Running {
            *state = BatchTerminalState::Finished;
            control.cancellation_token.cancel();
        }
    }

    remove_batch_session(registry, session_id, control);
}

fn remove_batch_session(
    registry: &Arc<BatchSessionRegistry>,
    session_id: &str,
    control: &Arc<BatchSessionControl>,
) {
    let mut sessions = registry
        .sessions
        .lock()
        .expect("batch session registry poisoned");
    let should_remove = sessions
        .get(session_id)
        .is_some_and(|entry| Arc::ptr_eq(&entry.control, control));
    if should_remove {
        sessions.remove(session_id);
    }
}

fn stop_batch_session(
    app: &tauri::AppHandle,
    registry: &Arc<BatchSessionRegistry>,
    session_id: &str,
) {
    let entry = {
        let mut sessions = registry
            .sessions
            .lock()
            .expect("batch session registry poisoned");
        sessions.remove(session_id)
    };

    let Some(entry) = entry else {
        return;
    };

    if mark_terminal_state(&entry.control, BatchTerminalState::Stopped) {
        let _ = TranscriptionEvent::Stopped {
            session_id: session_id.to_string(),
        }
        .emit(app);
    }

    if let Some(abort_handle) = entry.abort_handle {
        abort_handle.abort();
    }
}

fn spawn_idle_timeout_monitor(
    app: tauri::AppHandle,
    registry: Arc<BatchSessionRegistry>,
    session_id: String,
    control: Arc<BatchSessionControl>,
    abort_handle: tokio::task::AbortHandle,
) -> JoinHandle<()> {
    let mut activity_rx = control.last_activity_tx.subscribe();

    tokio::spawn(async move {
        loop {
            let deadline = *activity_rx.borrow() + BATCH_IDLE_TIMEOUT;
            let sleep = tokio::time::sleep_until(tokio::time::Instant::from_std(deadline));
            tokio::pin!(sleep);

            tokio::select! {
                _ = control.cancellation_token.cancelled() => return,
                _ = &mut sleep => {
                    if !mark_terminal_state(&control, BatchTerminalState::TimedOut) {
                        return;
                    }

                    remove_batch_session(&registry, &session_id, &control);
                    let _ = TranscriptionEvent::Failed {
                        session_id: session_id.clone(),
                        code: core::BatchErrorCode::TimedOut,
                        error: "Transcription timed out after 60 seconds without progress.".to_string(),
                    }
                    .emit(&app);
                    abort_handle.abort();
                    return;
                }
                changed = activity_rx.changed() => {
                    if changed.is_err() {
                        return;
                    }
                }
            }
        }
    })
}

async fn run_sidecar_with_timeout(
    cmd: Command,
    timeout: Duration,
    heartbeat: Option<(Duration, tokio::sync::watch::Sender<Instant>)>,
) -> Result<SidecarOutput, String> {
    let (mut rx, child) = cmd.spawn().map_err(|error| {
        tracing::error!(error = %error, "sidecar_spawn_failed");
        error.to_string()
    })?;
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut heartbeat = heartbeat.map(|(duration, tx)| {
        let mut interval = tokio::time::interval(duration);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        (interval, tx)
    });
    let timeout = tokio::time::sleep(timeout);
    tokio::pin!(timeout);

    loop {
        tokio::select! {
            _ = &mut timeout => {
                let _ = child.kill();
                return Err("timed out".to_string());
            }
            _ = async {
                match heartbeat.as_mut() {
                    Some((interval, tx)) => {
                        interval.tick().await;
                        let _ = tx.send(Instant::now());
                    }
                    None => std::future::pending::<()>().await,
                }
            } => {}
            event = rx.recv() => {
                match event {
                    Some(CommandEvent::Stdout(bytes)) => {
                        stdout.extend(bytes);
                        stdout.push(b'\n');
                    }
                    Some(CommandEvent::Stderr(bytes)) => {
                        stderr.extend(bytes);
                        stderr.push(b'\n');
                    }
                    Some(CommandEvent::Terminated(payload)) => {
                        return Ok(SidecarOutput {
                            code: payload.code,
                            signal: payload.signal,
                            stdout,
                            stderr,
                        });
                    }
                    Some(CommandEvent::Error(error)) => {
                        let _ = child.kill();
                        return Err(error);
                    }
                    None => {
                        return Err("event stream closed before process terminated".to_string());
                    }
                    _ => {}
                }
            }
        }
    }
}

fn sidecar_error_message(output: &SidecarOutput, stdout: &str, stderr: &str) -> String {
    let stdout = stdout.trim();
    let stderr = stderr.trim();

    let json_error = sidecar_json_values(stdout).find_map(|value| {
        value
            .get("error")
            .and_then(|error| error.as_str())
            .map(str::trim)
            .filter(|error| !error.is_empty())
            .map(str::to_string)
    });

    let detail = json_error
        .or_else(|| (!stderr.is_empty()).then(|| truncate_sidecar_output(stderr)))
        .or_else(|| (!stdout.is_empty()).then(|| truncate_sidecar_output(stdout)))
        .unwrap_or_else(|| "no output".to_string());

    format!("status={}, output={detail}", output.status_summary())
}

fn parse_sidecar_json<T: serde::de::DeserializeOwned>(stdout: &str) -> Result<T, String> {
    for value in sidecar_json_values(stdout) {
        if let Ok(parsed) = serde_json::from_value(value) {
            return Ok(parsed);
        }
    }

    serde_json::from_str(stdout.trim()).map_err(|error| {
        format!(
            "failed to parse sidecar JSON: {error}; stdout={}",
            truncate_sidecar_output(stdout.trim())
        )
    })
}

fn sidecar_json_values(stdout: &str) -> impl Iterator<Item = serde_json::Value> + '_ {
    stdout.lines().filter_map(|line| {
        let line = line.trim();
        line.starts_with('{')
            .then(|| serde_json::from_str(line).ok())
            .flatten()
    })
}

fn truncate_sidecar_output(value: &str) -> String {
    const MAX_CHARS: usize = 1000;

    let mut chars = value.chars();
    let truncated: String = chars.by_ref().take(MAX_CHARS).collect();
    if chars.next().is_some() {
        format!("{truncated}...")
    } else {
        truncated
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_control() -> Arc<BatchSessionControl> {
        let (last_activity_tx, _) = tokio::sync::watch::channel(Instant::now());
        Arc::new(BatchSessionControl {
            cancellation_token: tokio_util::sync::CancellationToken::new(),
            last_activity_tx,
            terminal_state: std::sync::Mutex::new(BatchTerminalState::Running),
        })
    }

    #[test]
    fn mark_terminal_state_only_transitions_once() {
        let control = make_control();

        assert!(mark_terminal_state(&control, BatchTerminalState::Stopped));
        assert!(!mark_terminal_state(&control, BatchTerminalState::TimedOut));
        assert_eq!(
            *control
                .terminal_state
                .lock()
                .expect("batch terminal state poisoned"),
            BatchTerminalState::Stopped,
        );
    }

    #[test]
    fn should_emit_event_stops_after_terminal_transition() {
        let control = make_control();
        let event = core::BatchEvent::BatchStarted {
            session_id: "session-1".to_string(),
        };

        assert!(should_emit_event(&control, &event));
        assert!(mark_terminal_state(&control, BatchTerminalState::Stopped));
        assert!(!should_emit_event(&control, &event));
    }

    #[test]
    fn finish_batch_session_removes_matching_registry_entry() {
        let control = make_control();
        let registry = Arc::new(BatchSessionRegistry {
            sessions: std::sync::Mutex::new(std::collections::HashMap::from([(
                "session-1".to_string(),
                BatchSessionEntry {
                    control: control.clone(),
                    abort_handle: None,
                },
            )])),
        });

        finish_batch_session(&registry, "session-1", &control);

        assert!(
            !registry
                .sessions
                .lock()
                .expect("batch session registry poisoned")
                .contains_key("session-1")
        );
    }

    #[test]
    fn parse_sidecar_json_uses_json_line_before_logs() {
        let stdout = r#"{"text":"ok","durationSeconds":1.0,"words":[],"error":null}
Loaded tokenizer
Loading: model.safetensors"#;

        let parsed: SoniqoTranscriptionOutput = parse_sidecar_json(stdout).unwrap();

        assert_eq!(parsed.text, "ok");
        assert_eq!(parsed.duration_seconds, 1.0);
        assert!(parsed.words.is_empty());
        assert!(parsed.error.is_none());
    }
}
