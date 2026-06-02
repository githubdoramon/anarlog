use std::fs::File;
use std::io::BufWriter;
use std::path::{Path, PathBuf};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use hypr_audio_utils::{
    decode_vorbis_to_mono_wav_file, decode_vorbis_to_wav_file, mix_audio_f32,
    ogg_has_identical_channels,
};
use ractor::ActorProcessingErr;

use crate::actors::SAMPLE_RATE;

use super::into_actor_err;

const FINAL_AUDIO_FILE: &str = "audio.mp3";
const MP3_TMP_FILE: &str = "audio.mp3.tmp";
const RECORDING_MANIFEST_FILE: &str = "audio.recording.json";
const WAV_FILE: &str = "audio.wav";
const OGG_FILE: &str = "audio.ogg";
const FLUSH_INTERVAL: std::time::Duration = std::time::Duration::from_millis(1000);
const SILENT_CHANNEL_MIN_SECONDS: usize = 2;
const SILENT_CHANNEL_PEAK_THRESHOLD: f32 = 1e-5;

pub(super) struct DiskSink {
    writer: Option<hound::WavWriter<BufWriter<File>>>,
    writer_mic: Option<hound::WavWriter<BufWriter<File>>>,
    writer_spk: Option<hound::WavWriter<BufWriter<File>>>,
    session_id: String,
    session_dir: PathBuf,
    wav_path: PathBuf,
    manifest_path: PathBuf,
    last_flush: Instant,
    is_stereo: bool,
    frames_written: usize,
    channel_stats: ChannelStats,
}

#[derive(Default)]
struct ChannelStats {
    dual_samples: usize,
    mic_peak: f32,
    spk_peak: f32,
    mic_energy: f64,
    spk_energy: f64,
}

impl ChannelStats {
    fn observe_dual(&mut self, mic: &[f32], spk: &[f32]) {
        let frames = mic.len().max(spk.len());
        self.dual_samples += frames;

        for sample in mic.iter().copied().filter(|sample| sample.is_finite()) {
            self.mic_peak = self.mic_peak.max(sample.abs());
            self.mic_energy += f64::from(sample * sample);
        }

        for sample in spk.iter().copied().filter(|sample| sample.is_finite()) {
            self.spk_peak = self.spk_peak.max(sample.abs());
            self.spk_energy += f64::from(sample * sample);
        }
    }

    fn should_warn_silent_speaker(&self) -> bool {
        self.dual_samples >= SAMPLE_RATE as usize * SILENT_CHANNEL_MIN_SECONDS
            && self.mic_peak > SILENT_CHANNEL_PEAK_THRESHOLD
            && self.spk_peak <= SILENT_CHANNEL_PEAK_THRESHOLD
    }

    fn mic_rms(&self) -> f64 {
        self.rms(self.mic_energy)
    }

    fn spk_rms(&self) -> f64 {
        self.rms(self.spk_energy)
    }

    fn rms(&self, energy: f64) -> f64 {
        if self.dual_samples == 0 {
            return 0.0;
        }

        (energy / self.dual_samples as f64).sqrt()
    }
}

pub(super) fn create_disk_sink(
    session_id: &str,
    session_dir: &Path,
) -> Result<DiskSink, ActorProcessingErr> {
    let wav_path = session_dir.join(WAV_FILE);
    let ogg_path = session_dir.join(OGG_FILE);
    let encoded_path = session_dir.join(FINAL_AUDIO_FILE);
    let manifest_path = session_dir.join(RECORDING_MANIFEST_FILE);
    let is_stereo = prepare_existing_audio_state(&encoded_path, &ogg_path, &wav_path)?;

    let stereo_spec = hound::WavSpec {
        channels: 2,
        sample_rate: super::super::SAMPLE_RATE,
        bits_per_sample: 32,
        sample_format: hound::SampleFormat::Float,
    };
    let mono_spec = hound::WavSpec {
        channels: 1,
        sample_rate: super::super::SAMPLE_RATE,
        bits_per_sample: 32,
        sample_format: hound::SampleFormat::Float,
    };

    let writer = if wav_path.exists() {
        hound::WavWriter::append(&wav_path)?
    } else if is_stereo {
        hound::WavWriter::create(&wav_path, stereo_spec)?
    } else {
        hound::WavWriter::create(&wav_path, mono_spec)?
    };

    let (writer_mic, writer_spk) = if is_debug_mode() {
        let mic_path = session_dir.join("audio_mic.wav");
        let spk_path = session_dir.join("audio_spk.wav");

        let mic_writer = if mic_path.exists() {
            hound::WavWriter::append(&mic_path)?
        } else {
            hound::WavWriter::create(&mic_path, mono_spec)?
        };

        let spk_writer = if spk_path.exists() {
            hound::WavWriter::append(&spk_path)?
        } else {
            hound::WavWriter::create(&spk_path, mono_spec)?
        };

        (Some(mic_writer), Some(spk_writer))
    } else {
        (None, None)
    };

    tracing::info!(
        session_id,
        session_dir = %session_dir.display(),
        wav_path = %wav_path.display(),
        mp3_path = %encoded_path.display(),
        "recording_disk_sink_opened"
    );

    let sink = DiskSink {
        writer: Some(writer),
        writer_mic,
        writer_spk,
        session_id: session_id.to_string(),
        session_dir: session_dir.to_path_buf(),
        wav_path,
        manifest_path,
        last_flush: Instant::now(),
        is_stereo,
        frames_written: 0,
        channel_stats: ChannelStats::default(),
    };
    write_recording_manifest(&sink, "recording");

    Ok(sink)
}

