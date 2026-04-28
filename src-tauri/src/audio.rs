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
pub fn resample_to_16k(input: &[f32], src_rate: u32) -> Vec<f32> {
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
pub fn to_mono(data: &[f32], channels: u16) -> Vec<f32> {
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
    /// Loopback buffer for eConsole (default render device)
    loopback_samples: Arc<Mutex<Vec<f32>>>,
    /// Loopback buffer for eCommunications (if different device)
    #[cfg(target_os = "windows")]
    loopback_comms_samples: Arc<Mutex<Vec<f32>>>,
    /// Stop signal for the eConsole loopback thread (Windows only)
    #[cfg(target_os = "windows")]
    loopback_stop: Option<Arc<std::sync::atomic::AtomicBool>>,
    /// Stop signal for the eCommunications loopback thread (Windows only)
    #[cfg(target_os = "windows")]
    loopback_comms_stop: Option<Arc<std::sync::atomic::AtomicBool>>,
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
            loopback_comms_samples: Arc::new(Mutex::new(Vec::new())),
            #[cfg(target_os = "windows")]
            loopback_stop: None,
            #[cfg(target_os = "windows")]
            loopback_comms_stop: None,
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

        // ── 2. WASAPI Endpoint Loopback (eConsole + optional eCommunications) ──
        // Each device runs on its own dedicated std::thread with MTA COM.
        #[cfg(target_os = "windows")]
        {
            use std::sync::atomic::{AtomicBool, Ordering};
            use std::sync::mpsc;
            use std::time::Duration;
            use windows::Win32::Media::Audio::{eConsole, eCommunications};

            self.loopback_comms_samples.lock().unwrap().clear();

            let lb_console_buf = Arc::clone(&self.loopback_samples);
            let lb_comms_buf   = Arc::clone(&self.loopback_comms_samples);

            let stop_console = Arc::new(AtomicBool::new(false));
            let stop_console_clone = Arc::clone(&stop_console);
            // (loopback_ok, needs_separate_comms_device)
            let (tx, rx) = mpsc::channel::<(bool, bool)>();

            // ── Thread 1: eConsole ───────────────────────────────────────────
            std::thread::spawn(move || {
                unsafe {
                    let _ = windows::Win32::System::Com::CoInitializeEx(
                        None,
                        windows::Win32::System::Com::COINIT_MULTITHREADED,
                    );
                }
                let needs_comms =
                    !crate::application_loopback::ApplicationLoopback::is_same_device();

                match crate::application_loopback::ApplicationLoopback::new(eConsole) {
                    Err(e) => {
                        eprintln!("[audio] Loopback eConsole init failed: {e}");
                        let _ = tx.send((false, false));
                    }
                    Ok(lb) => {
                        if let Err(e) = lb.start() {
                            eprintln!("[audio] Loopback eConsole start failed: {e}");
                            let _ = tx.send((false, false));
                            return;
                        }
                        let lb_rate     = lb.get_sample_rate();
                        let lb_channels = lb.get_channels();
                        eprintln!("[audio] Loopback eConsole: {lb_channels}ch @ {lb_rate} Hz");
                        let _ = tx.send((true, needs_comms));

                        while !stop_console_clone.load(Ordering::SeqCst) {
                            if !lb.wait_for_buffer(200) { continue; }
                            let samples = lb.read_samples();
                            if samples.is_empty() { continue; }
                            let mono      = to_mono(&samples, lb_channels);
                            let resampled = resample_to_16k(&mono, lb_rate);
                            if let Ok(mut buf) = lb_console_buf.lock() {
                                buf.extend_from_slice(&resampled);
                            } else { break; }
                        }
                        eprintln!("[audio] Loopback eConsole thread exited");
                    }
                }
            });

            match rx.recv_timeout(Duration::from_secs(3)) {
                Ok((true, needs_comms)) => {
                    self.loopback_active = true;
                    self.loopback_stop   = Some(stop_console);

                    // ── Thread 2: eCommunications (only if different device) ──
                    if needs_comms {
                        let stop_comms       = Arc::new(AtomicBool::new(false));
                        let stop_comms_clone = Arc::clone(&stop_comms);

                        std::thread::spawn(move || {
                            unsafe {
                                let _ = windows::Win32::System::Com::CoInitializeEx(
                                    None,
                                    windows::Win32::System::Com::COINIT_MULTITHREADED,
                                );
                            }
                            match crate::application_loopback::ApplicationLoopback::new(
                                eCommunications,
                            ) {
                                Err(e) => eprintln!(
                                    "[audio] Loopback eCommunications init failed: {e}"
                                ),
                                Ok(lb) => {
                                    if let Err(e) = lb.start() {
                                        eprintln!("[audio] Loopback eCommunications start failed: {e}");
                                        return;
                                    }
                                    let lb_rate     = lb.get_sample_rate();
                                    let lb_channels = lb.get_channels();
                                    eprintln!("[audio] Loopback eCommunications: {lb_channels}ch @ {lb_rate} Hz");

                                    while !stop_comms_clone.load(Ordering::SeqCst) {
                                        if !lb.wait_for_buffer(200) { continue; }
                                        let samples = lb.read_samples();
                                        if samples.is_empty() { continue; }
                                        let mono      = to_mono(&samples, lb_channels);
                                        let resampled = resample_to_16k(&mono, lb_rate);
                                        if let Ok(mut buf) = lb_comms_buf.lock() {
                                            buf.extend_from_slice(&resampled);
                                        } else { break; }
                                    }
                                    eprintln!("[audio] Loopback eCommunications thread exited");
                                }
                            }
                        });

                        self.loopback_comms_stop = Some(stop_comms);
                        eprintln!("[audio] Capturing from two separate audio endpoints");
                    }
                }
                _ => {
                    eprintln!("[audio] Loopback unavailable");
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
            if let Some(stop) = self.loopback_comms_stop.take() {
                stop.store(true, std::sync::atomic::Ordering::SeqCst);
            }
            // Give loopback threads ~250 ms to flush their last buffers
            std::thread::sleep(std::time::Duration::from_millis(250));
        }

        let mic = self.mic_samples.lock().unwrap();
        let lb  = self.loopback_samples.lock().unwrap();
        #[cfg(target_os = "windows")]
        let comms = self.loopback_comms_samples.lock().unwrap();
        #[cfg(not(target_os = "windows"))]
        let comms: Vec<f32> = Vec::new();

        // 3-way mix: mic + eConsole + eCommunications, padded to the longest.
        let len = mic.len().max(lb.len()).max(comms.len());
        let mut mixed: Vec<f32> = Vec::with_capacity(len);
        for i in 0..len {
            let m = if i < mic.len()   { mic[i]   } else { 0.0 };
            let l = if i < lb.len()    { lb[i]    } else { 0.0 };
            let c = if i < comms.len() { comms[i] } else { 0.0 };
            mixed.push((m + l + c).clamp(-1.0, 1.0));
        }

        eprintln!(
            "[audio] Stopped. mic={}s console={}s comms={}s mixed={}s",
            mic.len() as f32 / 16000.0,
            lb.len() as f32 / 16000.0,
            comms.len() as f32 / 16000.0,
            mixed.len() as f32 / 16000.0
        );

        // Store in recorded_samples so save_audio_file can access it
        *self.recorded_samples.lock().unwrap() = mixed.clone();

        // Convert to 16-bit PCM WAV for the frontend.
        // 16-bit is half the size of 32-bit float with no transcription quality loss
        // (Whisper uses 16-bit internally). Smaller payload = less IPC pressure on Windows.
        let mut cursor = std::io::Cursor::new(Vec::new());
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: 16000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };

        if let Ok(mut writer) = hound::WavWriter::new(&mut cursor, spec) {
            for &s in &mixed {
                let pcm = (s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
                let _ = writer.write_sample(pcm);
            }
            let _ = writer.finalize();
        }

        cursor.into_inner()
    }
}
