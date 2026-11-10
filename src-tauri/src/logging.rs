//! Diagnostisk fil-loggning med veckovis rotation.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Manager};

/// Max ålder (7 dygn) och max storlek (2 MB) innan `transcrptr.log` roteras till `transcrptr.old.log`.
const MAX_LOG_AGE: Duration = Duration::from_secs(7 * 24 * 3600);
const MAX_LOG_BYTES: u64 = 2 * 1024 * 1024;

// ── Fil-loggning ─────────────────────────────────────────────────────────────
// Diagnostisk logg till app_local_data_dir/transcrptr.log. Behövs eftersom
// Windows-bundlat .exe inte har synlig stderr — vi kan inte felsöka utan en fil.
pub(crate) static LOG_PATH: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

pub(crate) fn should_rotate(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if meta.len() == 0 {
        return false;
    }
    if meta.len() >= MAX_LOG_BYTES {
        return true;
    }
    // Använd skapelsetid (finns på Windows och macOS), annars ändringstid.
    let timestamp = meta.created().or_else(|_| meta.modified());
    if let Ok(ts) = timestamp {
        if let Ok(age) = ts.elapsed() {
            if age >= MAX_LOG_AGE {
                return true;
            }
        }
    }
    false
}

pub(crate) fn rotate_if_needed(path: &Path) {
    if should_rotate(path) {
        let old_path = path.with_file_name("transcrptr.old.log");
        let _ = std::fs::rename(path, old_path);
    }
}

pub(crate) fn init_logging(app_handle: &AppHandle) {
    if let Ok(dir) = app_handle.path().app_local_data_dir() {
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("transcrptr.log");
        rotate_if_needed(&path);
        let _ = LOG_PATH.set(path);
    }
}

/// Raderar loggfilerna (används vid nollställning av applikationen).
pub(crate) fn clear_logs(app_handle: &AppHandle) {
    let _guard = LOG_LOCK.lock();
    if let Ok(dir) = app_handle.path().app_local_data_dir() {
        let _ = std::fs::remove_file(dir.join("transcrptr.log"));
        let _ = std::fs::remove_file(dir.join("transcrptr.old.log"));
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roterar_stor_loggfil() {
        let dir = std::env::temp_dir().join(format!("transkribera-log-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let log = dir.join("transcrptr.log");
        let old = dir.join("transcrptr.old.log");

        // Liten ny fil roteras inte
        std::fs::write(&log, b"hej\n").unwrap();
        rotate_if_needed(&log);
        assert!(log.exists() && !old.exists());

        // Fil över MAX_LOG_BYTES roteras till .old.log
        std::fs::write(&log, vec![b'x'; (MAX_LOG_BYTES + 10) as usize]).unwrap();
        rotate_if_needed(&log);
        assert!(!log.exists() && old.exists());

        let _ = std::fs::remove_dir_all(&dir);
    }
}