pub(super) fn write_single(sink: &mut DiskSink, samples: &[f32]) -> Result<(), ActorProcessingErr> {
    if let Some(writer) = sink.writer.as_mut() {
        if sink.is_stereo {
            write_mono_as_stereo(writer, samples)?;
        } else {
            write_mono_samples(writer, samples)?;
        }
    }

    sink.frames_written += samples.len();
    flush_if_due(sink)?;
    Ok(())
}

pub(super) fn write_dual(
    sink: &mut DiskSink,
    mic: &[f32],
    spk: &[f32],
) -> Result<(), ActorProcessingErr> {
    sink.channel_stats.observe_dual(mic, spk);

    if let Some(writer) = sink.writer.as_mut() {
        if sink.is_stereo {
            write_interleaved_stereo(writer, mic, spk)?;
        } else {
            let mixed = mix_audio_f32(mic, spk);
            write_mono_samples(writer, &mixed)?;
        }
    }

    if let Some(writer_mic) = sink.writer_mic.as_mut() {
        write_mono_samples(writer_mic, mic)?;
    }

    if let Some(writer_spk) = sink.writer_spk.as_mut() {
        write_mono_samples(writer_spk, spk)?;
    }

    sink.frames_written += mic.len().max(spk.len());
    flush_if_due(sink)?;
    Ok(())
}

pub(super) fn finalize_disk_sink(sink: &mut DiskSink) -> Result<(), ActorProcessingErr> {
    if sink.channel_stats.should_warn_silent_speaker() {
        tracing::warn!(
            path = %sink.wav_path.display(),
            samples = sink.channel_stats.dual_samples,
            mic_peak = sink.channel_stats.mic_peak,
            spk_peak = sink.channel_stats.spk_peak,
            mic_rms = sink.channel_stats.mic_rms(),
            spk_rms = sink.channel_stats.spk_rms(),
            "system_audio_channel_silent"
        );
    }

    tracing::info!(
        session_id = %sink.session_id,
        wav_path = %sink.wav_path.display(),
        frames_written = sink.frames_written,
        wav_size = file_size(&sink.wav_path),
        "recording_audio_finalize_started"
    );
    write_recording_manifest(sink, "finalizing");

    finalize_writer(&mut sink.writer, Some(&sink.wav_path))?;
    finalize_writer(&mut sink.writer_mic, None)?;
    finalize_writer(&mut sink.writer_spk, None)?;

    if sink.wav_path.exists() {
        let encoded_path = sink.session_dir.join(FINAL_AUDIO_FILE);
        let tmp_path = sink.session_dir.join(MP3_TMP_FILE);
        if tmp_path.exists() {
            tracing::warn!(
                session_id = %sink.session_id,
                tmp_path = %tmp_path.display(),
                tmp_size = file_size(&tmp_path),
                "recording_audio_removing_stale_tmp_before_encode"
            );
            let _ = std::fs::remove_file(&tmp_path);
            sync_dir(&tmp_path);
        }

        match hypr_mp3::encode_wav(&sink.wav_path, &tmp_path) {
            Ok(()) => {
                sync_file(&tmp_path);
                let encoded_size = file_size(&tmp_path).unwrap_or(0);
                if encoded_size == 0 {
                    tracing::error!(
                        session_id = %sink.session_id,
                        tmp_path = %tmp_path.display(),
                        wav_path = %sink.wav_path.display(),
                        "recording_audio_encode_empty_tmp_wav_retained"
                    );
                    write_recording_manifest(sink, "encode_failed_wav_retained");
                    sync_file(&sink.wav_path);
                    sync_dir(&sink.wav_path);
                    return Ok(());
                }

                if encoded_path.exists() {
                    tracing::warn!(
                        session_id = %sink.session_id,
                        mp3_path = %encoded_path.display(),
                        mp3_size = file_size(&encoded_path),
                        "recording_audio_removing_existing_mp3_before_atomic_rename"
                    );
                    std::fs::remove_file(&encoded_path)?;
                    sync_dir(&encoded_path);
                }
                std::fs::rename(&tmp_path, &encoded_path)?;
                sync_file(&encoded_path);
                sync_dir(&sink.wav_path);
                tracing::info!(
                    session_id = %sink.session_id,
                    mp3_path = %encoded_path.display(),
                    mp3_size = encoded_size,
                    "recording_audio_encoded"
                );

                std::fs::remove_file(&sink.wav_path)?;
                sync_dir(&sink.wav_path);
                tracing::info!(
                    session_id = %sink.session_id,
                    wav_path = %sink.wav_path.display(),
                    mp3_path = %encoded_path.display(),
                    "recording_audio_wav_removed_after_mp3_persisted"
                );
                write_recording_manifest(sink, "finalized");
            }
            Err(error) => {
                tracing::error!(
                    session_id = %sink.session_id,
                    wav_path = %sink.wav_path.display(),
                    error = %error,
                    "recording_audio_encode_failed_wav_retained"
                );
                write_recording_manifest(sink, "encode_failed_wav_retained");
                sync_file(&sink.wav_path);
                sync_dir(&sink.wav_path);
            }
        }
    } else {
        tracing::warn!(
            session_id = %sink.session_id,
            wav_path = %sink.wav_path.display(),
            frames_written = sink.frames_written,
            "recording_audio_finalize_missing_wav"
        );
        write_recording_manifest(sink, "finalized_missing_audio");
    }

    Ok(())
}

