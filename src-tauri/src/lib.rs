// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use std::path::PathBuf;
use std::fs;
use futures_util::StreamExt;
use std::io::Write;
use tauri::{AppHandle, Manager, Emitter};
use serde::Serialize;
use whisper_rs::{WhisperContext, WhisperContextParameters, FullParams, SamplingStrategy};
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri_plugin_dialog::DialogExt;
use sysinfo::Disks;

mod audio;
mod pianissimo;
#[cfg(target_os = "windows")]
mod application_loopback;
use audio::AudioRecorder;

// Dekoda en ljudfil som en stream — ett chunk i taget — för att minimera minnespeak.
// Hela filen läses aldrig in i minnet; bara ett ~19 MB chunk åt gången hålls levande.
struct StreamingDecoder {
    format:   Box<dyn symphonia::core::formats::FormatReader>,
    decoder:  Box<dyn symphonia::core::codecs::Decoder>,
    track_id: u32,
    n_frames: Option<u64>,
    src_rate: u32,
    leftover: Vec<f32>,
}

impl StreamingDecoder {
    fn open(path: &str) -> Result<Self, String> {
        use symphonia::core::{
            codecs::{DecoderOptions, CODEC_TYPE_NULL},
            formats::FormatOptions,
            io::MediaSourceStream,
            meta::MetadataOptions,
            probe::Hint,
        };
        let file = std::fs::File::open(path)
            .map_err(|e| format!("Kunde inte öppna filen: {e}"))?;
        let mss = MediaSourceStream::new(Box::new(file), Default::default());
        let probed = symphonia::default::get_probe()
            .format(&Hint::new(), mss, &FormatOptions::default(), &MetadataOptions::default())
            .map_err(|e| format!("Okänt filformat: {e}"))?;
        let format = probed.format;
        let track = format.tracks().iter()
            .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
            .ok_or_else(|| "Ingen ljudspår hittades i filen".to_string())?;
        let track_id = track.id;
        let n_frames = track.codec_params.n_frames;
        let src_rate = track.codec_params.sample_rate.unwrap_or(44100);
        let decoder  = symphonia::default::get_codecs()
            .make(&track.codec_params, &DecoderOptions::default())
            .map_err(|e| format!("Kunde inte skapa avkodare: {e}"))?;
        Ok(StreamingDecoder { format, decoder, track_id, n_frames, src_rate, leftover: Vec::new() })
    }

    // Returnerar nästa chunk med exakt `chunk_samples` samples (eller resten av filen).
    // None = EOF.
    fn next_chunk(&mut self, chunk_samples: usize) -> Result<Option<Vec<f32>>, String> {
        use symphonia::core::{audio::SampleBuffer, errors::Error as SymphoniaError};
        loop {
            if self.leftover.len() >= chunk_samples {
                return Ok(Some(self.leftover.drain(..chunk_samples).collect()));
            }
            let packet = match self.format.next_packet() {
                Ok(p)                              => p,
                Err(SymphoniaError::IoError(_))    => break,
                Err(SymphoniaError::ResetRequired) => { self.decoder.reset(); continue; }
                Err(_)                             => break,
            };
            if packet.track_id() != self.track_id { continue; }
            let decoded = match self.decoder.decode(&packet) {
                Ok(d)  => d,
                Err(_) => continue,
            };
            let spec = *decoded.spec();
            let mut buf = SampleBuffer::<f32>::new(decoded.capacity() as u64, spec);
            buf.copy_interleaved_ref(decoded);
            let mono      = audio::to_mono(buf.samples(), spec.channels.count() as u16);
            let resampled = audio::resample_to_16k(&mono, spec.rate);
            self.leftover.extend_from_slice(&resampled);
        }
        if self.leftover.is_empty() { Ok(None) }
        else { Ok(Some(std::mem::take(&mut self.leftover))) }
    }

    // Uppskattar antal chunks via metadata — används för progress-visning.
    fn estimate_total_chunks(&self, chunk_samples: usize) -> usize {
        if let Some(n) = self.n_frames {
            if n > 0 && self.src_rate > 0 {
                let total_16k = (n as f64 * 16000.0 / self.src_rate as f64) as usize;
                return (total_16k + chunk_samples - 1) / chunk_samples;
            }
        }
        1
    }
}

pub struct AppState {
    pub cancel_flag: Arc<AtomicBool>,
    pub audio_recorder: Mutex<AudioRecorder>,
}

#[tauri::command]
fn cancel_transcription(state: tauri::State<AppState>) {
    state.inner().cancel_flag.store(true, Ordering::Relaxed);
}

#[tauri::command]
fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[derive(Serialize, Clone)]
struct ProgressPayload {
    progress: f32,
    downloaded: u64,
    total: u64,
}


#[derive(Serialize, Clone)]
struct TranscriptionProgressPayload {
    progress: i32,
}

#[derive(Serialize)]
struct TokenInfo {
    text: String,
    prob: f32,
}

#[derive(Serialize)]
struct TranscriptSegment {
    start_ms: i64,
    end_ms: i64,
    text: String,
    tokens: Vec<TokenInfo>,
}

#[derive(Serialize)]
struct ModelInfo {
    name: String,
    size: String,
    revision: String,
    quantized: bool,
    size_bytes: u64,
    downloaded: bool,
}

#[derive(Serialize)]
struct DiskInfo {
    total_space: u64,
    available_space: u64,
    models_dir_size: u64,
}

/// Strip whisper special tokens like <|nospeech|>, <|en|> etc. and replacement chars from text.
fn clean_whisper_text(s: &str) -> String {
    let mut result = s.to_string();
    while let Some(start) = result.find("<|") {
        if let Some(rel_end) = result[start..].find("|>") {
            result.replace_range(start..start + rel_end + 2, "");
        } else {
            break;
        }
    }
    result.retain(|c| c != '\u{FFFD}');
    result.trim().to_string()
}

