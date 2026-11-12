//! Uppdatering av den portabla versionen: hittar en nyare "latest"-release på GitHub,
//! laddar ned `Transkribera-portable.exe`, kontrollerar minisign-signaturen och byter ut
//! den körande filen. Inget installeras utan att användaren klickar på Uppdatera.
//!
//! All nätverkstrafik sker här (webbvyns CSP tillåter inga externa anrop).

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

use crate::log_line;
use crate::types::ProgressPayload;

/// Publik minisign-nyckel (andra raden i `.pub`-filen). Den hemliga nyckeln ligger bara i
/// GitHub Secrets (`MINISIGN_KEY`). Tom nyckel = uppdatering avstängd (inget installeras).
pub(crate) const PUBLIC_KEY: &str = "RWTFStkVlPyjeRjruPSPaDUyBIoOBuO5VwSJPdoc6doB6Hx2Ki7HE0k9";

const LATEST_URL: &str = "https://api.github.com/repos/mrswedish/transcrptr/releases/latest";
const ASSET_NAME: &str = "Transkribera-portable.exe";
const SIG_NAME: &str = "Transkribera-portable.exe.minisig";
const CHECK_INTERVAL_SECS: u64 = 24 * 3600;

// ── Versioner ───────────────────────────────────────────────────────────────

/// `transcrptr-v2.3.1` / `v2.3.1` / `2.3.1` → (2, 3, 1). Förhandsversioner (`-beta`) ger None.
pub(crate) fn parse_version(tag: &str) -> Option<(u64, u64, u64)> {
    let t = tag.trim();
    let t = t.strip_prefix("transcrptr-").unwrap_or(t);
    let t = t.strip_prefix('v').unwrap_or(t);
    let mut it = t.split('.');
    let v = (
        it.next()?.parse().ok()?,
        it.next()?.parse().ok()?,
        it.next()?.parse().ok()?,
    );
    if it.next().is_some() {
        return None;
    }
    Some(v)
}

pub(crate) fn is_newer(remote_tag: &str, local: &str) -> bool {
    match (parse_version(remote_tag), parse_version(local)) {
        (Some(r), Some(l)) => r > l,
        _ => false,
    }
}

// ── Release-svar ────────────────────────────────────────────────────────────

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateInfo {
    pub(crate) version: String,
    pub(crate) size: u64,
    pub(crate) url: String,
    pub(crate) sig_url: String,
    pub(crate) page_url: String,
    /// Den här installationen kan byta ut sig själv (portabel och skrivbar mapp).
    pub(crate) can_install: bool,
}

/// Plockar ut en uppdatering ur GitHubs release-JSON. None om releasen inte är nyare,
/// är ett utkast/förhandsversion, eller om den portabla filen eller signaturen saknas
/// (kan hända medan bygget fortfarande laddar upp filer).
pub(crate) fn pick_update(release: &Value, current: &str, can_install: bool) -> Option<UpdateInfo> {
    if release["draft"].as_bool().unwrap_or(false) || release["prerelease"].as_bool().unwrap_or(false) {
        return None;
    }
    let tag = release["tag_name"].as_str()?;
    if !is_newer(tag, current) {
        return None;
    }
    let assets = release["assets"].as_array()?;
    let find = |name: &str| assets.iter().find(|a| a["name"].as_str() == Some(name));
    let exe = find(ASSET_NAME)?;
    let sig = find(SIG_NAME)?;
    let (v0, v1, v2) = parse_version(tag)?;
    Some(UpdateInfo {
        version: format!("{v0}.{v1}.{v2}"),
        size: exe["size"].as_u64()?,
        url: exe["browser_download_url"].as_str()?.to_string(),
        sig_url: sig["browser_download_url"].as_str()?.to_string(),
        page_url: release["html_url"].as_str().unwrap_or("https://github.com/mrswedish/transcrptr/releases/latest").to_string(),
        can_install,
    })
}

// ── Signatur ────────────────────────────────────────────────────────────────

