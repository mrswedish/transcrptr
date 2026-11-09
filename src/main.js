const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const message = window.__TAURI__.dialog ? window.__TAURI__.dialog.message : window.alert;

/// Skickar en logg-rad till Rust som skriver den till transcrptr.log.
/// Fire-and-forget — vi väntar inte på resultatet.
function logToFile(msg) {
  invoke("log_message", { msg: `[JS] ${msg}` }).catch(() => {});
}

// v1.4.5: Globala error handlers — fångar tysta JS-exceptions (t.ex. en throw i en
// async-callback som ingen await:ar) och skickar dem till transcrptr.log. Utan detta
// "försvinner" fel som händer utanför våra try/catch och vi vet inte vad som hände.
window.addEventListener("error", (e) => {
  logToFile(`window.error: ${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`);
});
window.addEventListener("unhandledrejection", (e) => {
  const reason = e.reason && (e.reason.stack || e.reason.message || String(e.reason));
  logToFile(`unhandledrejection: ${reason}`);
});

// UI Elements
const badge = document.getElementById("status-badge");
const btnRecord = document.getElementById("btn-record");
const btnPause = document.getElementById("btn-pause");
const btnFile = document.getElementById("btn-file");
const fileInput = document.getElementById("file-input");
const btnCopy = document.getElementById("btn-copy");
const btnSave = document.getElementById("btn-save");
const outputText = document.getElementById("output-text");
// Inspelningstillstånds-element (control-row layout, v1.1.96)
const recordingIndicator = document.getElementById("recording-status");
const recordingStatusText = document.getElementById("recording-status-text");
const idleHint = document.getElementById("idle-hint");

// Pill-knappens klasser för de två lägena (v1.5)
// Alternativ A: profilrödan används i viloläge; under inspelning blir knappen mörk
// så att den pulserande röda punkten ensam signalerar "spelar in".
const REC_PILL_IDLE = "btn-record-pill shrink-0 flex items-center gap-2.5 pl-3 pr-5 h-12 bg-primary hover:bg-primary-hover active:scale-95 transition-all rounded-full shadow-md shadow-primary/25 text-white font-semibold text-sm";
const REC_PILL_ACTIVE = "btn-record-pill shrink-0 flex items-center gap-2.5 pl-3 pr-5 h-12 bg-slate-800 hover:bg-slate-900 dark:bg-slate-600 dark:hover:bg-slate-500 active:scale-95 transition-all rounded-full shadow-md text-white font-semibold text-sm";

// Central UI-state-växling för inspelningskontrollerna
function setRecordingUI(state) {                // "idle" | "recording" | "paused"
  const recIcon  = btnRecord && btnRecord.querySelector(".btn-icon");
  const recLabel = btnRecord && btnRecord.querySelector(".btn-record-label");
  if (state === "idle") {
    if (recIcon) recIcon.className = "btn-icon block w-4 h-4 rounded-full bg-white shrink-0";
    if (recLabel) recLabel.textContent = "Spela in";
    if (btnRecord) btnRecord.className = REC_PILL_IDLE;
    if (idleHint) idleHint.classList.remove("hidden");
    if (recordingIndicator) recordingIndicator.classList.add("hidden");
    if (btnPause) btnPause.classList.add("hidden");
    if (btnRecord) btnRecord.setAttribute("aria-label", "Spela in");
  } else {
    // Mörk/neutral pill med stopp-fyrkant — tydligt att knappen nu STOPPAR
    if (recIcon) recIcon.className = "btn-icon block w-3.5 h-3.5 rounded-sm bg-white shrink-0";
    if (recLabel) recLabel.textContent = "Stoppa inspelning";
    if (btnRecord) btnRecord.className = REC_PILL_ACTIVE;
    if (idleHint) idleHint.classList.add("hidden");
    if (recordingIndicator) recordingIndicator.classList.remove("hidden");
    if (btnPause) btnPause.classList.remove("hidden");
    if (recordingStatusText) recordingStatusText.textContent = state === "paused" ? "Pausad" : "Spelar in";
    if (btnRecord) btnRecord.setAttribute("aria-label", "Stoppa inspelning");
  }
}
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

// Profilfärgen läses från CSS-variabeln så EQ-baren följer temat (ljust/mörkt)
// utan hårdkodad hex. Variabeln är RGB-kanaler: "226 0 26".
function primaryColor() {
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue("--c-primary").trim();
  return v ? `rgb(${v})` : "#e2001a";
}

// Animate the EQ-bar columns based on audio level (average 0–128)
function animateEq(average) {
  if (!eqBar) return;
  const cols = eqBar.querySelectorAll(".eq-col");
  const norm = Math.min(average / 70, 1); // 0–1
  const shape = [0.3, 0.55, 0.85, 1.0, 0.85, 0.55, 0.3]; // bell curve base
  // Nivåfärgning: hög nivå = varning (rött/amber), normal = profilfärg.
  const color = norm > 0.85 ? "#ef4444" : norm > 0.6 ? "#f59e0b" : primaryColor();
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
    col.style.backgroundColor = primaryColor();
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
let modelSize = "pianissimo";
let modelRevision = "standard";
let modelQuantized = true;

// Download picker state (independent from active model)
let dlSize = "pianissimo";
let dlRevision = "standard";
let transcriptionLanguage = "sv";

// Personlig ordlista
let personalVocabulary = [];  // Array of strings

// Segment editor & audio player state
let transcriptSegments = [];        // [{startMs, endMs, text, tokens}] — accumulated across chunks
let segmentRowsCache = [];          // DOM-elementen i samma ordning som transcriptSegments — undviker O(n) querySelectorAll per timeupdate
let currentActiveSegIdx = -1;       // index för aktivt segment under uppspelning
let segmentViewActive = false;
let confidenceThreshold = 0.6;      // Words below this prob get highlighted
let currentPlaybackUrl = null;
let currentPlaybackIsAsset = false;  // true = src är en asset-URL (disk-stream), inte blob
// audioPlayer is resolved after DOM is ready (must be in DOM for WKWebView)
let audioPlayer = null;
let selectedMicId = "default";
let wasapiEnabled = false;
let useGpu = true;
let isCancelling = false;
let pendingRecording = null; // { type:'wav-file', filePath } | { type:'segments', segments:[] }
let wasapiRecordingReady = false; // Rust har recording.wav på disk — save_audio_file kan anropas direkt
let recordingDir         = "";    // Mapp där sessions sparas; tom = default från Rust
let threadCount          = 4;     // Antal CPU-trådar för whisper.cpp (1-16); cap för att undvika krasch på multi-core
let gpuDeviceIndex       = null;  // GPU-index (0-7) eller null = auto. Multi-GPU-stöd via WhisperContextParameters.gpu_device
let audioContext = null;
let analyzer = null;
let micStream = null;

// Session/Segment state

// Chunk progress state (used by transcription_progress listener)
let currentChunkIdx = 0;
let totalChunks = 1;
let animationFrameId = null;

// New Recording Metrics State
let recordingStartTime = null;
let recordingTimerInterval = null;
let estimatedRecordingSize = 0;
let lastRecordedSegments = []; // Store for "Redo" feature
let lastTranscribedPath = null; // Senast transkriberade filen — "Gör om" kör om den via Rust

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
  if (confThresh !== null) confidenceThreshold = parseFloat(confThresh);

  const wasapiToggle = document.getElementById("wasapi-toggle");
  if (wasapiToggle) wasapiToggle.checked = wasapiEnabled;

  // Visuell sync av systemljud-växeln (huvud-UI) — bg/text/badge skiftar mellan AV och PÅ
  const wasapiQuickEl  = document.getElementById("wasapi-quick");
  const wasapiStatusEl = document.getElementById("wasapi-status");
  const syncWasapiVisual = () => {
    const on = !!(wasapiToggle && wasapiToggle.checked);
    // Hjälptexten visas bara när mötesljud är AV, och bara där växeln finns
    // (dvs. Windows — på Mac är wasapi-quick dold och hjälptexten irrelevant).
    const hint = document.getElementById("wasapi-hint");
    if (hint) {
      const togglePresent = wasapiQuickEl && !wasapiQuickEl.classList.contains("hidden");
      hint.classList.toggle("hidden", on || !togglePresent);
    }
    if (!wasapiQuickEl) return;
    if (on) {
      wasapiQuickEl.classList.add("bg-primary", "border-primary", "shadow-md", "shadow-primary/20");
      wasapiQuickEl.classList.remove("bg-slate-50", "dark:bg-slate-900", "border-slate-200", "dark:border-slate-700");
      wasapiQuickEl.querySelectorAll(".wasapi-icon, .wasapi-label").forEach(s => {
        s.classList.add("text-white");
        s.classList.remove("text-slate-400", "text-slate-500", "dark:text-slate-400");
      });
      if (wasapiStatusEl) {
        wasapiStatusEl.textContent = "PÅ";
        wasapiStatusEl.classList.add("bg-white/20", "text-white");
        wasapiStatusEl.classList.remove("bg-slate-200", "dark:bg-slate-700", "text-slate-500", "dark:text-slate-400");
      }
    } else {
      wasapiQuickEl.classList.remove("bg-primary", "border-primary", "shadow-md", "shadow-primary/20");
      wasapiQuickEl.classList.add("bg-slate-50", "dark:bg-slate-900", "border-slate-200", "dark:border-slate-700");
      wasapiQuickEl.querySelectorAll(".wasapi-icon, .wasapi-label").forEach(s => {
        s.classList.remove("text-white");
        s.classList.add("text-slate-400");
      });
      if (wasapiStatusEl) {
        wasapiStatusEl.textContent = "AV";
        wasapiStatusEl.classList.remove("bg-white/20", "text-white");
        wasapiStatusEl.classList.add("bg-slate-200", "dark:bg-slate-700", "text-slate-500", "dark:text-slate-400");
      }
    }
  };
  if (wasapiToggle) {
    wasapiToggle.addEventListener("change", () => {
      // v1.4.5: persistera DIREKT vid klick på huvud-UI:s Systemljud-knapp.
      // Tidigare uppdaterades wasapiEnabled BARA via Spara inställningar — så klick
      // på huvud-UI-toggle gav visuell PÅ men variabel = false → startRecording gick
      // else-grenen (browser MediaRecorder) utan att anropa start_backend_recording
      // → inga tempfiler på disk.
      wasapiEnabled = wasapiToggle.checked;
      localStorage.setItem("wasapiEnabled", wasapiEnabled.toString());
      logToFile(`wasapi-toggle change: wasapiEnabled=${wasapiEnabled}`);
      syncWasapiVisual();
    });
  }
  syncWasapiVisual();

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
  // Spegla sparad modell i kvalitetsvalet
  const savedQuality = modelSize === "pianissimo" ? "fast" : modelSize === "large" ? "best" : modelSize === "turbo" ? "multi" : "balanced";
  const verbatimEl = document.getElementById("model-verbatim");
  if (verbatimEl) verbatimEl.checked = modelRevision === "strict";
  if (typeof applyQuality === "function") applyQuality(savedQuality);
  if (cbModelQuantized) cbModelQuantized.checked = modelQuantized;
  if (selLanguage) selLanguage.value = transcriptionLanguage;

  updateFooter();
}

