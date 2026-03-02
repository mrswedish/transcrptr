const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const message = window.__TAURI__.dialog ? window.__TAURI__.dialog.message : window.alert;

// UI Elements
const badge = document.getElementById("status-badge");
const btnRecord = document.getElementById("btn-record");
const btnFile = document.getElementById("btn-file");
const fileInput = document.getElementById("file-input");
const btnCopy = document.getElementById("btn-copy");
const outputText = document.getElementById("output-text");
const recordingIndicator = document.getElementById("recording-indicator");
const loadingOverlay = document.getElementById("loading-overlay");
const loadingText = document.getElementById("loading-text");
const progressContainer = document.getElementById("progress-container");
const progressBar = document.getElementById("progress-bar");

// Settings Elements
const btnSettings = document.getElementById("btn-settings");
const settingsModal = document.getElementById("settings-modal");
const btnCloseSettings = document.getElementById("btn-close-settings");
const btnSaveSettings = document.getElementById("btn-save-settings");
const selModelSize = document.getElementById("model-size");
const selModelQuantized = document.getElementById("model-quantized");
const selMic = document.getElementById("mic-select");
const audioLevelBar = document.getElementById("audio-level-bar");

// State
let isRecording = false;
let mediaRecorder = null;
let audioChunks = [];
let modelSize = "medium";
let modelQuantized = true;
let selectedMicId = "default";
let audioContext = null;
let analyzer = null;
let micStream = null;
let animationFrameId = null;

// Load config from local storage
function loadSettings() {
  const size = localStorage.getItem("modelSize");
  const quantized = localStorage.getItem("modelQuantized");
  const micId = localStorage.getItem("selectedMicId");

  if (size) modelSize = size;
  if (quantized !== null) modelQuantized = quantized === "true";
  if (micId) selectedMicId = micId;

  selModelSize.value = modelSize;
  selModelQuantized.value = modelQuantized.toString();
}

// Load available microphones
async function loadMicrophones() {
  if (!selMic) return;
  try {
    // Request permission first, otherwise labels might be empty
    await navigator.mediaDevices.getUserMedia({ audio: true });
    const devices = await navigator.mediaDevices.enumerateDevices();
    const audioInputDevices = devices.filter(device => device.kind === 'audioinput');

    selMic.innerHTML = '';

    // Add default option
    const defaultOption = document.createElement("option");
    defaultOption.value = "default";
    defaultOption.text = "Systemets standardmikrofon";
    selMic.appendChild(defaultOption);

    audioInputDevices.forEach(device => {
      // Skip the duplicated default entry usually provided by browsers
      if (device.deviceId === "default" || device.deviceId === "communications") return;

      const option = document.createElement("option");
      option.value = device.deviceId;
      option.text = device.label || `Mikrofon ${selMic.length}`;
      selMic.appendChild(option);
    });

    selMic.value = selectedMicId;
  } catch (err) {
    console.warn("Kunde inte ladda mikrofoner:", err);
  }
}

// Setup Event Listeners from Rust
async function setupEventListeners() {
  await listen("download_progress", (event) => {
    const { progress, downloaded, total } = event.payload;
    if (progressContainer) progressContainer.classList.remove("hidden");
    if (progressBar) progressBar.style.width = `${progress}%`;
    const dlMb = (downloaded / 1048576).toFixed(1);
    const totMb = (total / 1048576).toFixed(1);
    loadingText.innerText = `Laddar ner modell... ${dlMb}MB / ${totMb}MB`;
  });

  await listen("transcription_segment", (event) => {
    const { text } = event.payload;
    // Append the newly transcribed chunk immediately with a newline
    if (outputText.value) {
      outputText.value += '\n' + text;
    } else {
      outputText.value += text;
    }
    // Auto-scroll
    outputText.scrollTop = outputText.scrollHeight;
  });

  await listen("transcription_progress", (event) => {
    const { progress } = event.payload;
    if (progressContainer) progressContainer.classList.remove("hidden");
    if (progressBar) progressBar.style.width = `${progress}%`;
    loadingText.innerText = `Transkriberar... ${progress}%`;
  });
}

// Initialize Application
async function initialize() {
  loadSettings();
  await loadMicrophones();
  setupEventListeners();
  await ensureModelReady();
}

