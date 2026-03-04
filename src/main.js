const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const message = window.__TAURI__.dialog ? window.__TAURI__.dialog.message : window.alert;

// UI Elements
const badge = document.getElementById("status-badge");
const btnRecord = document.getElementById("btn-record");
const btnPause = document.getElementById("btn-pause");
const btnFile = document.getElementById("btn-file");
const fileInput = document.getElementById("file-input");
const btnCopy = document.getElementById("btn-copy");
const btnSave = document.getElementById("btn-save");
const outputText = document.getElementById("output-text");
const recordingIndicator = document.getElementById("recording-indicator");
const recordingStatusText = document.getElementById("recording-status-text");
const segmentBadge = document.getElementById("segment-badge");
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
let isPaused = false;
let mediaRecorder = null;
let audioChunks = [];
let modelSize = "small";
let modelQuantized = true;
let selectedMicId = "default";
let audioContext = null;
let analyzer = null;
let micStream = null;

// Session/Segment state
let sessionSegments = [];       // Array of {blob, startTime} objects
let currentSegmentChunks = [];  // Chunks for the currently-recording segment
let currentSegmentStartTime = null; // When the current segment started

// Chunk progress state (used by transcription_progress listener)
let currentChunkIdx = 0;
let totalChunks = 1;
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
    // Calculate overall progress across all chunks
    const overallProgress = Math.round((currentChunkIdx * 100 + progress) / totalChunks);
    if (progressContainer) progressContainer.classList.remove("hidden");
    if (progressBar) progressBar.style.width = `${overallProgress}%`;
    if (totalChunks > 1) {
      loadingText.innerText = `Transkriberar del ${currentChunkIdx + 1} av ${totalChunks}... (${overallProgress}%)`;
    } else {
      loadingText.innerText = `Transkriberar... ${overallProgress}%`;
    }
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
// Audio Recording Logic – Session/Segment model
// -------------------------------------------------------------
btnRecord.addEventListener("click", async () => {
  if (!isRecording && !isPaused) {
    // If there's existing transcription, warn the user
    if (outputText.value && outputText.value.trim()) {
      const confirmed = window.confirm(
        "Du har en transkribering som inte sparats.\n\n" +
        "En ny inspelning kommer att ersätta den.\n" +
        "Vill du fortsätta?"
      );
      if (!confirmed) return;
    }
    await startRecording();
  } else {
    await stopSession();
  }
});

// Pause/Resume button
btnPause.addEventListener("click", async () => {
  if (!isRecording && !isPaused) return;

  if (isRecording && !isPaused) {
    // Currently recording → Pause (save current segment)
    pauseSession();
  } else if (isPaused) {
    // Currently paused → Resume (start new segment)
    resumeSession();
  }
});

// Creates a new MediaRecorder on the existing micStream
function createRecorder() {
  const mrOptions = { audioBitsPerSecond: 64000 };
  let recorder;
  try {
    recorder = new MediaRecorder(micStream, mrOptions);
  } catch (e) {
    console.warn("Kunde inte sätta bitrate, använder standard.", e);
    recorder = new MediaRecorder(micStream);
  }

  currentSegmentChunks = [];
  currentSegmentStartTime = new Date();

  recorder.ondataavailable = event => {
    currentSegmentChunks.push(event.data);
  };

  // When recorder stops, save the segment blob with metadata
  recorder.onstop = () => {
    if (currentSegmentChunks.length > 0) {
      const segmentBlob = new Blob(currentSegmentChunks);
      sessionSegments.push({
        blob: segmentBlob,
        startTime: currentSegmentStartTime
      });
      console.log(`Del ${sessionSegments.length} sparad (${segmentBlob.size} bytes)`);
      updateSegmentBadge();
    }
    currentSegmentChunks = [];
  };

  return recorder;
}

function formatTimestamp(date) {
  return date.toLocaleString('sv-SE', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit'
  });
}

function updateSegmentBadge() {
  if (segmentBadge && sessionSegments.length > 0) {
    segmentBadge.classList.remove("hidden");
    segmentBadge.textContent = `Del ${sessionSegments.length}`;
  }
}

