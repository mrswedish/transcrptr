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
const btnFile = document.getElementById("btn-file");
const btnCopy = document.getElementById("btn-copy");
const btnSave = document.getElementById("btn-save");
const outputText = document.getElementById("output-text");
// Inspelningstillstånds-element (control-row layout, v1.1.96)
const recordingIndicator = document.getElementById("recording-status");
const recordingStatusText = document.getElementById("recording-status-text");
const idleHint = document.getElementById("idle-hint");

// ─────────────────────────────────────────────────────────────────────────────
// Tillgänglighet (WCAG 2.1 AA / EN 301 549)
// ─────────────────────────────────────────────────────────────────────────────

// Meddelanden till skärmläsare (status utan fokusflytt, WCAG 4.1.3).
const srStatusEl = document.getElementById("sr-status");
let srStatusTimer = null;
function announce(text) {
  if (!srStatusEl) return;
  srStatusEl.textContent = "";
  clearTimeout(srStatusTimer);
  srStatusTimer = setTimeout(() => { srStatusEl.textContent = text; }, 60);
}

// Förloppsstapeln speglas till aria-valuenow på behållaren.
(function wireProgressAria() {
  const bar = document.getElementById("progress-bar");
  const box = document.getElementById("progress-container");
  if (!bar || !box) return;
  new MutationObserver(() => {
    const n = Math.max(0, Math.min(100, parseInt(bar.style.width, 10) || 0));
    box.setAttribute("aria-valuenow", String(n));
    box.setAttribute("aria-valuetext", `${n} procent`);
  }).observe(bar, { attributes: true, attributeFilter: ["style"] });
})();

// Dialoger: fokus flyttas in, Tab hålls kvar i dialogen, Esc stänger, fokus återställs och
// bakgrunden görs inert medan en dialog är öppen (WCAG 2.1.1, 2.4.3, 2.4.7).
(function wireDialogs() {
  const DIALOGS = {
    "settings-modal": "btn-close-settings",
    "confirm-modal": "confirm-cancel",
    "import-choice-modal": "import-choice-cancel",
    "stereo-mix-modal": "btn-close-stereo-mix",
    "reset-modal": "reset-cancel",
  };
  const stack = [];                 // öppna dialoger, den översta sist
  const openers = new Map();        // dialog -> elementet som hade fokus före
  const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]:not([tabindex="-1"])';
  const visible = (el) => el.getClientRects().length > 0;
  const focusables = (root) => [...root.querySelectorAll(FOCUSABLE)].filter(visible);

  function syncInert() {
    const bg = document.querySelectorAll("body > header, body > section, body > main, body > footer, body > .skip-link");
    const top = stack[stack.length - 1] || null;
    bg.forEach(el => el.toggleAttribute("inert", !!top));
    for (const id of Object.keys(DIALOGS)) {
      const el = document.getElementById(id);
      if (el) el.toggleAttribute("inert", !!top && el !== top);
    }
  }

  function opened(el) {
    if (stack.includes(el)) return;
    openers.set(el, document.activeElement);
    stack.push(el);
    syncInert();
    requestAnimationFrame(() => {
      const target = el.querySelector("[data-autofocus]") || focusables(el)[0];
      if (target) target.focus();
    });
  }
  function closed(el) {
    const i = stack.indexOf(el);
    if (i === -1) return;
    stack.splice(i, 1);
    syncInert();
    const back = openers.get(el);
    openers.delete(el);
    requestAnimationFrame(() => {
      if (back && document.contains(back) && visible(back)) back.focus();
    });
  }

  for (const id of Object.keys(DIALOGS)) {
    const el = document.getElementById(id);
    if (!el) continue;
    const check = () => (el.classList.contains("hidden") ? closed(el) : opened(el));
    new MutationObserver(check).observe(el, { attributes: true, attributeFilter: ["class"] });
  }

  document.addEventListener("keydown", (e) => {
    const top = stack[stack.length - 1];
    if (!top) return;
    if (e.key === "Escape") {
      const btn = document.getElementById(DIALOGS[top.id]);
      if (btn) { e.preventDefault(); btn.click(); }
    } else if (e.key === "Tab") {
      const f = focusables(top);
      if (f.length === 0) { e.preventDefault(); return; }
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && (document.activeElement === first || !top.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !top.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
    }
  });
})();

// Central UI-state-växling för inspelningskontrollerna
let lastRecUIState = "idle";
function setRecordingUI(state) {                // "idle" | "recording"
  if (state !== lastRecUIState) {
    announce(state === "recording" ? "Inspelning pågår" : "Inspelningen är stoppad");
    lastRecUIState = state;
  }
  const recLabel = btnRecord && btnRecord.querySelector(".btn-record-label");
  if (state === "idle") {
    if (recLabel) recLabel.textContent = "Spela in";
    if (btnRecord) btnRecord.classList.remove("is-recording");
    if (idleHint) idleHint.classList.remove("hidden");
    if (recordingIndicator) recordingIndicator.classList.add("hidden");
    if (btnRecord) btnRecord.setAttribute("aria-label", "Spela in");
  } else {
    // Röd knapp med stopp-fyrkant — tydligt att knappen nu STOPPAR
    if (recLabel) recLabel.textContent = "Stoppa";
    if (btnRecord) btnRecord.classList.add("is-recording");
    if (idleHint) idleHint.classList.add("hidden");
    if (recordingIndicator) recordingIndicator.classList.remove("hidden");
    if (recordingStatusText) recordingStatusText.textContent = "Spelar in";
    if (btnRecord) btnRecord.setAttribute("aria-label", "Stoppa inspelning");
  }
}
const loadingOverlay = document.getElementById("loading-overlay");
const loadingText = document.getElementById("loading-text");
const progressContainer = document.getElementById("progress-container");
const progressBar = document.getElementById("progress-bar");

// New UI Elements
const recordingTimer = document.getElementById("recording-timer");
const recordingSize = document.getElementById("recording-size");
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
const selLanguage = document.getElementById("transcription-language");
const selMic = document.getElementById("mic-select");
const eqBar = document.getElementById("eq-bar");

// Animate the EQ-bar columns based on audio level (average 0–128)
function animateEq(average) {
  if (!eqBar) return;
  const col = eqBar.querySelector(".eq-col");
  if (!col) return;
  const norm = Math.min(average / 70, 1); // 0–1
  // Hög nivå (risk för klippning) får varningsfärg, annars accent.
  col.style.width = `${Math.round(norm * 100)}%`;
  col.style.backgroundColor = norm > 0.85 ? "rgb(var(--c-rec))" : "";
}

