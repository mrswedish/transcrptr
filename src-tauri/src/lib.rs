// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use std::path::PathBuf;
use std::fs;
use tauri::{AppHandle, Manager, Emitter};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri_plugin_dialog::DialogExt;

mod audio;
mod decode;
mod diarization;
mod engine;
mod logging;
mod models;
mod pianissimo;
mod session;
mod types;
mod vocabulary;
mod whisper;
use decode::StreamingDecoder;
use types::*;
pub(crate) use logging::log_line;
use models::get_model_path;
use session::default_recording_dir;
#[cfg(target_os = "windows")]
mod application_loopback;
use audio::AudioRecorder;

#[derive(PartialEq, Eq, Clone)]
pub(crate) struct EngineKey {
    pub(crate) model_path: PathBuf,
    pub(crate) use_gpu: bool,
    pub(crate) gpu_device: Option<i32>,
    pub(crate) thread_count: Option<u32>,
}

pub(crate) struct CachedEngine {
    pub(crate) key: EngineKey,
    pub(crate) engine: Box<dyn engine::Engine>,
}

pub struct AppState {
    pub cancel_flag: Arc<AtomicBool>,
    pub audio_recorder: Mutex<AudioRecorder>,
    pub(crate) engine_cache: Arc<Mutex<Option<CachedEngine>>>,
}

#[tauri::command]
fn cancel_transcription(state: tauri::State<AppState>) {
    state.inner().cancel_flag.store(true, Ordering::Relaxed);
}

#[tauri::command]
fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Utökar asset-protokollets scope vid runtime till EXAKT en fil, så att <audio>
/// kan streama just den filen via convertFileSrc. Asset-scopen i tauri.conf.json är tom
/// (`[]`) — vi tillåter aldrig hela filsystemet. JS anropar detta precis innan spelaren
/// sätts upp, med den faktiska recording.wav/importfilens path. Bara läsåtkomst, bara
/// den fil användaren redan valt; ingen annan path blir åtkomlig.
#[tauri::command]
fn allow_asset_path(app_handle: AppHandle, path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.is_file() {
        return Err(format!("Filen finns inte: {path}"));
    }
    app_handle.asset_protocol_scope()
        .allow_file(&p)
        .map_err(|e| format!("Kunde inte tillåta fil för uppspelning: {e}"))?;
    Ok(())
}

/// JS streamar mic-PCM hit under inspelning (Windows-WASAPI). Eliminerar
/// JS-side mic-blob-allokation som tidigare gjorde 1 GB Float32-arrays vid stop
/// av lång inspelning → OOM-krasch på WebView2.
/// Rå binär payload: f32 little-endian PCM i body, samplingsfrekvens i headern
/// `x-sample-rate`. (Tidigare skickades `Vec<f32>` som JSON-array av tal.)
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn parse_mic_payload(request: &tauri::ipc::Request<'_>) -> Result<(Vec<f32>, u32), String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("append_mic_chunk förväntar rå binär data".to_string());
    };
    let sample_rate: u32 = request
        .headers()
        .get("x-sample-rate")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok())
        .ok_or("Saknar giltig x-sample-rate")?;
    let samples = bytes
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .collect();
    Ok((samples, sample_rate))
}