// Build a summary string like "Del 1, Del 2, Del 3"
function getRecordedPartsLabel() {
  if (sessionSegments.length === 0) return "";
  return sessionSegments.map((_, i) => `Del ${i + 1}`).join(", ");
}

async function startRecording() {
  try {
    const audioConstraints = selectedMicId === "default"
      ? { audio: true }
      : { audio: { deviceId: { exact: selectedMicId } } };

    micStream = await navigator.mediaDevices.getUserMedia(audioConstraints);

    // Reset session state
    sessionSegments = [];
    currentSegmentChunks = [];

    // --- Visualizer Setup ---
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    analyzer = audioContext.createAnalyser();
    const source = audioContext.createMediaStreamSource(micStream);
    source.connect(analyzer);
    analyzer.fftSize = 256;
    const bufferLength = analyzer.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    function drawVisualizer() {
      if (!isRecording) return;
      animationFrameId = requestAnimationFrame(drawVisualizer);
      analyzer.getByteFrequencyData(dataArray);
      let sum = 0;
      for (let i = 0; i < bufferLength; i++) sum += dataArray[i];
      const average = sum / bufferLength;
      if (audioLevelBar) {
        const scale = 1 + (average / 150);
        const clampedScale = Math.min(Math.max(scale, 1), 2.2);
        audioLevelBar.style.transform = `scale(${clampedScale})`;
      }
    }
    // ------------------------

    mediaRecorder = createRecorder();
    mediaRecorder.start(1000);
    isRecording = true;
    isPaused = false;
    drawVisualizer();

    // UI Updates
    btnRecord.classList.add("recording");
    btnRecord.querySelector(".btn-text").textContent = "Stoppa & transkribera";
    recordingIndicator.classList.remove("hidden");
    if (recordingStatusText) recordingStatusText.textContent = "Spelar in Del 1";
    if (btnPause) {
      btnPause.classList.remove("hidden");
      btnPause.querySelector(".btn-pause-text").textContent = "Pausa inspelning";
      btnPause.querySelector(".material-symbols-outlined").textContent = "pause";
    }
    if (segmentBadge) segmentBadge.classList.add("hidden");
    disableControls();
    btnRecord.disabled = false;
    if (btnPause) btnPause.disabled = false;
  } catch (err) {
    console.error("startRecording error:", err);
    // Clean up on error
    if (micStream) {
      micStream.getTracks().forEach(track => track.stop());
      micStream = null;
    }
    if (audioContext && audioContext.state !== "closed") {
      audioContext.close();
    }
    isRecording = false;
    isPaused = false;
    enableControls();
    await message("Nekad mikrofonåtkomst eller så uppstod ett fel: " + (err.message || err), { title: 'Fel', kind: 'error' });
  }
}

function pauseSession() {
  if (!mediaRecorder || mediaRecorder.state === "inactive") return;

  // Stop the current recorder – onstop handler saves the segment
  mediaRecorder.stop();
  isRecording = false;
  isPaused = true;

  // Stop visualizer but keep micStream alive
  if (animationFrameId) cancelAnimationFrame(animationFrameId);
  if (audioLevelBar) audioLevelBar.style.transform = `scale(1)`;

  // UI Updates
  const partsLabel = getRecordedPartsLabel();
  if (recordingStatusText) {
    recordingStatusText.textContent = `Inspelning pausad | Inspelat: ${partsLabel}`;
    recordingStatusText.classList.remove("text-red-500");
    recordingStatusText.classList.add("text-amber-500");
  }
  if (audioLevelBar) {
    audioLevelBar.classList.remove("bg-red-500");
    audioLevelBar.classList.add("bg-amber-500");
  }
  btnPause.querySelector(".btn-pause-text").textContent = "Fortsätt inspelning";
  btnPause.querySelector(".material-symbols-outlined").textContent = "play_arrow";
}

