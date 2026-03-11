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

// New UI Elements
const recordingTimer = document.getElementById("recording-timer");
const recordingSize = document.getElementById("recording-size");
const diskForecast = document.getElementById("disk-forecast");
const footerMic = document.getElementById("footer-mic");
const footerModel = document.getElementById("footer-model");
const footerDisk = document.getElementById("footer-disk");
const modelList = document.getElementById("model-list");
const smallModelWarning = document.getElementById("small-model-warning");
const btnRedo = document.getElementById("btn-redo");

// Settings Elements
const btnSettings = document.getElementById("btn-settings");
const settingsModal = document.getElementById("settings-modal");
const btnCloseSettings = document.getElementById("btn-close-settings");
const btnSaveSettings = document.getElementById("btn-save-settings");
const selModelSize = document.getElementById("model-size");
const selModelQuantized = document.getElementById("model-quantized");
const selLanguage = document.getElementById("transcription-language");
const selMic = document.getElementById("mic-select");
const audioLevelBar = document.getElementById("audio-level-bar");

// Confirm modal elements
const confirmModal = document.getElementById("confirm-modal");
const confirmOk = document.getElementById("confirm-ok");
const confirmCancel = document.getElementById("confirm-cancel");

// State
let isRecording = false;
let isPaused = false;
let mediaRecorder = null;
let audioChunks = [];
let modelSize = "small";
let modelQuantized = true;
let transcriptionLanguage = "sv";
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

// New Recording Metrics State
let recordingStartTime = null;
let recordingTimerInterval = null;
let estimatedRecordingSize = 0;
let lastRecordedSegments = []; // Store for "Redo" feature

// Load config from local storage
function loadSettings() {
  const size = localStorage.getItem("modelSize");
  const quantized = localStorage.getItem("modelQuantized");
  const lang = localStorage.getItem("transcriptionLanguage");
  const micId = localStorage.getItem("selectedMicId");

  if (size) modelSize = size;
  if (quantized !== null) modelQuantized = quantized === "true";
  if (lang) transcriptionLanguage = lang;
  if (micId) selectedMicId = micId;

  selModelSize.value = modelSize;
  selModelQuantized.value = modelQuantized.toString();
  if (selLanguage) selLanguage.value = transcriptionLanguage;
  
  // Show/hide small model warning
  if (smallModelWarning) {
    if (modelSize === "small") {
      smallModelWarning.classList.remove("hidden");
    } else {
      smallModelWarning.classList.add("hidden");
    }
  }

  updateFooter();
}

// Update the footer information bar
function updateFooter() {
  if (footerMic) {
    const micLabel = Array.from(selMic.options).find(opt => opt.value === selectedMicId)?.text || "Standardmikrofon";
    footerMic.innerText = micLabel;
  }
  if (footerModel) {
    const fmtName = modelQuantized ? `${modelSize} (kvantiserad)` : modelSize;
    footerModel.innerText = fmtName;
  }
  updateDiskInfo();
}

async function updateDiskInfo() {
  try {
    const info = await invoke("get_disk_info");
    if (footerDisk) {
      const freeGb = (info.available_space / (1024 * 1024 * 1024)).toFixed(1);
      footerDisk.innerText = `Ledigt: ${freeGb} GB`;
    }
    
    // Update forecast if we are recording
    if (isRecording) {
      updateDiskForecast(info.available_space);
    }
  } catch (err) {
    console.warn("Kunde inte ladda diskinfo:", err);
  }
}

// Load available microphones
let firstMicDeviceId = null; // Actual deviceId of first real mic

