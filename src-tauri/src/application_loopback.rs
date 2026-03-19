#![cfg(target_os = "windows")]

extern crate windows_core;

use std::sync::{Arc, Mutex};
use windows::{
    core::*,
    Win32::Foundation::*,
    Win32::Media::Audio::*,
    Win32::System::Com::*,
    Win32::System::Threading::*,
};
use std::sync::atomic::{AtomicBool, Ordering};

// COM interfaces are MTA-safe when CoInitializeEx(COINIT_MULTITHREADED) is used.
// We declare Send+Sync so Tauri state and thread::spawn work.
unsafe impl Send for ApplicationLoopback {}
unsafe impl Sync for ApplicationLoopback {}

#[implement(IActivateAudioInterfaceCompletionHandler)]
struct Handler {
    audio_client: Arc<Mutex<Option<IAudioClient>>>,
    event: HANDLE,
}

impl Handler {
    fn new(audio_client: Arc<Mutex<Option<IAudioClient>>>, event: HANDLE) -> Self {
        Self { audio_client, event }
    }
}

impl IActivateAudioInterfaceCompletionHandler_Impl for Handler_Impl {
    fn ActivateCompleted(&self, activate_operation: Ref<IActivateAudioInterfaceAsyncOperation>) -> Result<()> {
        let mut activate_result = HRESULT(0);
        let mut activated_interface: Option<IUnknown> = None;

        unsafe {
            activate_operation.GetActivateResult(&mut activate_result, &mut activated_interface)?;
            if activate_result.is_ok() {
                if let Some(iface) = activated_interface {
                    let client: IAudioClient = iface.cast()?;
                    *self.audio_client.lock().unwrap() = Some(client);
                }
            }
            SetEvent(self.event)?;
        }
        Ok(())
    }
}

pub struct ApplicationLoopback {
    audio_client: Option<IAudioClient>,
    capture_client: Option<IAudioCaptureClient>,
    format: WAVEFORMATEX,
    buffer_event: HANDLE,
    active: Arc<AtomicBool>,
}

impl ApplicationLoopback {
    pub fn new(exclude_pid: Option<u32>) -> Result<Self> {
        unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED).ok()?;

            let audio_client_shared = Arc::new(Mutex::new(None));
            let completion_event = CreateEventW(None, true, false, None)?;

            let handler: IActivateAudioInterfaceCompletionHandler = Handler::new(
                Arc::clone(&audio_client_shared),
                completion_event,
            ).into();

            // Set up activation params for Application Loopback API
            // (Windows 10 build 20348+ / Windows 11)
            let mut params = AUDIOCLIENT_ACTIVATION_PARAMS {
                ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
                Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
                    ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                        TargetProcessId: exclude_pid.unwrap_or(GetCurrentProcessId()),
                        ProcessLoopbackMode: PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE,
                    },
                },
            };

            let _operation = ActivateAudioInterfaceAsync(
                VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
                &IAudioClient::IID,
                Some(&mut params as *mut _ as *mut _),
                &handler,
            )?;

            // Wait for async activation (timeout 2s)
            let wait_res = WaitForSingleObject(completion_event, 2000);
            let _ = CloseHandle(completion_event);

            if wait_res != WAIT_OBJECT_0 {
                return Err(Error::from_win32());
            }

            let audio_client = audio_client_shared.lock().unwrap().take()
                .ok_or_else(|| Error::from_win32())?;

            // Get mix format
            let mut format_ptr: *mut WAVEFORMATEX = std::ptr::null_mut();
            audio_client.GetMixFormat(&mut format_ptr)?;
            let format = *format_ptr;

            audio_client.Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                0,
                0,
                format_ptr,
                None,
            )?;

            let buffer_event = CreateEventW(None, false, false, None)?;
            audio_client.SetEventHandle(buffer_event)?;

            let capture_client: IAudioCaptureClient = audio_client.GetService()?;

            Ok(Self {
                audio_client: Some(audio_client),
                capture_client: Some(capture_client),
                format,
                buffer_event,
                active: Arc::new(AtomicBool::new(false)),
            })
        }
    }

    pub fn start(&self) -> Result<()> {
        unsafe {
            if let Some(client) = &self.audio_client {
                client.Start()?;
                self.active.store(true, Ordering::SeqCst);
            }
            Ok(())
        }
    }

    pub fn stop(&self) -> Result<()> {
        self.active.store(false, Ordering::SeqCst);
        unsafe {
            if let Some(client) = &self.audio_client {
                let _ = client.Stop();
            }
            Ok(())
        }
    }

    pub fn is_active(&self) -> bool {
        self.active.load(Ordering::SeqCst)
    }

    pub fn read_samples(&self) -> Vec<f32> {
        let mut all_samples = Vec::new();
        unsafe {
            let capture = match &self.capture_client {
                Some(c) => c,
                None => return all_samples,
            };

            loop {
                let mut data: *mut u8 = std::ptr::null_mut();
                let mut frames_available: u32 = 0;
                let mut flags: u32 = 0;

                let res = capture.GetBuffer(
                    &mut data,
                    &mut frames_available,
                    &mut flags,
                    None,
                    None,
                );

                if res.is_err() || frames_available == 0 {
                    break;
                }

                let channels = self.format.nChannels as usize;
                let n = frames_available as usize * channels;

                if (flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) == 0 {
                    let slice = std::slice::from_raw_parts(data as *const f32, n);
                    all_samples.extend_from_slice(slice);
                } else {
                    all_samples.extend(std::iter::repeat(0.0f32).take(n));
                }

                let _ = capture.ReleaseBuffer(frames_available);
            }
        }
        all_samples
    }

    pub fn wait_for_buffer(&self, timeout_ms: u32) -> bool {
        unsafe {
            WaitForSingleObject(self.buffer_event, timeout_ms) == WAIT_OBJECT_0
        }
    }

    pub fn get_sample_rate(&self) -> u32 {
        self.format.nSamplesPerSec
    }

    pub fn get_channels(&self) -> u16 {
        self.format.nChannels
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
