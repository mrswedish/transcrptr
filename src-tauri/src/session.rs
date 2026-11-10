//! Sessionsmappar, inspelningsfiler, import/återställning och diskinfo.

use std::fs;
use std::path::PathBuf;
use serde::Serialize;
use sysinfo::Disks;
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

use crate::audio;
use crate::types::*;
use crate::{log_line, AppState};

/// Returnerar sökvägen till senaste recording.wav (om någon). Används av JS i WASAPI-flödet
/// där pendingRecording.filePath är null — då frågar JS Rust om sökvägen efter stop.
#[tauri::command]
pub(crate) fn get_recording_path(state: tauri::State<'_, AppState>) -> Result<String, String> {
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
pub(crate) fn sanitize_session_name(raw: &str) -> Option<String> {
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
pub(crate) fn rename_session(state: tauri::State<'_, AppState>, name: String) -> Result<String, String> {
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


#[tauri::command]
pub(crate) async fn save_audio_file(app_handle: AppHandle, state: tauri::State<'_, AppState>) -> Result<(), String> {
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

/// Vad som ska göras med en sessionsmapp för att få fram en spelbar `recording.wav`.
#[derive(Debug, PartialEq)]
enum SessionPlan {
    /// Färdig, redan mixad inspelning — öppna direkt.
    Ready(PathBuf),
    /// Råspår finns (avbruten inspelning): laga huvuden och mixa.
    Mix { mic: Option<PathBuf>, lb: Option<PathBuf>, comms: Option<PathBuf> },
}

fn non_empty_file(p: &std::path::Path) -> bool {
    p.is_file() && fs::metadata(p).map(|m| m.len() > 44).unwrap_or(false)
}

fn plan_session(dir: &std::path::Path) -> Result<SessionPlan, String> {
    let pick = |name: &str| {
        let p = dir.join(name);
        if non_empty_file(&p) { Some(p) } else { None }
    };
    let (mic, lb, comms) = (pick("mic.wav"), pick("lb_console.wav"), pick("lb_comms.wav"));
    let ready = pick("recording.wav");
    if mic.is_some() || lb.is_some() || comms.is_some() {
        // Råspår kvar = avbruten inspelning (en färdig fil kan vara ofullständig): mixa om.
        return Ok(SessionPlan::Mix { mic, lb, comms });
    }
    if let Some(r) = ready {
        // Normalfallet: råspåren raderades efter mixningen, bara recording.wav finns.
        return Ok(SessionPlan::Ready(r));
    }
    Err("Hittade ingen inspelning i mappen (varken recording.wav eller råspår).".to_string())
}

#[tauri::command]
pub(crate) async fn recover_session(
    state: tauri::State<'_, AppState>,
    session_dir: String,
) -> Result<String, String> {
    let dir = PathBuf::from(&session_dir);
    if !dir.is_dir() {
        return Err("Vald mapp existerar inte".to_string());
    }
    let recording = match plan_session(&dir)? {
        SessionPlan::Ready(path) => path,
        SessionPlan::Mix { mic, lb, comms } => {
            for p in [&mic, &lb, &comms].into_iter().flatten() {
                audio::repair_wav_header(p)?;
            }
            let recording = dir.join("recording.wav");
            audio::mix_session_to_wav(mic.as_deref(), lb.as_deref(), comms.as_deref(), &recording)?;
            recording
        }
    };
    // Sätt recording_path så save_audio_file kan användas direkt
    if let Ok(rec) = state.inner().audio_recorder.lock() {
        if let Ok(mut path) = rec.recording_path.lock() {
            *path = Some(recording.clone());
        }
    }
    Ok(recording.to_string_lossy().into_owned())
}

#[cfg(test)]
mod session_plan_tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("transkribera-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }
    fn touch(d: &std::path::Path, f: &str) {
        fs::write(d.join(f), vec![0u8; 100]).unwrap();
    }

    #[test]
    fn fardig_inspelning_oppnas_direkt() {
        let d = tmp("ready");
        touch(&d, "recording.wav");
        assert_eq!(plan_session(&d), Ok(SessionPlan::Ready(d.join("recording.wav"))));
    }

    #[test]
    fn avbruten_inspelning_mixas() {
        let d = tmp("raw");
        touch(&d, "mic.wav");
        touch(&d, "lb_console.wav");
        match plan_session(&d).unwrap() {
            SessionPlan::Mix { mic, lb, comms } => {
                assert!(mic.is_some() && lb.is_some() && comms.is_none());
            }
            other => panic!("väntade Mix, fick {other:?}"),
        }
    }

    #[test]
    fn rasparer_vinner_over_en_eventuellt_ofullstandig_fil() {
        let d = tmp("both");
        touch(&d, "recording.wav");
        touch(&d, "mic.wav");
        assert!(matches!(plan_session(&d), Ok(SessionPlan::Mix { .. })));
    }

    #[test]
    fn tom_mapp_ger_fel() {
        let d = tmp("empty");
        assert!(plan_session(&d).is_err());
    }
}

#[derive(Serialize)]
pub(crate) struct SessionDirInfo {
    is_session: bool,
    has_ready_recording: bool,
    recording_path: String,
}

/// Lättviktig kontroll om en mapp är en sessionsmapp (innehåller streamat material).
/// Används av "Välj fil/mapp" i UI:t för att avgöra om mappen ska köras via recover_session.
#[tauri::command]
pub(crate) async fn inspect_session_dir(dir: String) -> Result<SessionDirInfo, String> {
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
pub(crate) fn default_recording_dir(app_handle: &AppHandle) -> Result<PathBuf, String> {
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
pub(crate) async fn get_default_recording_dir(app_handle: AppHandle) -> Result<String, String> {
    let dir = default_recording_dir(&app_handle)?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Kunde inte skapa standardmapp: {e}"))?;
    Ok(dir.to_string_lossy().into_owned())
}

pub(crate) fn get_dir_size(path: &PathBuf) -> u64 {
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

pub(crate) fn is_session_folder(name: &str) -> bool {
    name.starts_with("inspelning-") || name.starts_with("recording-")
}

/// En tidigare inspelning i inspelningsmappen (för listan "Senaste inspelningar").
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecordingInfo {
    pub(crate) path: String,
    /// Namnet användaren gav inspelningen, annars tomt.
    pub(crate) label: String,
    /// Lokal tid, "2026-11-06T13:43:18" (läses av `new Date(...)` som lokal tid).
    pub(crate) started: String,
    /// recording.wav finns och kan öppnas direkt.
    pub(crate) has_ready: bool,
    /// Råspår finns men ingen färdig recording.wav — avbruten inspelning som kan återställas.
    pub(crate) recoverable: bool,
    pub(crate) size_bytes: u64,
}

fn non_empty(p: &std::path::Path) -> bool {
    p.is_file() && fs::metadata(p).map(|m| m.len() > 44).unwrap_or(false)
}

/// Tolkar `inspelning-20260906-134318[-namn]` → ("2026-09-06T13:43:18", "namn").
fn parse_session_name(name: &str) -> Option<(String, String)> {
    let rest = name.strip_prefix("inspelning-").or_else(|| name.strip_prefix("recording-"))?;
    let mut it = rest.splitn(3, '-');
    let (d, t) = (it.next()?, it.next()?);
    if d.len() != 8 || t.len() != 6 || !d.bytes().all(|b| b.is_ascii_digit()) || !t.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let iso = format!("{}-{}-{}T{}:{}:{}", &d[0..4], &d[4..6], &d[6..8], &t[0..2], &t[2..4], &t[4..6]);
    Some((iso, it.next().unwrap_or("").to_string()))
}

/// Listar tidigare inspelningar (nyast först, högst 30) i inspelningsmappen.
#[tauri::command]
pub(crate) async fn list_recordings(
    app_handle: AppHandle,
    recording_dir: Option<String>,
) -> Result<Vec<RecordingInfo>, String> {
    let base = match recording_dir.as_deref() {
        Some(p) if !p.is_empty() => PathBuf::from(p),
        _ => default_recording_dir(&app_handle)?,
    };
    let Ok(rd) = fs::read_dir(&base) else { return Ok(vec![]) };
    let mut out: Vec<RecordingInfo> = Vec::new();
    for entry in rd.flatten() {
        let p = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if !p.is_dir() || !is_session_folder(&name) {
            continue;
        }
        let has_ready = non_empty(&p.join("recording.wav"));
        let has_parts = ["mic.wav", "lb_console.wav", "lb_comms.wav"].iter().any(|f| non_empty(&p.join(f)));
        if !has_ready && !has_parts {
            continue;
        }
        let (started, label) = parse_session_name(&name).unwrap_or_else(|| {
            let t = entry.metadata().and_then(|m| m.modified()).ok()
                .map(|t| chrono::DateTime::<chrono::Local>::from(t).format("%Y-%m-%dT%H:%M:%S").to_string())
                .unwrap_or_default();
            (t, name.clone())
        });
        out.push(RecordingInfo {
            path: p.to_string_lossy().into_owned(),
            label,
            started,
            has_ready,
            recoverable: !has_ready && has_parts,
            size_bytes: get_dir_size(&p),
        });
    }
    out.sort_by(|a, b| b.started.cmp(&a.started));
    out.truncate(30);
    Ok(out)
}

#[cfg(test)]
mod recordings_tests {
    use super::parse_session_name;

    #[test]
    fn tolkar_mappnamn() {
        assert_eq!(
            parse_session_name("inspelning-20261106-134318"),
            Some(("2026-11-06T13:43:18".into(), "".into()))
        );
        assert_eq!(
            parse_session_name("inspelning-20260903-142233-ledningsgrupp-vecka-3"),
            Some(("2026-09-03T14:22:33".into(), "ledningsgrupp-vecka-3".into()))
        );
        assert_eq!(parse_session_name("annat"), None);
        assert_eq!(parse_session_name("inspelning-xx-yy"), None);
    }
}

#[derive(Serialize)]
pub(crate) struct RecordingsSummary {
    count: usize,
    total_bytes: u64,
}

/// Räknar sessionsmappar (inspelning-* / recording-*) i en mapp och deras totala storlek.
/// Används av settings (diskanvändning) och som förhandsbesked före radering.
#[tauri::command]
pub(crate) async fn count_recordings(dir: String) -> Result<RecordingsSummary, String> {
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
pub(crate) async fn delete_all_recordings(dir: String) -> Result<usize, String> {
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
pub(crate) async fn get_disk_info(app_handle: AppHandle) -> Result<DiskInfo, String> {
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

