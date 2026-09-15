# MJOP Live

Een meerjarenonderhoudsplan (MJOP) voor kleine VvE's, gebouwd op echte
overheidsdata: BAG voor bouwjaar en aantal appartementen, 3D BAG voor het
werkelijke dakoppervlak, muuroppervlak en de gebouwhoogte.

Dit is een implementatie van het "MJOP Live" / "MJOP Kleine VvE" ontwerp uit
Claude Design, omgezet naar een echte, statische web-app zonder build-stap
of dependencies.

## Draaien

Er is geen build-stap nodig. Serveer de map statisch, bijvoorbeeld:

```
python3 -m http.server 8000
```

en open `http://localhost:8000`. Direct openen van `index.html` via
`file://` werkt ook, al blokkeren sommige browsers dan de adres-opzoek-fetches.

### Inloggen configureren (optioneel)

Inloggen (zie `SPEC_ACCOUNTS_AND_SAVING.md`) gebruikt Supabase, met een
eenmalige inloglink per e-mail (magic link) — geen wachtwoord. Zonder
configuratie werkt de rest van de app gewoon door — er verschijnt dan een
duidelijke melding op het "Inloggen"-tabblad. Om het aan te zetten:

1. Maak een gratis project aan op [supabase.com](https://supabase.com).
2. Zet in **Authentication → URL Configuration** de **Site URL** en voeg
   bij **Redirect URLs** het adres toe waar de app draait — voor de live
   versie `https://<gebruiker>.github.io/<repo>/`, voor lokaal draaien
   erbij `http://localhost:<poort>/index.html`. Zonder dit op de
   redirect-lijst weigert Supabase de inloglink.
3. Kopieer de **Project URL** en de **publishable/anon key** (Project
   Settings → API) naar `src/config.js`. Die sleutel is bedoeld om
   publiek te zijn; zet er nooit de *secret*/*service role*-sleutel in.
4. Zonder eigen SMTP-provider gebruikt Supabase altijd het standaard
   "Magic Link"-e-mailsjabloon (met een link, geen code) — de body
   daarvan is dan niet aan te passen. Dat is precies waarom deze app een
   link verwacht in plaats van een in te typen code.

## Hoe het werkt

1. **Adres opzoeken** (`src/app.js`, `suggestAddress` / `lookupBuilding`) —
   gebruikt de publieke, sleutelloze PDOK Locatieserver, BAG en 3D BAG
   API's om bouwjaar, appartementen, dakoppervlak, geveloppervlak en
   gebouwhoogte op te halen voor een adres. Levert de adreszoekbalk geen
   suggesties op, dan verschijnt een duidelijke melding in plaats van een
   ogenschijnlijk kapotte zoekbalk. Lukt de opzoeking niet, dan kan met
   "Begin met een voorbeeldgebouw" een demo-portiekflat (1978, 8
   appartementen) gebruikt worden. Het reservefonds is geen overheidsdata
   (dat bestaat niet) en start als richtgetal (€ 2.500 per appartement);
   het bedrag op het overzicht ("Reservefonds nu") is direct te bewerken
   naar het werkelijke saldo uit de VvE-administratie. De 3D BAG levert
   plat en hellend dakoppervlak apart aan (`b3_opp_dak_plat`/`b3_opp_dak_schuin`);
   die verdeling bepaalt welk dakelement(en) automatisch in het plan komen
   en tegen welk kengetal/cyclus, in plaats van standaard het hele
   dakvlak tegen bitumen-plat-dak-prijzen te zetten (relevant bij een
   flink deel van de vooroorlogse en jaren-50/60-panden waar de app op
   mikt).
2. **Elementenbibliotheek** (`ELEMENT_LIBRARY`) — ~20 gangbare VvE-
   onderhoudsposten (dak, gevel, kozijnen, installaties, binnen, terrein),
   elk met een NL-SfB-code (de Nederlandse coderingssystematiek voor
   bouwdelen). Een kernset staat standaard in het plan — waaronder
   schilderwerk buitenkozijnen/gevelhoutwerk, meestal een van de grootste
   posten in een MJOP en los van de kozijnen zelf begroot — de rest is
   optioneel toe te voegen via "Element toevoegen → uit bibliotheek", dat
   scherm zet veelgemiste posten (cv-installatie, mechanische ventilatie,
   brandveiligheid, verlichting gemeenschappelijke ruimten, terrein/
   verharding) vooraan onder "Vaak gemist bij een eerste MJOP".
3. **Upload een bestaand MJOP** — csv, Excel (xlsx/xls) of pdf. Csv/Excel
   worden kolom-voor-kolom herkend (element, jaar, bedrag, NL-SfB, conditie)
   met een controleerbare mapping; pdf wordt op tekst doorzocht naar
   regels met een jaartal en een bedrag. In alle gevallen volgt een
   bewerkbare regel-lijst — er gaat pas iets het plan in na bevestiging.
   xlsx-parsing gebruikt [SheetJS](https://sheetjs.com/), pdf-tekstextractie
   gebruikt [pdf.js](https://mozilla.github.io/pdf.js/), beide via CDN.
   Geïmporteerde posten worden op basis van hun NL-SfB-code (indien
   aanwezig) of trefwoorden in de omschrijving automatisch verdeeld over
   Dak/Gevel/Installaties/Binnen/Terrein in plaats van allemaal onder
   "Overig" te belanden; alleen posten die nergens op passen blijven
   "Overig". Na import kan bij elke geïmporteerde post het jaar, de cyclus
   en het bedrag alsnog worden aangepast (bijvoorbeeld zodra een offerte
   binnen is), en kunnen net als bij de bibliotheek-elementen gebreken
   worden vastgelegd.
4. **Gebreken (NEN 2767-methodiek)** — in plaats van één losse conditie-
   schuif legt elk element gebreken vast met ernst, omvang en intensiteit
   (elk 1–3); het zwaarste gebrek bepaalt de conditiescore (1–6, "uitstekend"
   t/m "zeer slecht"), die het jaar van de eerstvolgende beurt naar voren of
   naar achteren schuift. Dit is een praktische toepassing van de NEN
   2767-systematiek voor planningsdoeleinden — geen vervanging voor een
   inspectie door een gecertificeerd inspecteur, en niet gebaseerd op de
   (auteursrechtelijk beschermde) officiële NEN/SBR-defectcatalogus.
5. **Kozijnen per materiaal** — elk kozijntype (draaiend raam, vast glas,
   deur, dakkapel) krijgt een eigen materiaal (hout/aluminium/kunststof/
   staal) met een eigen onderhoudscyclus en -tarief: hout vraagt periodiek
   schilderwerk, aluminium en kunststof vooral reiniging. Rijen met
   verschillend materiaal worden apart in de tijd gezet.
6. **Kasstroom** — de 10-jaars projectie combineert de bijdrage per
   appartement met de geplande kosten per jaar, en laat zien in welk jaar
   (indien van toepassing) het reservefonds negatief wordt.
7. **Offertes** — per element kunnen offertes van meerdere aannemers
   handmatig worden ingevoerd (regel + bedrag, btw-schakelaar). Vanaf twee
   offertes verschijnt een vergelijkingstabel met rangorde; ontbrekende
   regels kunnen worden bijgevuld met het gemiddelde van de overige
   offertes voor die regel.
8. **Rapport** — samenvatting met voorstel voor de vergadering, CSV-export
   van alle elementen (inclusief NL-SfB-code en conditiescore) en een
   print-/PDF-knop (`window.print()` met een printstylesheet).

9. **Verschillend per schermformaat** — op een telefoon een app met een
   onderste tabbalk, op een tablet dezelfde kaart maar breder, en op een
   laptop/desktop een zijbalk-navigatie die de volle breedte van het
   scherm gebruikt in plaats van een smal telefoonformaat met lege
   marges ernaast.
10. **Inloggen** (`SPEC_ACCOUNTS_AND_SAVING.md`, fase 1) — een eenmalige
   inloglink per e-mail via Supabase, geen wachtwoord. Alleen in-/
   uitloggen en sessiestatus; een plan opslaan en heropenen ("mijn
   gebouwen") volgt in een latere fase. Zonder configuratie (zie
   hierboven) blijft de rest van de app volledig anoniem bruikbaar.

## Bronnen

PDOK Locatieserver en BAG (Public Domain Mark 1.0), 3D BAG van de TU Delft
(CC BY 4.0). Kengetallen zijn indicatieve richtprijzen inclusief btw, geen
offerte.

## Bekende beperkingen

- Offertes worden handmatig ingevoerd; er is geen OCR/foto-herkenning van
  offertes (dat vereist een externe dienst en is buiten scope van deze
  implementatie).
- De pdf-import van een bestaand MJOP is best-effort tekst-/regelherkenning
  op basis van jaartal + bedrag per regel — geen lay-outanalyse. Werkt goed
  voor eenvoudige tabellen, minder goed voor complexe pdf-opmaak; controleer
  daarom altijd de regel-lijst voor het importeren. Een regel met
  "onvoorzien" in de omschrijving (een reserveringspost, geen onderhouds-
  element) wordt bij csv/Excel/pdf-import automatisch overgeslagen.
- De NEN 2767-gebrekenmethodiek in de app is een vereenvoudigde, zelf
  geïmplementeerde toepassing van de systematiek (ernst/omvang/intensiteit
  → conditiescore), niet de officiële NEN/SBR-defectcatalogus en geen
  vervanging voor een inspectie door een gecertificeerd inspecteur.
- In sommige sandboxed omgevingen met een uitgaand netwerkbeleid kunnen de
  PDOK/BAG/3D BAG-aanroepen en de CDN's voor xlsx/pdf-parsing geblokkeerd
  zijn; in een gewone browser op het publieke internet werken deze
  aanroepen rechtstreeks.
