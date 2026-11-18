//! Kraschvakt och grafikkortsval.
//!
//! En inbyggd krasch (t.ex. i en grafikdrivrutin) dödar appen tyst, utan att Rust hinner
//! fånga något. Därför skrivs en markörfil innan transkriberingen börjar och tas bort när
//! den är klar (även vid fel och panik, via `Drop`). Finns markören kvar vid nästa start
//! dog förra körningen: gränssnittet visar en notis och stänger av GPU om den användes.

use crate::log_line;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

const MARKER: &str = "transcribe-run.json";

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RunMarker {
    /// Motorns id ("pianissimo", "medium" …).
    pub(crate) engine: String,
    /// Kördes Whisper på grafikkortet?
    pub(crate) gpu: bool,
    /// Unix-tid i sekunder när körningen startade.
    pub(crate) started: u64,
}

fn marker_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join(MARKER))
}

fn write_marker(path: &Path, marker: &RunMarker) {
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    match serde_json::to_vec(marker) {
        Ok(bytes) => {
            if let Err(e) = fs::write(path, bytes) {
                log_line(&format!("kraschvakt: kunde inte skriva markör: {e}"));
            }
        }
        Err(e) => log_line(&format!("kraschvakt: kunde inte serialisera markör: {e}")),
    }
}

/// Läser och tar bort markören. `None` om ingen fanns (förra körningen avslutades normalt).
fn take_marker(path: &Path) -> Option<RunMarker> {
    let bytes = fs::read(path).ok()?;
    let _ = fs::remove_file(path);
    // En trasig markör räknas ändå som en avbruten körning (okänd motor, utan GPU).
    Some(serde_json::from_slice(&bytes).unwrap_or(RunMarker { engine: String::new(), gpu: false, started: 0 }))
}

/// Håller markören så länge värdet lever. Tas bort i `Drop`, som körs vid normalt slut,
/// vid fel och vid fångad panik, men aldrig vid en inbyggd krasch.
pub(crate) struct RunGuard {
    path: Option<PathBuf>,
}

impl RunGuard {
    pub(crate) fn start(app: &AppHandle, engine: &str, gpu: bool) -> Self {
        let path = marker_path(app);
        if let Some(p) = &path {
            let started = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            write_marker(p, &RunMarker { engine: engine.to_string(), gpu, started });
        }
        Self { path }
    }
}

impl Drop for RunGuard {
    fn drop(&mut self) {
        if let Some(p) = &self.path {
            let _ = fs::remove_file(p);
        }
    }
}

/// Tar bort markören när appen stängs normalt mitt i en transkribering, så att det inte
/// tolkas som en krasch vid nästa start.
pub(crate) fn clear_on_exit(app: &AppHandle) {
    if let Some(p) = marker_path(app) {
        let _ = fs::remove_file(p);
    }
}

/// Anropas en gång vid start av gränssnittet. Returnerar förra körningens markör om den
/// dog oväntat.
#[tauri::command]
pub(crate) fn take_crash_marker(app: AppHandle) -> Option<RunMarker> {
    let marker = take_marker(&marker_path(&app)?)?;
    log_line(&format!(
        "kraschvakt: förra transkriberingen avslutades inte (motor={}, gpu={})",
        marker.engine, marker.gpu
    ));
    Some(marker)
}

// ── Grafikkort ──────────────────────────────────────────────────────────────

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GpuInfo {
    /// Namn på de fysiska grafikkorten (programvaruadaptrar räknas inte).
    pub(crate) adapters: Vec<String>,
    /// Bara Intel-grafik finns. Då är CPU säkrare som standard för Whisper.
    pub(crate) intel_only: bool,
}

const VENDOR_INTEL: u32 = 0x8086;
const VENDOR_MICROSOFT: u32 = 0x1414; // "Microsoft Basic Render Driver"

