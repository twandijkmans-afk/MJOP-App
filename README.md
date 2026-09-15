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

## Hoe het werkt

1. **Adres opzoeken** (`src/app.js`, `suggestAddress` / `lookupBuilding`) —
   gebruikt de publieke, sleutelloze PDOK Locatieserver, BAG en 3D BAG
   API's om bouwjaar, appartementen, dakoppervlak, geveloppervlak en
   gebouwhoogte op te halen voor een adres. Lukt de opzoeking niet, dan kan
   met "Begin met een voorbeeldgebouw" een demo-portiekflat (1978, 8
   appartementen) gebruikt worden.
2. **Elementen** — dak, kozijnen/buitenschilderwerk, gevel, steiger/hoogwerker,
   intercom, trappenhuis, riolering en dakinspectie krijgen elk een cyclus,
   een kengetal en (optioneel) een conditiescore 1–5. Onbeoordeeld valt de
   planning terug op de standaardcyclus vanaf het bouwjaar; een conditiescore
   schuift het jaar van de eerstvolgende beurt naar voren of naar achteren.
3. **Kasstroom** — de 10-jaars projectie combineert de bijdrage per
   appartement met de geplande kosten per jaar, en laat zien in welk jaar
   (indien van toepassing) het reservefonds negatief wordt.
4. **Offertes** — per element kunnen offertes van meerdere aannemers
   handmatig worden ingevoerd (regel + bedrag, btw-schakelaar). Vanaf twee
   offertes verschijnt een vergelijkingstabel met rangorde; ontbrekende
   regels kunnen worden bijgevuld met het gemiddelde van de overige
   offertes voor die regel.
5. **Rapport** — samenvatting met voorstel voor de vergadering, CSV-export
   van alle elementen en een print-/PDF-knop (`window.print()` met een
   printstylesheet).

## Bronnen

PDOK Locatieserver en BAG (Public Domain Mark 1.0), 3D BAG van de TU Delft
(CC BY 4.0). Kengetallen zijn indicatieve richtprijzen inclusief btw, geen
offerte.

## Bekende beperkingen

- Offertes worden handmatig ingevoerd; er is geen OCR/foto-herkenning van
  offertes (dat vereist een externe dienst en is buiten scope van deze
  implementatie).
- In sommige sandboxed omgevingen met een uitgaand netwerkbeleid kunnen de
  PDOK/BAG/3D BAG-aanroepen geblokkeerd zijn; in een gewone browser op het
  publieke internet werken deze aanroepen rechtstreeks.
