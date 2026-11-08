# Teknisk dokumentation — Transkribera (Windows)

Underlag för IT-avdelning, förvaltare och utvecklingsenhet. Beskriver var data lagras,
vilken nätverkstrafik som förekommer, vad som händer vid avinstallation och hur systemet är
byggt.

Avser **version 1.8.0** och **enbart Windows**. Uppgifterna är verifierade mot källkoden;
där en sökväg härleds ur Tauris API i stället för att vara hårdkodad anges det.

- **Identifier:** `com.patriksvensk.transcrptr`
- **Produktnamn:** Transkribera
- **Arkitektur:** x64 (`x86_64-pc-windows-msvc`)

---

## 1. Sammanfattning för säkerhetsgranskning

| Fråga | Svar |
|---|---|
| Skickas ljud eller text till någon server? | **Nej.** All transkribering sker lokalt. |
| Utgående nätverkstrafik? | **Endast `huggingface.co`**, och bara vid nedladdning av språkmodell. |
| Telemetri, analys, felrapportering? | **Nej, inget.** Verifierat genom sökning i hela kodbasen. |
| Automatisk uppdatering? | **Nej.** Appen kontrollerar aldrig efter nya versioner. |
| Kräver administratörsrättigheter? | **Nej** för appen. Installationsformatet avgör (se §6). |
| Fungerar utan internet? | **Ja**, fullständigt — efter att modellen laddats ned en gång. |
| Kodsignerad? | **Nej.** Se §8 — viktigaste åtgärdspunkten. |
| Lämnar avinstallation spår? | **Ja.** Se §5 — flera GB kan bli kvar. |

---

## 2. Var data lagras

Tauri använder två basmappar. Sökvägarna nedan är **härledda** ur identifiern enligt Tauri 2:s
dokumenterade beteende på Windows — koden anropar API:et, den hårdkodar inte sökvägen.

```
%APPDATA%\com.patriksvensk.transcrptr\        (C:\Users\<användare>\AppData\Roaming\...)
%LOCALAPPDATA%\com.patriksvensk.transcrptr\   (C:\Users\<användare>\AppData\Local\...)
```

Allt är **per användare**. Inget skrivs till maskingemensamma platser.

