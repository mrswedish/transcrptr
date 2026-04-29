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
const btnRedo = document.getElementById("btn-redo");

// Settings Elements
const btnSettings = document.getElementById("btn-settings");
const settingsModal = document.getElementById("settings-modal");
const btnCloseSettings = document.getElementById("btn-close-settings");
const btnSaveSettings = document.getElementById("btn-save-settings");
const btnDownloadModel = document.getElementById("btn-download-model");
const cbModelQuantized = document.getElementById("model-quantized");
const selLanguage = document.getElementById("transcription-language");
const selMic = document.getElementById("mic-select");
const eqBar = document.getElementById("eq-bar");

// Animate the EQ-bar columns based on audio level (average 0–128)
function animateEq(average) {
  if (!eqBar) return;
  const cols = eqBar.querySelectorAll(".eq-col");
  const norm = Math.min(average / 70, 1); // 0–1
  const shape = [0.3, 0.55, 0.85, 1.0, 0.85, 0.55, 0.3]; // bell curve base
  const color = norm > 0.85 ? "#ef4444" : norm > 0.6 ? "#f59e0b" : "#2DD4BF";
  cols.forEach((col, i) => {
    const jitter = (Math.random() * 0.35 - 0.175) * norm;
    const h = Math.max(0.08, Math.min(1, shape[i] * norm + jitter));
    col.style.height = `${Math.round(h * 100)}%`;
    col.style.backgroundColor = color;
  });
}

function resetEq() {
  if (!eqBar) return;
  eqBar.querySelectorAll(".eq-col").forEach((col, i) => {
    col.style.height = ["25%","45%","75%","100%","75%","45%","25%"][i];
    col.style.backgroundColor = "#2DD4BF";
  });
}

// Confirm modal elements
const confirmModal = document.getElementById("confirm-modal");
const confirmOk = document.getElementById("confirm-ok");
const confirmCancel = document.getElementById("confirm-cancel");

const btnCancelTranscription = document.getElementById("btn-cancel-transcription");
btnCancelTranscription?.addEventListener("click", async () => {
  isCancelling = true;
  await invoke("cancel_transcription");
});

// State
let isRecording = false;
let isPaused = false;
let mediaRecorder = null;
let audioChunks = [];
let modelSize = "medium";
let modelRevision = "standard";
let modelQuantized = true;

// Download picker state (independent from active model)
let dlSize = "medium";
let dlRevision = "standard";
let transcriptionLanguage = "sv";

// Personlig ordlista & PII-maskning
let personalVocabulary = [];  // Array of strings
let autoMaskPii = false;

// Segment editor & audio player state
let transcriptSegments = [];        // [{startMs, endMs, text, tokens}] — accumulated across chunks
let segmentViewActive = false;
let confidenceThreshold = 0.6;      // Words below this prob get highlighted
let currentPlaybackBlob = null;
let currentPlaybackUrl = null;
// audioPlayer is resolved after DOM is ready (must be in DOM for WKWebView)
let audioPlayer = null;
let selectedMicId = "default";
let wasapiEnabled = false;
let useGpu = true;
let isCancelling = false;
let pendingRecording = null; // { type:'float32', data:Float32Array } | { type:'segments', segments:[] }
let wasapiRecordingReady = false; // Rust har recorded_samples — save_audio_file kan anropas direkt
let wasapiDecodePromise  = null;  // Promise<Float32Array> för JS-mix, behövs vid transkribering
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
  const revision = localStorage.getItem("modelRevision");
  const quantized = localStorage.getItem("modelQuantized");
  const lang = localStorage.getItem("transcriptionLanguage");
  const micId = localStorage.getItem("selectedMicId");
  const wasapi = localStorage.getItem("wasapiEnabled");
  const gpu = localStorage.getItem("useGpu");
  const vocab = localStorage.getItem("personalVocabulary");
  const autoMask = localStorage.getItem("autoMaskPii");
  const confThresh = localStorage.getItem("confidenceThreshold");

  if (size) modelSize = size;
  if (revision) modelRevision = revision;
  if (quantized !== null) modelQuantized = quantized === "true";
  if (lang) transcriptionLanguage = lang;
  if (micId) selectedMicId = micId;
  if (wasapi !== null) wasapiEnabled = wasapi === "true";
  if (gpu !== null) useGpu = gpu === "true";
  if (vocab) {
    try { personalVocabulary = JSON.parse(vocab); } catch { personalVocabulary = []; }
  }
  if (autoMask !== null) autoMaskPii = autoMask === "true";
  if (confThresh !== null) confidenceThreshold = parseFloat(confThresh);

  const wasapiToggle = document.getElementById("wasapi-toggle");
  if (wasapiToggle) wasapiToggle.checked = wasapiEnabled;
  const gpuToggle = document.getElementById("gpu-toggle");
  if (gpuToggle) gpuToggle.checked = useGpu;

  const autoMaskToggle = document.getElementById("auto-mask-toggle");
  if (autoMaskToggle) autoMaskToggle.checked = autoMaskPii;

  const confSlider = document.getElementById("confidence-threshold-slider");
  const confLabel = document.getElementById("confidence-threshold-label");
  if (confSlider) confSlider.value = Math.round(confidenceThreshold * 100);
  if (confLabel) confLabel.textContent = Math.round(confidenceThreshold * 100) + "%";

  const vocabInput = document.getElementById("vocabulary-input");
  if (vocabInput) vocabInput.value = personalVocabulary.join("\n");

  // Sync pill pickers to current state
  syncPickButtons("size", modelSize);
  syncPickButtons("revision", modelRevision);
  if (cbModelQuantized) cbModelQuantized.checked = modelQuantized;
  if (selLanguage) selLanguage.value = transcriptionLanguage;

  updateFooter();
}

