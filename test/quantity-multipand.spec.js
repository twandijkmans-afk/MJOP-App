'use strict';
// End-to-end: Multi-pand Quantity Sources v1 — een bundel voor een VvE-scope met meerdere BAG-panden.
//
//   adres -> 3D BAG (automatisch, één pand) -> v2-bundel importeren (3D BAG-som van 3 panden + historisch MJOP
//   op complexniveau) -> bronnen apart zichtbaar, geen automatische keuze, geen verschil tussen complex en pand
//   -> 'Bron bekijken' toont de pandwaarden -> expliciet kiezen -> herladen (keuze + onderdelen blijven)
//   -> oude v1-bundel blijft werken in een nieuw plan.
//
// test/fixtures/quantity-bundle-multipand.test.json is SYNTHETISCHE testdata, gemaakt met de echte
// mjop-learning-export (scripts/export_app_quantity_bundle.py) op zelfgemaakte API-antwoorden.
//
//   python3 -m http.server 8937 &   ;   node test/quantity-multipand.spec.js

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
var BUNDLE = fs.readFileSync(path.join(__dirname, 'fixtures', 'quantity-bundle-multipand.test.json'), 'utf8');
var BUNDLE_V1 = fs.readFileSync(path.join(__dirname, 'fixtures', 'quantity-bundle.test.json'), 'utf8');
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

async function panelX(page) {
  return page.evaluate(function () {
    var p = document.querySelector('.qty-panel');
    var rows = Array.prototype.map.call(document.querySelectorAll('[data-qty-source-row]'), function (r) {
      return { id: r.dataset.qtySourceRow, source: r.dataset.source, level: r.dataset.scopeLevel, method: r.dataset.method || '',
        effective: r.classList.contains('is-effective'), label: (r.querySelector('[data-qty-source-label]') || {}).textContent || '',
        value: (r.querySelector('[data-qty-source-value]') || {}).textContent, diff: (r.querySelector('[data-qty-source-diff]') || {}).textContent || '',
        detail: (r.querySelector('[data-qty-source-detail]') || {}).textContent || '',
        note: (r.querySelector('[data-qty-scope-note]') || {}).textContent || '',
        comps: Array.prototype.map.call(r.querySelectorAll('[data-qty-component]'), function (c) { return c.textContent; }) };
    });
    return { status: p && p.dataset.qtyStatus, source: p && p.dataset.qtySource,
      formula: (document.querySelector('[data-qty-formula]') || {}).textContent || '', rows: rows };
  });
}