function resumeSession() {
  if (!micStream) return;

  // Create a new recorder on the same mic stream
  mediaRecorder = createRecorder();
  mediaRecorder.start(1000);
  isRecording = true;
  isPaused = false;

  // Restart visualizer
  const bufferLength = analyzer.frequencyBinCount;
  const dataArray = new Uint8Array(bufferLength);
  function drawVisualizer() {
    if (!isRecording) return;
    animationFrameId = requestAnimationFrame(drawVisualizer);
    analyzer.getByteFrequencyData(dataArray);
    let sum = 0;
    for (let i = 0; i < bufferLength; i++) sum += dataArray[i];
    const average = sum / bufferLength;
    if (audioLevelBar) {
      const scale = 1 + (average / 150);
      const clampedScale = Math.min(Math.max(scale, 1), 2.2);
      audioLevelBar.style.transform = `scale(${clampedScale})`;
    }
  }
  drawVisualizer();

  // UI Updates
  const nextPart = sessionSegments.length + 1;
  const partsLabel = getRecordedPartsLabel();
  if (recordingStatusText) {
    recordingStatusText.textContent = partsLabel
      ? `Spelar in Del ${nextPart} | Inspelat: ${partsLabel}`
      : `Spelar in Del ${nextPart}`;
    recordingStatusText.classList.remove("text-amber-500");
    recordingStatusText.classList.add("text-red-500");
  }
  if (audioLevelBar) {
    audioLevelBar.classList.remove("bg-amber-500");
    audioLevelBar.classList.add("bg-red-500");
  }
  btnPause.querySelector(".btn-pause-text").textContent = "Pausa inspelning";
  btnPause.querySelector(".material-symbols-outlined").textContent = "pause";
}

async function stopSession() {
  // If still recording (not paused), stop the recorder first to capture last segment
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    await new Promise(resolve => {
      const origOnstop = mediaRecorder.onstop;
      mediaRecorder.onstop = () => {
        origOnstop();
        resolve();
      };
      mediaRecorder.stop();
    });
  }

  // Release microphone
  if (micStream) {
    micStream.getTracks().forEach(track => track.stop());
  }

  if (audioContext && audioContext.state !== "closed") {
    audioContext.close();
  }

  if (animationFrameId) cancelAnimationFrame(animationFrameId);
  if (audioLevelBar) audioLevelBar.style.transform = `scale(1)`;

  isRecording = false;
  isPaused = false;

  // UI Updates – reset
  btnRecord.classList.remove("recording");
  const btnText = btnRecord.querySelector(".btn-text");
  if (btnText) btnText.textContent = "Starta ny inspelning";
  recordingIndicator.classList.add("hidden");
  btnPause.classList.add("hidden");
  if (recordingStatusText) {
    recordingStatusText.textContent = "Spelar in...";
    recordingStatusText.classList.remove("text-amber-500");
    recordingStatusText.classList.add("text-red-500");
  }
  if (audioLevelBar) {
    audioLevelBar.classList.remove("bg-amber-500");
    audioLevelBar.classList.add("bg-red-500");
  }
  if (segmentBadge) segmentBadge.classList.add("hidden");
  disableControls();

  // Process segments
  if (sessionSegments.length > 0) {
    const segments = [...sessionSegments];
    sessionSegments = [];
    const multiSegment = segments.length > 1;

    if (multiSegment) {
      // Multiple segments: process each with section headers
      await processSegments(segments);
    } else {
      // Single segment (no pauses): process normally without headers
      await processAudioBlob(segments[0].blob);
    }
  } else {
    enableControls();
  }
}

