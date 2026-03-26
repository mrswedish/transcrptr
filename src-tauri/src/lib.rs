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
use regex::Regex;

mod audio;
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
    let (_, filename) = get_model_info(size, quantized, revision);
    let app_data_dir = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    let models_dir = app_data_dir.join("models");
    if !models_dir.exists() {
        fs::create_dir_all(&models_dir).map_err(|e| e.to_string())?;
    }
    Ok(models_dir.join(filename))
}

#[tauri::command]
fn check_model_exists(app_handle: AppHandle, size: String, quantized: bool, revision: String) -> Result<bool, String> {
    let model_path = get_model_path(&app_handle, &size, quantized, &revision)?;
    Ok(model_path.exists())
}

#[tauri::command]
async fn download_model(app_handle: AppHandle, size: String, quantized: bool, revision: String) -> Result<String, String> {
    let model_path = get_model_path(&app_handle, &size, quantized, &revision)?;
    let (url, _) = get_model_info(&size, quantized, &revision);
    
    // If it already exists, just return path
    if model_path.exists() {
        // Emit 100% just in case
        let _ = app_handle.emit("download_progress", ProgressPayload { progress: 100.0, downloaded: 1, total: 1 });
        return Ok(model_path.to_string_lossy().to_string());
    }

    let tmp_path = model_path.with_extension("tmp");
    let res = reqwest::get(&url).await.map_err(|e| e.to_string())?;
    
    if !res.status().is_success() {
        return Err(format!("Failed to download model: HTTP {}", res.status()));
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

    Ok(models)
}

#[tauri::command]
async fn delete_model(app_handle: AppHandle, size: String, quantized: bool, revision: String) -> Result<(), String> {
    let model_path = get_model_path(&app_handle, &size, quantized, &revision)?;
    if model_path.exists() {
        fs::remove_file(model_path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn save_audio_file(app_handle: AppHandle, state: tauri::State<'_, AppState>) -> Result<(), String> {
    use tauri_plugin_dialog::FilePath;
    use hound::{WavWriter, WavSpec, SampleFormat};

    // Get current recorded samples
    let samples: Vec<f32> = state.inner().audio_recorder.lock().unwrap()
        .recorded_samples.lock().unwrap().clone();

    if samples.is_empty() {
        return Err("Ingen inspelning att spara".to_string());
    }

    let file_path = app_handle.dialog()
        .file()
        .set_title("Spara inspelning")
        .set_file_name("inspelning.wav")
        .add_filter("WAV-fil", &["wav"])
        .blocking_save_file();

    match file_path {
        Some(path) => {
            let path_str = match path {
                FilePath::Path(p) => p,
                _ => return Err("Ogiltigt filformat".to_string()),
            };
            let spec = WavSpec {
                channels: 1,
                sample_rate: 16000,
                bits_per_sample: 16,
                sample_format: SampleFormat::Int,
            };
            let mut writer = WavWriter::create(&path_str, spec)
                .map_err(|e| format!("Kunde inte skapa WAV-fil: {e}"))?;
            for &s in &samples {
                let pcm = (s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
                writer.write_sample(pcm).map_err(|e| format!("Skrivfel: {e}"))?;
            }
            writer.finalize().map_err(|e| format!("Fel vid finalisering: {e}"))?;
            Ok(())
        },
        None => Err("cancelled".to_string()),
    }
}

fn get_dir_size(path: &PathBuf) -> u64 {
    let mut size = 0;
    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.flatten() {
            let metadata = entry.metadata().unwrap();
            if metadata.is_dir() {
                size += get_dir_size(&entry.path());
            } else {
                size += metadata.len();
            }
        }
    }
    size
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
async fn transcribe_audio(app_handle: AppHandle, state: tauri::State<'_, AppState>, audio_bytes: Vec<u8>, size: String, quantized: bool, revision: String, language: String, initial_prompt: Option<String>, context_prefix: Option<String>, use_gpu: Option<bool>) -> Result<String, String> {
    state.inner().cancel_flag.store(false, Ordering::Relaxed);
    let model_path = get_model_path(&app_handle, &size, quantized, &revision)?;
    if !model_path.exists() {
        return Err("Model not found. Please download it first.".to_string());
    }

    // Extract the cancel flag Arc before moving into the closure
    let cancel_flag = Arc::clone(&state.inner().cancel_flag);

    // Run transcribe in a blocking thread since whisper-rs is CPU bound
    let audio_len = audio_bytes.len();
    let text = tokio::task::spawn_blocking(move || {
        // Wrap everything in catch_unwind to prevent silent crashes (segfaults in whisper.cpp)
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let num_samples = audio_len / std::mem::size_of::<f32>();
            eprintln!("[transcrptr] Transcribing {} bytes ({} samples, {:.1}s of audio, lang={})",
                audio_len, num_samples, num_samples as f64 / 16000.0, language);

            let mut ctx_params = WhisperContextParameters::default();
            ctx_params.use_gpu = use_gpu.unwrap_or(true);
            let ctx = WhisperContext::new_with_params(
                &model_path.to_string_lossy(),
                ctx_params
            ).map_err(|e| format!("Failed to load model: {}", e))?;
            
            let mut transcriber_state = ctx.create_state().map_err(|e| format!("Failed to create state: {}", e))?;
            
            let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
            
            // Build initial prompt: language hint + optional context from previous chunk + optional user vocabulary
            let lang_hint = match language.as_str() {
                "sv" => {
                    params.set_language(Some("sv"));
                    "Följande är en transkribering på svenska."
                }
                "en" => {
                    params.set_language(Some("en"));
                    "The following is a transcription in English."
                }
                _ => {
                    params.set_language(None);
                    ""
                }
            };
            let mut composed = lang_hint.to_string();
            if let Some(ctx) = &context_prefix {
                let ctx = ctx.trim();
                if !ctx.is_empty() {
                    if !composed.is_empty() { composed.push(' '); }
                    composed.push_str(ctx);
                }
            }
            if let Some(vocab) = &initial_prompt {
                let vocab = vocab.trim();
                if !vocab.is_empty() {
                    if !composed.is_empty() { composed.push(' '); }
                    composed.push_str(vocab);
                }
            }
            if !composed.is_empty() {
                params.set_initial_prompt(&composed);
            }
            
            params.set_print_progress(false);
            params.set_print_special(false);
            params.set_print_realtime(false);
            params.set_print_timestamps(false);
            

            // SAFE PROGRESS TRACKING
            // We use an AtomicI32 because it is 100% thread-safe and requires no memory allocation.
            // This prevents the FFI-boundary silent crashes we saw previously when emitting Tauri events directly from C++.
            let progress = Arc::new(AtomicI32::new(0));
            
            let progress_clone = Arc::clone(&progress);
            params.set_progress_callback_safe(move |p| {
                progress_clone.store(p, Ordering::Relaxed);
            });

            // Start a polling task to emit progress to the frontend
            let app_handle_clone = app_handle.clone();
            let progress_poller = Arc::clone(&progress);
            let cancel_poller = Arc::clone(&cancel_flag);
            
            let poller_handle = tokio::spawn(async move {
                let mut last_emitted = -1;
                loop {
                    // Check if transcription is cancelled to stop polling early
                    if cancel_poller.load(Ordering::Relaxed) {
                        break;
                    }
                    
                    let current_progress = progress_poller.load(Ordering::Relaxed);
                    
                    if current_progress != last_emitted {
                        let _ = app_handle_clone.emit("transcription_progress", TranscriptionProgressPayload { progress: current_progress });
                        last_emitted = current_progress;
                    }

                    if current_progress >= 100 {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(500)).await;
                }
            });

            // Safely convert Vec<u8> (little-endian f32 bytes) to Vec<f32>.
            // The unsafe cast from &[u8] to &[f32] is UB due to alignment — use safe conversion instead.
            let samples: Vec<f32> = audio_bytes
                .chunks_exact(4)
                .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
                .collect();

            // Run the main transcription
            let res = transcriber_state.full(params, &samples);
            
            // Abort poller just in case
            poller_handle.abort();

            // Check if error
            if let Err(e) = res {
                return Err(format!("Transcription failed: {:?}", e));
            }
            
            // Emit 100% progress when done
            let _ = app_handle.emit("transcription_progress", TranscriptionProgressPayload { progress: 100 });
            
            let num_segments = transcriber_state.full_n_segments();
            let mut result = String::new();
            for i in 0..num_segments {
                let segment_obj = transcriber_state.get_segment(i).ok_or("Failed to get segment")?;
                let segment = segment_obj.to_str_lossy().map_err(|e| format!("Failed to get text: {}", e))?;
                let trimmed = clean_whisper_text(segment.as_ref());
                if !trimmed.is_empty() {
                    result.push_str(&trimmed);
                    result.push('\n');
                }
            }
            
            Ok::<String, String>(result.trim().to_string())
        }));

        match result {
            Ok(inner) => inner,
            Err(panic_info) => {
                let panic_msg = if let Some(s) = panic_info.downcast_ref::<&str>() {
                    s.to_string()
                } else if let Some(s) = panic_info.downcast_ref::<String>() {
                    s.clone()
                } else {
                    "Unknown panic".to_string()
                };
                Err(format!("Transkriberingen kraschade: {}. Prova en kortare ljudfil eller en mindre modell.", panic_msg))
            },
        }
    }).await.map_err(|e| format!("Transcription task failed: {}", e))??;

    Ok(text)
}

#[tauri::command]
async fn transcribe_audio_segments(app_handle: AppHandle, state: tauri::State<'_, AppState>, audio_bytes: Vec<u8>, size: String, quantized: bool, revision: String, language: String, initial_prompt: Option<String>, context_prefix: Option<String>, use_gpu: Option<bool>) -> Result<Vec<TranscriptSegment>, String> {
    state.inner().cancel_flag.store(false, Ordering::Relaxed);
    let model_path = get_model_path(&app_handle, &size, quantized, &revision)?;
    if !model_path.exists() {
        return Err("Model not found. Please download it first.".to_string());
    }

    let cancel_flag = Arc::clone(&state.inner().cancel_flag);
    let audio_len = audio_bytes.len();

    let segments = tokio::task::spawn_blocking(move || {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let num_samples = audio_len / std::mem::size_of::<f32>();
            eprintln!("[transcrptr] transcribe_audio_segments {} samples, lang={}", num_samples, language);

            let mut ctx_params = WhisperContextParameters::default();
            ctx_params.use_gpu = use_gpu.unwrap_or(true);
            let ctx = WhisperContext::new_with_params(
                &model_path.to_string_lossy(),
                ctx_params
            ).map_err(|e| format!("Failed to load model: {}", e))?;

            let mut transcriber_state = ctx.create_state().map_err(|e| format!("Failed to create state: {}", e))?;
            let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });

            let lang_hint = match language.as_str() {
                "sv" => { params.set_language(Some("sv")); "Följande är en transkribering på svenska." }
                "en" => { params.set_language(Some("en")); "The following is a transcription in English." }
                _ => { params.set_language(None); "" }
            };
            let mut composed = lang_hint.to_string();
            if let Some(ctx) = &context_prefix {
                let ctx = ctx.trim();
                if !ctx.is_empty() { if !composed.is_empty() { composed.push(' '); } composed.push_str(ctx); }
            }
            if let Some(vocab) = &initial_prompt {
                let vocab = vocab.trim();
                if !vocab.is_empty() { if !composed.is_empty() { composed.push(' '); } composed.push_str(vocab); }
            }
            if !composed.is_empty() { params.set_initial_prompt(&composed); }

            params.set_print_progress(false);
            params.set_print_special(false);
            params.set_print_realtime(false);
            params.set_print_timestamps(false);

            let progress = Arc::new(AtomicI32::new(0));
            let progress_clone = Arc::clone(&progress);
            params.set_progress_callback_safe(move |p| { progress_clone.store(p, Ordering::Relaxed); });

            let app_handle_clone = app_handle.clone();
            let progress_poller = Arc::clone(&progress);
            let cancel_poller = Arc::clone(&cancel_flag);
            let poller_handle = tokio::spawn(async move {
                let mut last_emitted = -1;
                loop {
                    if cancel_poller.load(Ordering::Relaxed) { break; }
                    let current_progress = progress_poller.load(Ordering::Relaxed);
                    if current_progress != last_emitted {
                        let _ = app_handle_clone.emit("transcription_progress", TranscriptionProgressPayload { progress: current_progress });
                        last_emitted = current_progress;
                    }
                    if current_progress >= 100 { break; }
                    tokio::time::sleep(Duration::from_millis(500)).await;
                }
            });

            let samples: Vec<f32> = audio_bytes
                .chunks_exact(4)
                .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
                .collect();

            let res = transcriber_state.full(params, &samples);
            poller_handle.abort();

            if let Err(e) = res {
                return Err(format!("Transcription failed: {:?}", e));
            }

            let _ = app_handle.emit("transcription_progress", TranscriptionProgressPayload { progress: 100 });

            let num_segs = transcriber_state.full_n_segments();
            let mut out: Vec<TranscriptSegment> = Vec::new();
            for i in 0..num_segs {
                let seg = transcriber_state.get_segment(i).ok_or("Failed to get segment")?;
                let text = seg.to_str_lossy().map_err(|e| format!("Failed to get text: {:?}", e))?;
                let trimmed = clean_whisper_text(text.as_ref());
                if trimmed.is_empty() { continue; }
                // whisper.cpp timestamps are in centiseconds → convert to ms (* 10)
                let t0 = seg.start_timestamp() * 10;
                let t1 = seg.end_timestamp() * 10;
                // Collect token probabilities (skip special tokens like [_BEG_], [_TT_*])
                let mut tokens: Vec<TokenInfo> = Vec::new();
                for t in 0..seg.n_tokens() {
                    if let Some(tok) = seg.get_token(t) {
                        if let Ok(tok_text) = tok.to_str_lossy() {
                            let tok_str = tok_text.into_owned();
                            // Skip whisper special tokens ([_BEG_], [_TT_*], <|nospeech|> etc.)
                            if tok_str.starts_with("[_") || tok_str.starts_with("<|") { continue; }
                            let prob = tok.token_probability();
                            tokens.push(TokenInfo { text: tok_str, prob });
                        }
                    }
                }
                out.push(TranscriptSegment { start_ms: t0, end_ms: t1, text: trimmed, tokens });
            }

            Ok::<Vec<TranscriptSegment>, String>(out)
        }));

        match result {
            Ok(inner) => inner,
            Err(panic_info) => {
                let panic_msg = if let Some(s) = panic_info.downcast_ref::<&str>() { s.to_string() }
                    else if let Some(s) = panic_info.downcast_ref::<String>() { s.clone() }
                    else { "Unknown panic".to_string() };
                Err(format!("Transkriberingen kraschade: {}.", panic_msg))
            },
        }
    }).await.map_err(|e| format!("Transcription task failed: {}", e))??;

    Ok(segments)
}

