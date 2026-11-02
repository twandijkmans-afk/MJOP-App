# Golden master van de MJOP-rekenlogica (stap 0 van de gedeelde rekenkern)

**Doel.** Er komt uiteindelijk één gedeelde rekenkern voor de website en de iPhone-app (voorstel: `mjop-learning/mjop-learning/photo_walk/docs/shared_calculation_core.md`).
Vóór er ook maar iets wordt losgekoppeld, leggen we de uitkomsten van de **huidige** berekeningen vast. Daarna kan bewezen worden dat een verplaatsing
of herschrijving exact dezelfde uitkomsten geeft.

**Wat deze stap NIET doet:** er is niets aan `src/` veranderd. De berekeningen, hun uitkomsten en het opslagformaat zijn precies zoals ze waren
(`git diff origin/claude/mjop-live-implementation-smz60g -- src index.html` is leeg).

## Hoe het werkt
`test/engine-golden.spec.js` laadt de echte website in een browser (Playwright). De berekeningen staan als privéfuncties in `src/app.js`; om er bij te komen
voegt de test **in het geheugen** een meetpunt toe vlak vóór het sluiten van het bestand (via een onderschepte aanvraag; het bestand op schijf blijft ongewijzigd).
Per scenario wordt een plan opgebouwd zoals het in `saved_plans.state` staat, geopend met dezelfde functie als de website (`applyPlanBlob`, dus inclusief
het omzetten van oude plannen) en doorgerekend.

**Vastgezet voor herhaalbaarheid**
* De klok staat op `2026-06-15T12:00:00Z` (jaar 2026; de horizon is dus 2026–2035).
* Het netwerk is uit: de CBS-indexering mislukt en de vaste terugval van 3% per jaar geldt (`cbsIndexatie = null`).
* Geen opgeslagen sessie. Elk scenario wordt in twee onafhankelijke pagina's berekend en moet exact gelijk zijn; en twee keer rekenen op dezelfde staat moet hetzelfde geven.

**Wat per scenario wordt vastgelegd** (`test/golden/engine_v0/*.json`)
* per post: hoeveelheid, kosten van één beurt, conditiescore en -jaar, kozijngroepen, het schema (jaar, bedrag, omschrijving) en de metatekst;
* het volledige plan, totalen per categorie, kosten per jaar, de kasstroom (saldo per jaar), de benodigde bijdrage en de posten zonder bekende hoeveelheid;
* offertebedragen (parsing en totaal) en de automatische hoeveelheid voor élke post uit de bibliotheek.

Uitkomsten worden als tekst **op de letter** vergeleken (geen tolerantie).

## De 12 scenario's
| # | Scenario | Dekt |
|---|---|---|
| 01 | voorbeeldgebouw, standaard | basis, fonds 0 |
| 02 | idem met fonds en bijdrage | kasstroom, benodigde bijdrage |
| 03 | groot complex met alle optionele posten | schaal, hellend dak zonder gegevens |
| 04 | klein pand, nieuwbouw | andere hoeveelheden en cycli |
| 05 | gebreken en conditiescores | NEN 2767-score schuift de jaren |
| 06 | handmatige en onbekende hoeveelheden | onbekend blijft `null`, geen € 0 |
| 07 | kozijnmaterialen en eigen tarief | afronding, groepering op cyclus |
| 08 | steiger, werkhoogte onbekend | onbekend blijft `null` |
| 09 | steiger, hoog gebouw | tariefband |
| 10 | eigen posten met indexering | prijspeil en samengestelde indexering (onafhankelijk nagerekend: 18.500 × 1,03⁶ = 22.090) |
| 11 | offertes | parsing van bedragen, btw, dubbelzinnige bedragen |
| 12 | oud plan zonder hoeveelheidsobject | omzetting van plannen van vóór Quantity Foundation (zelfde totaal als 01) |

## Zelftest: merkt de golden master een wijziging echt op?
De test verandert bewust, alleen in het geheugen, drie berekeningen en eist dat de golden master dan **faalt**: het indexeringspercentage, de afronding van het
kozijntarief en de stapgrootte van de benodigde bijdrage. Slaagt zo'n test toch, dan meet de golden master niets en faalt de run.

## Gebruik
```
python3 -m http.server 8969 &
node test/engine-golden.spec.js          # vergelijken; draait ook mee in test/run-all.sh en in de CI
GOLDEN_UPDATE=1 node test/engine-golden.spec.js   # alleen als een berekening BEWUST verandert; bekijk de diff van de JSON-bestanden zorgvuldig
```
De CI zet `GOLDEN_UPDATE` nooit.

## Bewust nog niet gedekt (eerlijke beperkingen)
* **Geen echte opgeslagen plannen.** Er is geen productiedata gebruikt of gelezen. De scenario's zijn synthetisch. Het toevoegen van geanonimiseerde echte plannen kan alleen met uw toestemming en aangeleverde bestanden.
* **De echte bundels** (Maldenhof, DOC-012) worden al in de bestaande `quantity-*-real`-specs gecontroleerd op hoeveelheden, maar nog niet op kosten en kasstroom. Dat is een logische uitbreiding (stap 0b).
* **De live CBS-indexering** is vastgezet op de vaste terugval; de CBS-aanroep zelf (netwerk) hoort bij de website en wordt in een gedeelde kern als invoer meegegeven.
* **Opmaak** (euro-weergave in de schermen) wordt alleen via de metatekst per post gedekt.
* `quantity.js` en `inventory.js` hebben hun eigen unit-tests (54 en 13) die ongewijzigd blijven.

## Waarnemingen over het bestaande gedrag (vastgelegd, niet veranderd)
* `offerteTotal` geeft een niet-afgerond bedrag (bijvoorbeeld 15125,605). Geldbedragen zijn JavaScript-getallen, geen centen.
* Een bedrag als "3.200" naast een bedrag met decimalen wordt als dubbelzinnig gemarkeerd en telt niet mee in het offertetotaal (zo bedoeld in `Q.parseOfferteAmounts`).
* Bij een onbekende hoeveelheid is de post `null` en komt hij niet in de planning; er wordt nooit € 0 geteld.

## Hoe dit wordt gebruikt in de volgende stappen
1. Het loskoppelen van het rekenblok uit `app.js` (zonder gedragswijziging): het meetpunt wijst dan naar de nieuwe module en **dezelfde JSON-bestanden** moeten exact gelijk blijven.
2. Dezelfde bestanden draaien in JavaScriptCore op de macOS-CI om te bewijzen dat de app dezelfde uitkomsten geeft.
