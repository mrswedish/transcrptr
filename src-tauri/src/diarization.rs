//! Talaridentifiering (diarisering) med speakrs: pyannote community-1-pipelinen
//! (segmentering → embedding → PLDA → VBx) i ren Rust på CPU. Ingen onnxruntime.
//!
//! Modellerna är pyannotes (segmentation-3.0: MIT, wespeaker-voxceleb-resnet34-LM och
//! community-1-PLDA: CC-BY-4.0), konverterade av speakrs-projektet. De hämtas en gång,
//! från en fast revision med SHA-256-kontroll, och körs sedan helt lokalt.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use speakrs::{ExecutionMode, OwnedDiarizationPipeline};

use crate::decode::StreamingDecoder;
use crate::engine::{panic_msg, CHUNK_SAMPLES};
use crate::types::TranscriptSegment;

pub(crate) const MODEL_DIR: &str = "diarization";
const REPO: &str = "avencera/speakrs-models";
const REVISION: &str = "67f963b6a1d94fcd4678948237b3cc8bd69bf1d8";

/// (filnamn, SHA-256, ungefärlig storlek i byte)
pub(crate) const FILES: &[(&str, &str, u64)] = &[
    ("segmentation-3.0.safetensors", "88e7883cf56f679170e162419efddf970f929915281ebce80e351c42b5a7115d", 5_897_576),
    ("wespeaker-multimask-tail.safetensors", "b97b090ceebcf10924732ad4552a2d867d76d38dcc1409a13687a6ba71ff1ef3", 26_527_656),
    ("plda_lda.npy", "e20c9b012bebd1aabda5a38a127e63a43cf35debdc502715fc143e2fb6bc3c4b", 131_200),
    ("plda_tr.npy", "e700b68cb319de3fafb5fa093eb9222c23c447084741f8d3a533640d425510ee", 131_200),
    ("plda_mu.npy", "d286d48acf99bbc1ed1502fed0a3e361ae5626ce1870c8be9f7397c5e47886c6", 1_152),
    ("plda_psi.npy", "d7128c9ed2f28a9781971805131129f077c04f948e2df12e52dcdb99f2b4e5f5", 1_152),
    ("plda_mean1.npy", "e424c0c352182aa8e0f555dec1f3b30e29a20b9ed6b25d339f112af92e51e36f", 2_176),
    ("plda_mean2.npy", "6f6fb708a2037197b5b84ffeaa8f140cb878088fbecd6ab042ad26a7691bd2cf", 640),
    ("wespeaker-voxceleb-resnet34.min_num_samples.txt", "e4df891c484d7abb985dadf539fa1883a646dab6337af5cae4159c587b7050cc", 4),
];

pub(crate) fn download_url(file: &str) -> String {
    format!("https://huggingface.co/{REPO}/resolve/{REVISION}/{file}")
}

pub(crate) fn model_dir(models_root: &Path) -> PathBuf {
    models_root.join(MODEL_DIR)
}

pub(crate) fn is_ready(dir: &Path) -> bool {
    FILES.iter().all(|(name, _, _)| dir.join(name).is_file())
}

/// En talartur, med talare numrerade 1, 2, … i den ordning de först hörs.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Turn {
    pub(crate) start_ms: i64,
    pub(crate) end_ms: i64,
    pub(crate) speaker: i32,
}

/// Kör diariseringen på hela ljudet (16 kHz mono f32).
pub(crate) fn diarize(model_dir: &Path, samples: &[f32]) -> Result<Vec<Turn>, String> {
    let mut pipeline = OwnedDiarizationPipeline::from_dir(model_dir, ExecutionMode::Cpu)
        .map_err(|e| format!("Kunde inte läsa talarmodellerna: {e}"))?;
    let result = pipeline
        .run(samples)
        .map_err(|e| format!("Talaridentifieringen misslyckades: {e}"))?;
    Ok(turns_from_segments(
        result.exclusive_segments.iter().map(|s| (s.start, s.end, s.speaker.as_str())),
    ))
}

