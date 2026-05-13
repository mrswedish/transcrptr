use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::Stream;
use std::fs::File;
use std::io::BufWriter;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

// SendStream: wraps cpal::Stream to satisfy Send+Sync for Tauri managed state.
struct SendStream(Stream);
unsafe impl Send for SendStream {}
unsafe impl Sync for SendStream {}

// ─────────────────────────────────────────────────────────────────────────────
// Resampler: 2:a-ordningens Butterworth-lowpass + linjär interpolation till 16 kHz.
// ─────────────────────────────────────────────────────────────────────────────
pub fn resample_to_16k(input: &[f32], src_rate: u32) -> Vec<f32> {
    if src_rate == 16000 || input.is_empty() {
        return input.to_vec();
    }
    let filtered: Vec<f32> = if src_rate > 16000 {
        butterworth_lowpass(input, src_rate, 7000.0)
    } else {
        input.to_vec()
    };
    let ratio = src_rate as f64 / 16000.0;
    let out_len = (filtered.len() as f64 / ratio).ceil() as usize;
    let mut output = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let src_idx = i as f64 * ratio;
        let lo = src_idx.floor() as usize;
        let hi = (lo + 1).min(filtered.len().saturating_sub(1));
        let frac = (src_idx - src_idx.floor()) as f32;
        output.push(filtered[lo] * (1.0 - frac) + filtered[hi] * frac);
    }
    output
}

fn butterworth_lowpass(input: &[f32], src_rate: u32, cutoff_hz: f32) -> Vec<f32> {
    let mut filt = BiquadLowpass::new(src_rate, cutoff_hz);
    filt.process(input)
}

/// Stateful 2:a-ordningens biquad-lowpass. Bevarar filter-state mellan anrop.
pub struct BiquadLowpass {
    b0: f32, b1: f32, b2: f32, a1: f32, a2: f32,
    x1: f32, x2: f32, y1: f32, y2: f32,
}

impl BiquadLowpass {
    pub fn new(src_rate: u32, cutoff_hz: f32) -> Self {
        use std::f32::consts::PI;
        let fs = src_rate as f32;
        let fc = cutoff_hz.min(fs * 0.45);
        let w0 = 2.0 * PI * fc / fs;
        let cos_w0 = w0.cos();
        let sin_w0 = w0.sin();
        let alpha  = sin_w0 * std::f32::consts::FRAC_1_SQRT_2;
        let a0     = 1.0 + alpha;
        Self {
            b0: ((1.0 - cos_w0) / 2.0) / a0,
            b1: (1.0 - cos_w0)         / a0,
            b2: ((1.0 - cos_w0) / 2.0) / a0,
            a1: (-2.0 * cos_w0)        / a0,
            a2: (1.0 - alpha)          / a0,
            x1: 0.0, x2: 0.0, y1: 0.0, y2: 0.0,
        }
    }

    pub fn process(&mut self, input: &[f32]) -> Vec<f32> {
        let mut out = Vec::with_capacity(input.len());
        for &x in input {
            let y = self.b0 * x + self.b1 * self.x1 + self.b2 * self.x2
                  - self.a1 * self.y1 - self.a2 * self.y2;
            self.x2 = self.x1; self.x1 = x;
            self.y2 = self.y1; self.y1 = y;
            out.push(y);
        }
        out
    }
}

/// Stateful resampler till 16 kHz. Skapa en instans per kontinuerlig stream.
pub struct StatefulResampler {
    lowpass:  Option<BiquadLowpass>,
    src_rate: u32,
}

impl StatefulResampler {
    pub fn new(src_rate: u32) -> Self {
        let lowpass = if src_rate > 16000 {
            Some(BiquadLowpass::new(src_rate, 7000.0))
        } else {
            None
        };
        Self { lowpass, src_rate }
    }