fn get_model_info(size: &str, quantized: bool, revision: &str) -> (String, String) {
    // Turbo: ggerganov/whisper.cpp large-v3-turbo — always q8_0, no revision
    if size == "turbo" {
        return (
            "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q8_0.bin".to_string(),
            "ggml-large-v3-turbo-q8_0.bin".to_string(),
        );
    }
    let repo = format!("kb-whisper-{}", size);
    let hf_file = if quantized { "ggml-model-q5_0.bin" } else { "ggml-model.bin" };
    // "standard" maps to the "main" branch on HuggingFace; other revisions use their own branch name
    let hf_branch = if revision == "standard" { "main" } else { revision };
    let url = format!("https://huggingface.co/KBLab/{}/resolve/{}/{}", repo, hf_branch, hf_file);
    // "standard" keeps the original filename for backward compatibility
    let local_filename = if revision == "standard" {
        format!("ggml-model-{}-kb{}.bin", size, if quantized { "-q5_0" } else { "" })
    } else {
        format!("ggml-model-{}-kb-{}{}.bin", size, revision, if quantized { "-q5_0" } else { "" })
    };
    (url, local_filename)
}

fn get_model_path(app_handle: &AppHandle, size: &str, quantized: bool, revision: &str) -> Result<PathBuf, String> {
    let app_data_dir = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    let models_dir = app_data_dir.join("models");
    if !models_dir.exists() {
        fs::create_dir_all(&models_dir).map_err(|e| e.to_string())?;
    }
    // Pianissimo består av flera filer och lever i en egen katalog.
    if size == pianissimo::ENGINE_ID {
        return Ok(pianissimo::model_dir(&models_dir));
    }
    let (_, filename) = get_model_info(size, quantized, revision);
    Ok(models_dir.join(filename))
}

/// Ladda ned alla Pianissimo-filer (fast revision, SHA-256-kontroll) med samlad progress.
async fn download_pianissimo(app_handle: &AppHandle, dir: PathBuf) -> Result<String, String> {
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let total_expected: u64 = pianissimo::FILES.iter().map(|f| f.2).sum();
    let mut done_before: u64 = 0;
    let mut last_emit_mb = 0u64;

    for (name, sha, approx) in pianissimo::FILES {
        let target = dir.join(name);
        if target.exists() && pianissimo::file_hash(&target).map(|h| h == *sha).unwrap_or(false) {
            done_before += approx;
            continue;
        }
        let tmp = dir.join(format!("{name}.tmp"));
        let res = reqwest::get(pianissimo::download_url(name)).await.map_err(|e| format!(
            "Ingen kontakt med servern där modellen finns (huggingface.co).\n\n\
             Kontrollera nätverket. På en arbetsdator kan brandvägg eller proxy blockera \
             nedladdningen — kontakta i så fall IT-support.\n\nTeknisk information: {e}"
        ))?;
        if !res.status().is_success() {
            return Err(format!(
                "Servern nekade nedladdningen (HTTP {}).\n\n\
                 Försök igen om en stund. Kvarstår problemet kan brandvägg eller proxy \
                 blockera åtkomsten till huggingface.co.",
                res.status()
            ));
        }
        let mut file = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
        let mut stream = res.bytes_stream();
        let mut got: u64 = 0;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| e.to_string())?;
            file.write_all(&chunk).map_err(|e| e.to_string())?;
            got += chunk.len() as u64;
            let total_done = done_before + got;
            let mb = total_done / 1_048_576;
            if mb > last_emit_mb {
                last_emit_mb = mb;
                let progress = (total_done as f32 / total_expected as f32 * 99.0).min(99.0);
                let _ = app_handle.emit("download_progress", ProgressPayload { progress, downloaded: total_done, total: total_expected });
            }
        }
        drop(file);
        let hash = pianissimo::file_hash(&tmp).map_err(|e| e.to_string())?;
        if hash != *sha {
            let _ = fs::remove_file(&tmp);
            return Err(format!(
                "Den nedladdade filen {name} är skadad (kontrollsumman stämmer inte). Försök ladda ned igen."
            ));
        }
        fs::rename(&tmp, &target).map_err(|e| e.to_string())?;
        done_before += approx;
    }
    let _ = app_handle.emit("download_progress", ProgressPayload { progress: 100.0, downloaded: total_expected, total: total_expected });
    Ok(dir.to_string_lossy().to_string())
}

// ── Fil-loggning ─────────────────────────────────────────────────────────────
// Diagnostisk logg till app_local_data_dir/transcrptr.log. Behövs eftersom
// Windows-bundlat .exe inte har synlig stderr — vi kan inte felsöka utan en fil.
static LOG_PATH: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

fn init_logging(app_handle: &AppHandle) {
    if let Ok(dir) = app_handle.path().app_local_data_dir() {
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("transcrptr.log");
        let _ = LOG_PATH.set(path);
    }
}

// Global lås så parallella trådar (transcribe-poller + main-loop) inte interfererar
// med varandras writeln!-anrop. Append+writeln är inte atomärt på alla plattformar.
static LOG_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub(crate) fn log_line(msg: &str) {
    eprintln!("[transcrptr] {msg}");
    if let Some(path) = LOG_PATH.get() {
        let _guard = LOG_LOCK.lock();
        let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
            let _ = writeln!(f, "[{now}] {msg}");
        }
    }
}

// Cap n_threads till ett säkert värde. Default = 4 (whisper.cpp:s original-default).
// På Intel-laptops med 20+ logiska kärnor kan whisper.cpp kraschra; vi cap:ar vid 16.
fn whisper_thread_count(user_pref: Option<u32>) -> i32 {
    let detected = num_cpus::get() as u32;
    let chosen = user_pref
        .unwrap_or(4)
        .clamp(1, detected.min(16));
    log_line(&format!(
        "thread_count: requested={user_pref:?}, detected_cpus={detected}, chosen={chosen}"
    ));
    chosen as i32
}

#[tauri::command]
fn get_log_path(app_handle: AppHandle) -> Result<String, String> {
    let dir = app_handle.path().app_local_data_dir()
        .map_err(|e| format!("Kunde inte hämta app_local_data_dir: {e}"))?;
    Ok(dir.join("transcrptr.log").to_string_lossy().into_owned())
}

/// JS skickar ett meddelande som skrivs till transcrptr.log. Används av JS för att
/// rapportera framgång/fel i UI-flödet (renderSegmentEditor osv.) så vi kan diagnostisera
/// krasch som händer EFTER att Rust-transkriberingen returnerat.
#[tauri::command]
fn log_message(msg: String) {
    log_line(&msg);
}

