# Gevelherkenning: modellen vergelijken (Claude, Gemini, SAM 3)

Aanleiding: de feedback van de docent en zijn AI-reviewer (november 2026). Kern daarvan: een taalmodel is sterk in *wat* er op een foto staat, maar minder in *waar* de randen precies liggen, en zonder testset met bekende maten weet niemand welk model het beste werkt.

Dit onderdeel maakt het mogelijk om dezelfde gevelfoto door meerdere modellen te halen en de uitkomsten eerlijk te vergelijken. Het verandert nog niets aan de Gevelfoto-pagina zelf: die gebruikt nog steeds Claude zoals voorheen.

## Wat er is

| Onderdeel | Bestand | Wat het doet |
|---|---|---|
| Kern | `supabase/functions/gevel-detect/core.mjs` | Bouwt de verzoeken voor Claude, Gemini en SAM 3, zet de antwoorden om naar één elementlijst, combineert taalmodel en SAM 3, legt per uitkomst model, promptversie, foto-hash, tijd en tokens vast |
| Edge Function | `supabase/functions/gevel-detect/index.ts` | Dezelfde kern via de server, alleen voor ingelogde gebruikers. Sleutels staan als secrets op Supabase, niet in de browser |
| Vergelijkingsscherm | `gevelfoto/vergelijk.html` | Ontwikkelpagina: foto kiezen, modellen aanvinken, uitkomsten naast elkaar met overlay, aantallen, tijd, tokens en herkomst |
| Script voor de testset | `scripts/gevel-detect-run.mjs` | Draait de kern op een map foto's, zonder Supabase |
| Scorescript | `scripts/gevel-eval.mjs` | Vergelijkt uitkomsten met de grondwaarheid: precisie, recall, gemiddelde IoU, telfout; met drempels voor CI |
| Unittest | `test/gevel-detect.unit.spec.js` | Omzetten, combineren, sleutelafhandeling en scoren, met nep-netwerk |

## Rolverdeling

| Laag | Wie | Voorbeeld |
|---|---|---|
| Herkennen | Taalmodel met beeld (Claude of Gemini) | "Dit is een raamkozijn, hout" |
| Lokaliseren | SAM 3 (segmentatie) | Precieze rand van dat kozijn |
| Rekenen | Gevelfoto-pagina (vaste regels, homografie) | m², aantallen |
| Bevestigen | Adviseur | Correctie, akkoord |

De combinatie `gemini+sam3` (of `claude+sam3`) werkt zo: het taalmodel bepaalt welke kozijnen er zijn. Voor elk kozijn worden de SAM 3-maskers gezocht die voor minstens 60 % binnen het (8 % ruimere) kader liggen. Het kader wordt dan het omsluitende kader van die maskers. SAM 3 splitst een kozijn vaak per raam of draaiend deel; het taalmodel houdt het bij elkaar, dus het aantal kozijnen komt van het taalmodel.

Twee veiligheden, toegevoegd na de eerste echte test: alleen maskers van hetzelfde type verfijnen een element (een raammasker van het glasstrookje boven een garagedeur maakte die deur anders tot een smalle strook), en het verfijnde kader moet minstens 40 % van het oorspronkelijke oppervlak houden. Anders blijft het kader van het taalmodel staan, met de reden in `refine_rejected`. Omdat SAM 3 alleen op "window" en "drainpipe" zoekt, worden deuren en garagedeuren nu niet verfijnd.

Maskers van SAM 3 die bij geen enkel kozijn horen, worden niet toegevoegd. Ze komen als `unmatched_segments` mee ("mogelijk gemist"). Op een schuine foto zijn dat deels kozijnen die het taalmodel miste en deels kozijnen van buurpanden. De adviseur beslist, niet het systeem.

Elk element draagt `geometry_origin`: `LLM_BOX` (kader van het taalmodel), `LLM_BOX_REFINED_BY_SAM3` (verfijnd, met het oorspronkelijke kader in `refined_by.llm_box`) of `SAM3_MASK`.

## Hoeveelheden naast elkaar

