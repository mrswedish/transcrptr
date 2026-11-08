//! Pianissimo (Klang AI) – svensk taligenkänning via ONNX Runtime (endast CPU).
//!
//! Modellen är en finjustering av NVIDIA Parakeet TDT 0.6B (FastConformer-encoder,
//! TDT-avkodare) och distribueras som ONNX (`KlangAI/pianissimo-sv-onnx`, CC BY 4.0).
//! Förbehandling, avkodning och chunkning följer den MIT-licensierade referens-
//! implementationen i Avskrift (github.com/Pluggentipsar/avskrift, crates/pianissimo).

use anyhow::{bail, ensure, Context, Result};
use ort::session::Session;
use ort::value::Tensor;
use regex::Regex;
use rustfft::{num_complex::Complex, FftPlanner};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

/// Modell-ID som frontend skickar som `size`.
pub const ENGINE_ID: &str = "pianissimo";
pub const MODEL_DIR: &str = "pianissimo-sv-int8";
pub const REPO: &str = "KlangAI/pianissimo-sv-onnx";
/// Fast revision så att nedladdade filer alltid matchar kontrollsummorna.
pub const REVISION: &str = "63730c6021234f26b9bbae9a07a04fec39e7a52e";
/// (filnamn, sha256, ungefärlig storlek i byte)
pub const FILES: &[(&str, &str, u64)] = &[
    (
        "encoder-model.int8.onnx",
        "13288a5f4f009bf6bf8a3260044d098f6922e8caf1c564521d4962fa5749f66c",
        620_000_000,
    ),
    (
        "decoder_joint-model.int8.onnx",
        "0f9213242acd8874f2717c5e3cdb888d4e7673ddf3abb9ee3a2fd2eaf0acdd03",
        40_000_000,
    ),
    (
        "vocab.txt",
        "d58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d",
        150_000,
    ),
    (
        "config.json",
        "f19eee59d2ba995f6d5cdb164e30dd64d2a8b7ed0ce9f2198ab68a5467445694",
        1_000,
    ),
];

const BLANK: usize = 8192;
const RATE: usize = 16_000;
const HOP: usize = 160;
const MAX_PASS: usize = 120 * RATE;
const CORE: usize = 110 * RATE;
const CONTEXT: usize = 5 * RATE;
/// En encoder-frame = 10 ms * subsampling 8
const FRAME_SECS: f64 = 0.08;

pub fn download_url(file: &str) -> String {
    format!("https://huggingface.co/{REPO}/resolve/{REVISION}/{file}")
}

