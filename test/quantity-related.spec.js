'use strict';
// End-to-end: Related Quantity Sources v1 — bundel v3 met een verwant maar ANDER onderwerp.
//
//   adres -> 3D BAG (automatisch, één pand) -> v3-bundel importeren: 3D BAG-som van 3 panden (plat dakoppervlak,
//   kiesbaar) + historisch MJOP 'gerapporteerde dakbedekkingsoppervlakte' (RELATED_NOT_EQUIVALENT, alleen context)
//   -> beide semantieken apart zichtbaar, bronverschil als 'andere definitie', context niet kiesbaar, niets
//   automatisch gekozen, geen gemiddelde -> herladen (context blijft context) -> v2-bundel blijft werken.
//
// test/fixtures/quantity-bundle-related.test.json is SYNTHETISCHE testdata, gemaakt met de echte
// mjop-learning-export (scripts/export_app_quantity_bundle.py, met onderwerpenvocabulaire) op zelfgemaakte
// API-antwoorden.
//
//   python3 -m http.server 8937 &   ;   node test/quantity-related.spec.js

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
var BUNDLE = fs.readFileSync(path.join(__dirname, 'fixtures', 'quantity-bundle-related.test.json'), 'utf8');
var BUNDLE_V2 = fs.readFileSync(path.join(__dirname, 'fixtures', 'quantity-bundle-multipand.test.json'), 'utf8');
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

