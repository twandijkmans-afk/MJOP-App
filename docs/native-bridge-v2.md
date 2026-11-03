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
| `startMeasurement` | `mode` (`round`/`element`), `planId?`, `elementKey?` (verplicht bij `element`), `force?` | opent zo nodig het project en start daarna de **bestaande** Fotoronde-brug (`startPhotoRound` / `startElementScan`). De `planRef` komt altijd van de website |
| `getStatus` | — | huidige status |
| `getProposals` | — | openstaande voorstellen (onbekende waarden blijven `null`) |
| `signOut` | — | de bestaande uitlogactie |
| `newProject` | — | opent de startflow van de website |

## Website → app: berichten (`action`)

Dezelfde envelop als altijd: `{ v:1, action, requestId, payload }`.

- `webReady` — zie handshake.
- `webReply` — antwoord op een commando: `{ command, ok:true, data }` of `{ command, ok:false, error:{ code, message } }`, met het requestId van het commando. Foutcodes: `INVALID_COMMAND`, `NOT_LOGGED_IN`, `UNSAVED_CHANGES`, `OPEN_FAILED`, `LOAD_FAILED`, `NO_PROJECT`, `NO_ELEMENT`, `NO_BRIDGE`, `TIMEOUT`, `FAILED`.
- `webState` — `{ loggedIn, subscribed, planId, hasBuilding, example, label, tab, screen, dirty, saveStatus, pendingProposals, planRef, nextStep }`.
  `saveStatus`: `NOT_LOGGED_IN`, `NOT_SAVED` (geen abonnement: wijzigingen worden niet opgeslagen), `PENDING`, `SAVED`, `ERROR`. Alleen lezen; er wordt niets aan abonnementen of betalingen gewijzigd.

## Bestaande brug

`startPhotoRound`, `startElementScan`, `listProposals`, `ackProposals`, `getCapabilities`, `print` en de antwoorden `capabilities`, `proposals`, `round-status`, `error`
zijn **ongewijzigd** (`src/photo-round.js`). De nieuwe module hangt zich ernaast (`window.MJOPNativeBridge.receive` wordt geketend: eigen berichten naar de nieuwe
module, alles anders naar de bestaande ontvanger).

## Tests

- `test/native-nav.unit.spec.js` (Node): validatie, handshake, oude app, tijdslimiet, commando's, ketting naar de bestaande brug.
- `test/native-tabs.spec.js` (Playwright): volledige sessie met een nagebootste app en nagebootst Supabase-netwerk, inclusief oude app en gewone browser.
- `test/fixtures/native-bridge/contract_v1.json`: gedeelde voorbeeldberichten; hetzelfde bestand wordt door de Swift-tests in `mjop-learning` gebruikt.
