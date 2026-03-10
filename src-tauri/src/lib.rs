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
struct ModelInfo {
    name: String,
    size_bytes: u64,
    downloaded: bool,
}

#[derive(Serialize)]
struct DiskInfo {
    total_space: u64,
    available_space: u64,
    models_dir_size: u64,
}

fn get_model_info(size: &str, quantized: bool) -> (String, String) {
    let repo = format!("kb-whisper-{}", size);
    let filename = if quantized { "ggml-model-q5_0.bin" } else { "ggml-model.bin" };
    let url = format!("https://huggingface.co/KBLab/{}/resolve/main/{}", repo, filename);
    let local_filename = format!("ggml-model-{}-kb{}.bin", size, if quantized { "-q5_0" } else { "" });
    (url, local_filename)
}

fn get_model_path(app_handle: &AppHandle, size: &str, quantized: bool) -> Result<PathBuf, String> {
    let (_, filename) = get_model_info(size, quantized);
    let app_data_dir = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    let models_dir = app_data_dir.join("models");
    if !models_dir.exists() {
        fs::create_dir_all(&models_dir).map_err(|e| e.to_string())?;
    }
    Ok(models_dir.join(filename))
}

#[tauri::command]
fn check_model_exists(app_handle: AppHandle, size: String, quantized: bool) -> Result<bool, String> {
    let model_path = get_model_path(&app_handle, &size, quantized)?;
    Ok(model_path.exists())
}

#[tauri::command]
async fn download_model(app_handle: AppHandle, size: String, quantized: bool) -> Result<String, String> {
    let model_path = get_model_path(&app_handle, &size, quantized)?;
    let (url, _) = get_model_info(&size, quantized);
    
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
    let sizes = ["tiny", "base", "small", "medium", "large-v3-turbo", "large-v3"];
    let mut models = Vec::new();

    for size in sizes {
        // We check both quantized and non-quantized
        for quantized in [true, false] {
            let model_path = get_model_path(&app_handle, size, quantized)?;
            let name = if quantized { format!("{} (quantized)", size) } else { size.to_string() };
            
            let (downloaded, size_bytes) = if model_path.exists() {
                let meta = fs::metadata(&model_path).map_err(|e| e.to_string())?;
                (true, meta.len())
            } else {
                (false, 0)
            };

            models.push(ModelInfo {
                name,
                size_bytes,
                downloaded,
            });
        }
    }

    Ok(models)
}

#[tauri::command]
async fn delete_model(app_handle: AppHandle, name: String) -> Result<(), String> {
    // Determine size and quantized from name
    let (size, quantized) = if name.contains(" (quantized)") {
        (name.replace(" (quantized)", ""), true)
    } else {
        (name, false)
    };

    let model_path = get_model_path(&app_handle, &size, quantized)?;
    if model_path.exists() {
        fs::remove_file(model_path).map_err(|e| e.to_string())?;
    }
    Ok(())
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
async fn transcribe_audio(app_handle: AppHandle, state: tauri::State<'_, AppState>, audio_bytes: Vec<u8>, size: String, quantized: bool, language: String) -> Result<String, String> {
    state.inner().cancel_flag.store(false, Ordering::Relaxed);
    let model_path = get_model_path(&app_handle, &size, quantized)?;
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

            let ctx = WhisperContext::new_with_params(
                &model_path.to_string_lossy(),
                WhisperContextParameters::default()
            ).map_err(|e| format!("Failed to load model: {}", e))?;
            
            let mut transcriber_state = ctx.create_state().map_err(|e| format!("Failed to create state: {}", e))?;
            
            let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
            
            // Set language and initial prompt based on user selection
            match language.as_str() {
                "sv" => {
                    params.set_language(Some("sv"));
                    params.set_initial_prompt("Följande är en transkribering på svenska.");
                }
                "en" => {
                    params.set_language(Some("en"));
                    params.set_initial_prompt("The following is a transcription in English.");
                }
                _ => {
                    // "auto" — let whisper detect the language
                    params.set_language(None);
                }
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

            // Safely cast the incoming Vec<u8> to a &[f32]
            // We ensure it aligns properly and hasn't been corrupted.
            let samples: &[f32] = unsafe {
                std::slice::from_raw_parts(
                    audio_bytes.as_ptr() as *const f32,
                    audio_bytes.len() / std::mem::size_of::<f32>(),
                )
            };

            // Run the main transcription
            let res = transcriber_state.full(params, samples);
            
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
                let trimmed = segment.trim();
                if !trimmed.is_empty() {
                    result.push_str(trimmed);
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
async fn start_backend_recording(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let mut recorder = state.inner().audio_recorder.lock().unwrap();
    recorder.start_recording()
}

#[tauri::command]
async fn stop_backend_recording(state: tauri::State<'_, AppState>) -> Result<Vec<u8>, String> {
    let mut recorder = state.inner().audio_recorder.lock().unwrap();
    Ok(recorder.stop_recording())
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
            cancel_transcription,
            save_text_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
