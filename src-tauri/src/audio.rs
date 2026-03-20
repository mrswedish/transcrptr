use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::Stream;
use std::sync::{Arc, Mutex};

// SendStream: wraps cpal::Stream to satisfy Send+Sync for Tauri managed state.
struct SendStream(Stream);
unsafe impl Send for SendStream {}
unsafe impl Sync for SendStream {}

// ─────────────────────────────────────────────────────────────────────────────
// Resampler: linear interpolation from any Hz to 16kHz (Whisper input rate).
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
        let hi = (lo + 1).min(input.len().saturating_sub(1));
        let frac = (src_idx - src_idx.floor()) as f32;
        output.push(input[lo] * (1.0 - frac) + input[hi] * frac);
    }
    output
}

// ─────────────────────────────────────────────────────────────────────────────
// Downmix interleaved multi-channel to mono.
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

// ─────────────────────────────────────────────────────────────────────────────
// AudioRecorder: captures mic and loopback into SEPARATE buffers,
// then mixes them at stop_recording() time to avoid runtime race conditions.
// ─────────────────────────────────────────────────────────────────────────────
pub struct AudioRecorder {
    mic_stream: Option<SendStream>,
    /// Whether loopback actually started successfully on last recording
    pub loopback_active: bool,
    /// Final mixed buffer (used after stop)
    pub recorded_samples: Arc<Mutex<Vec<f32>>>,
    /// Separate mic buffer (accumulated during recording)
    mic_samples: Arc<Mutex<Vec<f32>>>,
    /// Separate loopback buffer (accumulated during recording)
    loopback_samples: Arc<Mutex<Vec<f32>>>,
    /// Stop signal for the dedicated loopback thread (Windows only)
    #[cfg(target_os = "windows")]
    loopback_stop: Option<Arc<std::sync::atomic::AtomicBool>>,
}

impl AudioRecorder {
    pub fn new() -> Self {
        Self {
            mic_stream: None,
            loopback_active: false,
            recorded_samples: Arc::new(Mutex::new(Vec::new())),
            mic_samples: Arc::new(Mutex::new(Vec::new())),
            loopback_samples: Arc::new(Mutex::new(Vec::new())),
            #[cfg(target_os = "windows")]
            loopback_stop: None,
        }
    }

    /// `loopback_only`: when true, skip the mic stream — the browser handles mic capture.
    pub fn start_recording(&mut self, loopback_only: bool) -> Result<(), String> {
        let host = cpal::default_host();

        // Clear all buffers
        self.recorded_samples.lock().unwrap().clear();
        self.mic_samples.lock().unwrap().clear();
        self.loopback_samples.lock().unwrap().clear();

        // ── 1. Microphone stream (skipped in loopback_only mode) ──────────────
        if !loopback_only {
            let mic_device = host
                .default_input_device()
                .ok_or("Ingen mikrofonenhet hittades")?;

            let mic_config = mic_device
                .default_input_config()
                .map_err(|e| format!("Mic config: {e}"))?;

            let mic_channels = mic_config.channels();
            let mic_rate = mic_config.sample_rate().0;
            eprintln!("[audio] Mic: {mic_channels}ch @ {mic_rate} Hz");

            let mic_buf = Arc::clone(&self.mic_samples);
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
        }

        // ── 2. Windows Application Loopback (New API) ────────────────────────
        // Runs on a dedicated std::thread with its own MTA COM apartment.
        // ActivateAudioInterfaceAsync requires MTA — Tauri's tokio threads may
        // have STA COM already initialized, which would silently fail loopback.
        #[cfg(target_os = "windows")]
        {
            use std::sync::atomic::{AtomicBool, Ordering};
            use std::sync::mpsc;
            use std::time::Duration;

            let lb_buf = Arc::clone(&self.loopback_samples);
            let stop = Arc::new(AtomicBool::new(false));
            let stop_clone = Arc::clone(&stop);
            let (tx, rx) = mpsc::channel::<bool>();

            std::thread::spawn(move || {
                // Initialize COM as MTA on this dedicated fresh thread.
                unsafe {
                    let _ = windows::Win32::System::Com::CoInitializeEx(
                        None,
                        windows::Win32::System::Com::COINIT_MULTITHREADED,
                    );
                }

                match crate::application_loopback::ApplicationLoopback::new(None) {
                    Err(e) => {
                        eprintln!("[audio] Application Loopback init failed: {e}");
                        let _ = tx.send(false);
                    }
                    Ok(lb) => {
                        if let Err(e) = lb.start() {
                            eprintln!("[audio] Application Loopback start failed: {e}");
                            let _ = tx.send(false);
                            return;
                        }
                        let lb_rate = lb.get_sample_rate();
                        let lb_channels = lb.get_channels();
                        eprintln!("[audio] Application Loopback active: {lb_channels}ch @ {lb_rate} Hz");
                        let _ = tx.send(true);

                        while !stop_clone.load(Ordering::SeqCst) {
                            if !lb.wait_for_buffer(200) { continue; }
                            let samples = lb.read_samples();
                            if samples.is_empty() { continue; }
                            let mono = to_mono(&samples, lb_channels);
                            let resampled = resample_to_16k(&mono, lb_rate);
                            if let Ok(mut buf) = lb_buf.lock() {
                                buf.extend_from_slice(&resampled);
                            } else {
                                break;
                            }
                        }
                        eprintln!("[audio] Application Loopback thread exited");
                    }
                }
            });

            match rx.recv_timeout(Duration::from_secs(3)) {
                Ok(true) => {
                    self.loopback_active = true;
                    self.loopback_stop = Some(stop);
                }
                _ => {
                    eprintln!("[audio] Application Loopback unavailable");
                    self.loopback_active = false;
                }
            }
        }

        Ok(())
    }

    pub fn stop_recording(&mut self) -> Vec<u8> {
        // Stop streams by dropping them
        self.mic_stream = None;
        #[cfg(target_os = "windows")]
        {
            if let Some(stop) = self.loopback_stop.take() {
                stop.store(true, std::sync::atomic::Ordering::SeqCst);
            }
            // Give the loopback thread ~250 ms to flush its last buffer
            std::thread::sleep(std::time::Duration::from_millis(250));
        }

        let mic = self.mic_samples.lock().unwrap();
        let lb = self.loopback_samples.lock().unwrap();

        // Mix mic + loopback sample-by-sample, padded to the longer of the two.
        // This avoids race conditions since both buffers were written independently.
        let len = mic.len().max(lb.len());
        let mut mixed: Vec<f32> = Vec::with_capacity(len);
        for i in 0..len {
            let m = if i < mic.len() { mic[i] } else { 0.0 };
            let l = if i < lb.len() { lb[i] } else { 0.0 };
            mixed.push((m + l).clamp(-1.0, 1.0));
        }

        eprintln!(
            "[audio] Stopped. mic={}s loopback={}s mixed={}s",
            mic.len() as f32 / 16000.0,
            lb.len() as f32 / 16000.0,
            mixed.len() as f32 / 16000.0
        );

        // Store in recorded_samples so save_audio_file can access it
        *self.recorded_samples.lock().unwrap() = mixed.clone();

        // Convert to WAV bytes for the frontend
        let mut cursor = std::io::Cursor::new(Vec::new());
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: 16000,
            bits_per_sample: 32,
            sample_format: hound::SampleFormat::Float,
        };

        if let Ok(mut writer) = hound::WavWriter::new(&mut cursor, spec) {
            for &s in &mixed {
                let _ = writer.write_sample(s);
            }
            let _ = writer.finalize();
        }

        cursor.into_inner()
    }
}
