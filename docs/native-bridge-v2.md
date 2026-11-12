# Native navigatie in de iPhone-app — brugcontract (app-versie 2)

De iPhone-app **MJOP Live** toont vanaf app-versie 2 zelf de tabbalk onderin (Home, Projecten, Meten, MJOP, Profiel). De website blijft de inhoud
tonen voor alles wat nog niet native is. Deze pagina beschrijft het contract tussen website (`src/native-nav.js`, haken in `src/app.js`) en app.

Uitgangspunten: **alleen optellend**, **achterwaarts compatibel**, **geen DOM-geklik** (de app stuurt gevalideerde commando's, de website voert ze uit via
zijn eigen acties), en **alleen lezen/navigeren**: geen enkel commando schrijft naar `saved_plans`.

## Wanneer is dit actief?

| Situatie | Gedrag |
|---|---|
| Gewone browser | Niets verandert. Eigen tabbalk zichtbaar. De module stuurt nooit een bericht. |
| Oude app (`MJOPLiveApp/1`) | Niets verandert. De website stuurt geen enkel nieuw bericht (een oude app zou het als "ongeldig bericht" tonen). Nieuwe berichten van buiten worden genegeerd. |
| Nieuwe app (`MJOPLiveApp/2`) + deze website | Handshake (zie hieronder); de eigen tabbalk en de zwevende knoppen worden verborgen (`html.native-tabs`). |
| Nieuwe app + oudere website | De oudere website meldt zich nooit met `webReady`; de app valt na een korte tijd terug op de klassieke weergave (één WebView met kopbalk). |
| Nieuwe app die niet antwoordt op `webReady` | Na 6 seconden komt de eigen tabbalk van de website terug. Een app zonder navigatie bestaat niet. |

Volgorde van uitrollen: **eerst de website, dan de app.**

## Handshake

1. De website ziet `MJOPLiveApp/<n>` met n ≥ 2 in de User-Agent en verbergt meteen zijn eigen tabbalk (geen flits).
2. De website stuurt `webReady`: `{ v:1, action:"webReady", requestId, payload:{ features:["nav1"], webVersion:"native-nav-1" } }`.
3. De app antwoordt met `{ v:1, type:"nativeReady", features:["tabs1"], appVersion, lidar }`. Alleen met `tabs1` blijft de website-tabbalk verborgen.
4. Daarna stuurt de website `webState` bij elke verandering (gebundeld, 200 ms, alleen als de inhoud echt anders is).

## App → website: commando's (`type:"command"`)

Altijd `{ v:1, type:"command", command, requestId, ... }`. De website valideert streng (gesloten lijst, onbekende velden genegeerd) en antwoordt altijd met `webReply`.

| Commando | Parameters | Doet |
|---|---|---|
| `navigate` | `tab` (`start`,`home`,`gebouw`,`fotoronde`,`planning`,`rapport`,`account`,`instellingen`,`mijngebouwen`), `sub?` (alleen bij account/instellingen: `profiel`,`organisatie`,`weergave`,`rapport`,`abonnement`) | zelfde als een tik op dat tabblad |
| `getProjects` | — | ververst en geeft de projectlijst van de ingelogde gebruiker (maximaal 200) |
| `openProject` | `id`, `tab?`, `force?` | opent een opgeslagen project (zelfde actie als op de website). Zonder `force` wordt een project met **niet-opgeslagen wijzigingen nooit vervangen** (`UNSAVED_CHANGES`) |
| `startMeasurement` | (vervallen) | De camera-scanner bestaat niet meer; de website antwoordt altijd met de fout `REMOVED` en start niets. Meten in de app opent de pagina Gevelfoto (`navigate` naar `fotoronde`). |
| `getStatus` | — | huidige status |
| `getProposals` | — | openstaande voorstellen (onbekende waarden blijven `null`) |
| `signOut` | — | de bestaande uitlogactie |
| `newProject` | — | opent de startflow van de website |

## Website → app: berichten (`action`)

Dezelfde envelop als altijd: `{ v:1, action, requestId, payload }`.