async function loadMicrophones() {
  if (!selMic) return;
  try {
    // Request permission first; stop the stream immediately after
    const permStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    permStream.getTracks().forEach(t => t.stop());

    const devices = await navigator.mediaDevices.enumerateDevices();
    const audioInputDevices = devices.filter(device => device.kind === 'audioinput');

    selMic.innerHTML = '';

    // Add default option
    const defaultOption = document.createElement("option");
    defaultOption.value = "default";
    defaultOption.text = "Systemets standardmikrofon";
    selMic.appendChild(defaultOption);

    // Add WASAPI Loopback option (Stereo Mix replacement)
    const wasapiOption = document.createElement("option");
    wasapiOption.value = "wasapi";
    wasapiOption.text = "Systemljud + Mikrofon (Möten/Musik)";
    selMic.appendChild(wasapiOption);

    audioInputDevices.forEach(device => {
      // Skip the duplicated default/communications entries
      if (device.deviceId === "default" || device.deviceId === "communications") return;

      // Remember the first real mic for use when "default" is selected
      if (!firstMicDeviceId && device.deviceId) {
        firstMicDeviceId = device.deviceId;
      }

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
  setupV11Handlers();
  updateFooter();
  refreshModelList();
  await ensureModelReady();
}

function setupV11Handlers() {
  // ── Search & Replace ──────────────────────────────────────────────────────
  const searchBar = document.getElementById("search-bar");
  const searchInput = document.getElementById("search-input");
  const replaceInput = document.getElementById("replace-input");
  const btnSearch = document.getElementById("btn-search");
  const btnReplaceOne = document.getElementById("btn-replace-one");
  const btnReplaceAll = document.getElementById("btn-replace-all");
  const btnCloseSearch = document.getElementById("btn-close-search");

  function openSearch() {
    if (!searchBar) return;
    searchBar.classList.remove("hidden");
    searchBar.style.display = "flex";
    if (searchInput) { searchInput.focus(); searchInput.select(); }
  }
  function closeSearch() {
    if (!searchBar) return;
    searchBar.classList.add("hidden");
    if (searchInput) searchInput.value = "";
    if (replaceInput) replaceInput.value = "";
  }

  btnSearch && btnSearch.addEventListener("click", openSearch);
  btnCloseSearch && btnCloseSearch.addEventListener("click", closeSearch);

  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "f") {
      if (!outputText || !outputText.value) return;
      e.preventDefault();
      openSearch();
    }
    if (e.key === "Escape" && searchBar && !searchBar.classList.contains("hidden")) {
      closeSearch();
    }
  });

  btnReplaceOne && btnReplaceOne.addEventListener("click", () => {
    const needle = searchInput ? searchInput.value : "";
    if (!needle || !outputText) return;
    const text = outputText.value;
    const idx = text.indexOf(needle);
    if (idx === -1) {
      if (searchInput) { searchInput.style.color = "red"; setTimeout(() => searchInput.style.color = "", 800); }
      return;
    }
    outputText.value = text.slice(0, idx) + (replaceInput ? replaceInput.value : "") + text.slice(idx + needle.length);
  });

  btnReplaceAll && btnReplaceAll.addEventListener("click", () => {
    const needle = searchInput ? searchInput.value : "";
    if (!needle || !outputText || !outputText.value) return;
    const count = outputText.value.split(needle).length - 1;
    outputText.value = outputText.value.split(needle).join(replaceInput ? replaceInput.value : "");
    if (searchInput) {
      searchInput.placeholder = `Ersatte ${count} förekomster`;
      setTimeout(() => { searchInput.placeholder = "Sök..."; }, 2000);
    }
  });

  // ── Stereo Mix Guide Modal ────────────────────────────────────────────────
  const stereoMixModal = document.getElementById("stereo-mix-modal");
  const btnStereoMixHelp = document.getElementById("btn-stereo-mix-help");
  const btnCloseStereoMix = document.getElementById("btn-close-stereo-mix");
  const btnCloseStereoMixOk = document.getElementById("btn-close-stereo-mix-ok");

  function openStereoMix() {
    if (settingsModal) settingsModal.classList.add("hidden");
    if (stereoMixModal) {
      stereoMixModal.classList.remove("hidden");
      stereoMixModal.style.display = "flex";
    }
  }
  function closeStereoMix() {
    if (stereoMixModal) stereoMixModal.classList.add("hidden");
  }

  btnStereoMixHelp && btnStereoMixHelp.addEventListener("click", openStereoMix);
  btnCloseStereoMix && btnCloseStereoMix.addEventListener("click", closeStereoMix);
  btnCloseStereoMixOk && btnCloseStereoMixOk.addEventListener("click", closeStereoMix);
  stereoMixModal && stereoMixModal.addEventListener("click", (e) => {
    if (e.target === stereoMixModal) closeStereoMix();
  });

  // ── Save Audio File ───────────────────────────────────────────────────────
  const btnSaveAudio = document.getElementById("btn-save-audio");
  btnSaveAudio && btnSaveAudio.addEventListener("click", async () => {
    try {
      await invoke("save_audio_file");
    } catch (err) {
      const msg = typeof err === "string" ? err : err.message || String(err);
      if (!msg.includes("cancelled") && !msg.includes("canceled")) {
        await message(`Kunde inte spara ljudfilen: ${msg}`, { title: "Fel", kind: "error" });
      }
    }
  });
}

