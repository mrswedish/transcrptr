# Transcrptr

Transcrptr är en lokal, integritetsfokuserad skrivbordsapp som omvandlar tal till text — helt utan molntjänster. Allt sker på din egen dator, vilket betyder att ditt ljud och din röstdata aldrig lämnar din maskin.

![Transcrptr Screenshot](public/screenshoot-windows.png)

## 🇸🇪 Fokus på svenska

Transcrptr är byggt med det svenska språket i fokus. Applikationen använder [KB-whisper](https://huggingface.co/KBLab/kb-whisper-small) — en AI-modell från **Kungliga biblioteket (KB)** som är specialtränad på mer än **50 000 timmar** av svenskt tal, däribland tv-sändningar, riksdagstal och dialekter från hela landet.

Tack vare denna träning är modellen ovanligt träffsäker på svenska — den klarar av allt från formella presentationer till vardagligt samtalsspråk och regionala dialekter.

> **Andra språk?** Även om fokus ligger på svenska kan Transcrptr hantera andra språk tack vare den underliggande Whisper-arkitekturen. Resultatet blir dock bäst på svenska.

📰 [Läs mer om KB-whisper på Kungliga bibliotekets hemsida](https://www.kb.se/om-oss/nyheter/nyhetsarkiv/2025-02-20-valtranad-ai-modell-forvandlar-tal-till-text.html)

## ✨ Funktioner
- **🔒 Integritet först:** Ditt ljud stannar på din dator. Inget skickas till externa servrar — din integritet är garanterad. [Läs vår integritetspolicy](PRIVACY.md)
- **⚡ Hårdvaruaccelererad:** Vulkan utnyttjar din GPU på Windows för snabbare transkribering.
- **🎙️ Mötesinspelning (Windows, experimentellt):** Spela in både mikrofon och systemljud (t.ex. från Teams/Skype) via WASAPI.
- **⏸️ Pausa inspelning:** Pausa och återuppta inspelningen. Varje del tidsstämplas automatiskt.
- **🔄 Gör om transkribering:** Upptäckte du att modellen inte räckte till? Gör om utan att spela in på nytt.
- **💾 Spara och kopiera:** Exportera transkriberingen som `.txt`-fil eller kopiera till urklipp.
- **📊 Modellhantering:** Se, ladda ner och ta bort modeller från inställningarna.

## 📦 Välj rätt modell

Transcrptr erbjuder tre storlekar av språkmodellen. Du byter modell genom att klicka på **kugghjulet** (⚙️) i appen:

| Modell | Format | Storlek | Hastighet | Kvalitet |
|--------|--------|---------|-----------|----------|
| **Small** *(standard)* | Standard | ~460 MB | ⚡⚡⚡ | Bra |
| **Small** | Kvantiserad (q5_0) | ~290 MB | ⚡⚡⚡ | Bra |
| **Medium** | Standard | ~1.5 GB | ⚡⚡ | Mycket bra |
| **Medium** | Kvantiserad (q5_0) | ~900 MB | ⚡⚡ | Mycket bra |
| **Large** | Standard | ~3.0 GB | ⚡ | Bäst |
| **Large** | Kvantiserad (q5_0) | ~2.0 GB | ⚡ | Bäst |

Kvantiserade modeller laddar snabbare och använder mindre diskutrymme med minimal kvalitetsförlust — rekommenderas för de flesta användare.

> [!WARNING]
> **Small-modellen** rekommenderas inte för möten eller samtal med flera deltagare. För möten rekommenderas **Medium** eller **Large**.

> **Tips:** Om resultatet inte är tillräckligt bra, prova en större modell. Skillnaden i kvalitet är markant.

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
