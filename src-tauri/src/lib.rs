// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use std::path::PathBuf;
use std::fs;
use futures_util::StreamExt;
use std::io::Write;
use tauri::{AppHandle, Manager, Emitter};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri_plugin_dialog::DialogExt;
use sysinfo::Disks;

mod audio;
mod decode;
mod engine;
mod pianissimo;
mod types;
mod whisper;
use decode::StreamingDecoder;
use types::*;
#[cfg(target_os = "windows")]
mod application_loopback;
use audio::AudioRecorder;

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
/// Rå binär payload: f32 little-endian PCM i body, samplingsfrekvens i headern
/// `x-sample-rate`. (Tidigare skickades `Vec<f32>` som JSON-array av tal.)
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn parse_mic_payload(request: &tauri::ipc::Request<'_>) -> Result<(Vec<f32>, u32), String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("append_mic_chunk förväntar rå binär data".to_string());
    };
    let sample_rate: u32 = request
        .headers()
        .get("x-sample-rate")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok())
        .ok_or("Saknar giltig x-sample-rate")?;
    let samples = bytes
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .collect();
    Ok((samples, sample_rate))
}

#[cfg(target_os = "windows")]
#[tauri::command]
async fn append_mic_chunk(
    state: tauri::State<'_, AppState>,
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    let (samples, sample_rate) = parse_mic_payload(&request)?;
    let recorder = state.inner().audio_recorder.lock()
        .map_err(|e| format!("Recorder-lås: {e}"))?;
    recorder.append_mic_pcm(&samples, sample_rate)
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
async fn append_mic_chunk(_request: tauri::ipc::Request<'_>) -> Result<(), String> {
    // Mac pausat: ingen mikrofoninspelning via webbläsaren.
    Ok(())
}

// Försök ladda WhisperContext med begärt GPU-läge. Om GPU-init misslyckas
// (vanligt på multi-GPU/NPU-Windows pga Vulkan-konflikt), faller vi tillbaka
// till CPU automatiskt så användaren slipper krasch.
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
    let cancel = Arc::clone(&state.inner().cancel_flag);
    let app = app_handle.clone();

    // Allt i en enda spawn_blocking: avkodaren hålls öppen hela vägen, ett chunk
    // avkodas, transkriberas och kastas bort innan nästa börjar.
    let segments = tokio::task::spawn_blocking(move || -> Result<Vec<TranscriptSegment>, String> {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| -> Result<Vec<TranscriptSegment>, String> {
            // Öppna filen först så att ett läsfel visas innan den långsamma modellen laddas.
            let mut dec = StreamingDecoder::open(&file_path)?;
            let mut engine: Box<dyn engine::Engine> = if size == pianissimo::ENGINE_ID {
                Box::new(
                    pianissimo::Pianissimo::load(&model_path, pianissimo::default_threads())
                        .map_err(|e| format!("Kunde inte starta Pianissimo: {e}"))?,
                )
            } else {
                Box::new(whisper::WhisperEngine::load(
                    &model_path,
                    use_gpu.unwrap_or(true),
                    gpu_device,
                    language,
                    initial_prompt,
                    thread_count,
                )?)
            };
            let emit = |p: i32| {
                let _ = app.emit("transcription_progress", TranscriptionProgressPayload { progress: p });
            };
            emit(0);
            engine::run_file(engine.as_mut(), &mut dec, &cancel, &emit)
        }))
        .unwrap_or_else(|p| Err(format!("Transkriberingen kraschade: {}.", engine::panic_msg(p))))
    })
    .await
    .map_err(|e| format!("Task-fel: {e}"))??;

    let _ = app_handle.emit("transcription_progress", TranscriptionProgressPayload { progress: 100 });
    Ok(segments)
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
