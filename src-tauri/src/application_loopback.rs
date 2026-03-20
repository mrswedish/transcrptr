#![cfg(target_os = "windows")]

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use windows::{
    core::*,
    Win32::Foundation::*,
    Win32::Media::Audio::*,
    Win32::System::Com::*,
    Win32::System::Threading::*,
};

// COM interfaces need Send+Sync — we ensure MTA usage in the caller.
unsafe impl Send for ApplicationLoopback {}
unsafe impl Sync for ApplicationLoopback {}

// CLSID for MMDeviceEnumerator ({BCDE0395-E52F-467C-8E3D-C4579291692E})
const CLSID_MMDEVICE_ENUMERATOR: GUID =
    GUID::from_u128(0xbcde0395_e52f_467c_8e3d_c4579291692e);

// SubFormat GUIDs for WAVE_FORMAT_EXTENSIBLE
const SUBFMT_IEEE_FLOAT: GUID =
    GUID::from_u128(0x00000003_0000_0010_8000_00aa00389b71);

// ─────────────────────────────────────────────────────────────────────────────
// Sample format detected from WAVEFORMATEX / WAVEFORMATEXTENSIBLE
// ─────────────────────────────────────────────────────────────────────────────
#[derive(Debug, Clone, Copy)]
enum SampleFormat {
    Float32,
    Int16,
    Int24,
    Int32,
}

// ─────────────────────────────────────────────────────────────────────────────
// ApplicationLoopback — classic WASAPI endpoint loopback
// Captures all audio playing through the default render device.
// Works on Windows 7+ without ActivateAudioInterfaceAsync.
// ─────────────────────────────────────────────────────────────────────────────
pub struct ApplicationLoopback {
    audio_client: Option<IAudioClient>,
    capture_client: Option<IAudioCaptureClient>,
    channels: u16,
    sample_rate: u32,
    sample_format: SampleFormat,
    buffer_event: HANDLE,
    active: Arc<AtomicBool>,
}

impl ApplicationLoopback {
    /// Caller must have called `CoInitializeEx(COINIT_MULTITHREADED)` on the
    /// current thread before calling `new()`.
    pub fn new(_device_id: Option<&str>) -> Result<Self> {
        unsafe {
            // 1. Create device enumerator
            let enumerator: IMMDeviceEnumerator = CoCreateInstance(
                &CLSID_MMDEVICE_ENUMERATOR,
                None::<&IUnknown>,
                CLSCTX_ALL,
            )?;

            // 2. Get default render endpoint (headset / speakers)
            let device = enumerator.GetDefaultAudioEndpoint(eRender, eConsole)?;

            // 3. Activate IAudioClient from render device
            let audio_client: IAudioClient = device.Activate(CLSCTX_ALL, None)?;

            // 4. Get mix format and detect sample layout
            let fmt_ptr = audio_client.GetMixFormat()?;
            let fmt = &*fmt_ptr;
            let channels = fmt.nChannels;
            let sample_rate = fmt.nSamplesPerSec;
            let sample_format = detect_format(fmt);
            // Copy packed fields to locals to avoid misaligned reference UB
            let fmt_tag = fmt.wFormatTag;
            let fmt_bits = fmt.wBitsPerSample;

            eprintln!(
                "[loopback] Endpoint loopback: {}ch @ {} Hz, {:?} (wFormatTag={:#06x}, bits={})",
                channels, sample_rate, sample_format, fmt_tag, fmt_bits
            );

            // 5. Initialize in shared loopback mode with event-driven buffering
            audio_client.Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                0,
                0,
                fmt_ptr,
                None,
            )?;

            // 6. Bind buffer-ready event
            let buffer_event = CreateEventW(None, false, false, PCWSTR::null())?;
            audio_client.SetEventHandle(buffer_event)?;

            // 7. Get capture client
            let capture_client: IAudioCaptureClient = audio_client.GetService()?;

            Ok(Self {
                audio_client: Some(audio_client),
                capture_client: Some(capture_client),
                channels,
                sample_rate,
                sample_format,
                buffer_event,
                active: Arc::new(AtomicBool::new(false)),
            })
        }
    }

    pub fn start(&self) -> Result<()> {
        unsafe {
            if let Some(c) = &self.audio_client {
                c.Start()?;
                self.active.store(true, Ordering::SeqCst);
            }
            Ok(())
        }
    }

    pub fn stop(&self) -> Result<()> {
        self.active.store(false, Ordering::SeqCst);
        unsafe {
            if let Some(c) = &self.audio_client {
                let _ = c.Stop();
            }
            Ok(())
        }
    }

    pub fn is_active(&self) -> bool {
        self.active.load(Ordering::SeqCst)
    }

    pub fn wait_for_buffer(&self, timeout_ms: u32) -> bool {
        unsafe { WaitForSingleObject(self.buffer_event, timeout_ms) == WAIT_OBJECT_0 }
    }

    pub fn read_samples(&self) -> Vec<f32> {
        let mut out = Vec::new();
        unsafe {
            let capture = match &self.capture_client {
                Some(c) => c,
                None => return out,
            };
            loop {
                let mut data: *mut u8 = std::ptr::null_mut();
                let mut frames: u32 = 0;
                let mut flags: u32 = 0;

                if capture
                    .GetBuffer(&mut data, &mut frames, &mut flags, None, None)
                    .is_err()
                    || frames == 0
                {
                    break;
                }

                let n = frames as usize * self.channels as usize;

                if (flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) != 0 {
                    out.extend(std::iter::repeat(0.0f32).take(n));
                } else {
                    out.extend(convert_to_f32(data, n, self.sample_format));
                }

                let _ = capture.ReleaseBuffer(frames);
            }
        }
        out
    }

    pub fn get_sample_rate(&self) -> u32 {
        self.sample_rate
    }

    pub fn get_channels(&self) -> u16 {
        self.channels
    }
}

