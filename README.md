# Transcrptr

Transcrptr är en lokal, integritetsfokuserad skrivbordsapp som omvandlar tal till text — helt utan molntjänster. Allt sker på din egen dator, vilket betyder att ditt ljud och din röstdata aldrig lämnar din maskin.

![Transcrptr Screenshot](public/screenshot-mac.png)

## 🇸🇪 Fokus på svenska

Transcrptr är byggt med det svenska språket i fokus. Applikationen använder [KB-whisper](https://huggingface.co/KBLab/kb-whisper-small) — en AI-modell från **Kungliga biblioteket (KB)** som är specialtränad på mer än **50 000 timmar** av svenskt tal, däribland tv-sändningar, riksdagstal och dialekter från hela landet.

Tack vare denna träning är modellen ovanligt träffsäker på svenska — den klarar av allt från formella presentationer till vardagligt samtalsspråk och regionala dialekter.

> **Andra språk?** Även om fokus ligger på svenska kan Transcrptr hantera andra språk tack vare den underliggande Whisper-arkitekturen. Resultatet blir dock bäst på svenska.

📰 [Läs mer om KB-whisper på Kungliga bibliotekets hemsida](https://www.kb.se/om-oss/nyheter/nyhetsarkiv/2025-02-20-valtranad-ai-modell-forvandlar-tal-till-text.html)

## ✨ Funktioner
- **🔒 Integritet först:** Ditt ljud stannar på din dator. Inget skickas till externa servrar — din integritet är garanterad.
- **⚡ Hårdvaruaccelererad:** Vulkan (Windows) och Metal (macOS) utnyttjar din GPU för snabbare transkribering.
- **🎙️ Flexibel inspelning:** Spela in direkt med valfri mikrofon (med realtidsvisualiserare) eller transkribera befintliga ljudfiler.
- **📊 Smart hantering:** Stora ljudfiler delas automatiskt upp i hanterbara delar — inga minneskrascher.

## 📦 Välj rätt modell

Transcrptr erbjuder tre storlekar av språkmodellen. Du byter modell genom att klicka på **kugghjulet** (⚙️) i appen:

| Modell | Storlek | Hastighet | Träffsäkerhet | Bäst för |
|--------|---------|-----------|---------------|----------|
| **Small** *(standard)* | ~200 MB | ⚡⚡⚡ Snabb | Bra | Vardagliga inspelningar, möten, anteckningar |
| **Medium** | ~800 MB | ⚡⚡ Medel | Mycket bra | Föreläsningar, intervjuer |
| **Large** | ~1.6 GB | ⚡ Långsam | Bäst | Svåra dialekter, brusigt ljud, maximal noggrannhet |

> **Tips:** Börja med **Small** — den räcker ofta gott och är betydligt snabbare. Om resultatet inte blir tillräckligt bra, prova Medium eller Large. Skillnaden i hastighet beror på att större modeller har fler parametrar att beräkna, vilket kräver mer tid och datorkraft.

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