#[cfg(target_os = "windows")]
#[tauri::command]
async fn append_mic_chunk(
    state: tauri::State<'_, AppState>,
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    let (samples, sample_rate) = parse_mic_payload(&request)?;
    let recorder = state.inner().audio_recorder.lock()
        .map_err(|e| format!("Recorder-lås: {e}"))?;
    recorder.append_mic_pcm(&samples, sample_rate)
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
async fn append_mic_chunk(_request: tauri::ipc::Request<'_>) -> Result<(), String> {
    // Mac pausat: ingen mikrofoninspelning via webbläsaren.
    Ok(())
}

#[tauri::command]
async fn transcribe_file(
    app_handle: AppHandle,
    state: tauri::State<'_, AppState>,
    file_path: String,
    size: String,
    quantized: bool,
    revision: String,
    language: String,
    use_gpu: Option<bool>,
    thread_count: Option<u32>,
    gpu_device: Option<i32>,
    identify_speakers: Option<bool>,
) -> Result<Vec<TranscriptSegment>, String> {
    state.inner().cancel_flag.store(false, Ordering::Relaxed);
    let model_path = get_model_path(&app_handle, &size, quantized, &revision)?;
    if !model_path.exists() {
        return Err("Modell saknas. Ladda ned den först.".to_string());
    }
    let cancel = Arc::clone(&state.inner().cancel_flag);
    let engine_cache = Arc::clone(&state.inner().engine_cache);
    let app = app_handle.clone();
    // Personliga ordlistor: ledtråd till Whisper och efterkorrigering för alla motorer.
    let vocab_entries = vocabulary::active_entries(&vocabulary::load_store(&app_handle).unwrap_or_default());
    let initial_prompt = vocabulary::whisper_prompt(&vocab_entries);
    // Talaridentifiering är valfri och körs bara om modellerna redan är nedladdade.
    let diar_dir = if identify_speakers.unwrap_or(false) {
        let d = models::diarization_dir(&app_handle)?;
        if !diarization::is_ready(&d) {
            return Err("Talarmodellerna saknas. Ladda ned dem först.".to_string());
        }
        Some(d)
    } else {
        None
    };

    // Allt i en enda spawn_blocking: avkodaren hålls öppen hela vägen, ett chunk
    // avkodas, transkriberas och kastas bort innan nästa börjar (eller samlas upp om
    // talaridentifiering är påslagen, så filen aldrig avkodas två gånger).
    let segments = tokio::task::spawn_blocking(move || -> Result<Vec<TranscriptSegment>, String> {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| -> Result<Vec<TranscriptSegment>, String> {
            // Öppna filen först så att ett läsfel visas innan den långsamma modellen laddas.
            let mut dec = StreamingDecoder::open(&file_path)?;
            let use_gpu_val = use_gpu.unwrap_or(true);
            let key = EngineKey {
                model_path: model_path.clone(),
                use_gpu: use_gpu_val,
                gpu_device,
                thread_count,
            };

            let mut engine: Box<dyn engine::Engine> = {
                let mut guard = engine_cache.lock().ok();
                let cached = guard.as_mut().and_then(|opt| opt.take());
                match cached {
                    Some(mut c) if c.key == key => {
                        log_line("transcribe_file: återanvänder varm modell från cache");
                        c.engine.set_run_options(&language, initial_prompt);
                        c.engine
                    }
                    _ => {
                        if size == pianissimo::ENGINE_ID {
                            Box::new(
                                pianissimo::Pianissimo::load(&model_path, pianissimo::default_threads())
                                    .map_err(|e| format!("Kunde inte starta Pianissimo: {e}"))?,
                            )
                        } else {
                            Box::new(whisper::WhisperEngine::load(
                                &model_path,
                                use_gpu_val,
                                gpu_device,
                                language,
                                initial_prompt,
                                thread_count,
                            )?)
                        }
                    }
                }
            };

            let emit = |p: i32| {
                let _ = app.emit("transcription_progress", TranscriptionProgressPayload { progress: p });
            };
            emit(0);
            let collect_samples = diar_dir.is_some();
            let (mut segs, diar_samples) = engine::run_file(engine.as_mut(), &mut dec, collect_samples, &cancel, &emit)?;
            drop(dec);

            if diar_dir.is_some() {
                // Frigör modellen före talaridentifiering så att diariseringen får maximalt RAM.
                drop(engine);
            } else if let Ok(mut guard) = engine_cache.lock() {
                *guard = Some(CachedEngine { key, engine });
            }

            if !vocab_entries.is_empty() {
                let mut changes: Vec<vocabulary::Change> = Vec::new();
                for seg in segs.iter_mut() {
                    let (text, c) = vocabulary::correct_text(&seg.text, &vocab_entries);
                    if !c.is_empty() {
                        seg.text = text;
                        seg.tokens.clear(); // ordnivå-konfidensen stämmer inte längre
                        changes.extend(c);
                    }
                }
                log_line(&format!("ordlista: {} ord rättades", changes.len()));
                let _ = app.emit("vocabulary_applied", changes);
            }

            if let Some(dir) = diar_dir {
                if !cancel.load(Ordering::Relaxed) && !segs.is_empty() {
                    let phase = |phase: &'static str, speakers: i32, message: Option<String>| {
                        let _ = app.emit("diarization_phase", DiarizationPhasePayload { phase, speakers, percent: 0, eta_seconds: 0, message });
                    };
                    let on_progress = |percent: i32, eta_seconds: i64| {
                        let _ = app.emit("diarization_phase", DiarizationPhasePayload { phase: "progress", speakers: 0, percent, eta_seconds, message: None });
                    };
                    phase("start", 0, None);
                    log_line("diarization: startar (återanvänder redan avkodat ljud)");
                    let started = std::time::Instant::now();
                    match diarization::identify_from_samples(&dir, diar_samples, &mut segs, &cancel, &on_progress) {
                        Ok(n) => {
                            log_line(&format!("diarization: {n} talare på {:.1} s", started.elapsed().as_secs_f64()));
                            phase("done", n, None);
                        }
                        Err(e) if e == diarization::CANCELLED => {
                            // Användaren avbröt: transkriptet behålls, utan talare.
                            log_line(&format!("diarization: avbruten efter {:.1} s", started.elapsed().as_secs_f64()));
                            phase("cancelled", 0, None);
                        }
                        Err(e) => {
                            // Transkriptet är intakt; bara talarna saknas.
                            log_line(&format!("diarization: misslyckades efter {:.1} s: {e}", started.elapsed().as_secs_f64()));
                            phase("failed", 0, Some(e));
                        }
                    }
                }
            }

            // Autospara transkriptet direkt i sessionsmappen om ljudfilen tillhör en inspelning.
            if !segs.is_empty() {
                if let Err(e) = session::write_session_transcript_for_audio(
                    std::path::Path::new(&file_path),
                    &segs,
                    &std::collections::HashMap::new(),
                ) {
                    log_line(&format!("transcribe_file: kunde inte autospara transcript.json: {e}"));
                }
            }
            Ok(segs)
        }))
        .unwrap_or_else(|p| Err(format!("Transkriberingen kraschade: {}.", engine::panic_msg(p))))
    })
    .await
    .map_err(|e| format!("Task-fel: {e}"))??;

    let _ = app_handle.emit("transcription_progress", TranscriptionProgressPayload { progress: 100 });
    Ok(segments)
}