impl Drop for ApplicationLoopback {
    fn drop(&mut self) {
        let _ = self.stop();
        unsafe {
            if !self.buffer_event.is_invalid() {
                let _ = CloseHandle(self.buffer_event);
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Detect sample format from WAVEFORMATEX (or WAVEFORMATEXTENSIBLE)
// ─────────────────────────────────────────────────────────────────────────────
unsafe fn detect_format(fmt: &WAVEFORMATEX) -> SampleFormat {
    const WAVE_FORMAT_PCM: u16 = 1;
    const WAVE_FORMAT_IEEE_FLOAT: u16 = 3;
    const WAVE_FORMAT_EXTENSIBLE: u16 = 0xFFFE;

    match fmt.wFormatTag {
        WAVE_FORMAT_IEEE_FLOAT => SampleFormat::Float32,
        WAVE_FORMAT_PCM => match fmt.wBitsPerSample {
            16 => SampleFormat::Int16,
            24 => SampleFormat::Int24,
            32 => SampleFormat::Int32,
            _ => SampleFormat::Float32,
        },
        WAVE_FORMAT_EXTENSIBLE => {
            // Cast to WAVEFORMATEXTENSIBLE to read SubFormat
            let ext = &*(fmt as *const WAVEFORMATEX as *const WAVEFORMATEXTENSIBLE);
            // Copy packed field to local to avoid misaligned reference UB
            let sub_format = std::ptr::read_unaligned(std::ptr::addr_of!(ext.SubFormat));
            if sub_format == SUBFMT_IEEE_FLOAT {
                SampleFormat::Float32
            } else {
                // PCM subformat — use wBitsPerSample
                match fmt.wBitsPerSample {
                    16 => SampleFormat::Int16,
                    24 => SampleFormat::Int24,
                    32 => SampleFormat::Int32,
                    _ => SampleFormat::Float32,
                }
            }
        }
        _ => SampleFormat::Float32, // safe fallback
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Convert raw PCM/float bytes to f32 samples
// ─────────────────────────────────────────────────────────────────────────────
unsafe fn convert_to_f32(data: *const u8, n: usize, fmt: SampleFormat) -> Vec<f32> {
    match fmt {
        SampleFormat::Float32 => {
            std::slice::from_raw_parts(data as *const f32, n).to_vec()
        }
        SampleFormat::Int16 => std::slice::from_raw_parts(data as *const i16, n)
            .iter()
            .map(|&s| s as f32 / 32_768.0)
            .collect(),
        SampleFormat::Int24 => (0..n)
            .map(|i| {
                let b0 = *data.add(i * 3) as i32;
                let b1 = *data.add(i * 3 + 1) as i32;
                let b2 = *data.add(i * 3 + 2) as i32;
                let raw = b0 | (b1 << 8) | (b2 << 16);
                let signed = if raw & 0x800000 != 0 { raw | !0x00FF_FFFF } else { raw };
                signed as f32 / 8_388_608.0
            })
            .collect(),
        SampleFormat::Int32 => std::slice::from_raw_parts(data as *const i32, n)
            .iter()
            .map(|&s| s as f32 / 2_147_483_648.0)
            .collect(),
    }
}
