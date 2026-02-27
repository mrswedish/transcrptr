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

// State
let isRecording = false;
let mediaRecorder = null;
let audioChunks = [];
let modelSize = "medium";
let modelQuantized = true;

// Load config from local storage
function loadSettings() {
  const size = localStorage.getItem("modelSize");
  const quantized = localStorage.getItem("modelQuantized");
  if (size) modelSize = size;
  if (quantized !== null) modelQuantized = quantized === "true";

  selModelSize.value = modelSize;
  selModelQuantized.value = modelQuantized.toString();
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

  localStorage.setItem("modelSize", newSize);
  localStorage.setItem("modelQuantized", newQuant.toString());

  modelSize = newSize;
  modelQuantized = newQuant;

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
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // Use an audio format that is broadly compatible
    mediaRecorder = new MediaRecorder(stream);
    audioChunks = [];

    mediaRecorder.ondataavailable = event => {
      audioChunks.push(event.data);
    };

    mediaRecorder.onstop = async () => {
      const audioBlob = new Blob(audioChunks);
      await processAudioBlob(audioBlob);
    };

    mediaRecorder.start();
    isRecording = true;

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
    // Stop tracks to release mic
    mediaRecorder.stream.getTracks().forEach(track => track.stop());
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

    // Get PCM samples from first channel (mono)
    const float32Data = audioBuffer.getChannelData(0);
    const samples = Array.from(float32Data);

    loadingText.innerText = `Transkriberar i bakgrunden... (${samples.length} ljudprover)`;

    console.log(`Sending ${samples.length} samples to Rust for transcription.`);

    // Invoke Rust Command
    // The event listener for 'transcription_segment' will append text as it processes
    const finalTranscribedText = await invoke("transcribe_audio", {
      samples: samples,
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