/// Kontrollerar att `data` är signerad av nyckeln. Tom nyckel avvisar alltid.
pub(crate) fn verify_signature(public_key_b64: &str, data: &[u8], signature_text: &str) -> Result<(), String> {
    if public_key_b64.trim().is_empty() {
        return Err("Uppdateringar är inte aktiverade i den här versionen (ingen signeringsnyckel).".to_string());
    }
    let pk = minisign_verify::PublicKey::from_base64(public_key_b64.trim())
        .map_err(|e| format!("Ogiltig inbyggd nyckel: {e}"))?;
    let sig = minisign_verify::Signature::decode(signature_text)
        .map_err(|e| format!("Ogiltig signaturfil: {e}"))?;
    pk.verify(data, &sig, false)
        .map_err(|_| "Signaturen stämmer inte. Filen har inte kontrollerats som äkta och installeras inte.".to_string())
}

// ── Filbyte ─────────────────────────────────────────────────────────────────

fn old_path_of(exe: &Path) -> PathBuf {
    let stem = exe.file_stem().and_then(|s| s.to_str()).unwrap_or("Transkribera");
    exe.with_file_name(format!("{stem}.old.exe"))
}

/// Byter ut `exe` mot `new_file`. Den gamla filen döps om (en körande exe får döpas om på
/// Windows) och tas bort vid nästa start. Misslyckas bytet återställs originalet.
pub(crate) fn swap_executable(exe: &Path, new_file: &Path) -> Result<(), String> {
    let old = old_path_of(exe);
    let _ = fs::remove_file(&old);
    fs::rename(exe, &old).map_err(|e| format!("Kunde inte flytta undan den gamla filen: {e}"))?;
    if let Err(e) = fs::copy(new_file, exe) {
        let _ = fs::remove_file(exe);
        let _ = fs::rename(&old, exe);
        return Err(format!("Kunde inte lägga dit den nya filen: {e}"));
    }
    Ok(())
}

/// Tar bort `….old.exe` efter en lyckad uppdatering. Den gamla processen kan fortfarande
/// vara på väg att avslutas, så vi försöker några gånger i bakgrunden.
pub(crate) fn cleanup_old_executable() {
    let Ok(exe) = std::env::current_exe() else { return };
    let old = old_path_of(&exe);
    if !old.exists() {
        return;
    }
    std::thread::spawn(move || {
        for _ in 0..8 {
            if fs::remove_file(&old).is_ok() {
                log_line("updater: raderade den gamla filen efter uppdatering");
                return;
            }
            std::thread::sleep(Duration::from_secs(2));
        }
        log_line("updater: kunde inte radera den gamla filen (försöker igen vid nästa start)");
    });
}