| Vad | Sökväg | Storlek | Varför där |
|---|---|---|---|
| **Språkmodeller** | `%APPDATA%\com.patriksvensk.transcrptr\models\*.bin` | **0,9–3 GB per modell**, flera kan samexistera → **8+ GB möjligt** | Roaming-mappen är Tauris standard för applikationsdata. Modellerna är stora men användarspecifika. |
| **Loggfil** | `%LOCALAPPDATA%\com.patriksvensk.transcrptr\transcrptr.log` | kB–MB. **Ingen rotation — växer obegränsat** | Diagnostik. Ligger i Local eftersom den är maskinspecifik och inte bör roama. |
| **Inställningar** (localStorage) | `%LOCALAPPDATA%\com.patriksvensk.transcrptr\EBWebView\Default\Local Storage\` | Några MB | WebView2:s egen lagring. Se §3. |
| **Inspelningar** | Användarvald mapp, eller default bredvid programfilen: `<mapp med .exe>\Transkribera-Inspelningar\` | **~115 MB per timme** | Medvetet nära användaren och utanför AppData, så inspelningar inte raderas av misstag. |
| **Exporterad text/ljud** | Där användaren väljer i spardialogen | Varierar | Användarstyrt. |

### Sessionsmappar

Varje inspelning får en egen mapp: `inspelning-ÅÅÅÅMMDD-TTMMSS[-valfritt-namn]`.

Under inspelning skrivs råspåren `mic.wav`, `lb_console.wav` och `lb_comms.wav` löpande till
disk — detta är ett medvetet skydd mot dataförlust vid krasch eller strömavbrott. Vid normalt
stopp mixas de till `recording.wav` och **råspåren raderas**.

> **Observera:** Vid krasch eller strömavbrott ligger råspåren kvar. Det är råinspelningar av
> mikrofon och systemljud och ska betraktas som lika känsliga som den färdiga filen. Appen kan
> återställa dem ("Öppna fil/mapp" → "En tidigare inspelning") men rensar dem aldrig automatiskt.

---

## 3. Inställningar

Inställningar lagras i webbläsarens `localStorage`, fysiskt under WebView2:s datamapp
(**härledd sökväg**):

```
%LOCALAPPDATA%\com.patriksvensk.transcrptr\EBWebView\Default\Local Storage\leveldb\
```

Följande nycklar sparas: `modelSize`, `modelRevision`, `modelQuantized`,
`transcriptionLanguage`, `selectedMicId`, `wasapiEnabled`, `useGpu`, `personalVocabulary`,
`confidenceThreshold`, `recordingDir`, `threadCount`, `theme`, `gpuDeviceIndex`.

**Två av dem kan innehålla känsliga uppgifter:**

- **`personalVocabulary`** — användarens egna ordlista. Innehåller ofta verksamhetsspecifika
  termer, och kan innehålla personnamn, diagnoser eller interna projektnamn.
- **`recordingDir`** — full sökväg, kan avslöja användarnamn och nätverksstruktur.

Mappen `EBWebView` innehåller även WebView2:s cache och tas **inte** bort automatiskt vid
avinstallation (se §5).

---

## 4. Nätverk och behörigheter

### All utgående trafik

Endast en enda domän kontaktas, och bara vid nedladdning av språkmodell:

```
https://huggingface.co/KBLab/kb-whisper-{medium|large}/resolve/{main|strict}/...
https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q8_0.bin
https://huggingface.co/KlangAI/pianissimo-sv-onnx/resolve/<fast revision>/{encoder-model.int8.onnx,decoder_joint-model.int8.onnx,vocab.txt,config.json}
```

Pianissimo-filerna hämtas med fast revision och verifieras med SHA-256 efter nedladdning. Modellen körs lokalt (ONNX Runtime, CPU) i katalogen `models\pianissimo-sv-int8\`; ingen ljuddata lämnar datorn.

> **För brandväggsregler:** `huggingface.co` omdirigerar till sitt CDN
> (`cdn-lfs.huggingface.co` / `cas-bridge.xethub.hf.co`) för själva filöverföringen. Båda
> måste tillåtas, annars misslyckas nedladdningen. Detta följer av Hugging Faces
> infrastruktur, inte av appens kod.

**Frontend gör noll nätverksanrop.** Typsnitt och CSS är lokalt bundlade sedan v1.5.5.

**Appen kan köras helt luftgapad.** IT kan för-deploya modellfilen till
`%APPDATA%\com.patriksvensk.transcrptr\models\` och därefter blockera all nätverkstrafik för
programmet.

### Behörigheter

| Resurs | Krävs | Kommentar |
|---|---|---|
| **Mikrofon** | Ja | Via WebView2. Windows sekretessinställning måste tillåta mikrofon. |
| **Systemljud** | Endast om påslaget | WASAPI loopback. Kräver ingen särskild behörighet. |
| **Nätverk** | Endast vid modellnedladdning | Utgående HTTPS. |
| **Filsystem** | Skriv till AppData och inspelningsmapp | Vanlig användarbehörighet. |
| **Administratör** | **Nej** | Appen begär aldrig förhöjda rättigheter. |

Tauris behörighetsuppsättning är medvetet snäv: fönsterhantering, systemdialoger och
"öppna sökväg i Utforskaren". **Filsystemspluginet är inte installerat** — JavaScript-lagret
kan inte läsa eller skriva filer på egen hand; all filåtkomst går genom namngivna
Rust-funktioner.

### Systemljudsinspelning — vad den fångar

Loopback-funktionen spelar in **allt ljud som spelas upp på datorn** — inklusive Teams- och
Zoom-möten. Det är funktionens syfte, men värt att notera ur inspelningsjuridiskt perspektiv.
Den är avstängd som standard och styrs av användaren via växeln "Mötesljud".

Appen lyssnar på två ljudutgångar samtidigt om standardenheten och kommunikationsenheten
skiljer sig åt — vanligt när headset används för samtal och högtalare för övrigt.

---

## 5. Avinstallation — vad blir kvar

Detta är den fråga IT oftast ställer, och svaret kräver eftertanke.

Installationen använder Tauris standardinställningar; ingen egen avinstallationslogik finns.

### Vid avinstallation av setup-versionen

Avinstalleraren visar en kryssruta **"Delete application data"**:

| Kryssrutan | Resultat |
|---|---|
| **Ibockad** | AppData-mapparna tas bort: modeller, loggfil, inställningar (EBWebView) |
| **Ej ibockad** | Endast programfilerna tas bort. **Modeller på flera GB blir kvar.** |

**Inspelningarna tas bort i inget av fallen.** De ligger utanför AppData — i användarens valda
mapp eller bredvid programfilen. Det är medvetet: inspelat material ska inte försvinna för att
programmet avinstalleras. Men det innebär att **ljudinspelningar av möten kan ligga kvar** efter
avinstallation.

### Portable-versionen

Har ingen avinstallation — man raderar filen. Men den lämnar **exakt samma AppData-spår**,
eftersom identifiern är densamma.

> **Fälla värd att känna till:** portable-versionens standardmapp för inspelningar ligger
> bredvid programfilen. Om användaren kör den från `Hämtade filer` hamnar mötesinspelningarna i
> `C:\Users\<användare>\Downloads\Transkribera-Inspelningar\` — en mapp som sällan omfattas av
> backup- eller gallringsrutiner, och som användare ofta uppfattar som tillfällig.

### Fullständig rensning

```bat
rmdir /s /q "%APPDATA%\com.patriksvensk.transcrptr"
rmdir /s /q "%LOCALAPPDATA%\com.patriksvensk.transcrptr"
```

Därefter behöver inspelningsmappen gås igenom manuellt, eftersom dess placering beror på
användarens val.

---

## 6. Distributionsformat

Bygget producerar tre filer. **Notera att release-steget explicit laddar upp portable och
setup — MSI:n hamnar i releasen endast om byggverktyget lägger dit den.** Detta bör verifieras
innan MSI dokumenteras som ett stött leveransformat.

| | **Portable** | **Setup (NSIS)** | **MSI** |
|---|---|---|---|
| Installationsplats | Ingen — körs där den ligger | `%LOCALAPPDATA%\Transkribera\` | `C:\Program Files\Transkribera\` |
| Administratör | Nej | Nej (per användare) | **Ja** (per maskin) |
| Tyst installation | — | `/S` | `msiexec /i ... /qn` |
| Lämpar sig för | Test, enskild användare | **Rekommenderas för utrullning** | Intune/SCCM |
| Standardmapp för inspelningar | Bredvid .exe | I installationsmappen | **Program Files — problem, se nedan** |

### ⚠️ MSI-versionen fungerar inte på låst dator

Standardmappen för inspelningar beräknas som "mappen där programfilen ligger". Vid
MSI-installation blir det `C:\Program Files\Transkribera\`, dit en vanlig användare **inte får
skriva**. Inspelning misslyckas då med ett felmeddelande, och **det finns ingen automatisk
fallback** till en skrivbar plats.

**Rekommendation:** använd NSIS-setup. Krävs MSI för Intune måste inspelningsmappen
för-konfigureras eller användaren instrueras att välja mapp vid första start.

*Detta är också en buggrapport till förvaltaren: standardmappen bör falla tillbaka till
användarens AppData när målmappen inte är skrivbar.*

---

## 7. Loggfilens innehåll

Loggen är enbart lokal och skickas aldrig någonstans. Den öppnas via Inställningar →
Avancerat → Diagnostik-logg.

**Transkriberad text loggas aldrig.** Samtliga loggrader kring transkribering innehåller
enbart metadata: antal ljudsamplingar, längd, språkkod och om anropet lyckades.

**Men följande kan förekomma och bör betraktas som känsligt:**

| Uppgift | Exempel |
|---|---|
| Användarens namn på inspelningen | `inspelning-20260903-142233-medarbetarsamtal` |
| Fullständiga sökvägar | Avslöjar användarnamn och katalogstruktur |
| Filnamn på importerade ljudfiler | Kan innehålla personnamn eller ärendenummer |

**Slutsats:** loggen innehåller inte vad som sades, men den kan avslöja **vad som spelats in
och om vem**. Klassificera den därefter — särskilt om en användare skickar den till support.

**Rekommendation till förvaltaren:** inför loggrotation (loggen växer obegränsat idag), och
överväg att bara logga filnamn utan katalogsökväg.

---

## 8. Kodsignering — viktigaste åtgärdspunkten

**Programmet är inte kodsignerat.** Byggkedjan innehåller inga signeringssteg och inget
certifikat.

Konsekvenser för en säkerhetsdriven IT-miljö:

- **SmartScreen varnar** vid första körning ("Windows har skyddat din dator")
- **AppLocker/WDAC kan inte använda utgivarregler** — måste använda hash- eller sökvägsregler,
  vilket kräver en ny regel för varje version
- **Antivirus och EDR flaggar osignerade binärer oftare**

**Rekommendation:** skaffa ett kodsigneringscertifikat (OV/EV eller Azure Trusted Signing) och
koppla in det i byggkedjan. Detta är den enskilt viktigaste förbättringen för att programmet ska
kunna hanteras smidigt i en företagsmiljö.

---

## 9. Arkitektur och byggkedja

### Struktur

```
src/                   Frontend — vanilla JavaScript, ingen bundler
  index.html           Enda sidan, endast lokala resurser
  main.js              All gränssnittslogik
  input.css → app.css  Tailwind (app.css genereras vid bygge, versionshanteras inte)
  fonts/               Lokalt bundlade typsnitt

