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



/// Loggar panik (med plats) och, på Windows, ostädade systemundantag (t.ex. åtkomstfel i en
/// grafikdrivrutin) till loggfilen. Utan detta försvinner appen tyst vid en inbyggd krasch.
pub(crate) fn install_crash_logging() {
    std::panic::set_hook(Box::new(|info| {
        let place = info.location().map(|l| format!("{}:{}", l.file(), l.line())).unwrap_or_default();
        let msg = if let Some(s) = info.payload().downcast_ref::<&str>() { s.to_string() }
            else if let Some(s) = info.payload().downcast_ref::<String>() { s.clone() }
            else { "okänt".to_string() };
        log_line(&format!("PANIK: {msg} ({place})"));
    }));
    #[cfg(windows)]
    win_crash::install();
}

#[cfg(windows)]
mod win_crash {
    use super::log_line;

    #[repr(C)]
    struct ExceptionRecord {
        code: u32,
        flags: u32,
        record: *mut ExceptionRecord,
        address: *mut core::ffi::c_void,
        n_params: u32,
        info: [usize; 15],
    }
    #[repr(C)]
    struct ExceptionPointers {
        record: *mut ExceptionRecord,
        context: *mut core::ffi::c_void,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn SetUnhandledExceptionFilter(
            filter: Option<unsafe extern "system" fn(*const ExceptionPointers) -> i32>,
        ) -> *mut core::ffi::c_void;
        fn GetModuleHandleExW(flags: u32, addr: *const core::ffi::c_void, out: *mut *mut core::ffi::c_void) -> i32;
        fn GetModuleFileNameW(module: *mut core::ffi::c_void, buf: *mut u16, len: u32) -> u32;
    }

    unsafe extern "system" fn handler(p: *const ExceptionPointers) -> i32 {
        if !p.is_null() && !(*p).record.is_null() {
            let rec = &*(*p).record;
            let mut module = String::from("okänd modul");
            let mut h: *mut core::ffi::c_void = core::ptr::null_mut();
            // FROM_ADDRESS (4) | UNCHANGED_REFCOUNT (2)
            if GetModuleHandleExW(4 | 2, rec.address, &mut h) != 0 {
                let mut buf = [0u16; 260];
                let n = GetModuleFileNameW(h, buf.as_mut_ptr(), buf.len() as u32) as usize;
                if n > 0 { module = String::from_utf16_lossy(&buf[..n]); }
            }
            log_line(&format!(
                "KRASCH: undantag 0x{:08X} på adress {:p} i {}",
                rec.code, rec.address, module
            ));
        }
        0 // EXCEPTION_CONTINUE_SEARCH: Windows hanterar krashen som vanligt
    }

    pub(super) fn install() {
        unsafe { SetUnhandledExceptionFilter(Some(handler)); }
    }
}