    pub fn process(&mut self, input: &[f32]) -> Vec<f32> {
        if input.is_empty() || self.src_rate == 16000 {
            return input.to_vec();
        }
        let filtered: Vec<f32> = match self.lowpass.as_mut() {
            Some(lp) => lp.process(input),
            None     => input.to_vec(),
        };
        let ratio = self.src_rate as f64 / 16000.0;
        let out_len = (filtered.len() as f64 / ratio).ceil() as usize;
        let mut output = Vec::with_capacity(out_len);
        for i in 0..out_len {
            let src_idx = i as f64 * ratio;
            let lo = src_idx.floor() as usize;
            let hi = (lo + 1).min(filtered.len().saturating_sub(1));
            let frac = (src_idx - src_idx.floor()) as f32;
            output.push(filtered[lo] * (1.0 - frac) + filtered[hi] * frac);
        }
        output
    }
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
// WAV-spec som används i hela inspelningsledet
// ─────────────────────────────────────────────────────────────────────────────
fn wav_spec_16k_mono_i16() -> hound::WavSpec {
    hound::WavSpec {
        channels: 1,
        sample_rate: 16000,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    }
}

type DiskWriter = hound::WavWriter<BufWriter<File>>;

fn make_writer(path: &Path) -> Result<DiskWriter, String> {
    let file = File::create(path).map_err(|e| format!("Kunde inte skapa fil {}: {e}", path.display()))?;
    hound::WavWriter::new(BufWriter::new(file), wav_spec_16k_mono_i16())
        .map_err(|e| format!("WAV-init: {e}"))
}

#[cfg(target_os = "windows")]
fn write_samples(writer: &mut DiskWriter, samples: &[f32]) {
    for &s in samples {
        let pcm = (s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
        let _ = writer.write_sample(pcm);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// AudioRecorder: streaming-to-disk för loopback (Windows), mic kvar i RAM på Mac.
// Vid stop_recording mixas alla källor till en recording.wav i sessionsmappen.
// ─────────────────────────────────────────────────────────────────────────────
pub struct AudioRecorder {
    mic_stream: Option<SendStream>,
    pub loopback_active: bool,

    /// Filsökväg till slutgiltig recording.wav efter stop_recording
    pub recording_path: Arc<Mutex<Option<PathBuf>>>,
    /// Aktiv session-mapp under pågående inspelning
    session_dir: Arc<Mutex<Option<PathBuf>>>,

    /// Mic kvar i RAM (Mac/cpal-flödet — oförändrat från tidigare)
    mic_samples: Arc<Mutex<Vec<f32>>>,

    /// WAV-writers för loopback streamas direkt till disk under inspelning (Windows)
    #[cfg(target_os = "windows")]
    lb_writer: Arc<Mutex<Option<DiskWriter>>>,
    #[cfg(target_os = "windows")]
    comms_writer: Arc<Mutex<Option<DiskWriter>>>,

    #[cfg(target_os = "windows")]
    loopback_stop: Option<Arc<std::sync::atomic::AtomicBool>>,
    #[cfg(target_os = "windows")]
    loopback_comms_stop: Option<Arc<std::sync::atomic::AtomicBool>>,
}

impl AudioRecorder {
    pub fn new() -> Self {
        Self {
            mic_stream: None,
            loopback_active: false,
            recording_path: Arc::new(Mutex::new(None)),
            session_dir: Arc::new(Mutex::new(None)),
            mic_samples: Arc::new(Mutex::new(Vec::new())),
            #[cfg(target_os = "windows")]
            lb_writer: Arc::new(Mutex::new(None)),
            #[cfg(target_os = "windows")]
            comms_writer: Arc::new(Mutex::new(None)),
            #[cfg(target_os = "windows")]
            loopback_stop: None,
            #[cfg(target_os = "windows")]
            loopback_comms_stop: None,
        }
    }

    /// `loopback_only`: when true, skip the mic stream — the browser handles mic capture.
    /// `base_dir`: rotmapp där en ny `recording-<timestamp>/`-undermapp skapas för sessionen.
    pub fn start_recording(&mut self, loopback_only: bool, base_dir: &Path) -> Result<(), String> {
        // Skapa session-mapp
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| format!("Tid-fel: {e}"))?
            .as_secs();
        let session = base_dir.join(format!("recording-{}", timestamp));
        std::fs::create_dir_all(&session)
            .map_err(|e| format!("Kunde inte skapa inspelningsmapp {}: {e}", session.display()))?;
        eprintln!("[audio] Session-mapp: {}", session.display());
        *self.session_dir.lock().unwrap() = Some(session.clone());
        *self.recording_path.lock().unwrap() = None;

        // Nollställ mic-buffert + loopback-writers
        self.mic_samples.lock().unwrap().clear();
        #[cfg(target_os = "windows")]
        {
            *self.lb_writer.lock().unwrap() = None;
            *self.comms_writer.lock().unwrap() = None;
        }

        let host = cpal::default_host();

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
            let mut mic_resampler = StatefulResampler::new(mic_rate);
            let mic_stream = mic_device
                .build_input_stream(
                    &mic_config.into(),
                    move |data: &[f32], _: &cpal::InputCallbackInfo| {
                        let mono = to_mono(data, mic_channels);
                        let resampled = mic_resampler.process(&mono);
                        mic_buf.lock().unwrap().extend_from_slice(&resampled);
                    },
                    |err| eprintln!("[audio] Mic error: {err}"),
                    None,
                )
                .map_err(|e| format!("Mic stream: {e}"))?;

            mic_stream.play().map_err(|e| format!("Mic play: {e}"))?;
            self.mic_stream = Some(SendStream(mic_stream));
        }

        // ── 2. WASAPI Endpoint Loopback (Windows) — streama till disk ──────────
        #[cfg(target_os = "windows")]
        {
            use std::sync::atomic::{AtomicBool, Ordering};
            use std::sync::mpsc;
            use std::time::Duration;
            use windows::Win32::Media::Audio::{eConsole, eCommunications};

            // Skapa lb_console.wav writer i förväg så tråden bara behöver skriva
            let lb_path = session.join("lb_console.wav");
            let comms_path = session.join("lb_comms.wav");
            *self.lb_writer.lock().unwrap() = Some(make_writer(&lb_path)?);
            *self.comms_writer.lock().unwrap() = Some(make_writer(&comms_path)?);

            let lb_writer_arc    = Arc::clone(&self.lb_writer);
            let comms_writer_arc = Arc::clone(&self.comms_writer);

            let stop_console = Arc::new(AtomicBool::new(false));
            let stop_console_clone = Arc::clone(&stop_console);
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

                        let mut lb_resampler = StatefulResampler::new(lb_rate);
                        while !stop_console_clone.load(Ordering::SeqCst) {
                            if !lb.wait_for_buffer(200) { continue; }
                            let samples = lb.read_samples();
                            if samples.is_empty() { continue; }
                            let mono      = to_mono(&samples, lb_channels);
                            let resampled = lb_resampler.process(&mono);
                            if let Ok(mut writer_opt) = lb_writer_arc.lock() {
                                if let Some(writer) = writer_opt.as_mut() {
                                    write_samples(writer, &resampled);
                                }
                            }
                        }
                        eprintln!("[audio] Loopback eConsole thread exited");
                    }
                }
            });

