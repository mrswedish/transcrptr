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

    // Returnerar nästa chunk med exakt `chunk_samples` samples (eller resten av filen).
    // None = EOF.
    pub(crate) fn next_chunk(&mut self, chunk_samples: usize) -> Result<Option<Vec<f32>>, String> {
        use symphonia::core::{audio::SampleBuffer, errors::Error as SymphoniaError};
        loop {
            if self.leftover.len() >= chunk_samples {
                return Ok(Some(self.leftover.drain(..chunk_samples).collect()));
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
            let mono      = crate::audio::to_mono(buf.samples(), spec.channels.count() as u16);
            let resampled = crate::audio::resample_to_16k(&mono, spec.rate);
            self.leftover.extend_from_slice(&resampled);
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

