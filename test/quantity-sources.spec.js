'use strict';
// End-to-end: meerdere hoeveelheidsbronnen (Quantity sources v1) + offertebedragen.
//
//   adres -> 3D BAG (automatisch) -> bundel uit mjop-learning importeren (historisch MJOP + 3D BAG)
//   -> bronnen naast elkaar met verschil -> "Gebruik deze bron" (historisch) -> kosten
//   -> herladen (keuze blijft) -> zelf aanpassen (andere bronnen blijven) -> andere bron kiezen
//   -> terug naar automatisch; plus: dezelfde bundel opnieuw (niets overschreven), bundel van een
//   ander pand (geweigerd), een plan met v1-hoeveelheden (laadt), offertebedragen met decimalen.
//
// test/fixtures/quantity-bundle.test.json is SYNTHETISCHE testdata, gemaakt met de echte
// mjop-learning-export (scripts/export_app_quantity_bundle.py) op zelfgemaakte API-antwoorden.
//
//   python3 -m http.server 8937 &   ;   node test/quantity-sources.spec.js

let chromium;
try {
  chromium = require('playwright').chromium;
} catch (e) {
  chromium = require('/opt/node22/lib/node_modules/playwright').chromium;
}
var fs = require('fs');
var path = require('path');

var APP_URL = process.env.MJOP_TEST_URL || 'http://localhost:8937/index.html';
var CHROMIUM_PATH = process.env.MJOP_CHROMIUM || '/opt/pw-browsers/chromium';
var BUNDLE = fs.readFileSync(path.join(__dirname, 'fixtures', 'quantity-bundle.test.json'), 'utf8');
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
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ features: [{ geometry: { type: 'Polygon', coordinates: [ring] },
      properties: { identificatie: PAND_ID, bouwjaar: 1972, gebruiksdoel: 'woonfunctie', aantal_verblijfsobjecten: 12 } }] }) });
  });
  await page.route('**/api.3dbag.nl/**', function (route) {
    var co = {};
    co['NL.IMBAG.Pand.' + PAND_ID] = { attributes: { b3_opp_dak_plat: 312.64, b3_opp_dak_schuin: 0, b3_opp_buitenmuur: 1099.7,
      b3_opp_grond: 318.2, b3_bouwlagen: 4, b3_dak_type: 'horizontal', b3_h_dak_max: 13.4, b3_h_maaiveld: 0.6 } };
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ feature: { CityObjects: co } }) });
  });
}

async function panel(page) {
  return page.evaluate(function () {
    var p = document.querySelector('.qty-panel');
    var rows = Array.prototype.map.call(document.querySelectorAll('[data-qty-source-row]'), function (r) {
      return { id: r.dataset.qtySourceRow, source: r.dataset.source, effective: r.classList.contains('is-effective'),
        value: (r.querySelector('[data-qty-source-value]') || {}).textContent, diff: (r.querySelector('[data-qty-source-diff]') || {}).textContent || '',
        detail: (r.querySelector('[data-qty-source-detail]') || {}).textContent || '' };
    });
    return { status: p && p.dataset.qtyStatus, source: p && p.dataset.qtySource,
      formula: (document.querySelector('[data-qty-formula]') || {}).textContent || '', rows: rows };
  });
}

async function openDakPlat(page) {
  await page.click('[data-act=set-tab][data-tab=gebouw]');
  await page.waitForTimeout(100);
  await page.click('.gb-row[data-act=open-element][data-id=dak-plat]');
  await page.waitForTimeout(100);
}

