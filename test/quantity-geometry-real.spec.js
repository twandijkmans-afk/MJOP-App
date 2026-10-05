'use strict';
// End-to-end met ECHTE data: geometriebundels uit mjop-learning (Scaffolding Quantity Activation v1).
//
//   Maldenhof 240 (pand 0363100012137996, één van de 15 bevestigde panden) -> maldenhof_geometry_expanded_v3.json
//   via de gewone bundelimport -> dak-plat en dak-hellend ongewijzigd -> steiger: 3D BAG — som van 15 panden
//   1.747,35 m² bruto buitenmuur met per pand de werkhoogte uit 3D BAG; alle 15 panden > 8 m -> één tariefklasse ->
//   1.747,35 × € 11 = € 19.221 (gelijk aan de som per pand) -> niets automatisch gekozen -> keuze blijft na herladen.
//   DOC-012 Meppelweg 819 (één pand) -> doc012_geometry_v3.json -> steiger 3.048,46 m² × € 11 (werkhoogte 20 m) =
//   € 33.533; dak-hellend (gemeten 0 m²) bestaat niet in dit plan en wordt overgeslagen.
//
// test/fixtures/real/ bevat ongewijzigde kopieën van de echte bundels en uitsneden van de canonieke snapshots
// (zie test/fixtures/real/README.md). PDOK/BAG/3D BAG worden nagebootst: geen netwerkcalls.
//
//   python3 -m http.server 8937 &   ;   node test/quantity-geometry-real.spec.js

let chromium;
try {
  chromium = require('playwright').chromium;
} catch (e) {
  chromium = require('/opt/node22/lib/node_modules/playwright').chromium;
}
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

var APP_URL = process.env.MJOP_TEST_URL || 'http://localhost:8937/index.html';
var CHROMIUM_PATH = process.env.MJOP_CHROMIUM || '/opt/pw-browsers/chromium';
var REAL = path.join(__dirname, 'fixtures', 'real');
var M_FILE = path.join(REAL, 'maldenhof_geometry_expanded_v3.json');
var D_FILE = path.join(REAL, 'doc012_geometry_v3.json');
var M_SHA = '8264bdceb2c0ee633333b79ac6a073f8c9ea48661659007f69ff22df391a52ca';
var D_SHA = 'fe12a4eb7999f784056d46a607e5e37b6223fc30a6eff0c4c86924390f074a87';
var SNAP = JSON.parse(fs.readFileSync(path.join(REAL, 'maldenhof_240_snapshot_excerpt.json'), 'utf8'));
var SNAP12 = JSON.parse(fs.readFileSync(path.join(REAL, 'doc012_meppelweg_819_snapshot_excerpt.json'), 'utf8'));

async function mockAddress(page, snap, extern) {
  await page.route(/^https?:\/\/(?!localhost)/, function (route) { extern.push(route.request().url()); route.abort(); });
  var naam = snap.address.weergavenaam, pandId = snap.bag_pand_id, props = snap.bag_properties;
  var pt = /POINT\(([\d.]+) ([\d.]+)\)/.exec(snap.address.centroide_ll);
  var lon = Number(pt[1]), lat = Number(pt[2]), d = 0.00005;
  await page.route('**/locatieserver/search/v3_1/suggest**', function (route) {
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ response: { docs: [{ id: 'adr-test', weergavenaam: naam }] } }) });
  });
  await page.route('**/locatieserver/search/v3_1/lookup**', function (route) {
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ response: { docs: [{ weergavenaam: naam, centroide_ll: snap.address.centroide_ll }] } }) });
  });
  await page.route('**/kadaster/bag/ogc/v2/collections/pand/items**', function (route) {
    var ring = [[lon - d, lat - d], [lon + d, lat - d], [lon + d, lat + d], [lon - d, lat + d], [lon - d, lat - d]];
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ features: [{ geometry: { type: 'Polygon', coordinates: [ring] },
      properties: { identificatie: pandId, bouwjaar: props.bouwjaar, gebruiksdoel: props.gebruiksdoel, aantal_verblijfsobjecten: props.aantal_verblijfsobjecten } }] }) });
  });
  await page.route('**/api.3dbag.nl/**', function (route) {
    var co = {};
    co['NL.IMBAG.Pand.' + pandId] = { attributes: snap.threedbag_attributes };
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ feature: { CityObjects: co } }) });
  });
}

async function tab(page, naam) { await page.click('[data-act=set-tab][data-tab=' + naam + ']'); await page.waitForTimeout(120); }
async function openEl(page, id) { await tab(page, 'gebouw'); await page.click('.gb-row[data-act=open-element][data-id=' + id + ']'); await page.waitForTimeout(120); }