/// Kan den här installationen byta ut sig själv? Portabel (ingen `uninstall.exe` bredvid)
/// och skrivbar mapp.
fn can_self_update() -> bool {
    if !cfg!(windows) || PUBLIC_KEY.is_empty() {
        return false;
    }
    let Ok(exe) = std::env::current_exe() else { return false };
    let Some(dir) = exe.parent() else { return false };
    if dir.join("uninstall.exe").exists() {
        return false;
    }
    let probe = dir.join(".transkribera-skrivtest");
    match fs::File::create(&probe) {
        Ok(_) => {
            let _ = fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

// ── Inställningar ───────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct UpdateSettings {
    pub(crate) auto_check: bool,
    pub(crate) last_check: u64,
}

impl Default for UpdateSettings {
    fn default() -> Self {
        Self { auto_check: true, last_check: 0 }
    }
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("updater.json"))
}

fn load_settings(app: &AppHandle) -> UpdateSettings {
    settings_path(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_settings(app: &AppHandle, s: &UpdateSettings) {
    if let Ok(p) = settings_path(app) {
        if let Ok(json) = serde_json::to_string_pretty(s) {
            let _ = fs::write(p, json);
        }
    }
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Dags för en automatisk kontroll? (påslaget och minst ett dygn sedan sist)
pub(crate) fn auto_check_due(s: &UpdateSettings, now: u64) -> bool {
    s.auto_check && now.saturating_sub(s.last_check) >= CHECK_INTERVAL_SECS
}

// ── Kommandon ───────────────────────────────────────────────────────────────

static PENDING: Mutex<Option<UpdateInfo>> = Mutex::new(None);

fn latest_url() -> String {
    #[cfg(debug_assertions)]
    if let Ok(u) = std::env::var("TRANSKRIBERA_UPDATE_URL") {
        return u;
    }
    LATEST_URL.to_string()
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent("Transkribera")
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn get_update_settings(app_handle: AppHandle) -> UpdateSettings {
    load_settings(&app_handle)
}

#[tauri::command]
pub(crate) fn set_update_auto_check(app_handle: AppHandle, enabled: bool) {
    let mut s = load_settings(&app_handle);
    s.auto_check = enabled;
    save_settings(&app_handle, &s);
}

/// Frågar GitHub efter senaste release. `manual = false` (vid start) respekterar
/// inställningen och högst en kontroll per dygn, och är tyst vid fel.
#[tauri::command]
pub(crate) async fn check_for_update(app_handle: AppHandle, manual: bool) -> Result<Option<UpdateInfo>, String> {
    let mut settings = load_settings(&app_handle);
    if !manual && !auto_check_due(&settings, now_secs()) {
        return Ok(None);
    }
    log_line(&format!("updater: söker efter uppdatering (manuell={manual})"));
    let res = async {
        let resp = client()?
            .get(latest_url())
            .header("Accept", "application/vnd.github+json")
            .send()
            .await
            .map_err(|e| format!("Ingen kontakt med GitHub. Kontrollera nätverket.\n\nTeknisk information: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("GitHub svarade med HTTP {}. Försök igen om en stund.", resp.status()));
        }
        let body = resp.bytes().await.map_err(|e| e.to_string())?;
        let json: Value = serde_json::from_slice(&body).map_err(|e| format!("Oväntat svar från GitHub: {e}"))?;
        Ok(pick_update(&json, env!("CARGO_PKG_VERSION"), can_self_update()))
    }
    .await;

    match &res {
        Ok(found) => {
            settings.last_check = now_secs();
            save_settings(&app_handle, &settings);
            match found {
                Some(u) => log_line(&format!("updater: ny version {} finns ({} byte)", u.version, u.size)),
                None => log_line("updater: ingen nyare version"),
            }
            *PENDING.lock().unwrap() = found.clone();
        }
        Err(e) => log_line(&format!("updater: kontrollen misslyckades: {e}")),
    }
    if manual { res } else { Ok(res.ok().flatten()) }
}

/// Laddar ned, kontrollerar och installerar den uppdatering som `check_for_update` hittade,
/// och startar sedan om appen.
#[tauri::command]
pub(crate) async fn install_update(app_handle: AppHandle) -> Result<(), String> {
    let info = PENDING.lock().unwrap().clone().ok_or("Ingen uppdatering att installera.")?;
    if !info.can_install {
        return Err("Den här installationen kan inte uppdatera sig själv.".to_string());
    }
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir = app_handle.path().app_data_dir().map_err(|e| e.to_string())?.join("update");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let new_file = dir.join("Transkribera-portable.new.exe");
    let _ = fs::remove_file(&new_file);

    log_line(&format!("updater: laddar ned {}", info.url));
    let http = client_for_download()?;
    let sig_text = http
        .get(&info.sig_url)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("Kunde inte hämta signaturen: {e}"))?
        .text()
        .await
        .map_err(|e| e.to_string())?;

    let resp = http
        .get(&info.url)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("Nedladdningen misslyckades: {e}"))?;
    let mut file = fs::File::create(&new_file).map_err(|e| e.to_string())?;
    let mut stream = resp.bytes_stream();
    let mut got: u64 = 0;
    let mut last_pct = -1i32;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Nedladdningen avbröts: {e}"))?;
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        got += chunk.len() as u64;
        let pct = (got as f32 / info.size.max(1) as f32 * 100.0) as i32;
        if pct != last_pct {
            last_pct = pct;
            let _ = app_handle.emit("update_progress", ProgressPayload { progress: pct as f32, downloaded: got, total: info.size });
        }
    }
    drop(file);

    let check = (|| -> Result<(), String> {
        if got != info.size {
            return Err(format!("Filen blev {got} byte men skulle vara {}. Försök igen.", info.size));
        }
        let data = fs::read(&new_file).map_err(|e| e.to_string())?;
        verify_signature(PUBLIC_KEY, &data, &sig_text)
    })();
    if let Err(e) = check {
        let _ = fs::remove_file(&new_file);
        log_line(&format!("updater: avvisade nedladdningen: {e}"));
        return Err(e);
    }
    log_line("updater: signaturen stämmer");

    swap_executable(&exe, &new_file)?;
    let _ = fs::remove_file(&new_file);
    log_line("updater: filen utbytt, startar om");
    std::process::Command::new(&exe)
        .spawn()
        .map_err(|e| format!("Uppdateringen är installerad men appen kunde inte startas om: {e}. Starta den manuellt."))?;
    app_handle.exit(0);
    Ok(())
}

fn client_for_download() -> Result<reqwest::Client, String> {
    // Ingen total timeout: 90 MB på en långsam anslutning får ta tid.
    reqwest::Client::builder()
        .user_agent("Transkribera")
        .connect_timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn release(tag: &str, prerelease: bool, assets: &[&str]) -> Value {
        json!({
            "tag_name": tag, "draft": false, "prerelease": prerelease,
            "html_url": "https://github.com/x/y/releases/tag/t",
            "assets": assets.iter().map(|n| json!({
                "name": n, "size": 1234, "browser_download_url": format!("https://example.test/{n}")
            })).collect::<Vec<_>>()
        })
    }

    #[test]
    fn versioner_tolkas_och_jamfors() {
        assert_eq!(parse_version("transcrptr-v2.3.1"), Some((2, 3, 1)));
        assert_eq!(parse_version("v2.10.0"), Some((2, 10, 0)));
        assert_eq!(parse_version("2.2.6"), Some((2, 2, 6)));
        assert_eq!(parse_version("2.3.0-beta"), None);
        assert_eq!(parse_version("2.3"), None);
        assert!(is_newer("transcrptr-v2.3.0", "2.2.6"));
        assert!(is_newer("transcrptr-v2.10.0", "2.9.9"), "numerisk, inte textjämförelse");
        assert!(!is_newer("transcrptr-v2.2.6", "2.2.6"));
        assert!(!is_newer("transcrptr-v2.2.5", "2.2.6"));
        assert!(!is_newer("skräp", "2.2.6"));
    }

    #[test]
    fn nyare_release_med_bada_filerna_ger_uppdatering() {
        let r = release("transcrptr-v2.3.0", false, &[ASSET_NAME, SIG_NAME, "Transkribera_x64-setup.exe"]);
        let u = pick_update(&r, "2.2.6", true).expect("uppdatering");
        assert_eq!(u.version, "2.3.0");
        assert_eq!(u.size, 1234);
        assert!(u.url.ends_with(ASSET_NAME) && u.sig_url.ends_with(SIG_NAME));
        assert!(u.can_install);
    }

    #[test]
    fn ingen_uppdatering_nar_nagot_saknas_eller_ar_fel_typ() {
        // Signaturen saknas (bygget laddar fortfarande upp) eller exe saknas.
        assert!(pick_update(&release("transcrptr-v2.3.0", false, &[ASSET_NAME]), "2.2.6", true).is_none());
        assert!(pick_update(&release("transcrptr-v2.3.0", false, &[SIG_NAME]), "2.2.6", true).is_none());
        // Förhandsversion och utkast räknas aldrig.
        assert!(pick_update(&release("transcrptr-v2.3.0", true, &[ASSET_NAME, SIG_NAME]), "2.2.6", true).is_none());
        let mut d = release("transcrptr-v2.3.0", false, &[ASSET_NAME, SIG_NAME]);
        d["draft"] = json!(true);
        assert!(pick_update(&d, "2.2.6", true).is_none());
        // Samma eller äldre version.
        assert!(pick_update(&release("transcrptr-v2.2.6", false, &[ASSET_NAME, SIG_NAME]), "2.2.6", true).is_none());
    }

    #[test]
    fn kontrolltakt() {
        let on = UpdateSettings { auto_check: true, last_check: 1_000 };
        assert!(!auto_check_due(&on, 1_000 + 3_600), "en timme sedan sist");
        assert!(auto_check_due(&on, 1_000 + CHECK_INTERVAL_SECS), "ett dygn sedan sist");
        assert!(auto_check_due(&UpdateSettings::default(), now_secs()), "aldrig kontrollerat");
        let off = UpdateSettings { auto_check: false, last_check: 0 };
        assert!(!auto_check_due(&off, now_secs()), "avstängd");
    }

    fn keypair() -> (String, minisign::SecretKey) {
        let kp = minisign::KeyPair::generate_unencrypted_keypair().unwrap();
        let text = kp.pk.to_box().unwrap().to_string();
        let b64 = text.lines().last().unwrap().trim().to_string();
        (b64, kp.sk)
    }

    fn sign(sk: &minisign::SecretKey, data: &[u8]) -> String {
        minisign::sign(None, sk, std::io::Cursor::new(data), Some("test"), Some("test"))
            .unwrap()
            .to_string()
    }

    #[test]
    fn signatur_giltig_andrad_fil_fel_nyckel_och_tom_nyckel() {
        let (pk, sk) = keypair();
        let data = b"Transkribera-portable.exe innehall".to_vec();
        let sig = sign(&sk, &data);
        assert!(verify_signature(&pk, &data, &sig).is_ok());

        let mut tampered = data.clone();
        tampered[0] ^= 1;
        assert!(verify_signature(&pk, &tampered, &sig).is_err(), "ändrad fil");

        let (other_pk, _) = keypair();
        assert!(verify_signature(&other_pk, &data, &sig).is_err(), "fel nyckel");

        assert!(verify_signature("", &data, &sig).is_err(), "tom nyckel installerar aldrig");
        assert!(verify_signature(&pk, &data, "skräp").is_err(), "trasig signaturfil");
    }

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("transkribera-upd-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn filbyte_lyckas_och_lamnar_gammal_fil() {
        let d = tmp("ok");
        let exe = d.join("Transkribera-portable.exe");
        let new = d.join("ny.exe");
        fs::write(&exe, b"gammal").unwrap();
        fs::write(&new, b"ny").unwrap();
        swap_executable(&exe, &new).unwrap();
        assert_eq!(fs::read(&exe).unwrap(), b"ny");
        assert_eq!(fs::read(d.join("Transkribera-portable.old.exe")).unwrap(), b"gammal");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn filbyte_aterstaller_originalet_vid_fel() {
        let d = tmp("fel");
        let exe = d.join("Transkribera-portable.exe");
        fs::write(&exe, b"gammal").unwrap();
        let saknas = d.join("finns-inte.exe");
        assert!(swap_executable(&exe, &saknas).is_err());
        assert_eq!(fs::read(&exe).unwrap(), b"gammal", "originalet ska vara orört");
        assert!(!d.join("Transkribera-portable.old.exe").exists());
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn gammal_fil_fran_tidigare_byte_skrivs_over() {
        let d = tmp("over");
        let exe = d.join("Transkribera-portable.exe");
        let new = d.join("ny.exe");
        fs::write(&exe, b"v2").unwrap();
        fs::write(&new, b"v3").unwrap();
        fs::write(d.join("Transkribera-portable.old.exe"), b"v1").unwrap();
        swap_executable(&exe, &new).unwrap();
        assert_eq!(fs::read(d.join("Transkribera-portable.old.exe")).unwrap(), b"v2");
        let _ = fs::remove_dir_all(&d);
    }
}
