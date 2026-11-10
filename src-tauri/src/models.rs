//! Modellkatalog, sökvägar och nedladdning (Whisper och Pianissimo).

use std::fs;
use std::io::Write;
use std::path::PathBuf;
use futures_util::StreamExt;
use tauri::{AppHandle, Emitter, Manager};

use crate::types::*;
use crate::{diarization, pianissimo};

pub(crate) fn get_model_info(size: &str, quantized: bool, revision: &str) -> (String, String) {
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

pub(crate) fn get_model_path(app_handle: &AppHandle, size: &str, quantized: bool, revision: &str) -> Result<PathBuf, String> {
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
pub(crate) async fn download_pianissimo(app_handle: &AppHandle, dir: PathBuf) -> Result<String, String> {
    download_files(app_handle, dir, pianissimo::FILES, pianissimo::download_url).await
}

/// Ladda ned modellerna för talaridentifiering (en gång, ~33 MB).
pub(crate) async fn download_diarization(app_handle: &AppHandle) -> Result<String, String> {
    let dir = diarization_dir(app_handle)?;
    download_files(app_handle, dir, diarization::FILES, diarization::download_url).await
}

pub(crate) fn diarization_dir(app_handle: &AppHandle) -> Result<PathBuf, String> {
    let root = app_handle.path().app_data_dir().map_err(|e| e.to_string())?.join("models");
    Ok(diarization::model_dir(&root))
}

#[tauri::command]
pub(crate) fn check_diarization_models(app_handle: AppHandle) -> Result<bool, String> {
    Ok(diarization::is_ready(&diarization_dir(&app_handle)?))
}

#[tauri::command]
pub(crate) async fn download_diarization_models(app_handle: AppHandle) -> Result<String, String> {
    download_diarization(&app_handle).await
}

/// Flerfilsnedladdning med fast revision, SHA-256-kontroll och samlad progress.
async fn download_files(
    app_handle: &AppHandle,
    dir: PathBuf,
    files: &[(&str, &str, u64)],
    url_of: fn(&str) -> String,
) -> Result<String, String> {
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let total_expected: u64 = files.iter().map(|f| f.2).sum();
    let mut done_before: u64 = 0;
    let mut last_emit_mb = 0u64;

    for (name, sha, approx) in files {
        let target = dir.join(name);
        if target.exists() && pianissimo::file_hash(&target).map(|h| h == *sha).unwrap_or(false) {
            done_before += approx;
            continue;
        }
        let tmp = dir.join(format!("{name}.tmp"));
        let res = reqwest::get(url_of(name)).await.map_err(|e| format!(
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


#[tauri::command]
pub(crate) fn check_model_exists(app_handle: AppHandle, size: String, quantized: bool, revision: String) -> Result<bool, String> {
    let model_path = get_model_path(&app_handle, &size, quantized, &revision)?;
    if size == pianissimo::ENGINE_ID {
        return Ok(pianissimo::is_ready(&model_path));
    }
    Ok(model_path.exists())
}

#[tauri::command]
pub(crate) async fn download_model(app_handle: AppHandle, size: String, quantized: bool, revision: String) -> Result<String, String> {
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
pub(crate) async fn get_available_models(app_handle: AppHandle) -> Result<Vec<ModelInfo>, String> {
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
pub(crate) async fn delete_model(
    app_handle: AppHandle,
    state: tauri::State<'_, crate::AppState>,
    size: String,
    quantized: bool,
    revision: String,
) -> Result<(), String> {
    if let Ok(mut cache) = state.inner().engine_cache.lock() {
        *cache = None;
    }
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