// Update the footer information bar
function updateFooter() {
  updateEngineLanguageNote();
  if (footerMic) {
    const micLabel = Array.from(selMic.options).find(opt => opt.value === selectedMicId)?.text || "Standardmikrofon";
    footerMic.innerText = micLabel;
  }
  if (footerModel) {
    const revLabel = modelRevision !== "standard" ? ` ${modelRevision}` : "";
    const fmtName = modelSize === "pianissimo"
      ? "Pianissimo · Snabb (svenska)"
      : modelSize === "turbo"
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

  // Bläddra-knapp för inspelningsmapp
  const btnBrowseDir = document.getElementById("btn-browse-recording-dir");
  if (btnBrowseDir) {
    btnBrowseDir.addEventListener("click", async () => {
      try {
        const selected = await window.__TAURI__.dialog.open({
          directory: true,
          multiple: false,
          defaultPath: recordingDir || undefined,
          title: "Välj mapp för inspelningar",
        });
        if (typeof selected === "string" && selected) {
          recordingDir = selected;
          localStorage.setItem("recordingDir", selected);
          const dirInput = document.getElementById("recording-dir-path");
          if (dirInput) dirInput.value = selected;
        }
      } catch (e) {
        console.warn("Mapp-val avbröts:", e);
      }
    });
  }

  // CPU-trådar-slider
  const threadSlider = document.getElementById("thread-count-slider");
  const threadValue  = document.getElementById("thread-count-value");
  if (threadSlider) {
    threadSlider.addEventListener("input", () => {
      // Clampa här också om DOM-värdet manipulerats (DevTools eller felaktig HTML)
      const raw = parseInt(threadSlider.value, 10);
      threadCount = Number.isFinite(raw) ? Math.max(1, Math.min(16, raw)) : 4;
      if (threadValue) threadValue.textContent = String(threadCount);
      localStorage.setItem("threadCount", String(threadCount));
    });
  }

  // Öppna loggfil för diagnostik
  const btnShowLog = document.getElementById("btn-show-log");
  if (btnShowLog) {
    btnShowLog.addEventListener("click", async () => {
      try {
        const logPath = await invoke("get_log_path");
        await window.__TAURI__.opener.openPath(logPath);
      } catch (e) {
        const msg = typeof e === "string" ? e : e.message || String(e);
        await message(`Kunde inte öppna loggfilen: ${msg}`, { title: "Fel", kind: "error" });
      }
    });
  }

  // (v1.5: recover-knappen i settings borttagen — importeras nu via "Öppna fil/mapp" i headern)
}

// Parsar sessionens starttid ur mappnamnet (inspelning-YYYYMMDD-HHMMSS / recording-<unix>).
function sessionStartFromFolderName(folderName) {
  // Tillåter valfritt namnsuffix efter tidsstämpeln, t.ex.
  // "inspelning-20260903-142233-ledningsgrupp" (se rename_session i Rust).
  const newFmt = folderName.match(/^inspelning-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(?:-.*)?$/);
  const oldFmt = folderName.match(/^recording-(\d+)$/);
  if (newFmt) {
    const [, y, m, d, hh, mm, ss] = newFmt;
    return new Date(`${y}-${m}-${d}T${hh}:${mm}:${ss}`);
  } else if (oldFmt) {
    return new Date(parseInt(oldFmt[1], 10) * 1000);
  }
  return new Date();
}

// Importerar en sessionsmapp: mixar (recover_session) och lämnar över till post-recording-flödet.
async function importSessionFolder(dir, needsRepair = false) {
  // Nollställ ev. öppen post-recording-dialog innan vi tar över state (F6)
  pendingRecording = null;
  hidePostRecordingActions();
  try {
    loadingText.innerText = needsRepair
      ? "Återställer avbruten inspelning..."
      : "Förbereder inspelning...";
    loadingOverlay.classList.remove("hidden");
    const recordedPath = await invoke("recover_session", { sessionDir: dir });
    loadingOverlay.classList.add("hidden");
    document.getElementById("settings-modal")?.classList.add("hidden");
    const folderName = dir.split(/[/\\]/).pop() || "";
    wasapiRecordingReady = true;
    pendingRecording     = { type: "wav-file", filePath: recordedPath };
    lastRecordedSegments = [{ startTime: sessionStartFromFolderName(folderName) }];
    showPostRecordingActions(dir);
  } catch (err) {
    loadingOverlay.classList.add("hidden");
    const msg = typeof err === "string" ? err : err.message || String(err);
    await message(`Kunde inte läsa inspelningsmappen: ${msg}`, { title: "Fel", kind: "error" });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tema — två lägen: "light" | "dark". Växlas med temaknappen i headern.
// Vid allra första start används datorns inställning som utgångspunkt, därefter
// gäller användarens eget val. Markup har haft dark:-klasser länge men klassen
// `dark` sattes aldrig förrän v1.6.0 — mörkt läge var i praktiken avstängt.
// ─────────────────────────────────────────────────────────────────────────────
let themePref = "light";

function applyTheme() {
  const isDark = themePref === "dark";
  document.documentElement.classList.toggle("dark", isDark);
  // Ikonen visar vad ett klick LEDER TILL, inte nuvarande läge.
  const icon = document.getElementById("theme-icon");
  if (icon) icon.textContent = isDark ? "light_mode" : "dark_mode";
  const btn = document.getElementById("btn-theme");
  if (btn) btn.title = isDark ? "Byt till ljust tema" : "Byt till mörkt tema";
}

function setTheme(pref) {
  themePref = pref === "dark" ? "dark" : "light";
  localStorage.setItem("theme", themePref);
  applyTheme();
}

function initTheme() {
  const saved = localStorage.getItem("theme");
  if (saved === "light" || saved === "dark") {
    themePref = saved;
  } else {
    // Första start: utgå från datorns inställning och spara valet.
    themePref = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    localStorage.setItem("theme", themePref);
  }
  applyTheme();
}

// Kör direkt (inte i initialize) så rätt tema gäller innan första målningen.
initTheme();

// Initialize Application
async function initialize() {
  // Visa app-version i inställningar-panelen.
  try {
    const version = await invoke("get_app_version");
    const versionLabel = document.getElementById("app-version");
    if (versionLabel) versionLabel.textContent = `v${version}`;
  } catch (e) {
    console.warn("Kunde inte hämta version:", e);
  }

  // Initiera inspelningsmapp: localStorage → fallback till Rusts default.
  try {
    const saved = localStorage.getItem("recordingDir");
    if (saved && saved.trim()) {
      recordingDir = saved.trim();
    } else {
      recordingDir = await invoke("get_default_recording_dir");
    }
    const dirInput = document.getElementById("recording-dir-path");
    if (dirInput) dirInput.value = recordingDir;
  } catch (e) {
    console.warn("Kunde inte hämta inspelningsmapp:", e);
  }

  // Initiera threadCount från localStorage
  try {
    const savedThreads = parseInt(localStorage.getItem("threadCount") || "4", 10);
    if (!Number.isNaN(savedThreads) && savedThreads >= 1 && savedThreads <= 16) {
      threadCount = savedThreads;
    }
    const slider = document.getElementById("thread-count-slider");
    const valueEl = document.getElementById("thread-count-value");
    if (slider) slider.value = String(threadCount);
    if (valueEl) valueEl.textContent = String(threadCount);
  } catch (e) {
    console.warn("Kunde inte hämta threadCount:", e);
  }

  // Initiera gpuDeviceIndex från localStorage (för multi-GPU-system)
  try {
    const savedGpuIdx = localStorage.getItem("gpuDeviceIndex");
    if (savedGpuIdx !== null && savedGpuIdx !== "") {
      const n = parseInt(savedGpuIdx, 10);
      if (Number.isFinite(n) && n >= 0 && n <= 7) gpuDeviceIndex = n;
    }
    const gpuIdxInput = document.getElementById("gpu-device-index");
    if (gpuIdxInput) gpuIdxInput.value = gpuDeviceIndex === null ? "" : String(gpuDeviceIndex);
    if (gpuIdxInput) {
      gpuIdxInput.addEventListener("input", () => {
        const raw = gpuIdxInput.value.trim();
        if (raw === "") {
          gpuDeviceIndex = null;
          localStorage.removeItem("gpuDeviceIndex");
        } else {
          const n = parseInt(raw, 10);
          if (Number.isFinite(n) && n >= 0 && n <= 7) {
            gpuDeviceIndex = n;
            localStorage.setItem("gpuDeviceIndex", String(n));
          }
        }
      });
    }
  } catch (e) {
    console.warn("Kunde inte hämta gpuDeviceIndex:", e);
  }

  initPlayer();
  loadSettings();
  await loadMicrophones();
  setupEventListeners();
  setupV11Handlers();
  updateFooter();
  refreshModelList();
  // Visa systemljud-toggle + GPU-inställning bara på Windows (Application Loopback API)
  if (navigator.userAgent.includes('Windows')) {
    const wasapiQuick = document.getElementById('wasapi-quick');
    if (wasapiQuick) {
      wasapiQuick.classList.remove('hidden');
      wasapiQuick.classList.add('flex');
    }
    // Växeln blev synlig först nu — visa hjälptexten om mötesljud är avslaget.
    const wasapiHint = document.getElementById('wasapi-hint');
    if (wasapiHint) wasapiHint.classList.toggle('hidden', wasapiEnabled);
    document.getElementById('gpu-section')?.classList.remove('hidden');
    const stereoHelp = document.getElementById('btn-stereo-mix-help');
    if (stereoHelp) {
      stereoHelp.classList.remove('hidden');
      stereoHelp.classList.add('flex');
    }
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
  }, 1000);
}

function stopRecordingMetrics() {
  if (recordingTimerInterval) {
    clearInterval(recordingTimerInterval);
    recordingTimerInterval = null;
  }
}

// v1.5: varna om ledigt diskutrymme är lågt innan inspelning. Returnerar true om
// inspelning kan fortsätta (alltid — vi blockerar inte, bara informerar/bekräftar).
const LOW_DISK_WARN_BYTES = 500 * 1024 * 1024; // 500 MB
async function checkDiskBeforeRecording() {
  try {
    const info = await invoke("get_disk_info");
    if (info && typeof info.available_space === "number" && info.available_space < LOW_DISK_WARN_BYTES) {
      const mb = (info.available_space / 1048576).toFixed(0);
      return await showConfirm(`Lågt diskutrymme: endast ${mb} MB ledigt. En lång inspelning kan fylla disken. Vill du fortsätta ändå?`, "Lågt diskutrymme");
    }
  } catch (_) { /* diskinfo icke-kritisk — tillåt inspelning */ }
  return true;
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
    const fmtName = size === "pianissimo" ? "Pianissimo · Snabb (svenska)" : quantized ? `${size}${revLabelFmt} q5_0` : `${size}${revLabelFmt}`;
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
        // First launch — download default (Pianissimo, svenska, CPU)
        await downloadAndActivate("pianissimo", "standard", true);
        return;
      }
    }

    const revLabel = modelRevision !== "standard" ? ` ${modelRevision}` : "";
    const fmtName = modelSize === "pianissimo"
      ? "Pianissimo · Snabb (svenska)"
      : modelSize === "turbo"
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
// Ungefärlig nedladdningsstorlek i MB. Okomprimerade varianter är betydligt
// större — används för att visa storlek på knappen och varna före stora hämtningar.
const MODEL_SIZES_MB = {
  "medium-true": 900,  "medium-false": 1500,
  "large-true": 2000,  "large-false": 3000,
  "turbo-true": 1500,  "turbo-false": 1500,   // turbo är alltid q8_0
  "pianissimo-true": 700, "pianissimo-false": 700, // Pianissimo int8 (en variant)
};


// ─────────────────────────────────────────────────────────────────────────────
// Motorval: Pianissimo klarar bara svenska. För engelska/automatiskt språk byter
// vi tyst till en nedladdad Whisper-modell så att användaren slipper tänka på det.
// ─────────────────────────────────────────────────────────────────────────────
async function resolveEngine() {
  const current = { size: modelSize, quantized: modelQuantized, revision: modelRevision };
  if (modelSize !== "pianissimo" || transcriptionLanguage === "sv") return current;
  const available = await invoke("get_available_models");
  for (const s of ["turbo", "large", "medium"]) {
    const m = available.find(x => x.size === s);
    if (m) return { size: m.size, quantized: m.quantized, revision: m.revision };
  }
  throw new Error(
    "Modellen \"Snabbast\" (Pianissimo) klarar bara svenska. " +
    "Välj språket Svenska, eller ladda ned en Whisper-modell (t.ex. \"Flera språk\") under Inställningar."
  );
}

function updateEngineLanguageNote() {
  const note = document.getElementById("engine-language-note");
  if (note) note.classList.toggle("hidden", !(modelSize === "pianissimo" && transcriptionLanguage !== "sv"));
}

function modelSizeMb(size, quantized) {
  return MODEL_SIZES_MB[`${size}-${quantized}`] ?? 1000;
}

function formatMb(mb) {
  return mb >= 1000 ? `${(mb / 1000).toFixed(1).replace(".0", "")} GB` : `${mb} MB`;
}

// Visar nedladdningsstorleken på knappen så den syns innan man klickar.
// Uppdateras när storlek eller kvantisering ändras.
function updateDownloadButtonLabel() {
  const btn = document.getElementById("btn-download-model");
  if (!btn) return;
  const label = btn.querySelector(".download-label");
  if (!label) return;
  const quantized = cbModelQuantized ? cbModelQuantized.checked : true;
  label.textContent = `Ladda ner · ${formatMb(modelSizeMb(dlSize, quantized))}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Kvalitetsval — tre namngivna alternativ i stället för att låta användaren
// kombinera Stil × Storlek × Format själv (9 varianter). Varje val motsvarar en
// färdig kombination; "Ordagrann" är ortogonalt och ligger som egen kryssruta.
// ─────────────────────────────────────────────────────────────────────────────
const QUALITY_PRESETS = {
  fast:     { size: "pianissimo", supportsVerbatim: false }, // Pianissimo: svenska, CPU
  balanced: { size: "medium", supportsVerbatim: true  },
  best:     { size: "large",  supportsVerbatim: true  },
  multi:    { size: "turbo",  supportsVerbatim: false }, // Turbo saknar KB-varianter
};
let dlQuality = "fast";

const QUALITY_ACTIVE = "quality-btn flex items-start gap-3 px-3 py-2.5 border rounded-xl transition-colors text-left bg-primary/5 border-primary/40 text-slate-800 dark:text-white";
const QUALITY_IDLE   = "quality-btn flex items-start gap-3 px-3 py-2.5 border rounded-xl transition-colors text-left bg-slate-50 dark:bg-slate-900 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:border-primary/30";

function applyQuality(quality) {
  const preset = QUALITY_PRESETS[quality] ?? QUALITY_PRESETS.balanced;
  dlQuality = quality;
  dlSize = preset.size;

  // Ordagrann gäller bara KB-modellerna; dölj valet för "Flera språk".
  const verbatimRow = document.getElementById("verbatim-row");
  const verbatim = document.getElementById("model-verbatim");
  if (verbatimRow) verbatimRow.classList.toggle("hidden", !preset.supportsVerbatim);
  if (!preset.supportsVerbatim && verbatim) verbatim.checked = false;
  dlRevision = (preset.supportsVerbatim && verbatim && verbatim.checked) ? "strict" : "standard";

  document.querySelectorAll("[data-quality]").forEach(b => {
    b.className = b.dataset.quality === quality ? QUALITY_ACTIVE : QUALITY_IDLE;
  });
  updateDownloadButtonLabel();
}

document.querySelectorAll("[data-quality]").forEach(btn => {
  btn.addEventListener("click", () => applyQuality(btn.dataset.quality));
});

document.getElementById("model-verbatim")?.addEventListener("change", () => {
  applyQuality(dlQuality);
});

applyQuality(dlQuality);

// -------------------------------------------------------------
// Settings Logic
// -------------------------------------------------------------
btnSettings.addEventListener("click", () => {
  loadSettings(); // refresh form
  settingsModal.classList.remove("hidden");
  refreshRecordingsUsage();
});

// Visar antal inspelningar + total storlek i settings (Mapp för inspelningar).
async function refreshRecordingsUsage() {
  const el = document.getElementById("recordings-usage");
  if (!el) return;
  el.textContent = "";
  try {
    const sum = await invoke("count_recordings", { dir: recordingDir });
    if (sum.count > 0) {
      const mb = (sum.total_bytes / 1048576).toFixed(0);
      el.textContent = `${sum.count} inspelning${sum.count === 1 ? "" : "ar"} · ${mb} MB`;
    } else {
      el.textContent = "Inga sparade inspelningar.";
    }
  } catch (_) { /* tyst — diskinfo är icke-kritisk */ }
}

// Radera alla sessionsmappar i recordingDir efter bekräftelse.
document.getElementById("btn-delete-recordings")?.addEventListener("click", async () => {
  try {
    const sum = await invoke("count_recordings", { dir: recordingDir });
    if (!sum.count) {
      await message("Det finns inga inspelningar att radera.", { title: "Inget att radera" });
      return;
    }
    const mb = (sum.total_bytes / 1048576).toFixed(0);
    const ok = await showConfirm(`Radera ${sum.count} inspelning${sum.count === 1 ? "" : "ar"} (${mb} MB)? Detta kan inte ångras.`, "Radera inspelningar");
    if (!ok) return;
    // Släpp ev. öppet ljud-handtag innan radering — annars kan <audio> som spelar
    // recording.wav blockera fs::remove_dir_all på Windows.
    teardownPlayer();
    logToFile("delete_all_recordings: teardownPlayer körd före radering");
    const n = await invoke("delete_all_recordings", { dir: recordingDir });
    await message(`${n} inspelning${n === 1 ? "" : "ar"} raderades.`, { title: "Klart" });
    refreshRecordingsUsage();
  } catch (e) {
    const msg = typeof e === "string" ? e : e.message || String(e);
    await message(`Kunde inte radera: ${msg}`, { title: "Fel", kind: "error" });
  }
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

  // Confidence threshold
  const confSlider = document.getElementById("confidence-threshold-slider");
  if (confSlider) {
    confidenceThreshold = parseInt(confSlider.value) / 100;
    localStorage.setItem("confidenceThreshold", confidenceThreshold.toString());
    // Re-render segment editor if visible to reflect new threshold
    if (segmentViewActive && transcriptSegments.length > 0) renderSegmentEditor();
  }

  transcriptionLanguage = newLang;
  updateEngineLanguageNote();
  selectedMicId = newMicId;
  wasapiEnabled = newWasapi;

  settingsModal.classList.add("hidden");
  updateFooter();
});

// Kvantiseringen påverkar nedladdningsstorleken — uppdatera knappetiketten.
// Varna direkt vid urkryssning: "kvantiserad" låter som en försämring, men är
// rekommendationen. Utan detta laddar folk ner 3 GB i tron att de får bättre kvalitet.
if (cbModelQuantized) {
  cbModelQuantized.addEventListener("change", async () => {
    updateDownloadButtonLabel();
    if (!cbModelQuantized.checked) {
      const full = formatMb(modelSizeMb(dlSize, false));
      const comp = formatMb(modelSizeMb(dlSize, true));
      const ok = await showConfirm(
        `Den okomprimerade modellen är ${full} i stället för ${comp}, utan märkbart bättre ` +
        "resultat.\n\nVill du ändå välja den?",
        "Större nedladdning");
      if (!ok) {
        cbModelQuantized.checked = true;
        updateDownloadButtonLabel();
      }
    }
  });
}

// "Ladda ner vald modell" — always downloads the selected combination.
// Skyddar mot oavsiktliga stora hämtningar: visar storleken, bekräftar över 1 GB
// och varnar om disken inte räcker. Tidigare startade nedladdningen direkt utan
// någon kontroll — man kunde dra ner 3 GB av misstag.
const LARGE_DOWNLOAD_MB = 1000;

if (btnDownloadModel) {
  btnDownloadModel.addEventListener("click", async () => {
    const quantized = (dlSize === "pianissimo") ? true : (cbModelQuantized ? cbModelQuantized.checked : true);
    const sizeMb = modelSizeMb(dlSize, quantized);
    const sizeText = formatMb(sizeMb);

    // Diskkontroll — behövs plats för modellen plus lite marginal.
    try {
      const info = await invoke("get_disk_info");
      const freeMb = info.available_space / 1048576;
      if (freeMb < sizeMb * 1.1) {
        await message(
          `Modellen behöver ${sizeText} men det finns bara ${formatMb(Math.round(freeMb))} ledigt.\n\n` +
          "Frigör utrymme och försök igen, eller välj en mindre modell.",
          { title: "För lite diskutrymme", kind: "error" });
        return;
      }
    } catch (_) { /* diskinfo är icke-kritisk — fortsätt */ }

    // Bekräfta stora nedladdningar.
    if (sizeMb >= LARGE_DOWNLOAD_MB) {
      const ok = await showConfirm(
        `Modellen är ${sizeText} och laddas ner en gång. Det kan ta en stund på en långsam ` +
        "uppkoppling, och appen är upptagen under tiden.\n\nVill du fortsätta?",
        "Ladda ner modell");
      if (!ok) return;
    }

    settingsModal.classList.add("hidden");
    await downloadAndActivate(dlSize, dlRevision, quantized);
  });
}

// Redo transcription with different model
btnRedo.addEventListener("click", async () => {
  if (!lastTranscribedPath) return;

  const confirmed = await showConfirm("Vill du göra om transkriberingen med nuvarande inställningar?", "Gör om transkribering");
  if (!confirmed) return;

  btnRedo.classList.add("hidden");
  // Rust avkodar och transkriberar filen igen.
  await processAudioFile(lastTranscribedPath);
  btnRedo.classList.remove("hidden");
  btnRedo.style.display = "inline-flex";
});

// -------------------------------------------------------------
// Audio Recording Logic – Session/Segment model
// -------------------------------------------------------------
btnRecord.addEventListener("click", async () => {
  if (!isRecording && !isPaused) {
    // F2: varna om det finns en transkribering — kolla BÅDE råtext och segmentvy
    // (segmentvyns text ligger i transcriptSegments, inte i outputText).
    if ((outputText.value && outputText.value.trim()) || transcriptSegments.length > 0) {
      const confirmed = await showConfirm();
      if (!confirmed) return;
    }
    // Varna vid lågt diskutrymme (blockerar inte, bara bekräftar)
    if (!(await checkDiskBeforeRecording())) return;
    await startRecording();
  } else {
    await stopSession();
  }
});

// Show custom HTML confirm dialog, returns a Promise<boolean>
// Sätter ALLTID texten — annars ligger ett tidigare anrops meddelande kvar
// (t.ex. "Radera N inspelningar" visades felaktigt vid ny inspelning).
const CONFIRM_DEFAULT_MSG = "Du har en transkribering som inte sparats. En ny inspelning kommer att ersätta den.";
const CONFIRM_DEFAULT_TITLE = "Ny inspelning";
function showConfirm(msg, title) {
  return new Promise(resolve => {
    if (!confirmModal) { resolve(true); return; }
    const p = confirmModal.querySelector("p");
    if (p) p.innerText = msg || CONFIRM_DEFAULT_MSG;
    const h = document.getElementById("confirm-title");
    if (h) h.innerText = title || CONFIRM_DEFAULT_TITLE;
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

function formatTimestamp(date) {
  return date.toLocaleString('sv-SE', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit'
  });
}

async function startRecording() {
  const isWindows = navigator.userAgent.includes('Windows');
  if (!isWindows) {
    await message("Inspelning stöds just nu bara i Windows-versionen. Du kan öppna en ljudfil i stället.",
      { title: "Inspelning ej tillgänglig", kind: "info" });
    return;
  }
  logToFile(`startRecording: isWindows=${isWindows}, wasapiEnabled=${wasapiEnabled}, selectedMicId=${selectedMicId}, recordingDir=${recordingDir || "<default>"}`);
  // Discard any pending post-recording choice if user starts a new recording
  if (pendingRecording) {
    pendingRecording = null;
    hidePostRecordingActions();
  }
  // Rensa eventuell player från en föregående session
  teardownPlayer();
  // v1.5: rensa transkriberingsfönstret + segment-state vid ny inspelning så
  // gammal text/segment inte ligger kvar (state-läckage). Varningsrutan har redan
  // körts i btn-record-handlern innan vi kommer hit.
  outputText.value = "";
  transcriptSegments = [];
  segmentRowsCache = [];
  const prevEditor = document.getElementById("segment-editor");
  if (prevEditor) prevEditor.innerHTML = "";
  showRawView();
  btnRedo.classList.add("hidden");
  if (btnSaveAudio) btnSaveAudio.classList.add("hidden");
  document.getElementById("btn-segment-toggle")?.classList.add("hidden");
  wasapiRecordingReady = false;
  lastTranscribedPath = null;
  try {
    let recordingStatusMsg = "Spelar in...";
    // v1.4.6: På Windows använder vi ALLTID Rust-backend för tempfiler/krasch-skydd.
    // wasapiEnabled styr bara om systemljud (loopback) ska fångas eller inte —
    // mic-flödet via AudioWorklet + append_mic_chunk är konstant.
    // Mac pausat: ingen inspelning där tills vidare (se guard överst).
    if (isWindows) {
      logToFile(`startRecording: Windows Rust-backend (with_loopback=${wasapiEnabled})`);
      let resolvedMicId = selectedMicId;
      if (selectedMicId === "default" && firstMicDeviceId) resolvedMicId = firstMicDeviceId;
      const audioConstraints = resolvedMicId === "default"
        ? { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }
        : { audio: { deviceId: { exact: resolvedMicId }, echoCancellation: true, noiseSuppression: true, autoGainControl: true } };

      logToFile("startRecording: anropar getUserMedia");
      micStream = await navigator.mediaDevices.getUserMedia(audioConstraints);
      logToFile("startRecording: getUserMedia OK");

      audioContext = new (window.AudioContext || window.webkitAudioContext)();
      logToFile(`startRecording: AudioContext skapad (sampleRate=${audioContext.sampleRate})`);
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

      // v1.4.0: Streama mic-PCM direkt till Rust istället för att samla MediaRecorder-blobs.
      // Eliminerar JS-side mic-blob-buffring (~150 MB för 1.5h) och OOM-krasch vid stop.
      // AudioWorklet: samlar 128-sampleblock till 4096 i ljudtråden och skickar dem hit.
      const workletSrc = `
        class MicCapture extends AudioWorkletProcessor {
          constructor() { super(); this.buf = new Float32Array(4096); this.n = 0; }
          process(inputs) {
            const ch = inputs[0] && inputs[0][0];
            if (ch) {
              for (let i = 0; i < ch.length; i++) {
                this.buf[this.n++] = ch[i];
                if (this.n === this.buf.length) {
                  this.port.postMessage(this.buf.buffer, [this.buf.buffer]);
                  this.buf = new Float32Array(4096);
                  this.n = 0;
                }
              }
            }
            return true;
          }
        }
        registerProcessor("mic-capture", MicCapture);`;
      const workletUrl = URL.createObjectURL(new Blob([workletSrc], { type: "text/javascript" }));
      const wasapiSampleRate = audioContext.sampleRate;  // typiskt 48000 eller 44100
      await audioContext.audioWorklet.addModule(workletUrl);
      URL.revokeObjectURL(workletUrl);
      const wasapiProcessor = new AudioWorkletNode(audioContext, "mic-capture", {
        numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1,
      });
      wasapiProcessor.port.onmessage = (e) => {
        if (!isRecording || isPaused) return;
        // Rå binär payload (f32 LE) — ingen JSON-array av tal.
        invoke("append_mic_chunk", new Uint8Array(e.data), { headers: { "x-sample-rate": String(wasapiSampleRate) } })
          .catch(err => console.warn("append_mic_chunk:", err));
      };
      wasapiSource.connect(wasapiProcessor);
      // Noden måste vara ansluten för att köras; den skriver inget till utgången (tystnad).
      wasapiProcessor.connect(audioContext.destination);
      // Spara så vi kan stänga ner vid stop
      window.__wasapiProcessor = wasapiProcessor;
      window.__wasapiSource = wasapiSource;

      // Start backend recording — Rust skapar session-mapp + mic-writer + ev. loopback-trådar.
      logToFile(`startRecording: anropar invoke("start_backend_recording") med withLoopback=${wasapiEnabled}, recordingDir=${recordingDir || "<null>"}`);
      const result = await invoke("start_backend_recording", {
        loopbackOnly: true,
        withLoopback: wasapiEnabled,
        recordingDir: recordingDir || null,
      });
      logToFile(`startRecording: start_backend_recording returnerade loopback_active=${result.loopback_active}`);

      isRecording = true;
      isPaused = false;
      drawVisualizer();
      startRecordingMetrics();

      if (wasapiEnabled) {
        recordingStatusMsg = result.loopback_active
          ? "Spelar in (mikrofon + systemljud)"
          : "Spelar in (mikrofon — systemljud ej tillgängligt)";
      } else {
        recordingStatusMsg = "Spelar in (mikrofon)";
      }
      const loopbackIndicator = document.getElementById("loopback-indicator");
      if (loopbackIndicator) {
        if (result.loopback_active) loopbackIndicator.classList.remove("hidden");
        else loopbackIndicator.classList.add("hidden");
      }
    }

    // UI Updates
    btnRecord.classList.add("recording");
    setRecordingUI("recording");
    if (recordingStatusText) recordingStatusText.textContent = recordingStatusMsg;
    // Paus stöds inte i Rust-backend-flödet
    if (btnPause) btnPause.classList.add("hidden");
    if (segmentBadge) segmentBadge.classList.add("hidden");
    disableControls();
    btnRecord.disabled = false;
  } catch (err) {
    const errMsg = err && (err.stack || err.message || String(err));
    console.error("startRecording error:", err);
    logToFile(`startRecording: CATCH ${errMsg}`);
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
    // Skilj på nekad behörighet (vanligast, och åtgärdbart) och övriga fel.
    const namn = err && err.name ? err.name : "";
    const nekad = namn === "NotAllowedError" || namn === "SecurityError";
    const saknas = namn === "NotFoundError" || namn === "OverconstrainedError";
    if (nekad) {
      await message(
        "Appen får inte använda mikrofonen.\n\n" +
        "Öppna Inställningar → Sekretess och säkerhet → Mikrofon i Windows och " +
        "tillåt Transkribera. Starta sedan om appen.",
        { title: 'Mikrofonen är blockerad', kind: 'error' });
    } else if (saknas) {
      await message(
        "Ingen mikrofon hittades.\n\n" +
        "Kontrollera att mikrofonen är inkopplad och vald i listan högst upp i appen.",
        { title: 'Ingen mikrofon', kind: 'error' });
    } else {
      await message(
        "Inspelningen kunde inte starta.\n\n" +
        `Teknisk information: ${err.message || err}`,
        { title: 'Kunde inte spela in', kind: 'error' });
    }
  }
}

// Strippar filnamnet ur en recording-path → sessionsmappen (.../inspelning-X/recording.wav → .../inspelning-X)
function sessionDirFromRecordingPath(p) {
  return p ? p.replace(/[/\\][^/\\]+$/, "") : "";
}

function showPostRecordingActions(sessionDir) {
  document.getElementById("post-recording-actions")?.classList.remove("hidden");
  // Namnfältet döper om sessionsmappen — visa det bara när en sådan finns.
  // Mac-flödet (MediaRecorder, type "segments") har inga filer på disk ännu,
  // så där finns ingen mapp att namnge.
  const nameRow = document.getElementById("session-name-row");
  const nameInput = document.getElementById("session-name-input");
  if (nameInput) nameInput.value = "";
  if (nameRow) nameRow.classList.toggle("hidden", !sessionDir);
  const btn = document.getElementById("post-recording-path");
  const txt = document.getElementById("post-recording-path-text");
  if (btn && txt) {
    if (sessionDir) {
      txt.textContent = sessionDir;
      btn.dataset.path = sessionDir;
      btn.classList.remove("hidden");
    } else {
      delete btn.dataset.path;
      btn.classList.add("hidden");
    }
  }
}

function hidePostRecordingActions() {
  document.getElementById("post-recording-actions")?.classList.add("hidden");
}

async function saveRecordedAudio() {
  try {
    if (!wasapiRecordingReady) {
      await message("Ingen inspelning att spara.", { title: "Fel", kind: "error" });
      return;
    }
    await invoke("save_audio_file");
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

  // Återställd inspelning: behandla som en filimport av recording.wav
  if (rec.type === "wav-file") {
    // filePath kan vara null (WASAPI-flödet) — då hämtar vi Rusts recording_path
    let path = rec.filePath;
    if (!path) {
      try { path = await invoke("get_recording_path"); }
      catch (e) {
        await message(`Ingen inspelning att transkribera: ${e}`, { title: "Fel", kind: "error" });
        return;
      }
    }
    await processAudioFile(path);
    return;
  }
}

async function stopSession() {
  const isWindows = navigator.userAgent.includes('Windows');
  // v1.4.6: matchar startRecording-grenen. Windows använder alltid Rust-backend,
  // oavsett om systemljud (wasapiEnabled) är aktiverat eller inte.
  if (isWindows) {
    isRecording = false;
    isPaused = false;
    stopRecordingMetrics();

    btnRecord.classList.remove("recording");
    setRecordingUI("idle");
    document.getElementById("loopback-indicator")?.classList.add("hidden");
    disableControls();

    // Stoppa mikrofonnoden
    if (window.__wasapiProcessor) {
      try { window.__wasapiProcessor.disconnect(); } catch (_) {}
      window.__wasapiProcessor = null;
    }
    if (window.__wasapiSource) {
      try { window.__wasapiSource.disconnect(); } catch (_) {}
      window.__wasapiSource = null;
    }

    if (micStream) micStream.getTracks().forEach(t => t.stop());
    if (audioContext && audioContext.state !== "closed") {
      audioContext.close();
      audioContext = null;
    }

    loadingText.innerText = "Avslutar inspelning...";
    loadingOverlay.classList.remove("hidden");

    try {
      // Rust mixar mic.wav + lb_console.wav + lb_comms.wav till recording.wav
      // och returnerar dess bytes (kompatibelt kontrakt, men vi använder dem inte längre)
      await invoke("stop_backend_recording");
      wasapiRecordingReady = true;

      // Recording.wav finns nu på disk — peka direkt på den utan JS-mix-decode
      // (inga 1 GB Float32-allokationer som i v1.3.x).
      // recording_path är satt i AudioRecorder; vi använder den för både save och transcribe.
      pendingRecording = { type: "wav-file", filePath: null };  // null = "använd Rusts recording_path"
      lastRecordedSegments = [{ startTime: new Date() }];
      loadingOverlay.classList.add("hidden");
      // Hämta sessionsmappen så dialogen kan visa + öppna sökvägen
      let sessionDir = "";
      try { sessionDir = sessionDirFromRecordingPath(await invoke("get_recording_path")); } catch (_) {}
      showPostRecordingActions(sessionDir);
    } catch (err) {
      console.error("WASAPI stop error:", err);
      wasapiRecordingReady = false;
      // Viktigt: ljudet streamas till disk under inspelningen, så det finns kvar
      // även när det här steget misslyckas. Säg det — annars tror användaren att
      // mötet är förlorat.
      const detalj = typeof err === "string" ? err : err.message || String(err);
      await message(
        "Inspelningen kunde inte förberedas för uppspelning.\n\n" +
        "Ljudet finns kvar på disk. Öppna det med \"Öppna fil/mapp\" → " +
        "\"En tidigare inspelning\" och välj den senaste mappen.\n\n" +
        `Teknisk information: ${detalj}`,
        { title: 'Inspelningen är sparad', kind: 'warning' });
    } finally {
      loadingOverlay.classList.add("hidden");
      enableControls();
    }
    return;
  }
}

// -------------------------------------------------------------
// File Selection Logic
// -------------------------------------------------------------
// Visar import-valmodalen och resolvar med "file" | "folder" | null (avbruten).
function showImportChoice() {
  return new Promise(resolve => {
    const modal  = document.getElementById("import-choice-modal");
    const fileBtn   = document.getElementById("import-choice-file");
    const folderBtn = document.getElementById("import-choice-folder");
    const cancelBtn = document.getElementById("import-choice-cancel");
    if (!modal || !fileBtn || !folderBtn || !cancelBtn) { resolve(null); return; }
    modal.classList.remove("hidden");
    const cleanup = () => {
      modal.classList.add("hidden");
      fileBtn.removeEventListener("click", onFile);
      folderBtn.removeEventListener("click", onFolder);
      cancelBtn.removeEventListener("click", onCancel);
    };
    const onFile   = () => { cleanup(); resolve("file"); };
    const onFolder = () => { cleanup(); resolve("folder"); };
    const onCancel = () => { cleanup(); resolve(null); };
    fileBtn.addEventListener("click", onFile);
    folderBtn.addEventListener("click", onFolder);
    cancelBtn.addEventListener("click", onCancel);
  });
}

btnFile.addEventListener("click", async () => {
  const choice = await showImportChoice();
  if (!choice) return;
  try {
    if (choice === "file") {
      const selected = await invoke("pick_audio_file");
      if (selected) {
        disableControls();
        await processAudioFile(selected);
      }
      return;
    }
    // choice === "folder": öppna en tidigare inspelning. Appen avgör själv om
    // mappen behöver repareras (avbruten inspelning där råspåren finns men
    // recording.wav saknas) eller redan är färdig — användaren ska inte behöva
    // känna till skillnaden.
    const dir = await window.__TAURI__.dialog.open({
      directory: true,
      multiple: false,
      defaultPath: recordingDir || undefined,
      title: "Välj en tidigare inspelning",
    });
    if (typeof dir !== "string" || !dir) return;
    const info = await invoke("inspect_session_dir", { dir });
    if (!info.is_session) {
      await message(
        "Den här mappen innehåller ingen inspelning.\n\n" +
        "Välj en mapp som börjar med \"inspelning-\" — de skapas automatiskt när du spelar in.",
        { title: "Ingen inspelning hittades", kind: "error" });
      return;
    }
    // Avbruten inspelning (råspår men ingen färdig recording.wav) → laga först.
    const needsRepair = !info.has_ready_recording;
    if (needsRepair) {
      logToFile("import: avbruten inspelning upptäckt — reparerar och mixar råspåren");
    }
    await importSessionFolder(dir, needsRepair);
  } catch (e) {
    console.error("Import misslyckades:", e);
  }
});

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

// Bygger en enskild segment-rad. Extraherad från renderSegmentEditor så att
// progressive rendering kan anropa den per chunk.
function buildSegmentRow(seg, idx) {
  const row = document.createElement("div");
  row.className = "segment-row";
  row.dataset.idx = idx;

  const ts = document.createElement("span");
  ts.className = "segment-ts";
  ts.textContent = formatMs(seg.startMs);
  ts.title = "Klicka för att spela från denna tidpunkt";
  ts.addEventListener("click", () => seekPlayer(seg.startMs));

  const confView = buildConfidenceView(seg);
  confView.title = "Klicka för att redigera";

  const ta = document.createElement("textarea");
  ta.className = "segment-input hidden";
  ta.value = seg.text;
  ta.rows = 1;
  const autoGrow = () => { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + "px"; };
  ta.addEventListener("input", () => {
    transcriptSegments[idx].text = ta.value;
    transcriptSegments[idx].tokens = [];
    outputText.value = buildPlainText();
    autoGrow();
  });
  ta.addEventListener("focus", () => row.classList.add("ring-1", "ring-primary/30", "rounded-lg"));
  ta.addEventListener("blur", () => {
    row.classList.remove("ring-1", "ring-primary/30", "rounded-lg");
    const newView = buildConfidenceView(transcriptSegments[idx]);
    newView.title = "Klicka för att redigera";
    newView.addEventListener("click", () => { newView.classList.add("hidden"); ta.classList.remove("hidden"); requestAnimationFrame(autoGrow); ta.focus(); });
    // Ersätt den befintliga vyn (eller sätt in en ny). Tidigare fanns här ett
    // extra replaceChild som kastade NotFoundError när confView redan bytts ut —
    // raderna nedan gör jobbet korrekt på egen hand.
    ta.classList.add("hidden");
    const existing = row.querySelector(".segment-view");
    if (existing) row.replaceChild(newView, existing);
    else row.insertBefore(newView, ta);
  });

  confView.addEventListener("click", () => {
    confView.classList.add("hidden");
    ta.classList.remove("hidden");
    requestAnimationFrame(autoGrow);
    ta.focus();
  });

  row.appendChild(ts);
  row.appendChild(confView);
  row.appendChild(ta);
  // autoGrow körs lazy via IntersectionObserver i renderSegmentEditor
  // — bara för rader som faktiskt scrollas in i bild.
  row._autoGrowFn = autoGrow;
  return row;
}

// Aktiv observer för lazy autoGrow — avregistreras vid omrendering
let autoGrowObserver = null;

function renderSegmentEditor() {
  const editor = document.getElementById("segment-editor");
  if (!editor) return;
  editor.replaceChildren();
  segmentRowsCache = [];
  currentActiveSegIdx = -1;

  if (autoGrowObserver) autoGrowObserver.disconnect();
  autoGrowObserver = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (!e.isIntersecting) return;
      const row = e.target;
      if (row.dataset.grown) return;
      if (typeof row._autoGrowFn === "function") row._autoGrowFn();
      row.dataset.grown = "1";
    });
  }, { rootMargin: "200px" });

  const CHUNK = 50;
  let i = 0;
  const total = transcriptSegments.length;

  function renderBatch(deadline) {
    const frag = document.createDocumentFragment();
    let added = 0;
    const hasDeadline = deadline && typeof deadline.timeRemaining === "function";
    while (i < total && added < CHUNK && (!hasDeadline || deadline.timeRemaining() > 4 || deadline.didTimeout)) {
      const row = buildSegmentRow(transcriptSegments[i], i);
      frag.appendChild(row);
      segmentRowsCache.push(row);
      i++;
      added++;
    }
    editor.appendChild(frag);
    // observera dem efter de är i DOM
    for (let j = segmentRowsCache.length - added; j < segmentRowsCache.length; j++) {
      autoGrowObserver.observe(segmentRowsCache[j]);
    }
    if (i < total) {
      if (typeof requestIdleCallback === "function") {
        requestIdleCallback(renderBatch, { timeout: 100 });
      } else {
        setTimeout(() => renderBatch({ timeRemaining: () => 16, didTimeout: false }), 0);
      }
    }
  }

  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(renderBatch, { timeout: 100 });
  } else {
    renderBatch({ timeRemaining: () => 16, didTimeout: false });
  }
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

// v1.5.3: Sätt upp spelaren från en disk-path via Tauri asset protocol.
// <audio> streamar filen on-demand från disk — INGEN blob i JS-minnet (undviker
// OOM-läckan från v1.3.x). Används i Windows-flödet (processAudioFile).
async function setupPlayerFromPath(filePath) {
  if (!filePath || !audioPlayer) return;
  teardownPlayer();                 // släpp ev. tidigare källa + fil-handtag
  // Tillåt EXAKT denna fil i asset-scopen (config-scopen är tom — vi öppnar aldrig
  // hela filsystemet). Misslyckas detta kan filen inte spelas; logga och avbryt.
  try {
    await invoke("allow_asset_path", { path: filePath });
  } catch (e) {
    logToFile(`setupPlayerFromPath: allow_asset_path misslyckades: ${e}`);
    return;
  }
  const assetUrl = window.__TAURI__.core.convertFileSrc(filePath);
  currentPlaybackUrl = null;        // ingen blob-URL att revoka
  currentPlaybackIsAsset = true;
  audioPlayer.src = assetUrl;
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

// Tear down audio player. Anropas vid ny session (filimport eller inspelning)
// så att en föregående sessions player inte hänger kvar.
function teardownPlayer() {
  if (audioPlayer) {
    try { audioPlayer.pause(); } catch (_) {}
    audioPlayer.removeAttribute("src");
    audioPlayer.load();
  }
  if (currentPlaybackUrl) { URL.revokeObjectURL(currentPlaybackUrl); currentPlaybackUrl = null; }
  currentPlaybackIsAsset = false;
  const playerBar = document.getElementById("player-bar");
  if (playerBar) playerBar.classList.add("hidden");
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

    if (segmentViewActive && segmentRowsCache.length > 0) {
      // Binary search istället för O(n) querySelectorAll på varje timeupdate-event
      let lo = 0, hi = transcriptSegments.length - 1, found = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const seg = transcriptSegments[mid];
        if (ms < seg.startMs)     hi = mid - 1;
        else if (ms >= seg.endMs) lo = mid + 1;
        else { found = mid; break; }
      }
      if (found !== currentActiveSegIdx) {
        if (currentActiveSegIdx >= 0) {
          segmentRowsCache[currentActiveSegIdx]?.classList.remove("segment-active");
        }
        if (found >= 0) {
          const row = segmentRowsCache[found];
          if (row) {
            row.classList.add("segment-active");
            row.scrollIntoView({ block: "nearest", behavior: "smooth" });
          }
        }
        currentActiveSegIdx = found;
      }
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
    // Källan kunde inte laddas/spelas (fil saknas, ej spelbart format, scope-block).
    // Dölj player-bar gracefully — segmentvyn/texten fungerar ändå.
    document.getElementById("player-bar")?.classList.add("hidden");
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

// -------------------------------------------------------------
// processAudioFile — Rust-side decode + transcribe (no JS heap allocation)
// -------------------------------------------------------------
async function processAudioFile(filePath) {
  lastTranscribedPath = filePath;
  try {
    // Stäng ev. kvarvarande post-recording-overlay innan ny transkribering visas
    // (annars ligger den blurrad ovanpå resultatet om man importerar utan att välja
    // transkribera/spara i dialogen).
    hidePostRecordingActions();
    pendingRecording = null;

    const fileName = filePath.split(/[/\\]/).pop();
    loadingText.innerText = `Avkodar ${fileName}...`;
    loadingOverlay.classList.remove("hidden");
    if (progressContainer) progressContainer.classList.remove("hidden");
    if (progressBar) progressBar.style.width = "0%";

    outputText.value = "";
    transcriptSegments = [];
    teardownPlayer();
    showRawView();

    const initialPrompt = personalVocabulary.length > 0 ? personalVocabulary.join(", ") : null;
    isCancelling = false;
    if (btnCancelTranscription) btnCancelTranscription.classList.remove("hidden");
    // Rust beräknar overall-progress (0–99%) och emitterar det direkt.
    // Sätt totalChunks=1 så att JS-lyssnaren passerar Rusts värde rakt igenom.
    totalChunks     = 1;
    currentChunkIdx = 0;
    const startTime = performance.now();

    logToFile(`processAudioFile: anropar invoke("transcribe_file") för ${filePath}`);
    const segs = await invoke("transcribe_file", {
      filePath,
      ...(await resolveEngine()),
      language:     transcriptionLanguage,
      initialPrompt,
      useGpu,
      threadCount,
      gpuDevice: gpuDeviceIndex
    });
    logToFile(`processAudioFile: transcribe_file returnerade ${segs ? segs.length : 0} segment`);

    if (segs && segs.length > 0) {
      // Rust serialiserar camelCase (startMs, endMs, text, tokens) — används som det är.
      transcriptSegments = segs.map(s => ({ ...s, tokens: s.tokens || [] }));
      logToFile(`processAudioFile: mapped till transcriptSegments (${transcriptSegments.length} st)`);
      outputText.value = transcriptSegments.map(s => s.text).join("\n");
      logToFile(`processAudioFile: outputText.value satt (${outputText.value.length} tecken)`);
    }

    if (progressBar) progressBar.style.width = "100%";
    const elapsed = Math.round((performance.now() - startTime) / 1000);
    const elMin   = Math.floor(elapsed / 60);
    const elSec   = elapsed % 60;
    loadingText.innerText = `Klar! (${elMin > 0 ? `${elMin}m ` : ""}${elSec}s)`;
    outputText.value += `\n\n[Transkribering klar]`;
    outputText.scrollTop = outputText.scrollHeight;

    if (transcriptSegments.length > 0) {
      logToFile(`processAudioFile: anropar renderSegmentEditor (${transcriptSegments.length} segment)`);
      renderSegmentEditor();
      logToFile(`processAudioFile: renderSegmentEditor returnerade`);
      const btnSeg = document.getElementById("btn-segment-toggle");
      showSegmentView();
      logToFile(`processAudioFile: showSegmentView klar`);
      if (btnSeg) { btnSeg.classList.remove("hidden"); btnSeg.style.display = "inline-flex"; }
      // v1.5.3: aktivera synkad spelare som streamar filen direkt från disk
      await setupPlayerFromPath(filePath);
    }
  } catch (err) {
    console.error("transcribe_file error:", err);
    logToFile(`processAudioFile: FEL ${err && err.stack ? err.stack : err}`);
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
      // Behåll ikonspråket (Material Symbols) i stället för en emoji.
      const prevIcon = btnCopy.innerHTML;
      btnCopy.innerHTML =
        `<span class="material-symbols-outlined text-lg">check</span><span>Kopierad!</span>`;
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
// Save Audio File
// Decodes lastRecordedSegments to Float32, encodes as 16-bit PCM WAV, saves via dialog.
// Works for both regular mic mode (WebM blobs) and WASAPI mode (PCM WAV blob).
// ─────────────────────────────────────────────────────────────────────────────
const btnSaveAudio = document.getElementById("btn-save-audio");

btnSaveAudio && btnSaveAudio.addEventListener("click", () => saveRecordedAudio());

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

// Döper om sessionsmappen om användaren skrivit ett namn. Körs före varje
// åtgärd i dialogen så namnet aldrig tappas. Tomt fält = ingen omdöpning.
// Uppdaterar pendingRecording.filePath eftersom sökvägen ändras vid omdöpning.
async function applySessionName() {
  const input = document.getElementById("session-name-input");
  const name = input ? input.value.trim() : "";
  if (!name) return;
  try {
    const newPath = await invoke("rename_session", { name });
    if (pendingRecording && pendingRecording.type === "wav-file") {
      pendingRecording.filePath = newPath;
    }
    logToFile(`applySessionName: sessionen sparad som "${name}"`);
  } catch (e) {
    // Omdöpning är en bekvämlighet — misslyckas den ska flödet ändå fortsätta utan
    // att stoppa användaren med en dialog. Inspelningen finns kvar oavsett; felet
    // hamnar i loggen för felsökning.
    const msg = typeof e === "string" ? e : e.message || String(e);
    logToFile(`applySessionName: kunde inte döpa om: ${msg}`);
  } finally {
    if (input) input.value = "";
  }
}

document.getElementById("btn-start-transcription")?.addEventListener("click", async () => {
  await applySessionName();
  startPendingTranscription();
});

// "Spara för senare" — stänger dialogen direkt. Ljudet ligger redan i sessionsmappen,
// så inget mer behöver göras. Detta är vägen vidare till nästa möte.
document.getElementById("btn-save-for-later")?.addEventListener("click", async () => {
  await applySessionName();
  hidePostRecordingActions();
  pendingRecording = null;
  updateBadge("Inspelning sparad", "");
});

// Enter i namnfältet = spara för senare (snabbaste vägen vidare)
document.getElementById("session-name-input")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    document.getElementById("btn-save-for-later")?.click();
  }
});
// Klick på sökvägen i post-recording-dialogen öppnar sessionsmappen i Utforskaren
document.getElementById("post-recording-path")?.addEventListener("click", async () => {
  const p = document.getElementById("post-recording-path")?.dataset.path;
  if (p) { try { await window.__TAURI__.opener.openPath(p); } catch (_) {} }
});
document.getElementById("btn-save-audio-only")?.addEventListener("click", async () => {
  await applySessionName();
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

// Temaknapp i headern — växlar ljust/mörkt
const btnTheme = document.getElementById("btn-theme");
if (btnTheme) {
  btnTheme.addEventListener("click", () => {
    setTheme(themePref === "dark" ? "light" : "dark");
    // EQ-baren har inline-färg satt i JS — måla om den i det nya temat
    if (!isRecording) resetEq();
  });
}

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

