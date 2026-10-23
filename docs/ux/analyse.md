# MJOP Live — UX-analyse (nieuwe gebruiker, iPhone 375×667)

Methode: de huidige website en de iPhone-app (incl. Fotoronde uit PR #59) doorlopen als iemand die de app nooit eerder zag.
Schermafbeeldingen van vóór de wijzigingen: `docs/ux/voor/`. Na elke stap: `docs/ux/na/`.

Legenda: **T** = te technisch · **O** = onduidelijk · **E** = overbodig · **V** = verwarrend

| # | Stap | Bevinding | Type | Aanpak (stap) |
|---|------|-----------|------|---------------|
| 1 | Account / inloggen | Na inloggen land je op het adresscherm of het Overzicht; er is geen plek die zegt "dit zijn je gebouwen, kies er één". Gebouwen staan verstopt onder Account → Mijn gebouwen. | O | **1** Startpagina |
| 2 | Nieuw gebouw | Adres zoeken werkt goed, maar daarna land je direct in een Overzicht vol grafieken en bedragen; er is geen uitleg wat er al is ingevuld en wat een schatting is. | O/V | **2** Wizard |
| 3 | MJOP-project maken/opslaan | "Opslaan" bestaat niet als knop, alleen een statusregel onderaan; zonder abonnement staat er "Wijzigingen worden niet opgeslagen" zonder uitleg wat je moet doen. | O | 1 (opslagstatus), 5 |
| 4 | Posten toevoegen/aanpassen | "Posten" en "bibliotheek" zijn vakjargon. Een nieuwe gebruiker weet niet welke posten bij een gebouw horen. Kozijntabel (Type/Materiaal/Aantal/Tarief/Bedrag) is op 375 px krap. | T/O | **2** vragen in gewone taal |
| 5 | Fotoronde starten | Zes tabs onderaan, waarvan "Fotoronde" een eigen tab met voorbereidende tekst die een scan als ‘voorstel’ beschrijft. De iPhone-app vraagt eerst gevelnamen/-richtingen voordat de camera opent. | V/E | **3** Fotoronde |
| 6 | Gevels/kozijnen fotograferen | Camera-instructie ontbreekt als korte tekst; statusregels noemen "keyframes", "LiDAR multi-frame". | T | 3 |
| 7 | Scanresultaten controleren | Termen `PROPOSED`, `PHOTO_WALK_SCAN`, schemaversie zijn in de standaardweergave zichtbaar. Onzekere maten staan als getal zonder woordelijke betrouwbaarheid. | T | 3 + **4** |
| 8 | Hoeveelheden koppelen | Meerstaps-flow: bron toevoegen → kiezen → onzekerheid erkennen. Veilig, maar voelt als drie schermen voor één beslissing. | V | **4** één bevestiging |
| 9 | Planning en kosten | Planning toont jaartallen en bedragen zonder samenvatting "wat is nu belangrijk". | O | **5** |
| 10 | Rapport | Abonnementstekst dwars door de inhoud; geen duidelijke "dit is af / dit mist nog". | O/E | 5 |
| 11 | Navigatie | 6 tabs (Overzicht, Gebouw, Fotoronde, Planning, Rapport, Account) + 2 zwevende icoontjes. Instellingen is dubbel bereikbaar. | E/V | **1** Start + eenvoudige weergave (Fotoronde-tab verborgen, bereikbaar via Start) |

## Ontwerpprincipes
- Beginner-first: één primaire actie per scherm, gewone taal, grote knoppen.
- Profs verliezen niets: "Eenvoudige weergave" uit (Instellingen → Weergave) toont alle tabs en technische details.
- Niets wijzigt aan berekeningen, database of RLS; nieuwe voortgangsgegevens leven alleen in de bestaande plan-blob.
- Onbekend blijft onbekend (nooit 0), handmatige waarden worden nooit stil overschreven, scanmaten blijven voorstel tot de gebruiker bevestigt.

## Stappenplan (aparte draft-PR's)
1. Startpagina + projectkeuze + eenvoudige/uitgebreide weergave
2. Begeleide wizard (gebouw → controleren → inspecteren → onderhoudsplan)
3. Vereenvoudigde Fotoronde (web + iPhone)
4. Begrijpelijke hoeveelheidscontrole en bevestiging
5. Duidelijkere planning en rapportage

## Resultaat per stap (draft-PR's, gestapeld)
| Stap | PR | Kern |
|------|----|------|
| 1 | MJOP-App #17 | Start-pagina (drie keuzes), projectkeuze met laatste activiteit en volgende stap, eenvoudige/uitgebreide weergave |
| 2 | MJOP-App #18 | Begeleide stappen: gebouw kiezen → controleren → inspecteren → onderhoudsplan |
| 3 | MJOP-App #19 + mjop-learning #60 | Eenvoudige Fotoronde (web + iPhone) in gewone taal, technische details op verzoek |
| 4 | MJOP-App #20 | "Dit is gevonden" + één bevestiging "Toevoegen aan MJOP" met verplichte erkenning |
| 5 | MJOP-App #21 | Planning "In het kort" en Rapport-checklist |

Schermafbeeldingen na de wijzigingen (375×667): `docs/ux/na/` — `start-375`, `wizard-1…4`, `fotoronde-simpel-375`, `controle-375`, `planning-375`, `rapport-375`.

## Wat nog op een echte iPhone beoordeeld moet worden
- De camera die direct opent en de duidelijkheid van de overlay-tekst in daglicht.
- Of de eerste gevel "Gevel 1" voor de gebruiker logisch is als de website er geen plande.
- Het gedrag van "Toevoegen aan MJOP" na terugkeer in de WebView (voorstellen ophalen).