async function ensureModelReady() {
  disableControls();
  try {
    updateBadge("Kontrollerar modell...", "");
    const exists = await invoke("check_model_exists", { size: modelSize, quantized: modelQuantized });
    if (!exists) {
      updateBadge("Laddar ner...", "");
      loadingText.innerText = `Förbereder nedladdning av ${modelSize}...`;
      loadingOverlay.classList.remove("hidden");
      if (progressContainer) progressContainer.classList.remove("hidden");
      if (progressBar) progressBar.style.width = "0%";

      await invoke("download_model", { size: modelSize, quantized: modelQuantized });

      loadingOverlay.classList.add("hidden");
      if (progressContainer) progressContainer.classList.add("hidden");
    }

    const fmtName = modelQuantized ? `${modelSize} q5_0` : modelSize;
    updateBadge(`Redo (${fmtName})`, "ready");
    enableControls();
  } catch (error) {
    console.error(error);
    updateBadge("Modellfel", "error");
    loadingOverlay.classList.add("hidden");
    if (progressContainer) progressContainer.classList.add("hidden");
    await message(`Misslyckades att initiera modellan: ${error}`, { title: 'Fel', kind: 'error' });
  }
}

function updateBadge(text, className) {
  if (!badge) return;
  badge.textContent = text;
  badge.className = "text-[10px] font-bold uppercase tracking-wider";
  if (className === "ready") {
    badge.classList.add("text-slate-500", "dark:text-slate-400");
  } else if (className === "error") {
    badge.classList.add("text-red-500");
  } else {
    badge.classList.add("text-primary");
  }
}

function enableControls() {
  btnRecord.disabled = false;
  btnFile.disabled = false;
  btnSettings.disabled = false;
}

function disableControls() {
  btnRecord.disabled = true;
  btnFile.disabled = true;
  btnSettings.disabled = true;
}

// -------------------------------------------------------------
// Settings Logic
// -------------------------------------------------------------
btnSettings.addEventListener("click", () => {
  loadSettings(); // refresh form
  settingsModal.classList.remove("hidden");
});

btnCloseSettings.addEventListener("click", () => {
  settingsModal.classList.add("hidden");
});

btnSaveSettings.addEventListener("click", async () => {
  const newSize = selModelSize.value;
  const newQuant = selModelQuantized.value === "true";
  const newMicId = selMic ? selMic.value : "default";

  localStorage.setItem("modelSize", newSize);
  localStorage.setItem("modelQuantized", newQuant.toString());
  localStorage.setItem("selectedMicId", newMicId);

  modelSize = newSize;
  modelQuantized = newQuant;
  selectedMicId = newMicId;

  settingsModal.classList.add("hidden");

  // Re-check and download if needed
  await ensureModelReady();
});

// -------------------------------------------------------------
// Audio Recording Logic using Web Audio API to convert to 16kHz
// -------------------------------------------------------------
btnRecord.addEventListener("click", async () => {
  if (!isRecording) {
    await startRecording();
  } else {
    stopRecording();
  }
});

async function startRecording() {
  try {
    const audioConstraints = selectedMicId === "default"
      ? { audio: true }
      : { audio: { deviceId: { exact: selectedMicId } } };

    micStream = await navigator.mediaDevices.getUserMedia(audioConstraints);

    // Set a lower bitrate (e.g. 64kbps) to save RAM on long recordings
    const mrOptions = {
      audioBitsPerSecond: 64000
    };

    try {
      mediaRecorder = new MediaRecorder(micStream, mrOptions);
    } catch (e) {
      // Fallback if the browser doesn't support setting the bitrate or codec
      console.warn("Kunde inte sätta bitrate, använder standard.", e);
      mediaRecorder = new MediaRecorder(micStream);
    }

    audioChunks = [];

    // --- Visualizer Setup ---
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    analyzer = audioContext.createAnalyser();
    const source = audioContext.createMediaStreamSource(micStream);
    source.connect(analyzer);

    // Fast fourier transform size, higher = more detailed, lower = faster
    analyzer.fftSize = 256;
    const bufferLength = analyzer.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    function drawVisualizer() {
      if (!isRecording) return;
      animationFrameId = requestAnimationFrame(drawVisualizer);

      analyzer.getByteFrequencyData(dataArray);

      // Calculate overall volume (average)
      let sum = 0;
      for (let i = 0; i < bufferLength; i++) {
        sum += dataArray[i];
      }
      const average = sum / bufferLength;

      // Scale the UI dot based on average volume (e.g., scale between 1 and 1.8)
      if (audioLevelBar) {
        // average usually ranges from 0 to ~100 in normal speech
        const scale = 1 + (average / 150);
        // clamp scale to reasonable sizes
        const clampedScale = Math.min(Math.max(scale, 1), 2.2);
        audioLevelBar.style.transform = `scale(${clampedScale})`;
      }
    }
    // ------------------------

    mediaRecorder.ondataavailable = event => {
      audioChunks.push(event.data);
    };

    mediaRecorder.onstop = async () => {
      const audioBlob = new Blob(audioChunks);
      await processAudioBlob(audioBlob);
    };

    mediaRecorder.start(1000); // Collect data in 1 second chunks for streaming/safety conceptually
    isRecording = true;
    drawVisualizer(); // Start the visualizer loop

    // UI Updates
    btnRecord.classList.add("recording");
    btnRecord.querySelector(".btn-text").textContent = "Stoppa inspelning";
    recordingIndicator.classList.remove("hidden");
    disableControls();
    btnRecord.disabled = false; // Re-enable so we can stop
  } catch (err) {
    console.error("Error accessing microphone:", err);
    await message("Nekad mikrofonåtkomst eller så uppstod ett fel.", { title: 'Fel', kind: 'error' });
  }
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
  }

  if (micStream) {
    micStream.getTracks().forEach(track => track.stop());
  }

  if (audioContext && audioContext.state !== "closed") {
    audioContext.close();
  }

  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId);
  }

  // reset visualizer dot
  if (audioLevelBar) {
    audioLevelBar.style.transform = `scale(1)`;
  }

  isRecording = false;

  // UI Updates
  btnRecord.classList.remove("recording");
  const btnText = btnRecord.querySelector(".btn-text");
  if (btnText) btnText.textContent = "Starta inspelning";
  recordingIndicator.classList.add("hidden");
  disableControls(); // Re-disabled until processing finishes
}