async function refreshModelList() {
  if (!modelList) return;
  try {
    const models = await invoke("get_available_models");
    modelList.innerHTML = "";
    
    if (models.length === 0) {
      modelList.innerHTML = '<p class="text-xs text-slate-400 italic">Inga modeller hittades.</p>';
      return;
    }

    models.forEach(m => {
      const div = document.createElement("div");
      div.className = "flex items-center justify-between p-2 bg-slate-50 dark:bg-slate-900/80 rounded-lg border border-slate-200 dark:border-slate-700/50";
      
      const info = document.createElement("div");
      info.className = "flex flex-col";
      
      const name = document.createElement("span");
      name.className = "text-xs font-semibold text-slate-700 dark:text-slate-300";
      name.innerText = m.name;
      
      const size = document.createElement("span");
      size.className = "text-[10px] text-slate-500 dark:text-slate-500";
      size.innerText = m.downloaded ? formatSize(m.size_bytes) : "Ej nedladdad";
      
      info.appendChild(name);
      info.appendChild(size);
      
      div.appendChild(info);
      
      if (m.downloaded) {
        const delBtn = document.createElement("button");
        delBtn.className = "p-1.5 text-slate-400 hover:text-red-500 transition-colors";
        delBtn.innerHTML = '<span class="material-symbols-outlined text-sm">delete</span>';
        delBtn.onclick = async () => {
          if (confirm(`Är du säker på att du vill ta bort ${m.name}?`)) {
            await invoke("delete_model", { name: m.name });
            refreshModelList();
            updateFooter();
          }
        };
        div.appendChild(delBtn);
      }
      
      modelList.appendChild(div);
    });
  } catch (err) {
    console.error("Kunde inte ladda modellistan:", err);
  }
}

function formatSize(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

function updateDiskForecast(availableBytes) {
  if (!diskForecast) return;
  // whisper audio is 16kHz mono 32-bit float = 16000 * 4 bytes per second
  const bytesPerSec = 16000 * 4;
  const totalSeconds = availableBytes / bytesPerSec;
  const totalHours = Math.floor(totalSeconds / 3600);
  
  if (totalHours > 24) {
    diskForecast.innerText = `Prognos: >24h kvar`;
  } else {
    diskForecast.innerText = `Prognos: ~${totalHours}h kvar`;
  }
}

function startRecordingMetrics() {
  recordingStartTime = Date.now();
  estimatedRecordingSize = 0;
  
  if (recordingTimer) recordingTimer.innerText = "00:00:00";
  if (recordingSize) recordingSize.innerText = "0.0 MB";
  
  recordingTimerInterval = setInterval(() => {
    const elapsedMs = Date.now() - recordingStartTime;
    const sec = Math.floor(elapsedMs / 1000);
    const hrs = Math.floor(sec / 3600).toString().padStart(2, '0');
    const mins = Math.floor((sec % 3600) / 60).toString().padStart(2, '0');
    const s = (sec % 60).toString().padStart(2, '0');
    
    if (recordingTimer) recordingTimer.innerText = `${hrs}:${mins}:${s}`;
    
    // Estimate size
    estimatedRecordingSize = (elapsedMs / 1000) * (16000 * 4); // 16kHz mono f32
    if (recordingSize) {
      recordingSize.innerText = (estimatedRecordingSize / (1024 * 1024)).toFixed(1) + " MB";
    }

    // Warn at 25 minutes
    if (sec === 25 * 60) {
      if (typeof message === "function") {
        message("Du har spelat in i 25 minuter. Kom ihåg att avsluta inspelningen i tid — längre inspelningar kräver mer minne och kan ta längre tid att transkribera.", { title: "Lång inspelning", kind: "warning" });
      }
    }
  }, 1000);
}

function stopRecordingMetrics() {
  if (recordingTimerInterval) {
    clearInterval(recordingTimerInterval);
    recordingTimerInterval = null;
  }
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
  const newLang = selLanguage ? selLanguage.value : "sv";
  const newMicId = selMic ? selMic.value : "default";

  localStorage.setItem("modelSize", newSize);
  localStorage.setItem("modelQuantized", newQuant.toString());
  localStorage.setItem("transcriptionLanguage", newLang);
  localStorage.setItem("selectedMicId", newMicId);

  modelSize = newSize;
  modelQuantized = newQuant;
  transcriptionLanguage = newLang;
  selectedMicId = newMicId;

  settingsModal.classList.add("hidden");

  // Show/hide small model warning
  if (smallModelWarning) {
    if (modelSize === "small") {
      smallModelWarning.classList.remove("hidden");
    } else {
      smallModelWarning.classList.add("hidden");
    }
  }

  updateFooter();
  refreshModelList();

  // Re-check and download if needed
  await ensureModelReady();
});

