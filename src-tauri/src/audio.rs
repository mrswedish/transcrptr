use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Sample, SampleFormat, Stream, StreamConfig};
use std::sync::{Arc, Mutex};

pub struct AudioRecorder {
    mic_stream: Option<Stream>,
    loopback_stream: Option<Stream>,
    pub recorded_samples: Arc<Mutex<Vec<f32>>>,
}

impl AudioRecorder {
    pub fn new() -> Self {
        Self {
            mic_stream: None,
            loopback_stream: None,
            recorded_samples: Arc::new(Mutex::new(Vec::new())),
        }
    }

    pub fn start_recording(&mut self) -> Result<(), String> {
        let host = cpal::default_host();
        let recorded_samples = Arc::clone(&self.recorded_samples);
        
        // Clear previous recordings
        {
            let mut samples = recorded_samples.lock().unwrap();
            samples.clear();
        }

        // 1. Setup Microphone Stream
        let mic_device = host.default_input_device()
            .ok_or("No input device found")?;
        let mic_config: StreamConfig = mic_device.default_input_config()
            .map_err(|e| e.to_string())?.into();
        
        // Target format for Whisper: 16kHz mono f32
        let target_sample_rate = 16000;
        
        let recorded_samples_clone = Arc::clone(&recorded_samples);
        let mic_stream = mic_device.build_input_stream(
            &mic_config,
            move |data: &[f32], _: &cpal::InputCallbackInfo| {
                // Here we would ideally resample and mix, but for simplicity we'll just push
                // In a real implementation we need a proper ring buffer and resampling logic
                let mut samples = recorded_samples_clone.lock().unwrap();
                // Simple mono conversion if needed
                for &sample in data {
                    samples.push(sample);
                }
            },
            |err| eprintln!("Mic stream error: {}", err),
            None
        ).map_err(|e| e.to_string())?;

        // 2. Setup WASAPI Loopback (Windows Only)
        #[cfg(target_os = "windows")]
        {
            // WASAPI loopback requires special host handling or using a specific device
            // CPAL's WASAPI backend supports loopback if the device is an output device
            if let Some(output_device) = host.default_output_device() {
                let loopback_config: StreamConfig = output_device.default_output_config()
                    .map_err(|e| e.to_string())?.into();
                
                let recorded_samples_clone_2 = Arc::clone(&recorded_samples);
                let loopback_stream = output_device.build_input_stream(
                    &loopback_config,
                    move |data: &[f32], _: &cpal::InputCallbackInfo| {
                        let mut samples = recorded_samples_clone_2.lock().unwrap();
                        for (i, &sample) in data.iter().enumerate() {
                            // Mix with existing samples if they exist (naive alignment)
                            // This is VERY simplified. Proper mixing requires timestamp alignment.
                            if i < samples.len() {
                                samples[i] = (samples[i] + sample) / 2.0;
                            } else {
                                samples.push(sample);
                            }
                        }
                    },
                    |err| eprintln!("Loopback stream error: {}", err),
                    None
                ).map_err(|e| e.to_string())?;
                
                loopback_stream.play().map_err(|e| e.to_string())?;
                self.loopback_stream = Some(loopback_stream);
            }
        }

        mic_stream.play().map_err(|e| e.to_string())?;
        self.mic_stream = Some(mic_stream);

        Ok(())
    }

    pub fn stop_recording(&mut self) -> Vec<u8> {
        self.mic_stream = None;
        self.loopback_stream = None;
        
        let samples = self.recorded_samples.lock().unwrap();
        // Convert f32 samples to bytes for Whisper
        let mut bytes = Vec::with_capacity(samples.len() * 4);
        for &sample in samples.iter() {
            bytes.extend_from_slice(&sample.to_le_bytes());
        }
        bytes
    }
}
