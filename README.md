# Transcrptr

Transcrptr är en lokal, integritetsfokuserad skrivbordsapp för transkribering av ljud. Driven av OpenAI:s Whisper-modell som körs helt på din egen dator — inga molntjänster, inga API-nycklar, ingen data som lämnar din maskin.

![Transcrptr Screenshot](public/screenshot-mac.png)

## ✨ Funktioner
- **🔒 100% Lokalt:** Ditt ljud och din röstdata stannar på din dator. Inget skickas till externa servrar — din integritet är garanterad.
- **⚡ Hårdvaruaccelererad:** Vulkan (Windows) och Metal (macOS) för snabb transkribering via GPU.
- **🎙️ Flexibel inspelning:** Spela in direkt med valfri mikrofon (med realtidsvisualiserare) eller transkribera befintliga ljudfiler.
- **📦 Modellval:** Välj mellan Small, Medium och Large beroende på om du prioriterar hastighet eller noggrannhet.
- **📊 Smart hantering:** Stora ljudfiler delas automatiskt upp i hanterbara delar — inga minneskrascher.

## 📥 Ladda ner
Gå till [Releases](https://github.com/mrswedish/transcrptr/releases) för att hämta senaste versionen:

- **Windows:** Ladda ner `Transcrptr-portable.exe` och kör direkt. Ingen installation krävs.
- **macOS:** Ladda ner `.dmg` eller `.app` från release-sidan. *(macOS kan visa en varning vid första start — se felsökning nedan).*

## 🏗️ Arkitektur
- **Tauri** (Rust-backend, webbfrontend)
- **Whisper.cpp** via `whisper-rs` för C++-optimerad transkribering
- **Vanilla JS + CSS** för ett snabbt och snyggt gränssnitt

## 🛠️ Bygga från källkod

### Förutsättningar
- [Node.js](https://nodejs.org/) (v20+)
- [Rust](https://www.rust-lang.org/tools/install)
- [CMake](https://cmake.org/)

### Kom igång
```bash
# Klona repot
git clone https://github.com/mrswedish/transcrptr.git
cd transcrptr

# Installera frontend-beroenden
npm install

# Kör i utvecklingsläge
npm run tauri dev

# Bygg för produktion
npm run tauri build
```

## ❓ Felsökning

### macOS: "Transcrptr.app är skadad och kan inte öppnas"

Eftersom Transcrptr distribueras utan en officiell Apple Developer-signatur lägger macOS Gatekeeper en karantänflagga på appen vid nedladdning. macOS varnar felaktigt att appen är "skadad".

**Appen är inte skadad.**

Lösning:
1. Flytta `Transcrptr.app` till mappen `Program`.
2. Öppna **Terminal**.
3. Kör:
   ```bash
   xattr -cr /Applications/Transcrptr.app
   ```
4. Nu kan du öppna Transcrptr som vanligt!