/// Gör om speakrs-segment ("SPEAKER_03", sekunder) till turer med talare numrerade
/// efter första uppträdande. Använder segment med högst en aktiv talare åt gången.
fn turns_from_segments<'a>(segs: impl Iterator<Item = (f64, f64, &'a str)>) -> Vec<Turn> {
    let mut raw: Vec<(f64, f64, &str)> = segs.filter(|(s, e, _)| e > s).collect();
    raw.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    let mut order: Vec<&str> = Vec::new();
    raw.iter()
        .map(|&(s, e, label)| {
            let idx = match order.iter().position(|l| *l == label) {
                Some(i) => i,
                None => {
                    order.push(label);
                    order.len() - 1
                }
            };
            Turn {
                start_ms: (s * 1000.0).round() as i64,
                end_ms: (e * 1000.0).round() as i64,
                speaker: idx as i32 + 1,
            }
        })
        .collect()
}

/// Sätter `speaker_id` på varje segment: talaren med störst tidsöverlapp, annars
/// närmaste tur (högst 2 s bort). Returnerar antal talare som fick minst ett segment.
pub(crate) fn assign_speakers(segments: &mut [TranscriptSegment], turns: &[Turn]) -> i32 {
    const MAX_GAP_MS: i64 = 2000;
    for seg in segments.iter_mut() {
        let mut best: Option<(i32, i64)> = None;
        let mut per: Vec<(i32, i64)> = Vec::new();
        for t in turns {
            let ov = seg.end_ms.min(t.end_ms) - seg.start_ms.max(t.start_ms);
            if ov > 0 {
                match per.iter_mut().find(|(s, _)| *s == t.speaker) {
                    Some(e) => e.1 += ov,
                    None => per.push((t.speaker, ov)),
                }
            }
        }
        for (s, ov) in per {
            if best.map(|(_, b)| ov > b).unwrap_or(true) {
                best = Some((s, ov));
            }
        }
        if best.is_none() {
            let mid = (seg.start_ms + seg.end_ms) / 2;
            best = turns
                .iter()
                .map(|t| {
                    let d = if mid < t.start_ms { t.start_ms - mid } else if mid > t.end_ms { mid - t.end_ms } else { 0 };
                    (t.speaker, d)
                })
                .filter(|(_, d)| *d <= MAX_GAP_MS)
                .min_by_key(|(_, d)| *d);
        }
        seg.speaker_id = best.map(|(s, _)| s);
    }
    // Numrera om efter första uppträdande i transkriptet, så "Talare 1" är den som talar först.
    let mut order: Vec<i32> = Vec::new();
    for seg in segments.iter_mut() {
        if let Some(s) = seg.speaker_id {
            let idx = match order.iter().position(|o| *o == s) {
                Some(i) => i,
                None => {
                    order.push(s);
                    order.len() - 1
                }
            };
            seg.speaker_id = Some(idx as i32 + 1);
        }
    }
    order.len() as i32
}

/// Avkodar hela filen till 16 kHz mono f32 (cirka 230 MB per timme ljud).
fn load_samples(path: &str, cancel: &AtomicBool) -> Result<Vec<f32>, String> {
    let mut dec = StreamingDecoder::open(path)?;
    let mut all = Vec::new();
    while let Some(chunk) = dec.next_chunk(CHUNK_SAMPLES)? {
        if cancel.load(Ordering::Relaxed) {
            return Err("avbruten".into());
        }
        all.extend_from_slice(&chunk);
    }
    Ok(all)
}