async function startPlan(page, adres) {
  await page.goto(APP_URL);
  await page.waitForTimeout(150);
  await page.click('[data-act=goto-onboarding]').catch(function () {});
  await page.waitForTimeout(150);
  await page.fill('#addr-search', adres);
  await page.waitForSelector('.suggest-row', { timeout: 5000 });
  await page.click('.suggest-row');
  await page.waitForSelector('[data-act=set-tab][data-tab=gebouw]', { timeout: 8000 });
}

async function upload(page, file) {
  await tab(page, 'gebouw');
  await page.setInputFiles('#qty-bundle-input', { name: path.basename(file), mimeType: 'application/json', buffer: fs.readFileSync(file) });
  await page.waitForTimeout(250);
  return page.evaluate(function () { return ((document.querySelector('[data-bundle-melding]') || {}).textContent || '') + ((document.querySelector('[data-bundle-fout]') || {}).textContent || ''); });
}

async function view(page) {
  return page.evaluate(function () {
    function t(r, sel) { return (r.querySelector(sel) || {}).textContent || ''; }
    var p = document.querySelector('.qty-panel');
    var sp = document.querySelector('[data-steiger-pricing]');
    var f = document.querySelector('[data-qty-formula]');
    return { status: p && p.dataset.qtyStatus, source: p && p.dataset.qtySource, label: (p && p.querySelector('label') || {}).textContent || '',
      formula: f ? f.textContent : '', mode: sp && sp.dataset.steigerPricing, note: (document.querySelector('[data-steiger-note]') || {}).textContent || '',
      whInput: !!document.querySelector('input[data-change=el-werkhoogte]'), whValue: (document.querySelector('input[data-change=el-werkhoogte]') || {}).value,
      steigerRows: Array.prototype.map.call(document.querySelectorAll('[data-steiger-row]'), function (r) { return { pand: r.dataset.steigerRow, band: r.dataset.band, text: r.textContent }; }),
      rows: Array.prototype.map.call(document.querySelectorAll('[data-qty-source-row]'), function (r) {
        return { id: r.dataset.qtySourceRow, source: r.dataset.source, level: r.dataset.scopeLevel, effective: r.classList.contains('is-effective'),
          label: t(r, '[data-qty-source-label]'), value: t(r, '[data-qty-source-value]'), detail: t(r, '[data-qty-source-detail]'),
          comps: r.querySelectorAll('[data-qty-component]').length, buttons: r.querySelectorAll('[data-act=qty-select]').length };
      }),
      related: document.querySelectorAll('[data-qty-related-row]').length };
  });
}

function bag(v) { return v.rows.filter(function (r) { return r.source === '3D_BAG' && r.id !== 'auto'; })[0] || {}; }
function auto(v) { return v.rows.filter(function (r) { return r.id === 'auto'; })[0] || {}; }