function resetEq() {
  if (!eqBar) return;
  const col = eqBar.querySelector(".eq-col");
  if (col) { col.style.width = "0"; col.style.backgroundColor = ""; }
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
let modelSize = "pianissimo";
let modelRevision = "standard";
let modelQuantized = true;

// Download picker state (independent from active model)
let dlSize = "pianissimo";
let dlRevision = "standard";
let transcriptionLanguage = "sv";

// Personlig ordlista
// Ordlistor lagras i en fil via Rust (ordlistor.json); här en kopia att redigera.
let vocabStore = { version: 1, lists: [] };
let vocabSelected = null;   // id på vald lista i inställningarna
let pendingVocabChanges = []; // ersättningar från senaste transkriberingen

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
let identifySpeakers = false;
let speakerNotice = null;   // sätts om talaridentifieringen misslyckas
let speakerNames = {};   // { 1: "Anna" } — egna namn på talare, per transkribering
let isCancelling = false;
let pendingRecording = null; // { type:'wav-file', filePath } | { type:'segments', segments:[] }
let wasapiRecordingReady = false; // Rust har recording.wav på disk — save_audio_file kan anropas direkt
let recordingDir         = "";    // Mapp där sessions sparas; tom = default från Rust
let threadCount          = 4;     // Antal CPU-trådar för whisper.cpp (1-16); cap för att undvika krasch på multi-core
let gpuDeviceIndex       = null;  // GPU-index (0-7) eller null = auto. Multi-GPU-stöd via WhisperContextParameters.gpu_device
let audioContext = null;
let analyzer = null;
let micStream = null;

let animationFrameId = null;

// New Recording Metrics State
let recordingStartTime = null;
let recordingTimerInterval = null;
let estimatedRecordingSize = 0;
let lastTranscribedPath = null; // Senast transkriberade filen — "Gör om" kör om den via Rust

// Hjälptexten visas bara när mötesljud är av, och bara där växeln finns (Windows).
function syncWasapiVisual() {
  const wasapiToggle = document.getElementById("wasapi-toggle");
  const wasapiQuickEl = document.getElementById("wasapi-quick");
  const on = !!(wasapiToggle && wasapiToggle.checked);
  const hint = document.getElementById("wasapi-hint");
  if (hint) {
    const togglePresent = wasapiQuickEl && !wasapiQuickEl.classList.contains("hidden");
    hint.classList.toggle("hidden", on || !togglePresent);
  }
}

// Load config from local storage
function loadSettings() {
  const size = localStorage.getItem("modelSize");
  const revision = localStorage.getItem("modelRevision");
  const quantized = localStorage.getItem("modelQuantized");
  const lang = localStorage.getItem("transcriptionLanguage");
  const micId = localStorage.getItem("selectedMicId");
  const wasapi = localStorage.getItem("wasapiEnabled");
  const gpu = localStorage.getItem("useGpu");
  identifySpeakers = localStorage.getItem("identifySpeakers") === "true";
  const confThresh = localStorage.getItem("confidenceThreshold");

  if (size) modelSize = size;
  if (revision) modelRevision = revision;
  if (quantized !== null) modelQuantized = quantized === "true";
  if (lang) transcriptionLanguage = lang;
  if (micId) selectedMicId = micId;
  if (wasapi !== null) wasapiEnabled = wasapi === "true";
  if (gpu !== null) useGpu = gpu === "true";
  if (confThresh !== null) confidenceThreshold = parseFloat(confThresh);

  const wasapiToggle = document.getElementById("wasapi-toggle");
  if (wasapiToggle) wasapiToggle.checked = wasapiEnabled;
  const speakersToggle = document.getElementById("speakers-toggle");
  if (speakersToggle) speakersToggle.checked = identifySpeakers;

  syncWasapiVisual();

  const gpuToggle = document.getElementById("gpu-toggle");
  if (gpuToggle) gpuToggle.checked = useGpu;

  const confSlider = document.getElementById("confidence-threshold-slider");
  const confLabel = document.getElementById("confidence-threshold-label");
  if (confSlider) confSlider.value = Math.round(confidenceThreshold * 100);
  if (confLabel) confLabel.textContent = Math.round(confidenceThreshold * 100) + "%";

  renderVocab();

  // Sync pill pickers to current state
  // Spegla sparad modell i kvalitetsvalet
  const savedQuality = modelSize === "pianissimo" ? "fast" : modelSize === "large" ? "best" : modelSize === "turbo" ? "multi" : "balanced";
  const verbatimEl = document.getElementById("model-verbatim");
  if (verbatimEl) verbatimEl.checked = modelRevision === "strict";
  if (typeof applyQuality === "function") applyQuality(savedQuality);
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

  await listen("vocabulary_applied", (event) => {
    pendingVocabChanges = Array.isArray(event.payload) ? event.payload : [];
  });

  await listen("diarization_phase", (event) => {
    const { phase, message, percent, etaSeconds } = event.payload;
    if (phase === "start") {
      announce("Identifierar talare. Det kan ta några minuter. Avbryt är möjligt.");
      if (btnCancelTranscription) {
        btnCancelTranscription.textContent = "Avbryt talaridentifiering";
        btnCancelTranscription.classList.remove("hidden");
      }
      if (progressContainer) progressContainer.classList.remove("hidden");
      if (progressBar) progressBar.style.width = "0%";
      loadingText.innerText = "Identifierar talare…";
    } else if (phase === "progress") {
      if (progressBar) progressBar.style.width = `${percent}%`;
      const left = etaSeconds >= 90 ? `ca ${Math.round(etaSeconds / 60)} min kvar`
                 : etaSeconds > 5 ? `ca ${etaSeconds} s kvar`
                 : "snart klart";
      loadingText.innerText = `Identifierar talare… ${percent}% (uppskattning: ${left})`;
    } else if (phase === "cancelled") {
      speakerNotice = "Talaridentifieringen avbröts. Transkriptet är sparat, men utan talare.";
    } else if (phase === "failed") {
      logToFile(`diarization: ${message}`);
      speakerNotice = `Talarna kunde inte identifieras: ${message || "okänt fel"}`;
    }
  });

  await listen("transcription_progress", (event) => {
    const { progress } = event.payload;
    if (progressContainer) progressContainer.classList.remove("hidden");
    if (progressBar) progressBar.style.width = `${progress}%`;
    loadingText.innerText = `Transkriberar... ${progress}%`;
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

  // (v1.5: recover-knappen i settings borttagen — importeras nu via "Öppna" i headern)
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
    const started = sessionStartFromFolderName(folderName);
    const when = started.toLocaleString("sv-SE", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });
    showPostRecordingActions(dir, { title: `Inspelning från ${when}` });
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
  if (btn) {
    btn.title = isDark ? "Byt till ljust tema" : "Byt till mörkt tema";
    btn.setAttribute("aria-label", btn.title);
  }
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
  await loadVocab();
  loadSettings();
  await loadMicrophones();
  setupEventListeners();
  setupV11Handlers();
  updateFooter();
  refreshModelList();
  checkInterruptedRecordings();
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
  document.getElementById("btn-open-win-sound")?.addEventListener("click", () => {
    window.__TAURI__.opener.openUrl("ms-settings:sound").catch(() => {});
  });

}

async function refreshModelList() {
  if (!modelList) return;
  try {
    const models = await invoke("get_available_models");
    modelList.innerHTML = "";

    if (models.length === 0) {
      modelList.innerHTML = '<p class="hint">Inga modeller nedladdade ännu.</p>';
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
      div.className = `model-row ${isActive ? "is-active" : "is-clickable"}`;
      if (!isActive) div.onclick = activateModel;

      const info = document.createElement("div");
      info.className = "flex flex-col min-w-0";

      const nameEl = document.createElement("span");
      nameEl.className = "text-sm font-semibold";
      nameEl.innerText = m.name + (isActive ? " (används)" : "");

      const sizeEl = document.createElement("span");
      sizeEl.className = "text-xs text-muted";
      sizeEl.innerText = formatSize(m.size_bytes);

      info.appendChild(nameEl);
      info.appendChild(sizeEl);
      div.appendChild(info);

      const actions = document.createElement("div");
      actions.className = "flex items-center gap-1 shrink-0";

      const delBtn = document.createElement("button");
      delBtn.className = "btn btn-ghost btn-sm btn-icon-only btn-danger";
      delBtn.setAttribute("aria-label", `Ta bort ${m.name}`);
      delBtn.innerHTML = '<span class="material-symbols-outlined">delete</span>';
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
    
    // Estimate size: 16kHz mono 16-bit PCM = 32 000 bytes/s
    estimatedRecordingSize = (elapsedMs / 1000) * (16000 * 2);
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
  // Varning/fel i klartext med färg; "redo" är dämpat.
  badge.className = className === "error" ? "text-rec" : "";
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
function updateDownloadButtonLabel() {
  const btn = document.getElementById("btn-download-model");
  if (!btn) return;
  const label = btn.querySelector(".download-label");
  if (!label) return;
  label.textContent = `Ladda ner · ${formatMb(modelSizeMb(dlSize, true))}`;
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

const QUALITY_ACTIVE = "quality-btn choice is-selected";
const QUALITY_IDLE   = "quality-btn choice";

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
    b.setAttribute("aria-pressed", String(b.dataset.quality === quality));
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

  // Ordlistor (sparas direkt vid ändring; här säkerställs att allt är skrivet)
  await saveVocabNow();

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

// "Ladda ner vald modell" — always downloads the selected combination.
// Skyddar mot oavsiktliga stora hämtningar: visar storleken, bekräftar över 1 GB
// och varnar om disken inte räcker. Tidigare startade nedladdningen direkt utan
// någon kontroll — man kunde dra ner 3 GB av misstag.
const LARGE_DOWNLOAD_MB = 1000;

if (btnDownloadModel) {
  btnDownloadModel.addEventListener("click", async () => {
    const quantized = true;
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
  if (!isRecording) {
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
function showConfirm(msg, title, okLabel) {
  return new Promise(resolve => {
    if (!confirmModal) { resolve(true); return; }
    if (confirmOk) confirmOk.textContent = okLabel || "Fortsätt";
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
        if (!isRecording) return;
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

// `opts.title` anges när en redan sparad inspelning öppnas (listan Senaste inspelningar):
// då visas bara det som är relevant — Transkribera och Stäng — inte namnfält, Spara för senare
// eller Spara kopia, eftersom inspelningen redan ligger sparad och namngiven.
function showPostRecordingActions(sessionDir, opts = {}) {
  const opened = !!opts.title;
  document.getElementById("post-recording-actions")?.classList.remove("hidden");
  const titleEl = document.getElementById("post-recording-title");
  if (titleEl) titleEl.textContent = opened ? opts.title : "Inspelningen är sparad";
  document.getElementById("btn-save-for-later")?.classList.toggle("hidden", opened);
  document.getElementById("btn-save-audio-only")?.classList.toggle("hidden", opened);
  document.getElementById("btn-close-opened")?.classList.toggle("hidden", !opened);
  // Namnfältet döper om sessionsmappen — visa det bara när en sådan finns.
  // Mac-flödet (MediaRecorder, type "segments") har inga filer på disk ännu,
  // så där finns ingen mapp att namnge.
  const nameRow = document.getElementById("session-name-row");
  const nameInput = document.getElementById("session-name-input");
  if (nameInput) nameInput.value = "";
  if (nameRow) nameRow.classList.toggle("hidden", !sessionDir || opened);
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
        "Ljudet finns kvar på disk. Öppna det med \"Öppna\" och välj det i listan " +
        "Senaste inspelningar.\n\n" +
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
// Visar "Öppna": ljudfil överst och en lista med senaste inspelningar. Resolvar med
// { kind: "file" } | { kind: "session", rec } | null (avbruten). Finns inga tidigare
// inspelningar går det direkt till filväljaren.
function formatRecordingTitle(rec) {
  const d = new Date(rec.started);
  const when = isNaN(d) ? rec.started
    : d.toLocaleString("sv-SE", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });
  const label = rec.label ? rec.label.replace(/-/g, " ") : "";
  return label ? `${label} · ${when}` : when;
}

async function showImportChoice() {
  let recs = [];
  try { recs = await invoke("list_recordings", { recordingDir: recordingDir || null }); }
  catch (e) { logToFile(`list_recordings: ${e}`); }
  if (recs.length === 0) return { kind: "file" };

  return new Promise(resolve => {
    const modal     = document.getElementById("import-choice-modal");
    const fileBtn   = document.getElementById("import-choice-file");
    const cancelBtn = document.getElementById("import-choice-cancel");
    const list      = document.getElementById("recent-list");
    if (!modal || !fileBtn || !cancelBtn || !list) { resolve({ kind: "file" }); return; }

    list.replaceChildren();
    for (const rec of recs) {
      const li = document.createElement("li");
      li.className = "recent-row";
      const b = document.createElement("button");
      b.type = "button";
      b.className = "choice";
      const t = document.createElement("span");
      t.className = "choice-title";
      t.textContent = formatRecordingTitle(rec);
      const d = document.createElement("span");
      d.className = "choice-desc";
      d.textContent = formatSize(rec.sizeBytes);
      if (rec.recoverable) {
        const w = document.createElement("span");
        w.className = "text-warn font-semibold";
        w.textContent = " · Avbruten – återställs när du öppnar den";
        d.appendChild(w);
      }
      b.append(t, d);
      const h = () => { cleanup(); resolve({ kind: "session", rec }); };
      b.addEventListener("click", h);

      const del = document.createElement("button");
      del.type = "button";
      del.className = "btn btn-ghost btn-sm btn-icon-only recent-del";
      del.setAttribute("aria-label", `Radera inspelningen ${formatRecordingTitle(rec)}`);
      del.title = "Radera inspelningen";
      del.innerHTML = '<span class="material-symbols-outlined" aria-hidden="true">delete</span>';
      del.addEventListener("click", async () => {
        const ok = await showConfirm(
          `Inspelningen ”${formatRecordingTitle(rec)}” och alla dess ljudfiler och transkript raderas. Det går inte att ångra.`,
          "Radera inspelning", "Radera");
        if (!ok) return;
        try {
          await invoke("delete_recording", { recordingDir: recordingDir || null, path: rec.path });
          logToFile(`delete_recording: raderade ${rec.path}`);
        } catch (e) {
          logToFile(`delete_recording misslyckades: ${e}`);
          await message(`Kunde inte radera inspelningen: ${e}`, { title: "Radering misslyckades", kind: "error" });
          return;
        }
        const next = li.nextElementSibling?.querySelector(".choice") || li.previousElementSibling?.querySelector(".choice");
        li.remove();
        announce("Inspelningen är raderad.");
        if (list.children.length === 0) {
          const empty = document.createElement("li");
          empty.className = "hint";
          empty.textContent = "Inga inspelningar kvar.";
          list.appendChild(empty);
          fileBtn.focus();
        } else if (next) {
          next.focus();
        }
      });
      li.append(b, del);
      list.appendChild(li);
    }

    modal.classList.remove("hidden");
    const cleanup = () => {
      modal.classList.add("hidden");
      fileBtn.removeEventListener("click", onFile);
      cancelBtn.removeEventListener("click", onCancel);
    };
    const onFile   = () => { cleanup(); resolve({ kind: "file" }); };
    const onCancel = () => { cleanup(); resolve(null); };
    fileBtn.addEventListener("click", onFile);
    cancelBtn.addEventListener("click", onCancel);
  });
}

btnFile.addEventListener("click", async () => {
  const choice = await showImportChoice();
  if (!choice) return;
  try {
    if (choice.kind === "file") {
      const selected = await invoke("pick_audio_file");
      if (selected) {
        disableControls();
        await processAudioFile(selected);
      }
      return;
    }
    // En tidigare inspelning från listan. Är den avbruten (råspår men ingen recording.wav)
    // lagas och mixas den först — användaren behöver inte känna till skillnaden.
    if (choice.rec.recoverable) {
      logToFile("import: avbruten inspelning upptäckt — reparerar och mixar råspåren");
    }
    await importSessionFolder(choice.rec.path, choice.rec.recoverable);
  } catch (e) {
    console.error("Import misslyckades:", e);
  }
});

// Vid start: erbjud återställning om en inspelning avbröts (råspår men ingen färdig fil).
async function checkInterruptedRecordings() {
  try {
    const recs = await invoke("list_recordings", { recordingDir: recordingDir || null });
    const rec = recs.find(r => r.recoverable);
    if (!rec || isRecording) return;
    showNotice(`Hittade en avbruten inspelning från ${formatRecordingTitle(rec)}. Ljudet finns kvar på disken.`, {
      label: "Återställ",
      onClick: async () => {
        hideNotice();
        disableControls();
        await importSessionFolder(rec.path, true);
      },
    });
  } catch (e) { logToFile(`checkInterruptedRecordings: ${e}`); }
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
function speakerLabel(id) {
  return speakerNames[id] || `Talare ${id}`;
}

// Text för kopiera/spara. Med talare: en rubrik "Talare N:" varje gång talaren byter.
function buildPlainText() {
  if (!transcriptSegments.some(s => s.speakerId)) {
    return transcriptSegments.map(s => s.text).join("\n");
  }
  const out = [];
  let prev = null;
  for (const s of transcriptSegments) {
    if (s.speakerId !== prev) {
      if (out.length) out.push("");
      if (s.speakerId) out.push(`${speakerLabel(s.speakerId)}:`);
      prev = s.speakerId;
    }
    out.push(s.text);
  }
  return out.join("\n");
}

// Talarrubrik i segmentvyn. Klick byter namn (Enter sparar, Esc avbryter).
function buildSpeakerHeader(id) {
  const h = document.createElement("div");
  h.className = "segment-spk";
  h.dataset.speaker = String(id);
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `spk-tag spk-${((id - 1) % 6) + 1}`;
  btn.textContent = speakerLabel(id);
  btn.title = "Byt namn på talaren";
  btn.setAttribute("aria-label", `${speakerLabel(id)}. Byt namn på talaren`);
  btn.addEventListener("click", () => {
    const input = document.createElement("input");
    input.type = "text";
    input.className = "field spk-input";
    input.maxLength = 30;
    input.value = speakerNames[id] || "";
    input.placeholder = `Talare ${id}`;
    input.setAttribute("aria-label", `Namn på talare ${id}`);
    let done = false;
    const finish = (save) => {
      if (done) return; done = true;
      if (save) {
        const v = input.value.trim();
        if (v) speakerNames[id] = v; else delete speakerNames[id];
        document.querySelectorAll(`.segment-spk[data-speaker="${id}"] .spk-tag`)
          .forEach(t => { t.textContent = speakerLabel(id); t.setAttribute("aria-label", `${speakerLabel(id)}. Byt namn på talaren`); });
        outputText.value = buildPlainText();
      }
      if (input.parentNode) input.replaceWith(btn);
      btn.textContent = speakerLabel(id);
      btn.focus();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") finish(true);
      else if (e.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
    btn.replaceWith(input);
    input.focus();
  });
  h.appendChild(btn);
  return h;
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
        span.title = `Mycket osäkert ord (${Math.round(minProb * 100)}%)`;
        span.setAttribute("aria-description", span.title);
      } else if (minProb < confidenceThreshold) {
        span.className = "tok tok-low";
        span.title = `Osäkert ord (${Math.round(minProb * 100)}%)`;
        span.setAttribute("aria-description", span.title);
      }
    }
    div.appendChild(span);
  });

  return div;
}

// Bygger en enskild segment-rad. Extraherad från renderSegmentEditor så att
// progressive rendering kan anropa den per chunk.
// Segmentets text visas som en knapp (fokuserbar, Enter/blanksteg öppnar redigering).
function makeViewEditable(view) {
  view.tabIndex = 0;
  view.setAttribute("role", "button");
  view.title = "Redigera texten (Enter)";
}
function viewKeydown(e) {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.currentTarget.click(); }
}

function buildSegmentRow(seg, idx) {
  const row = document.createElement("div");
  row.className = "segment-row";
  row.dataset.idx = idx;

  const ts = document.createElement("button");
  ts.type = "button";
  ts.className = "segment-ts";
  ts.textContent = formatMs(seg.startMs);
  ts.title = "Spela från denna tidpunkt";
  ts.setAttribute("aria-label", `Spela från ${formatMs(seg.startMs)}`);
  ts.addEventListener("click", () => seekPlayer(seg.startMs));

  const confView = buildConfidenceView(seg);
  makeViewEditable(confView);

  const ta = document.createElement("textarea");
  ta.className = "segment-input hidden";
  ta.setAttribute("aria-label", `Redigera texten som börjar ${formatMs(seg.startMs)}. Esc avslutar.`);
  ta.value = seg.text;
  ta.rows = 1;
  const autoGrow = () => { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + "px"; };
  ta.addEventListener("input", () => {
    transcriptSegments[idx].text = ta.value;
    transcriptSegments[idx].tokens = [];
    outputText.value = buildPlainText();
    autoGrow();
  });
  let textAtFocus = "";
  ta.addEventListener("focus", () => { textAtFocus = transcriptSegments[idx].text; });
  const finishEdit = () => {
    if (ta.classList.contains("hidden")) return;   // redan avslutad
    if (textAtFocus && ta.value !== textAtFocus) suggestVocabFromEdit(textAtFocus, ta.value);
    const newView = buildConfidenceView(transcriptSegments[idx]);
    makeViewEditable(newView);
    newView.addEventListener("click", () => { newView.classList.add("hidden"); ta.classList.remove("hidden"); requestAnimationFrame(autoGrow); ta.focus(); });
    newView.addEventListener("keydown", viewKeydown);
    // Ersätt den befintliga vyn (eller sätt in en ny). Tidigare fanns här ett
    // extra replaceChild som kastade NotFoundError när confView redan bytts ut —
    // raderna nedan gör jobbet korrekt på egen hand.
    ta.classList.add("hidden");
    const existing = row.querySelector(".segment-view");
    if (existing) row.replaceChild(newView, existing);
    else row.insertBefore(newView, ta);
    if (row._focusView) { row._focusView = false; newView.focus(); }
  };
  ta.addEventListener("blur", finishEdit);
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.stopPropagation(); row._focusView = true; finishEdit(); }
  });

  confView.addEventListener("keydown", viewKeydown);
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
  let lastSpeakerRendered = null;
  const total = transcriptSegments.length;

  function renderBatch(deadline) {
    const frag = document.createDocumentFragment();
    let added = 0;
    const hasDeadline = deadline && typeof deadline.timeRemaining === "function";
    while (i < total && added < CHUNK && (!hasDeadline || deadline.timeRemaining() > 4 || deadline.didTimeout)) {
      const seg = transcriptSegments[i];
      if (seg.speakerId && seg.speakerId !== lastSpeakerRendered) {
        frag.appendChild(buildSpeakerHeader(seg.speakerId));
      }
      lastSpeakerRendered = seg.speakerId || null;
      const row = buildSegmentRow(seg, i);
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
    const trackEl = document.getElementById("player-track");
    if (trackEl) {
      trackEl.setAttribute("aria-valuenow", String(Math.round(pct)));
      trackEl.setAttribute("aria-valuetext", `${formatMs(ms)} av ${formatMs(dur)}`);
    }

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
            row.scrollIntoView({ block: "nearest", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
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

  const playBtn = document.getElementById("btn-play-pause");
  audioPlayer.addEventListener("play", () => playBtn?.setAttribute("aria-label", "Pausa uppspelning"));
  audioPlayer.addEventListener("pause", () => playBtn?.setAttribute("aria-label", "Spela upp"));
  audioPlayer.addEventListener("ended", () => playBtn?.setAttribute("aria-label", "Spela upp"));

  const track = document.getElementById("player-track");
  if (track) {
    track.addEventListener("keydown", (e) => {
      if (!audioPlayer || !isFinite(audioPlayer.duration)) return;
      const step = e.shiftKey ? 30 : 5;
      let t = audioPlayer.currentTime;
      switch (e.key) {
        case "ArrowRight": case "ArrowUp": t += step; break;
        case "ArrowLeft": case "ArrowDown": t -= step; break;
        case "PageUp": t += 30; break;
        case "PageDown": t -= 30; break;
        case "Home": t = 0; break;
        case "End": t = audioPlayer.duration; break;
        default: return;
      }
      e.preventDefault();
      audioPlayer.currentTime = Math.max(0, Math.min(audioPlayer.duration, t));
    });
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
    announce("Transkriberingen har startat");
    loadingOverlay.classList.remove("hidden");
    if (progressContainer) progressContainer.classList.remove("hidden");
    if (progressBar) progressBar.style.width = "0%";

    outputText.value = "";
    transcriptSegments = [];
    speakerNames = {};
    speakerNotice = null;
    pendingVocabChanges = [];
    hideNotice();
    teardownPlayer();
    showRawView();

    isCancelling = false;
    if (btnCancelTranscription) { btnCancelTranscription.textContent = "Avbryt"; btnCancelTranscription.classList.remove("hidden"); }
    const startTime = performance.now();

    logToFile(`processAudioFile: anropar invoke("transcribe_file") för ${filePath}`);
    const segs = await invoke("transcribe_file", {
      filePath,
      ...(await resolveEngine()),
      language:     transcriptionLanguage,
      useGpu,
      threadCount,
      gpuDevice: gpuDeviceIndex,
      identifySpeakers
    });
    logToFile(`processAudioFile: transcribe_file returnerade ${segs ? segs.length : 0} segment`);

    if (segs && segs.length > 0) {
      // Rust serialiserar camelCase (startMs, endMs, text, tokens) — används som det är.
      transcriptSegments = segs.map(s => ({ ...s, tokens: s.tokens || [] }));
      logToFile(`processAudioFile: mapped till transcriptSegments (${transcriptSegments.length} st)`);
      outputText.value = buildPlainText();
      logToFile(`processAudioFile: outputText.value satt (${outputText.value.length} tecken)`);
    }

    if (progressBar) progressBar.style.width = "100%";
    const elapsed = Math.round((performance.now() - startTime) / 1000);
    const elMin   = Math.floor(elapsed / 60);
    const elSec   = elapsed % 60;
    loadingText.innerText = `Klar! (${elMin > 0 ? `${elMin}m ` : ""}${elSec}s)`;
    outputText.scrollTop = outputText.scrollHeight;
    announce(`Transkriberingen är klar. ${transcriptSegments.length} segment.`);
    const notices = [];
    if (pendingVocabChanges.length > 0) {
      notices.push(`Ordlistan rättade ${pendingVocabChanges.length} ord: ${summarizeChanges(pendingVocabChanges)}.`);
    }
    if (speakerNotice) { notices.push(speakerNotice); speakerNotice = null; }
    if (notices.length > 0) showNotice(notices.join(" "));

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
        `<span class="material-symbols-outlined">check</span><span>Kopierad</span>`;
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

// "Stäng" för en öppnad inspelning: ingenting ska sparas eller döpas om.
document.getElementById("btn-close-opened")?.addEventListener("click", () => {
  hidePostRecordingActions();
  pendingRecording = null;
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
  logToFile(`wasapi-toggle change: wasapiEnabled=${wasapiEnabled}`);
  syncWasapiVisual();
});

// Nollställ applikationen — selektiv modal där användaren väljer vad som ska tas bort/behållas
const resetModal = document.getElementById("reset-modal");
const btnResetApp = document.getElementById("btn-reset-app");
const resetCancel = document.getElementById("reset-cancel");
const resetConfirm = document.getElementById("reset-confirm");
const resetOptModels = document.getElementById("reset-opt-models");
const resetOptSettings = document.getElementById("reset-opt-settings");
const resetOptVocab = document.getElementById("reset-opt-vocab");
const resetOptRecordings = document.getElementById("reset-opt-recordings");

function syncResetConfirmBtn() {
  if (!resetConfirm) return;
  const anyChecked = Boolean(
    resetOptModels?.checked ||
    resetOptSettings?.checked ||
    resetOptVocab?.checked ||
    resetOptRecordings?.checked
  );
  resetConfirm.disabled = !anyChecked;
}

[resetOptModels, resetOptSettings, resetOptVocab, resetOptRecordings].forEach(cb => {
  cb?.addEventListener("change", syncResetConfirmBtn);
});

btnResetApp?.addEventListener("click", async () => {
  if (!resetModal) return;
  // Standardval: radera modeller + inställningar, behåll ordlistor och inspelningar
  if (resetOptModels) resetOptModels.checked = true;
  if (resetOptSettings) resetOptSettings.checked = true;
  if (resetOptVocab) resetOptVocab.checked = false;
  if (resetOptRecordings) resetOptRecordings.checked = false;
  syncResetConfirmBtn();

  // Fyll i aktuella storlekar/antal så användaren ser vad som påverkas
  const modelsInfoEl = document.getElementById("reset-models-info");
  const vocabInfoEl = document.getElementById("reset-vocab-info");
  const recInfoEl = document.getElementById("reset-recordings-info");
  if (modelsInfoEl) modelsInfoEl.textContent = "Frigör diskutrymme. Standardmodellen laddas ner igen vid nästa start.";
  if (vocabInfoEl) {
    const nLists = vocabStore?.lists?.length || 0;
    const nWords = (vocabStore?.lists || []).reduce((acc, l) => acc + vocabEntryCount(l.text || ""), 0);
    vocabInfoEl.textContent = nLists > 0
      ? `Behålls om ej ikryssad (${nLists} ordlist${nLists === 1 ? "a" : "or"}, ${nWords} ord).`
      : "Inga sparade ordlistor just nu.";
  }
  if (recInfoEl) recInfoEl.textContent = "Behålls om ej ikryssad.";

  resetModal.classList.remove("hidden");

  try {
    const disk = await invoke("get_disk_info");
    if (modelsInfoEl && disk && typeof disk.models_size === "number") {
      const sz = disk.models_size > 0 ? ` (${formatSize(disk.models_size)})` : " (0 B)";
      modelsInfoEl.textContent = `Frigör diskutrymme${sz}. Standardmodellen laddas ner igen vid nästa start.`;
    }
  } catch (_) {}

  try {
    const sum = await invoke("count_recordings", { dir: recordingDir });
    if (recInfoEl && sum) {
      recInfoEl.textContent = sum.count > 0
        ? `Behålls om ej ikryssad (${sum.count} inspelning${sum.count === 1 ? "" : "ar"}, ${formatSize(sum.total_bytes)}).`
        : "Inga sparade inspelningar just nu.";
    }
  } catch (_) {}
});

resetCancel?.addEventListener("click", () => {
  resetModal?.classList.add("hidden");
});
resetModal?.addEventListener("click", (e) => {
  if (e.target === resetModal) resetModal.classList.add("hidden");
});

resetConfirm?.addEventListener("click", async () => {
  const deleteModels = Boolean(resetOptModels?.checked);
  const deleteSettings = Boolean(resetOptSettings?.checked);
  const deleteVocab = Boolean(resetOptVocab?.checked);
  const deleteRecordings = Boolean(resetOptRecordings?.checked);
  if (!deleteModels && !deleteSettings && !deleteVocab && !deleteRecordings) return;

  resetConfirm.disabled = true;
  try {
    teardownPlayer();
    await invoke("reset_application", {
      deleteModels,
      deleteVocab,
      deleteRecordings,
      deleteLogs: deleteSettings,
      recordingDir: recordingDir || null,
    });
    if (deleteSettings) {
      localStorage.clear();
    }
    resetModal?.classList.add("hidden");
    if (deleteSettings || deleteModels) {
      window.location.reload();
      return;
    }
    // Om bara ordlistor och/eller inspelningar raderades: uppdatera vyerna på plats
    if (deleteVocab) {
      vocabStore = { version: 1, lists: [] };
      vocabSelected = null;
      renderVocab();
    }
    if (deleteRecordings) {
      refreshRecordingsUsage();
    }
    updateFooter();
    await message("Valda delar har nollställts.", { title: "Nollställning klar" });
  } catch (err) {
    const msg = typeof err === "string" ? err : err.message || String(err);
    await message(`Kunde inte nollställa applikationen: ${msg}`, { title: "Fel", kind: "error" });
  } finally {
    syncResetConfirmBtn();
  }
});

const gpuToggleEl = document.getElementById("gpu-toggle");
gpuToggleEl && gpuToggleEl.addEventListener("change", () => {
  useGpu = gpuToggleEl.checked;
  localStorage.setItem("useGpu", useGpu.toString());
});

// Identifiera talare: kryssa i → hämta modellerna (en gång) om de saknas.
const speakersToggleEl = document.getElementById("speakers-toggle");
speakersToggleEl && speakersToggleEl.addEventListener("change", async () => {
  if (!speakersToggleEl.checked) {
    identifySpeakers = false;
    localStorage.setItem("identifySpeakers", "false");
    return;
  }
  try {
    const ready = await invoke("check_diarization_models");
    if (!ready) {
      const ok = await showConfirm(
        "För att skilja talare åt hämtas två små modeller (ca 33 MB) från huggingface.co. " +
        "Det görs bara en gång; därefter fungerar det helt utan internet.",
        "Hämta talarmodeller");
      if (!ok) { speakersToggleEl.checked = false; return; }
      loadingOverlay.classList.remove("hidden");
      loadingText.innerText = "Hämtar talarmodeller…";
      if (progressContainer) progressContainer.classList.remove("hidden");
      if (progressBar) progressBar.style.width = "0%";
      try {
        await invoke("download_diarization_models");
      } finally {
        loadingOverlay.classList.add("hidden");
        if (progressContainer) progressContainer.classList.add("hidden");
      }
    }
    identifySpeakers = true;
    localStorage.setItem("identifySpeakers", "true");
  } catch (err) {
    speakersToggleEl.checked = false;
    identifySpeakers = false;
    localStorage.setItem("identifySpeakers", "false");
    const msg = typeof err === "string" ? err : err.message || String(err);
    await message(`Kunde inte hämta talarmodellerna: ${msg}`, { title: "Fel", kind: "error" });
  }
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
// Ordlistor — flera listor, lagrade i en fil (Rust), rättar texten efter transkribering
// -------------------------------------------------------------
function newVocabId() {
  return "l" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function vocabEntryCount(text) {
  return text.split("\n").filter(l => l.split("#")[0].trim()).length;
}

async function loadVocab() {
  try {
    vocabStore = await invoke("vocab_load");
  } catch (err) {
    logToFile(`loadVocab: ${err}`);
    vocabStore = { version: 1, lists: [] };
    try { await message(String(err), { title: "Ordlistorna", kind: "warning" }); } catch (_) {}
  }
  // Engångsflytt från tidigare versioner (ordlistan låg i webbläsarens lagring).
  const legacy = localStorage.getItem("personalVocabulary");
  if (legacy) {
    try {
      const words = JSON.parse(legacy);
      if (Array.isArray(words) && words.length && vocabStore.lists.length === 0) {
        vocabStore.lists.push({ id: newVocabId(), name: "Min ordlista", enabled: true, text: words.join("\n") + "\n" });
        await invoke("vocab_save", { store: vocabStore });
      }
      localStorage.removeItem("personalVocabulary");
    } catch (e) { logToFile(`vocab-migrering misslyckades: ${e}`); }
  }
  if (!vocabStore.lists.some(l => l.id === vocabSelected)) vocabSelected = vocabStore.lists[0]?.id ?? null;
}

let vocabSaveTimer = null;
function saveVocabSoon() {
  clearTimeout(vocabSaveTimer);
  vocabSaveTimer = setTimeout(saveVocabNow, 600);
}
async function saveVocabNow() {
  clearTimeout(vocabSaveTimer);
  vocabSaveTimer = null;
  try { await invoke("vocab_save", { store: vocabStore }); }
  catch (err) { logToFile(`saveVocab: ${err}`); }
}

function selectedVocabList() {
  return vocabStore.lists.find(l => l.id === vocabSelected) || null;
}

// Ritar listraderna och redigeringsfälten i inställningarna.
function renderVocab() {
  const ul = document.getElementById("vocab-lists");
  if (!ul) return;
  ul.replaceChildren();
  if (vocabStore.lists.length === 0) {
    const p = document.createElement("li");
    p.className = "hint";
    p.textContent = "Du har inga ordlistor än. Skapa en med Ny ordlista.";
    ul.appendChild(p);
  }
  for (const list of vocabStore.lists) {
    const li = document.createElement("li");
    li.className = `model-row ${list.id === vocabSelected ? "is-active" : ""}`;

    const label = document.createElement("label");
    label.className = "flex items-center gap-3 min-w-0 flex-1 cursor-pointer";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "w-5 h-5 accent-primary shrink-0";
    cb.checked = list.enabled;
    cb.setAttribute("aria-label", `Använd ordlistan ${list.name} vid transkribering`);
    cb.addEventListener("change", () => { list.enabled = cb.checked; saveVocabSoon(); });
    label.appendChild(cb);
    const name = document.createElement("span");
    name.className = "text-sm font-semibold truncate";
    name.textContent = list.name;
    const count = document.createElement("span");
    count.className = "text-xs text-muted shrink-0";
    count.textContent = `${vocabEntryCount(list.text)} ord`;
    label.append(name, count);

    const pick = document.createElement("button");
    pick.type = "button";
    pick.className = "btn btn-sm shrink-0";
    pick.textContent = list.id === vocabSelected ? "Vald" : "Redigera";
    pick.disabled = list.id === vocabSelected;
    pick.setAttribute("aria-label", `Redigera ordlistan ${list.name}`);
    pick.addEventListener("click", () => { vocabSelected = list.id; renderVocab(); document.getElementById("vocab-list-name")?.focus(); });
    li.append(label, pick);
    ul.appendChild(li);
  }

  const editor = document.getElementById("vocab-editor");
  const list = selectedVocabList();
  if (editor) editor.classList.toggle("hidden", !list);
  const del = document.getElementById("vocab-delete");
  if (del) del.disabled = !list;
  if (list) {
    const nameEl = document.getElementById("vocab-list-name");
    const textEl = document.getElementById("vocabulary-input");
    if (nameEl && nameEl.value !== list.name) nameEl.value = list.name;
    if (textEl && textEl.value !== list.text) textEl.value = list.text;
  }
}

function updateVocabCounts() {
  // Uppdaterar bara namn/antal i listraderna utan att ta fokus från redigeringsfälten.
  const list = selectedVocabList();
  const idx = vocabStore.lists.indexOf(list);
  const li = document.querySelectorAll("#vocab-lists > li")[idx];
  if (!li || !list) return;
  const spans = li.querySelectorAll("label > span");
  if (spans[0]) spans[0].textContent = list.name;
  if (spans[1]) spans[1].textContent = `${vocabEntryCount(list.text)} ord`;
}

document.getElementById("vocab-list-name")?.addEventListener("input", (e) => {
  const list = selectedVocabList();
  if (!list) return;
  list.name = e.target.value.trim() || "Ordlista";
  updateVocabCounts();
  saveVocabSoon();
});
document.getElementById("vocabulary-input")?.addEventListener("input", (e) => {
  const list = selectedVocabList();
  if (!list) return;
  list.text = e.target.value;
  updateVocabCounts();
  saveVocabSoon();
});
document.getElementById("vocab-new")?.addEventListener("click", () => {
  const list = { id: newVocabId(), name: `Ordlista ${vocabStore.lists.length + 1}`, enabled: true, text: "" };
  vocabStore.lists.push(list);
  vocabSelected = list.id;
  renderVocab();
  const nameEl = document.getElementById("vocab-list-name");
  if (nameEl) { nameEl.focus(); nameEl.select(); }
  saveVocabSoon();
});
document.getElementById("vocab-delete")?.addEventListener("click", async () => {
  const list = selectedVocabList();
  if (!list) return;
  const ok = await showConfirm(`Ordlistan "${list.name}" och dess ${vocabEntryCount(list.text)} ord tas bort. Det går inte att ångra.`, "Ta bort ordlista");
  if (!ok) return;
  vocabStore.lists = vocabStore.lists.filter(l => l.id !== list.id);
  vocabSelected = vocabStore.lists[0]?.id ?? null;
  renderVocab();
  await saveVocabNow();
});
document.getElementById("vocab-open-dir")?.addEventListener("click", async () => {
  try {
    const dir = await invoke("vocab_dir");
    await window.__TAURI__.opener.openPath(dir);
  } catch (err) { logToFile(`vocab-open-dir: ${err}`); }
});
invoke("vocab_dir").then(d => { const el = document.getElementById("vocab-dir"); if (el) el.textContent = d; }).catch(() => {});

// Import/export av vald lista som textfil
const vocabImport = document.getElementById("vocabulary-import");
vocabImport && vocabImport.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  let text = await file.text();
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) text = parsed.map(String).join("\n");
  } catch { /* vanlig text */ }
  let list = selectedVocabList();
  if (!list) {
    list = { id: newVocabId(), name: file.name.replace(/\.[^.]+$/, "").slice(0, 40) || "Importerad", enabled: true, text: "" };
    vocabStore.lists.push(list);
    vocabSelected = list.id;
  }
  list.text = text.replace(/\r\n/g, "\n").trim() + "\n";
  renderVocab();
  saveVocabSoon();
  vocabImport.value = "";
});

const vocabExport = document.getElementById("vocabulary-export");
vocabExport && vocabExport.addEventListener("click", async () => {
  const list = selectedVocabList();
  const content = list ? list.text : "";
  try {
    await invoke("save_text_file", { content });
  } catch (err) {
    const msg = typeof err === "string" ? err : err.message || String(err);
    if (!msg.includes("cancelled") && !msg.includes("canceled")) {
      console.error("Export misslyckades:", msg);
    }
  }
});

// ── Meddelanderad ovanför texten (rättningar, förslag) ──
const noticeBar = document.getElementById("notice-bar");
const noticeText = document.getElementById("notice-text");
const noticeAction = document.getElementById("notice-action");
let noticeActionHandler = null;
function showNotice(text, action) {
  if (!noticeBar) return;
  noticeText.textContent = text;
  noticeActionHandler = action ? action.onClick : null;
  if (action) { noticeAction.textContent = action.label; noticeAction.classList.remove("hidden"); }
  else noticeAction.classList.add("hidden");
  noticeBar.classList.remove("hidden");
}
function hideNotice() { noticeBar?.classList.add("hidden"); noticeActionHandler = null; }
noticeAction?.addEventListener("click", () => { const h = noticeActionHandler; if (h) h(); });
document.getElementById("notice-close")?.addEventListener("click", hideNotice);

function summarizeChanges(changes) {
  const counts = new Map();
  for (const c of changes) {
    const k = `${c.from} → ${c.to}`;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const top = [...counts.entries()].slice(0, 4).map(([k, n]) => (n > 1 ? `${k} (${n})` : k));
  const more = counts.size > 4 ? ` och ${counts.size - 4} till` : "";
  return `${top.join(", ")}${more}`;
}

// Rättar den visade texten mot de ikryssade ordlistorna. Returnerar antal rättade ord.
async function applyVocabularyToTranscript(quiet) {
  await saveVocabNow();
  const useSegments = transcriptSegments.length > 0;
  const texts = useSegments ? transcriptSegments.map(s => s.text) : [outputText.value];
  if (!texts.some(t => t.trim())) {
    if (!quiet) showNotice("Det finns ingen text att rätta än.");
    return 0;
  }
  let res;
  try { res = await invoke("apply_vocabulary", { texts }); }
  catch (err) { showNotice(`Ordlistan kunde inte tillämpas: ${err}`); return 0; }
  if (res.changes.length === 0) {
    if (!quiet) showNotice("Ordlistan hittade inget att rätta i texten.");
    return 0;
  }
  if (useSegments) {
    res.texts.forEach((t, i) => {
      if (t !== transcriptSegments[i].text) { transcriptSegments[i].text = t; transcriptSegments[i].tokens = []; }
    });
    renderSegmentEditor();
    outputText.value = buildPlainText();
  } else {
    outputText.value = res.texts[0];
  }
  showNotice(`Ordlistan rättade ${res.changes.length} ord: ${summarizeChanges(res.changes)}.`);
  return res.changes.length;
}
document.getElementById("btn-apply-vocab")?.addEventListener("click", () => applyVocabularyToTranscript(false));

// Förslag: när användaren rättar ett ord i segmentvyn, erbjud att lägga till det i ordlistan.
function wordEdit(oldText, newText) {
  const tok = (t) => t.match(/[\p{L}\p{N}][\p{L}\p{N}-]*/gu) || [];
  const a = tok(oldText), b = tok(newText);
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length, eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  const from = a.slice(s, ea), to = b.slice(s, eb);
  if (!from.length || !to.length || from.length > 3 || to.length > 3) return null;
  const f = from.join(" "), t = to.join(" ");
  if (f.toLowerCase() === t.toLowerCase()) return null;
  return { from: f, to: t };
}

function suggestVocabFromEdit(oldText, newText) {
  const edit = wordEdit(oldText, newText);
  if (!edit) return;
  showNotice(`Lägga till "${edit.to}" i ordlistan? "${edit.from}" rättas då automatiskt framöver.`, {
    label: "Lägg till",
    onClick: async () => {
      try {
        vocabStore = await invoke("vocab_add_entry", { listId: null, term: edit.to, alias: edit.from });
        if (!vocabStore.lists.some(l => l.id === vocabSelected)) vocabSelected = vocabStore.lists[0]?.id ?? null;
        renderVocab();
        const n = await applyVocabularyToTranscript(true);
        showNotice(`Lade till "${edit.from} => ${edit.to}" i ordlistan.${n ? ` ${n} ord i resten av texten rättades.` : ""}`);
      } catch (err) {
        showNotice(`Kunde inte lägga till i ordlistan: ${err}`);
      }
    },
  });
}

