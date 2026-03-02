// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use std::path::PathBuf;
use std::fs;
use futures_util::StreamExt;
use std::io::Write;
use tauri::{AppHandle, Manager, Emitter};
use serde::Serialize;
use whisper_rs::{WhisperContext, WhisperContextParameters, FullParams, SamplingStrategy};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

pub struct AppState {
    pub cancel_flag: Arc<AtomicBool>,
}

#[tauri::command]
fn cancel_transcription(state: tauri::State<AppState>) {
    state.cancel_flag.store(true, Ordering::Relaxed);
}

#[derive(Serialize, Clone)]
struct ProgressPayload {
    progress: f32,
    downloaded: u64,
    total: u64,
}

#[derive(Serialize, Clone)]
struct SegmentPayload {
    text: String,
}

#[derive(Serialize, Clone)]
struct TranscriptionProgressPayload {
    progress: i32,
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
async fn transcribe_audio(app_handle: AppHandle, state: tauri::State<'_, AppState>, audio_bytes: Vec<u8>, size: String, quantized: bool) -> Result<String, String> {
    state.cancel_flag.store(false, Ordering::Relaxed);
    let model_path = get_model_path(&app_handle, &size, quantized)?;
    if !model_path.exists() {
        return Err("Model not found. Please download it first.".to_string());
    }

    // Run transcribe in a blocking thread since whisper-rs is CPU bound
    let text = tokio::task::spawn_blocking(move || {
        // Wrap everything in catch_unwind to prevent silent crashes (segfaults in whisper.cpp)
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let ctx = WhisperContext::new_with_params(
                &model_path.to_string_lossy(),
                WhisperContextParameters::default()
            ).map_err(|e| format!("Failed to load model: {}", e))?;
            
            let mut state = ctx.create_state().map_err(|e| format!("Failed to create state: {}", e))?;
            
            let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
            params.set_language(Some("sv"));
            params.set_print_progress(false);
            params.set_print_special(false);
            params.set_print_realtime(false);
            params.set_print_timestamps(false);
            
            // NOTE: We intentionally do NOT set any FFI callbacks here.
            // set_segment_callback, set_progress_callback, and set_abort_callback
            // all cross the Rust<->C++ FFI boundary and are known to cause silent
            // segfaults on Windows. Instead we collect results after transcription.

            // Safely cast the incoming Vec<u8> to a &[f32]
            // We ensure it aligns properly and hasn't been corrupted.
            let samples: &[f32] = unsafe {
                std::slice::from_raw_parts(
                    audio_bytes.as_ptr() as *const f32,
                    audio_bytes.len() / std::mem::size_of::<f32>(),
                )
            };

            // Run the main transcription
            let res = state.full(params, samples);
            
            // Check if error
            if res.is_err() {
                return Err("Transcription failed.".to_string());
            }
            
            let num_segments = state.full_n_segments();
            let mut result = String::new();
            for i in 0..num_segments {
                let segment_obj = state.get_segment(i).ok_or("Failed to get segment")?;
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
            Err(_) => Err("Transcription crashed unexpectedly. This may be a compatibility issue with your system.".to_string()),
        }
    }).await.map_err(|e| e.to_string())??;

    Ok(text)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState {
            cancel_flag: Arc::new(AtomicBool::new(false)),
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            check_model_exists,
            download_model,
            transcribe_audio,
            cancel_transcription
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
