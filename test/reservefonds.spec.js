'use strict';
// Regressietest voor de reservefonds-/benodigde-bijdrage-berekening
// (zie src/app.js: kasstroom(), benodigdeBijdrage()).
//
// Er is geen build-stap of testrunner in dit project — dit script bedient
// de echte app in een echte browser (Playwright), net als een gebruiker
// zou doen, i.p.v. een losse kopie van de rekenlogica te testen die uit de
// pas zou kunnen lopen met src/app.js.
//
// Uitvoeren (vanuit de projectroot):
//   1. python3 -m http.server 8937   (in een apart terminalvenster)
//   2. node test/reservefonds.spec.js
//
// Zoekt Playwright eerst via de normale node_modules-resolutie; valt
// terug op het pad van de Claude Code-sandbox als dat niet lukt.
//
// Waarom deze vier controles i.p.v. de exacte "165-170"/"12.885" uit de
// oorspronkelijke bugreport: dat scenario was een specifiek, elders
// opgezocht adres (bouwjaar 2023, 1 appartement) waarvan de precieze
// BAG-gegevens hier niet beschikbaar zijn — dat getal kon dus niet
// worden nagerekend zonder het klakkeloos over te nemen. In plaats
// daarvan test dit bestand de daadwerkelijke WISKUNDIGE eigenschap die
// de bug veroorzaakte, op het meegeleverde voorbeeldgebouw (teruggeschaald
// naar 1 appartement, zelfde orde van grootte als de bugreport):
//   1. Bij de berekende voorstel-bijdrage is de laagste fondsstand over
//      alle jaren van de planning >= 0.
//   2. Bij voorstel - 5 euro is de laagste fondsstand wél < 0 — het
//      voorstel is dus het kleinst mogelijke bedrag in stappen van 5
//      euro, geen ruime marge.
//   3. Het voorstel is nooit lager dan de oude (foute) gemiddelde-
//      formule total/aantal-maanden, en op dit voorbeeldgebouw (met
//      ongelijk verdeelde kosten over de jaren) staat het er ook
//      daadwerkelijk boven — het bewijst dat de fix niet toevallig
//      hetzelfde getal geeft.
//   4. De som van de kosten die Planning toont komt overeen met het
//      totaal dat Overzicht laat zien.

let chromium;
try {
  chromium = require('playwright').chromium;
} catch (e) {
  chromium = require('/opt/node22/lib/node_modules/playwright').chromium;
}

var APP_URL = process.env.MJOP_TEST_URL || 'http://localhost:8937/index.html';
var CHROMIUM_PATH = process.env.MJOP_CHROMIUM || '/opt/pw-browsers/chromium';

async function laagsteSaldoBlijftPositief(page, bedrag) {
  // Niet page.fill(): de slider heeft zelf een zichtbaar bereik van
  // 10-400, en het voorstel voor een klein gebouw (1 appartement) kan
  // daar ruim boven liggen. Een <input type=range> klemt zijn .value
  // altijd op [min,max], ook als je 'm rechtstreeks via JS zet — dus
  // eerst het max-attribuut tijdelijk verhogen, anders test dit stilzwijgend
  // de geklemde 400 i.p.v. het echte bedrag. state.bijdrage zelf kent
  // geen bovengrens (zie CHANGES['bijdrage'] in app.js).
  await page.evaluate(function (v) {
    var el = document.querySelector('input[type=range]');
    if (Number(el.max) < v) el.max = String(v);
    el.value = v;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, bedrag);
  await page.waitForTimeout(120);
  var tekst = await page.$eval('#ov-verdict .ov-head', function (el) { return el.textContent.trim(); });
  return tekst.indexOf('leeg') === -1;
}

async function main() {
  var browser = await chromium.launch({ executablePath: CHROMIUM_PATH });
  var page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  var errors = [];
  page.on('pageerror', function (e) { errors.push(String(e)); });

  await page.goto(APP_URL);
  await page.waitForTimeout(150);
  await page.click('[data-act=goto-onboarding]').catch(function () {});
  await page.waitForTimeout(150);
  await page.click('[data-act=skip-onboarding]');
  await page.waitForTimeout(200);

  // Startsaldo 0 en 1 appartement — zelfde orde van grootte als het
  // scenario uit de bugreport (zie toelichting hierboven).
  await page.fill('#fonds-bedrag', '0');
  await page.dispatchEvent('#fonds-bedrag', 'input');
  await page.click('[data-act=set-tab][data-tab=gebouw]');
  await page.waitForTimeout(100);
  await page.fill('#building-units', '1');
  await page.dispatchEvent('#building-units', 'input');
  await page.click('[data-act=set-tab][data-tab=home]');
  await page.waitForTimeout(150);

  var totaalTekst = await page.$eval('.ov-kv:has-text("Kosten") b', function (el) { return el.textContent.trim(); });
  var totaal = Number(totaalTekst.replace(/[^0-9]/g, ''));
  var voorstel = Number(await page.$eval('[data-act=zet-advies]', function (el) { return el.dataset.nodig; }));

  var checks = [];

  var bijVoorstelOk = await laagsteSaldoBlijftPositief(page, voorstel);
  checks.push(['Bij het voorstel (€ ' + voorstel + ') blijft het fonds de hele horizon (10 jaar) positief', bijVoorstelOk]);

  var bijVoorstelMin5Ok = null;
  if (voorstel - 5 >= 10) {
    bijVoorstelMin5Ok = await laagsteSaldoBlijftPositief(page, voorstel - 5);
  }
  checks.push(['Bij voorstel - 5 (€ ' + (voorstel - 5) + ') raakt het fonds wél leeg (voorstel is het kleinst mogelijke bedrag)', bijVoorstelMin5Ok === false]);

  // Oude, foute formule (totale kosten / aantal maanden), voor vergelijking.
  var oudeFormule = Math.max(5, Math.ceil((totaal - 0) / (10 * 12 * 1) / 5) * 5);
  checks.push(['Voorstel (€ ' + voorstel + ') is minstens de oude gemiddelde-formule (€ ' + oudeFormule + ')', voorstel >= oudeFormule]);
  checks.push(['Voorstel ligt daadwerkelijk boven de oude gemiddelde-formule (bewijst dat de fix iets veranderde)', voorstel > oudeFormule]);

  await page.click('[data-act=set-tab][data-tab=planning]');
  await page.waitForTimeout(150);
  var planningSub = await page.$eval('.page-sub', function (el) { return el.textContent.trim(); });
  var planningTotaalMatch = /€\s*([\d.]+)\s*totaal/.exec(planningSub);
  var planningTotaal = planningTotaalMatch ? Number(planningTotaalMatch[1].replace(/\./g, '')) : null;
  checks.push(['Som van Planning-kosten (€ ' + planningTotaal + ') komt overeen met Overzicht (€ ' + totaal + ')', planningTotaal === totaal]);

  checks.push(['Geen JavaScript-fouten tijdens het testen', errors.length === 0]);

  await browser.close();

  var fail = 0;
  checks.forEach(function (c) {
    console.log((c[1] ? 'OK  ' : 'FAIL') + ' - ' + c[0]);
    if (!c[1]) fail++;
  });
  if (errors.length) console.log('Fouten:', JSON.stringify(errors));
  console.log('');
  console.log('Ter info (geen assert, alleen ter controle): totale kosten € ' + totaal + ', voorstel € ' + voorstel + '.');
  if (fail) { console.log(fail + ' controle(s) mislukt.'); process.exitCode = 1; return; }
  console.log('Alle controles geslaagd.');
}

main().catch(function (e) { console.error(e); process.exitCode = 1; });