/// Returnerar sökvägen till senaste recording.wav (om någon). Används av JS i WASAPI-flödet
/// där pendingRecording.filePath är null — då frågar JS Rust om sökvägen efter stop.
#[tauri::command]
fn get_recording_path(state: tauri::State<'_, AppState>) -> Result<String, String> {
    state.inner().audio_recorder.lock()
        .map_err(|e| format!("Recorder-lås: {e}"))?
        .recording_path.lock()
        .map_err(|e| format!("Path-lås: {e}"))?
        .clone()
        .map(|p| p.to_string_lossy().into_owned())
        .ok_or_else(|| "Ingen aktiv inspelning".to_string())
}

/// Rensar ett användarangivet sessionsnamn så det duger som mappnamn på Windows.
/// Otillåtna tecken blir bindestreck; längden kapas. Tom sträng → None.
fn sanitize_session_name(raw: &str) -> Option<String> {
    let cleaned: String = raw
        .trim()
        .chars()
        .map(|c| match c {
            // Reserverade i Windows-filnamn, plus path-separatorer
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '-',
            c if c.is_control() => '-',
            c => c,
        })
        .collect();
    // Kollapsa upprepade bindestreck/mellanslag och trimma kanterna
    let mut out = String::with_capacity(cleaned.len());
    let mut prev_sep = false;
    for c in cleaned.chars() {
        let is_sep = c == '-' || c == ' ';
        if is_sep {
            if !prev_sep && !out.is_empty() { out.push('-'); }
            prev_sep = true;
        } else {
            out.push(c);
            prev_sep = false;
        }
    }
    let out = out.trim_matches('-').chars().take(40).collect::<String>();
    let out = out.trim_matches('-').to_string();
    // Windows tillåter inte mappnamn som slutar på punkt
    let out = out.trim_end_matches('.').to_string();
    if out.is_empty() { None } else { Some(out) }
}

/// Döper om den senaste sessionsmappen genom att lägga till ett namn efter
/// tidsstämpeln: `inspelning-20260903-142233-ledningsgrupp`.
/// Tidsstämpeln behålls som prefix så sortering och datumparsning fortsätter fungera.
/// Uppdaterar recording_path så efterföljande uppspelning/transkribering hittar filen.
#[tauri::command]
fn rename_session(state: tauri::State<'_, AppState>, name: String) -> Result<String, String> {
    let recorder = state.inner().audio_recorder.lock()
        .map_err(|e| format!("Recorder-lås: {e}"))?;
    let mut path_guard = recorder.recording_path.lock()
        .map_err(|e| format!("Path-lås: {e}"))?;
    let current = path_guard.clone()
        .ok_or_else(|| "Ingen inspelning att döpa om".to_string())?;

    let Some(clean) = sanitize_session_name(&name) else {
        // Inget namn angivet — behåll mappen som den är.
        return Ok(current.to_string_lossy().into_owned());
    };

    let session_dir = current.parent()
        .ok_or_else(|| "Kunde inte hitta sessionsmappen".to_string())?;
    let old_name = session_dir.file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "Ogiltigt mappnamn".to_string())?;
    let parent = session_dir.parent()
        .ok_or_else(|| "Kunde inte hitta överordnad mapp".to_string())?;

    // Bygg nytt namn: behåll allt fram till ev. tidigare suffix.
    let new_name = format!("{old_name}-{clean}");
    let new_dir = parent.join(&new_name);
    if new_dir.exists() {
        return Err(format!("Det finns redan en mapp som heter {new_name}"));
    }

    std::fs::rename(session_dir, &new_dir)
        .map_err(|e| format!("Kunde inte döpa om mappen: {e}"))?;

    let file_name = current.file_name()
        .ok_or_else(|| "Ogiltigt filnamn".to_string())?;
    let new_path = new_dir.join(file_name);
    *path_guard = Some(new_path.clone());
    log_line(&format!("rename_session: {} → {}", old_name, new_name));
    Ok(new_path.to_string_lossy().into_owned())
}

/// Utökar asset-protokollets scope vid runtime till EXAKT en fil, så att <audio>
/// kan streama just den filen via convertFileSrc. Asset-scopen i tauri.conf.json är tom
/// (`[]`) — vi tillåter aldrig hela filsystemet. JS anropar detta precis innan spelaren
/// sätts upp, med den faktiska recording.wav/importfilens path. Bara läsåtkomst, bara
/// den fil användaren redan valt; ingen annan path blir åtkomlig.
#[tauri::command]
fn allow_asset_path(app_handle: AppHandle, path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.is_file() {
        return Err(format!("Filen finns inte: {path}"));
    }
    app_handle.asset_protocol_scope()
        .allow_file(&p)
        .map_err(|e| format!("Kunde inte tillåta fil för uppspelning: {e}"))?;
    Ok(())
}

