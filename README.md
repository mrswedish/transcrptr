# Transcrptr

Transcrptr är en lokal, integritetsfokuserad skrivbordsapp som omvandlar tal till text — helt utan molntjänster. Allt sker på din egen dator; ditt ljud och din röstdata lämnar aldrig din maskin.

![Transcrptr Screenshot](public/screenshoot-windows.png)

## 🇸🇪 Fokus på svenska

Transcrptr använder [KB-whisper](https://huggingface.co/KBLab/kb-whisper-small) — en AI-modell från **Kungliga biblioteket (KB)** specialtränad på **50 000+ timmar** av svenskt tal, däribland tv-sändningar, riksdagstal och dialekter från hela landet.

> **Andra språk?** Transcrptr kan hantera andra språk tack vare Whisper-arkitekturen, men resultatet blir bäst på svenska.

📰 [Läs mer om KB-whisper på Kungliga bibliotekets hemsida](https://www.kb.se/om-oss/nyheter/nyhetsarkiv/2025-02-20-valtranad-ai-modell-forvandlar-tal-till-text.html)

## ✨ Funktioner
- **🔒 Integritet:** Ditt ljud stannar på din dator. Inget skickas till externa servrar. [Integritetspolicy](PRIVACY.md)
- **⚡ Hårdvaruaccelererad:** Vulkan utnyttjar din GPU för snabbare transkribering.
- **🎙️ Mötesinspelning (Windows):** Spela in både mikrofon och datorljud från t.ex. Teams/Zoom — med Stereo Mix (se guide nedan).
- **⏸️ Pausa inspelning:** Pausa och återuppta. Varje del tidsstämplas automatiskt.
- **🔄 Gör om transkribering:** Byt modell och kör om utan att spela in på nytt.
- **✏️ Redigera transkribering:** Redigera, sök och ersätt direkt i appen (Ctrl+F).
- **💾 Spara:** Exportera text som `.txt` eller ljud som `.wav`.
- **📊 Modellhantering:** Se, ladda ner och ta bort modeller i inställningarna.

## 📦 Välj rätt modell

Byt modell via **kugghjulet** (⚙️) i appen. Kvantiserade modeller rekommenderas — små filer, nästan samma kvalitet.

| Modell | Format | Storlek | Hastighet | Kvalitet |
|--------|--------|---------|-----------|----------|
| **Small** *(standard)* | Standard | ~460 MB | ⚡⚡⚡ | Bra |
| **Small** | Kvantiserad (q5_0) | ~290 MB | ⚡⚡⚡ | Bra |
| **Medium** | Standard | ~1.5 GB | ⚡⚡ | Mycket bra |
| **Medium** | Kvantiserad (q5_0) | ~900 MB | ⚡⚡ | Mycket bra |
| **Large** | Standard | ~3.0 GB | ⚡ | Bäst |
| **Large** | Kvantiserad (q5_0) | ~2.0 GB | ⚡ | Bäst |

> [!WARNING]
> **Small-modellen rekommenderas inte för möten** eller samtal med flera deltagare. Använd **Medium** eller **Large**.

## 🎙️ Spela in möten med Stereo Mix (Windows)

För att spela in både din mikrofon och datorns ljud (t.ex. Teams, Zoom, Skype) behöver du aktivera **Stereo Mix** i Windows. Det tar en minut och kräver inga extra program.

1. **Högerklicka på ljudikonen** nere till höger på skärmen → välj **"Ljud"** eller **"Ljudinställningar"**
2. Klicka på fliken **Inspelning**
3. **Högerklicka** på ett tomt område i listan → kryssa i **"Visa inaktiverade enheter"** och **"Visa frånkopplade enheter"**
4. Högerklicka på **Stereo Mix** → välj **"Aktivera"**
   > Ser du ingen Stereo Mix? Ditt ljudkort stöder tyvärr inte den här funktionen.
5. Öppna inställningarna i Transcrptr och välj **Stereo Mix** som mikrofon.

> [!IMPORTANT]
> Starta alltid mötet och se till att ljud spelas **innan** du trycker Spela in i Transcrptr.

## 📥 Ladda ner
Gå till [Releases](https://github.com/mrswedish/transcrptr/releases) för senaste versionen:

- **Windows:** Ladda ner `Transcrptr-portable.exe` och kör direkt. Ingen installation krävs.

## 🏗️ Arkitektur
- **Tauri** (Rust-backend, webbfrontend)
- **Whisper.cpp** via `whisper-rs` för C++-optimerad transkribering
- **Vanilla JS + CSS** för ett snabbt gränssnitt

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