async function startPlan(page) {
  await page.goto(APP_URL);
  await page.waitForTimeout(150);
  await page.click('[data-act=goto-onboarding]').catch(function () {});
  await page.waitForTimeout(150);
  await page.fill('#addr-search', 'Teststraat 1');
  await page.waitForSelector('.suggest-row', { timeout: 5000 });
  await page.click('.suggest-row');
  await page.waitForSelector('[data-act=set-tab][data-tab=gebouw]', { timeout: 8000 });
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

  await startPlan(page);
  var up = await uploadBundle(page, BUNDLE, 'multipand.json');
  check('v2-bundel: 2 bronnen toegevoegd, VvE-scope van 3 panden', /^2 bronnen toegevoegd/.test(up.melding) && /VvE-scope van 3 panden/.test(up.melding), up.melding || up.fout);

  await openDakPlat(page);
  var p = await panelX(page);
  var auto = p.rows.filter(function (r) { return r.id === 'auto'; })[0] || {};
  var hist = p.rows.filter(function (r) { return r.source === 'IMPORTED_MJOP'; })[0] || {};
  var som = p.rows.filter(function (r) { return r.source === '3D_BAG' && r.id !== 'auto'; })[0] || {};
  check('Niets automatisch gekozen: automatische pandwaarde 312,64 blijft PROPOSED', auto.effective && /312,64/.test(auto.value) && p.status === 'PROPOSED', p.status);
  check('3D BAG-som 463,39 m² apart zichtbaar als som van 3 panden (GEOMETRY_DERIVED, complexniveau)',
    /463,39/.test(som.value) && /som van 3 panden/.test(som.label) && som.method === 'GEOMETRY_DERIVED' && som.level === 'COMPLEX', som.label + ' / ' + som.value);
  check('Historisch MJOP 520 m² apart zichtbaar (SOURCE_REPORTED, complexniveau)',
    /520/.test(hist.value) && hist.method === 'SOURCE_REPORTED' && hist.level === 'COMPLEX' && /complexniveau/.test(hist.detail), hist.detail);
  check('Geen verschil tussen complexwaarde en pandwaarde (wel uitleg)', !som.diff && !hist.diff && /hele VvE-scope/.test(som.note), som.diff + '|' + hist.diff);
  check('Bron bekijken: de 3 onderliggende pandwaarden', som.comps.length === 3 && /0363100012345678: 312,64/.test(som.comps[0]) &&
    /0363100012345679: 100,25/.test(som.comps[1]) && /0363100012345680: 50,5/.test(som.comps[2]), som.comps.join(' | '));
  check('Historische bron heeft geen pandverdeling', hist.comps.length === 0);
  check('Kosten nog op de automatische waarde: 312,64 × € 165', /312,64 m² × € 165/.test(p.formula), p.formula);

  // expliciet kiezen
  await page.click('[data-act=qty-select][data-ev="' + som.id + '"]');
  await page.waitForTimeout(100);
  p = await panelX(page);
  var hist2 = p.rows.filter(function (r) { return r.source === 'IMPORTED_MJOP'; })[0] || {};
  check('Na expliciete keuze: 3D BAG-som gebruikt (CONFIRMED, 463,39 × € 165)', p.status === 'CONFIRMED' && /463,39 m² × € 165/.test(p.formula), p.formula);
  check('Nu wel verschil historisch t.o.v. som (zelfde niveau): +56,61 m²', /\+56,61/.test(hist2.diff), hist2.diff);

  // herladen
  await page.reload();
  await page.waitForTimeout(300);
  await openDakPlat(page);
  p = await panelX(page);
  var som2 = p.rows.filter(function (r) { return r.source === '3D_BAG' && r.id !== 'auto'; })[0] || {};
  check('Na herladen: keuze blijft en de 3 pandwaarden blijven bewaard', p.source === '3D_BAG' && /463,39 m² × € 165/.test(p.formula) && som2.comps.length === 3, som2.comps.length + '');
  var opgeslagen = await page.evaluate(function () {
    var ws = JSON.parse(sessionStorage.getItem('mjop-worksessie'));
    var el = ws.plan.elements.filter(function (e) { return e.id === 'dak-plat'; })[0];
    return el.quantity.evidence.map(function (e) { return { s: e.source, v: e.value, n: (e.components || []).length, lvl: e.scope_level }; });
  });
  check('Opgeslagen: som met 3 onderdelen + historisch, beide complexniveau', JSON.stringify(opgeslagen) ===
    JSON.stringify([{ s: '3D_BAG', v: 463.39, n: 3, lvl: 'COMPLEX' }, { s: 'IMPORTED_MJOP', v: 520, n: 0, lvl: 'COMPLEX' }]), JSON.stringify(opgeslagen));

  // bundel van een scope zonder dit pand
  var ander = JSON.parse(BUNDLE);
  ander.bag_pand_ids = ['0363100099999998', '0363100099999999']; ander.building_scope.bag_pand_ids = ander.bag_pand_ids.slice();
  ander.building_id = ander.building_scope.building_id = 'BAG:0363100099999998+0363100099999999';
  up = await uploadBundle(page, JSON.stringify(ander));
  check('v2-bundel van een scope zonder dit pand wordt geweigerd', /dit plan hoort bij pand 0363100012345678/.test(up.fout), up.fout);

  // oude v1-bundel in een nieuw plan
  var p2 = await context.newPage();
  p2.on('pageerror', function (e) { errors.push(String(e)); });
  await mockApis(p2);
  await p2.evaluate(function () { sessionStorage.clear(); }).catch(function () {});
  await startPlan(p2);
  up = await uploadBundle(p2, BUNDLE_V1, 'v1.json');
  check('Oude v1-bundel (één pand) importeert nog: 2 bronnen, geen scope-tekst', /^2 bronnen toegevoegd/.test(up.melding) && !/VvE-scope/.test(up.melding), up.melding || up.fout);
  await openDakPlat(p2);
  var pv1 = await panelX(p2);
  var h1 = pv1.rows.filter(function (r) { return r.source === 'IMPORTED_MJOP'; })[0] || {};
  check('v1: verschil historisch t.o.v. pand blijft zichtbaar (-4,64 m²)', /-4,64/.test(h1.diff) && h1.level === 'PAND', h1.diff);
  await p2.close();

  check('Geen JavaScript-fouten tijdens het testen', errors.length === 0, errors.join(' | '));
  await browser.close();
  var fail = 0;
  checks.forEach(function (c) { console.log((c[1] ? 'OK  ' : 'FAIL') + ' - ' + c[0]); if (!c[1]) fail++; });
  if (fail) { console.log(fail + ' controle(s) mislukt.'); process.exitCode = 1; return; }
  console.log('Alle controles geslaagd.');
}

main().catch(function (e) { console.error(e); process.exitCode = 1; });
