# Tillgänglighet i Transkribera

Underlag för bedömning mot **EN 301 549 v3.2.1**, som för programvarans användargränssnitt hänvisar till **WCAG 2.1 nivå AA**. Några kriterier ur WCAG 2.2 AA är också uppfyllda där det varit billigt (se nedan).

> **Status:** egenbedömning av utvecklaren. Det är *inte* en certifiering och appen har ännu **inte testats med skärmläsare** (NVDA, Skärmläsaren/Narrator) eller i Windows kontrastteman. Se "Ej verifierat".

Gäller version 2.1.1 och senare.

## Hur det granskats

- **Automatiskt:** axe-core 4.10.2 med reglerna WCAG 2.0/2.1/2.2 A och AA samt best practice, på huvudvyn med transkript och på inställningspanelen, i ljust och mörkt läge. Resultat: **0 avvikelser**.
- **Kontrast:** alla färgpar i båda teman är uträknade (se tabellen).
- **Tangentbord:** dialoger, segmentredigering och spelare har provats med tangentbordshändelser i en förhandsvisning.
- **Omflöde och textavstånd:** provat vid 320 CSS-pixlars bredd (inget horisontellt rullningsfält) och med WCAG:s textavståndsvärden (radhöjd 1,5, bokstavsavstånd 0,12 em, ordavstånd 0,16 em) utan beskuren text.

## Kontrast (WCAG 1.4.3, 1.4.11)

| Par | Ljust | Mörkt | Krav |
|---|---|---|---|
| Text på papper/pappersark | 15,1 / 16,4 : 1 | 15,1 / 13,9 : 1 | 4,5 |
| Dämpad text på ark | 6,4 : 1 | 7,1 : 1 | 4,5 |
| Knapptext på accent | 7,3 : 1 | 8,3 : 1 | 4,5 |
| Knapptext på inspelningsröd | 5,5 : 1 | 6,5 : 1 | 4,5 |
| Varningstext | 6,9 : 1 | 9,3 : 1 | 4,5 |
| Fältkanter, spelarspår (`--c-control`) | 4,3 : 1 | 4,5 : 1 | 3 |
| Fokusring mot ark | 7,3 : 1 | 7,7 : 1 | 3 |

Tunna avgränsningslinjer (`--c-line`) används bara för dekorativ indelning, aldrig för att identifiera ett fält.

## Det som är gjort

| Område | Kriterier | Åtgärd |
|---|---|---|
| Landmärken, hoppa över block | 1.3.1, 2.4.1 | `header`, `main`, `footer`, namngivna regioner, länk "Hoppa till transkriptet" |
| Tangentbord | 2.1.1, 2.4.3, 2.4.7 | Allt går att nå och använda: tidsstämplar är knappar, segmenttexten öppnas med Enter/blanksteg och stängs med Esc, spelarens position är en reglage-roll (piltangenter, Home/End, Page Up/Down) |
| Dialoger | 2.1.2, 2.4.3 | Fokus flyttas in, Tab hålls i dialogen, Esc stänger, fokus återställs, bakgrunden är `inert` |
| Namn och roller | 4.1.2 | Alla fält har etikett, ikonknappar har namn, förloppsfält har `progressbar`-roll med värde, kvalitetsval har `aria-pressed`, nivåmätaren är dold för skärmläsare |
| Statusmeddelanden | 4.1.3 | Meddelanderad (`role=status`) och en dold statusrad: transkribering startad/klar, inspelning startad/pausad/stoppad, talaridentifiering |
| Färg som enda signal | 1.4.1 | Osäkra ord har prickad understrykning *och* text för skärmläsare; talare har text, inte bara färg |
| Omflöde, textavstånd | 1.4.10, 1.4.12 | Layouten bryter om vid smal bredd, sidan rullar lodrätt vid låg höjd |
| Rörelse | 2.3.3 | `prefers-reduced-motion` respekteras, även automatisk rullning till aktivt segment |
| Målstorlek | 2.5.8 (WCAG 2.2) | Kryssrutor 20 px, knappar minst 32 px, talarrubriker 28 px |
| Kontrastläge | 1.4.11 | Särskilda regler för `forced-colors` så att markerade rader, förlopp och osäkra ord syns |

## Känd begränsning eller ej verifierat

- **Skärmläsare:** inte testat med NVDA eller Skärmläsaren. Läsordning, uppläsning av `aria-description` och live-regioner i WebView2 behöver provas av en människa.
- **Windows kontrastteman och zoom:** reglerna för `forced-colors` är skrivna men inte provade i ett riktigt kontrastläge. Zoom (Ctrl + mushjul) i WebView2 är inte genomgånget i den byggda appen.
- **Systemdialoger:** fil- och mappväljare samt meddelanderutor visas av Windows och följer systemets tillgänglighet, inte appens.
- **Mikrofoninspelning:** själva inspelningsstarten förlitar sig på användarens egen hörsel/syn för att veta att ljudet verkligen spelas in; appen visar timer och storlek men ingen hörbar signal. En ljudsignal vid start/stopp är ett möjligt tillägg.
- **Ljudspelaren:** inspelningen är användarens eget material. Texten är det textalternativ som appen producerar, och innehållet i den är inte kontrollerat av appen.
- **Transkriptets språk:** sidans språk är svenska. Engelskt eller blandat tal märks inte upp med `lang` per segment.
- **Ordlistor:** förslaget att lägga till ett ord visas som en statusrad, inte som fokusflytt. Det är avsiktligt (avbryter inte skrivandet), men bör följas upp i användartest.

## Rekommenderat nästa steg

1. Provkör med NVDA och Skärmläsaren: starta, öppna fil, läs transkriptet, rätta ett ord, byt namn på talare, öppna inställningar.
2. Prova Windows kontrastteman (Aquatic, Desert, Night sky) och 200 % samt 400 % zoom.
3. Notera resultaten här och sätt version/datum på bedömningen.