/// JS streamar mic-PCM hit under inspelning (Windows-WASAPI). Eliminerar
/// JS-side mic-blob-allokation som tidigare gjorde 1 GB Float32-arrays vid stop
/// av lång inspelning → OOM-krasch på WebView2.
#[cfg(target_os = "windows")]
#[tauri::command]
async fn append_mic_chunk(
    state: tauri::State<'_, AppState>,
    samples: Vec<f32>,
    sample_rate: u32,
) -> Result<(), String> {
    let recorder = state.inner().audio_recorder.lock()
        .map_err(|e| format!("Recorder-lås: {e}"))?;
    recorder.append_mic_pcm(&samples, sample_rate)
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
async fn append_mic_chunk(
    _state: tauri::State<'_, AppState>,
    _samples: Vec<f32>,
    _sample_rate: u32,
) -> Result<(), String> {
    // No-op på Mac — mic går via cpal direkt i Rust
    Ok(())
}

// Försök ladda WhisperContext med begärt GPU-läge. Om GPU-init misslyckas
// (vanligt på multi-GPU/NPU-Windows pga Vulkan-konflikt), faller vi tillbaka
// till CPU automatiskt så användaren slipper krasch.
fn load_whisper_with_fallback(
    model_path: &PathBuf,
    use_gpu_requested: bool,
    gpu_device: Option<i32>,
) -> Result<WhisperContext, String> {
    let chosen_device = gpu_device.unwrap_or(0);
    log_line(&format!(
        "WhisperContext init: use_gpu={use_gpu_requested}, gpu_device={chosen_device}, model={}",
        model_path.display()
    ));
    let mut params = WhisperContextParameters::default();
    params.use_gpu = use_gpu_requested;
    params.gpu_device = chosen_device;
    match WhisperContext::new_with_params(model_path.as_path(), params) {
        Ok(ctx) => {
            log_line(&format!("WhisperContext OK (gpu={use_gpu_requested}, device={chosen_device})"));
            Ok(ctx)
        }
        Err(e) if use_gpu_requested => {
            log_line(&format!("GPU-init misslyckades ({e}) — faller tillbaka till CPU"));
            let mut cpu = WhisperContextParameters::default();
            cpu.use_gpu = false;
            WhisperContext::new_with_params(model_path.as_path(), cpu)
                .map_err(|e| format!("Kunde inte ladda modell (CPU-fallback): {e}"))
        }
        Err(e) => Err(format!("Kunde inte ladda modell: {e}")),
    }
}

#[tauri::command]
fn check_model_exists(app_handle: AppHandle, size: String, quantized: bool, revision: String) -> Result<bool, String> {
    let model_path = get_model_path(&app_handle, &size, quantized, &revision)?;
    if size == pianissimo::ENGINE_ID {
        return Ok(pianissimo::is_ready(&model_path));
    }
    Ok(model_path.exists())
}

#[tauri::command]
async fn download_model(app_handle: AppHandle, size: String, quantized: bool, revision: String) -> Result<String, String> {
    let model_path = get_model_path(&app_handle, &size, quantized, &revision)?;
    if size == pianissimo::ENGINE_ID {
        return download_pianissimo(&app_handle, model_path).await;
    }
    let (url, _) = get_model_info(&size, quantized, &revision);

    // If it already exists, just return path
    if model_path.exists() {
        // Emit 100% just in case
        let _ = app_handle.emit("download_progress", ProgressPayload { progress: 100.0, downloaded: 1, total: 1 });
        return Ok(model_path.to_string_lossy().to_string());
    }

    let tmp_path = model_path.with_extension("tmp");
    // Nätverksfel: i regionmiljö är brandvägg/proxy den vanligaste orsaken — säg det.
    let res = reqwest::get(&url).await.map_err(|e| format!(
        "Ingen kontakt med servern där modellen finns (huggingface.co).\n\n\
         Kontrollera nätverket. På en arbetsdator kan brandvägg eller proxy blockera \
         nedladdningen — kontakta i så fall IT-support.\n\nTeknisk information: {e}"
    ))?;

    if !res.status().is_success() {
        return Err(format!(
            "Servern nekade nedladdningen (HTTP {}).\n\n\
             Försök igen om en stund. Kvarstår problemet kan brandvägg eller proxy \
             blockera åtkomsten till huggingface.co.",
            res.status()
        ));
    }

    let total_size = res.content_length().unwrap_or(0);
    let mut file = std::fs::File::create(&tmp_path).map_err(|e| e.to_string())?;
    let mut stream = res.bytes_stream();
    let mut downloaded: u64 = 0;
    
    // Only emit every megabyte to prevent lagging the frontend
    let mut last_emit_mb = 0;

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        downloaded += chunk.len() as u64;
        
        let current_mb = downloaded / 1_048_576;
        if total_size > 0 && current_mb > last_emit_mb {
            last_emit_mb = current_mb;
            let progress = (downloaded as f32 / total_size as f32) * 100.0;
            let _ = app_handle.emit("download_progress", ProgressPayload { progress, downloaded, total: total_size });
        }
    }
    
    // Emit 100% when finished
    let _ = app_handle.emit("download_progress", ProgressPayload { progress: 100.0, downloaded, total: total_size });

    // Rename from tmp to final name
    std::fs::rename(tmp_path, &model_path).map_err(|e| e.to_string())?;

    Ok(model_path.to_string_lossy().to_string())
}

#[tauri::command]
async fn get_available_models(app_handle: AppHandle) -> Result<Vec<ModelInfo>, String> {
    let mut models = Vec::new();

    // KB-whisper models (medium + large, standard + strict)
    let kb_sizes = ["medium", "large"];
    let kb_revisions = ["standard", "strict"];
    for size in kb_sizes {
        for revision in kb_revisions {
            for quantized in [true, false] {
                let model_path = get_model_path(&app_handle, size, quantized, revision)?;
                let size_label = if size == "medium" { "Medium" } else { "Large" };
                let rev_label = if revision == "strict" { "Ordagrann" } else { "Standard" };
                let fmt_label = if quantized { "q5_0" } else { "Standard" };
                let name = format!("{} · {} · {}", size_label, rev_label, fmt_label);

                if model_path.exists() {
                    let meta = fs::metadata(&model_path).map_err(|e| e.to_string())?;
                    models.push(ModelInfo {
                        name,
                        size: size.to_string(),
                        revision: revision.to_string(),
                        quantized,
                        size_bytes: meta.len(),
                        downloaded: true,
                    });
                }
            }
        }
    }

    // Turbo model (ggerganov/whisper.cpp large-v3-turbo-q8_0)
    let turbo_path = get_model_path(&app_handle, "turbo", true, "standard")?;
    if turbo_path.exists() {
        let meta = fs::metadata(&turbo_path).map_err(|e| e.to_string())?;
        models.push(ModelInfo {
            name: "Turbo · q8_0".to_string(),
            size: "turbo".to_string(),
            revision: "standard".to_string(),
            quantized: true,
            size_bytes: meta.len(),
            downloaded: true,
        });
    }

    // Pianissimo (svenska, snabb)
    let pian_dir = get_model_path(&app_handle, pianissimo::ENGINE_ID, true, "standard")?;
    if pianissimo::is_ready(&pian_dir) {
        let size_bytes: u64 = pianissimo::FILES
            .iter()
            .filter_map(|(n, _, _)| fs::metadata(pian_dir.join(n)).ok())
            .map(|m| m.len())
            .sum();
        models.push(ModelInfo {
            name: "Pianissimo · Snabb (svenska)".to_string(),
            size: pianissimo::ENGINE_ID.to_string(),
            revision: "standard".to_string(),
            quantized: true,
            size_bytes,
            downloaded: true,
        });
    }

    Ok(models)
}