#[derive(Serialize)]
struct RecordingStartResult {
    loopback_active: bool,
}

#[tauri::command]
async fn start_backend_recording(
    app_handle: AppHandle,
    state: tauri::State<'_, AppState>,
    loopback_only: bool,
    with_loopback: bool,
    recording_dir: Option<String>,
) -> Result<RecordingStartResult, String> {
    log_line(&format!("start_backend_recording: loopback_only={loopback_only}, with_loopback={with_loopback}, recording_dir={recording_dir:?}"));

    // v1.4.7: ANV\u{00c4}NDARENS valda recording_dir är streaming-mapp DIREKT — ingen kopia.
    // V1.4.3 flödade alltid via lokal "tempfile-mapp" + kopia vid stop, men på GP-redirected
    // Documents-mappar (UNC-nätverk) blev "lokal"-mappen i själva verket nätverksdisk.
    // Användaren ansvarar nu själv för att välja en lokal path; default = .exe-mappen.
    let base_dir = match recording_dir.as_deref() {
        Some(p) if !p.is_empty() => PathBuf::from(p),
        _ => default_recording_dir(&app_handle)?,
    };
    std::fs::create_dir_all(&base_dir)
        .map_err(|e| format!("Kunde inte skapa inspelningsmapp {}: {e}", base_dir.display()))?;
    log_line(&format!("start_backend_recording: streaming-mapp = {}", base_dir.display()));

    let mut recorder = state.inner().audio_recorder.lock().unwrap();
    let result = recorder.start_recording(loopback_only, with_loopback, &base_dir);
    match &result {
        Ok(_) => log_line(&format!("start_backend_recording: OK (loopback_active={})", recorder.loopback_active)),
        Err(e) => log_line(&format!("start_backend_recording: FAIL {e}")),
    }
    result?;
    Ok(RecordingStartResult { loopback_active: recorder.loopback_active })
}