// Process multiple segments with section headers
async function processSegments(segments) {
  try {
    loadingText.innerText = "Bearbetar ljud...";
    loadingOverlay.classList.remove("hidden");
    if (progressContainer) progressContainer.classList.add("hidden");
    outputText.value = "";

    const startTime = performance.now();

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const partNum = i + 1;
      const timestamp = formatTimestamp(seg.startTime);

      loadingText.innerText = `Transkriberar Del ${partNum} av ${segments.length}...`;

      // Add section header
      if (outputText.value) outputText.value += "\n\n";
      outputText.value += `// Start Del ${partNum} (${timestamp})\n\n`;
      outputText.scrollTop = outputText.scrollHeight;

      // Transcribe this segment
      const segmentText = await transcribeBlob(seg.blob, `Del ${partNum}`);

      if (segmentText && segmentText.trim()) {
        outputText.value += segmentText.trim();
      } else {
        outputText.value += "[Ingen text transkriberad]";
      }

      // Add section footer
      outputText.value += `\n\n// Slut Del ${partNum}`;
      outputText.scrollTop = outputText.scrollHeight;
    }

    // Final elapsed time
    const elapsedMs = performance.now() - startTime;
    const elapsedSec = Math.round(elapsedMs / 1000);
    const elapsedMin = Math.floor(elapsedSec / 60);
    const elapsedRemSec = elapsedSec % 60;
    const elapsedStr = elapsedMin > 0 ? `${elapsedMin}m ${elapsedRemSec}s` : `${elapsedSec}s`;

    if (progressBar) progressBar.style.width = "100%";
    loadingText.innerText = `Klar! (${elapsedStr})`;
    outputText.value += `\n\n[Transkribering klar: ${segments.length} delar, ${elapsedStr}]`;
    outputText.scrollTop = outputText.scrollHeight;

  } catch (err) {
    console.error("processSegments error:", err);
    const errorMsg = typeof err === 'string' ? err : err.message || String(err);
    await message(`Transkribering misslyckades: ${errorMsg}`, { title: 'Fel', kind: 'error' });
  } finally {
    loadingOverlay.classList.add("hidden");
    enableControls();
  }
}