- `webReady` — zie handshake.
- `webReply` — antwoord op een commando: `{ command, ok:true, data }` of `{ command, ok:false, error:{ code, message } }`, met het requestId van het commando. Foutcodes: `INVALID_COMMAND`, `NOT_LOGGED_IN`, `UNSAVED_CHANGES`, `OPEN_FAILED`, `LOAD_FAILED`, `NO_PROJECT`, `NO_ELEMENT`, `NO_BRIDGE`, `TIMEOUT`, `FAILED`.
- `webState` — `{ loggedIn, subscribed, planId, hasBuilding, example, label, tab, screen, dirty, saveStatus, pendingProposals, planRef, nextStep }`, details }`.
  `details` (optioneel, voor het native projectdetailscherm; een oudere app negeert het) hoort bij het GEOPENDE project en is `null` zonder gebouw en voor het voorbeeldgebouw: `{ bouwjaar, units, dakM2, dakGeschat, gevelM2, gevelGeschat, posten, geraamdTotaal, periodeVan, periodeTot, gevelfotos }`. Onbekend is `null`, nooit 0 (ook een totaal van 0 euro is onbekend); `dakGeschat`/`gevelGeschat` betekent: afgeleid uit de BAG-geometrie, geen 3D BAG-waarde. Alleen lezen; kosten komen uit dezelfde berekening als het Overzicht.
  `saveStatus`: `NOT_LOGGED_IN`, `NOT_SAVED` (geen abonnement: wijzigingen worden niet opgeslagen), `PENDING`, `SAVED`, `ERROR`. Alleen lezen; er wordt niets aan abonnementen of betalingen gewijzigd.

## Bestaande brug

`startPhotoRound`, `startElementScan`, `listProposals`, `ackProposals`, `getCapabilities`, `print` en de antwoorden `capabilities`, `proposals`, `round-status`, `error`
zijn **ongewijzigd** (`src/photo-round.js`). De nieuwe module hangt zich ernaast (`window.MJOPNativeBridge.receive` wordt geketend: eigen berichten naar de nieuwe
module, alles anders naar de bestaande ontvanger).

## Tests

- `test/native-nav.unit.spec.js` (Node): validatie, handshake, oude app, tijdslimiet, commando's, ketting naar de bestaande brug.
- `test/native-tabs.spec.js` (Playwright): volledige sessie met een nagebootste app en nagebootst Supabase-netwerk, inclusief oude app en gewone browser.
- `test/fixtures/native-bridge/contract_v1.json`: gedeelde voorbeeldberichten; hetzelfde bestand wordt door de Swift-tests in `mjop-learning` gebruikt.

## Gevelscanner 2.0: gevelinventaris (alleen optellend)

De iPhone-app kan na een fotoronde naast de bestaande voorstellen (`mjop_scan_proposal_v2`, ongewijzigd) een **gevelinventaris** leveren: contract
`mjop_gevel_inventory_v1` (schema en uitleg in `mjop-learning`: `photo_walk/schemas/mjop_gevel_inventory_v1.schema.json`, `photo_walk/docs/gevelscanner_2.md`).

| Richting | Bericht | Inhoud |
|---|---|---|
| App → website | `capabilities` | extra veld `features: ["gevelscan2"]` (een oudere app stuurt het veld niet) |
| Website → app | `listFacadeInventory` | `{ planRef }`; **alleen** gestuurd als `features` `gevelscan2` bevat |
| App → website | `facade-inventory` | `{ planRef, inventories: [ … ] }` |
| Website → app | `ackProposals` (bestaand) | bevestigt ook de ontvangen `inventory_id`'s |

Verwerking (`src/gevel-inventory.js`, haken in `src/app.js`):

- Elke inventaris wordt opnieuw tegen het contract gecontroleerd; een andere `plan_ref` wordt nooit toegepast; samenvoegen is idempotent op `inventory_id`; een nieuwere revisie van dezelfde ronde vervangt de oude.
- De inventaris staat in `photoRound.inventories` en zit dus in het planobject: opslaan loopt via de bestaande planopslag. Geen databasewijziging.
- Er wordt **niets automatisch overgenomen**. Een hoeveelheid wordt eerst een bron bij een bestaande kozijnrij (`Q.addEvidence`) en pas na bevestiging van de onzekerheid de hoeveelheid (`Q.selectEvidence`).
- **Kengetallen**: draaiende delen → rij *Draaiend raam*, vaste delen → *Vast glas*, deurkozijnen → *Deur*. Voor het aantal kozijnen, het kozijnoppervlak en het glasoppervlak bestaat geen passend kengetal: die worden getoond met die melding en er worden geen kosten uit afgeleid. De module bevat geen prijzen en rekent geen kosten; dat blijft de bestaande berekening.

Tests: `test/gevel-inventory.unit.spec.js` (Node) en `test/gevel-inventaris.spec.js` (Playwright, nagebootste app, inclusief een app zonder `gevelscan2`). Fixture: `test/fixtures/gevel-inventory/gevel_inventory_v1_example.json` (door de app zelf gemaakt).
