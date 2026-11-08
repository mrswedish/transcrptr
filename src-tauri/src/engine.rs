//! Gemensamt gränssnitt för transkriberingsmotorer (Whisper, Pianissimo, …).
//!
//! Motorerna känner varken till Tauri eller filer: de får en bit ljud (16 kHz mono f32)
//! och returnerar segment med absoluta tider. Chunk-loopen, progress och avbrott
//! finns på ett enda ställe i `run_file`.

use crate::decode::StreamingDecoder;
use crate::types::TranscriptSegment;
use std::sync::atomic::{AtomicBool, Ordering};

/// 5 minuter per chunk — håller peak-minnet ~19 MB oavsett fillängd.
pub(crate) const CHUNK_SAMPLES: usize = 16_000 * 300;

pub(crate) trait Engine {
    /// `offset_ms`: chunkens start i hela inspelningen. `prev_text`: slutet av föregående
    /// chunk (används som kontext av motorer som stöder det). `on_progress`: 0..=100 inom chunken.
    fn transcribe_chunk(
        &mut self,
        samples: &[f32],
        offset_ms: i64,
        prev_text: Option<&str>,
        cancel: &AtomicBool,
        on_progress: &(dyn Fn(i32) + Sync),
    ) -> Result<Vec<TranscriptSegment>, String>;
}

pub(crate) fn panic_msg(p: Box<dyn std::any::Any + Send>) -> String {
    if let Some(s) = p.downcast_ref::<&str>() { s.to_string() }
    else if let Some(s) = p.downcast_ref::<String>() { s.clone() }
    else { "okänt fel".to_string() }
}

/// Transkribera hela filen chunk för chunk. `on_overall` får total progress 0..=99.
pub(crate) fn run_file(
    engine: &mut dyn Engine,
    dec: &mut StreamingDecoder,
    cancel: &AtomicBool,
    on_overall: &(dyn Fn(i32) + Sync),
) -> Result<Vec<TranscriptSegment>, String> {
    let total_chunks = dec.estimate_total_chunks(CHUNK_SAMPLES).max(1) as i32;
    let mut all = Vec::<TranscriptSegment>::new();
    let mut prev_text: Option<String> = None;
    let mut cum_offset = 0i64;
    let mut idx = 0i32;

    while let Some(chunk) = dec.next_chunk(CHUNK_SAMPLES)? {
        if cancel.load(Ordering::Relaxed) { break; }
        let offset = cum_offset;
        cum_offset += (chunk.len() as i64 * 1000) / 16000;

        // Tidigt event så att UI:t byter från "Avkodar…" till "Transkriberar…".
        on_overall(((idx * 100) / total_chunks).min(99));

        let overall = move |p: i32| on_overall(((idx * 100 + p) / total_chunks).min(99));
        let segs = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            engine.transcribe_chunk(&chunk, offset, prev_text.as_deref(), cancel, &overall)
        }))
        .unwrap_or_else(|p| Err(format!("Krasch i del {}: {}", idx + 1, panic_msg(p))))?;

        if !segs.is_empty() {
            let text = segs.iter().map(|s| s.text.as_str()).collect::<Vec<_>>().join(" ");
            let words: Vec<&str> = text.split_whitespace().collect();
            prev_text = Some(words.iter().rev().take(30).rev().cloned().collect::<Vec<_>>().join(" "));
        }
        all.extend(segs);
        idx += 1;
    }
    Ok(all)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Manuellt: PIANISSIMO_DIR=<modellmapp> TEST_AUDIO=<valfri ljudfil> cargo test --release --lib -- --ignored --nocapture run_file_e2e
    #[test]
    #[ignore]
    fn run_file_e2e() {
        let dir = std::env::var("PIANISSIMO_DIR").expect("PIANISSIMO_DIR");
        let audio = std::env::var("TEST_AUDIO").expect("TEST_AUDIO");
        let mut dec = StreamingDecoder::open(&audio).unwrap();
        let mut eng = crate::pianissimo::Pianissimo::load(std::path::Path::new(&dir), 4).unwrap();
        let t0 = std::time::Instant::now();
        let last = std::sync::atomic::AtomicI32::new(-1);
        let segs = run_file(&mut eng, &mut dec, &AtomicBool::new(false), &|p| last.store(p, Ordering::Relaxed)).unwrap();
        println!("{} segment på {:.1} s, sista progress {}", segs.len(), t0.elapsed().as_secs_f64(), last.load(Ordering::Relaxed));
        for s in segs.iter().take(3) { println!("[{} - {}] {}", s.start_ms, s.end_ms, s.text); }
        assert!(segs.windows(2).all(|w| w[0].start_ms <= w[1].start_ms), "tider ska vara monotona");
    }
}