// Redo transcription with different model
btnRedo.addEventListener("click", async () => {
  if (lastRecordedSegments.length === 0) return;
  
  const confirmed = await showConfirm("Vill du göra om transkriberingen med nuvarande inställningar?");
  if (!confirmed) return;
  
  btnRedo.classList.add("hidden");
  
  if (lastRecordedSegments.length > 1) {
    await processSegments([...lastRecordedSegments]);
  } else {
    await processAudioBlob(lastRecordedSegments[0].blob);
  }
});

// -------------------------------------------------------------
// Audio Recording Logic – Session/Segment model
// -------------------------------------------------------------
btnRecord.addEventListener("click", async () => {
  if (!isRecording && !isPaused) {
    // If there's existing transcription, warn the user
    if (outputText.value && outputText.value.trim()) {
      const confirmed = await showConfirm();
      if (!confirmed) return;
    }
    await startRecording();
  } else {
    await stopSession();
  }
});

// Show custom HTML confirm dialog, returns a Promise<boolean>
function showConfirm(msg) {
  return new Promise(resolve => {
    if (!confirmModal) { resolve(true); return; }
    if (msg) {
      confirmModal.querySelector("p").innerText = msg;
    }
    confirmModal.classList.remove("hidden");
    const onOk = () => { cleanup(); resolve(true); };
    const onCancel = () => { cleanup(); resolve(false); };
    const cleanup = () => {
      confirmModal.classList.add("hidden");
      confirmOk.removeEventListener("click", onOk);
      confirmCancel.removeEventListener("click", onCancel);
    };
    confirmOk.addEventListener("click", onOk);
    confirmCancel.addEventListener("click", onCancel);
  });
}

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
    if (selectedMicId === "wasapi") {
      // Backend recording mode
      await invoke("start_backend_recording");
      isRecording = true;
      isPaused = false;
      startRecordingMetrics();
    } else {
      // For "default", use the actual firstMicDeviceId if we found one,
      // because Tauri/WebView2 on Windows doesn't reliably handle implicit default
      let resolvedMicId = selectedMicId;
      if (selectedMicId === "default" && firstMicDeviceId) {
        resolvedMicId = firstMicDeviceId;
      }
      const audioConstraints = resolvedMicId === "default"
        ? { audio: true }
        : { audio: { deviceId: { exact: resolvedMicId } } };

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
      startRecordingMetrics();
    }

    // UI Updates
    btnRecord.classList.add("recording");
    btnRecord.querySelector(".btn-text").textContent = "Stoppa & transkribera";
    recordingIndicator.classList.remove("hidden");
    if (recordingStatusText) recordingStatusText.textContent = "Spelar in...";
    if (btnPause) {
      if (selectedMicId !== "wasapi") {
        btnPause.classList.remove("hidden");
        btnPause.querySelector(".btn-pause-text").textContent = "Pausa inspelning";
        btnPause.querySelector(".material-symbols-outlined").textContent = "pause";
      } else {
        btnPause.classList.add("hidden"); // Pause not supported for WASAPI for now
      }
    }
    if (segmentBadge) segmentBadge.classList.add("hidden");
    disableControls();
    btnRecord.disabled = false;
    if (btnPause && selectedMicId !== "wasapi") btnPause.disabled = false;
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
  if (selectedMicId === "wasapi") {
    isRecording = false;
    isPaused = false;
    stopRecordingMetrics();
    
    btnRecord.classList.remove("recording");
    const btnText = btnRecord.querySelector(".btn-text");
    if (btnText) btnText.textContent = "Starta ny inspelning";
    recordingIndicator.classList.add("hidden");
    btnPause.classList.add("hidden");
    disableControls();

    loadingText.innerText = "Hämtar ljud från backend...";
    loadingOverlay.classList.remove("hidden");

    try {
      const audioBytes = await invoke("stop_backend_recording");
      const blob = new Blob([new Uint8Array(audioBytes)], { type: 'audio/pcm' });
      lastRecordedSegments = [{ blob, startTime: new Date() }];
      btnRedo.classList.remove("hidden");
      btnRedo.style.display = "inline-flex";
      if (btnSaveAudio) { btnSaveAudio.classList.remove("hidden"); btnSaveAudio.style.display = "inline-flex"; }
      await processAudioBlob(blob);
    } catch (err) {
      console.error("WASAPI stop error:", err);
      await message("Kunde inte hämta ljud från backend: " + err, { title: 'Fel', kind: 'error' });
    } finally {
      loadingOverlay.classList.add("hidden");
      enableControls();
    }
    return;
  }

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
  stopRecordingMetrics();

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
    lastRecordedSegments = [...sessionSegments];
    const segments = [...sessionSegments];
    sessionSegments = [];
    const multiSegment = segments.length > 1;
    
    btnRedo.classList.remove("hidden");
    btnRedo.style.display = "inline-flex";
    if (btnSaveAudio) { btnSaveAudio.classList.remove("hidden"); btnSaveAudio.style.display = "inline-flex"; }

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
        quantized: modelQuantized,
        language: transcriptionLanguage
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
          quantized: modelQuantized,
          language: transcriptionLanguage
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