/// `adapters` = (tillverkar-id, namn, programvara?).
fn classify(adapters: &[(u32, String, bool)]) -> GpuInfo {
    let hw: Vec<&(u32, String, bool)> = adapters
        .iter()
        .filter(|(vendor, _, software)| !*software && *vendor != VENDOR_MICROSOFT)
        .collect();
    let intel_only = !hw.is_empty() && hw.iter().all(|(vendor, _, _)| *vendor == VENDOR_INTEL);
    GpuInfo { adapters: hw.iter().map(|(_, name, _)| name.clone()).collect(), intel_only }
}

#[cfg(windows)]
fn list_adapters() -> Vec<(u32, String, bool)> {
    use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIFactory1, DXGI_ADAPTER_FLAG_SOFTWARE};
    let mut out = Vec::new();
    // DXGI listar grafikkorten utan att starta Vulkan, så själva kontrollen kan inte
    // krascha i en trasig Vulkan-drivrutin.
    let Ok(factory) = (unsafe { CreateDXGIFactory1::<IDXGIFactory1>() }) else {
        return out;
    };
    let mut i = 0u32;
    while let Ok(adapter) = unsafe { factory.EnumAdapters1(i) } {
        if let Ok(desc) = unsafe { adapter.GetDesc1() } {
            let len = desc.Description.iter().position(|&c| c == 0).unwrap_or(desc.Description.len());
            let name = String::from_utf16_lossy(&desc.Description[..len]);
            let software = desc.Flags & (DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32) != 0;
            out.push((desc.VendorId, name, software));
        }
        i += 1;
    }
    out
}

#[cfg(not(windows))]
fn list_adapters() -> Vec<(u32, String, bool)> {
    Vec::new()
}

#[tauri::command]
pub(crate) fn get_gpu_info() -> GpuInfo {
    let info = classify(&list_adapters());
    log_line(&format!("grafikkort: {:?} (bara Intel: {})", info.adapters, info.intel_only));
    info
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("transkribera-crashguard-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d.join(MARKER)
    }

    #[test]
    fn ingen_markor_betyder_ingen_krasch() {
        assert_eq!(take_marker(&tmp("ingen")), None);
    }

    #[test]
    fn kvarlamnad_markor_lases_och_tas_bort() {
        let p = tmp("kvar");
        let m = RunMarker { engine: "medium".into(), gpu: true, started: 1 };
        write_marker(&p, &m);
        assert_eq!(take_marker(&p), Some(m));
        assert!(!p.exists());
        assert_eq!(take_marker(&p), None);
    }

    #[test]
    fn trasig_markor_raknas_som_avbruten_utan_gpu() {
        let p = tmp("trasig");
        fs::write(&p, b"{inte json").unwrap();
        let m = take_marker(&p).unwrap();
        assert!(!m.gpu);
    }

    #[test]
    fn guard_tar_bort_markoren_vid_drop() {
        let p = tmp("guard");
        write_marker(&p, &RunMarker { engine: "pianissimo".into(), gpu: false, started: 1 });
        drop(RunGuard { path: Some(p.clone()) });
        assert!(!p.exists());
    }

    #[test]
    fn bara_intel_kanns_igen() {
        let a = vec![(VENDOR_INTEL, "Intel(R) Iris(R) Xe Graphics".to_string(), false), (VENDOR_MICROSOFT, "Microsoft Basic Render Driver".to_string(), true)];
        let i = classify(&a);
        assert!(i.intel_only);
        assert_eq!(i.adapters, vec!["Intel(R) Iris(R) Xe Graphics".to_string()]);
    }

    #[test]
    fn intel_plus_nvidia_ar_inte_bara_intel() {
        let a = vec![(VENDOR_INTEL, "Intel UHD".to_string(), false), (0x10DE, "NVIDIA RTX".to_string(), false)];
        assert!(!classify(&a).intel_only);
    }

    #[test]
    fn amd_ar_inte_intel() {
        assert!(!classify(&[(0x1002, "AMD Radeon".to_string(), false)]).intel_only);
    }

    #[test]
    fn inga_kort_ar_inte_bara_intel() {
        assert!(!classify(&[]).intel_only);
    }
}