            match rx.recv_timeout(Duration::from_secs(3)) {
                Ok((true, needs_comms)) => {
                    self.loopback_active = true;
                    self.loopback_stop   = Some(stop_console);

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

                                    let mut lb_resampler = StatefulResampler::new(lb_rate);
                                    while !stop_comms_clone.load(Ordering::SeqCst) {
                                        if !lb.wait_for_buffer(200) { continue; }
                                        let samples = lb.read_samples();
                                        if samples.is_empty() { continue; }
                                        let mono      = to_mono(&samples, lb_channels);
                                        let resampled = lb_resampler.process(&mono);
                                        if let Ok(mut writer_opt) = comms_writer_arc.lock() {
                                            if let Some(writer) = writer_opt.as_mut() {
                                                write_samples(writer, &resampled);
                                            }
                                        }
                                    }
                                    eprintln!("[audio] Loopback eCommunications thread exited");
                                }
                            }
                        });

                        self.loopback_comms_stop = Some(stop_comms);
                        eprintln!("[audio] Capturing from two separate audio endpoints");
                    } else {
                        // Vi behöver inte comms-writer — stäng den så filen är tom
                        if let Some(w) = self.comms_writer.lock().unwrap().take() {
                            let _ = w.finalize();
                        }
                    }
                }
                _ => {
                    eprintln!("[audio] Loopback unavailable");
                    self.loopback_active = false;
                    // Stäng writers vi öppnade i förväg
                    if let Some(w) = self.lb_writer.lock().unwrap().take() {
                        let _ = w.finalize();
                    }
                    if let Some(w) = self.comms_writer.lock().unwrap().take() {
                        let _ = w.finalize();
                    }
                }
            }
        }

        Ok(())
    }

    /// Returnerar slutgiltig recording.wav som bytes (för bakåt-kompabilitet med JS-flödet).
    /// Filen finns också kvar på disk i sessionsmappen — recording_path pekar dit.
    pub fn stop_recording(&mut self) -> Result<Vec<u8>, String> {
        // 1. Stoppa cpal mic-stream
        self.mic_stream = None;

        // 2. Signalera + vänta in loopback-trådar (Windows)
        #[cfg(target_os = "windows")]
        {
            if let Some(stop) = self.loopback_stop.take() {
                stop.store(true, std::sync::atomic::Ordering::SeqCst);
            }
            if let Some(stop) = self.loopback_comms_stop.take() {
                stop.store(true, std::sync::atomic::Ordering::SeqCst);
            }
            std::thread::sleep(std::time::Duration::from_millis(250));

            // 3. Finalize writers så WAV-headerna får korrekt sample count
            if let Some(writer) = self.lb_writer.lock().unwrap().take() {
                writer.finalize().map_err(|e| format!("LB finalize: {e}"))?;
            }
            if let Some(writer) = self.comms_writer.lock().unwrap().take() {
                writer.finalize().map_err(|e| format!("Comms finalize: {e}"))?;
            }
        }

        // 4. Hämta session-mapp
        let session = self.session_dir.lock().unwrap()
            .clone()
            .ok_or_else(|| "Ingen aktiv inspelningssession".to_string())?;
        let recording_path = session.join("recording.wav");

        // 5. Mixa allt till recording.wav
        let mic = self.mic_samples.lock().unwrap().clone();
        #[cfg(target_os = "windows")]
        {
            let lb_path    = session.join("lb_console.wav");
            let comms_path = session.join("lb_comms.wav");
            mix_to_wav_streaming(&mic, Some(&lb_path), Some(&comms_path), &recording_path)?;
        }
        #[cfg(not(target_os = "windows"))]
        {
            mix_to_wav_streaming(&mic, None, None, &recording_path)?;
        }

        eprintln!("[audio] Stopped → {}", recording_path.display());
        *self.recording_path.lock().unwrap() = Some(recording_path.clone());

        // Läs tillbaka recording.wav som bytes för JS-flödet (oförändrat kontrakt).
        // Filen finns kvar på disk — krasch-skydd + recording_path pekar dit.
        std::fs::read(&recording_path)
            .map_err(|e| format!("Kunde inte läsa recording.wav: {e}"))
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Streamad mix av mic + två loopback-filer till en utfil.
// Läser samples från WAV-filer en åt gången via hound::WavReader,
// summerar med mic-buffer (in-memory), skalar och skriver till utfil.
// Peak memory: ~64 KB (BufWriter + några samples). Hanterar timmar utan OOM.
// ─────────────────────────────────────────────────────────────────────────────
fn mix_to_wav_streaming(
    mic: &[f32],
    lb_path: Option<&Path>,
    comms_path: Option<&Path>,
    out_path: &Path,
) -> Result<(), String> {
    let lb_reader = lb_path
        .filter(|p| p.exists())
        .and_then(|p| hound::WavReader::open(p).ok());
    let comms_reader = comms_path
        .filter(|p| p.exists())
        .and_then(|p| hound::WavReader::open(p).ok());

    let lb_len     = lb_reader.as_ref().map(|r| r.duration() as usize).unwrap_or(0);
    let comms_len  = comms_reader.as_ref().map(|r| r.duration() as usize).unwrap_or(0);
    let mic_len    = mic.len();
    let total_len  = mic_len.max(lb_len).max(comms_len);

    let active = (mic_len > 0) as u32 + (lb_len > 0) as u32 + (comms_len > 0) as u32;
    let scale  = if active > 0 { 1.0 / active as f32 } else { 1.0 };

    let mut writer = make_writer(out_path)?;

    let mut lb_iter    = lb_reader.map(|r| r.into_samples::<i16>());
    let mut comms_iter = comms_reader.map(|r| r.into_samples::<i16>());

    let i16_max_f = i16::MAX as f32;
    for i in 0..total_len {
        let lb_sample = lb_iter.as_mut()
            .and_then(|it| it.next().and_then(|s| s.ok()))
            .map(|s| s as f32 / i16_max_f)
            .unwrap_or(0.0);
        let comms_sample = comms_iter.as_mut()
            .and_then(|it| it.next().and_then(|s| s.ok()))
            .map(|s| s as f32 / i16_max_f)
            .unwrap_or(0.0);
        let mic_sample = if i < mic_len { mic[i] } else { 0.0 };

        let mixed = ((mic_sample + lb_sample + comms_sample) * scale).clamp(-1.0, 1.0);
        let pcm = (mixed * i16_max_f) as i16;
        writer.write_sample(pcm).map_err(|e| format!("Skrivfel: {e}"))?;
    }

    writer.finalize().map_err(|e| format!("Mix finalize: {e}"))?;

    eprintln!(
        "[audio] Mix klar — mic={:.1}s lb={:.1}s comms={:.1}s total={:.1}s",
        mic_len as f32 / 16000.0,
        lb_len as f32 / 16000.0,
        comms_len as f32 / 16000.0,
        total_len as f32 / 16000.0,
    );

    Ok(())
}