#[tauri::command]
async fn delete_model(app_handle: AppHandle, size: String, quantized: bool, revision: String) -> Result<(), String> {
    let model_path = get_model_path(&app_handle, &size, quantized, &revision)?;
    if size == pianissimo::ENGINE_ID {
        if model_path.exists() {
            fs::remove_dir_all(&model_path).map_err(|e| e.to_string())?;
        }
        return Ok(());
    }
    if model_path.exists() {
        fs::remove_file(model_path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn save_audio_file(app_handle: AppHandle, state: tauri::State<'_, AppState>) -> Result<(), String> {
    use tauri_plugin_dialog::FilePath;

    // Streaming-flödet: hämta sökvägen till sessionsmappens recording.wav
    let src = state.inner().audio_recorder.lock().unwrap()
        .recording_path.lock().unwrap().clone()
        .ok_or_else(|| "Ingen inspelning att spara".to_string())?;

    if !src.exists() {
        return Err("Inspelningsfilen saknas på disk".to_string());
    }

    let file_path = app_handle.dialog()
        .file()
        .set_title("Spara som ny ljudfil")
        .set_file_name("inspelning.wav")
        .add_filter("WAV-fil", &["wav"])
        .blocking_save_file();

    match file_path {
        Some(path) => {
            let dest = match path {
                FilePath::Path(p) => p,
                _ => return Err("Ogiltigt filformat".to_string()),
            };
            std::fs::copy(&src, &dest)
                .map_err(|e| format!("Kunde inte spara filen: {e}"))?;
            Ok(())
        },
        None => Err("cancelled".to_string()),
    }
}

#[tauri::command]
async fn recover_session(
    state: tauri::State<'_, AppState>,
    session_dir: String,
) -> Result<String, String> {
    let dir = PathBuf::from(&session_dir);
    if !dir.is_dir() {
        return Err("Vald mapp existerar inte".to_string());
    }
    let lb    = dir.join("lb_console.wav");
    let comms = dir.join("lb_comms.wav");
    let mic_file  = dir.join("mic.wav");
    let has_lb    = lb.exists() && std::fs::metadata(&lb).map(|m| m.len() > 44).unwrap_or(false);
    let has_comms = comms.exists() && std::fs::metadata(&comms).map(|m| m.len() > 44).unwrap_or(false);
    let has_mic   = mic_file.exists() && std::fs::metadata(&mic_file).map(|m| m.len() > 44).unwrap_or(false);
    if !has_lb && !has_comms && !has_mic {
        return Err("Inga loopback- eller mic-filer hittades i den valda mappen".to_string());
    }
    if has_lb    { audio::repair_wav_header(&lb)?; }
    if has_comms { audio::repair_wav_header(&comms)?; }
    if has_mic   { audio::repair_wav_header(&mic_file)?; }
    let recording = dir.join("recording.wav");
    audio::mix_session_to_wav(
        if has_mic   { Some(&mic_file) } else { None },
        if has_lb    { Some(&lb) }      else { None },
        if has_comms { Some(&comms) }   else { None },
        &recording,
    )?;
    // Sätt recording_path så save_audio_file kan användas direkt
    if let Ok(rec) = state.inner().audio_recorder.lock() {
        if let Ok(mut path) = rec.recording_path.lock() {
            *path = Some(recording.clone());
        }
    }
    Ok(recording.to_string_lossy().into_owned())
}

#[derive(Serialize)]
struct SessionDirInfo {
    is_session: bool,
    has_ready_recording: bool,
    recording_path: String,
}

/// Lättviktig kontroll om en mapp är en sessionsmapp (innehåller streamat material).
/// Används av "Välj fil/mapp" i UI:t för att avgöra om mappen ska köras via recover_session.
#[tauri::command]
async fn inspect_session_dir(dir: String) -> Result<SessionDirInfo, String> {
    let p = PathBuf::from(&dir);
    if !p.is_dir() {
        return Err("Mappen finns inte".to_string());
    }
    let has_part = ["mic.wav", "lb_console.wav", "lb_comms.wav", "recording.wav"]
        .iter()
        .any(|f| {
            let fp = p.join(f);
            fp.exists() && std::fs::metadata(&fp).map(|m| m.len() > 44).unwrap_or(false)
        });
    let rec = p.join("recording.wav");
    let has_ready = rec.exists() && std::fs::metadata(&rec).map(|m| m.len() > 44).unwrap_or(false);
    Ok(SessionDirInfo {
        is_session: has_part,
        has_ready_recording: has_ready,
        recording_path: if has_ready { rec.to_string_lossy().into_owned() } else { String::new() },
    })
}

/// Default-mapp för inspelningar = mappen där .exe ligger / Transkribera-Inspelningar.
/// På företagsdatorer är Documents ofta GP-redirected till UNC-nätverksdisk, så
/// Documents fungerar dåligt. Mappen där .exe körs ifrån är vanligen lokal SSD
/// (Downloads för portable .exe). Fallback till app_local_data_dir om current_exe
/// inte fungerar (dev-mode-edge-cases).
fn default_recording_dir(app_handle: &AppHandle) -> Result<PathBuf, String> {
    match std::env::current_exe().ok().and_then(|p| p.parent().map(|p| p.to_path_buf())) {
        Some(exe_dir) => Ok(exe_dir.join("Transkribera-Inspelningar")),
        None => {
            let base = app_handle.path().app_local_data_dir()
                .map_err(|e| format!("Kunde inte h\u{00e4}mta app_local_data_dir: {e}"))?;
            Ok(base.join("sessions"))
        }
    }
}

#[tauri::command]
async fn get_default_recording_dir(app_handle: AppHandle) -> Result<String, String> {
    let dir = default_recording_dir(&app_handle)?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Kunde inte skapa standardmapp: {e}"))?;
    Ok(dir.to_string_lossy().into_owned())
}

fn get_dir_size(path: &PathBuf) -> u64 {
    let mut size = 0;
    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.flatten() {
            // F5: undvik panik vid TOCTOU/behörighetsfel — hoppa över filer vi inte kan läsa.
            let Ok(metadata) = entry.metadata() else { continue; };
            if metadata.is_dir() {
                size += get_dir_size(&entry.path());
            } else {
                size += metadata.len();
            }
        }
    }
    size
}

fn is_session_folder(name: &str) -> bool {
    name.starts_with("inspelning-") || name.starts_with("recording-")
}

#[derive(Serialize)]
struct RecordingsSummary {
    count: usize,
    total_bytes: u64,
}

/// Räknar sessionsmappar (inspelning-* / recording-*) i en mapp och deras totala storlek.
/// Används av settings (diskanvändning) och som förhandsbesked före radering.
#[tauri::command]
async fn count_recordings(dir: String) -> Result<RecordingsSummary, String> {
    let base = PathBuf::from(&dir);
    if !base.is_dir() {
        return Ok(RecordingsSummary { count: 0, total_bytes: 0 });
    }
    let mut count = 0;
    let mut total = 0u64;
    for entry in fs::read_dir(&base).map_err(|e| e.to_string())?.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                if is_session_folder(name) {
                    count += 1;
                    total += get_dir_size(&path);
                }
            }
        }
    }
    Ok(RecordingsSummary { count, total_bytes: total })
}

