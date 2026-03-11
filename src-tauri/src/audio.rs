use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Stream, SampleRate};
use std::sync::{Arc, Mutex};

// ─────────────────────────────────────────────────────────────────────────────
// SendStream: wraps cpal::Stream to satisfy Send+Sync for Tauri managed state.
// cpal::Stream contains a PhantomData<*mut ()> on Windows (COM safety).
// We never access the stream from multiple threads simultaneously, so this is safe.
// ─────────────────────────────────────────────────────────────────────────────
struct SendStream(Stream);
unsafe impl Send for SendStream {}
unsafe impl Sync for SendStream {}

pub struct AudioRecorder {
    mic_stream: Option<SendStream>,
    loopback_stream: Option<SendStream>,
    pub recorded_samples: Arc<Mutex<Vec<f32>>>,
}

// ─────────────────────────────────────────────────────────────────────────────
// Linear interpolation resampler: converts from src_rate to 16000 Hz.
// ─────────────────────────────────────────────────────────────────────────────
fn resample_to_16k(input: &[f32], src_rate: u32) -> Vec<f32> {
    if src_rate == 16000 {
        return input.to_vec();
    }
    let ratio = src_rate as f64 / 16000.0;
    let out_len = (input.len() as f64 / ratio).ceil() as usize;
    let mut output = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let src_idx = i as f64 * ratio;
        let lo = src_idx.floor() as usize;
        let hi = (lo + 1).min(input.len() - 1);
        let frac = src_idx - src_idx.floor();
        output.push(input[lo] * (1.0 - frac as f32) + input[hi] * frac as f32);
    }
    output
}

// ─────────────────────────────────────────────────────────────────────────────
// Convert possibly-multichannel interleaved samples to mono.
// ─────────────────────────────────────────────────────────────────────────────
fn to_mono(data: &[f32], channels: u16) -> Vec<f32> {
    if channels == 1 {
        return data.to_vec();
    }
    let ch = channels as usize;
    data.chunks_exact(ch)
        .map(|frame| frame.iter().sum::<f32>() / ch as f32)
        .collect()
}

impl AudioRecorder {
    pub fn new() -> Self {
        Self {
            mic_stream: None,
            loopback_stream: None,
            recorded_samples: Arc::new(Mutex::new(Vec::new())),
        }
    }

    pub fn start_recording(&mut self) -> Result<(), String> {
        let host = cpal::default_host();

        // Shared output buffer
        let recorded_samples = Arc::clone(&self.recorded_samples);
        {
            let mut s = recorded_samples.lock().unwrap();
            s.clear();
        }

        // ── 1. Microphone stream ──────────────────────────────────────────────
        let mic_device = host
            .default_input_device()
            .ok_or("Ingen mikrofonenhet hittades")?;

        let mic_config = mic_device
            .default_input_config()
            .map_err(|e| format!("Mic config: {e}"))?;

        let mic_channels = mic_config.channels();
        let mic_rate = mic_config.sample_rate().0;

        eprintln!("[audio] Mic: {mic_channels}ch @ {mic_rate} Hz");

        let mic_buf = Arc::clone(&recorded_samples);
        let mic_stream = mic_device
            .build_input_stream(
                &mic_config.into(),
                move |data: &[f32], _: &cpal::InputCallbackInfo| {
                    let mono = to_mono(data, mic_channels);
                    let resampled = resample_to_16k(&mono, mic_rate);
                    mic_buf.lock().unwrap().extend_from_slice(&resampled);
                },
                |err| eprintln!("[audio] Mic error: {err}"),
                None,
            )
            .map_err(|e| format!("Mic stream: {e}"))?;

        mic_stream.play().map_err(|e| format!("Mic play: {e}"))?;
        self.mic_stream = Some(SendStream(mic_stream));

        // ── 2. WASAPI Loopback stream (Windows only) ──────────────────────────
        // cpal's WASAPI backend transparently enables AUDCLNT_STREAMFLAGS_LOOPBACK
        // when build_input_stream is called on a rendering (output) device.
        #[cfg(target_os = "windows")]
        {
            if let Some(output_device) = host.default_output_device() {
                // Use supported_input_configs() on the output device to get the
                // loopback format (different from default_output_config).
                let loopback_config = output_device
                    .default_input_config()
                    .map_err(|e| format!("Loopback config: {e}"))?;

                let lb_channels = loopback_config.channels();
                let lb_rate = loopback_config.sample_rate().0;

                eprintln!("[audio] Loopback: {lb_channels}ch @ {lb_rate} Hz");

                let lb_buf = Arc::clone(&recorded_samples);
                let loopback_stream = output_device
                    .build_input_stream(
                        &loopback_config.into(),
                        move |data: &[f32], _: &cpal::InputCallbackInfo| {
                            let mono = to_mono(data, lb_channels);
                            let resampled = resample_to_16k(&mono, lb_rate);
                            // Mix additively, clamped to [-1, 1]
                            let mut buf = lb_buf.lock().unwrap();
                            let existing = buf.len();
                            for (i, &s) in resampled.iter().enumerate() {
                                if i < existing {
                                    buf[i] = (buf[i] + s).clamp(-1.0, 1.0);
                                } else {
                                    buf.push(s);
                                }
                            }
                        },
                        |err| eprintln!("[audio] Loopback error: {err}"),
                        None,
                    )
                    .map_err(|e| format!("Loopback stream: {e}"))?;

                loopback_stream
                    .play()
                    .map_err(|e| format!("Loopback play: {e}"))?;
                self.loopback_stream = Some(SendStream(loopback_stream));
                eprintln!("[audio] WASAPI loopback started");
            } else {
                eprintln!("[audio] No output device — loopback unavailable");
            }
        }

        Ok(())
    }

    pub fn stop_recording(&mut self) -> Vec<u8> {
        // Dropping the streams stops them
        self.mic_stream = None;
        self.loopback_stream = None;

        let samples = self.recorded_samples.lock().unwrap();
        eprintln!("[audio] Stopped. {} samples ({:.1}s)", samples.len(), samples.len() as f32 / 16000.0);

        // Convert f32 PCM to raw bytes for Whisper
        let mut bytes = Vec::with_capacity(samples.len() * 4);
        for &s in samples.iter() {
            bytes.extend_from_slice(&s.to_le_bytes());
        }
        bytes
    }
}
