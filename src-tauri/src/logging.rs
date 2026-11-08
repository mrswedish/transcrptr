//! Diagnostisk fil-loggning.

use std::io::Write;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};


// ── Fil-loggning ─────────────────────────────────────────────────────────────
// Diagnostisk logg till app_local_data_dir/transcrptr.log. Behövs eftersom
// Windows-bundlat .exe inte har synlig stderr — vi kan inte felsöka utan en fil.
pub(crate) static LOG_PATH: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

pub(crate) fn init_logging(app_handle: &AppHandle) {
    if let Ok(dir) = app_handle.path().app_local_data_dir() {
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("transcrptr.log");
        let _ = LOG_PATH.set(path);
    }
}

// Global lås så parallella trådar (transcribe-poller + main-loop) inte interfererar
// med varandras writeln!-anrop. Append+writeln är inte atomärt på alla plattformar.
pub(crate) static LOG_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

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
pub(crate) fn get_log_path(app_handle: AppHandle) -> Result<String, String> {
    let dir = app_handle.path().app_local_data_dir()
        .map_err(|e| format!("Kunde inte hämta app_local_data_dir: {e}"))?;
    Ok(dir.join("transcrptr.log").to_string_lossy().into_owned())
}

/// JS skickar ett meddelande som skrivs till transcrptr.log. Används av JS för att
/// rapportera framgång/fel i UI-flödet (renderSegmentEditor osv.) så vi kan diagnostisera
/// krasch som händer EFTER att Rust-transkriberingen returnerat.
#[tauri::command]
pub(crate) fn log_message(msg: String) {
    log_line(&msg);
}

