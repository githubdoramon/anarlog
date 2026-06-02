use std::{fs::File, io::BufWriter, path::Path, sync::Arc};

use hypr_audio_utils::Source;
use owhisper_client::{
    AdapterKind, AquaVoiceAdapter, ArgmaxAdapter, AssemblyAIAdapter, BatchSttAdapter,
    DeepgramAdapter, ElevenLabsAdapter, FireworksAdapter, GladiaAdapter, HyprnoteAdapter,
    MistralAdapter, OpenAIAdapter, PyannoteAdapter, SonioxAdapter,
};
use tracing::Instrument;

use super::{BatchParams, BatchRunMode, BatchRunOutput, format_user_friendly_error, session_span};
use crate::{BatchRuntime, SoniqoAlignmentRequest, SoniqoTranscriptionRequest};

const SONIQO_BATCH_SAMPLE_RATE: u32 = 16_000;
const SONIQO_BATCH_MAX_CHUNK_SECONDS: f64 = 25.0;
const SONIQO_BATCH_CONTEXT_SECONDS: f64 = 1.0;
const SONIQO_BATCH_BOUNDARY_TOLERANCE_SECONDS: f64 = 0.35;
const SONIQO_BOUNDARY_DEDUPE_SECONDS: f64 = 0.35;
const SONIQO_ALIGNMENT_MAX_WORD_SECONDS: f64 = 2.5;
const SONIQO_ALIGNMENT_MAX_PRESPEECH_SECONDS: f64 = 1.0;
const SONIQO_ACTIVE_WINDOW_SECONDS: f64 = 0.1;
const SONIQO_ACTIVE_RMS_THRESHOLD: f32 = 0.003;
const SONIQO_ACTIVE_MIN_SPAN_SECONDS: f64 = 0.25;
const SONIQO_CROSSTALK_DOMINANCE_RATIO: f32 = 4.0;
const SONIQO_CROSSTALK_MIN_DOMINANT_RMS: f32 = 0.006;
const SONIQO_CROSSTALK_MIN_CORRELATION: f32 = 0.35;
const SONIQO_CROSSTALK_ATTENUATION: f32 = 0.05;
const SONIQO_CROSSTALK_MAX_LAG_SECONDS: f64 = 0.02;
const SONIQO_CROSSTALK_LAG_STEP_SAMPLES: usize = 16;
const SYNTHETIC_WORD_SECONDS: f64 = 0.4;

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
    runtime: Arc<dyn BatchRuntime>,
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
            let language = language.clone();
            tracing::info!(
                hyprnote.soniqo.channel = channel_idx,
                hyprnote.stt.duration_seconds = prepared_channel.duration_seconds(),
                "soniqo_batch_channel_transcription_start"
            );

            let transcribed = transcribe_soniqo_prepared_channel(
                runtime.clone(),
                model,
                prepared_channel,
                language,
            )
            .await?;

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
    sample_count: usize,
    profile: SoniqoChannelProfile,
}

impl PreparedSoniqoChannel {
    fn path(&self) -> &Path {
        self.file.path()
    }

    fn duration_seconds(&self) -> f64 {
        self.sample_count as f64 / SONIQO_BATCH_SAMPLE_RATE as f64
    }
}