fn prepare_existing_audio_state(
    encoded_path: &Path,
    ogg_path: &Path,
    wav_path: &Path,
) -> Result<bool, ActorProcessingErr> {
    if encoded_path.exists() && !wav_path.exists() {
        tracing::info!(
            mp3_path = %encoded_path.display(),
            wav_path = %wav_path.display(),
            "recording_audio_existing_mp3_decoding_for_append"
        );
        hypr_mp3::decode_to_wav(encoded_path, wav_path).map_err(into_actor_err)?;
        sync_file(wav_path);
        sync_dir(wav_path);
        std::fs::remove_file(encoded_path)?;
        sync_dir(encoded_path);
    }

    if ogg_path.exists() {
        tracing::info!(
            ogg_path = %ogg_path.display(),
            wav_path = %wav_path.display(),
            "recording_audio_existing_ogg_decoding_for_append"
        );
        let has_identical = ogg_has_identical_channels(ogg_path).map_err(into_actor_err)?;
        if has_identical {
            decode_vorbis_to_mono_wav_file(ogg_path, wav_path).map_err(into_actor_err)?;
        } else {
            decode_vorbis_to_wav_file(ogg_path, wav_path).map_err(into_actor_err)?;
        }
        sync_file(wav_path);
        sync_dir(wav_path);
        std::fs::remove_file(ogg_path)?;
        sync_dir(ogg_path);
        return Ok(!has_identical);
    }

    if wav_path.exists() {
        let reader = hound::WavReader::open(wav_path)?;
        return Ok(reader.spec().channels == 2);
    }

    Ok(true)
}

fn is_debug_mode() -> bool {
    cfg!(debug_assertions)
        || std::env::var("LISTENER_DEBUG")
            .map(|value| !value.is_empty() && value != "0" && value != "false")
            .unwrap_or(false)
}

fn flush_if_due(sink: &mut DiskSink) -> Result<(), hound::Error> {
    if sink.last_flush.elapsed() < FLUSH_INTERVAL {
        return Ok(());
    }

    flush_all(sink)
}

fn flush_all(sink: &mut DiskSink) -> Result<(), hound::Error> {
    if let Some(writer) = sink.writer.as_mut() {
        writer.flush()?;
    }
    if let Some(writer_mic) = sink.writer_mic.as_mut() {
        writer_mic.flush()?;
    }
    if let Some(writer_spk) = sink.writer_spk.as_mut() {
        writer_spk.flush()?;
    }
    sink.last_flush = Instant::now();
    Ok(())
}

fn write_mono_samples(
    writer: &mut hound::WavWriter<BufWriter<File>>,
    samples: &[f32],
) -> Result<(), hound::Error> {
    for sample in samples {
        writer.write_sample(*sample)?;
    }
    Ok(())
}

fn write_mono_as_stereo(
    writer: &mut hound::WavWriter<BufWriter<File>>,
    samples: &[f32],
) -> Result<(), hound::Error> {
    for sample in samples {
        writer.write_sample(*sample)?;
        writer.write_sample(*sample)?;
    }
    Ok(())
}

fn write_interleaved_stereo(
    writer: &mut hound::WavWriter<BufWriter<File>>,
    mic: &[f32],
    spk: &[f32],
) -> Result<(), hound::Error> {
    let frames = mic.len().max(spk.len());
    for i in 0..frames {
        writer.write_sample(mic.get(i).copied().unwrap_or(0.0))?;
        writer.write_sample(spk.get(i).copied().unwrap_or(0.0))?;
    }
    Ok(())
}