// -------------------------------------------------------------
// File Selection Logic
// -------------------------------------------------------------
btnFile.addEventListener("click", () => {
  fileInput.click();
});

fileInput.addEventListener("change", async (e) => {
  if (e.target.files.length > 0) {
    const file = e.target.files[0];
    disableControls();
    await processAudioBlob(file);
    // Reset file input
    fileInput.value = "";
  }
});

// -------------------------------------------------------------
// Audio Processing and Transcription
// -------------------------------------------------------------
async function processAudioBlob(blob) {
  try {
    // Show Loading
    loadingText.innerText = "Bearbetar ljud...";
    loadingOverlay.classList.remove("hidden");
    if (progressContainer) progressContainer.classList.add("hidden"); // disable progress bar initially

    // Clear previous output text before starting
    outputText.value = "";

    // Convert Blob/File to ArrayBuffer
    const arrayBuffer = await blob.arrayBuffer();

    // Resample to 16kHz Float32 for whisper-rs
    const audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

    // Convert Float32Array directly to an array of bytes (Uint8Array)
    // This stops browser from creating a 57-million-item JS Array which crashes JSON stringification
    const float32Data = audioBuffer.getChannelData(0);
    const byteData = new Uint8Array(float32Data.buffer, float32Data.byteOffset, float32Data.byteLength);
    const byteDataArray = Array.from(byteData); // Uint8Array to regular array of bytes

    loadingText.innerText = `Transkriberar i bakgrunden... (${float32Data.length} ljudprover)`;

    console.log(`Sending ${float32Data.length} samples (${byteDataArray.length} bytes) to Rust for transcription.`);

    // Invoke Rust Command
    // The event listener for 'transcription_segment' will append text as it processes
    const finalTranscribedText = await invoke("transcribe_audio", {
      audioBytes: byteDataArray,
      size: modelSize,
      quantized: modelQuantized
    });

    // As a fallback to guarantee we didn't miss anything, we can set it at the end.
    // However, since we're streaming with newlines now, let's just make sure it's fully populated.
    if (!outputText.value.trim()) {
      outputText.value = finalTranscribedText;
    }

  } catch (err) {
    console.error("Transcription error:", err);
    if (typeof err === 'string' && err.includes("canceled")) {
      outputText.value += "\n\n[Transkribering avbruten]";
    } else {
      await message(`Transkribering misslyckades: ${err}`, { title: 'Fel', kind: 'error' });
    }
  } finally {
    loadingOverlay.classList.add("hidden");
    enableControls();
  }
}

// -------------------------------------------------------------
// Copy Logic
// -------------------------------------------------------------
btnCopy.addEventListener("click", () => {
  if (outputText.value) {
    navigator.clipboard.writeText(outputText.value).then(() => {
      const prevIcon = btnCopy.innerHTML;
      btnCopy.innerHTML = `<span class="icon">✅</span> Kopierad!`;
      setTimeout(() => {
        btnCopy.innerHTML = prevIcon;
      }, 2000);
    });
  }
});

// Run Init
window.addEventListener("DOMContentLoaded", initialize);
