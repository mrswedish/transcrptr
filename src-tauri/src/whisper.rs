//! Whisper-motorn (whisper.cpp via whisper-rs). Vulkan på Windows, Metal på macOS.

use crate::engine::Engine;
use crate::log_line;
use crate::types::{TokenInfo, TranscriptSegment};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::Arc;
use std::time::Duration;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

/// Rensar whisper-specialtokens som <|nospeech|> samt ersättningstecken.
pub(crate) fn clean_whisper_text(s: &str) -> String {
    let mut result = s.to_string();
    while let Some(start) = result.find("<|") {
        if let Some(rel_end) = result[start..].find("|>") {
            result.replace_range(start..start + rel_end + 2, "");
        } else {
            break;
        }
    }
    result.retain(|c| c != '\u{FFFD}');
    result.trim().to_string()
}

// Cap n_threads till ett säkert värde. Default = 4 (whisper.cpp:s original-default).
// På Intel-laptops med 20+ logiska kärnor kan whisper.cpp krascha; vi cap:ar vid 16.
fn thread_count(user_pref: Option<u32>) -> i32 {
    let detected = num_cpus::get() as u32;
    let chosen = user_pref.unwrap_or(4).clamp(1, detected.min(16));
    log_line(&format!(
        "thread_count: requested={user_pref:?}, detected_cpus={detected}, chosen={chosen}"
    ));
    chosen as i32
}

fn load_context(model_path: &Path, use_gpu: bool, gpu_device: Option<i32>) -> Result<WhisperContext, String> {
    let device = gpu_device.unwrap_or(0);
    log_line(&format!(
        "WhisperContext init: use_gpu={use_gpu}, gpu_device={device}, model={}",
        model_path.display()
    ));
    let mut params = WhisperContextParameters::default();
    params.use_gpu = use_gpu;
    params.gpu_device = device;
    match WhisperContext::new_with_params(model_path, params) {
        Ok(ctx) => {
            log_line(&format!("WhisperContext OK (gpu={use_gpu}, device={device})"));
            Ok(ctx)
        }
        Err(e) if use_gpu => {
            log_line(&format!("GPU-init misslyckades ({e}) — faller tillbaka till CPU"));
            let mut cpu = WhisperContextParameters::default();
            cpu.use_gpu = false;
            WhisperContext::new_with_params(model_path, cpu)
                .map_err(|e| format!("Kunde inte ladda modell (CPU-fallback): {e}"))
        }
        Err(e) => Err(format!("Kunde inte ladda modell: {e}")),
    }
}

pub(crate) struct WhisperEngine {
    ctx: WhisperContext,
    language: String,
    initial_prompt: Option<String>,
    n_threads: i32,
}

impl WhisperEngine {
    pub(crate) fn load(
        model_path: &Path,
        use_gpu: bool,
        gpu_device: Option<i32>,
        language: String,
        initial_prompt: Option<String>,
        thread_pref: Option<u32>,
    ) -> Result<Self, String> {
        // Modellen laddas EN gång och återanvänds över alla chunks.
        Ok(Self {
            ctx: load_context(model_path, use_gpu, gpu_device)?,
            language,
            initial_prompt,
            n_threads: thread_count(thread_pref),
        })
    }

    fn prompt(&self, prev_text: Option<&str>) -> String {
        let hint = match self.language.as_str() {
            "sv" => "Följande är en transkribering på svenska.",
            "en" => "The following is a transcription in English.",
            _ => "",
        };
        let mut composed = hint.to_string();
        for part in [prev_text, self.initial_prompt.as_deref()].into_iter().flatten() {
            let part = part.trim();
            if part.is_empty() { continue; }
            if !composed.is_empty() { composed.push(' '); }
            composed.push_str(part);
        }
        composed
    }
}

impl Engine for WhisperEngine {
    fn set_run_options(&mut self, language: &str, initial_prompt: Option<String>) {
        self.language = language.to_string();
        self.initial_prompt = initial_prompt;
    }