#[tauri::command]
async fn stop_backend_recording(state: tauri::State<'_, AppState>) -> Result<(), String> {
    log_line("stop_backend_recording: anrop fr\u{00e5}n JS");
    let mut recorder = state.inner().audio_recorder.lock().unwrap();
    log_line("stop_backend_recording: recorder-l\u{00e5}s taget, anropar stop_recording");
    let result = recorder.stop_recording();
    match &result {
        Ok(_) => {
            let path = recorder.recording_path.lock().ok()
                .and_then(|g| g.clone())
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_else(|| "<saknas>".to_string());
            log_line(&format!("stop_backend_recording: OK, recording_path = {path}"));
        }
        Err(e) => log_line(&format!("stop_backend_recording: FAIL {e}")),
    }
    result
}

fn format_srt_timestamp(ms: i64, sep: char) -> String {
    let total_ms = ms.max(0);
    let h = total_ms / 3_600_000;
    let m = (total_ms % 3_600_000) / 60_000;
    let s = (total_ms % 60_000) / 1_000;
    let millis = total_ms % 1_000;
    format!("{h:02}:{m:02}:{s:02}{sep}{millis:03}")
}

fn format_short_timestamp(ms: i64) -> String {
    let total_sec = (ms.max(0)) / 1_000;
    let h = total_sec / 3_600;
    let m = (total_sec % 3_600) / 60;
    let s = total_sec % 60;
    if h > 0 {
        format!("{h}:{m:02}:{s:02}")
    } else {
        format!("{m:02}:{s:02}")
    }
}

fn speaker_name(id: i32, names: &std::collections::HashMap<i32, String>) -> String {
    names
        .get(&id)
        .filter(|s| !s.trim().is_empty())
        .cloned()
        .unwrap_or_else(|| format!("Talare {id}"))
}

pub(crate) fn format_export_by_ext(
    ext: &str,
    plain_content: &str,
    segments: &[TranscriptSegment],
    speaker_names: &std::collections::HashMap<i32, String>,
) -> String {
    if segments.is_empty() {
        return plain_content.to_string();
    }
    match ext {
        "srt" => {
            let mut out = String::new();
            for (i, seg) in segments.iter().enumerate() {
                let start = format_srt_timestamp(seg.start_ms, ',');
                let end = format_srt_timestamp(seg.end_ms.max(seg.start_ms + 500), ',');
                let prefix = seg
                    .speaker_id
                    .map(|id| format!("[{}] ", speaker_name(id, speaker_names)))
                    .unwrap_or_default();
                out.push_str(&format!("{}\n{} --> {}\n{}{}\n\n", i + 1, start, end, prefix, seg.text.trim()));
            }
            out
        }
        "vtt" => {
            let mut out = String::from("WEBVTT\n\n");
            for seg in segments {
                let start = format_srt_timestamp(seg.start_ms, '.');
                let end = format_srt_timestamp(seg.end_ms.max(seg.start_ms + 500), '.');
                let prefix = seg
                    .speaker_id
                    .map(|id| format!("<v {}>", speaker_name(id, speaker_names)))
                    .unwrap_or_default();
                out.push_str(&format!("{} --> {}\n{}{}\n\n", start, end, prefix, seg.text.trim()));
            }
            out
        }
        "md" => {
            let mut out = String::from("# Transkribering\n\n");
            let mut prev_spk = None;
            for seg in segments {
                if seg.speaker_id.is_some() && seg.speaker_id != prev_spk {
                    let spk = speaker_name(seg.speaker_id.unwrap(), speaker_names);
                    out.push_str(&format!("\n### {spk}\n\n"));
                    prev_spk = seg.speaker_id;
                }
                let ts = format_short_timestamp(seg.start_ms);
                out.push_str(&format!("- **`[{ts}]`** {}\n", seg.text.trim()));
            }
            out
        }
        _ => plain_content.to_string(),
    }
}