// Transcribe a single blob and return the text (used by processSegments)
async function transcribeBlob(blob, label) {
  const arrayBuffer = await blob.arrayBuffer();
  const decodeCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
  const audioBuffer = await decodeCtx.decodeAudioData(arrayBuffer);
  const float32Data = audioBuffer.getChannelData(0);
  const totalSamples = float32Data.length;

  const numChunks = Math.ceil(totalSamples / CHUNK_SAMPLES);
  totalChunks = numChunks;
  currentChunkIdx = 0;

  if (progressContainer) progressContainer.classList.remove("hidden");
  if (progressBar) progressBar.style.width = "0%";

  let result = "";

  for (let chunkIdx = 0; chunkIdx < numChunks; chunkIdx++) {
    currentChunkIdx = chunkIdx;
    const start = chunkIdx * CHUNK_SAMPLES;
    const end = Math.min(start + CHUNK_SAMPLES, totalSamples);
    const chunkFloat32 = float32Data.slice(start, end);
    const chunkBytes = new Uint8Array(chunkFloat32.buffer, chunkFloat32.byteOffset, chunkFloat32.byteLength);
    const chunkBytesArray = Array.from(chunkBytes);

    try {
      const chunkText = await invoke("transcribe_audio", {
        audioBytes: chunkBytesArray,
        size: modelSize,
        quantized: modelQuantized
      });
      if (chunkText && chunkText.trim()) {
        if (result) result += "\n";
        result += chunkText.trim();
      }
    } catch (chunkErr) {
      console.error(`${label} chunk ${chunkIdx + 1} failed:`, chunkErr);
      result += `\n[Fel i ${label}, del ${chunkIdx + 1}: ${chunkErr}]`;
    }
  }

  return result;
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
// Audio Processing and Transcription (chunked for large files)
// -------------------------------------------------------------

// Max chunk size: 5 minutes of audio at 16kHz mono
const CHUNK_DURATION_SECONDS = 300; // 5 minutes
const CHUNK_SAMPLES = 16000 * CHUNK_DURATION_SECONDS;

async function processAudioBlob(blob) {
  try {
    // Show Loading
    loadingText.innerText = "Bearbetar ljud...";
    loadingOverlay.classList.remove("hidden");
    if (progressContainer) progressContainer.classList.add("hidden");

    // Clear previous output text before starting
    outputText.value = "";

    // Convert Blob/File to ArrayBuffer
    const arrayBuffer = await blob.arrayBuffer();

    // Resample to 16kHz Float32 for whisper-rs
    const decodeCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    const audioBuffer = await decodeCtx.decodeAudioData(arrayBuffer);

    // Get PCM samples from first channel (mono)
    const float32Data = audioBuffer.getChannelData(0);
    const totalSamples = float32Data.length;
    const totalDuration = (totalSamples / 16000).toFixed(0);

    console.log(`Audio decoded: ${totalSamples} samples (${totalDuration}s)`);

    // Calculate number of chunks
    const numChunks = Math.ceil(totalSamples / CHUNK_SAMPLES);

    // Set global chunk state for the progress listener
    totalChunks = numChunks;
    currentChunkIdx = 0;

    const durationMin = Math.floor(totalDuration / 60);
    const durationSec = totalDuration % 60;
    const durationStr = durationMin > 0 ? `${durationMin}m ${durationSec}s` : `${durationSec}s`;
    loadingText.innerText = `Transkriberar ${durationStr} ljud...`;
    if (progressContainer) progressContainer.classList.remove("hidden");
    if (progressBar) progressBar.style.width = "0%";

    // Start timer
    const startTime = performance.now();

    let fullResult = "";

    for (let chunkIdx = 0; chunkIdx < numChunks; chunkIdx++) {
      currentChunkIdx = chunkIdx;

      const start = chunkIdx * CHUNK_SAMPLES;
      const end = Math.min(start + CHUNK_SAMPLES, totalSamples);
      const chunkFloat32 = float32Data.slice(start, end);

      // Convert Float32Array chunk to byte array for Rust
      const chunkBytes = new Uint8Array(chunkFloat32.buffer, chunkFloat32.byteOffset, chunkFloat32.byteLength);
      const chunkBytesArray = Array.from(chunkBytes);

      console.log(`Sending chunk ${chunkIdx + 1}/${numChunks}: ${chunkFloat32.length} samples (${chunkBytesArray.length} bytes)`);

      try {
        const chunkText = await invoke("transcribe_audio", {
          audioBytes: chunkBytesArray,
          size: modelSize,
          quantized: modelQuantized
        });

        if (chunkText && chunkText.trim()) {
          if (fullResult) fullResult += "\n";
          fullResult += chunkText.trim();
          outputText.value = fullResult;
          outputText.scrollTop = outputText.scrollHeight;
        }
      } catch (chunkErr) {
        console.error(`Chunk ${chunkIdx + 1} failed:`, chunkErr);
        const errorMsg = typeof chunkErr === 'string' ? chunkErr : chunkErr.message || String(chunkErr);
        outputText.value += `\n\n[Fel i del ${chunkIdx + 1}: ${errorMsg}]`;
        // Continue with next chunk instead of aborting entirely
      }
    }

    // Final progress + elapsed time
    if (progressBar) progressBar.style.width = "100%";
    const elapsedMs = performance.now() - startTime;
    const elapsedSec = Math.round(elapsedMs / 1000);
    const elapsedMin = Math.floor(elapsedSec / 60);
    const elapsedRemSec = elapsedSec % 60;
    const elapsedStr = elapsedMin > 0 ? `${elapsedMin}m ${elapsedRemSec}s` : `${elapsedSec}s`;
    loadingText.innerText = `Klar! (${elapsedStr})`;

    // Show elapsed time in the output text so user can see it
    outputText.value += `\n\n[Transkribering klar: ${elapsedStr}]`;
    outputText.scrollTop = outputText.scrollHeight;

    if (!outputText.value.trim()) {
      outputText.value = fullResult || "[Ingen text transkriberad]";
    }

  } catch (err) {
    console.error("Transcription error:", err);
    if (typeof err === 'string' && err.includes("canceled")) {
      outputText.value += "\n\n[Transkribering avbruten]";
    } else {
      const errorMsg = typeof err === 'string' ? err : err.message || String(err);
      await message(`Transkribering misslyckades: ${errorMsg}`, { title: 'Fel', kind: 'error' });
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

// -------------------------------------------------------------
// Save to File Logic
// -------------------------------------------------------------
btnSave.addEventListener("click", async () => {
  if (!outputText.value || !outputText.value.trim()) return;
  try {
    const content = outputText.value;
    await invoke("save_text_file", { content });
  } catch (err) {
    console.error("Save error:", err);
    const errorMsg = typeof err === 'string' ? err : err.message || String(err);
    if (!errorMsg.includes("cancelled") && !errorMsg.includes("canceled")) {
      await message(`Kunde inte spara filen: ${errorMsg}`, { title: 'Fel', kind: 'error' });
    }
  }
});

// Run Init
window.addEventListener("DOMContentLoaded", initialize);