pub fn file_hash(path: &Path) -> Result<String> {
    use std::io::Read;
    let mut f = std::fs::File::open(path)?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// Snabb kontroll (finns alla filer?). Full hash-kontroll görs vid nedladdning.
pub fn is_ready(dir: &Path) -> bool {
    FILES.iter().all(|(name, _, _)| dir.join(name).is_file())
}

#[derive(Debug, Clone)]
pub struct PSegment {
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
}

struct Transcript {
    tokens: Vec<String>,
    stamps: Vec<f64>,
}

pub struct Pianissimo {
    encoder: Session,
    decoder: Session,
    vocab: Vec<String>,
    clean: Regex,
}

fn session(path: &Path, threads: usize) -> Result<Session> {
    use ort::session::builder::GraphOptimizationLevel;
    // Builder-fel bär med sig buildern (inte Send/Sync) – gör om till vanliga strängfel.
    let e = |err: String| anyhow::anyhow!(err);
    Session::builder()?
        .with_optimization_level(GraphOptimizationLevel::Level3)
        .map_err(|x| e(x.to_string()))?
        .with_intra_threads(threads.max(1))
        .map_err(|x| e(x.to_string()))?
        .with_inter_threads(1)
        .map_err(|x| e(x.to_string()))?
        .commit_from_file(path)
        .with_context(|| format!("Kunde inte läsa {}", path.display()))
}

fn argmax(v: &[f32]) -> usize {
    let mut best = 0;
    for (i, x) in v.iter().enumerate() {
        if *x > v[best] {
            best = i;
        }
    }
    best
}

impl Pianissimo {
    pub fn load(dir: &Path, threads: usize) -> Result<Self> {
        let cfg: serde_json::Value =
            serde_json::from_slice(&std::fs::read(dir.join("config.json"))?)?;
        ensure!(
            cfg["model_type"] == "nemo-conformer-tdt"
                && cfg["features_size"] == 128
                && cfg["subsampling_factor"] == 8
                && cfg["max_tokens_per_step"] == 10,
            "Oväntad modellkonfiguration för Pianissimo"
        );
        let vocab_txt = std::fs::read_to_string(dir.join("vocab.txt"))?;
        let mut vocab = Vec::new();
        for (i, line) in vocab_txt.lines().enumerate() {
            let (tok, id) = line.rsplit_once(' ').context("Ogiltig rad i vocab.txt")?;
            ensure!(id.parse::<usize>()? == i, "Ogiltigt id i vocab.txt");
            vocab.push(tok.replace('▁', " "));
        }
        ensure!(vocab.len() == BLANK + 1, "Fel antal tokens i vocab.txt");
        Ok(Self {
            encoder: session(&dir.join("encoder-model.int8.onnx"), threads)?,
            decoder: session(&dir.join("decoder_joint-model.int8.onnx"), threads)?,
            vocab,
            clean: Regex::new(r"\A\s|\s\B|(\s)\b")?,
        })
    }

    /// Transkribera hela inspelningen (16 kHz mono f32). `progress` får 0..=100.
    pub fn transcribe(
        &mut self,
        samples: &[f32],
        cancel: &AtomicBool,
        progress: impl Fn(i32),
    ) -> Result<Vec<PSegment>> {
        let mut out = Vec::new();
        if samples.is_empty() {
            return Ok(out);
        }
        let core = if samples.len() <= MAX_PASS { samples.len() } else { CORE };
        let mut begin = 0;
        while begin < samples.len() {
            if cancel.load(Ordering::Relaxed) {
                break;
            }
            let end = (begin + core).min(samples.len());
            let left = begin.saturating_sub(CONTEXT);
            let right = (end + CONTEXT).min(samples.len());
            let mut audio = samples[left..right].to_vec();
            if audio.len() < 512 {
                audio.resize(512, 0.0);
            }
            let t = self.transcribe_pass(&audio, cancel)?;
            out.extend(self.segments(
                &t,
                left as f64 / RATE as f64,
                begin as f64 / RATE as f64,
                end as f64 / RATE as f64,
            ));
            progress((end as f64 / samples.len() as f64 * 100.0) as i32);
            begin = end;
        }
        Ok(out)
    }

    fn transcribe_pass(&mut self, audio: &[f32], cancel: &AtomicBool) -> Result<Transcript> {
        let (features, frames, valid) = extract_features(audio)?;
        let enc_in = Tensor::from_array(([1usize, 128, frames], features))?;
        let len_in = Tensor::from_array(([1usize], vec![valid as i64]))?;
        let enc_out = self.encoder.run(ort::inputs! {
            "audio_signal" => enc_in,
            "length" => len_in,
        })?;
        let (shape, encoded) = enc_out["outputs"].try_extract_tensor::<f32>()?;
        let (_, lengths) = enc_out["encoded_lengths"].try_extract_tensor::<i64>()?;
        ensure!(shape.len() == 3 && shape[0] == 1 && shape[1] == 1024, "Oväntad encoder-form");
        let stride = shape[2] as usize;
        ensure!(!lengths.is_empty() && (lengths[0] as usize) <= stride, "Ogiltig encoderlängd");
        let n_frames = lengths[0] as usize;

        let mut s1 = vec![0.0_f32; 1280];
        let mut s2 = vec![0.0_f32; 1280];
        let mut ids: Vec<usize> = Vec::new();
        let mut stamps: Vec<f64> = Vec::new();
        let (mut t, mut emitted) = (0usize, 0usize);
        while t < n_frames {
            if cancel.load(Ordering::Relaxed) {
                break;
            }
            let frame: Vec<f32> = (0..1024).map(|c| encoded[c * stride + t]).collect();
            let last = *ids.last().unwrap_or(&BLANK) as i32;
            let out = self.decoder.run(ort::inputs! {
                "encoder_outputs" => Tensor::from_array(([1usize, 1024, 1], frame))?,
                "targets" => Tensor::from_array(([1usize, 1], vec![last]))?,
                "target_length" => Tensor::from_array(([1usize], vec![1_i32]))?,
                "input_states_1" => Tensor::from_array(([2usize, 1, 640], s1.clone()))?,
                "input_states_2" => Tensor::from_array(([2usize, 1, 640], s2.clone()))?,
            })?;
            let (_, logits) = out["outputs"].try_extract_tensor::<f32>()?;
            ensure!(
                logits.len() == 8198 && logits.iter().all(|x| x.is_finite()),
                "Ogiltiga logits från avkodaren"
            );
            let token = argmax(&logits[..=BLANK]);
            let step = argmax(&logits[BLANK + 1..]);
            if token != BLANK {
                let (_, h) = out["output_states_1"].try_extract_tensor::<f32>()?;
                let (_, c) = out["output_states_2"].try_extract_tensor::<f32>()?;
                ensure!(h.len() == 1280 && c.len() == 1280, "Ogiltigt avkodartillstånd");
                s1.copy_from_slice(h);
                s2.copy_from_slice(c);
                ids.push(token);
                stamps.push(t as f64 * FRAME_SECS);
                emitted += 1;
            }
            if step > 0 {
                t += step;
                emitted = 0;
            } else if token == BLANK || emitted == 10 {
                t += 1;
                emitted = 0;
            }
        }
        Ok(Transcript {
            tokens: ids.iter().map(|&i| self.vocab[i].clone()).collect(),
            stamps,
        })
    }

    fn clean_text(&self, s: &str) -> String {
        self.clean.replace_all(s, "$1").into_owned()
    }

    /// Bygg segment (meningar/pauser) av token-tider. Ett ord tillhör den chunk
    /// där dess första token ligger i `[keep_start, keep_end)`.
    fn segments(&self, t: &Transcript, offset: f64, keep_start: f64, keep_end: f64) -> Vec<PSegment> {
        // Gruppera tokens till ord: nytt ord vid token som börjar med blanksteg.
        struct Word {
            text: String,
            start: f64,
            last: f64,
        }
        let mut words: Vec<Word> = Vec::new();
        for (tok, &st) in t.tokens.iter().zip(&t.stamps) {
            let time = offset + st;
            let new_word = words.is_empty() || tok.starts_with(char::is_whitespace);
            if new_word {
                words.push(Word { text: tok.clone(), start: time, last: time });
            } else {
                let w = words.last_mut().unwrap();
                w.text.push_str(tok);
                w.last = time;
            }
        }
        let mut result: Vec<PSegment> = Vec::new();
        let mut cur: Option<(f64, f64, String)> = None; // start, end, text
        let n = words.len();
        for i in 0..n {
            let w = &words[i];
            if w.start < keep_start || w.start >= keep_end {
                continue;
            }
            let natural_end = if i + 1 < n {
                words[i + 1].start.min(w.last + 0.5)
            } else {
                w.last + 0.24
            };
            let end = natural_end.min(keep_end).max(w.start);
            if let Some((cs, ce, ct)) = cur.as_mut() {
                if w.start - *ce > 0.8 || *ce - *cs >= 5.0 {
                    result.push(self.finish(*cs, *ce, ct));
                    cur = None;
                }
            }
            match cur.as_mut() {
                Some((_, ce, ct)) => {
                    ct.push_str(&w.text);
                    *ce = end;
                }
                None => cur = Some((w.start, end, w.text.clone())),
            }
            let trimmed = w.text.trim_end();
            if trimmed.ends_with(['.', '!', '?']) {
                if let Some((cs, ce, ct)) = cur.take() {
                    result.push(self.finish(cs, ce, &ct));
                }
            }
        }
        if let Some((cs, ce, ct)) = cur.take() {
            result.push(self.finish(cs, ce, &ct));
        }
        result.retain(|s| !s.text.is_empty());
        result
    }

    fn finish(&self, start: f64, end: f64, text: &str) -> PSegment {
        PSegment {
            start_ms: (start * 1000.0).round() as i64,
            end_ms: (end * 1000.0).round() as i64,
            text: self.clean_text(text),
        }
    }
}

// ---------------------------------------------------------------------------
// Log-mel-förbehandling (128 band, Slaney, 16 kHz) – matchar NeMo/onnx-asr "nemo128"
// ---------------------------------------------------------------------------

fn hz_to_mel(hz: f64) -> f64 {
    let (f_sp, min_log_hz) = (200.0 / 3.0, 1000.0);
    let min_log_mel = min_log_hz / f_sp;
    let logstep = (6.4_f64).ln() / 27.0;
    if hz >= min_log_hz {
        min_log_mel + (hz / min_log_hz).ln() / logstep
    } else {
        hz / f_sp
    }
}

fn mel_to_hz(mel: f64) -> f64 {
    let (f_sp, min_log_hz) = (200.0 / 3.0, 1000.0);
    let min_log_mel = min_log_hz / f_sp;
    let logstep = (6.4_f64).ln() / 27.0;
    if mel >= min_log_mel {
        min_log_hz * (logstep * (mel - min_log_mel)).exp()
    } else {
        mel * f_sp
    }
}

/// Returnerar (features [128 x frames] row-major, frames, valid)
fn extract_features(audio: &[f32]) -> Result<(Vec<f32>, usize, usize)> {
    if audio.len() < 512 || audio.len() > MAX_PASS {
        bail!("Ljudlängd utanför tillåtet intervall");
    }
    ensure!(audio.iter().all(|x| x.is_finite()), "Ljudet innehåller ogiltiga värden");
    let valid = audio.len() / HOP;
    let frames = valid + 1;

    let mut emphasized = vec![0.0_f32; audio.len() + 512];
    for (i, &s) in audio.iter().enumerate() {
        emphasized[i + 256] = s - 0.97 * if i == 0 { 0.0 } else { audio[i - 1] };
    }

    let top = hz_to_mel(8000.0);
    let edges: Vec<f64> = (0..130).map(|i| mel_to_hz(top * i as f64 / 129.0)).collect();
    let mut banks = vec![0.0_f32; 128 * 257];
    for band in 0..128 {
        for bin in 0..257 {
            let freq = bin as f64 * 16000.0 / 512.0;
            let tri = ((freq - edges[band]) / (edges[band + 1] - edges[band]))
                .min((edges[band + 2] - freq) / (edges[band + 2] - edges[band + 1]))
                .max(0.0);
            banks[band * 257 + bin] =
                (tri as f32 as f64 * 2.0 / (edges[band + 2] - edges[band])) as f32;
        }
    }

    let mut window = [0.0_f64; 512];
    for i in 0..400 {
        window[i + 56] = 0.5 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / 399.0).cos();
    }
    let fft = FftPlanner::<f64>::new().plan_fft_forward(512);
    let mut buffer = vec![Complex::new(0.0_f64, 0.0); 512];
    let mut scratch = vec![Complex::new(0.0_f64, 0.0); fft.get_inplace_scratch_len()];
    let mut features = vec![0.0_f32; 128 * frames];
    for frame in 0..valid {
        for i in 0..512 {
            buffer[i] = Complex::new(emphasized[frame * HOP + i] as f64 * window[i], 0.0);
        }
        fft.process_with_scratch(&mut buffer, &mut scratch);
        let mut spectrum = [0.0_f32; 257];
        for i in 0..257 {
            let m = buffer[i].norm() as f32;
            spectrum[i] = m * m;
        }
        for band in 0..128 {
            let power: f32 = (0..257).map(|b| spectrum[b] * banks[band * 257 + b]).sum();
            features[band * frames + frame] = (power + 2.0_f32.powi(-24)).ln();
        }
    }
    for band in features.chunks_mut(frames) {
        let mean = band[..valid].iter().sum::<f32>() / valid as f32;
        let var = if valid > 1 {
            band[..valid].iter().map(|x| (x - mean).powi(2)).sum::<f32>() / (valid - 1) as f32
        } else {
            0.0
        };
        for v in &mut band[..valid] {
            *v = (*v - mean) / (var.sqrt() + 1e-5);
        }
    }
    Ok((features, frames, valid))
}