async function related(page) {
  return page.evaluate(function () {
    return Array.prototype.map.call(document.querySelectorAll('[data-qty-related-row]'), function (r) {
      function t(sel) { return (r.querySelector(sel) || {}).textContent || ''; }
      return { id: r.dataset.qtyRelatedRow, source: r.dataset.source, subject: r.dataset.subject, selectable: r.dataset.selectable,
        level: r.dataset.scopeLevel, method: r.dataset.method || '', label: t('[data-qty-source-label]'), value: t('[data-qty-source-value]'),
        subjectText: t('[data-qty-related-subject]'), definition: t('[data-qty-related-definition]'), diff: t('[data-qty-related-diff]'),
        status: t('[data-qty-related-status]'), detail: t('[data-qty-source-detail]'),
        buttons: r.querySelectorAll('button').length };
    });
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

  await startPlan(page);
  var up = await uploadBundle(page, BUNDLE, 'related.json');
  check('v3-bundel: 2 bronnen, waarvan 1 ter vergelijking (ander onderwerp)', /^2 bronnen toegevoegd \(waarvan 1 ter vergelijking: ander onderwerp, niet kiesbaar\)/.test(up.melding) &&
    /VvE-scope van 3 panden/.test(up.melding), up.melding || up.fout);

  await openDakPlat(page);
  var p = await panelX(page);
  var rel = await related(page);
  var auto = p.rows.filter(function (r) { return r.id === 'auto'; })[0] || {};
  var som = p.rows.filter(function (r) { return r.source === '3D_BAG' && r.id !== 'auto'; })[0] || {};
  var hist = rel[0] || {};
  check('Niets automatisch gekozen: automatische waarde blijft PROPOSED', auto.effective && /312,64/.test(auto.value) && p.status === 'PROPOSED', p.status);
  check('3D BAG-som 463,39 m² als kiesbare bron, onderwerp plat dakoppervlak',
    /463,39/.test(som.value) && /som van 3 panden/.test(som.label) && /onderwerp: plat dakoppervlak/.test(som.detail) && som.method === 'GEOMETRY_DERIVED', som.detail);
  check('Historische dakbedekking staat NIET tussen de kiesbare bronnen', p.rows.every(function (r) { return r.source !== 'IMPORTED_MJOP'; }));
  check('Historische bron apart: 520 m², oud MJOP, complexniveau, SOURCE_REPORTED', rel.length === 1 && /520/.test(hist.value) &&
    hist.source === 'IMPORTED_MJOP' && hist.level === 'COMPLEX' && hist.method === 'SOURCE_REPORTED' && /Uit oud MJOP/.test(hist.label), JSON.stringify(hist));
  check('Onderwerp: gerapporteerde dakbedekkingsoppervlakte', hist.subject === 'ROOF_COVERING_REPORTED_AREA' &&
    /door bron\/mjop gerapporteerde oppervlakte dakbedekking/.test(hist.subjectText), hist.subjectText);
  check('Definitie wijkt mogelijk af; niet kiesbaar', /Definitie wijkt mogelijk af van plat dakoppervlak/.test(hist.definition) &&
    hist.selectable === 'false' && hist.buttons === 0, hist.definition);
  check('Bronverschil als andere definitie: +56,61 m² (+12,2%) t.o.v. 3D BAG-som', /Bronverschil t\.o\.v\. 3D BAG — som van 3 panden: \+56,61 m² \(\+12,2%\) — andere definitie/.test(hist.diff), hist.diff);
  check('Status: nog niet bevestigd, geen keuze, geen gemiddelde', /nog niet bevestigd/.test(hist.status) && /geen gemiddelde/.test(hist.status), hist.status);
  check('Kosten op de automatische waarde, geen gemiddelde: 312,64 × € 165', /312,64 m² × € 165/.test(p.formula), p.formula);

  // de context kan ook via de logica niet gekozen worden
  var poging = await page.evaluate(function (id) {
    return window.MJOPQuantity.selectEvidence({ evidence: [{ id: id, role: 'RELATED_CONTEXT', selectable: false, value: 520, unit: 'm2' }], history: [], auto: null, manual: null }, id);
  }, hist.id);
  check('selectEvidence weigert de context-bron (ander_onderwerp)', poging.ok === false && poging.error === 'ander_onderwerp', JSON.stringify(poging));

  // expliciet het hoofdonderwerp kiezen; de historische bron blijft context
  await page.click('[data-act=qty-select][data-ev="' + som.id + '"]');
  await page.waitForTimeout(100);
  p = await panelX(page);
  rel = await related(page);
  check('Na expliciete keuze: 3D BAG-som gebruikt (463,39 × € 165); historisch blijft context', p.status === 'CONFIRMED' &&
    /463,39 m² × € 165/.test(p.formula) && rel.length === 1 && rel[0].buttons === 0, p.formula);

  await page.reload();
  await page.waitForTimeout(300);
  await openDakPlat(page);
  p = await panelX(page);
  rel = await related(page);
  check('Na herladen: keuze blijft, historische bron nog steeds niet kiesbaar', p.source === '3D_BAG' && /463,39 m² × € 165/.test(p.formula) &&
    rel.length === 1 && rel[0].selectable === 'false' && /\+56,61/.test(rel[0].diff), p.formula);
  var opgeslagen = await page.evaluate(function () {
    var ws = JSON.parse(sessionStorage.getItem('mjop-worksessie'));
    var el = ws.plan.elements.filter(function (e) { return e.id === 'dak-plat'; })[0];
    return el.quantity.evidence.map(function (e) { return { s: e.source, k: e.subject_key, sel: e.selectable !== false, v: e.value }; });
  });
  check('Opgeslagen: som (kiesbaar) + historische context (niet kiesbaar)', JSON.stringify(opgeslagen) === JSON.stringify([
    { s: 'IMPORTED_MJOP', k: 'ROOF_COVERING_REPORTED_AREA', sel: false, v: 520 }, { s: '3D_BAG', k: 'ROOF_FLAT_AREA', sel: true, v: 463.39 }]), JSON.stringify(opgeslagen));

  // v2-bundel blijft werken in een nieuw plan (historisch als gewone bron, zoals voorheen)
  var p2 = await context.newPage();
  p2.on('pageerror', function (e) { errors.push(String(e)); });
  await mockApis(p2);
  await p2.evaluate(function () { sessionStorage.clear(); }).catch(function () {});
  await startPlan(p2);
  up = await uploadBundle(p2, BUNDLE_V2, 'v2.json');
  check('v2-bundel importeert nog: 2 bronnen, geen context', /^2 bronnen toegevoegd/.test(up.melding) && !/ter vergelijking/.test(up.melding), up.melding || up.fout);
  await openDakPlat(p2);
  var rel2 = await related(p2);
  var pv2 = await panelX(p2);
  check('v2: geen context-sectie, historisch blijft gewone (kiesbare) bron', rel2.length === 0 && pv2.rows.some(function (r) { return r.source === 'IMPORTED_MJOP'; }));
  await p2.close();

  check('Geen JavaScript-fouten tijdens het testen', errors.length === 0, errors.join(' | '));
  await browser.close();
  var fail = 0;
  checks.forEach(function (c) { console.log((c[1] ? 'OK  ' : 'FAIL') + ' - ' + c[0]); if (!c[1]) fail++; });
  if (fail) { console.log(fail + ' controle(s) mislukt.'); process.exitCode = 1; return; }
  console.log('Alle controles geslaagd.');
}

main().catch(function (e) { console.error(e); process.exitCode = 1; });