fn finalize_writer(
    writer: &mut Option<hound::WavWriter<BufWriter<File>>>,
    path: Option<&Path>,
) -> Result<(), hound::Error> {
    if let Some(mut writer) = writer.take() {
        writer.flush()?;
        writer.finalize()?;

        if let Some(path) = path {
            sync_file(path);
        }
    }
    Ok(())
}

fn sync_file(path: &Path) {
    match File::open(path).and_then(|file| file.sync_all()) {
        Ok(()) => {}
        Err(error) => {
            tracing::warn!(
                path = %path.display(),
                error = %error,
                "recording_audio_sync_file_failed"
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
            "recording_audio_sync_dir_failed"
        );
    }
}

fn write_recording_manifest(sink: &DiskSink, status: &str) {
    let payload = serde_json::json!({
        "session_id": &sink.session_id,
        "status": status,
        "updated_at_unix_ms": unix_time_ms(),
        "frames_written": sink.frames_written,
        "wav_path": &sink.wav_path,
        "wav_size": file_size(&sink.wav_path),
        "mp3_path": sink.session_dir.join(FINAL_AUDIO_FILE),
        "mp3_size": file_size(&sink.session_dir.join(FINAL_AUDIO_FILE)),
        "tmp_mp3_path": sink.session_dir.join(MP3_TMP_FILE),
        "tmp_mp3_size": file_size(&sink.session_dir.join(MP3_TMP_FILE)),
    });

    let result = serde_json::to_vec_pretty(&payload)
        .map_err(std::io::Error::other)
        .and_then(|bytes| std::fs::write(&sink.manifest_path, bytes));

    match result {
        Ok(()) => {
            sync_file(&sink.manifest_path);
            sync_dir(&sink.manifest_path);
        }
        Err(error) => {
            tracing::warn!(
                session_id = %sink.session_id,
                manifest_path = %sink.manifest_path.display(),
                error = %error,
                "recording_manifest_write_failed"
            );
        }
    }
}

fn file_size(path: &Path) -> Option<u64> {
    std::fs::metadata(path).ok().map(|metadata| metadata.len())
}

fn unix_time_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::*;

    #[test]
    fn create_disk_sink_decodes_existing_mp3_to_wav() {
        let dir = tempdir().unwrap();
        let session_dir = dir.path().join("session");
        std::fs::create_dir_all(&session_dir).unwrap();
        std::fs::copy(
            hypr_data::english_1::AUDIO_MP3_PATH,
            session_dir.join(FINAL_AUDIO_FILE),
        )
        .unwrap();

        let _sink = create_disk_sink("session", &session_dir).unwrap();

        assert!(session_dir.join(WAV_FILE).exists());
        assert!(!session_dir.join(FINAL_AUDIO_FILE).exists());
    }

    #[test]
    fn create_disk_sink_keeps_legacy_wav_for_append() {
        let dir = tempdir().unwrap();
        let session_dir = dir.path().join("session");
        std::fs::create_dir_all(&session_dir).unwrap();
        std::fs::copy(hypr_data::english_1::AUDIO_PATH, session_dir.join(WAV_FILE)).unwrap();

        let _sink = create_disk_sink("session", &session_dir).unwrap();

        assert!(session_dir.join(WAV_FILE).exists());
        assert!(!session_dir.join(FINAL_AUDIO_FILE).exists());
    }

    #[test]
    fn create_disk_sink_writes_recording_manifest() {
        let dir = tempdir().unwrap();
        let session_dir = dir.path().join("session");
        std::fs::create_dir_all(&session_dir).unwrap();

        let _sink = create_disk_sink("session", &session_dir).unwrap();

        let manifest = std::fs::read_to_string(session_dir.join(RECORDING_MANIFEST_FILE)).unwrap();
        assert!(manifest.contains("\"session_id\": \"session\""));
        assert!(manifest.contains("\"status\": \"recording\""));
    }

    #[test]
    fn channel_stats_warns_when_dual_speaker_channel_is_silent() {
        let mut stats = ChannelStats::default();
        let mic = vec![0.1; SAMPLE_RATE as usize * SILENT_CHANNEL_MIN_SECONDS];
        let spk = vec![0.0; mic.len()];

        stats.observe_dual(&mic, &spk);

        assert!(stats.should_warn_silent_speaker());
    }

    #[test]
    fn channel_stats_does_not_warn_when_speaker_has_signal() {
        let mut stats = ChannelStats::default();
        let mic = vec![0.1; SAMPLE_RATE as usize * SILENT_CHANNEL_MIN_SECONDS];
        let spk = vec![0.01; mic.len()];

        stats.observe_dual(&mic, &spk);

        assert!(!stats.should_warn_silent_speaker());
    }
}