async function uploadBundle(page, text, name) {
  await page.click('[data-act=set-tab][data-tab=gebouw]');
  await page.waitForTimeout(100);
  await page.setInputFiles('#qty-bundle-input', { name: name || 'bundle.json', mimeType: 'application/json', buffer: Buffer.from(text, 'utf8') });
  await page.waitForTimeout(250);
  return page.evaluate(function () {
    return { melding: (document.querySelector('[data-bundle-melding]') || {}).textContent || '', fout: (document.querySelector('[data-bundle-fout]') || {}).textContent || '' };
  });
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

  await page.goto(APP_URL);
  await page.waitForTimeout(150);
  await page.click('[data-act=goto-onboarding]').catch(function () {});
  await page.waitForTimeout(150);
  await page.fill('#addr-search', 'Teststraat 1');
  await page.waitForSelector('.suggest-row', { timeout: 5000 });
  await page.click('.suggest-row');
  await page.waitForSelector('[data-act=set-tab][data-tab=gebouw]', { timeout: 8000 });

  // --- bundel importeren -------------------------------------------------------
  var up = await uploadBundle(page, BUNDLE);
  check('Bundel: 2 bronnen toegevoegd', /^2 bronnen toegevoegd/.test(up.melding), up.melding || up.fout);

  await openDakPlat(page);
  var p = await panel(page);
  var hist = p.rows.filter(function (r) { return r.source === 'IMPORTED_MJOP'; })[0] || {};
  var auto = p.rows.filter(function (r) { return r.id === 'auto'; })[0] || {};
  var bag2 = p.rows.filter(function (r) { return r.source === '3D_BAG' && r.id !== 'auto'; })[0] || {};
  check('Drie bronnen zichtbaar (automatisch 3D BAG, historisch MJOP, 3D BAG via mjop-learning)', p.rows.length === 3, JSON.stringify(p.rows.map(function (r) { return r.id; })));
  check('Automatisch 3D BAG 312,64 m² is de gekozen hoeveelheid (PROPOSED)', auto.effective && /312,64/.test(auto.value) && p.status === 'PROPOSED', auto.value + ' / ' + p.status);
  check('Historisch MJOP 308 m² met document en afhankelijkheid', /308/.test(hist.value) && /DOC-005/.test(hist.detail) && /geen onafhankelijke bevestiging/.test(hist.detail), hist.detail);
  check('Verschil historisch t.o.v. gekozen: -4,64 m² (-1,5%)', /-4,64/.test(hist.diff) && /-1,5%/.test(hist.diff), hist.diff);
  check('Kosten nog 312,64 × € 165 = € 51.586', /€ 51\.586/.test(p.formula), p.formula);

  // --- historische bron kiezen ------------------------------------------------------
  await page.click('[data-act=qty-select][data-ev="' + hist.id + '"]');
  await page.waitForTimeout(100);
  p = await panel(page);
  check('Na "Gebruik deze bron": status CONFIRMED, bron IMPORTED_MJOP', p.status === 'CONFIRMED' && p.source === 'IMPORTED_MJOP', p.status + ' / ' + p.source);
  check('Gekozen bron stuurt de kosten: 308 × € 165 = € 50.820', /308 m² × € 165 = € 50\.820/.test(p.formula), p.formula);
  check('3D BAG blijft als bron staan met zijn eigen waarde (niet overschreven)', p.rows.some(function (r) { return r.id === 'auto' && /312,64/.test(r.value) && !r.effective; }));

  // --- herladen --------------------------------------------------------------------
  await page.reload();
  await page.waitForTimeout(300);
  await openDakPlat(page);
  p = await panel(page);
  check('Na herladen blijft de keuze staan (IMPORTED_MJOP, € 50.820)', p.source === 'IMPORTED_MJOP' && /€ 50\.820/.test(p.formula), p.source);

  // --- zelf aanpassen ------------------------------------------------------------------
  await page.fill('#hv-dak-plat', '311');
  await page.press('#hv-dak-plat', 'Tab');
  await page.waitForTimeout(100);
  p = await panel(page);
  check('Zelf aanpassen: USER_OVERRIDDEN, 311 × € 165 = € 51.315', p.status === 'USER_OVERRIDDEN' && /€ 51\.315/.test(p.formula), p.formula);
  check('Andere bronnen blijven staan (historisch 308, 3D BAG 312,64)', p.rows.some(function (r) { return r.source === 'IMPORTED_MJOP' && /308/.test(r.value); }) &&
    p.rows.some(function (r) { return r.id === 'auto' && /312,64/.test(r.value); }));

  // --- andere bron kiezen: handmatige waarde blijft als bron ------------------------------
  await page.click('[data-act=qty-select][data-ev="' + bag2.id + '"]');
  await page.waitForTimeout(100);
  p = await panel(page);
  check('3D BAG (mjop-learning) gekozen: € 51.586', p.source === '3D_BAG' && p.status === 'CONFIRMED' && /€ 51\.586/.test(p.formula), p.formula);
  check('Eerdere handmatige waarde 311 staat nog als bron', p.rows.some(function (r) { return r.source === 'MANUAL' && /311/.test(r.value) && !r.effective; }));

  // --- terug naar automatisch ---------------------------------------------------------
  await page.click('.qty-actions [data-act=qty-reset][data-id=dak-plat]');
  await page.waitForTimeout(100);
  p = await panel(page);
  check('Reset: automatisch 3D BAG, PROPOSED, € 51.586', p.status === 'PROPOSED' && p.rows.some(function (r) { return r.id === 'auto' && r.effective; }) && /€ 51\.586/.test(p.formula), p.status);
  check('Na reset zijn alle bronnen er nog (4 rijen)', p.rows.length === 4, String(p.rows.length));

  // --- dezelfde bundel opnieuw / ander pand ----------------------------------------------
  up = await uploadBundle(page, BUNDLE);
  check('Zelfde bundel opnieuw: niets toegevoegd, 2 al aanwezig', /^0 bronnen toegevoegd, 2 al aanwezig/.test(up.melding), up.melding);
  var ander = JSON.parse(BUNDLE); ander.bag_pand_ids = ['0363100099999999']; ander.building_id = 'BAG:0363100099999999';
  up = await uploadBundle(page, JSON.stringify(ander));
  check('Bundel van een ander pand wordt geweigerd', /hoort bij pand 0363100099999999/.test(up.fout), up.fout);

  var hist2 = await page.evaluate(function () {
    var ws = JSON.parse(sessionStorage.getItem('mjop-worksessie'));
    var el = ws.plan.elements.filter(function (e) { return e.id === 'dak-plat'; })[0];
    return { events: el.quantity.history.map(function (h) { return h.event; }), evidence: el.quantity.evidence.map(function (e) { return e.source + ':' + e.value; }) };
  });
  check('Historie bevat EVIDENCE_ADDED, SOURCE_SELECTED, USER_OVERRIDDEN, RESET_TO_AUTO',
    ['EVIDENCE_ADDED', 'SOURCE_SELECTED', 'USER_OVERRIDDEN', 'RESET_TO_AUTO'].every(function (e) { return hist2.events.indexOf(e) > -1; }), hist2.events.join(','));
  check('Opgeslagen bronwaarden ongewijzigd', hist2.evidence.join(',') === 'IMPORTED_MJOP:308,3D_BAG:312.64,MANUAL:311', hist2.evidence.join(','));

  // --- offertebedragen ---------------------------------------------------------------------
  await openDakPlat(page);
  await page.click('[data-act=of-add]');
  await page.waitForTimeout(100);
  var oid = await page.$eval('[data-bind=of-regel-bedrag]', function (el) { return el.dataset.oid; });
  async function offerteBedrag(ri, tekst) {
    await page.fill('#of-' + oid + '-bedrag-' + ri, tekst);
    await page.waitForTimeout(80);
  }
  async function offerteTotaal() {
    return page.evaluate(function () {
      var v = document.querySelector('[data-act=of-del]').parentElement.querySelector('.value');
      return v ? v.textContent : '';
    });
  }
  await offerteBedrag(0, '1.250,50');
  check('Offerte "1.250,50" -> € 1.251 (niet € 125.050)', (await offerteTotaal()) === '€ 1.251', await offerteTotaal());
  await offerteBedrag(0, '1250.50');
  check('Offerte "1250.50" -> € 1.251', (await offerteTotaal()) === '€ 1.251', await offerteTotaal());
  await offerteBedrag(0, '1,250.50');
  check('Offerte "1,250.50" -> € 1.251', (await offerteTotaal()) === '€ 1.251', await offerteTotaal());
  await offerteBedrag(0, '1.250');
  var profiel = await page.$('[data-of-profiel]');
  check('Offerte alleen "1.250" (hele euro\'s) -> € 1.250, zichtbaar als profielregel', (await offerteTotaal()) === '€ 1.250' && !!profiel, await offerteTotaal());
  await page.click('[data-act=of-add-regel][data-oid="' + oid + '"]');
  await page.waitForTimeout(80);
  await offerteBedrag(1, '99,50');
  var fout = await page.$eval('[data-of-fout]', function (el) { return el.textContent; }).catch(function () { return ''; });
  check('"1.250" naast "99,50": onduidelijk, niet geraden (melding, telt niet mee)', /Onduidelijk bedrag/.test(fout) && (await offerteTotaal()) === '€ 100', fout + ' / ' + await offerteTotaal());

  // --- plan met v1-hoeveelheden (zonder bronnenlijst) laadt nog ---------------------------------
  var v1 = await context.newPage();
  v1.on('pageerror', function (e) { errors.push(String(e)); });
  await v1.goto(APP_URL);
  await v1.evaluate(function () {
    var q = { auto: { value: 100, unit: 'm2', source: '3D_BAG', basis: 'v1', raw: null }, manual: null, confirmed: null,
      history: [{ at: '2026-09-29T00:00:00Z', event: 'PROPOSED', value: 100, source: '3D_BAG' }], value: 100, unit: 'm2', source: '3D_BAG', status: 'PROPOSED' };
    var building = { adres: 'v1-plan', bouwjaar: 1980, units: 8, unitsBron: 8, dakM2: 100, gevelM2: 540, werkhoogte: 9, opp: 100, omtrek: 60,
      identificatie: PAND_ID_PLACEHOLDER, d3: { dak: 100, plat: 100, schuin: 0, gevel: 540 } };
    var plan = { building: building, fonds: 1000, bijdrage: 60, invul: { fonds: true, bijdrage: true }, offertes: {}, bijvullen: {}, elements: [
      { id: 'dak-plat', naam: 'Dakbedekking plat dak', categorie: 'Dak', sfb: '27.1', type: 'dak', cyclus: 25, bron: 'dakPlatM2', laatsteBeurt: 1980, gebreken: [], kengetal: 165, quantity: q }] };
    sessionStorage.setItem('mjop-worksessie', JSON.stringify({ screen: 'app', tab: 'gebouw', plan: plan }));
  }.toString().replace('PAND_ID_PLACEHOLDER', JSON.stringify(PAND_ID)).replace(/^function \(\) \{|\}$/g, ''));
  await v1.reload();
  await v1.waitForTimeout(300);
  await openDakPlat(v1);
  var pv1 = await panel(v1);
  check('Plan met v1-hoeveelheid laadt: 100 m², PROPOSED', pv1.status === 'PROPOSED' && /100 m² × € 165 = € 16\.500/.test(pv1.formula), pv1.formula);
  await v1.close();

  check('Geen JavaScript-fouten tijdens het testen', errors.length === 0, errors.join(' | '));
  await browser.close();

  var fail = 0;
  checks.forEach(function (c) { console.log((c[1] ? 'OK  ' : 'FAIL') + ' - ' + c[0]); if (!c[1]) fail++; });
  if (fail) { console.log(fail + ' controle(s) mislukt.'); process.exitCode = 1; return; }
  console.log('Alle controles geslaagd.');
}

main().catch(function (e) { console.error(e); process.exitCode = 1; });