// ─────────────────────────────────────────────────────────────────────────────
// Search & Replace
// ─────────────────────────────────────────────────────────────────────────────
const searchBar = document.getElementById("search-bar");
const searchInput = document.getElementById("search-input");
const replaceInput = document.getElementById("replace-input");
const btnSearch = document.getElementById("btn-search");
const btnReplaceOne = document.getElementById("btn-replace-one");
const btnReplaceAll = document.getElementById("btn-replace-all");
const btnCloseSearch = document.getElementById("btn-close-search");

function openSearch() {
  searchBar.classList.remove("hidden");
  searchInput.focus();
  searchInput.select();
}
function closeSearch() {
  searchBar.classList.add("hidden");
  searchInput.value = "";
  replaceInput.value = "";
}

btnSearch && btnSearch.addEventListener("click", openSearch);
btnCloseSearch && btnCloseSearch.addEventListener("click", closeSearch);

document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "f") {
    e.preventDefault();
    openSearch();
  }
  if (e.key === "Escape" && !searchBar.classList.contains("hidden")) {
    closeSearch();
  }
});

btnReplaceOne && btnReplaceOne.addEventListener("click", () => {
  const needle = searchInput.value;
  if (!needle) return;
  const text = outputText.value;
  const idx = text.indexOf(needle);
  if (idx === -1) { searchInput.style.color = "red"; setTimeout(() => searchInput.style.color = "", 800); return; }
  outputText.value = text.slice(0, idx) + (replaceInput.value || "") + text.slice(idx + needle.length);
});

btnReplaceAll && btnReplaceAll.addEventListener("click", () => {
  const needle = searchInput.value;
  if (!needle || !outputText.value) return;
  const count = (outputText.value.split(needle).length - 1);
  outputText.value = outputText.value.split(needle).join(replaceInput.value || "");
  searchInput.placeholder = `Ersatte ${count} förekomster`;
  setTimeout(() => { searchInput.placeholder = "Sök..."; }, 2000);
});

// ─────────────────────────────────────────────────────────────────────────────
// Stereo Mix Guide Modal
// ─────────────────────────────────────────────────────────────────────────────
const stereoMixModal = document.getElementById("stereo-mix-modal");
const btnStereoMixHelp = document.getElementById("btn-stereo-mix-help");
const btnCloseStereoMix = document.getElementById("btn-close-stereo-mix");
const btnCloseStereoMixOk = document.getElementById("btn-close-stereo-mix-ok");

btnStereoMixHelp && btnStereoMixHelp.addEventListener("click", () => {
  settingsModal.classList.add("hidden");
  stereoMixModal.classList.remove("hidden");
});
btnCloseStereoMix && btnCloseStereoMix.addEventListener("click", () => {
    stereoMixModal.classList.add("hidden");
    settingsModal.classList.remove("hidden");
});
btnCloseStereoMixOk && btnCloseStereoMixOk.addEventListener("click", () => {
    stereoMixModal.classList.add("hidden");
    settingsModal.classList.remove("hidden");
});
stereoMixModal && stereoMixModal.addEventListener("click", (e) => {
  if (e.target === stereoMixModal) {
      stereoMixModal.classList.add("hidden");
      settingsModal.classList.remove("hidden");
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Save Audio File
// ─────────────────────────────────────────────────────────────────────────────
const btnSaveAudio = document.getElementById("btn-save-audio");

btnSaveAudio && btnSaveAudio.addEventListener("click", async () => {
  try {
    await invoke("save_audio_file");
  } catch (err) {
    const msg = typeof err === "string" ? err : err.message || String(err);
    if (!msg.includes("cancelled") && !msg.includes("canceled")) {
      await message(`Kunde inte spara ljudfilen: ${msg}`, { title: "Fel", kind: "error" });
    }
  }
});

// Show Save Audio button after recording completes (hooked into existing flow)
// We patch the existing transcription end so the button shows
const _origShowRedo = () => {
  btnRedo && btnRedo.classList.remove("hidden");
  btnRedo && (btnRedo.style.display = "inline-flex");
};