    fn transcribe_chunk(
        &mut self,
        samples: &[f32],
        offset_ms: i64,
        prev_text: Option<&str>,
        cancel: &AtomicBool,
        on_progress: &(dyn Fn(i32) + Sync),
    ) -> Result<Vec<TranscriptSegment>, String> {
        let composed = self.prompt(prev_text);
        let mut wstate = self.ctx.create_state().map_err(|e| format!("Kunde inte skapa state: {e}"))?;
        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        params.set_n_threads(self.n_threads);
        match self.language.as_str() {
            "sv" => params.set_language(Some("sv")),
            "en" => params.set_language(Some("en")),
            _ => params.set_language(None),
        }
        if !composed.is_empty() { params.set_initial_prompt(&composed); }
        params.set_print_progress(false);
        params.set_print_special(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);
        params.set_temperature(0.0);
        params.set_no_speech_thold(0.6);
        params.set_suppress_blank(true);
        params.set_split_on_word(true);

        // whisper.cpp anropar callbacken från sin egen tråd; vi skriver bara en atomär
        // och låter en vanlig tråd rapportera, så inget UI-arbete sker inne i C++.
        let progress = Arc::new(AtomicI32::new(0));
        let cb = Arc::clone(&progress);
        params.set_progress_callback_safe(move |p| cb.store(p, Ordering::Relaxed));

        let done = AtomicBool::new(false);
        let res = std::thread::scope(|sc| {
            sc.spawn(|| {
                let mut last = -1;
                while !done.load(Ordering::Relaxed) && !cancel.load(Ordering::Relaxed) {
                    let p = progress.load(Ordering::Relaxed);
                    if p != last { on_progress(p); last = p; }
                    if p >= 100 { break; }
                    std::thread::sleep(Duration::from_millis(100));
                }
            });
            let r = wstate.full(params, samples);
            done.store(true, Ordering::Relaxed);
            r
        });
        log_line("whisper: full() klar");
        res.map_err(|e| format!("Transkribering misslyckades: {e:?}"))?;

        let mut out = Vec::new();
        for i in 0..wstate.full_n_segments() {
            let seg = wstate.get_segment(i).ok_or("Segment saknas")?;
            let text = seg.to_str_lossy().map_err(|e| format!("Texthämtning: {e:?}"))?;
            let trimmed = clean_whisper_text(text.as_ref());
            if trimmed.is_empty() { continue; }
            // whisper.cpp ger centisekunder → ms
            let t0 = seg.start_timestamp() * 10 + offset_ms;
            let t1 = seg.end_timestamp() * 10 + offset_ms;
            let mut tokens = Vec::new();
            for t in 0..seg.n_tokens() {
                if let Some(tok) = seg.get_token(t) {
                    if let Ok(tt) = tok.to_str_lossy() {
                        let s = tt.into_owned();
                        if s.starts_with("[_") || s.starts_with("<|") { continue; }
                        tokens.push(TokenInfo { text: s, prob: tok.token_probability() });
                    }
                }
            }
            out.push(TranscriptSegment { start_ms: t0, end_ms: t1, text: trimmed, tokens, speaker_id: None });
        }
        log_line(&format!("whisper: {} segment lästa, frigör state", out.len()));
        drop(wstate);
        log_line("whisper: state frigjort");
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Manuellt test mot riktig modell:
    /// WHISPER_MODEL=<ggml-fil> TEST_WAV=<16 kHz wav> cargo test --release --lib -- --ignored --nocapture whisper_e2e
    #[test]
    #[ignore]
    fn whisper_e2e() {
        let model = std::env::var("WHISPER_MODEL").expect("WHISPER_MODEL");
        let wav = std::env::var("TEST_WAV").expect("TEST_WAV");
        let mut r = hound::WavReader::open(&wav).unwrap();
        let samples: Vec<f32> = r.samples::<i16>().map(|s| s.unwrap() as f32 / 32768.0).collect();
        let t0 = std::time::Instant::now();
        let mut e = WhisperEngine::load(Path::new(&model), true, None, "sv".into(), None, Some(4)).unwrap();
        let segs = e.transcribe_chunk(&samples, 0, None, &AtomicBool::new(false), &|p| eprintln!("progress {p}")).unwrap();
        for s in &segs { println!("[{:>7.2} - {:>7.2}] {}", s.start_ms as f64 / 1000.0, s.end_ms as f64 / 1000.0, s.text); }
        println!("{} s ljud på {:.1} s", samples.len() / 16000, t0.elapsed().as_secs_f64());
        assert!(!segs.is_empty());
    }
}