/// Raderar ALLA sessionsmappar (inspelning-* / recording-*) i den givna mappen.
/// Säkerhet: rör ENDAST mappar med rätt prefix — aldrig själva mappen eller andra
/// filer (recordingDir kan peka på t.ex. Downloads). Returnerar antal raderade.
#[tauri::command]
async fn delete_all_recordings(dir: String) -> Result<usize, String> {
    let base = PathBuf::from(&dir);
    if !base.is_dir() {
        return Err("Inspelningsmappen finns inte".to_string());
    }
    let mut deleted = 0;
    for entry in fs::read_dir(&base).map_err(|e| e.to_string())?.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                if is_session_folder(name) {
                    fs::remove_dir_all(&path)
                        .map_err(|e| format!("Kunde inte radera {}: {e}", path.display()))?;
                    deleted += 1;
                }
            }
        }
    }
    Ok(deleted)
}

#[tauri::command]
async fn get_disk_info(app_handle: AppHandle) -> Result<DiskInfo, String> {
    let app_data_dir = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    let models_dir = app_data_dir.join("models");
    let models_dir_size = get_dir_size(&models_dir);

    let disks = Disks::new_with_refreshed_list();
    
    // Find the disk where app data is located
    // For simplicity on macOS/Windows, we look for the disk that contains the app data dir.
    // On Windows it might be C:, on macOS typically /
    let disk = disks.iter().find(|d| {
        app_data_dir.starts_with(d.mount_point())
    }).or_else(|| disks.get(0));

    if let Some(d) = disk {
        Ok(DiskInfo {
            total_space: d.total_space(),
            available_space: d.available_space(),
            models_dir_size,
        })
    } else {
        Err("Could not get disk info".to_string())
    }
}

// ── Pianissimo-motorn (svenska, ONNX, CPU) ──────────────────────────────────

/// Pianissimo körs bara på CPU – använd fysiska kärnor, högst 8 (mer ger ingen vinst).
fn pianissimo_threads() -> usize {
    num_cpus::get_physical().clamp(1, 8)
}

fn pianissimo_to_segments(v: Vec<pianissimo::PSegment>, offset_ms: i64) -> Vec<TranscriptSegment> {
    v.into_iter()
        .map(|s| TranscriptSegment {
            start_ms: s.start_ms + offset_ms,
            end_ms: s.end_ms + offset_ms,
            text: s.text,
            tokens: Vec::new(), // ingen ordnivå-konfidens från Pianissimo
        })
        .collect()
}

fn pianissimo_panic_msg(p: Box<dyn std::any::Any + Send>) -> String {
    let msg = if let Some(s) = p.downcast_ref::<&str>() { s.to_string() }
        else if let Some(s) = p.downcast_ref::<String>() { s.clone() }
        else { "okänt fel".to_string() };
    format!("Transkriberingen kraschade: {msg}.")
}

/// Filväg: streamar avkodning i 5-minuterschunkar, modellen laddas en gång.
async fn transcribe_file_pianissimo(
    app_handle: AppHandle,
    cancel_flag: Arc<AtomicBool>,
    model_dir: PathBuf,
    file_path: String,
) -> Result<Vec<TranscriptSegment>, String> {
    const CHUNK_SAMPLES: usize = 16000 * 300;
    let app_final = app_handle.clone();
    let segs = tokio::task::spawn_blocking(move || {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| -> Result<Vec<TranscriptSegment>, String> {
            let mut dec = StreamingDecoder::open(&file_path)?;
            let total_chunks = dec.estimate_total_chunks(CHUNK_SAMPLES).max(1);
            let _ = app_handle.emit("transcription_progress", TranscriptionProgressPayload { progress: 0 });
            let mut model = pianissimo::Pianissimo::load(&model_dir, pianissimo_threads())
                .map_err(|e| format!("Kunde inte starta Pianissimo: {e}"))?;
            let mut all = Vec::<TranscriptSegment>::new();
            let (mut cum_offset, mut idx) = (0i64, 0usize);
            while let Some(chunk) = dec.next_chunk(CHUNK_SAMPLES)? {
                if cancel_flag.load(Ordering::Relaxed) { break; }
                let offset = cum_offset;
                cum_offset += (chunk.len() as i64 * 1000) / 16000;
                let app = app_handle.clone();
                let (i, total) = (idx as i32, total_chunks as i32);
                let segs = model
                    .transcribe(&chunk, &cancel_flag, move |p| {
                        let overall = ((i * 100 + p) / total).min(99);
                        let _ = app.emit("transcription_progress", TranscriptionProgressPayload { progress: overall });
                    })
                    .map_err(|e| format!("Transkribering med Pianissimo misslyckades: {e}"))?;
                all.extend(pianissimo_to_segments(segs, offset));
                idx += 1;
            }
            Ok(all)
        }))
        .unwrap_or_else(|p| Err(pianissimo_panic_msg(p)))
    })
    .await
    .map_err(|e| format!("Task-fel: {e}"))??;
    let _ = app_final.emit("transcription_progress", TranscriptionProgressPayload { progress: 100 });
    Ok(segs)
}