#[tauri::command]
fn mask_pii_regex(text: String) -> Result<String, String> {
    // Swedish personnummer: YYMMDD-NNNN or YYYYMMDD-NNNN or YYMMDD+NNNN
    let personnummer = Regex::new(r"\b\d{6,8}[-+]\d{4}\b").map_err(|e| e.to_string())?;
    // Swedish phone numbers: 07X, +46 7X, 08-XXXX etc
    let phone = Regex::new(r"\b(\+46|0)[\s.-]?\d{1,3}[\s.-]?\d{2,4}[\s.-]?\d{2,4}[\s.-]?\d{0,4}\b").map_err(|e| e.to_string())?;
    // Email addresses
    let email = Regex::new(r"\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b").map_err(|e| e.to_string())?;

    let result = personnummer.replace_all(&text, "[PERSONNUMMER]");
    let result = email.replace_all(&result, "[E-POST]");
    let result = phone.replace_all(&result, "[TELEFON]");

    Ok(result.into_owned())
}

#[derive(Serialize)]
struct RecordingStartResult {
    loopback_active: bool,
}

#[tauri::command]
async fn start_backend_recording(state: tauri::State<'_, AppState>, loopback_only: bool) -> Result<RecordingStartResult, String> {
    let mut recorder = state.inner().audio_recorder.lock().unwrap();
    recorder.start_recording(loopback_only)?;
    Ok(RecordingStartResult { loopback_active: recorder.loopback_active })
}