pub fn model_dir(models_root: &Path) -> PathBuf {
    models_root.join(MODEL_DIR)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn features_have_expected_shape() {
        let audio = vec![0.01_f32; 16000];
        let (f, frames, valid) = extract_features(&audio).unwrap();
        assert_eq!(valid, 100);
        assert_eq!(frames, 101);
        assert_eq!(f.len(), 128 * 101);
        assert!(f.iter().all(|x| x.is_finite()));
    }

    /// Manuellt test mot riktig modell:
    /// PIANISSIMO_DIR=... PIANISSIMO_WAV=fil.wav cargo test --release -- --ignored --nocapture e2e
    #[test]
    #[ignore]
    fn e2e_transcribe_wav() {
        let dir = std::env::var("PIANISSIMO_DIR").expect("PIANISSIMO_DIR");
        let wav = std::env::var("PIANISSIMO_WAV").expect("PIANISSIMO_WAV");
        let mut r = hound::WavReader::open(&wav).unwrap();
        assert_eq!(r.spec().sample_rate, 16000);
        let samples: Vec<f32> = r.samples::<i16>().map(|s| s.unwrap() as f32 / 32768.0).collect();
        let secs = samples.len() as f64 / 16000.0;
        let t0 = std::time::Instant::now();
        let mut m = Pianissimo::load(Path::new(&dir), 4).unwrap();
        let load = t0.elapsed().as_secs_f64();
        let t1 = std::time::Instant::now();
        let segs = m.transcribe(&samples, &AtomicBool::new(false), |_| {}).unwrap();
        let run = t1.elapsed().as_secs_f64();
        for s in &segs {
            println!("[{:>7.2} - {:>7.2}] {}", s.start_ms as f64 / 1000.0, s.end_ms as f64 / 1000.0, s.text);
        }
        println!("ljud {secs:.1}s, laddning {load:.1}s, transkribering {run:.1}s => {:.1}x realtid", secs / run);
        assert!(!segs.is_empty());
    }

    #[test]
    fn clean_text_removes_space_before_punctuation() {
        let re = Regex::new(r"\A\s|\s\B|(\s)\b").unwrap();
        assert_eq!(re.replace_all(" Åsa är här .", "$1"), "Åsa är här.");
    }
}