/// Hela steget: avkoda → diarisera → tilldela talare. Returnerar antal talare.
/// Felet är aldrig ödesdigert för transkriptet — anroparen behåller texten utan talare.
pub(crate) fn identify(
    model_dir: &Path,
    audio_path: &str,
    segments: &mut [TranscriptSegment],
    cancel: &AtomicBool,
) -> Result<i32, String> {
    let samples = load_samples(audio_path, cancel)?;
    // speakrs kräver en viss minsta längd; för korta filer finns ingenting att skilja åt.
    if samples.len() < 16_000 * 5 {
        return Err("Ljudet är för kort för att skilja talare åt.".into());
    }
    let turns = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| diarize(model_dir, &samples)))
        .unwrap_or_else(|p| Err(format!("Talaridentifieringen kraschade: {}.", panic_msg(p))))?;
    drop(samples);
    Ok(assign_speakers(segments, &turns))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seg(s: i64, e: i64) -> TranscriptSegment {
        TranscriptSegment { start_ms: s, end_ms: e, text: String::new(), tokens: vec![], speaker_id: None }
    }

    #[test]
    fn turns_numreras_efter_forsta_uppträdande() {
        let t = turns_from_segments(
            vec![(5.0, 6.0, "SPEAKER_02"), (0.0, 2.0, "SPEAKER_07"), (2.0, 4.0, "SPEAKER_02")].into_iter(),
        );
        assert_eq!(t[0], Turn { start_ms: 0, end_ms: 2000, speaker: 1 });
        assert_eq!(t[1].speaker, 2);
        assert_eq!(t[2].speaker, 2);
    }

    #[test]
    fn storst_overlapp_vinner() {
        let turns = vec![
            Turn { start_ms: 0, end_ms: 3000, speaker: 1 },
            Turn { start_ms: 3000, end_ms: 10_000, speaker: 2 },
        ];
        let mut segs = vec![seg(1000, 2000), seg(2000, 8000), seg(9000, 9500)];
        let n = assign_speakers(&mut segs, &turns);
        assert_eq!(n, 2);
        assert_eq!(segs[0].speaker_id, Some(1));
        assert_eq!(segs[1].speaker_id, Some(2)); // 1 s mot 5 s
        assert_eq!(segs[2].speaker_id, Some(2));
    }

    #[test]
    fn narmaste_tur_inom_tva_sekunder_annars_ingen() {
        let turns = vec![Turn { start_ms: 0, end_ms: 1000, speaker: 1 }];
        let mut segs = vec![seg(2000, 2500), seg(9000, 9500)];
        assign_speakers(&mut segs, &turns);
        assert_eq!(segs[0].speaker_id, Some(1));
        assert_eq!(segs[1].speaker_id, None);
    }

    #[test]
    fn omnumrering_efter_forsta_segment() {
        // Talare 2 (i turerna) hörs först i transkriptet → blir Talare 1.
        let turns = vec![
            Turn { start_ms: 0, end_ms: 1000, speaker: 2 },
            Turn { start_ms: 1000, end_ms: 2000, speaker: 1 },
        ];
        let mut segs = vec![seg(0, 900), seg(1100, 1900)];
        assign_speakers(&mut segs, &turns);
        assert_eq!(segs[0].speaker_id, Some(1));
        assert_eq!(segs[1].speaker_id, Some(2));
    }

    #[test]
    fn filer_ar_kompletta() {
        assert_eq!(FILES.len(), 9);
        assert!(FILES.iter().all(|(_, sha, _)| sha.len() == 64));
    }

    /// Kör hela steget på en riktig tvåtalarfil:
    /// `SPK_MODELS=<katalog> SPK_WAV=<fil> cargo test --release e2e_identify -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn e2e_identify() {
        let dir = std::env::var("SPK_MODELS").expect("SPK_MODELS");
        let wav = std::env::var("SPK_WAV").expect("SPK_WAV");
        let secs: i64 = {
            let mut dec = StreamingDecoder::open(&wav).unwrap();
            let mut n = 0usize;
            while let Some(c) = dec.next_chunk(CHUNK_SAMPLES).unwrap() { n += c.len(); }
            (n / 16_000) as i64
        };
        // Ett "transkript" med ett segment var femte sekund.
        let mut segs: Vec<TranscriptSegment> = (0..secs / 5).map(|i| seg(i * 5000, i * 5000 + 4500)).collect();
        let cancel = AtomicBool::new(false);
        let t = std::time::Instant::now();
        let n = identify(Path::new(&dir), &wav, &mut segs, &cancel).unwrap();
        println!("{secs} s ljud, {n} talare, {:.1} s", t.elapsed().as_secs_f64());
        let line: String = segs.iter().map(|s| s.speaker_id.map(|x| x.to_string()).unwrap_or("?".into())).collect();
        println!("talare per 5 s: {line}");
        assert!(n >= 2);
    }
}