Op `gevelfoto/vergelijk.html` zet je in stap 3 de schaal. Dat kan op twee manieren:

- Uit de BAG: zoek het adres op en tik de gevelzijde aan die op de foto staat (`src/bag-gevel.mjs`, dezelfde werkwijze als de Gevelfoto-pagina). De lengte van die zijde wordt de afstand, en de twee punten komen op de linker- en rechterrand van het muurvlak dat het eerste taalmodel aanwees. Dat is een aanname: controleer of de punten echt op de hoeken van deze gevel staan en tik ze anders zelf aan. De BAG-omtrek is van boven ingemeten en kan afwijken van de gevel op ooghoogte, en een BAG-pand kan meer omvatten dan de gefotografeerde gevel.
- Zelf: tik twee punten aan waarvan je de echte afstand weet (bijvoorbeeld een nagemeten kozijn) en vul die afstand in.

Pandgrenzen. In een doorlopende straatwand staan vaak buurpanden mee op de foto. Dan is het muurvlak breder dan het pand in de BAG, en tellen de ramen van de buren mee. Daarom:

- Het taalmodel geeft in dezelfde aanroep (prompt `gevel_detect_v0.2`) een voorstel voor de pandgrenzen (`facade.boundaries`, met reden en zekerheid) en of de gevel links of rechts doorloopt voorbij de foto. Dat is een voorstel, geen feit.
- Op de pagina staan de voorgestelde grenzen als gele stippellijnen. Met "Grens zetten of weghalen" verplaats je ze; met "Pand kiezen" tik je in het pand dat je meet. De rest van de foto wordt gedimd.
- Alleen wat binnen het pand ligt telt mee: kozijnen op hun middelpunt, muurvlakken en lijnen (goot, boeiboord) afgesneden op de grenzen. De tabel meldt hoeveel elementen buiten het pand vielen.
- Staan beide grenzen van het pand op de foto, dan wordt de BAG-breedte de afstand tussen die grenzen. Loopt het pand door tot de fotorand, dan kan de BAG-breedte geen schaal geven; de pagina zegt dat en vraagt om een foto van verder weg of een eigen maat.
- De pagina zet de schaalpunten niet meer automatisch op het muurvlak als er grenzen op de foto staan, als het model zegt dat de gevel doorloopt, of als het muurvlak tot de rand van de foto loopt.

Eerste test (één foto, een blok in Amsterdamse School-stijl): met een losse vraag wezen Gemini Flash en Pro allebei één grens aan bij de regenpijp in het midden, "zeker". Met de prompt `gevel_detect_v0.2`, die zegt dat een symmetrie-as binnen één gebouw geen grens is, zag Gemini daar geen grens meer, wel dat de gevel aan beide kanten doorloopt. Het voorstel hangt dus sterk af van de prompt; bevestiging door de gebruiker blijft nodig, en de BAG of een eigen meting moet uitwijzen welke versie klopt.

Daarna rekent de pagina met `quantities()` uit de kern (vaste regels, getest) per model uit: aantal en m² ramen, deuren en garagedeuren, metselwerk bruto en netto, en meters hemelwaterafvoer, goot, boeiboord en waterslag.

- Elk model krijgt dezelfde schaal, dus verschillen komen alleen uit de kaders.
- Aannames: foto recht van voren, de gevel is één plat vlak, geen perspectiefcorrectie. Bij een schuine foto of een gevel met erkers zijn de uitkomsten systematisch fout.
- Netto metselwerk is bruto min de ramen en deuren waarvan het middelpunt in het muurvlak ligt.
- Bij minder dan 40 pixels per meter waarschuwt de pagina: dan is elke pixel meer dan 2,5 cm.
- "Uitkomst bewaren" neemt de schaal (punten, lengte, pixels per meter) en de hoeveelheden per model mee in het JSON-bestand.

## Eerste waarnemingen (25-11-2026, drie foto's, géén grondwaarheid)

Dit zijn indrukken, geen metingen. Er zijn nog geen foto's met bekende maten.