#[tauri::command]
async fn save_text_file(
    app_handle: AppHandle,
    content: String,
    segments: Option<Vec<TranscriptSegment>>,
    speaker_names: Option<std::collections::HashMap<i32, String>>,
) -> Result<(), String> {
    use tauri_plugin_dialog::FilePath;

    let mut dialog = app_handle.dialog()
        .file()
        .set_title("Spara transkribering")
        .set_file_name("transkribering.txt")
        .add_filter("Textfil (.txt)", &["txt"]);

    let has_segments = segments.as_ref().map(|s| !s.is_empty()).unwrap_or(false);
    if has_segments {
        dialog = dialog
            .add_filter("Markdown med tidsstämplar (.md)", &["md"])
            .add_filter("Undertexter SubRip (.srt)", &["srt"])
            .add_filter("Webb-undertexter WebVTT (.vtt)", &["vtt"]);
    }

    let file_path = dialog.blocking_save_file();

    match file_path {
        Some(path) => {
            let path_buf = match path {
                FilePath::Path(p) => p,
                _ => return Err("Ogiltigt filformat".to_string()),
            };
            let ext = path_buf
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("txt")
                .to_ascii_lowercase();
            let segs = segments.unwrap_or_default();
            let names = speaker_names.unwrap_or_default();
            let formatted = format_export_by_ext(&ext, &content, &segs, &names);
            fs::write(&path_buf, formatted).map_err(|e| format!("Kunde inte spara: {}", e))?;
            Ok(())
        },
        None => Err("cancelled".to_string()),
    }
}

#[tauri::command]
async fn pick_audio_file(app_handle: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::FilePath;
    let path = app_handle.dialog()
        .file()
        .add_filter("Ljud/Video", &["mp3","m4a","aac","wav","ogg","flac","mp4","webm","mkv"])
        .blocking_pick_file();
    match path {
        Some(FilePath::Path(p)) => Ok(Some(p.to_string_lossy().to_string())),
        _ => Ok(None),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState {
            cancel_flag: Arc::new(AtomicBool::new(false)),
            audio_recorder: Mutex::new(AudioRecorder::new()),
            engine_cache: Arc::new(Mutex::new(None)),
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            logging::init_logging(&app.handle());
            log_line(&format!("=== app start v{} ===", env!("CARGO_PKG_VERSION")));
            log_line(&format!("num_cpus::get() = {}", num_cpus::get()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            models::check_model_exists,
            models::download_model,
            models::get_available_models,
            models::delete_model,
            models::check_diarization_models,
            vocabulary::vocab_load,
            vocabulary::vocab_save,
            vocabulary::vocab_dir,
            vocabulary::vocab_add_entry,
            vocabulary::apply_vocabulary,
            models::download_diarization_models,
            session::get_disk_info,
            start_backend_recording,
            stop_backend_recording,
            transcribe_file,
            cancel_transcription,
            get_app_version,
            session::get_default_recording_dir,
            session::recover_session,
            session::count_recordings,
            session::list_recordings,
            session::delete_all_recordings,
            session::reset_application,
            session::save_session_transcript,
            session::load_session_transcript,
            save_text_file,
            session::save_audio_file,
            pick_audio_file,
            logging::get_log_path,
            logging::log_message,
            append_mic_chunk,
            session::get_recording_path,
            session::rename_session,
            allow_asset_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod export_tests {
    use super::*;

    #[test]
    fn formaterar_srt_och_md_med_talare() {
        let segs = vec![
            TranscriptSegment {
                start_ms: 1200,
                end_ms: 3500,
                text: "Hej och välkomna.".into(),
                tokens: vec![],
                speaker_id: Some(1),
            },
            TranscriptSegment {
                start_ms: 4000,
                end_ms: 6000,
                text: "Tack så mycket.".into(),
                tokens: vec![],
                speaker_id: Some(2),
            },
        ];
        let mut names = std::collections::HashMap::new();
        names.insert(1, "Anna".to_string());

        let srt = format_export_by_ext("srt", "råtext", &segs, &names);
        assert!(srt.contains("1\n00:00:01,200 --> 00:00:03,500\n[Anna] Hej och välkomna."));
        assert!(srt.contains("2\n00:00:04,000 --> 00:00:06,000\n[Talare 2] Tack så mycket."));

        let md = format_export_by_ext("md", "råtext", &segs, &names);
        assert!(md.contains("### Anna"));
        assert!(md.contains("- **`[00:01]`** Hej och välkomna."));
        assert!(md.contains("### Talare 2"));
    }
}
