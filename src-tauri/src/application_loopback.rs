#![cfg(target_os = "windows")]

use std::sync::{Arc, Mutex};
use windows::{
    core::*,
    Win32::Foundation::*,
    Win32::Media::Audio::*,
    Win32::System::Com::*,
    Win32::System::Threading::*,
    Win32::Media::Audio::Wasapi::*,
};
use std::sync::atomic::{AtomicBool, Ordering};

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

impl IActivateAudioInterfaceCompletionHandler_Impl for Handler {
    fn ActivateCompleted(&self, activate_operation: Ref<'_, IActivateAudioInterfaceAsyncOperation>) -> Result<()> {
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

            let mut params = AUDIOCLIENT_ACTIVATION_PARAMS::default();
            params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
            
            // Loopback parameters
            let mut lb_params = PROCESS_LOOPBACK_CAPTURE_INFORMATION::default();
            lb_params.ProcessId = exclude_pid.unwrap_or(GetCurrentProcessId());
            lb_params.ProcessLoopbackMode = PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS;

            params.Anonymous.ProcessLoopbackParams = &lb_params;

            let _operation = ActivateAudioInterfaceAsync(
                VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
                &IAudioClient::IID,
                Some(&params),
                &handler,
            )?;

            // Wait for activation (timeout after 2s)
            let wait_res = WaitForSingleObject(completion_event, 2000);
            CloseHandle(completion_event)?;

            if wait_res != WAIT_OBJECT_0.0 {
                return Err(Error::from_win32());
            }

            let audio_client = audio_client_shared.lock().unwrap().take()
                .ok_or_else(|| Error::from_win32())?;

            // Get format
            let mut format_ptr: *mut WAVEFORMATEX = std::ptr::null_mut();
            audio_client.GetMixFormat(&mut format_ptr)?;
            let format = *format_ptr;

            // Initialize in shared mode with loopback
            // Note: AUDCLNT_STREAMFLAGS_LOOPBACK is NOT needed for this new API type
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
                let mut device_position: u64 = 0;
                let mut qpc_position: u64 = 0;

                let res = capture.GetBuffer(
                    &mut data,
                    &mut frames_available,
                    &mut flags,
                    Some(&mut device_position),
                    Some(&mut qpc_position),
                );

                if res.is_err() || frames_available == 0 {
                    break;
                }

                let channels = self.format.nChannels as usize;
                let data_slice = std::slice::from_raw_parts(data as *const f32, frames_available as usize * channels);
                
                // If it's silent or invalid, handle it?
                if (flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) == 0 {
                    all_samples.extend_from_slice(data_slice);
                } else {
                    all_samples.extend(std::iter::repeat(0.0).take(frames_available as usize * channels));
                }

                let _ = capture.ReleaseBuffer(frames_available);
            }
        }
        all_samples
    }

    pub fn wait_for_buffer(&self, timeout_ms: u32) -> bool {
        unsafe {
            WaitForSingleObject(self.buffer_event, timeout_ms) == WAIT_OBJECT_0.0
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
        unsafe {
            let _ = self.stop();
            if !self.buffer_event.is_invalid() {
                let _ = CloseHandle(self.buffer_event);
            }
        }
    }
}