#[derive(Clone)]
struct SoniqoChannelProfile {
    active_spans: Vec<ActiveSpan>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct ActiveSpan {
    start: f64,
    end: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct SoniqoChunkRange {
    index: usize,
    start_sample: usize,
    end_sample: usize,
    commit_start_sample: usize,
    commit_end_sample: usize,
}

impl SoniqoChunkRange {
    fn start_seconds(&self) -> f64 {
        sample_to_seconds(self.start_sample)
    }

    fn commit_start_seconds(&self) -> f64 {
        sample_to_seconds(self.commit_start_sample)
    }

    fn commit_end_seconds(&self) -> f64 {
        sample_to_seconds(self.commit_end_sample)
    }

    fn duration_seconds(&self) -> f64 {
        sample_to_seconds(self.end_sample.saturating_sub(self.start_sample))
    }
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

    let writers = (0..channels)
        .map(SoniqoChannelWriter::new)
        .collect::<crate::Result<Vec<_>>>()?;

    let mut preprocessor = SoniqoChannelPreprocessor::new(writers);
    stream_resampled_frames(source, channels, sample_rate, |frame| {
        preprocessor.push_frame(frame)
    })?;

    let prepared_channels = preprocessor.finalize()?;
    for prepared in &prepared_channels {
        tracing::info!(
            hyprnote.file.path = %path,
            hyprnote.soniqo.prepared_path = %prepared.file.path().display(),
            hyprnote.audio.source_channel = prepared.channel_idx,
            hyprnote.audio.source_channels = channels,
            hyprnote.audio.source_sample_rate_hz = sample_rate,
            hyprnote.audio.prepared_sample_count = prepared.sample_count,
            "soniqo_batch_audio_channel_prepared"
        );
    }

    Ok(prepared_channels)
}

struct SoniqoChannelPreprocessor {
    writers: Vec<SoniqoChannelWriter>,
    window: Vec<Vec<f32>>,
    suppressed_windows: usize,
}

impl SoniqoChannelPreprocessor {
    fn new(writers: Vec<SoniqoChannelWriter>) -> Self {
        Self {
            writers,
            window: Vec::with_capacity(active_window_samples()),
            suppressed_windows: 0,
        }
    }

    fn push_frame(&mut self, frame: &[f32]) -> crate::Result<()> {
        self.window.push(frame.to_vec());
        if self.window.len() >= active_window_samples() {
            self.flush_window()?;
        }
        Ok(())
    }

    fn finalize(mut self) -> crate::Result<Vec<PreparedSoniqoChannel>> {
        self.flush_window()?;
        if self.suppressed_windows > 0 {
            tracing::info!(
                hyprnote.soniqo.crosstalk_suppressed_windows = self.suppressed_windows,
                "soniqo_batch_audio_crosstalk_suppressed"
            );
        }

        self.writers
            .into_iter()
            .map(SoniqoChannelWriter::finalize)
            .collect()
    }

    fn flush_window(&mut self) -> crate::Result<()> {
        if self.window.is_empty() {
            return Ok(());
        }

        let gains = crosstalk_suppression_gains(&self.window, self.writers.len());
        if gains.iter().any(|gain| *gain < 1.0 - f32::EPSILON) {
            self.suppressed_windows += 1;
        }

        for frame in self.window.drain(..) {
            for (idx, writer) in self.writers.iter_mut().enumerate() {
                let sample = frame.get(idx).copied().unwrap_or_default() * gains[idx];
                writer.write_sample(sample)?;
            }
        }

        Ok(())
    }
}

struct SoniqoChannelWriter {
    channel_idx: usize,
    file: tempfile::NamedTempFile,
    writer: hound::WavWriter<BufWriter<File>>,
    activity: ActiveSpanDetector,
}

impl SoniqoChannelWriter {
    fn new(channel_idx: usize) -> crate::Result<Self> {
        let file = tempfile::Builder::new()
            .prefix("soniqo-batch-channel-")
            .suffix(".wav")
            .tempfile()
            .map_err(|err| crate::BatchFailure::DirectRequestFailed {
                provider: "soniqo".to_string(),
                message: format!("Failed to create temporary Soniqo audio file: {err}"),
            })?;

        let writer = hound::WavWriter::create(file.path(), soniqo_wav_spec()).map_err(|err| {
            crate::BatchFailure::DirectRequestFailed {
                provider: "soniqo".to_string(),
                message: format!("Failed to write temporary Soniqo audio file: {err}"),
            }
        })?;

        Ok(Self {
            channel_idx,
            file,
            writer,
            activity: ActiveSpanDetector::new(),
        })
    }

    fn write_sample(&mut self, sample: f32) -> crate::Result<()> {
        let sample = sample.clamp(-1.0, 1.0);
        self.writer.write_sample(sample).map_err(|err| {
            crate::BatchFailure::DirectRequestFailed {
                provider: "soniqo".to_string(),
                message: format!("Failed to write temporary Soniqo audio sample: {err}"),
            }
        })?;
        self.activity.push_sample(sample);
        Ok(())
    }

    fn finalize(self) -> crate::Result<PreparedSoniqoChannel> {
        let Self {
            channel_idx,
            file,
            writer,
            mut activity,
        } = self;
        writer
            .finalize()
            .map_err(|err| crate::BatchFailure::DirectRequestFailed {
                provider: "soniqo".to_string(),
                message: format!("Failed to finalize temporary Soniqo audio file: {err}"),
            })?;

        let sample_count = activity.sample_count();
        Ok(PreparedSoniqoChannel {
            channel_idx,
            file,
            sample_count,
            profile: activity.finish(),
        })
    }
}

struct ActiveSpanDetector {
    window_start_sample: usize,
    window_sample_count: usize,
    window_sum_squares: f32,
    active_start_sample: Option<usize>,
    sample_count: usize,
    spans: Vec<ActiveSpan>,
}

impl ActiveSpanDetector {
    fn new() -> Self {
        Self {
            window_start_sample: 0,
            window_sample_count: 0,
            window_sum_squares: 0.0,
            active_start_sample: None,
            sample_count: 0,
            spans: Vec::new(),
        }
    }

    fn push_sample(&mut self, sample: f32) {
        self.window_sum_squares += sample * sample;
        self.window_sample_count += 1;
        self.sample_count += 1;

        if self.window_sample_count >= active_window_samples() {
            self.finish_window();
        }
    }

    fn sample_count(&self) -> usize {
        self.sample_count
    }

    fn finish(&mut self) -> SoniqoChannelProfile {
        if self.window_sample_count > 0 {
            self.finish_window();
        }

        if let Some(span_start) = self.active_start_sample.take() {
            push_active_span(&mut self.spans, span_start, self.sample_count);
        }

        SoniqoChannelProfile {
            active_spans: std::mem::take(&mut self.spans),
        }
    }

    fn finish_window(&mut self) {
        let rms = (self.window_sum_squares / self.window_sample_count as f32).sqrt();
        let window_end_sample = self.window_start_sample + self.window_sample_count;
        if rms > SONIQO_ACTIVE_RMS_THRESHOLD {
            self.active_start_sample
                .get_or_insert(self.window_start_sample);
        } else if let Some(span_start) = self.active_start_sample.take() {
            push_active_span(&mut self.spans, span_start, self.window_start_sample);
        }

        self.window_start_sample = window_end_sample;
        self.window_sample_count = 0;
        self.window_sum_squares = 0.0;
    }
}

fn stream_resampled_frames<S>(
    mut source: S,
    channels: usize,
    source_sample_rate: u32,
    mut on_frame: impl FnMut(&[f32]) -> crate::Result<()>,
) -> crate::Result<()>
where
    S: Iterator<Item = f32>,
{
    if source_sample_rate == SONIQO_BATCH_SAMPLE_RATE {
        while let Some(frame) = read_source_frame(&mut source, channels) {
            on_frame(&frame)?;
        }
        return Ok(());
    }

    let Some(mut previous_frame) = read_source_frame(&mut source, channels) else {
        return Ok(());
    };
    let mut output_frame = vec![0.0; channels];
    let mut next_output_source_position = 0.0;
    let output_step = source_sample_rate as f64 / SONIQO_BATCH_SAMPLE_RATE as f64;
    let mut current_source_position = 0usize;

    while let Some(current_frame) = read_source_frame(&mut source, channels) {
        current_source_position += 1;

        while next_output_source_position <= current_source_position as f64 {
            let previous_source_position = current_source_position.saturating_sub(1) as f64;
            let alpha = (next_output_source_position - previous_source_position).clamp(0.0, 1.0);
            for channel_idx in 0..channels {
                output_frame[channel_idx] = lerp(
                    previous_frame[channel_idx],
                    current_frame[channel_idx],
                    alpha as f32,
                );
            }
            on_frame(&output_frame)?;
            next_output_source_position += output_step;
        }

        previous_frame = current_frame;
    }

    while next_output_source_position < current_source_position as f64 + 1.0 {
        on_frame(&previous_frame)?;
        next_output_source_position += output_step;
    }

    Ok(())
}

fn read_source_frame(source: &mut impl Iterator<Item = f32>, channels: usize) -> Option<Vec<f32>> {
    let mut frame = Vec::with_capacity(channels);
    for _ in 0..channels {
        frame.push(source.next()?);
    }
    Some(frame)
}

fn lerp(start: f32, end: f32, alpha: f32) -> f32 {
    start + (end - start) * alpha
}

fn crosstalk_suppression_gains(frames: &[Vec<f32>], channels: usize) -> Vec<f32> {
    let mut gains = vec![1.0; channels];
    if frames.is_empty() || channels <= 1 {
        return gains;
    }

    let samples_by_channel = samples_by_channel(frames, channels);
    let rms_by_channel = samples_by_channel
        .iter()
        .map(|samples| rms(samples))
        .collect::<Vec<_>>();
    let Some((dominant_channel, dominant_rms)) =
        rms_by_channel
            .iter()
            .copied()
            .enumerate()
            .max_by(|(_, left), (_, right)| {
                left.partial_cmp(right).unwrap_or(std::cmp::Ordering::Equal)
            })
    else {
        return gains;
    };

    if dominant_rms < SONIQO_CROSSTALK_MIN_DOMINANT_RMS {
        return gains;
    }

    for channel_idx in 0..channels {
        if channel_idx == dominant_channel {
            continue;
        }

        let channel_rms = rms_by_channel[channel_idx];
        if channel_rms <= 0.0 || dominant_rms / channel_rms < SONIQO_CROSSTALK_DOMINANCE_RATIO {
            continue;
        }

        let correlation = max_abs_lagged_correlation(
            &samples_by_channel[dominant_channel],
            &samples_by_channel[channel_idx],
        );
        if correlation >= SONIQO_CROSSTALK_MIN_CORRELATION {
            gains[channel_idx] = SONIQO_CROSSTALK_ATTENUATION;
        }
    }

    gains
}

fn samples_by_channel(frames: &[Vec<f32>], channels: usize) -> Vec<Vec<f32>> {
    let mut samples = (0..channels)
        .map(|_| Vec::with_capacity(frames.len()))
        .collect::<Vec<_>>();
    for frame in frames {
        for (idx, channel_samples) in samples.iter_mut().enumerate() {
            channel_samples.push(frame.get(idx).copied().unwrap_or_default());
        }
    }

    samples
}

fn max_abs_lagged_correlation(left: &[f32], right: &[f32]) -> f32 {
    let len = left.len().min(right.len());
    if len == 0 {
        return 0.0;
    }

    let max_lag = crosstalk_max_lag_samples().min(len.saturating_sub(1));
    let step = SONIQO_CROSSTALK_LAG_STEP_SAMPLES.max(1);
    let mut best = correlation(&left[..len], &right[..len]).abs();

    for lag in (step..=max_lag).step_by(step) {
        best = best.max(correlation(&left[lag..len], &right[..len - lag]).abs());
        best = best.max(correlation(&left[..len - lag], &right[lag..len]).abs());
    }

    best
}

fn correlation(left: &[f32], right: &[f32]) -> f32 {
    let len = left.len().min(right.len());
    if len == 0 {
        return 0.0;
    }

    let mut dot = 0.0;
    let mut left_sum = 0.0;
    let mut right_sum = 0.0;
    for idx in 0..len {
        let left = left[idx];
        let right = right[idx];
        dot += left * right;
        left_sum += left * left;
        right_sum += right * right;
    }

    let denom = (left_sum * right_sum).sqrt();
    if denom <= f32::EPSILON {
        0.0
    } else {
        dot / denom
    }
}

async fn transcribe_soniqo_prepared_channel(
    runtime: Arc<dyn BatchRuntime>,
    model: hypr_transcribe_soniqo::SoniqoModel,
    prepared_channel: PreparedSoniqoChannel,
    language: Option<String>,
) -> crate::Result<hypr_transcribe_soniqo::FileTranscript> {
    if prepared_channel.duration_seconds() <= SONIQO_BATCH_MAX_CHUNK_SECONDS {
        let mut transcribed = transcribe_soniqo_file(
            &runtime,
            model,
            prepared_channel.path(),
            language.as_deref(),
        )
        .await?;
        repair_soniqo_alignment(&mut transcribed, &prepared_channel.profile);
        align_soniqo_words(
            &runtime,
            &mut transcribed,
            prepared_channel.path(),
            language.as_deref(),
        )
        .await;
        ensure_soniqo_words(
            &mut transcribed,
            prepared_channel.duration_seconds(),
            &prepared_channel.profile,
        );
        return Ok(transcribed);
    }

    let chunks =
        build_soniqo_chunk_ranges(prepared_channel.sample_count, &prepared_channel.profile);
    let chunk_count = chunks.len();
    tracing::info!(
        hyprnote.soniqo.channel = prepared_channel.channel_idx,
        hyprnote.soniqo.chunk_count = chunk_count,
        hyprnote.soniqo.max_chunk_seconds = SONIQO_BATCH_MAX_CHUNK_SECONDS,
        hyprnote.soniqo.context_seconds = SONIQO_BATCH_CONTEXT_SECONDS,
        "soniqo_batch_channel_chunking_start"
    );

    let mut words = Vec::new();
    let total_duration = prepared_channel.duration_seconds();

    for chunk in chunks {
        let chunk_file = write_soniqo_channel_chunk_file(&prepared_channel, chunk)?;
        let mut transcribed =
            transcribe_soniqo_file(&runtime, model, chunk_file.path(), language.as_deref()).await?;
        let chunk_profile = SoniqoChannelProfile::from_file_range(&prepared_channel, chunk)?;
        repair_soniqo_alignment(&mut transcribed, &chunk_profile);
        align_soniqo_words(
            &runtime,
            &mut transcribed,
            chunk_file.path(),
            language.as_deref(),
        )
        .await;
        ensure_soniqo_words(&mut transcribed, chunk.duration_seconds(), &chunk_profile);
        offset_soniqo_transcript(&mut transcribed, chunk.start_seconds());

        let retained_words = retain_soniqo_words_for_commit(
            transcribed.words,
            chunk.commit_start_seconds(),
            chunk.commit_end_seconds(),
        );
        words.extend(retained_words);

        tracing::info!(
            hyprnote.soniqo.channel = prepared_channel.channel_idx,
            hyprnote.soniqo.chunk = chunk.index,
            hyprnote.soniqo.chunk_count = chunk_count,
            hyprnote.soniqo.chunk_start_seconds = chunk.start_seconds(),
            hyprnote.soniqo.chunk_duration_seconds = chunk.duration_seconds(),
            hyprnote.soniqo.commit_start_seconds = chunk.commit_start_seconds(),
            hyprnote.soniqo.commit_end_seconds = chunk.commit_end_seconds(),
            hyprnote.stt.aligned_words = words.len(),
            "soniqo_batch_chunk_transcription_completed"
        );
    }

    dedupe_soniqo_words(&mut words);
    let text = reconstruct_soniqo_text(&words);

    Ok(hypr_transcribe_soniqo::FileTranscript {
        text,
        duration_seconds: total_duration,
        words,
    })
}

async fn transcribe_soniqo_file(
    runtime: &Arc<dyn BatchRuntime>,
    model: hypr_transcribe_soniqo::SoniqoModel,
    path: &Path,
    language: Option<&str>,
) -> crate::Result<hypr_transcribe_soniqo::FileTranscript> {
    runtime
        .transcribe_soniqo(SoniqoTranscriptionRequest {
            model,
            audio_path: path.to_path_buf(),
            language: language.map(ToOwned::to_owned),
        })
        .await
        .map_err(|e| crate::BatchFailure::DirectRequestFailed {
            provider: "soniqo".to_string(),
            message: format_user_friendly_error(&e),
        })
        .map_err(Into::into)
}

async fn align_soniqo_words(
    runtime: &Arc<dyn BatchRuntime>,
    transcript: &mut hypr_transcribe_soniqo::FileTranscript,
    audio_path: &Path,
    language: Option<&str>,
) {
    if !transcript.words.is_empty() || transcript.text.trim().is_empty() {
        return;
    }

    let request = SoniqoAlignmentRequest {
        audio_path: audio_path.to_path_buf(),
        text: transcript.text.clone(),
        language: language.map(ToOwned::to_owned),
    };

    match runtime.align_soniqo(request).await {
        Ok(words) if !words.is_empty() => {
            transcript.words = words;
        }
        Ok(_) => {
            tracing::warn!("soniqo_forced_alignment_returned_empty");
        }
        Err(error) => {
            tracing::warn!(%error, "soniqo_forced_alignment_failed");
        }
    }
}

fn build_soniqo_chunk_ranges(
    sample_count: usize,
    profile: &SoniqoChannelProfile,
) -> Vec<SoniqoChunkRange> {
    if sample_count == 0 || profile.active_spans.is_empty() {
        return Vec::new();
    }

    let max_chunk_samples = seconds_to_samples(SONIQO_BATCH_MAX_CHUNK_SECONDS).max(1);
    let context_samples = seconds_to_samples(SONIQO_BATCH_CONTEXT_SECONDS)
        .min(max_chunk_samples.saturating_sub(1) / 2);
    let max_commit_samples = max_chunk_samples.saturating_sub(context_samples * 2).max(1);
    let mut commit_ranges = Vec::new();
    let mut current: Option<(usize, usize)> = None;

    for span in &profile.active_spans {
        let mut span_start = seconds_to_samples(span.start).min(sample_count);
        let span_end = seconds_to_samples(span.end).min(sample_count);
        if span_start >= span_end {
            continue;
        }

        while span_end - span_start > max_commit_samples {
            if let Some((current_start, current_end)) = current.take() {
                push_commit_range(&mut commit_ranges, current_start, current_end);
            }

            let split_end = span_start + max_commit_samples;
            push_commit_range(&mut commit_ranges, span_start, split_end);
            span_start = split_end;
        }

        if let Some((current_start, current_end)) = current {
            if span_end.saturating_sub(current_start) <= max_commit_samples {
                current = Some((current_start, current_end.max(span_end)));
            } else {
                push_commit_range(&mut commit_ranges, current_start, current_end);
                current = Some((span_start, span_end));
            }
        } else {
            current = Some((span_start, span_end));
        }
    }

    if let Some((start, end)) = current {
        push_commit_range(&mut commit_ranges, start, end);
    }

    commit_ranges
        .into_iter()
        .enumerate()
        .map(|(index, (commit_start_sample, commit_end_sample))| {
            let start_sample = commit_start_sample.saturating_sub(context_samples);
            let end_sample = commit_end_sample
                .saturating_add(context_samples)
                .min(sample_count);

            SoniqoChunkRange {
                index,
                start_sample,
                end_sample,
                commit_start_sample,
                commit_end_sample,
            }
        })
        .collect()
}

fn push_commit_range(ranges: &mut Vec<(usize, usize)>, start_sample: usize, end_sample: usize) {
    if start_sample < end_sample {
        ranges.push((start_sample, end_sample));
    }
}

fn retain_soniqo_words_for_commit(
    words: Vec<hypr_transcribe_soniqo::AlignedWord>,
    commit_start_seconds: f64,
    commit_end_seconds: f64,
) -> Vec<hypr_transcribe_soniqo::AlignedWord> {
    words
        .into_iter()
        .filter(|word| {
            let midpoint = word_midpoint(word);
            midpoint >= commit_start_seconds - SONIQO_BATCH_BOUNDARY_TOLERANCE_SECONDS
                && midpoint <= commit_end_seconds + SONIQO_BATCH_BOUNDARY_TOLERANCE_SECONDS
        })
        .collect()
}

fn dedupe_soniqo_words(words: &mut Vec<hypr_transcribe_soniqo::AlignedWord>) {
    words.sort_by(|left, right| {
        left.start
            .partial_cmp(&right.start)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| {
                left.end
                    .partial_cmp(&right.end)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
    });

    let mut deduped: Vec<hypr_transcribe_soniqo::AlignedWord> = Vec::with_capacity(words.len());
    for word in words.drain(..) {
        if let Some(last) = deduped.last_mut()
            && soniqo_words_are_boundary_duplicate(last, &word)
        {
            if word.confidence > last.confidence {
                *last = word;
            }
            continue;
        }
        deduped.push(word);
    }

    *words = deduped;
}

fn soniqo_words_are_boundary_duplicate(
    left: &hypr_transcribe_soniqo::AlignedWord,
    right: &hypr_transcribe_soniqo::AlignedWord,
) -> bool {
    normalized_soniqo_word(&left.word) == normalized_soniqo_word(&right.word)
        && (word_intersection_seconds(left, right) > 0.0
            || (word_midpoint(left) - word_midpoint(right)).abs() <= SONIQO_BOUNDARY_DEDUPE_SECONDS)
}

fn normalized_soniqo_word(word: &str) -> String {
    strip_ascii_punctuation(word)
        .unwrap_or(word)
        .to_ascii_lowercase()
}

fn word_intersection_seconds(
    left: &hypr_transcribe_soniqo::AlignedWord,
    right: &hypr_transcribe_soniqo::AlignedWord,
) -> f64 {
    left.end.min(right.end) - left.start.max(right.start)
}

fn word_midpoint(word: &hypr_transcribe_soniqo::AlignedWord) -> f64 {
    (word.start + word.end) / 2.0
}

fn reconstruct_soniqo_text(words: &[hypr_transcribe_soniqo::AlignedWord]) -> String {
    words
        .iter()
        .map(|word| word.word.trim())
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn ensure_soniqo_words(
    transcript: &mut hypr_transcribe_soniqo::FileTranscript,
    duration_seconds: f64,
    profile: &SoniqoChannelProfile,
) {
    if transcript.words.is_empty() && !transcript.text.trim().is_empty() {
        transcript.words =
            synthesize_soniqo_words_for_profile(&transcript.text, duration_seconds, profile);
    }
}

fn synthesize_soniqo_words_for_profile(
    text: &str,
    duration_seconds: f64,
    profile: &SoniqoChannelProfile,
) -> Vec<hypr_transcribe_soniqo::AlignedWord> {
    let spans = normalized_active_spans(&profile.active_spans, duration_seconds);
    if spans.is_empty() {
        return synthesize_soniqo_words(text, duration_seconds);
    }

    let tokens: Vec<&str> = text
        .split_whitespace()
        .filter(|token| !token.is_empty())
        .collect();
    if tokens.is_empty() {
        return Vec::new();
    }

    let active_duration = spans.iter().map(|span| span.end - span.start).sum::<f64>();
    if active_duration <= 0.0 {
        return synthesize_soniqo_words(text, duration_seconds);
    }

    let mut tokens_by_span = vec![Vec::new(); spans.len()];
    for (idx, token) in tokens.iter().copied().enumerate() {
        let active_midpoint = active_duration * (idx as f64 + 0.5) / tokens.len() as f64;
        let span_idx = span_index_at_active_offset(&spans, active_midpoint);
        tokens_by_span[span_idx].push(token);
    }

    spans
        .iter()
        .zip(tokens_by_span)
        .flat_map(|(span, tokens)| synthesize_soniqo_words_in_span(&tokens, *span))
        .collect()
}

fn normalized_active_spans(spans: &[ActiveSpan], duration_seconds: f64) -> Vec<ActiveSpan> {
    spans
        .iter()
        .filter_map(|span| {
            let start = span.start.clamp(0.0, duration_seconds);
            let end = span.end.clamp(0.0, duration_seconds);
            (end > start).then_some(ActiveSpan { start, end })
        })
        .collect()
}

fn span_index_at_active_offset(spans: &[ActiveSpan], offset_seconds: f64) -> usize {
    let mut remaining = offset_seconds;
    for (idx, span) in spans.iter().enumerate() {
        let span_duration = span.end - span.start;
        if remaining <= span_duration {
            return idx;
        }
        remaining -= span_duration;
    }

    spans.len().saturating_sub(1)
}

fn synthesize_soniqo_words_in_span(
    tokens: &[&str],
    span: ActiveSpan,
) -> Vec<hypr_transcribe_soniqo::AlignedWord> {
    if tokens.is_empty() {
        return Vec::new();
    }

    let duration = (span.end - span.start).max(0.0);
    let word_duration = duration / tokens.len() as f64;

    tokens
        .iter()
        .copied()
        .enumerate()
        .map(|(idx, token)| {
            let start = span.start + word_duration * idx as f64;
            let end = if idx + 1 == tokens.len() {
                span.end
            } else {
                (start + word_duration).min(span.end)
            };
            hypr_transcribe_soniqo::AlignedWord {
                word: strip_ascii_punctuation(token).unwrap_or(token).to_string(),
                start,
                end,
                confidence: 1.0,
            }
        })
        .collect()
}

fn synthesize_soniqo_words(
    text: &str,
    duration_seconds: f64,
) -> Vec<hypr_transcribe_soniqo::AlignedWord> {
    let tokens: Vec<&str> = text
        .split_whitespace()
        .filter(|token| !token.is_empty())
        .collect();
    if tokens.is_empty() {
        return Vec::new();
    }

    let duration = duration_seconds.max(tokens.len() as f64 * SYNTHETIC_WORD_SECONDS);
    let word_duration = duration / tokens.len() as f64;

    tokens
        .into_iter()
        .enumerate()
        .map(|(idx, token)| {
            let start = word_duration * idx as f64;
            let end = word_duration * (idx as f64 + 1.0);
            hypr_transcribe_soniqo::AlignedWord {
                word: strip_ascii_punctuation(token).unwrap_or(token).to_string(),
                start,
                end: end.min(duration).max(start + 0.05),
                confidence: 1.0,
            }
        })
        .collect()
}

fn strip_ascii_punctuation(token: &str) -> Option<&str> {
    let stripped = token.trim_matches(|c: char| c.is_ascii_punctuation());
    (!stripped.is_empty()).then_some(stripped)
}

fn offset_soniqo_transcript(
    transcript: &mut hypr_transcribe_soniqo::FileTranscript,
    offset_seconds: f64,
) {
    for word in &mut transcript.words {
        word.start += offset_seconds;
        word.end += offset_seconds;
    }
}

impl SoniqoChannelProfile {
    fn from_samples(samples: &[f32]) -> Self {
        Self {
            active_spans: active_spans(samples),
        }
    }

    fn from_file_range(
        channel: &PreparedSoniqoChannel,
        range: SoniqoChunkRange,
    ) -> crate::Result<Self> {
        let samples =
            read_soniqo_channel_samples(channel.path(), range.start_sample, range.end_sample)?;
        Ok(Self::from_samples(&samples))
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

fn seconds_to_samples(seconds: f64) -> usize {
    (seconds.max(0.0) * SONIQO_BATCH_SAMPLE_RATE as f64).round() as usize
}

fn sample_to_seconds(samples: usize) -> f64 {
    samples as f64 / SONIQO_BATCH_SAMPLE_RATE as f64
}

fn active_window_samples() -> usize {
    (SONIQO_BATCH_SAMPLE_RATE as f64 * SONIQO_ACTIVE_WINDOW_SECONDS)
        .round()
        .max(1.0) as usize
}

fn crosstalk_max_lag_samples() -> usize {
    (SONIQO_BATCH_SAMPLE_RATE as f64 * SONIQO_CROSSTALK_MAX_LAG_SECONDS)
        .round()
        .max(0.0) as usize
}

fn active_spans(samples: &[f32]) -> Vec<ActiveSpan> {
    let window = active_window_samples();
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

fn write_soniqo_channel_chunk_file(
    channel: &PreparedSoniqoChannel,
    range: SoniqoChunkRange,
) -> crate::Result<tempfile::NamedTempFile> {
    let samples =
        read_soniqo_channel_samples(channel.path(), range.start_sample, range.end_sample)?;
    write_soniqo_channel_file(&samples)
}

fn read_soniqo_channel_samples(
    path: &Path,
    start_sample: usize,
    end_sample: usize,
) -> crate::Result<Vec<f32>> {
    let sample_count = end_sample.saturating_sub(start_sample);
    let mut reader =
        hound::WavReader::open(path).map_err(|err| crate::BatchFailure::DirectRequestFailed {
            provider: "soniqo".to_string(),
            message: format!("Failed to read prepared Soniqo audio file: {err}"),
        })?;
    let seek_sample =
        u32::try_from(start_sample).map_err(|_| crate::BatchFailure::DirectRequestFailed {
            provider: "soniqo".to_string(),
            message: "Prepared Soniqo audio is too long to seek safely.".to_string(),
        })?;
    reader
        .seek(seek_sample)
        .map_err(|err| crate::BatchFailure::DirectRequestFailed {
            provider: "soniqo".to_string(),
            message: format!("Failed to seek prepared Soniqo audio file: {err}"),
        })?;

    Ok(reader
        .samples::<f32>()
        .take(sample_count)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| crate::BatchFailure::DirectRequestFailed {
            provider: "soniqo".to_string(),
            message: format!("Failed to read prepared Soniqo audio samples: {err}"),
        })?)
}

fn soniqo_wav_spec() -> hound::WavSpec {
    hound::WavSpec {
        channels: 1,
        sample_rate: SONIQO_BATCH_SAMPLE_RATE,
        bits_per_sample: 32,
        sample_format: hound::SampleFormat::Float,
    }
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

    let mut writer =
        hound::WavWriter::create(prepared.path(), soniqo_wav_spec()).map_err(|err| {
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
    fn prepare_soniqo_batch_audio_suppresses_correlated_channel_bleed() {
        let temp_dir = tempfile::tempdir().unwrap();
        let path = temp_dir.path().join("bleed.wav");
        let spec = hound::WavSpec {
            channels: 2,
            sample_rate: SONIQO_BATCH_SAMPLE_RATE,
            bits_per_sample: 32,
            sample_format: hound::SampleFormat::Float,
        };
        let mut writer = hound::WavWriter::create(&path, spec).unwrap();
        for index in 0..SONIQO_BATCH_SAMPLE_RATE as usize {
            let system_sample = square_sample(index, 64, 0.5);
            writer.write_sample(system_sample * 0.1).unwrap();
            writer.write_sample(system_sample).unwrap();
        }
        writer.finalize().unwrap();

        let prepared = prepare_soniqo_batch_audio(path.to_str().unwrap()).unwrap();

        let mic_max_abs = max_abs_sample(prepared[0].path());
        let system_max_abs = max_abs_sample(prepared[1].path());
        assert!(
            mic_max_abs < 0.01,
            "correlated bleed should be strongly attenuated, got {mic_max_abs}"
        );
        assert!(
            system_max_abs > 0.1,
            "dominant system channel should be preserved"
        );
    }

    #[test]
    fn prepare_soniqo_batch_audio_keeps_independent_quiet_channel() {
        let temp_dir = tempfile::tempdir().unwrap();
        let path = temp_dir.path().join("independent.wav");
        let spec = hound::WavSpec {
            channels: 2,
            sample_rate: SONIQO_BATCH_SAMPLE_RATE,
            bits_per_sample: 32,
            sample_format: hound::SampleFormat::Float,
        };
        let mut writer = hound::WavWriter::create(&path, spec).unwrap();
        for index in 0..SONIQO_BATCH_SAMPLE_RATE as usize {
            writer.write_sample(square_sample(index, 37, 0.08)).unwrap();
            writer.write_sample(square_sample(index, 64, 0.5)).unwrap();
        }
        writer.finalize().unwrap();

        let prepared = prepare_soniqo_batch_audio(path.to_str().unwrap()).unwrap();

        let mic_max_abs = max_abs_sample(prepared[0].path());
        assert!(
            mic_max_abs > 0.05,
            "independent quiet mic channel should not be treated as crosstalk"
        );
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
    fn streaming_activity_detector_matches_batch_active_spans() {
        let mut samples = vec![0.0; SONIQO_BATCH_SAMPLE_RATE as usize * 3];
        samples[16_000..24_000].fill(0.01);
        samples[32_000..40_000].fill(0.01);
        let mut detector = ActiveSpanDetector::new();

        for sample in samples.iter().copied() {
            detector.push_sample(sample);
        }
        let profile = detector.finish();

        assert_eq!(profile.active_spans, active_spans(&samples));
    }

    #[test]
    fn stream_resampled_frames_downsamples_and_preserves_channels() {
        let channels = 2;
        let mut source = Vec::new();
        for frame in 0..48_000 {
            source.push(frame as f32);
            source.push(-(frame as f32));
        }
        let mut frames = Vec::new();

        stream_resampled_frames(source.into_iter(), channels, 48_000, |frame| {
            frames.push(frame.to_vec());
            Ok(())
        })
        .unwrap();

        assert_eq!(frames.len(), 16_000);
        assert_eq!(frames[0], vec![0.0, -0.0]);
        assert_eq!(frames[1], vec![3.0, -3.0]);
        assert_eq!(frames[15_999], vec![47_997.0, -47_997.0]);
    }

    #[test]
    fn stream_resampled_frames_upsamples_to_target_duration() {
        let source = vec![0.0; 8_000];
        let mut frame_count = 0usize;

        stream_resampled_frames(source.into_iter(), 1, 8_000, |_| {
            frame_count += 1;
            Ok(())
        })
        .unwrap();

        assert_eq!(frame_count, 16_000);
    }

    #[test]
    fn prepared_long_audio_reads_only_soniqo_safe_chunk_files() {
        let temp_dir = tempfile::tempdir().unwrap();
        let path = temp_dir.path().join("long-active.wav");
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: SONIQO_BATCH_SAMPLE_RATE,
            bits_per_sample: 32,
            sample_format: hound::SampleFormat::Float,
        };
        let mut writer = hound::WavWriter::create(&path, spec).unwrap();
        for _ in 0..(SONIQO_BATCH_SAMPLE_RATE as usize * 70) {
            writer.write_sample(0.01f32).unwrap();
        }
        writer.finalize().unwrap();

        let prepared = prepare_soniqo_batch_audio(path.to_str().unwrap()).unwrap();
        assert_eq!(prepared.len(), 1);
        assert_eq!(prepared[0].duration_seconds(), 70.0);

        let chunks = build_soniqo_chunk_ranges(prepared[0].sample_count, &prepared[0].profile);
        assert_eq!(chunks.len(), 4);

        for chunk in chunks {
            let chunk_file = write_soniqo_channel_chunk_file(&prepared[0], chunk).unwrap();
            let reader = hound::WavReader::open(chunk_file.path()).unwrap();
            let chunk_duration = reader.duration() as f64 / SONIQO_BATCH_SAMPLE_RATE as f64;
            assert!(
                chunk_duration <= SONIQO_BATCH_MAX_CHUNK_SECONDS,
                "chunk duration {chunk_duration} should stay below Soniqo's per-file limit"
            );
        }
    }

    #[tokio::test]
    #[ignore = "requires local Soniqo Parakeet and Qwen3 forced aligner model assets"]
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    async fn soniqo_batch_local_smoke_transcribes_audio_over_model_window() {
        let temp_dir = tempfile::tempdir().unwrap();
        let path = temp_dir.path().join("repeated-speech.wav");
        write_repeated_fixture(&path, 2);

        let prepared = prepare_soniqo_batch_audio(path.to_str().unwrap()).unwrap();
        assert_eq!(prepared.len(), 1);
        assert!(prepared[0].duration_seconds() > SONIQO_BATCH_MAX_CHUNK_SECONDS);
        assert!(
            build_soniqo_chunk_ranges(prepared[0].sample_count, &prepared[0].profile).len() > 1
        );

        let transcript = transcribe_soniqo_prepared_channel(
            Arc::new(NoopBatchRuntime),
            hypr_transcribe_soniqo::SoniqoModel::ParakeetBatch,
            prepared.into_iter().next().unwrap(),
            Some("en".to_string()),
        )
        .await
        .expect("long local Soniqo batch transcription should complete");

        assert!(transcript.duration_seconds > SONIQO_BATCH_MAX_CHUNK_SECONDS);
        assert!(!transcript.text.trim().is_empty());
        assert!(!transcript.words.is_empty());
        assert!(
            transcript
                .words
                .iter()
                .all(|word| word.end >= word.start && word.start >= 0.0)
        );
    }

    #[test]
    fn build_soniqo_chunk_ranges_prefers_silence_boundaries() {
        let mut samples = vec![0.0; SONIQO_BATCH_SAMPLE_RATE as usize * 40];
        fill_active_seconds(&mut samples, 0, 12);
        fill_active_seconds(&mut samples, 20, 32);
        let profile = SoniqoChannelProfile::from_samples(&samples);

        let ranges = build_soniqo_chunk_ranges(samples.len(), &profile);

        assert_eq!(ranges.len(), 2);
        assert_eq!(ranges[0].commit_start_seconds(), 0.0);
        assert_eq!(ranges[0].commit_end_seconds(), 12.0);
        assert_eq!(ranges[0].start_seconds(), 0.0);
        assert_eq!(ranges[0].duration_seconds(), 13.0);
        assert_eq!(ranges[1].commit_start_seconds(), 20.0);
        assert_eq!(ranges[1].commit_end_seconds(), 32.0);
        assert_eq!(ranges[1].start_seconds(), 19.0);
        assert_eq!(ranges[1].duration_seconds(), 14.0);
    }

    #[test]
    fn build_soniqo_chunk_ranges_splits_continuous_speech_with_context_overlap() {
        let samples = vec![0.01; SONIQO_BATCH_SAMPLE_RATE as usize * 60];
        let profile = SoniqoChannelProfile::from_samples(&samples);

        let ranges = build_soniqo_chunk_ranges(samples.len(), &profile);

        assert_eq!(ranges.len(), 3);
        assert_eq!(ranges[0].commit_start_seconds(), 0.0);
        assert_eq!(ranges[0].commit_end_seconds(), 23.0);
        assert_eq!(ranges[1].commit_start_seconds(), 23.0);
        assert_eq!(ranges[1].commit_end_seconds(), 46.0);
        assert_eq!(ranges[2].commit_start_seconds(), 46.0);
        assert_eq!(ranges[2].commit_end_seconds(), 60.0);
        assert!(
            ranges
                .iter()
                .all(|range| range.duration_seconds() <= SONIQO_BATCH_MAX_CHUNK_SECONDS)
        );
        assert!(ranges[1].start_seconds() < ranges[0].commit_end_seconds());
        assert!(ranges[2].start_seconds() < ranges[1].commit_end_seconds());
    }

    #[test]
    fn build_soniqo_chunk_ranges_handles_four_hour_continuous_speech() {
        let duration_seconds = 4 * 60 * 60;
        let sample_count = SONIQO_BATCH_SAMPLE_RATE as usize * duration_seconds;
        let profile = SoniqoChannelProfile {
            active_spans: vec![ActiveSpan {
                start: 0.0,
                end: duration_seconds as f64,
            }],
        };

        let ranges = build_soniqo_chunk_ranges(sample_count, &profile);

        assert_eq!(ranges.len(), 627);
        assert_eq!(ranges[0].commit_start_seconds(), 0.0);
        assert_eq!(
            ranges.last().unwrap().commit_end_seconds(),
            duration_seconds as f64
        );
        assert!(
            ranges
                .iter()
                .all(|range| range.duration_seconds() <= SONIQO_BATCH_MAX_CHUNK_SECONDS)
        );
        for pair in ranges.windows(2) {
            assert_eq!(pair[0].commit_end_sample, pair[1].commit_start_sample);
            assert!(pair[1].start_sample < pair[0].commit_end_sample);
        }
    }

    #[test]
    fn retain_soniqo_words_for_commit_keeps_boundary_words_with_tolerance() {
        let retained = retain_soniqo_words_for_commit(
            vec![
                aligned_word("before", 22.3, 22.5),
                aligned_word("split", 22.8, 23.2),
                aligned_word("after", 23.5, 23.7),
            ],
            0.0,
            23.0,
        );

        assert_eq!(
            retained
                .iter()
                .map(|word| word.word.as_str())
                .collect::<Vec<_>>(),
            vec!["before", "split"]
        );
    }

    #[test]
    fn dedupe_soniqo_words_removes_overlapped_boundary_duplicate() {
        let mut words = vec![
            aligned_word("hello", 0.2, 0.5),
            aligned_word("split", 22.8, 23.2),
            aligned_word("split", 22.9, 23.3),
            aligned_word("world", 24.0, 24.2),
        ];

        dedupe_soniqo_words(&mut words);

        assert_eq!(
            words
                .iter()
                .map(|word| word.word.as_str())
                .collect::<Vec<_>>(),
            vec!["hello", "split", "world"]
        );
    }

    #[test]
    fn synthesize_soniqo_words_strips_outer_punctuation() {
        let words = synthesize_soniqo_words("Hello, world.", 2.0);

        assert_eq!(words.len(), 2);
        assert_eq!(words[0].word, "Hello");
        assert_eq!(words[0].start, 0.0);
        assert_eq!(words[0].end, 1.0);
        assert_eq!(words[1].word, "world");
        assert_eq!(words[1].start, 1.0);
        assert_eq!(words[1].end, 2.0);
    }

    #[test]
    fn synthesize_soniqo_words_uses_active_spans_instead_of_silence() {
        let profile = SoniqoChannelProfile {
            active_spans: vec![
                ActiveSpan {
                    start: 5.0,
                    end: 7.0,
                },
                ActiveSpan {
                    start: 10.0,
                    end: 12.0,
                },
            ],
        };

        let words = synthesize_soniqo_words_for_profile("one two three four", 15.0, &profile);

        assert_eq!(words.len(), 4);
        assert_eq!(
            words
                .iter()
                .map(|word| word.word.as_str())
                .collect::<Vec<_>>(),
            vec!["one", "two", "three", "four"]
        );
        assert!(words[0].start >= 5.0);
        assert!(words[1].end <= 7.0);
        assert!(words[2].start >= 10.0);
        assert!(words[3].end <= 12.0);
    }

    #[test]
    fn offset_soniqo_transcript_moves_word_timings() {
        let mut transcript = hypr_transcribe_soniqo::FileTranscript {
            text: "hello".to_string(),
            duration_seconds: 1.0,
            words: vec![aligned_word("hello", 0.2, 0.8)],
        };

        offset_soniqo_transcript(&mut transcript, 25.0);

        assert_eq!(transcript.words[0].start, 25.2);
        assert_eq!(transcript.words[0].end, 25.8);
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

    fn fill_active_seconds(samples: &mut [f32], start_seconds: usize, end_seconds: usize) {
        let start = start_seconds * SONIQO_BATCH_SAMPLE_RATE as usize;
        let end = end_seconds * SONIQO_BATCH_SAMPLE_RATE as usize;
        samples[start..end].fill(0.01);
    }

    fn square_sample(index: usize, period: usize, amplitude: f32) -> f32 {
        if index % period < period / 2 {
            amplitude
        } else {
            -amplitude
        }
    }

    fn max_abs_sample(path: &Path) -> f32 {
        let mut reader = hound::WavReader::open(path).unwrap();
        reader
            .samples::<f32>()
            .map(|sample| sample.unwrap().abs())
            .fold(0.0f32, f32::max)
    }

    struct NoopBatchRuntime;

    impl BatchRuntime for NoopBatchRuntime {
        fn emit(&self, _event: crate::BatchEvent) {}
    }

    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    fn write_repeated_fixture(path: &Path, repeat_count: usize) {
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../data/src/english_1/audio_part2_16000hz.wav");
        let mut reader = hound::WavReader::open(fixture).unwrap();
        let spec = reader.spec();
        let samples = reader
            .samples::<i16>()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        let mut writer = hound::WavWriter::create(path, spec).unwrap();
        for _ in 0..repeat_count {
            for sample in &samples {
                writer.write_sample(*sample).unwrap();
            }
        }
        writer.finalize().unwrap();
    }
}