src-tauri/
  src/lib.rs                    Tauri-kommandon, whisper, nedladdning, loggning
  src/audio.rs                  Inspelning, resampling, WAV-mixning
  src/application_loopback.rs   WASAPI loopback (Windows)
```

Frontend och backend kommunicerar via Tauris `invoke`-brygga med **27 namngivna kommandon**.
Det är den enda vägen för JavaScript att nå filsystem eller ljudenheter.

### Nyckelbeslut värda att känna till vid förvaltning

**All transkribering körs på separat tråd** (`spawn_blocking`) och omges av panikhantering,
eftersom whisper.cpp är C++-kod som kan krascha hårt. Utan detta skulle en segfault ta ner hela
programmet.

**Framstegsrapportering sker via pollning**, inte via callback från C++. Att skicka händelser
direkt från whisper.cpp:s callback orsakade tidigare tysta krascher över språkgränsen.

**Minnesanvändningen är medvetet begränsad:** filtranskribering håller ~19 MB oavsett filens
längd (strömmande avkodning i 5-minutersblock), och ljudmixningen ~64 kB. Detta löste tidigare
minnesproblem vid långa inspelningar.

**Mikrofonen går via WebView2, inte via ljudbiblioteket** på Windows. Anledningen är att
WebView2 inte klarade att allokera stora ljudbuffertar vid stopp av långa inspelningar.
Ljuddata strömmas i stället i småbitar till Rust-sidan.

### Bygga själv

Förutsättningar: Node.js 20+, Rust (stable, target `x86_64-pc-windows-msvc`), Visual Studio
Build Tools med C++, CMake, Ninja, Vulkan SDK 1.4.309.0, samt långa sökvägar aktiverat i
registret.

```bat
npm install
npm run build:css      :: OBLIGATORISKT — app.css versionshanteras inte
npm run tauri build
```

> **Vanligaste misstaget:** hoppa över `npm run build:css`. Programmet startar då helt utan
> formatering, eftersom den genererade CSS-filen avsiktligt inte ligger i versionshanteringen.

Byggkedjan länkar C-runtime statiskt, vilket innebär att **ingen Visual C++ Redistributable
behövs** på klientdatorerna.

### Kända punkter att åtgärda

| Punkt | Konsekvens |
|---|---|
| **Kodsignering saknas** | SmartScreen, AppLocker-friktion (§8) |
| **MSI + Program Files** | Inspelning misslyckas utan fallback (§6) |
| **Loggrotation saknas** | Loggfilen växer obegränsat (§7) |
| **Rust- och Tauri-versioner är inte låsta** | Ett bygge om sex månader kan ge annan verktygskedja. Överväg `rust-toolchain.toml`. |
| **Utvecklarverktyg aktiverade i release** | WebView2:s devtools kan gå att öppna i produktionsbygget. Bör läggas bakom en felsökningsflagga. |
| **Ingen Content Security Policy** | Låg risk eftersom allt innehåll är lokalt, men avviker från rekommendationen. |
| **Versionsnummer ur synk** | `package.json` säger 1.1.75 medan programmet är 1.8.0. Kosmetiskt — `package.json`-versionen används inte vid paketering — men förvirrande. |

---

## 10. Personuppgifter och gallring

Programmet behandlar ljudinspelningar och transkriberad text lokalt på användarens dator. Inget
lämnar datorn.

Att uppmärksamma vid införande:

1. **Inspelningar raderas aldrig automatiskt.** De ackumuleras (~115 MB per timme) tills
   användaren rensar dem via Inställningar → "Radera alla ljudinspelningar", eller manuellt.
2. **Ingen gallringsrutin är inbyggd.** Verksamheten behöver egna rutiner för hur länge
   mötesinspelningar får sparas.
3. **Inspelningar överlever avinstallation** (§5).
4. **Råspår kan ligga kvar efter krasch** och innehåller lika känsligt material som den färdiga
   inspelningen (§2).
5. **Loggfilen kan avslöja mötesnamn** även om den inte innehåller samtalsinnehåll (§7).
6. **Ordlistan kan innehålla personuppgifter** om användaren lagt in namn eller diagnoser (§3).

Vid utrullning på delade datorer: allt lagras per användarprofil, så data separeras mellan
användare — men inspelningsmappen kan pekas mot en gemensam plats, vilket då delar materialet.