async function main() {
  var browser = await chromium.launch({ executablePath: CHROMIUM_PATH });
  var errors = [], extern = [], checks = [];
  function check(naam, ok, info) { checks.push([naam + (info ? ' (' + info + ')' : ''), !!ok]); }
  check('Fixtures zijn de ongewijzigde echte bundels (sha256)', crypto.createHash('sha256').update(fs.readFileSync(M_FILE)).digest('hex') === M_SHA &&
    crypto.createHash('sha256').update(fs.readFileSync(D_FILE)).digest('hex') === D_SHA);

  // ---------------- Maldenhof 240 ----------------
  var ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  var page = await ctx.newPage();
  page.setDefaultTimeout(8000);
  page.on('pageerror', function (e) { errors.push(String(e)); });
  await mockAddress(page, SNAP, extern);
  await startPlan(page, 'Maldenhof 240');
  var m = await upload(page, M_FILE);
  check('Import: 7 bronnen, waarvan 4 ter vergelijking; VvE-scope van 15 panden; niets overgeslagen', /^7 bronnen toegevoegd \(waarvan 4 ter vergelijking/.test(m) &&
    /VvE-scope van 15 panden/.test(m) && !/overgeslagen/.test(m), m);

  await openEl(page, 'dak-plat');
  var v = await view(page);
  check('dak-plat ongewijzigd: 3D BAG — som van 15 panden 190,65 m² + 2x historische context', bag(v).value === '190,65 m²' && v.related === 2 && auto(v).effective, bag(v).value);
  await openEl(page, 'dak-hellend');
  v = await view(page);
  check('dak-hellend ongewijzigd: 1.415,57 m² + 2x dakpannen-context', bag(v).value === '1.415,57 m²' && v.related === 2 && auto(v).effective, bag(v).value);

  await openEl(page, 'steiger');
  v = await view(page);
  var som = bag(v);
  check('steiger: "Bruto buitenmuuroppervlak"; 3D BAG — som van 15 panden 1.747,35 m², complexniveau, 15 onderdelen, kiesbaar',
    /^Bruto buitenmuuroppervlak/.test(v.label) && /3D BAG — som van 15 panden/.test(som.label) && som.value === '1.747,35 m²' && som.level === 'COMPLEX' &&
    som.comps === 15 && som.buttons === 1, som.label + ' / ' + som.value);
  check('steiger: geen historische (2110) context', v.related === 0 && v.rows.every(function (r) { return r.source !== 'IMPORTED_MJOP'; }));
  check('steiger: niets automatisch gekozen — eigen pand 118,32 m² × € 11 (werkhoogte 9 m)', auto(v).effective && auto(v).value === '118,32 m²' &&
    v.mode === 'PAND' && v.whValue === '9' && v.formula === '118,32 m² × € 11 = € 1.302 per keer', v.formula);
  await page.click('[data-act=qty-select][data-ev="' + som.id + '"]');
  await page.waitForTimeout(150);
  v = await view(page);
  check('steiger gekozen: één tariefklasse (alle 15 panden > 8 m) -> 1.747,35 × € 11 = € 19.221', v.status === 'CONFIRMED' && v.mode === 'SCOPE_UNIFORM' &&
    v.formula === '1.747,35 m² × € 11 = € 19.221 per keer' && /^Alle 15 panden vallen in dezelfde tariefklasse \(werkhoogte boven 8 m: € 11 per m²\)/.test(v.note), v.formula);
  check('steiger: 15 pandregels met eigen werkhoogte (9–12 m), allemaal > 8 m; werkhoogte van het plan niet op de scope', v.steigerRows.length === 15 &&
    v.steigerRows.every(function (r) { return r.band === 'GT_8M'; }) && /0363100012137996: 118,32 m² · werkhoogte 9 m/.test(v.steigerRows.map(function (r) { return r.text; }).join('|')) &&
    !v.whInput && /wordt niet voor de hele scope gebruikt/.test(v.note));
  var somPerPand = v.steigerRows.reduce(function (s, r) { var mm = /= € ([\d.,]+)$/.exec(r.text); return s + Math.round(Number(mm[1].replace(/\./g, '').replace(',', '.')) * 100); }, 0);
  check('steiger: scopetarief = som per pand (€ 19.221)', Math.round(somPerPand / 100) === 19221, String(somPerPand));

  await page.reload();
  await page.waitForTimeout(300);
  await openEl(page, 'steiger');
  v = await view(page);
  check('Na herladen: keuze en prijscontext blijven (SCOPE_UNIFORM, € 19.221, 15 pandregels)', v.status === 'CONFIRMED' && v.mode === 'SCOPE_UNIFORM' &&
    v.formula === '1.747,35 m² × € 11 = € 19.221 per keer' && v.steigerRows.length === 15, v.formula);
  await ctx.close();

  // ---------------- DOC-012 (één pand) ----------------
  var c2 = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  var p2 = await c2.newPage();
  p2.setDefaultTimeout(8000);
  p2.on('pageerror', function (e) { errors.push(String(e)); });
  await mockAddress(p2, SNAP12, extern);
  await startPlan(p2, 'Meppelweg 819');
  var m2 = await upload(p2, D_FILE);
  check('DOC-012 import: 3 bronnen (1 ter vergelijking); dak-hellend overgeslagen (gemeten 0 m², niet in dit plan)', /^3 bronnen toegevoegd \(waarvan 1 ter vergelijking/.test(m2) &&
    /overgeslagen: dak-hellend \(niet in dit plan\)/.test(m2), m2);
  await openEl(p2, 'steiger');
  v = await view(p2);
  check('DOC-012 steiger automatisch: 3.048,46 m² × € 11 (werkhoogte 20 m) = € 33.533', v.mode === 'PAND' && v.whValue === '20' &&
    v.formula === '3.048,46 m² × € 11 = € 33.533 per keer', v.formula);
  var b12 = bag(v);
  await p2.click('[data-act=qty-select][data-ev="' + b12.id + '"]');
  await p2.waitForTimeout(150);
  v = await view(p2);
  check('DOC-012 bundelbron gekozen: één pand, geen ambiguïteit — zelfde € 33.533', v.status === 'CONFIRMED' && v.mode === 'PAND' &&
    v.formula === '3.048,46 m² × € 11 = € 33.533 per keer' && v.whInput, v.formula);
  await c2.close();

  await browser.close();
  var dataCalls = extern.filter(function (u) { return /pdok|kadaster|3dbag/i.test(u); });
  check('Geen echte PDOK/BAG/3D BAG-calls', dataCalls.length === 0, dataCalls.join(' | '));
  check('Geen JavaScript-fouten tijdens het testen', errors.length === 0, errors.join(' | '));
  var fail = 0;
  checks.forEach(function (c) { console.log((c[1] ? 'OK  ' : 'FAIL') + ' - ' + c[0]); if (!c[1]) fail++; });
  if (fail) { console.log(fail + ' controle(s) mislukt.'); process.exitCode = 1; return; }
  console.log('Alle controles geslaagd.');
}

main().catch(function (e) { console.error(e); process.exit(1); });