#[tauri::command]
async fn transcribe_file(
    app_handle: AppHandle,
    state: tauri::State<'_, AppState>,
    file_path: String,
    size: String,
    quantized: bool,
    revision: String,
    language: String,
    initial_prompt: Option<String>,
    use_gpu: Option<bool>,
    thread_count: Option<u32>,
    gpu_device: Option<i32>,
) -> Result<Vec<TranscriptSegment>, String> {
    state.inner().cancel_flag.store(false, Ordering::Relaxed);
    let model_path = get_model_path(&app_handle, &size, quantized, &revision)?;
    if !model_path.exists() {
        return Err("Modell saknas. Ladda ned den först.".to_string());
    }

    if size == pianissimo::ENGINE_ID {
        let cancel = Arc::clone(&state.inner().cancel_flag);
        return transcribe_file_pianissimo(app_handle, cancel, model_path, file_path).await;
    }

    const CHUNK_SAMPLES: usize = 16000 * 300; // 5 min per chunk
    let cancel_flag  = Arc::clone(&state.inner().cancel_flag);
    let use_gpu_val  = use_gpu.unwrap_or(true);
    let app_for_task = app_handle.clone();

    // Kör allt i en enda spawn_blocking — StreamingDecoder öppnas där och
    // hålls levande hela vägen; ett chunk avkodas, transkriberas och kastas
    // bort innan nästa börjar. Peak-minne: ~19 MB oavsett fillängd.
    let all_segments = tokio::task::spawn_blocking(move || -> Result<Vec<TranscriptSegment>, String> {
        let mut dec          = StreamingDecoder::open(&file_path)?;
        let total_chunks     = dec.estimate_total_chunks(CHUNK_SAMPLES).max(1);
        let mut all_segs     = Vec::<TranscriptSegment>::new();
        let mut ctx_prefix   = Option::<String>::None;
        let mut cum_offset   = 0i64;
        let mut chunk_idx    = 0usize;

        // Ladda modellen EN gång — återanvänds över alla chunks.
        // För en 2h-fil sparar detta ~23 onödiga modell-laddningar (varje ~1.5 GB från disk + GPU-init).
        let ctx = load_whisper_with_fallback(&model_path, use_gpu_val, gpu_device)?;
        let n_threads = whisper_thread_count(thread_count);

        while let Some(chunk_samples) = dec.next_chunk(CHUNK_SAMPLES)? {
            if cancel_flag.load(Ordering::Relaxed) { break; }

            let chunk_offset  = cum_offset;
            cum_offset       += (chunk_samples.len() as i64 * 1000) / 16000;

            let lang_hint = match language.as_str() {
                "sv" => "Följande är en transkribering på svenska.",
                "en" => "The following is a transcription in English.",
                _    => "",
            };
            let mut composed = lang_hint.to_string();
            if let Some(ctx) = &ctx_prefix {
                let ctx = ctx.trim();
                if !ctx.is_empty() { if !composed.is_empty() { composed.push(' '); } composed.push_str(ctx); }
            }
            if let Some(vocab) = &initial_prompt {
                let vocab = vocab.trim();
                if !vocab.is_empty() { if !composed.is_empty() { composed.push(' '); } composed.push_str(vocab); }
            }

            // Skicka ett tidigt progress-event så JS direkt byter från "Avkodar..." till "Transkriberar..."
            let chunk_start_progress = ((chunk_idx * 100) / total_chunks) as i32;
            let _ = app_for_task.emit("transcription_progress",
                TranscriptionProgressPayload { progress: chunk_start_progress });

            let composed_cln = composed.clone();
            let language_cln = language.clone();
            let progress     = Arc::new(AtomicI32::new(0));
            let prog_cb      = Arc::clone(&progress);
            let prog_poll    = Arc::clone(&progress);
            let app_poll     = app_for_task.clone();
            let cancel_poll  = Arc::clone(&cancel_flag);

            eprintln!("[transcrptr] chunk {}/{}: {} samples ({:.1}s), n_threads={}",
                chunk_idx + 1, total_chunks, chunk_samples.len(),
                chunk_samples.len() as f32 / 16000.0, n_threads);

            let segs: Result<Vec<TranscriptSegment>, String> = {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    log_line(&format!("transcribe_file chunk {}: anropar ctx.create_state...", chunk_idx + 1));
                    let mut wstate = match ctx.create_state() {
                        Ok(s) => { log_line(&format!("transcribe_file chunk {}: create_state OK", chunk_idx + 1)); s }
                        Err(e) => { log_line(&format!("transcribe_file chunk {}: create_state FAIL: {e}", chunk_idx + 1)); return Err(format!("Kunde inte skapa state: {e}")); }
                    };
                    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
                    params.set_n_threads(n_threads);

                    match language_cln.as_str() {
                        "sv" => params.set_language(Some("sv")),
                        "en" => params.set_language(Some("en")),
                        _    => params.set_language(None),
                    }
                    if !composed_cln.is_empty() { params.set_initial_prompt(&composed_cln); }
                    params.set_print_progress(false);
                    params.set_print_special(false);
                    params.set_print_realtime(false);
                    params.set_print_timestamps(false);

                    params.set_temperature(0.0);
                    params.set_no_speech_thold(0.6);
                    params.set_suppress_blank(true);
                    params.set_split_on_word(true);

                    params.set_progress_callback_safe(move |p| { prog_cb.store(p, Ordering::Relaxed); });

                    let poller = tokio::spawn(async move {
                        let mut last = -1i32;
                        loop {
                            if cancel_poll.load(Ordering::Relaxed) { break; }
                            let p = prog_poll.load(Ordering::Relaxed);
                            if p != last {
                                let overall = ((chunk_idx as i32 * 100 + p) / total_chunks as i32).min(99);
                                let _ = app_poll.emit("transcription_progress",
                                    TranscriptionProgressPayload { progress: overall });
                                last = p;
                            }
                            if p >= 100 { break; }
                            tokio::time::sleep(Duration::from_millis(500)).await;
                        }
                    });

                    log_line(&format!("calling wstate.full chunk {}/{}: {} samples", chunk_idx + 1, total_chunks, chunk_samples.len()));
                    let res = wstate.full(params, &chunk_samples);
                    poller.abort();
                    if let Err(e) = res {
                        log_line(&format!("wstate.full FAIL chunk {}: {e:?}", chunk_idx + 1));
                        return Err(format!("Transkribering misslyckades: {e:?}"));
                    }
                    log_line(&format!("wstate.full OK chunk {}", chunk_idx + 1));

                    let n = wstate.full_n_segments();
                    let mut out = Vec::new();
                    for i in 0..n {
                        let seg     = wstate.get_segment(i).ok_or("Segment saknas")?;
                        let text    = seg.to_str_lossy().map_err(|e| format!("Texthämtning: {e:?}"))?;
                        let trimmed = clean_whisper_text(text.as_ref());
                        if trimmed.is_empty() { continue; }
                        let t0 = seg.start_timestamp() * 10 + chunk_offset;
                        let t1 = seg.end_timestamp()   * 10 + chunk_offset;
                        let mut tokens = Vec::new();
                        for t in 0..seg.n_tokens() {
                            if let Some(tok) = seg.get_token(t) {
                                if let Ok(tt) = tok.to_str_lossy() {
                                    let s = tt.into_owned();
                                    if s.starts_with("[_") || s.starts_with("<|") { continue; }
                                    tokens.push(TokenInfo { text: s, prob: tok.token_probability() });
                                }
                            }
                        }
                        out.push(TranscriptSegment { start_ms: t0, end_ms: t1, text: trimmed, tokens });
                    }
                    Ok::<Vec<TranscriptSegment>, String>(out)
                }));
                match result {
                    Ok(inner) => inner,
                    Err(p) => {
                        let msg = if let Some(s) = p.downcast_ref::<&str>() { s.to_string() }
                                  else if let Some(s) = p.downcast_ref::<String>() { s.clone() }
                                  else { "Unknown panic".to_string() };
                        Err(format!("Krasch i del {}: {msg}", chunk_idx + 1))
                    }
                }
            };
            let segs = segs?;

            if !segs.is_empty() {
                let chunk_text = segs.iter().map(|s| s.text.as_str()).collect::<Vec<_>>().join(" ");
                let words: Vec<&str> = chunk_text.split_whitespace().collect();
                ctx_prefix = Some(words.iter().rev().take(30).rev().cloned().collect::<Vec<_>>().join(" "));
            }
            all_segs.extend(segs);
            chunk_idx += 1;
        }

        Ok(all_segs)
    }).await.map_err(|e| format!("Task-fel: {e}"))??;

    let _ = app_handle.emit("transcription_progress", TranscriptionProgressPayload { progress: 100 });
    Ok(all_segments)
}

