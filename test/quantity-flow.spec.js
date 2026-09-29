'use strict';
// End-to-end: Quantity Foundation v1 — plat dak.
//
//   adres -> 3D BAG -> voorgestelde hoeveelheid -> bevestigen -> aanpassen
//   -> (meer appartementen: aanpassing blijft staan) -> terug naar automatisch
//   -> kostenberekening, plus: afgewezen onduidelijke invoer, herladen,
//   migratie van een oud opgeslagen plan en hoeveelheid bij MJOP-import.
//
// De PDOK-, BAG- en 3D BAG-API's worden met page.route() nagebootst (vaste
// antwoorden), zodat de test niet van het netwerk afhangt.
//
// Uitvoeren (vanuit de projectroot):
//   1. python3 -m http.server 8937
//   2. node test/quantity-flow.spec.js

let chromium;
try {
  chromium = require('playwright').chromium;
} catch (e) {
  chromium = require('/opt/node22/lib/node_modules/playwright').chromium;
}

var APP_URL = process.env.MJOP_TEST_URL || 'http://localhost:8937/index.html';
var CHROMIUM_PATH = process.env.MJOP_CHROMIUM || '/opt/pw-browsers/chromium';

var PAND_ID = '0363100012345678';
var LON = 4.9, LAT = 52.37, D = 0.0001;

async function mockApis(page) {
  await page.route('**/locatieserver/search/v3_1/suggest**', function (route) {
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ response: { docs: [{ id: 'adr-1', weergavenaam: 'Teststraat 1, 1000AA Amsterdam' }] } }) });
  });
  await page.route('**/locatieserver/search/v3_1/lookup**', function (route) {
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ response: { docs: [{ weergavenaam: 'Teststraat 1, 1000AA Amsterdam', centroide_ll: 'POINT(' + LON + ' ' + LAT + ')' }] } }) });
  });
  await page.route('**/kadaster/bag/ogc/v2/collections/pand/items**', function (route) {
    var ring = [[LON - D, LAT - D], [LON + D, LAT - D], [LON + D, LAT + D], [LON - D, LAT + D], [LON - D, LAT - D]];
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ features: [{
      geometry: { type: 'Polygon', coordinates: [ring] },
      properties: { identificatie: PAND_ID, bouwjaar: 1972, gebruiksdoel: 'woonfunctie', aantal_verblijfsobjecten: 12 },
    }] }) });
  });
  await page.route('**/api.3dbag.nl/**', function (route) {
    var co = {};
    co['NL.IMBAG.Pand.' + PAND_ID] = { attributes: {
      b3_opp_dak_plat: 312.64, b3_opp_dak_schuin: 0, b3_opp_buitenmuur: 1099.7, b3_opp_grond: 318.2,
      b3_bouwlagen: 4, b3_dak_type: 'horizontal', b3_h_dak_max: 13.4, b3_h_maaiveld: 0.6,
    } };
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ feature: { CityObjects: co } }) });
  });
}

async function paneel(page) {
  return page.evaluate(function () {
    var p = document.querySelector('.qty-panel');
    var f = document.querySelector('[data-qty-formula]');
    var fout = document.querySelector('.qty-fout');
    return {
      status: p && p.dataset.qtyStatus,
      source: p && p.dataset.qtySource,
      sourceLabel: (document.querySelector('[data-qty-source-label]') || {}).textContent,
      value: (document.querySelector('#hv-dak-plat') || {}).value,
      formula: f && f.textContent.trim(),
      fout: fout && fout.textContent.trim(),
      bronDetails: (document.querySelector('.qty-bron') || {}).textContent || '',
    };
  });
}

async function zetHoeveelheid(page, tekst) {
  await page.fill('#hv-dak-plat', tekst);
  await page.press('#hv-dak-plat', 'Tab');
  await page.waitForTimeout(100);
}

async function openDakPlat(page) {
  await page.click('[data-act=set-tab][data-tab=gebouw]');
  await page.waitForTimeout(100);
  await page.click('.gb-row[data-act=open-element][data-id=dak-plat]');
  await page.waitForTimeout(100);
}

