# Transkribera

Transkribera är en lokal, integritetsfokuserad skrivbordsapp som omvandlar tal till text — helt utan molntjänster. Allt sker på din egen dator; ditt ljud och din röstdata lämnar aldrig din maskin.

![Transkribera Screenshot](public/screenshot-mac.png)

## 🇸🇪 Fokus på svenska

Transkribera använder [KB-whisper](https://huggingface.co/KBLab/kb-whisper-small) — en AI-modell från **Kungliga biblioteket (KB)** specialtränad på **50 000+ timmar** av svenskt tal, däribland tv-sändningar, riksdagstal och dialekter från hela landet.

> **Andra språk?** Transkribera kan hantera andra språk tack vare Whisper-arkitekturen, men resultatet blir bäst på svenska.

📰 [Läs mer om KB-whisper på Kungliga bibliotekets hemsida](https://www.kb.se/om-oss/nyheter/nyhetsarkiv/2025-02-20-valtranad-ai-modell-forvandlar-tal-till-text.html)

## ✨ Funktioner
- **🔒 Integritet:** Ditt ljud stannar på din dator. Inget skickas till externa servrar. [Integritetspolicy](PRIVACY.md)
- **⚡ Hårdvaruaccelererad:** Vulkan (Windows) och Metal (Mac) utnyttjar din GPU för snabbare transkribering. Kan stängas av för äldre grafikkort.
- **🎙️ Mötesinspelning (Windows):** Spela in både mikrofon och datorljud från t.ex. Teams/Zoom — via WASAPI Endpoint Loopback (fungerar från Windows 7) eller Stereo Mix (se guide nedan).
- **📂 Filimport:** Transkribera valfri ljudfil direkt — MP3, M4A, AAC, WAV, OGG, FLAC, MP4, WebM, MKV. Avkodningen sker helt i Rust (Symphonia) utan att belasta JS-heapen — fungerar även för inspelningar på flera timmar.
- **🎚️ Antialiaserad ljudbehandling:** Lågpassfilter (cutoff 7 kHz) före nedsampling till 16 kHz — minskar aliasing-artefakter från 44.1k/48k-källor (iPhone, Mac mic) för bättre transkribering.
- **⏹️ Avbryt transkribering:** Avbryt pågående transkribering när som helst med en knapp. Inspelad audio bevaras alltid och kan sparas även efter avbrott.
- **⏸️ Pausa inspelning:** Pausa och återuppta. Varje del tidsstämplas automatiskt.
- **🔄 Gör om transkribering:** Byt modell och kör om utan att spela in på nytt.
- **✏️ Redigera transkribering:** Redigera, sök och ersätt direkt i appen (Ctrl+F).
- **📝 Personlig ordlista:** Mata in facktermer och medicinsk terminologi som skickas som ledtrådar till transkriberingsmotorn — förbättrar igenkänning av domänspecifika ord.
- **🎬 Segmentredigering:** Visa transkriberingen som tidsstämplade rader — klicka på en tidsstämpel för att hoppa direkt till den punkten i inspelningen. Progressiv rendering håller UI:t responsivt även för flertimmes-transkriberingar.
- **🔊 Synkad ljudspelare:** Spela upp inspelningen direkt i appen med automatisk markering av det aktiva textsegmentet.
- **🟡 Konfidensfärgning:** Ord med låg igenkänningssäkerhet markeras med färg i segmentvyn — gul = osäker, röd = mycket osäker. Tröskelvärdet justeras i inställningarna.
- **💾 Spara:** Exportera text som `.txt` eller ljud som `.wav`.
- **📊 Modellhantering:** Se, ladda ner och ta bort modeller i inställningarna.

## 📦 Välj rätt modell

Byt modell via **kugghjulet** (⚙️) i appen. Välj storlek, stil och format — ladda ner flera och byt med ett klick.

### KB-whisper (svenska)

Specialtränad på 50 000+ timmar av svenskt tal — bäst val för svenska inspelningar.

| Modell | Format | Storlek | Hastighet | Kvalitet |
|--------|--------|---------|-----------|----------|
| **Medium** *(rekommenderas)* | Standard | ~1.5 GB | ⚡⚡ | Mycket bra |
| **Medium** *(rekommenderas)* | **q5_0 ✓** | ~900 MB | ⚡⚡ | Mycket bra |
| **Large** | Standard | ~3.0 GB | ⚡ | Bäst |
| **Large** | **q5_0 ✓** | ~2.0 GB | ⚡ | Bäst |

> [!TIP]
> **q5_0 rekommenderas** — 40% mindre filstorlek med i princip identisk kvalitet.

### Whisper Turbo (flerspråkig)

OpenAIs officiella large-v3-turbo-modell från [ggerganov/whisper.cpp](https://huggingface.co/ggerganov/whisper.cpp). Välj Turbo när du transkriberar på flera språk, blandar svenska med facktermer på engelska, eller när hastighet är viktigare än maximal noggrannhet på svenska.

| Modell | Format | Storlek | Hastighet | Språk |
|--------|--------|---------|-----------|-------|
| **Large-v3-Turbo** | q8_0 | ~1.5 GB | ⚡⚡⚡ | 100+ språk |

> [!NOTE]
> KB-whisper slår Turbo på ren svenska. Välj Turbo för blandspråkigt innehåll eller internationella möten.

### Stil (KB-whisper)

| Stil | Passar för | Beskrivning |
|------|-----------|-------------|
| **Standard** *(standard)* | Generellt bruk | Balanserat transkript — bra för de flesta användningsfall |
| **Ordagrann** | Diktering, protokoll | Mer verbalt transkript som följer det talade nära |

> [!NOTE]
> Välj stil i inställningarna innan nedladdning. Varje kombination av storlek + stil är en separat modell. Turbo har ingen stilvariant.

## 🎙️ Spela in möten — Systemljud (Windows)

Det finns två sätt att spela in både mikrofon och datorns systemljud (Teams, Zoom, Spotify m.fl.):

| | **Spela in systemljud** *(WASAPI Loopback)* | **Stereo Mix** *(Windows-funktion)* |
|---|---|---|
| **Kräver inställning** | Nej | Ja (engångsinställning) |
| **Windows-version** | Windows 7+ | Alla versioner |
| **Pausa inspelning** | Ja | Ja |
| **Välj mikrofon i appen** | Ja | Nej (styrs av Windows) |
| **Systemljud** | Ja | Ja |
| **Drivrutinsstöd** | Oberoende av hårdvara | Beror på ljudkortet |

### Alternativ 1: Spela in systemljud (rekommenderas)

Aktivera **"Spela in systemljud"** i inställningarna (⚙️). Transkribera använder **klassisk WASAPI Endpoint Loopback** för att fånga datorns systemljud digitalt — oberoende av hårdvara och drivrutiner.

**Hur det fungerar:** Transkribera lyssnar automatiskt på Windows standardljudenhet (t.ex. hörlurar eller högtalare) **och** på kommunikationsenheten (den enhet Teams, Zoom m.fl. använder). Om de är olika enheter — t.ex. Jabra Speak för möten men inbyggda högtalare för övrigt — fångas båda och mixas automatiskt. Under inspelning visas en <span style="color:red">●</span> röd pulserande punkt i inspelningsindikatorn som bekräftar att systemljudet spelas in.

> [!NOTE]
> Fungerar från Windows 7 och uppåt — inget behov av en specifik Windows-version.

> [!IMPORTANT]
> Starta alltid mötet och se till att ljud spelas **innan** du trycker Spela in i Transkribera. Om du använder en separat USB-enhet (t.ex. Jabra) för möten — se till att den är vald som kommunikationsenhet i Windows ljudinställningar.

### Alternativ 2: Stereo Mix (alternativ metod)

Stereo Mix är en virtuell Windows-enhet som fångar allt systemljud och mixar det med valfri mikrofon. Kräver en engångsinställning i Windows.

1. **Öppna ljudinställningar:** Högerklicka på ljudikonen i aktivitetsfältet → välj **"Ljudinställningar"**.
2. **Hitta detaljerade steg:** Scrolla längst ner och klicka på **"Mer ljudinställningar"** (viktigt för Windows 11).
3. **Visa enheter:** I fönstret som öppnas, gå till fliken **Inspelning**. Högerklicka på en tom yta och aktivera **"Visa inaktiverade enheter"**.
4. **Aktivera:** Högerklicka på **Stereo Mix** → **Aktivera**.
5. **Sätt som standard:** Högerklicka på **Stereo Mix** igen → **"Ange som standardenhet"**.
6. **Välj i appen:** Välj **"Systemets standardmikrofon"** i mikrofonlistan i Transkribera.

> [!IMPORTANT]
> Starta alltid mötet och se till att ljud spelas **innan** du trycker Spela in i Transkribera.

> [!NOTE]
> Syns inte Stereo Mix? Din dators ljudkort saknar stöd för det. Använd "Spela in systemljud" istället.

## 📥 Ladda ner och installera (Windows)

Gå till [Releases](https://github.com/mrswedish/transcrptr/releases) för senaste versionen och ladda ner `Transkribera-portable.exe`.

### Om transkriberingen kraschar

På datorer med **flera grafikkort eller en NPU** (t.ex. laptop med Intel Arc + NVIDIA, eller Intel AI Boost) kan Vulkan välja "fel" grafikkort och appen kraschar tyst när transkriberingen startar. Workaround:

1. Öppna **Inställningar** (kugghjulet)
2. Sänk **CPU-trådar för transkribering** till **4**
3. Stäng av växeln **GPU-acceleration**
4. Försök transkribera igen — det är långsammare men ska INTE krascha

Om problemet kvarstår: öppna **Inställningar → Öppna loggfil** och skicka loggens innehåll för diagnostik.

### Windows SmartScreen och säkerhet

Eftersom appen inte är köpt med ett kommersiellt kodsigneringscertifikat kan Windows varna vid första körningen. Så här hanterar du det:

**SmartScreen-varning ("Windows skyddade din dator"):**
1. Klicka på **"Mer information"**
2. Klicka sedan på **"Kör ändå"**

**Filen är "blockerad" av Windows:**
På vissa Windows-versioner kan filer laddade från internet blockeras. Om appen inte startar:
1. Högerklicka på `.exe`-filen
2. Välj **"Egenskaper"**
3. Längst ner under fliken **Allmänt** — kryssa i **"Avblockera"**
4. Klicka **OK** och starta appen igen

> [!NOTE]
> Transkribera innehåller ingen skadlig kod. Varningarna beror på att appen distribueras utan kommersiell kodsignering. Källkoden är öppen och granskningsbar på GitHub.

## 🏗️ Teknisk arkitektur

Transkribera bygger på **Tauri 2** — en Rust-backend kombinerad med ett webbfrontend. All tung bearbetning sker i Rust; webbvyn hanterar enbart UI.

### Kärnkomponenter

| Komponent | Teknologi | Roll |
|-----------|-----------|------|
| **Desktop-ram** | Tauri 2 (Rust) | Fönsterhantering, IPC-brygga, systemdialog |
| **Transkribering** | whisper-rs / whisper.cpp | C++-optimerad Whisper-inferens |
| **GPU-acceleration** | Metal (Mac) / Vulkan (Windows) | Hårdvaruaccelererad modellkörning |
| **Ljudavkodning (fil)** | Symphonia (Rust) | Avkodar MP3, M4A/AAC, WAV, OGG, FLAC utan JS-heap |
| **Ljudavkodning (mic)** | Web Audio API | Avkodar MediaRecorder-output för Mac-mikrofon |
| **Mikrofon (inspelning)** | cpal (Rust) + MediaRecorder | Rust fångar mic via WASAPI/CoreAudio; browser komplettar |
| **Systemljud (Windows)** | WASAPI Endpoint Loopback | Fångar eConsole + eCommunications, mixas i Rust |
| **WAV-kodning** | hound (Rust) | Skriver 16-bit PCM WAV direkt till disk |
| **Frontend** | Vanilla JS + Tailwind CSS | Snabb, beroendefri UI |

### Minneshantering och Windows-optimeringar

WebView2 (Chromium-motorn i Tauri på Windows) kan inte allokera stora sammanhängande block i JS-heapen. En 2-timmars M4A-inspelning kräver ~460 MB som ett enda block vid avkodning i JavaScript — vilket kraschar processen tyst.

Transkribera löser detta genom att flytta all tung bearbetning till Rust:

**Filimport — Rust-side avkodning med Symphonia:**
- JS skickar enbart filsökvägen (en sträng) till Rust via Tauri-kommandot `transcribe_file`
- Rust avkodar filen med Symphonia, resamplar till 16 kHz mono och delar upp i 5-minuters-chunks
- Whisper-inferens sker direkt på varje chunk i Rust — JS-heap belastas aldrig med audiodata
- Minnespeak: ~19 MB per chunk, oavsett fillängd

**IPC-optimering — 16-bit PCM:**
- Ljud skickas som 16-bit PCM (i16) över Tauri IPC-bryggan, inte 32-bit float
- Halverar nyttolaststorleken: ~25 MB per 5-min-chunk istället för ~50 MB
- Whisper.cpp använder 16-bit internt — ingen kvalitetsförlust

**WASAPI-inspelning — omedelbar dialog och effektivt sparande:**
- Vid inspelningsstopp lagrar Rust det mixade ljudet i minnet (`recorded_samples`) och returnerar omedelbart
- Dialogen "Transkribera / Spara" visas direkt — JS-mix körs asynkront i bakgrunden
- Sparande via "Spara inspelning" läser direkt från `recorded_samples` i Rust (`save_audio_file`) utan IPC-transfer — filväljaren öppnas omedelbart

### Dataflöde — filimport

```
Fil på disk (MP3 / M4A / WAV / OGG / FLAC / …)
  │
  ▼  Rust: Symphonia avkodar + resamplar till 16 kHz mono f32
  │
  ▼  Rust: delar upp i 5-min-chunks (~19 MB/st)
  │
  ▼  Rust: whisper.cpp transkriberar chunk för chunk
  │        (cancel_flag kontrolleras mellan varje chunk)
  │
  ▼  JS: tar emot segmentlista [{start_ms, end_ms, text, tokens}]
  │
  ▼  UI: visar transkribering + segmentredigerare
```

### Dataflöde — WASAPI-inspelning (Windows)

```
Mikrofon ──► cpal / WASAPI ──────────────────► Rust mic-buffer
                                                        │
Systemljud ► WASAPI Endpoint Loopback ────────► Rust loopback-buffer(ar)
                                                        │
                                stop_recording(): mix + resample → recorded_samples
                                                        │
                                      ┌─────────────────┴──────────────────────┐
                                      │                                         │
                            "Spara inspelning"                       "Transkribera"
                                      │                                         │
                            save_audio_file()                  decodeWasapiMix() (JS, asynkront)
                            Rust läser recorded_samples         → Float32Array → chunks → whisper
                            och visar filväljare direkt
```

## 🛠️ Bygga från källkod

### Förutsättningar
- [Node.js](https://nodejs.org/) (v20+)
- [Rust](https://www.rust-lang.org/tools/install)
- [CMake](https://cmake.org/)

### Kom igång
```bash
git clone https://github.com/mrswedish/transcrptr.git
cd transcrptr
npm install
npm run tauri dev
```
