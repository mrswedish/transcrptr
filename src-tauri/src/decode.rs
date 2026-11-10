//! Strömmande avkodning av ljudfiler (Symphonia) till 16 kHz mono f32.

// Dekoda en ljudfil som en stream — ett chunk i taget — för att minimera minnespeak.
// Hela filen läses aldrig in i minnet; bara ett ~19 MB chunk åt gången hålls levande.
pub(crate) struct StreamingDecoder {
    format:   Box<dyn symphonia::core::formats::FormatReader>,
    decoder:  Box<dyn symphonia::core::codecs::Decoder>,
    track_id: u32,
    n_frames: Option<u64>,
    src_rate: u32,
    leftover: Vec<f32>,
}

impl StreamingDecoder {
    pub(crate) fn open(path: &str) -> Result<Self, String> {
        use symphonia::core::{
            codecs::{DecoderOptions, CODEC_TYPE_NULL},
            formats::FormatOptions,
            io::MediaSourceStream,
            meta::MetadataOptions,
            probe::Hint,
        };
        let file = std::fs::File::open(path)
            .map_err(|e| format!("Kunde inte öppna filen: {e}"))?;
        let mss = MediaSourceStream::new(Box::new(file), Default::default());
        let probed = symphonia::default::get_probe()
            .format(&Hint::new(), mss, &FormatOptions::default(), &MetadataOptions::default())
            .map_err(|e| format!("Okänt filformat: {e}"))?;
        let format = probed.format;
        let track = format.tracks().iter()
            .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
            .ok_or_else(|| "Ingen ljudspår hittades i filen".to_string())?;
        let track_id = track.id;
        let n_frames = track.codec_params.n_frames;
        let src_rate = track.codec_params.sample_rate.unwrap_or(44100);
        let decoder  = symphonia::default::get_codecs()
            .make(&track.codec_params, &DecoderOptions::default())
            .map_err(|e| format!("Kunde inte skapa avkodare: {e}"))?;
        Ok(StreamingDecoder { format, decoder, track_id, n_frames, src_rate, leftover: Vec::new() })
    }

    // Returnerar nästa chunk med cirka `chunk_samples` samples (eller resten av filen).
    // Om mer ljud följer klipps chunken vid den tystaste punkten under de sista 15 sekunderna
    // så att vi inte klyver ett uttalat ord mitt itu vid 5-minutersgränsen.
    // None = EOF.
    pub(crate) fn next_chunk(&mut self, chunk_samples: usize) -> Result<Option<Vec<f32>>, String> {
        use symphonia::core::{audio::SampleBuffer, errors::Error as SymphoniaError};
        loop {
            if self.leftover.len() >= chunk_samples {
                let split_at = find_silence_split(&self.leftover[..chunk_samples]);
                return Ok(Some(self.leftover.drain(..split_at).collect()));
            }
            let packet = match self.format.next_packet() {
                Ok(p)                              => p,
                Err(SymphoniaError::IoError(_))    => break,
                Err(SymphoniaError::ResetRequired) => { self.decoder.reset(); continue; }
                Err(_)                             => break,
            };
            if packet.track_id() != self.track_id { continue; }
            let decoded = match self.decoder.decode(&packet) {
                Ok(d)  => d,
                Err(_) => continue,
            };
            let spec = *decoded.spec();
            let mut buf = SampleBuffer::<f32>::new(decoded.capacity() as u64, spec);
            buf.copy_interleaved_ref(decoded);
            let ch = spec.channels.count() as u16;
            if ch == 1 && spec.rate == 16_000 {
                // Snabbväg för våra egna 16 kHz mono recording.wav-filer — noll extra allokering
                self.leftover.extend_from_slice(buf.samples());
            } else {
                let mono      = crate::audio::to_mono(buf.samples(), ch);
                let resampled = crate::audio::resample_to_16k(&mono, spec.rate);
                self.leftover.extend_from_slice(&resampled);
            }
        }
        if self.leftover.is_empty() { Ok(None) }
        else { Ok(Some(std::mem::take(&mut self.leftover))) }
    }

    // Uppskattar antal chunks via metadata — används för progress-visning.
    pub(crate) fn estimate_total_chunks(&self, chunk_samples: usize) -> usize {
        if let Some(n) = self.n_frames {
            if n > 0 && self.src_rate > 0 {
                let total_16k = (n as f64 * 16000.0 / self.src_rate as f64) as usize;
                return (total_16k + chunk_samples - 1) / chunk_samples;
            }
        }
        1
    }
}

/// Hittar den tystaste punkten (lägst energi i ett 200 ms-fönster) under de sista 15 sekunderna
/// av `buf` (16 kHz). Om `buf` är kortare än 30 sekunder returneras `buf.len()` oförändrat.
pub(crate) fn find_silence_split(buf: &[f32]) -> usize {
    const RATE: usize = 16_000;
    const MIN_LEN: usize = RATE * 30;
    const SEARCH_TAIL: usize = RATE * 15;
    const WIN: usize = RATE / 5;   // 200 ms = 3 200 samples
    const STEP: usize = RATE / 20; // 50 ms = 800 samples

    if buf.len() < MIN_LEN {
        return buf.len();
    }
    let search_start = buf.len() - SEARCH_TAIL;
    let mut best_center = buf.len();
    let mut best_energy = f32::INFINITY;

    let mut pos = search_start;
    while pos + WIN <= buf.len() {
        let slice = &buf[pos..pos + WIN];
        let energy: f32 = slice.iter().map(|&x| x * x).sum();
        if energy <= best_energy {
            best_energy = energy;
            best_center = pos + WIN / 2;
        }
        pos += STEP;
    }
    best_center
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hittar_tystnad_i_slutet_av_chunk() {
        // 40 sekunder ton (0.5), men 300 ms tystnad vid 32.0 s
        let mut buf = vec![0.5_f32; 16_000 * 40];
        let silence_start = 16_000 * 32;
        let silence_end = silence_start + 16_000 * 3 / 10;
        for s in &mut buf[silence_start..silence_end] {
            *s = 0.0;
        }
        let split = find_silence_split(&buf);
        assert!(
            split >= silence_start && split <= silence_end,
            "split ({split}) borde hamna i tystnaden ({silence_start}..{silence_end})"
        );
    }
}