// Update the footer information bar
function updateFooter() {
  if (footerMic) {
    const micLabel = Array.from(selMic.options).find(opt => opt.value === selectedMicId)?.text || "Standardmikrofon";
    footerMic.innerText = micLabel;
  }
  if (footerModel) {
    const revLabel = modelRevision !== "standard" ? ` ${modelRevision}` : "";
    const fmtName = modelSize === "turbo"
      ? "Turbo · Global · kvantiserad"
      : modelQuantized ? `${modelSize}${revLabel} · kvantiserad` : `${modelSize}${revLabel}`;
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

    audioInputDevices.forEach(device => {
      // Skip the duplicated default/communications entries
      if (device.deviceId === "default" || device.deviceId === "communications") return;

      // Skip virtual capture devices (Stereo Mix, What U Hear, etc.)
      // They must be set as Windows default mic and used via "Systemets standardmikrofon"
      const lbl = (device.label || "").toLowerCase();
      if (lbl.includes("stereo mix") || lbl.includes("what u hear") || lbl.includes("wat u hoort")) return;

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
  initPlayer();
  loadSettings();
  await loadMicrophones();
  setupEventListeners();
  setupV11Handlers();
  updateFooter();
  refreshModelList();
  // Visa systemljud-toggle bara på Windows (Application Loopback API)
  if (navigator.userAgent.includes('Windows')) {
    document.getElementById('loopback-section')?.classList.remove('hidden');
    document.getElementById('gpu-section')?.classList.remove('hidden');
  }
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

}

async function refreshModelList() {
  if (!modelList) return;
  try {
    const models = await invoke("get_available_models");
    modelList.innerHTML = "";

    if (models.length === 0) {
      modelList.innerHTML = '<p class="text-xs text-slate-400 italic">Inga modeller nedladdade ännu.</p>';
      return;
    }

    models.forEach(m => {
      const isActive = m.size === modelSize && m.revision === modelRevision && m.quantized === modelQuantized;

      function activateModel() {
        if (isActive) return;
        modelSize = m.size;
        modelRevision = m.revision;
        modelQuantized = m.quantized;
        localStorage.setItem("modelSize", modelSize);
        localStorage.setItem("modelRevision", modelRevision);
        localStorage.setItem("modelQuantized", modelQuantized.toString());
        updateFooter();
        refreshModelList();
        updateBadge(`Redo (${m.name})`, "ready");
      }

      const div = document.createElement("div");
      div.className = `flex items-center justify-between p-2 rounded-lg border transition-colors ${
        isActive
          ? "bg-primary/5 border-primary/30 dark:border-primary/30"
          : "bg-slate-50 dark:bg-slate-900/80 border-slate-200 dark:border-slate-700/50 cursor-pointer hover:border-primary/40 hover:bg-primary/5"
      }`;
      if (!isActive) div.onclick = activateModel;

      const info = document.createElement("div");
      info.className = "flex flex-col min-w-0";

      const nameEl = document.createElement("span");
      nameEl.className = `text-xs font-semibold ${isActive ? "text-primary" : "text-slate-700 dark:text-slate-300"}`;
      nameEl.innerText = m.name + (isActive ? " ✓" : "");

      const sizeEl = document.createElement("span");
      sizeEl.className = "text-[10px] text-slate-500";
      sizeEl.innerText = formatSize(m.size_bytes);

      info.appendChild(nameEl);
      info.appendChild(sizeEl);
      div.appendChild(info);

      const actions = document.createElement("div");
      actions.className = "flex items-center gap-1 shrink-0";

      const delBtn = document.createElement("button");
      delBtn.className = "p-1.5 text-slate-400 hover:text-red-500 transition-colors";
      delBtn.innerHTML = '<span class="material-symbols-outlined text-sm">delete</span>';
      delBtn.onclick = async (e) => {
        e.stopPropagation();
        if (confirm(`Ta bort ${m.name}?`)) {
          await invoke("delete_model", { size: m.size, quantized: m.quantized, revision: m.revision });
          // If we deleted the active model, clear badge
          if (isActive) updateBadge("Ingen modell vald", "error");
          refreshModelList();
          updateFooter();
        }
      };
      actions.appendChild(delBtn);
      div.appendChild(actions);

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

// Download + activate a specific model (called by download button)
async function downloadAndActivate(size, revision, quantized) {
  disableControls();
  try {
    updateBadge("Laddar ner...", "");
    const revLabel = revision !== "standard" ? ` ${revision}` : "";
    loadingText.innerText = `Laddar ner ${size}${revLabel}...`;
    loadingOverlay.classList.remove("hidden");
    if (progressContainer) progressContainer.classList.remove("hidden");
    if (progressBar) progressBar.style.width = "0%";

    await invoke("download_model", { size, quantized, revision });

    loadingOverlay.classList.add("hidden");
    if (progressContainer) progressContainer.classList.add("hidden");

    modelSize = size;
    modelRevision = revision;
    modelQuantized = quantized;
    localStorage.setItem("modelSize", modelSize);
    localStorage.setItem("modelRevision", modelRevision);
    localStorage.setItem("modelQuantized", modelQuantized.toString());

    const revLabelFmt = revision !== "standard" ? ` ${revision}` : "";
    const fmtName = quantized ? `${size}${revLabelFmt} q5_0` : `${size}${revLabelFmt}`;
    updateBadge(`Redo (${fmtName})`, "ready");
    updateFooter();
    refreshModelList();
    enableControls();
  } catch (error) {
    console.error(error);
    updateBadge("Modellfel", "error");
    loadingOverlay.classList.add("hidden");
    if (progressContainer) progressContainer.classList.add("hidden");
    enableControls();
    await message(`Nedladdning misslyckades: ${error}`, { title: 'Fel', kind: 'error' });
  }
}

// Check saved model on startup — fall back to any existing downloaded model
async function ensureModelReady() {
  disableControls();
  try {
    updateBadge("Kontrollerar modell...", "");
    const exists = await invoke("check_model_exists", { size: modelSize, quantized: modelQuantized, revision: modelRevision });

    if (!exists) {
      // Saved model missing — look for any already-downloaded model to use
      const available = await invoke("get_available_models");
      if (available.length > 0) {
        const m = available[0];
        modelSize = m.size;
        modelRevision = m.revision;
        modelQuantized = m.quantized;
        localStorage.setItem("modelSize", modelSize);
        localStorage.setItem("modelRevision", modelRevision);
        localStorage.setItem("modelQuantized", modelQuantized.toString());
        updateFooter();
        refreshModelList();
      } else {
        // First launch — download default (medium standard q5)
        await downloadAndActivate("medium", "standard", true);
        return;
      }
    }

    const revLabel = modelRevision !== "standard" ? ` ${modelRevision}` : "";
    const fmtName = modelSize === "turbo"
      ? "Turbo · Global · kvantiserad"
      : modelQuantized ? `${modelSize}${revLabel} · kvantiserad` : `${modelSize}${revLabel}`;
    updateBadge(`Redo (${fmtName})`, "ready");
    enableControls();
    refreshModelList();
  } catch (error) {
    console.error(error);
    updateBadge("Modellfel", "error");
    loadingOverlay.classList.add("hidden");
    if (progressContainer) progressContainer.classList.add("hidden");
    enableControls(); // Always re-enable so user can reach settings
    await message(`Misslyckades att initiera modellen: ${error}`, { title: 'Fel', kind: 'error' });
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
// -------------------------------------------------------------
// Pill button logic for download pickers
// -------------------------------------------------------------
const REVISION_DESCS = {
  standard: "Balanserat transkript för generellt bruk",
  strict:   "Ordagrant transkript — passar diktering och protokoll",
};
const SIZE_DESCS = {
  medium: "~900 MB · Balanserad hastighet och kvalitet · Rekommenderas för svenska",
  large:  "~2 GB · Bäst kvalitet på svenska · Långsammast",
  turbo:  "~1.5 GB · Snabb · 100+ språk · Välj vid blandspråkigt innehåll, engelska facktermer eller internationella möten",
};

const revisionSection = document.getElementById("revision-section");
const quantizedRow = document.getElementById("quantized-row");

function syncPickButtons(group, value) {
  document.querySelectorAll(`[data-pick="${group}"]`).forEach(btn => {
    const isActive = btn.dataset.value === value;
    btn.className = `pick-btn flex-1 py-2 px-1 text-xs font-semibold rounded-lg transition-colors ${
      isActive
        ? "bg-white dark:bg-slate-700 text-slate-800 dark:text-white shadow-sm"
        : "text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
    }`;
  });
  const descEl = document.getElementById(`${group}-desc`);
  if (descEl) {
    descEl.innerText = group === "revision" ? REVISION_DESCS[value] ?? "" : SIZE_DESCS[value] ?? "";
  }
  // Turbo has no KB-whisper revisions — hide revision picker; quantized row stays visible but forced on
  if (group === "size") {
    const isTurbo = value === "turbo";
    if (revisionSection) revisionSection.classList.toggle("hidden", isTurbo);
    const qCheckbox = document.getElementById("model-quantized");
    if (qCheckbox) {
      if (isTurbo) {
        qCheckbox.checked = true;
        qCheckbox.disabled = true;
      } else {
        qCheckbox.disabled = false;
      }
    }
  }
}

document.querySelectorAll("[data-pick]").forEach(btn => {
  btn.addEventListener("click", () => {
    const group = btn.dataset.pick;
    const value = btn.dataset.value;
    if (group === "revision") dlRevision = value;
    if (group === "size") {
      dlSize = value;
      if (value === "turbo") dlRevision = "standard"; // turbo has no KB revisions
    }
    syncPickButtons(group, value);
  });
});

// Init pill defaults
syncPickButtons("revision", dlRevision);
syncPickButtons("size", dlSize);

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

// Live-update confidence threshold label as slider moves
document.getElementById("confidence-threshold-slider")?.addEventListener("input", (e) => {
  const label = document.getElementById("confidence-threshold-label");
  if (label) label.textContent = e.target.value + "%";
});

btnSaveSettings.addEventListener("click", async () => {
  const newLang = selLanguage ? selLanguage.value : "sv";
  const newMicId = selMic ? selMic.value : "default";
  const wasapiToggle = document.getElementById("wasapi-toggle");
  const newWasapi = wasapiToggle ? wasapiToggle.checked : false;

  localStorage.setItem("transcriptionLanguage", newLang);
  localStorage.setItem("selectedMicId", newMicId);
  localStorage.setItem("wasapiEnabled", newWasapi.toString());

  // Personlig ordlista
  const vocabInput = document.getElementById("vocabulary-input");
  if (vocabInput) {
    personalVocabulary = vocabInput.value.split("\n").map(s => s.trim()).filter(Boolean);
    localStorage.setItem("personalVocabulary", JSON.stringify(personalVocabulary));
  }

  // Auto-mask PII
  const autoMaskToggle = document.getElementById("auto-mask-toggle");
  if (autoMaskToggle) {
    autoMaskPii = autoMaskToggle.checked;
    localStorage.setItem("autoMaskPii", autoMaskPii.toString());
  }

  // Confidence threshold
  const confSlider = document.getElementById("confidence-threshold-slider");
  if (confSlider) {
    confidenceThreshold = parseInt(confSlider.value) / 100;
    localStorage.setItem("confidenceThreshold", confidenceThreshold.toString());
    // Re-render segment editor if visible to reflect new threshold
    if (segmentViewActive && transcriptSegments.length > 0) renderSegmentEditor();
  }

  transcriptionLanguage = newLang;
  selectedMicId = newMicId;
  wasapiEnabled = newWasapi;

  settingsModal.classList.add("hidden");
  updateFooter();
});

// "Ladda ner vald modell" — always downloads the selected combination
if (btnDownloadModel) {
  btnDownloadModel.addEventListener("click", async () => {
    const quantized = cbModelQuantized ? cbModelQuantized.checked : true;
    settingsModal.classList.add("hidden");
    await downloadAndActivate(dlSize, dlRevision, quantized);
  });
}

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

  btnRedo.classList.remove("hidden");
  btnRedo.style.display = "inline-flex";
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
  // Discard any pending post-recording choice if user starts a new recording
  if (pendingRecording) {
    pendingRecording = null;
    hidePostRecordingActions();
  }
  wasapiRecordingReady = false;
  wasapiDecodePromise  = null;
  try {
    let recordingStatusMsg = "Spelar in...";
    if (wasapiEnabled) {
      // Hybrid mode: browser records mic (reliable), Rust backend records loopback only.
      // Both are decoded and mixed in JS at stop time.
      let resolvedMicId = selectedMicId;
      if (selectedMicId === "default" && firstMicDeviceId) resolvedMicId = firstMicDeviceId;
      const audioConstraints = resolvedMicId === "default"
        ? { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }
        : { audio: { deviceId: { exact: resolvedMicId }, echoCancellation: true, noiseSuppression: true, autoGainControl: true } };

      micStream = await navigator.mediaDevices.getUserMedia(audioConstraints);

      sessionSegments = [];
      currentSegmentChunks = [];

      audioContext = new (window.AudioContext || window.webkitAudioContext)();
      analyzer = audioContext.createAnalyser();
      const wasapiSource = audioContext.createMediaStreamSource(micStream);
      wasapiSource.connect(analyzer);
      analyzer.fftSize = 256;
      const wasapiBufLen = analyzer.frequencyBinCount;
      const wasapiDataArr = new Uint8Array(wasapiBufLen);

      function drawVisualizer() {
        if (!isRecording) return;
        animationFrameId = requestAnimationFrame(drawVisualizer);
        analyzer.getByteFrequencyData(wasapiDataArr);
        let sum = 0;
        for (let i = 0; i < wasapiBufLen; i++) sum += wasapiDataArr[i];
        const average = sum / wasapiBufLen;
        animateEq(average);
      }

      mediaRecorder = createRecorder();
      mediaRecorder.start(1000);

      // Start loopback-only capture in backend (no mic there)
      const result = await invoke("start_backend_recording", { loopbackOnly: true });

      isRecording = true;
      isPaused = false;
      drawVisualizer();
      startRecordingMetrics();

      recordingStatusMsg = result.loopback_active
        ? "Spelar in (mikrofon + systemljud)"
        : "Spelar in (mikrofon — systemljud ej tillgängligt)";
      const loopbackIndicator = document.getElementById("loopback-indicator");
      if (loopbackIndicator) {
        if (result.loopback_active) loopbackIndicator.classList.remove("hidden");
        else loopbackIndicator.classList.add("hidden");
      }
    } else {
      // For "default", use the actual firstMicDeviceId if we found one,
      // because Tauri/WebView2 on Windows doesn't reliably handle implicit default
      let resolvedMicId = selectedMicId;
      if (selectedMicId === "default" && firstMicDeviceId) {
        resolvedMicId = firstMicDeviceId;
      }
      const audioConstraints = resolvedMicId === "default"
        ? { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }
        : { audio: { deviceId: { exact: resolvedMicId }, echoCancellation: true, noiseSuppression: true, autoGainControl: true } };

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
        animateEq(average);
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
    btnRecord.querySelector(".btn-text").textContent = "Stoppa";
    recordingIndicator.classList.remove("hidden");
    if (recordingStatusText) recordingStatusText.textContent = recordingStatusMsg;
    if (btnPause) {
      if (!wasapiEnabled) {
        btnPause.classList.remove("hidden");
        btnPause.querySelector(".btn-pause-text").textContent = "Pausa";
        btnPause.querySelector(".material-symbols-outlined").textContent = "pause";
      } else {
        btnPause.classList.add("hidden"); // Pause not supported in WASAPI mode
      }
    }
    if (segmentBadge) segmentBadge.classList.add("hidden");
    disableControls();
    btnRecord.disabled = false;
    if (btnPause && !wasapiEnabled) btnPause.disabled = false;
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
  resetEq();

  // UI Updates
  const partsLabel = getRecordedPartsLabel();
  if (recordingStatusText) {
    recordingStatusText.textContent = `Pausad${partsLabel ? " · " + partsLabel : ""}`;
    recordingStatusText.classList.remove("text-slate-600", "dark:text-slate-300");
    recordingStatusText.classList.add("text-amber-500");
  }
  if (eqBar) eqBar.querySelectorAll(".eq-col").forEach(c => c.style.backgroundColor = "#f59e0b");
  btnPause.querySelector(".btn-pause-text").textContent = "Fortsätt";
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
    animateEq(sum / bufferLength);
  }
  drawVisualizer();

  // UI Updates
  const nextPart = sessionSegments.length + 1;
  if (recordingStatusText) {
    recordingStatusText.textContent = `Spelar in — del ${nextPart}`;
    recordingStatusText.classList.remove("text-amber-500");
    recordingStatusText.classList.add("text-slate-600", "dark:text-slate-300");
  }
  btnPause.querySelector(".btn-pause-text").textContent = "Pausa";
  btnPause.querySelector(".material-symbols-outlined").textContent = "pause";
}

function showPostRecordingActions() {
  document.getElementById("post-recording-actions")?.classList.remove("hidden");
}

function hidePostRecordingActions() {
  document.getElementById("post-recording-actions")?.classList.add("hidden");
}

async function saveRecordedAudio() {
  try {
    if (wasapiRecordingReady) {
      // Rust har recorded_samples klart — spara direkt utan JS-kodning eller IPC-transfer
      await invoke("save_audio_file");
      return;
    }
    if (!lastRecordedSegments || lastRecordedSegments.length === 0 || !lastRecordedSegments[0].blob) {
      await message("Ingen inspelning att spara.", { title: "Fel", kind: "error" });
      return;
    }
    const blobs = lastRecordedSegments.map(s => s.blob);
    const combined = new Blob(blobs, { type: blobs[0].type });
    const float32Data = await decodeAudioToFloat32(combined);
    const wavBlob = float32ToPCM16WavBlob(float32Data, 16000);
    const wavBytes = Array.from(new Uint8Array(await wavBlob.arrayBuffer()));
    await invoke("save_audio_data", { audioData: wavBytes });
  } catch (err) {
    const msg = typeof err === "string" ? err : err.message || String(err);
    if (!msg.includes("cancelled") && !msg.includes("canceled")) {
      await message(`Kunde inte spara ljudfilen: ${msg}`, { title: "Fel", kind: "error" });
    }
  }
}

async function startPendingTranscription() {
  if (!pendingRecording) return;
  hidePostRecordingActions();
  const rec = pendingRecording;
  pendingRecording = null;

  btnRedo.classList.remove("hidden"); btnRedo.style.display = "inline-flex";
  if (btnSaveAudio) { btnSaveAudio.classList.remove("hidden"); btnSaveAudio.style.display = "inline-flex"; }

  if (rec.type === "float32") {
    disableControls();
    loadingOverlay.classList.remove("hidden");
    try {
      // Om WASAPI-avkodning fortfarande pågår i bakgrunden — invänta den
      if (!rec.data && wasapiDecodePromise) {
        loadingText.innerText = "Förbereder ljud...";
        rec.data = await wasapiDecodePromise;
      }
      if (!rec.data) {
        outputText.value = "[Ingen ljuddata tillgänglig]";
        return;
      }
      transcriptSegments = [];
      showRawView();
      const text = await transcribeFloat32(rec.data);
      if (!text || !text.trim()) outputText.value = "[Ingen text hittades i inspelningen]";
      if (transcriptSegments.length > 0) {
        renderSegmentEditor();
        showSegmentView();
        const btnSeg = document.getElementById("btn-segment-toggle");
        if (btnSeg) { btnSeg.classList.remove("hidden"); btnSeg.style.display = "inline-flex"; }
        setupPlayer(currentPlaybackBlob);
      }
    } finally {
      loadingOverlay.classList.add("hidden");
      enableControls();
    }
  } else if (rec.type === "segments") {
    if (rec.segments.length > 1) {
      await processSegments(rec.segments);
    } else {
      await processAudioBlob(rec.segments[0].blob);
    }
  }
}

async function stopSession() {
  if (wasapiEnabled) {
    isRecording = false;
    isPaused = false;
    stopRecordingMetrics();

    btnRecord.classList.remove("recording");
    const btnText = btnRecord.querySelector(".btn-text");
    if (btnText) btnText.textContent = "Spela in";
    recordingIndicator.classList.add("hidden");
    document.getElementById("loopback-indicator")?.classList.add("hidden");
    btnPause.classList.add("hidden");
    disableControls();

    // Flush the last mic chunk from MediaRecorder
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      await new Promise(resolve => {
        const origOnstop = mediaRecorder.onstop;
        mediaRecorder.onstop = () => { origOnstop(); resolve(); };
        mediaRecorder.stop();
      });
    }

    if (micStream) micStream.getTracks().forEach(t => t.stop());
    if (audioContext && audioContext.state !== "closed") {
      audioContext.close();
      audioContext = null;
    }

    loadingText.innerText = "Hämtar systemljud...";
    loadingOverlay.classList.remove("hidden");

    try {
      const loopbackBytes = await invoke("stop_backend_recording");
      // recorded_samples är nu fyllt i Rust — save_audio_file kan användas direkt
      wasapiRecordingReady = true;

      const micBlobs = sessionSegments.map(s => s.blob);

      // Starta avkodning+mix asynkront — behövs bara om användaren väljer Transkribera
      wasapiDecodePromise = decodeWasapiMix(micBlobs, loopbackBytes);

      // Visa dialog direkt utan att vänta på avkodning
      pendingRecording = { type: "float32", data: null };
      lastRecordedSegments = [{ startTime: new Date() }];
      loadingOverlay.classList.add("hidden");
      showPostRecordingActions();
    } catch (err) {
      console.error("WASAPI stop error:", err);
      wasapiRecordingReady = false;
      await message("Kunde inte hämta ljud: " + err, { title: 'Fel', kind: 'error' });
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
  resetEq();

  isRecording = false;
  isPaused = false;
  stopRecordingMetrics();

  // UI Updates – reset
  btnRecord.classList.remove("recording");
  const btnText = btnRecord.querySelector(".btn-text");
  if (btnText) btnText.textContent = "Spela in";
  recordingIndicator.classList.add("hidden");
  document.getElementById("loopback-indicator")?.classList.add("hidden");
  btnPause.classList.add("hidden");
  if (recordingStatusText) {
    recordingStatusText.textContent = "Spelar in";
    recordingStatusText.classList.remove("text-amber-500");
  }
  if (segmentBadge) segmentBadge.classList.add("hidden");
  disableControls();

  // Process segments
  if (sessionSegments.length > 0) {
    lastRecordedSegments = [...sessionSegments];
    const segments = [...sessionSegments];
    sessionSegments = [];

    // Let the user choose: transcribe now or just save the audio
    pendingRecording = { type: "segments", segments };
    showPostRecordingActions();
    enableControls();
  } else {
    enableControls();
  }
}

// Avkodar och mixar WASAPI mic + loopback till en Float32Array.
// Körs asynkront i bakgrunden direkt efter stop — resultatet behövs
// bara om användaren väljer att transkribera.
async function decodeWasapiMix(micBlobs, loopbackBytes) {
  const hasMic = micBlobs && micBlobs.length > 0;
  const hasLoopback = loopbackBytes && loopbackBytes.length > 44;

  let micFloat32 = null;
  let loopbackFloat32 = null;

  if (hasMic) {
    try {
      const micBlob = new Blob(micBlobs, { type: micBlobs[0].type });
      micFloat32 = await decodeAudioToFloat32(micBlob);
      console.log(`[wasapi] Mic decoded: ${micFloat32.length} samples (${(micFloat32.length/16000).toFixed(1)}s)`);
    } catch (e) {
      console.warn('[wasapi] Mic decode failed:', e);
    }
  }

  if (hasLoopback) {
    try {
      const loopbackBlob = new Blob([new Uint8Array(loopbackBytes)], { type: 'audio/wav' });
      loopbackFloat32 = await decodeAudioToFloat32(loopbackBlob);
      console.log(`[wasapi] Loopback decoded: ${loopbackFloat32.length} samples (${(loopbackFloat32.length/16000).toFixed(1)}s)`);
    } catch (e) {
      console.warn('[wasapi] Loopback decode failed:', e);
    }
  }

  if (micFloat32 && loopbackFloat32) {
    const len = Math.max(micFloat32.length, loopbackFloat32.length);
    const mixed = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      const a = i < micFloat32.length ? micFloat32[i] : 0;
      const b = i < loopbackFloat32.length ? loopbackFloat32[i] : 0;
      mixed[i] = Math.max(-1, Math.min(1, a + b));
    }
    console.log(`[wasapi] Mixed: ${mixed.length} samples (${(mixed.length/16000).toFixed(1)}s)`);
    return mixed;
  } else if (micFloat32) {
    console.log('[wasapi] Mic only (loopback unavailable)');
    return micFloat32;
  } else if (loopbackFloat32) {
    console.log('[wasapi] Loopback only (mic unavailable)');
    return loopbackFloat32;
  } else {
    throw new Error('Kunde inte avkoda varken mikrofon eller systemljud.');
  }
}

// Process multiple segments with section headers
async function processSegments(segments) {
  try {
    loadingText.innerText = "Bearbetar ljud...";
    loadingOverlay.classList.remove("hidden");
    if (progressContainer) progressContainer.classList.add("hidden");
    outputText.value = "";
    transcriptSegments = [];
    showRawView();

    currentPlaybackBlob = null;
    transcribeBlob._float32Chunks = [];

    isCancelling = false;
    if (btnCancelTranscription) btnCancelTranscription.classList.remove("hidden");

    const startTime = performance.now();
    let cumulativeOffsetMs = 0;

    for (let i = 0; i < segments.length; i++) {
      if (isCancelling) break;
      const seg = segments[i];
      const partNum = i + 1;
      const timestamp = formatTimestamp(seg.startTime);

      loadingText.innerText = `Transkriberar Del ${partNum} av ${segments.length}...`;

      if (outputText.value) outputText.value += "\n\n";
      outputText.value += `// Start Del ${partNum} (${timestamp})\n\n`;
      outputText.scrollTop = outputText.scrollHeight;

      const { text: segmentText, durationMs } = await transcribeBlob(seg.blob, `Del ${partNum}`, cumulativeOffsetMs);
      cumulativeOffsetMs += durationMs;

      if (segmentText && segmentText.trim()) {
        outputText.value += segmentText.trim();
      } else {
        outputText.value += "[Ingen text transkriberad]";
      }

      outputText.value += `\n\n// Slut Del ${partNum}`;
      outputText.scrollTop = outputText.scrollHeight;
    }

    const elapsedMs = performance.now() - startTime;
    const elapsedSec = Math.round(elapsedMs / 1000);
    const elapsedMin = Math.floor(elapsedSec / 60);
    const elapsedRemSec = elapsedSec % 60;
    const elapsedStr = elapsedMin > 0 ? `${elapsedMin}m ${elapsedRemSec}s` : `${elapsedSec}s`;

    if (progressBar) progressBar.style.width = "100%";
    loadingText.innerText = `Klar! (${elapsedStr})`;
    outputText.value += `\n\n[Transkribering klar: ${segments.length} delar, ${elapsedStr}]`;
    outputText.scrollTop = outputText.scrollHeight;

    // Build combined WAV blob for playback from all decoded Float32 chunks
    if (transcribeBlob._float32Chunks && transcribeBlob._float32Chunks.length > 0) {
      const totalLen = transcribeBlob._float32Chunks.reduce((s, c) => s + c.length, 0);
      const combined = new Float32Array(totalLen);
      let offset = 0;
      for (const chunk of transcribeBlob._float32Chunks) {
        combined.set(chunk, offset);
        offset += chunk.length;
      }
      currentPlaybackBlob = float32ToPCM16WavBlob(combined, 16000);
      transcribeBlob._float32Chunks = [];
    }

    if (transcriptSegments.length > 0) {
      renderSegmentEditor();
      showSegmentView();
      const btnSeg = document.getElementById("btn-segment-toggle");
      if (btnSeg) { btnSeg.classList.remove("hidden"); btnSeg.style.display = "inline-flex"; }
      setupPlayer(currentPlaybackBlob);
    }

  } catch (err) {
    console.error("processSegments error:", err);
    const errMsg = typeof err === 'string' ? err : err.message || String(err);
    if (isCancelling || errMsg.includes("canceled") || errMsg.includes("cancelled")) {
      outputText.value += "\n\n[Transkribering avbruten]";
    } else {
      await message(`Transkribering misslyckades: ${errMsg}`, { title: 'Fel', kind: 'error' });
    }
  } finally {
    isCancelling = false;
    if (btnCancelTranscription) btnCancelTranscription.classList.add("hidden");
    loadingOverlay.classList.add("hidden");
    enableControls();
  }
}

// Transcribe a single blob and return the text (used by processSegments)
// blobOffsetMs: cumulative offset (ms) to add to all segment timestamps from this blob
async function transcribeBlob(blob, label, blobOffsetMs = 0) {
  const arrayBuffer = await blob.arrayBuffer();
  const decodeCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
  const audioBuffer = await decodeCtx.decodeAudioData(arrayBuffer);
  decodeCtx.close();
  const float32Data = audioBuffer.getChannelData(0).slice();
  const totalSamples = float32Data.length;
  const durationMs = Math.round(totalSamples / 16000 * 1000);

  // Accumulate Float32 for WAV playback (each segment blob decoded separately)
  // We'll combine all segments' Float32 into a single WAV in processSegments
  if (!transcribeBlob._float32Chunks) transcribeBlob._float32Chunks = [];
  transcribeBlob._float32Chunks.push(float32Data);

  const numChunks = Math.ceil(totalSamples / CHUNK_SAMPLES);
  totalChunks = numChunks;
  currentChunkIdx = 0;

  if (progressContainer) progressContainer.classList.remove("hidden");
  if (progressBar) progressBar.style.width = "0%";

  let result = "";
  let contextPrefix = null;
  const initialPrompt = personalVocabulary.length > 0 ? personalVocabulary.join(", ") : null;

  for (let chunkIdx = 0; chunkIdx < numChunks; chunkIdx++) {
    if (isCancelling) throw new Error("canceled");
    currentChunkIdx = chunkIdx;
    const chunkOffsetMs = blobOffsetMs + chunkIdx * CHUNK_DURATION_SECONDS * 1000;
    const start = chunkIdx * CHUNK_SAMPLES;
    const end = Math.min(start + CHUNK_SAMPLES, totalSamples);
    const chunkFloat32 = float32Data.slice(start, end);
    const chunkI16 = new Int16Array(chunkFloat32.length);
    for (let i = 0; i < chunkFloat32.length; i++) chunkI16[i] = Math.round(chunkFloat32[i] * 32767);
    const chunkBytesArray = Array.from(new Uint8Array(chunkI16.buffer));

    try {
      const chunkSegs = await invoke("transcribe_audio_segments", {
        audioBytes: chunkBytesArray,
        size: modelSize,
        quantized: modelQuantized,
        revision: modelRevision,
        language: transcriptionLanguage,
        initialPrompt,
        contextPrefix,
        useGpu
      });
      if (chunkSegs && chunkSegs.length > 0) {
        const adjusted = chunkSegs.map(s => ({
          startMs: s.start_ms + chunkOffsetMs,
          endMs: s.end_ms + chunkOffsetMs,
          text: s.text,
          tokens: s.tokens || []
        }));
        transcriptSegments.push(...adjusted);
        const chunkText = adjusted.map(s => s.text).join("\n");
        if (result) result += "\n";
        result += chunkText;
        contextPrefix = lastWords(chunkText, 30);
      }
    } catch (chunkErr) {
      console.error(`${label} chunk ${chunkIdx + 1} failed:`, chunkErr);
      result += `\n[Fel i ${label}, del ${chunkIdx + 1}: ${chunkErr}]`;
    }
  }

  return { text: result, durationMs };
}

// -------------------------------------------------------------
// File Selection Logic
// -------------------------------------------------------------
btnFile.addEventListener("click", async () => {
  try {
    const selected = await invoke("pick_audio_file");
    if (selected) {
      disableControls();
      await processAudioFile(selected);
    }
  } catch (e) {
    console.error("Filval misslyckades:", e);
  }
});

// -------------------------------------------------------------
// Audio mixing helpers (used by WASAPI hybrid mode)
// -------------------------------------------------------------

// Encode Float32Array as 16-bit PCM WAV blob (universally decodable format).
function float32ToPCM16WavBlob(samples, sampleRate) {
  const n = samples.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const s = (off, str) => { for (let i = 0; i < str.length; i++) v.setUint8(off + i, str.charCodeAt(i)); };
  s(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true);
  s(8, 'WAVE'); s(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  s(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const x = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, x < 0 ? x * 32768 : x * 32767, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

async function decodeAudioToFloat32(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
  const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
  ctx.close();
  // .slice() copies the data out of the AudioBuffer before it can be GC'd
  return audioBuffer.getChannelData(0).slice();
}

// Mix two audio blobs and return the combined Float32Array (no WAV encode step).
// Avoids the float32 WAV format compatibility issue with WebView2's decodeAudioData.
async function mixAudioToFloat32(blobA, blobB) {
  const [dataA, dataB] = await Promise.all([
    decodeAudioToFloat32(blobA),
    decodeAudioToFloat32(blobB)
  ]);
  const len = Math.max(dataA.length, dataB.length);
  const mixed = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const a = i < dataA.length ? dataA[i] : 0;
    const b = i < dataB.length ? dataB[i] : 0;
    mixed[i] = Math.max(-1, Math.min(1, a + b));
  }
  return mixed;
}

// Transcribe a pre-decoded Float32Array at 16kHz directly (no blob/decode roundtrip).
async function transcribeFloat32(rawFloat32Data) {
  const float32Data = normalizeAudio(rawFloat32Data);
  const totalSamples = float32Data.length;
  if (totalSamples === 0) { console.warn('[wasapi] transcribeFloat32: empty audio'); return ''; }

  const totalDuration = (totalSamples / 16000).toFixed(0);
  const numChunks = Math.ceil(totalSamples / CHUNK_SAMPLES);
  totalChunks = numChunks;
  currentChunkIdx = 0;

  const durationMin = Math.floor(totalDuration / 60);
  const durationSec = totalDuration % 60;
  const durationStr = durationMin > 0 ? `${durationMin}m ${durationSec}s` : `${durationSec}s`;
  loadingText.innerText = `Transkriberar ${durationStr} ljud...`;
  if (progressContainer) progressContainer.classList.remove("hidden");
  if (progressBar) progressBar.style.width = "0%";

  const startTime = performance.now();
  let fullResult = "";
  let contextPrefix = null;
  const initialPrompt = personalVocabulary.length > 0 ? personalVocabulary.join(", ") : null;

  // Store WAV blob for playback
  currentPlaybackBlob = float32ToPCM16WavBlob(float32Data, 16000);

  for (let chunkIdx = 0; chunkIdx < numChunks; chunkIdx++) {
    currentChunkIdx = chunkIdx;
    const chunkOffsetMs = chunkIdx * CHUNK_DURATION_SECONDS * 1000;
    const start = chunkIdx * CHUNK_SAMPLES;
    const end = Math.min(start + CHUNK_SAMPLES, totalSamples);
    const chunkFloat32 = float32Data.slice(start, end);
    const chunkI16 = new Int16Array(chunkFloat32.length);
    for (let i = 0; i < chunkFloat32.length; i++) chunkI16[i] = Math.round(chunkFloat32[i] * 32767);
    const chunkBytesArray = Array.from(new Uint8Array(chunkI16.buffer));
    console.log(`[wasapi] Chunk ${chunkIdx + 1}/${numChunks}: ${chunkFloat32.length} samples`);
    try {
      const chunkSegs = await invoke("transcribe_audio_segments", {
        audioBytes: chunkBytesArray,
        size: modelSize,
        quantized: modelQuantized,
        revision: modelRevision,
        language: transcriptionLanguage,
        initialPrompt,
        contextPrefix,
        useGpu
      });
      if (chunkSegs && chunkSegs.length > 0) {
        const adjusted = chunkSegs.map(s => ({
          startMs: s.start_ms + chunkOffsetMs,
          endMs: s.end_ms + chunkOffsetMs,
          text: s.text,
          tokens: s.tokens || []
        }));
        transcriptSegments.push(...adjusted);
        const chunkText = adjusted.map(s => s.text).join("\n");
        if (fullResult) fullResult += "\n";
        fullResult += chunkText;
        contextPrefix = lastWords(chunkText, 30);
        outputText.value = fullResult;
        outputText.scrollTop = outputText.scrollHeight;
      }
    } catch (chunkErr) {
      console.error(`[wasapi] Chunk ${chunkIdx + 1} failed:`, chunkErr);
    }
  }

  const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);
  console.log(`[wasapi] Transcription done in ${elapsed}s, result length: ${fullResult.length}`);
  return fullResult;
}

// Normalize Float32 audio to peak ±0.95 to avoid clipping and improve whisper accuracy
// Returns the last N words of a text string (for chunk context continuity)
function lastWords(text, n) {
  const words = text.trim().split(/\s+/);
  return words.slice(-n).join(" ");
}

// Format milliseconds as M:SS or H:MM:SS
function formatMs(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  return `${m}:${String(s).padStart(2,'0')}`;
}

// Rebuild plain text from the segment array (used by copy/save/search)
function buildPlainText() {
  return transcriptSegments.map(s => s.text).join("\n");
}

// Render the segment editor from transcriptSegments
function buildConfidenceView(seg) {
  const div = document.createElement("div");
  div.className = "segment-view";

  const tokens = seg.tokens || [];
  const words = seg.text.trim().split(/\s+/).filter(Boolean);

  if (tokens.length === 0 || words.length === 0) {
    div.textContent = seg.text;
    return div;
  }

  // Group tokens into word-groups: a new group starts when tok.text begins with " ".
  // tok.text is used ONLY for word-boundary detection — not for display.
  // Display text always comes from seg.text (correctly assembled UTF-8 from whisper).
  const groups = [];
  let cur = [];
  for (const tok of tokens) {
    if (tok.text.startsWith(" ") && cur.length > 0) {
      groups.push(cur);
      cur = [];
    }
    cur.push(tok);
  }
  if (cur.length > 0) groups.push(cur);

  words.forEach((word, i) => {
    if (i > 0) div.appendChild(document.createTextNode(" "));
    const span = document.createElement("span");
    span.textContent = word;
    if (i < groups.length) {
      const minProb = Math.min(...groups[i].map(t => t.prob));
      if (minProb < confidenceThreshold * 0.6) {
        span.className = "tok tok-very-low";
        span.title = `Konfidenspoäng: ${Math.round(minProb * 100)}%`;
      } else if (minProb < confidenceThreshold) {
        span.className = "tok tok-low";
        span.title = `Konfidenspoäng: ${Math.round(minProb * 100)}%`;
      }
    }
    div.appendChild(span);
  });

  return div;
}

function renderSegmentEditor() {
  const editor = document.getElementById("segment-editor");
  if (!editor) return;
  editor.innerHTML = "";
  const frag = document.createDocumentFragment();
  transcriptSegments.forEach((seg, idx) => {
    const row = document.createElement("div");
    row.className = "segment-row";
    row.dataset.idx = idx;

    const ts = document.createElement("span");
    ts.className = "segment-ts";
    ts.textContent = formatMs(seg.startMs);
    ts.title = "Klicka för att spela från denna tidpunkt";
    ts.addEventListener("click", () => seekPlayer(seg.startMs));

    // Confidence view (default, read-only with colored tokens)
    const confView = buildConfidenceView(seg);
    confView.title = "Klicka för att redigera";

    // Editable textarea (hidden by default)
    const ta = document.createElement("textarea");
    ta.className = "segment-input hidden";
    ta.value = seg.text;
    ta.rows = 1;
    const autoGrow = () => { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + "px"; };
    ta.addEventListener("input", () => {
      transcriptSegments[idx].text = ta.value;
      // Clear tokens since text changed; confidence view will show plain text
      transcriptSegments[idx].tokens = [];
      outputText.value = buildPlainText();
      autoGrow();
    });
    ta.addEventListener("focus", () => row.classList.add("ring-1", "ring-primary/30", "rounded-lg"));
    ta.addEventListener("blur", () => {
      row.classList.remove("ring-1", "ring-primary/30", "rounded-lg");
      // Rebuild confidence view from (possibly updated) text, switch back
      const newView = buildConfidenceView(transcriptSegments[idx]);
      newView.title = "Klicka för att redigera";
      newView.addEventListener("click", () => { newView.classList.add("hidden"); ta.classList.remove("hidden"); requestAnimationFrame(autoGrow); ta.focus(); });
      row.replaceChild(newView, confView.parentNode ? confView : newView);
      // Swap: hide textarea, show new view
      ta.classList.add("hidden");
      const existing = row.querySelector(".segment-view");
      if (existing) row.replaceChild(newView, existing);
      else row.insertBefore(newView, ta);
    });

    // Click confidence view → switch to textarea
    confView.addEventListener("click", () => {
      confView.classList.add("hidden");
      ta.classList.remove("hidden");
      requestAnimationFrame(autoGrow);
      ta.focus();
    });

    requestAnimationFrame(autoGrow);

    row.appendChild(ts);
    row.appendChild(confView);
    row.appendChild(ta);
    frag.appendChild(row);
  });
  editor.appendChild(frag);
}

// Switch to segment view
function showSegmentView() {
  segmentViewActive = true;
  outputText.classList.add("hidden");
  const editor = document.getElementById("segment-editor");
  if (editor) editor.classList.remove("hidden");
  const label = document.getElementById("segment-toggle-label");
  if (label) label.textContent = "Råtext";
  const toggleBtn = document.getElementById("btn-segment-toggle");
  if (toggleBtn) {
    const icon = toggleBtn.querySelector(".material-symbols-outlined");
    if (icon) icon.textContent = "notes";
  }
}

// Switch to raw text view
function showRawView() {
  segmentViewActive = false;
  outputText.classList.remove("hidden");
  const editor = document.getElementById("segment-editor");
  if (editor) editor.classList.add("hidden");
  const label = document.getElementById("segment-toggle-label");
  if (label) label.textContent = "Segmentvy";
  const toggleBtn = document.getElementById("btn-segment-toggle");
  if (toggleBtn) {
    const icon = toggleBtn.querySelector(".material-symbols-outlined");
    if (icon) icon.textContent = "view_list";
  }
}

// Setup audio player with a blob for playback
function setupPlayer(blob) {
  if (!blob || !audioPlayer) return;
  if (currentPlaybackUrl) { URL.revokeObjectURL(currentPlaybackUrl); currentPlaybackUrl = null; }
  currentPlaybackUrl = URL.createObjectURL(blob);
  audioPlayer.src = currentPlaybackUrl;
  audioPlayer.load();
  const playerBar = document.getElementById("player-bar");
  if (playerBar) playerBar.classList.remove("hidden");
  const fill = document.getElementById("player-fill");
  if (fill) fill.style.width = "0%";
  const playerTime = document.getElementById("player-time");
  if (playerTime) playerTime.textContent = "0:00";
  const dur = document.getElementById("player-duration");
  if (dur) dur.textContent = "0:00";
}

// Seek audio player to a specific ms position
function seekPlayer(ms) {
  if (!audioPlayer) return;
  audioPlayer.currentTime = ms / 1000;
}

// Init player — called once DOM is ready
function initPlayer() {
  audioPlayer = document.getElementById("audio-player");
  if (!audioPlayer) return;

  audioPlayer.addEventListener("timeupdate", () => {
    const ms = audioPlayer.currentTime * 1000;
    const dur = (isFinite(audioPlayer.duration) ? audioPlayer.duration : 0) * 1000 || 1;
    const pct = Math.min(100, (ms / dur) * 100);
    const fill = document.getElementById("player-fill");
    if (fill) fill.style.width = `${pct}%`;
    const playerTime = document.getElementById("player-time");
    if (playerTime) playerTime.textContent = formatMs(ms);

    if (segmentViewActive) {
      document.querySelectorAll(".segment-row").forEach((row) => {
        const idx = parseInt(row.dataset.idx, 10);
        const seg = transcriptSegments[idx];
        const active = seg && ms >= seg.startMs && ms < seg.endMs;
        if (active) {
          row.classList.add("segment-active");
          row.scrollIntoView({ block: "nearest", behavior: "smooth" });
        } else {
          row.classList.remove("segment-active");
        }
      });
    }
  });

  audioPlayer.addEventListener("loadedmetadata", () => {
    const dur = document.getElementById("player-duration");
    if (dur && isFinite(audioPlayer.duration)) dur.textContent = formatMs(audioPlayer.duration * 1000);
  });

  audioPlayer.addEventListener("ended", () => {
    const icon = document.getElementById("play-icon");
    if (icon) icon.textContent = "play_arrow";
  });

  audioPlayer.addEventListener("error", (e) => {
    console.error("[player] Audio error:", e, audioPlayer.error);
  });

  const track = document.getElementById("player-track");
  if (track) {
    track.addEventListener("click", (e) => {
      if (!audioPlayer || !isFinite(audioPlayer.duration)) return;
      const rect = track.getBoundingClientRect();
      const ratio = (e.clientX - rect.left) / rect.width;
      audioPlayer.currentTime = ratio * audioPlayer.duration;
    });
  }
}

function normalizeAudio(float32Data) {
  let peak = 0;
  for (let i = 0; i < float32Data.length; i++) {
    const abs = Math.abs(float32Data[i]);
    if (abs > peak) peak = abs;
  }
  if (peak < 0.001) return float32Data;
  const scale = 0.95 / peak;
  // Normalize in-place to avoid doubling the memory allocation for large files
  for (let i = 0; i < float32Data.length; i++) {
    float32Data[i] *= scale;
  }
  return float32Data;
}

// Audio Processing and Transcription (chunked for large files)
// -------------------------------------------------------------

// Max chunk size: 5 minutes of audio at 16kHz mono
const CHUNK_DURATION_SECONDS = 300; // 5 minutes
const CHUNK_SAMPLES = 16000 * CHUNK_DURATION_SECONDS;

// Decode an audio or video file to Float32Array at 16kHz.
// Uses AudioContext.decodeAudioData (supports MP3/WAV/OGG/AAC/M4A/MP4/WebM).
async function decodeFileToFloat32(blob) {
  const fileSizeMB = blob.size / 1_048_576;

  // Reject files that are too large to safely load into memory on Windows.
  // An uncompressed 2-hour stereo WAV can be 1+ GB and will silently crash WebView2.
  if (blob.size > 400 * 1_048_576) {
    throw new Error(
      `Filen är för stor (${fileSizeMB.toFixed(0)} MB) för att läsas in i minnet. ` +
      `Om det är en okomprimerad WAV-inspelning, konvertera den till M4A eller MP3 och försök igen.`
    );
  }

  const decodeCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
  try {
    const arrayBuffer = await blob.arrayBuffer();
    const audioBuffer = await decodeCtx.decodeAudioData(arrayBuffer);
    // No .slice() — the Float32Array view keeps the backing memory alive.
    // Skipping the copy saves ~460 MB for a 2-hour file.
    const data = audioBuffer.getChannelData(0);
    decodeCtx.close();
    return normalizeAudio(data);
  } catch (err) {
    decodeCtx.close();
    console.error("[decode] decodeAudioData misslyckades:", err);
    throw new Error(
      `Kunde inte avkoda ljudfilen (${fileSizeMB.toFixed(0)} MB). ` +
      `Kontrollera att formatet stöds (WAV, MP3, M4A, OGG) och att filen inte är skadad.` +
      (err?.message ? ` Detaljer: ${err.message}` : "")
    );
  }
}

async function processAudioBlob(blob) {
  try {
    const fileSizeMB = blob.size / 1_048_576;
    loadingText.innerText = fileSizeMB > 50
      ? `Avkodar ljudfil (${fileSizeMB.toFixed(0)} MB)...`
      : "Bearbetar ljud...";
    loadingOverlay.classList.remove("hidden");
    if (progressContainer) progressContainer.classList.add("hidden");

    outputText.value = "";
    transcriptSegments = [];
    showRawView();

    const float32Data = await decodeFileToFloat32(blob);
    const totalSamples = float32Data.length;
    const totalDuration = (totalSamples / 16000).toFixed(0);
    console.log(`Audio decoded: ${totalSamples} samples (${totalDuration}s)`);
    // Skip the playback WAV blob for files longer than 30 minutes — creating a 230 MB
    // ArrayBuffer on top of the already-large Float32 buffer crashes WebView2 on Windows.
    if (totalSamples <= 16000 * 1800) {
      currentPlaybackBlob = float32ToPCM16WavBlob(float32Data, 16000);
    } else {
      currentPlaybackBlob = null;
    }

    const numChunks = Math.ceil(totalSamples / CHUNK_SAMPLES);
    totalChunks = numChunks;
    currentChunkIdx = 0;

    const durationMin = Math.floor(totalDuration / 60);
    const durationSec = totalDuration % 60;
    const durationStr = durationMin > 0 ? `${durationMin}m ${durationSec}s` : `${durationSec}s`;
    loadingText.innerText = `Transkriberar ${durationStr} ljud...`;
    if (progressContainer) progressContainer.classList.remove("hidden");
    if (progressBar) progressBar.style.width = "0%";
    isCancelling = false;
    if (btnCancelTranscription) btnCancelTranscription.classList.remove("hidden");

    const startTime = performance.now();
    let fullResult = "";
    let contextPrefix = null;
    const initialPrompt = personalVocabulary.length > 0 ? personalVocabulary.join(", ") : null;

    for (let chunkIdx = 0; chunkIdx < numChunks; chunkIdx++) {
      if (isCancelling) break;
      currentChunkIdx = chunkIdx;
      const chunkOffsetMs = chunkIdx * CHUNK_DURATION_SECONDS * 1000;
      const start = chunkIdx * CHUNK_SAMPLES;
      const end = Math.min(start + CHUNK_SAMPLES, totalSamples);
      const chunkFloat32 = float32Data.slice(start, end);
      const chunkI16 = new Int16Array(chunkFloat32.length);
      for (let i = 0; i < chunkFloat32.length; i++) chunkI16[i] = Math.round(chunkFloat32[i] * 32767);
      const chunkBytesArray = Array.from(new Uint8Array(chunkI16.buffer));
      console.log(`Sending chunk ${chunkIdx + 1}/${numChunks}: ${chunkFloat32.length} samples`);

      try {
        const chunkSegs = await invoke("transcribe_audio_segments", {
          audioBytes: chunkBytesArray,
          size: modelSize,
          quantized: modelQuantized,
          revision: modelRevision,
          language: transcriptionLanguage,
          initialPrompt,
          contextPrefix,
          useGpu
        });

        if (chunkSegs && chunkSegs.length > 0) {
          const adjusted = chunkSegs.map(s => ({
            startMs: s.start_ms + chunkOffsetMs,
            endMs: s.end_ms + chunkOffsetMs,
            text: s.text,
            tokens: s.tokens || []
          }));
          transcriptSegments.push(...adjusted);
          const chunkText = adjusted.map(s => s.text).join("\n");
          if (fullResult) fullResult += "\n";
          fullResult += chunkText;
          contextPrefix = lastWords(chunkText, 30);
          outputText.value = fullResult;
          outputText.scrollTop = outputText.scrollHeight;
        }
      } catch (chunkErr) {
        console.error(`Chunk ${chunkIdx + 1} failed:`, chunkErr);
        const errorMsg = typeof chunkErr === 'string' ? chunkErr : chunkErr.message || String(chunkErr);
        outputText.value += `\n\n[Fel i del ${chunkIdx + 1}: ${errorMsg}]`;
      }
    }

    if (progressBar) progressBar.style.width = "100%";
    const elapsedMs = performance.now() - startTime;
    const elapsedSec = Math.round(elapsedMs / 1000);
    const elapsedMin = Math.floor(elapsedSec / 60);
    const elapsedRemSec = elapsedSec % 60;
    const elapsedStr = elapsedMin > 0 ? `${elapsedMin}m ${elapsedRemSec}s` : `${elapsedSec}s`;
    loadingText.innerText = `Klar! (${elapsedStr})`;

    // Auto-mask PII if enabled
    if (autoMaskPii && outputText.value.trim()) {
      try {
        const masked = await invoke("mask_pii_regex", { text: outputText.value });
        outputText.value = masked;
        // Re-sync segment texts
        transcriptSegments.forEach((seg, i) => {
          const rows = document.querySelectorAll(".segment-row");
          if (rows[i]) seg.text = rows[i].querySelector(".segment-input")?.value ?? seg.text;
        });
      } catch (maskErr) {
        console.warn("PII-maskning misslyckades:", maskErr);
      }
    }

    outputText.value += `\n\n[Transkribering klar: ${elapsedStr}]`;
    outputText.scrollTop = outputText.scrollHeight;

    if (!outputText.value.trim()) {
      outputText.value = fullResult || "[Ingen text transkriberad]";
    }

    // Setup segment editor and player
    if (transcriptSegments.length > 0) {
      renderSegmentEditor();
      const btnSeg = document.getElementById("btn-segment-toggle");
      showSegmentView();
      if (btnSeg) { btnSeg.classList.remove("hidden"); btnSeg.style.display = "inline-flex"; }
      setupPlayer(currentPlaybackBlob);
    }

  } catch (err) {
    console.error("Transcription error:", err);
    const errStr = typeof err === 'string' ? err : err.message || String(err);
    if (isCancelling || errStr.includes("canceled") || errStr.includes("cancelled")) {
      outputText.value += "\n\n[Transkribering avbruten]";
    } else {
      await message(`Transkribering misslyckades: ${errStr}`, { title: 'Fel', kind: 'error' });
    }
  } finally {
    isCancelling = false;
    if (btnCancelTranscription) btnCancelTranscription.classList.add("hidden");
    loadingOverlay.classList.add("hidden");
    enableControls();
  }
}

// -------------------------------------------------------------
// processAudioFile — Rust-side decode + transcribe (no JS heap allocation)
// -------------------------------------------------------------
async function processAudioFile(filePath) {
  try {
    const fileName = filePath.split(/[/\\]/).pop();
    loadingText.innerText = `Avkodar ${fileName}...`;
    loadingOverlay.classList.remove("hidden");
    if (progressContainer) progressContainer.classList.remove("hidden");
    if (progressBar) progressBar.style.width = "0%";

    outputText.value = "";
    transcriptSegments = [];
    currentPlaybackBlob = null;
    showRawView();

    const initialPrompt = personalVocabulary.length > 0 ? personalVocabulary.join(", ") : null;
    isCancelling = false;
    if (btnCancelTranscription) btnCancelTranscription.classList.remove("hidden");
    const startTime = performance.now();

    const segs = await invoke("transcribe_file", {
      filePath,
      size:         modelSize,
      quantized:    modelQuantized,
      revision:     modelRevision,
      language:     transcriptionLanguage,
      initialPrompt,
      useGpu
    });

    if (segs && segs.length > 0) {
      transcriptSegments = segs.map(s => ({
        startMs: s.start_ms,
        endMs:   s.end_ms,
        text:    s.text,
        tokens:  s.tokens || []
      }));
      outputText.value = transcriptSegments.map(s => s.text).join("\n");
    }

    if (progressBar) progressBar.style.width = "100%";
    const elapsed = Math.round((performance.now() - startTime) / 1000);
    const elMin   = Math.floor(elapsed / 60);
    const elSec   = elapsed % 60;
    loadingText.innerText = `Klar! (${elMin > 0 ? `${elMin}m ` : ""}${elSec}s)`;
    outputText.value += `\n\n[Transkribering klar]`;
    outputText.scrollTop = outputText.scrollHeight;

    if (autoMaskPii && outputText.value.trim()) {
      try {
        const masked = await invoke("mask_pii_regex", { text: outputText.value });
        outputText.value = masked;
      } catch (e) { console.warn("PII-maskning misslyckades:", e); }
    }

    if (transcriptSegments.length > 0) {
      renderSegmentEditor();
      const btnSeg = document.getElementById("btn-segment-toggle");
      showSegmentView();
      if (btnSeg) { btnSeg.classList.remove("hidden"); btnSeg.style.display = "inline-flex"; }
    }
  } catch (err) {
    console.error("transcribe_file error:", err);
    const errMsg = typeof err === "string" ? err : err.message || String(err);
    if (isCancelling || errMsg.toLowerCase().includes("cancel")) {
      outputText.value += "\n\n[Transkribering avbruten]";
    } else {
      await message(`Transkribering misslyckades: ${errMsg}`, { title: "Fel", kind: "error" });
    }
  } finally {
    isCancelling = false;
    if (btnCancelTranscription) btnCancelTranscription.classList.add("hidden");
    loadingOverlay.classList.add("hidden");
    enableControls();
  }
}

// -------------------------------------------------------------
// Copy Logic
// -------------------------------------------------------------
btnCopy.addEventListener("click", () => {
  const text = segmentViewActive && transcriptSegments.length > 0
    ? buildPlainText()
    : outputText.value;
  if (text) {
    navigator.clipboard.writeText(text).then(() => {
      const prevIcon = btnCopy.innerHTML;
      btnCopy.innerHTML = `<span class="icon">✅</span> Kopierad!`;
      setTimeout(() => { btnCopy.innerHTML = prevIcon; }, 2000);
    });
  }
});

// -------------------------------------------------------------
// Save to File Logic
// -------------------------------------------------------------
btnSave.addEventListener("click", async () => {
  const content = segmentViewActive && transcriptSegments.length > 0
    ? buildPlainText()
    : outputText.value;
  if (!content || !content.trim()) return;
  try {
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
// Save Audio File
// Decodes lastRecordedSegments to Float32, encodes as 16-bit PCM WAV, saves via dialog.
// Works for both regular mic mode (WebM blobs) and WASAPI mode (PCM WAV blob).
// ─────────────────────────────────────────────────────────────────────────────
const btnSaveAudio = document.getElementById("btn-save-audio");

btnSaveAudio && btnSaveAudio.addEventListener("click", () => saveRecordedAudio());

// Show Save Audio button after recording completes (hooked into existing flow)
// We patch the existing transcription end so the button shows
const _origShowRedo = () => {
  btnRedo && btnRedo.classList.remove("hidden");
  btnRedo && (btnRedo.style.display = "inline-flex");
};

// -------------------------------------------------------------
// Segment view toggle
// -------------------------------------------------------------
const btnSegmentToggle = document.getElementById("btn-segment-toggle");
btnSegmentToggle && btnSegmentToggle.addEventListener("click", () => {
  if (segmentViewActive) showRawView();
  else showSegmentView();
});

// -------------------------------------------------------------
// Audio player play/pause button
// -------------------------------------------------------------
const btnPlayPause = document.getElementById("btn-play-pause");
const playIcon = document.getElementById("play-icon");
btnPlayPause && btnPlayPause.addEventListener("click", () => {
  if (!audioPlayer || !audioPlayer.src) return;
  if (audioPlayer.paused) {
    audioPlayer.play().then(() => {
      if (playIcon) playIcon.textContent = "pause";
    }).catch(err => console.error("[player] play() failed:", err));
  } else {
    audioPlayer.pause();
    if (playIcon) playIcon.textContent = "play_arrow";
  }
});

// -------------------------------------------------------------
// Systemljud-toggle — uppdatera direkt utan spara-krav
// -------------------------------------------------------------
// Post-recording action buttons
document.getElementById("btn-start-transcription")?.addEventListener("click", () => startPendingTranscription());
document.getElementById("btn-save-audio-only")?.addEventListener("click", async () => {
  hidePostRecordingActions();
  pendingRecording = null;
  btnRedo.classList.remove("hidden"); btnRedo.style.display = "inline-flex";
  if (btnSaveAudio) { btnSaveAudio.classList.remove("hidden"); btnSaveAudio.style.display = "inline-flex"; }
  await saveRecordedAudio();
});

const wasapiToggleEl = document.getElementById("wasapi-toggle");
wasapiToggleEl && wasapiToggleEl.addEventListener("change", () => {
  wasapiEnabled = wasapiToggleEl.checked;
  localStorage.setItem("wasapiEnabled", wasapiEnabled.toString());
});

const gpuToggleEl = document.getElementById("gpu-toggle");
gpuToggleEl && gpuToggleEl.addEventListener("change", () => {
  useGpu = gpuToggleEl.checked;
  localStorage.setItem("useGpu", useGpu.toString());
});

// -------------------------------------------------------------
// Maskera PII — manuell knapp
// -------------------------------------------------------------
const btnMaskPii = document.getElementById("btn-mask-pii");
btnMaskPii && btnMaskPii.addEventListener("click", async () => {
  const text = outputText.value.trim();
  if (!text) return;
  try {
    outputText.value = await invoke("mask_pii_regex", { text: outputText.value });
  } catch (err) {
    console.error("PII-maskning misslyckades:", err);
  }
});

// -------------------------------------------------------------
// Personlig ordlista — import/export
// -------------------------------------------------------------
const vocabImport = document.getElementById("vocabulary-import");
vocabImport && vocabImport.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const text = await file.text();
  let words;
  try {
    const parsed = JSON.parse(text);
    words = Array.isArray(parsed) ? parsed.map(String) : text.split("\n");
  } catch {
    words = text.split("\n");
  }
  words = words.map(w => w.trim()).filter(Boolean);
  const vocabInput = document.getElementById("vocabulary-input");
  if (vocabInput) vocabInput.value = words.join("\n");
  vocabImport.value = "";
});

const vocabExport = document.getElementById("vocabulary-export");
vocabExport && vocabExport.addEventListener("click", async () => {
  const vocabInput = document.getElementById("vocabulary-input");
  const content = vocabInput ? vocabInput.value : personalVocabulary.join("\n");
  try {
    await invoke("save_text_file", { content });
  } catch (err) {
    const msg = typeof err === "string" ? err : err.message || String(err);
    if (!msg.includes("cancelled") && !msg.includes("canceled")) {
      console.error("Export misslyckades:", msg);
    }
  }
});

// -------------------------------------------------------------
// Window sizing: 50% screen width, full available height
// -------------------------------------------------------------
(async () => {
  try {
    const { getCurrentWindow, LogicalSize, LogicalPosition } = window.__TAURI__.window;
    const win = getCurrentWindow();
    const sw = window.screen.availWidth;
    const sh = window.screen.availHeight;
    const w = Math.round(sw * 0.5);
    const x = Math.round((sw - w) / 2); // horizontally centered
    await win.setSize(new LogicalSize(w, sh));
    await win.setPosition(new LogicalPosition(x, 0));
  } catch (e) {
    console.warn("Window resize failed:", e);
  }
})();