#[derive(Serialize)]
struct RecordingStartResult {
    loopback_active: bool,
}

#[tauri::command]
async fn start_backend_recording(
    app_handle: AppHandle,
    state: tauri::State<'_, AppState>,
    loopback_only: bool,
    with_loopback: bool,
    recording_dir: Option<String>,
) -> Result<RecordingStartResult, String> {
    log_line(&format!("start_backend_recording: loopback_only={loopback_only}, with_loopback={with_loopback}, recording_dir={recording_dir:?}"));

    // v1.4.7: ANV\u{00c4}NDARENS valda recording_dir är streaming-mapp DIREKT — ingen kopia.
    // V1.4.3 flödade alltid via lokal "tempfile-mapp" + kopia vid stop, men på GP-redirected
    // Documents-mappar (UNC-nätverk) blev "lokal"-mappen i själva verket nätverksdisk.
    // Användaren ansvarar nu själv för att välja en lokal path; default = .exe-mappen.
    let base_dir = match recording_dir.as_deref() {
        Some(p) if !p.is_empty() => PathBuf::from(p),
        _ => default_recording_dir(&app_handle)?,
    };
    std::fs::create_dir_all(&base_dir)
        .map_err(|e| format!("Kunde inte skapa inspelningsmapp {}: {e}", base_dir.display()))?;
    log_line(&format!("start_backend_recording: streaming-mapp = {}", base_dir.display()));

    let mut recorder = state.inner().audio_recorder.lock().unwrap();
    let result = recorder.start_recording(loopback_only, with_loopback, &base_dir);
    match &result {
        Ok(_) => log_line(&format!("start_backend_recording: OK (loopback_active={})", recorder.loopback_active)),
        Err(e) => log_line(&format!("start_backend_recording: FAIL {e}")),
    }
    result?;
    Ok(RecordingStartResult { loopback_active: recorder.loopback_active })
}

#[tauri::command]
async fn stop_backend_recording(state: tauri::State<'_, AppState>) -> Result<(), String> {
    log_line("stop_backend_recording: anrop fr\u{00e5}n JS");
    let mut recorder = state.inner().audio_recorder.lock().unwrap();
    log_line("stop_backend_recording: recorder-l\u{00e5}s taget, anropar stop_recording");
    let result = recorder.stop_recording();
    match &result {
        Ok(_) => {
            let path = recorder.recording_path.lock().ok()
                .and_then(|g| g.clone())
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_else(|| "<saknas>".to_string());
            log_line(&format!("stop_backend_recording: OK, recording_path = {path}"));
        }
        Err(e) => log_line(&format!("stop_backend_recording: FAIL {e}")),
    }
    result
}

#[tauri::command]
async fn save_text_file(app_handle: AppHandle, content: String) -> Result<(), String> {
    use tauri_plugin_dialog::FilePath;
    
    let file_path = app_handle.dialog()
        .file()
        .set_title("Spara transkribering")
        .set_file_name("transkribering.txt")
        .add_filter("Textfil", &["txt"])
        .blocking_save_file();

    match file_path {
        Some(path) => {
            let path_str = match path {
                FilePath::Path(p) => p,
                _ => return Err("Ogiltigt filformat".to_string()),
            };
            fs::write(&path_str, &content).map_err(|e| format!("Kunde inte spara: {}", e))?;
            Ok(())
        },
        None => Err("cancelled".to_string()),
    }
}

#[tauri::command]
async fn pick_audio_file(app_handle: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::FilePath;
    let path = app_handle.dialog()
        .file()
        .add_filter("Ljud/Video", &["mp3","m4a","aac","wav","ogg","flac","mp4","webm","mkv"])
        .blocking_pick_file();
    match path {
        Some(FilePath::Path(p)) => Ok(Some(p.to_string_lossy().to_string())),
        _ => Ok(None),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState {
            cancel_flag: Arc::new(AtomicBool::new(false)),
            audio_recorder: Mutex::new(AudioRecorder::new()),
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            init_logging(&app.handle());
            log_line(&format!("=== app start v{} ===", env!("CARGO_PKG_VERSION")));
            log_line(&format!("num_cpus::get() = {}", num_cpus::get()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            check_model_exists,
            download_model,
            get_available_models,
            delete_model,
            get_disk_info,
            start_backend_recording,
            stop_backend_recording,
            transcribe_file,
            cancel_transcription,
            get_app_version,
            get_default_recording_dir,
            recover_session,
            inspect_session_dir,
            count_recordings,
            delete_all_recordings,
            save_text_file,
            save_audio_file,
            pick_audio_file,
            get_log_path,
            log_message,
            append_mic_chunk,
            get_recording_path,
            rename_session,
            allow_asset_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