| | gemini-3.5-flash | gemini-3.1-pro-preview | SAM 3 |
|---|---|---|---|
| Tijd per foto | 8 tot 11 s | ongeveer 67 s | 0,5 tot 1,5 s (eerste aanroep tot 14 s) |
| Rechte gevel (maldenhof_2) | 13 kozijnen, kaders netjes | 13 kozijnen, maar ook een deur achter struiken en hemelwaterafvoeren die er niet lijken te zijn | 25 maskers: per raam of draaiend deel, ook kozijnen van het buurpand |
| Schuine gevel (maldenhof_1) | 7 kozijnen, een deel gemist | niet getest | 42 maskers, inclusief gemiste kozijnen en buurpanden |
| Deuren, goten | wel | wel | "door" en "gutter" gaven niets op deze foto's |

Wat dit betekent: SAM 3 maakt de kaders van Gemini zichtbaar strakker, maar is als enige bron niet bruikbaar (te veel losse delen, geen deuren). De combinatie lijkt de beste richting. Of dat ook betere m² oplevert, moet de testset uitwijzen.

### Claude en Gemini op dezelfde foto (25-11-2026, prompt `gevel_detect_v0.2`)

Eén foto van een bedrijfsverzamelgebouw met acht traveeën, schaal uit de BAG (27,93 m). Nog steeds geen gemeten maten: dit is een vergelijking op het oog.

| | Claude (claude-opus-5-5) | Gemini (gemini-3.5-flash) |
|---|---|---|
| Tijd | 19 s | 7 s |
| Tokens in / uit | 5.166 / 2.267 | 2.011 / 799 |
| Indeling | ramen op de verdieping, deuren en garagedeuren beneden apart, ook de smalle glasstrook links | per travee één kader van dak tot straat (op een eerdere run van dezelfde foto wel apart) |
| Raamkozijnen | 9 st, 62 m² | 4 st, 95 m² |
| Pandgrenzen | op beide hoeken van het pand, gevel loopt door (buurpanden) | geen grens, gevel loopt niet door |

- Claude legde de randen hier al zo strak dat SAM 3 weinig toevoegt (62 → 63 m²); bij Gemini scheelt SAM 3 veel (95 → 71 m²), maar de indeling blijft fout.
- Gemini gaf op dezelfde foto bij twee runs een heel andere indeling. Een model moet daarom op meerdere runs per foto worden gemeten, niet op één.
- Gevonden en opgelost: een SAM 3-masker dat ook het glas boven een deur bevatte, liet een raam naar beneden doorgroeien. Het verfijnde kader blijft nu binnen de marge rond het kader van het taalmodel.

## Op Supabase zetten

De sleutels horen als secrets op Supabase, nooit in de code, de browser of een mail. Voer uit in de map van deze repository, met de Supabase CLI ingelogd op het project:

```bash
supabase secrets set GEMINI_API_KEY=... ROBOFLOW_API_KEY=...
```

Optioneel, als je Claude ook via de server wilt vergelijken:

```bash
supabase secrets set ANTHROPIC_API_KEY=...
```

Optioneel, voor een kosteninschatting (prijs per miljoen tokens in USD, zoals op de prijspagina van de aanbieder):

```bash
supabase secrets set GEMINI_PRICE_IN=... GEMINI_PRICE_OUT=...
```

Daarna de functie zelf:

```bash
supabase functions deploy gevel-detect
```

Zonder prijs blijft de kostenkolom leeg; de kern gokt geen prijzen. Het model is in te stellen met `GEMINI_MODEL` en `CLAUDE_MODEL` (standaard `gemini-3.5-flash` en `claude-opus-5-5`).

## De testset

Advies van de reviewer: 20 tot 30 gebouwen met bekende maten, gevarieerd (bouwjaar, metselwerk en strakke gevels, schaduw, bomen, smalle straten). Bevries de set en houd een deel apart (`split: "holdout"`) dat je nooit gebruikt om een prompt of instelling bij te stellen.

Per foto één bestand `<naam>.truth.json`:

```json
{
  "contract": "gevel_testset_v1",
  "photo": "voorbeeldstraat_12.jpg",
  "photo_sha256": "<sha256 van precies dit fotobestand>",
  "image": { "width": 2000, "height": 1500 },
  "split": "dev",
  "annotated_by": "<naam>",
  "annotated_at": "2026-12-01",
  "source": "eigen meting met laserafstandmeter",
  "elements": [
    { "type": "kozijn_raam", "points": [[412, 380], [655, 610]], "width_m": 1.82, "height_m": 1.45 },
    { "type": "kozijn_deur", "points": [[700, 520], [790, 900]], "width_m": 1.02, "height_m": 2.31 },
    { "type": "hwa", "points": [[960, 120], [962, 1180]], "length_m": 8.4 }
  ]
}
```

- `points` zijn pixels in die foto: bij een kozijn linksboven en rechtsonder, bij een lijnelement begin en eind.
- `type` gebruikt dezelfde sleutels als de Gevelfoto-pagina.
- Maten (`width_m`, `height_m`, `length_m`) zijn optioneel per element. Het scorescript gebruikt ze nog niet; ze zijn nodig voor de volgende stap, de fout in m² en in euro's.
- De foto-hash koppelt grondwaarheid en uitkomst. Draai het script dus op precies hetzelfde bestand.

Meetprotocol, kort:
1. Foto recht van voren, de hele gevel in beeld, telefoon waterpas. Geen herkenbare personen of kentekens.
2. Meet minstens drie kozijnen (breedte en hoogte buitenwerks) en de gevelbreedte met een laserafstandmeter of rolmaat.
3. Teken alle zichtbare elementen in, ook de kleine. Twijfel je of iets één of twee kozijnen is, schrijf dat in een veld `note`.
4. Laat iemand anders een paar foto's controleren.

## Scoren

```bash
node scripts/gevel-detect-run.mjs --providers gemini,sam3,gemini+sam3 --out uitvoer/ testset/*.jpg
```

```bash
node scripts/gevel-eval.mjs --truth testset/ --pred uitvoer/ --split dev
```

Het scorescript koppelt per type bij een IoU van minstens 0,5 en meldt per aanbieder precisie (hoeveel van de gevonden elementen klopt), recall (hoeveel van de echte elementen is gevonden), de gemiddelde IoU van de treffers en de telfout. Raam en deur worden ook samen gescoord, omdat een verwisseling minder erg is dan een gemist kozijn.

Met `--min-recall 0.8 --min-precision 0.8` stopt het script met een fout als een aanbieder onder de drempel zakt. Dat is bedoeld voor GitHub Actions zodra de testset bevroren is: een nieuwe prompt- of modelversie die slechter scoort, gaat dan niet live. Omdat de aanroepen geld kosten en sleutels nodig hebben, draait CI dan op opgeslagen uitkomsten (`*.detect.json`) of handmatig.

## Privacy

Met dit onderdeel gaan gevelfoto's ook naar Google (Gemini) en Roboflow (SAM 3), naast Anthropic.

- Het vergelijkingsscherm verkleint en hercodeert de foto; daarmee verdwijnen EXIF en GPS. Het script verstuurt de foto ongewijzigd.
- Gezichten en kentekens worden nog niet onherkenbaar gemaakt. Dat moet op de telefoon gebeuren, vóór het uploaden, en staat op de lijst.
- Gebruik bij Gemini een betaald account: bij de gratis laag mag Google de invoer gebruiken om zijn producten te verbeteren.
- Er wordt niets opgeslagen. Het logregeltje van de Edge Function bevat alleen de foto-hash, gebruikers-id, modellen, tijden, tokens en aantallen.
- Voor een echte release: verwerkersovereenkomsten, bewaartermijnen en een korte DPIA (zie de review).

## Nog niet gedaan

- De Gevelfoto-pagina zelf gebruikt deze functie nog niet. Eerst meten, dan kiezen.
- Geen fout in m² en euro's: daarvoor zijn de maten in de testset en de schaal per foto nodig.
- Geen quotum per gebruiker op de Edge Function.
- SAM 3-prompts met een kader (in plaats van tekst) zijn niet gebruikt; dat zou het verfijnen per kozijn nog gerichter maken.