#[tauri::command]
async fn stop_backend_recording(state: tauri::State<'_, AppState>) -> Result<Vec<u8>, String> {
    let mut recorder = state.inner().audio_recorder.lock().unwrap();
    Ok(recorder.stop_recording())
}

#[tauri::command]
async fn save_audio_data(app_handle: AppHandle, audio_data: Vec<u8>) -> Result<(), String> {
    use tauri_plugin_dialog::FilePath;

    let file_path = app_handle.dialog()
        .file()
        .set_title("Spara inspelning")
        .set_file_name("inspelning.wav")
        .add_filter("WAV-fil", &["wav"])
        .blocking_save_file();

    match file_path {
        Some(path) => {
            let path_str = match path {
                FilePath::Path(p) => p,
                _ => return Err("Ogiltigt filformat".to_string()),
            };
            fs::write(&path_str, &audio_data).map_err(|e| format!("Kunde inte spara: {}", e))?;
            Ok(())
        },
        None => Err("cancelled".to_string()),
    }
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState {
            cancel_flag: Arc::new(AtomicBool::new(false)),
            audio_recorder: Mutex::new(AudioRecorder::new()),
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            check_model_exists,
            download_model,
            get_available_models,
            delete_model,
            get_disk_info,
            start_backend_recording,
            stop_backend_recording,
            transcribe_audio,
            transcribe_audio_segments,
            cancel_transcription,
            mask_pii_regex,
            save_text_file,
            save_audio_file,
            save_audio_data
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