async function main() {
  var browser = await chromium.launch({ executablePath: CHROMIUM_PATH });
  var context = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  var page = await context.newPage();
  var errors = [];
  page.on('pageerror', function (e) { errors.push(String(e)); });
  await mockApis(page);
  var checks = [];
  function check(naam, ok, info) { checks.push([naam + (info ? ' (' + info + ')' : ''), !!ok]); }

  // --- adres -> 3D BAG ----------------------------------------------------
  await page.goto(APP_URL);
  await page.waitForTimeout(150);
  await page.click('[data-act=goto-onboarding]').catch(function () {});
  await page.waitForTimeout(150);
  await page.fill('#addr-search', 'Teststraat 1');
  await page.waitForSelector('.suggest-row', { timeout: 5000 });
  await page.click('.suggest-row');
  await page.waitForSelector('[data-act=set-tab][data-tab=gebouw]', { timeout: 8000 });
  await openDakPlat(page);

  var p = await paneel(page);
  check('Voorstel uit 3D BAG: 312,64 m²', p.value === '312,64', p.value);
  check('Bron = 3D_BAG, label "3D BAG"', p.source === '3D_BAG' && p.sourceLabel === '3D BAG', p.source + ' / ' + p.sourceLabel);
  check('Status = PROPOSED', p.status === 'PROPOSED', p.status);
  check('Ruwe bronwaarde zichtbaar (b3_opp_dak_plat = 312.64, pand-id)', p.bronDetails.indexOf('b3_opp_dak_plat') > -1 && p.bronDetails.indexOf('312.64') > -1 && p.bronDetails.indexOf(PAND_ID) > -1);
  check('Kosten: 312,64 × € 165 = € 51.586', p.formula.indexOf('€ 51.586') > -1, p.formula);

  // --- bevestigen ---------------------------------------------------------
  await page.click('[data-act=qty-confirm][data-id=dak-plat]');
  await page.waitForTimeout(100);
  p = await paneel(page);
  check('Na bevestigen: status CONFIRMED, waarde 312,64', p.status === 'CONFIRMED' && p.value === '312,64', p.status);

  // --- onduidelijke invoer wordt geweigerd ---------------------------------
  await zetHoeveelheid(page, '1.250');
  p = await paneel(page);
  check('"1.250" wordt geweigerd met melding, hoeveelheid ongewijzigd', !!p.fout && p.status === 'CONFIRMED' && p.formula.indexOf('€ 51.586') > -1, p.fout);

  // --- aanpassen met decimaal ----------------------------------------------
  await zetHoeveelheid(page, '305,5');
  p = await paneel(page);
  check('"305,5" wordt 305,5 (niet 3055)', p.value === '305,5', p.value);
  check('Na aanpassen: status USER_OVERRIDDEN, bron MANUAL', p.status === 'USER_OVERRIDDEN' && p.source === 'MANUAL', p.status + ' / ' + p.source);
  check('Kosten: 305,5 × € 165 = € 50.408', p.formula.indexOf('€ 50.408') > -1, p.formula);

  // --- ander aantal appartementen: aanpassing blijft staan -------------------
  await page.click('[data-act=set-tab][data-tab=gebouw]');
  await page.waitForTimeout(100);
  await page.fill('#building-units', '14');
  await page.dispatchEvent('#building-units', 'input');
  await page.waitForTimeout(100);
  await page.click('.gb-row[data-act=open-element][data-id=dak-plat]');
  await page.waitForTimeout(100);
  p = await paneel(page);
  check('Na wijzigen aantal appartementen blijft 305,5 staan', p.value === '305,5' && p.status === 'USER_OVERRIDDEN', p.value);

  // --- herladen (werksessie) -------------------------------------------------
  await page.reload();
  await page.waitForTimeout(300);
  await openDakPlat(page);
  p = await paneel(page);
  check('Na herladen: 305,5 en USER_OVERRIDDEN bewaard', p.value === '305,5' && p.status === 'USER_OVERRIDDEN', p.value + ' / ' + p.status);

  // --- terug naar automatisch ------------------------------------------------
  await page.click('[data-act=qty-reset][data-id=dak-plat]');
  await page.waitForTimeout(100);
  p = await paneel(page);
  check('Na reset: 312,64, status PROPOSED, bron 3D_BAG', p.value === '312,64' && p.status === 'PROPOSED' && p.source === '3D_BAG', p.value + ' / ' + p.status);
  check('Kosten na reset weer € 51.586', p.formula.indexOf('€ 51.586') > -1, p.formula);

  var hist = await page.evaluate(function () {
    var ws = JSON.parse(sessionStorage.getItem('mjop-worksessie'));
    var el = ws.plan.elements.filter(function (e) { return e.id === 'dak-plat'; })[0];
    return { events: el.quantity.history.map(function (h) { return h.event; }), heeftOudVeld: 'hoeveelheid' in el, raw: ws.plan.building.d3raw };
  });
  check('Historie compleet (PROPOSED, CONFIRMED, USER_OVERRIDDEN, RESET_TO_AUTO)',
    ['PROPOSED', 'CONFIRMED', 'USER_OVERRIDDEN', 'RESET_TO_AUTO'].every(function (e) { return hist.events.indexOf(e) > -1; }), hist.events.join(','));
  check('Opgeslagen plan heeft geen los kaal hoeveelheid-veld meer', !hist.heeftOudVeld);
  check('Ruwe 3D BAG-attributen in het plan bewaard', hist.raw && hist.raw.attributes.b3_opp_dak_plat === 312.64);

  // --- label: schatting vs. 3D BAG --------------------------------------------
  await page.click('[data-act=set-tab][data-tab=gebouw]');
  await page.waitForTimeout(100);
  await page.click('.gb-row[data-act=open-element][data-id=kozijnen-onderhoud]');
  await page.waitForTimeout(100);
  var kozLabel = await page.$eval('.origin-tag', function (el) { return el.textContent.trim(); });
  check('Kozijnen gelabeld als "Schatting" (niet "BAG")', kozLabel === 'Schatting', kozLabel);

  // --- pdf-import: hoeveelheid + eenheid uit een jarenplanregel -------------------
  var pdfRegels = await page.evaluate(function () {
    return window.MJOPInternals.extractPdfRegels('2110 Dakbedekking bitumen vervangen 312,60 m2 2029 25 45.000\nHemelwaterafvoer pvc 1.250,00 m1 2030 4.200\n');
  });
  check('Pdf-regel: "312,60 m2" bewaard', pdfRegels[0] && pdfRegels[0].hoeveelheid === '312,60' && pdfRegels[0].eenheid === 'm2' && pdfRegels[0].jaar === 2029 && pdfRegels[0].cyclus === 25, JSON.stringify(pdfRegels[0]));
  check('Pdf-regel: "1.250,00 m1" bewaard (jaar 2030)', pdfRegels[1] && pdfRegels[1].hoeveelheid === '1.250,00' && pdfRegels[1].eenheid === 'm1' && pdfRegels[1].jaar === 2030, JSON.stringify(pdfRegels[1]));

  // --- migratie van een oud opgeslagen plan -----------------------------------
  var legacyPage = await context.newPage();
  legacyPage.on('pageerror', function (e) { errors.push(String(e)); });
  await legacyPage.goto(APP_URL);
  await legacyPage.evaluate(function () {
    var building = { adres: 'Oud plan', bouwjaar: 1980, units: 8, unitsBron: 8, dakM2: 141, gevelM2: 540, werkhoogte: 9, opp: 140, omtrek: 60,
      identificatie: '0363100099999999', gebruiksdoel: 'woonfunctie', d3: { dak: 141, plat: 100, schuin: 40, gevel: 540, grond: 140, lagen: 3, daktype: 'slanted', hoogte: 9 } };
    var plan = { building: building, fonds: 10000, bijdrage: 60, invul: { fonds: true, bijdrage: true }, offertes: {}, bijvullen: {}, elements: [
      { id: 'dak-plat', naam: 'Dakbedekking plat dak', categorie: 'Dak', sfb: '27.1', type: 'dak', cyclus: 25, bron: 'dakPlatM2', laatsteBeurt: 1980, gebreken: [], hoeveelheid: 100, kengetal: 165 },
      { id: 'gevel-metselwerk', naam: 'Gevelreiniging en metselwerkherstel', categorie: 'Gevel', sfb: '21.1', type: 'gevel', cyclus: 15, bron: 'gevelM2', laatsteBeurt: 1980, gebreken: [], hoeveelheid: 3126, kengetal: 26 },
      { id: 'kozijnen-onderhoud', naam: 'Onderhoud buitenkozijnen', categorie: 'Gevel', sfb: '31.1', type: 'kozijnen', cyclus: 6, laatsteBeurt: 1980, gebreken: [],
        koz: [{ naam: 'Draaiend raam', tarief: 174, aantal: 8, eigenTarief: null, materiaal: 'hout' }, { naam: 'Vast glas', tarief: 96, aantal: 5, eigenTarief: null, materiaal: 'hout' },
          { naam: 'Deur', tarief: 240, aantal: 1, eigenTarief: null, materiaal: 'hout' }, { naam: 'Dakkapel', tarief: 320, aantal: 1, eigenTarief: null, materiaal: 'hout' }] },
    ] };
    sessionStorage.setItem('mjop-worksessie', JSON.stringify({ screen: 'app', tab: 'gebouw', plan: plan }));
  });
  await legacyPage.reload();
  await legacyPage.waitForTimeout(300);
  var mig = await legacyPage.evaluate(function () {
    var ws = JSON.parse(sessionStorage.getItem('mjop-worksessie'));
    var by = {}; ws.plan.elements.forEach(function (e) { by[e.id] = e; });
    return {
      dak: by['dak-plat'].quantity && { v: by['dak-plat'].quantity.value, s: by['dak-plat'].quantity.status },
      gevel: by['gevel-metselwerk'].quantity && { v: by['gevel-metselwerk'].quantity.value, s: by['gevel-metselwerk'].quantity.status },
      koz: by['kozijnen-onderhoud'].koz.map(function (k) { return k.quantity && k.quantity.value + ':' + k.quantity.status; }),
    };
  });
  check('Oud plan: onveranderde dakwaarde 100 -> PROPOSED', mig.dak && mig.dak.v === 100 && mig.dak.s === 'PROPOSED', JSON.stringify(mig.dak));
  check('Oud plan: afwijkende gevelwaarde 3126 blijft staan als USER_OVERRIDDEN', mig.gevel && mig.gevel.v === 3126 && mig.gevel.s === 'USER_OVERRIDDEN', JSON.stringify(mig.gevel));
  check('Oud plan: kozijnaantallen behouden (afwijkend vast glas 5 = handmatig)', mig.koz.join(',') === '8:PROPOSED,5:USER_OVERRIDDEN,1:PROPOSED,1:PROPOSED', mig.koz.join(','));
  await legacyPage.close();

  // --- MJOP-import (csv): hoeveelheid + eenheid blijven bewaard ------------------
  var importPage = await context.newPage();
  importPage.on('pageerror', function (e) { errors.push(String(e)); });
  await importPage.goto(APP_URL);
  await importPage.evaluate(function () { sessionStorage.clear(); });
  await importPage.reload();
  await importPage.waitForTimeout(150);
  await importPage.click('[data-act=goto-onboarding]').catch(function () {});
  await importPage.waitForTimeout(150);
  var csv = 'Element;Jaar;Bedrag;Hoeveelheid;Eenheid\nDakbedekking bitumen vervangen;2029;45000;312,6;m2\nHemelwaterafvoer pvc;2030;4200;84;m1\n';
  await importPage.setInputFiles('#mjop-file-input', { name: 'oud-mjop.csv', mimeType: 'text/csv', buffer: Buffer.from(csv, 'utf8') });
  await importPage.waitForSelector('[data-act=upload-confirm-mapping]', { timeout: 5000 });
  await importPage.click('[data-act=upload-confirm-mapping]');
  await importPage.waitForTimeout(100);
  var regelHvh = await importPage.$eval('#upload-regel-hoeveelheid-0', function (el) { return el.value; });
  check('Import: hoeveelheid-kolom herkend ("312,6")', regelHvh === '312,6', regelHvh);
  await importPage.click('[data-act=mjop-import-confirm]');
  await importPage.waitForTimeout(200);
  var imp = await importPage.evaluate(function () {
    var ws = JSON.parse(sessionStorage.getItem('mjop-worksessie'));
    return ws.plan.elements.filter(function (e) { return e.type === 'custom'; }).map(function (e) {
      return { naam: e.naam, v: e.quantity && e.quantity.value, u: e.quantity && e.quantity.unit, s: e.quantity && e.quantity.source, raw: e.quantity && e.quantity.auto.raw.value };
    });
  });
  var dakImp = imp.filter(function (e) { return /Dakbedekking/.test(e.naam); })[0] || {};
  var hwaImp = imp.filter(function (e) { return /Hemelwater/.test(e.naam); })[0] || {};
  check('Import: 312,6 m² bewaard als IMPORTED_MJOP (letterlijk "312,6 m2")', dakImp.v === 312.6 && dakImp.u === 'm2' && dakImp.s === 'IMPORTED_MJOP' && dakImp.raw === '312,6 m2', JSON.stringify(dakImp));
  check('Import: 84 m1 bewaard', hwaImp.v === 84 && hwaImp.u === 'm1', JSON.stringify(hwaImp));
  await importPage.close();

  check('Geen JavaScript-fouten tijdens het testen', errors.length === 0, errors.join(' | '));
  await browser.close();

  var fail = 0;
  checks.forEach(function (c) {
    console.log((c[1] ? 'OK  ' : 'FAIL') + ' - ' + c[0]);
    if (!c[1]) fail++;
  });
  if (fail) { console.log(fail + ' controle(s) mislukt.'); process.exitCode = 1; return; }
  console.log('Alle controles geslaagd.');
}

main().catch(function (e) { console.error(e); process.exitCode = 1; });
