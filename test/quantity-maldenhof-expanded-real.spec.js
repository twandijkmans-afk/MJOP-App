'use strict';
// End-to-end met ECHTE data: uitgebreide Maldenhof-bundel v3 (dak-plat + dak-hellend), Sloped Roof Quantity Activation v1.
//
//   Maldenhof 240 (pand 0363100012137996, één van de 15 bevestigde panden) -> echte mjop-learning-bundel
//   maldenhof_expanded_v3.json importeren via de gewone bundelimport ->
//   dak-plat: ongewijzigd (3D BAG-som 190,65 m² + historische dakbedekking 425,80 m², niet kiesbaar) ->
//   dak-hellend: 3D BAG-som van 15 panden 1415,57 m² (hellend dakoppervlak, kiesbaar) en apart 'Uit oud MJOP'
//   1485,60 m² gerapporteerde dakpannen (DOC-005 en DOC-006, één bron, ander onderwerp, niet kiesbaar) ->
//   niets automatisch gekozen, geen gemiddelde -> voor TESTDOELEINDEN de 3D BAG-som kiezen -> herladen -> keuze blijft.
//   DOC-012 Meppelweg 819: gemeten hellend dak 0 m² (geldig, geen missing) -> geen dak-hellend-post.
//
// test/fixtures/real/ bevat ongewijzigde kopieën van de echte bundels en uitsneden van de canonieke snapshots
// (zie test/fixtures/real/README.md). PDOK/BAG/3D BAG worden daarmee nagebootst: geen netwerkcalls. De keuze in
// deze test is alleen app-persistentie en wordt nergens teruggeschreven.
//
//   python3 -m http.server 8937 &   ;   node test/quantity-maldenhof-expanded-real.spec.js

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
var BUNDLE_FILE = path.join(REAL, 'maldenhof_expanded_v3.json');
var BUNDLE = fs.readFileSync(BUNDLE_FILE, 'utf8');
var BUNDLE_SHA256 = 'c78f387e66ce7963d7a434270350f0ee8fa4c9f232099f871e83ed202cd2975d';
var SNAP = JSON.parse(fs.readFileSync(path.join(REAL, 'maldenhof_240_snapshot_excerpt.json'), 'utf8'));
var SNAP12 = JSON.parse(fs.readFileSync(path.join(REAL, 'doc012_meppelweg_819_snapshot_excerpt.json'), 'utf8'));

async function mockAddress(page, snap) {
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
      properties: { identificatie: pandId, bouwjaar: props.bouwjaar, gebruiksdoel: props.gebruiksdoel,
        aantal_verblijfsobjecten: props.aantal_verblijfsobjecten } }] }) });
  });
  await page.route('**/api.3dbag.nl/**', function (route) {
    var co = {};
    co['NL.IMBAG.Pand.' + pandId] = { attributes: snap.threedbag_attributes };
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ feature: { CityObjects: co } }) });
  });
}

async function blockOtherNetwork(page, log) {
  await page.route(/^https?:\/\/(?!localhost)/, function (route) { log.push(route.request().url()); route.abort(); });
}

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

async function openElement(page, id) {
  await page.click('[data-act=set-tab][data-tab=gebouw]');
  await page.waitForTimeout(100);
  await page.click('.gb-row[data-act=open-element][data-id=' + id + ']');
  await page.waitForTimeout(100);
}

async function uploadBundle(page, text, name) {
  await page.click('[data-act=set-tab][data-tab=gebouw]');
  await page.waitForTimeout(100);
  await page.setInputFiles('#qty-bundle-input', { name: name, mimeType: 'application/json', buffer: Buffer.from(text, 'utf8') });
  await page.waitForTimeout(250);
  return page.evaluate(function () {
    return { melding: (document.querySelector('[data-bundle-melding]') || {}).textContent || '', fout: (document.querySelector('[data-bundle-fout]') || {}).textContent || '' };
  });
}

async function view(page) {
  return page.evaluate(function () {
    function t(r, sel) { return (r.querySelector(sel) || {}).textContent || ''; }
    var p = document.querySelector('.qty-panel');
    var rows = Array.prototype.map.call(document.querySelectorAll('[data-qty-source-row]'), function (r) {
      return { id: r.dataset.qtySourceRow, source: r.dataset.source, level: r.dataset.scopeLevel, method: r.dataset.method || '',
        effective: r.classList.contains('is-effective'), label: t(r, '[data-qty-source-label]'), value: t(r, '[data-qty-source-value]'),
        detail: t(r, '[data-qty-source-detail]'), comps: r.querySelectorAll('[data-qty-component]').length,
        selectButtons: r.querySelectorAll('[data-act=qty-select]').length };
    });
    var related = Array.prototype.map.call(document.querySelectorAll('[data-qty-related-row]'), function (r) {
      return { id: r.dataset.qtyRelatedRow, source: r.dataset.source, subject: r.dataset.subject, selectable: r.dataset.selectable,
        level: r.dataset.scopeLevel, method: r.dataset.method || '', label: t(r, '[data-qty-source-label]'), value: t(r, '[data-qty-source-value]'),
        subjectText: t(r, '[data-qty-related-subject]'), definition: t(r, '[data-qty-related-definition]'), diff: t(r, '[data-qty-related-diff]'),
        detail: t(r, '[data-qty-source-detail]'), buttons: r.querySelectorAll('button').length };
    });
    return { status: p && p.dataset.qtyStatus, source: p && p.dataset.qtySource, formula: t(document, '[data-qty-formula]'),
      rows: rows, related: related, relatedHeading: t(document, '[data-qty-related] > .label') };
  });
}

async function saved(page, id) {
  return page.evaluate(function (id) {
    var ws = JSON.parse(sessionStorage.getItem('mjop-worksessie'));
    var el = ws.plan.elements.filter(function (e) { return e.id === id; })[0];
    return { plan: ws.plan, q: el && el.quantity };
  }, id);
}

function bag(v) { return v.rows.filter(function (r) { return r.source === '3D_BAG' && r.id !== 'auto'; })[0] || {}; }
function auto(v) { return v.rows.filter(function (r) { return r.id === 'auto'; })[0] || {}; }

async function main() {
  var browser = await chromium.launch({ executablePath: CHROMIUM_PATH });
  var context = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  var page = await context.newPage();
  var errors = [], extern = [];
  page.on('pageerror', function (e) { errors.push(String(e)); });
  await blockOtherNetwork(page, extern);
  await mockAddress(page, SNAP);
  var checks = [];
  function check(naam, ok, info) { checks.push([naam + (info ? ' (' + info + ')' : ''), !!ok]); }

  check('Fixture is de ongewijzigde echte uitgebreide bundel (sha256)', crypto.createHash('sha256').update(fs.readFileSync(BUNDLE_FILE)).digest('hex') === BUNDLE_SHA256);
  var b = JSON.parse(BUNDLE);
  var els = b.entries.map(function (e) { return e.app_element_key; }).filter(function (k, i, a) { return a.indexOf(k) === i; }).sort();
  check('Echte bundel: v3, 15 panden, dak-plat + dak-hellend', b.bundle_version === 'mjop_app_quantity_bundle_v3' && b.bag_pand_ids.length === 15 &&
    b.bag_pand_ids.indexOf(SNAP.bag_pand_id) !== -1 && els.join(',') === 'dak-hellend,dak-plat', els.join(','));

  // 1. Maldenhof 240-plan; dak-hellend bestaat (3D BAG hellend dak 74,07 m² voor dit pand)
  await startPlan(page, 'Maldenhof 240');
  await page.click('[data-act=set-tab][data-tab=gebouw]');
  await page.waitForTimeout(100);
  var heeftHellend = await page.evaluate(function () { return !!document.querySelector('.gb-row[data-id="dak-hellend"]'); });
  check('1. Plan voor Maldenhof 240 met dak-plat en dak-hellend', heeftHellend);

  // 2. import via de gewone bundelimport
  var up = await uploadBundle(page, BUNDLE, 'maldenhof_expanded_v3.json');
  check('2. Import: 6 bronnen, waarvan 4 ter vergelijking; VvE-scope van 15 panden; niets overgeslagen',
    /^6 bronnen toegevoegd \(waarvan 4 ter vergelijking: ander onderwerp, niet kiesbaar\)/.test(up.melding) && /VvE-scope van 15 panden/.test(up.melding) &&
    !/overgeslagen/.test(up.melding), up.melding || up.fout);

  // 3. dak-plat: regressie
  await openElement(page, 'dak-plat');
  var vp = await view(page);
  check('3a. dak-plat: 3D BAG — som van 15 panden 190,65 m², kiesbaar', /3D BAG — som van 15 panden/.test(bag(vp).label) && bag(vp).value === '190,65 m²' &&
    bag(vp).selectButtons === 1 && bag(vp).comps === 15, bag(vp).label + ' / ' + bag(vp).value);
  check('3b. dak-plat: historische dakbedekking 425,80 m² (2x), niet kiesbaar', vp.related.length === 2 && vp.related.every(function (r) {
    return r.value === '425,80 m²' && r.subject === 'ROOF_COVERING_REPORTED_AREA' && r.selectable === 'false' && r.buttons === 0; }));
  check('3c. dak-plat: geen dakpannen-context en niets automatisch gekozen', vp.related.every(function (r) { return r.subject !== 'ROOF_TILES_REPORTED_AREA'; }) &&
    auto(vp).effective && auto(vp).value === '12,74 m²' && !bag(vp).effective, auto(vp).value);

  // 4. dak-hellend: PRIMARY + historische dakpannen
  await openElement(page, 'dak-hellend');
  var v = await view(page);
  var som = bag(v);
  check('4a. dak-hellend: 3D BAG — som van 15 panden, 1415,57 m², complexniveau, GEOMETRY_DERIVED', /3D BAG — som van 15 panden/.test(som.label) &&
    som.value === '1.415,57 m²' && som.level === 'COMPLEX' && som.method === 'GEOMETRY_DERIVED' && som.comps === 15, som.label + ' / ' + som.value);
  check('4b. onderwerp hellend dakoppervlak', /onderwerp: hellend dakoppervlak/i.test(som.detail), som.detail);
  check('4c. Kop "Historische bron — ander onderwerp"', /^Historische bron — ander onderwerp/.test(v.relatedHeading), v.relatedHeading);
  check('4d. Uit oud MJOP 1485,60 m² (DOC-005 en DOC-006), complexniveau, SOURCE_REPORTED', v.related.length === 2 &&
    v.related.every(function (r) { return r.value === '1.485,60 m²' && r.source === 'IMPORTED_MJOP' && /^Uit oud MJOP/.test(r.label) &&
      r.level === 'COMPLEX' && r.method === 'SOURCE_REPORTED'; }) &&
    /document DOC-005/.test(v.related.map(function (r) { return r.detail; }).join()) && /document DOC-006/.test(v.related.map(function (r) { return r.detail; }).join()),
    v.related.map(function (r) { return r.label + ' ' + r.value; }).join(', '));
  check('4e. Onderwerp: gerapporteerde oppervlakte dakpannen', v.related.every(function (r) {
    return r.subject === 'ROOF_TILES_REPORTED_AREA' && r.subjectText === 'Onderwerp: door bron/MJOP gerapporteerde oppervlakte dakpannen'; }), (v.related[0] || {}).subjectText);
  check('4f. Definitie wijkt mogelijk af van hellend dakoppervlak', v.related.every(function (r) { return /Definitie wijkt mogelijk af van hellend dakoppervlak/i.test(r.definition); }),
    (v.related[0] || {}).definition);
  check('4g. niet selecteerbaar (geen knop, data-selectable=false)', v.related.every(function (r) { return r.selectable === 'false' && r.buttons === 0; }));
  check('4h. DOC-005/DOC-006 één bron (geen onafhankelijke bevestiging)', v.related.every(function (r) { return /geen onafhankelijke bevestiging/.test(r.detail); }));
  check('4i. Bronverschil als andere definitie: +70,03 m² (+4,9%) t.o.v. 3D BAG — som van 15 panden', v.related.every(function (r) {
    return /Bronverschil t\.o\.v\. 3D BAG — som van 15 panden: \+70,03 m² \(\+4,9%\) — andere definitie/.test(r.diff); }), (v.related[0] || {}).diff);

  // 5. niets automatisch gekozen, geen gemiddelde
  check('5a. Niets automatisch gekozen: automatische pandwaarde 74,07 m² blijft effectief', auto(v).effective && auto(v).value === '74,07 m²' && !som.effective, auto(v).value);
  check('5b. Geen gemiddelde: kosten op 74,07 m²', /^74,07 m² × /.test(v.formula) && !/1\.4\d\d|1450/.test(v.formula), v.formula);
  var s0 = await saved(page, 'dak-hellend');
  check('5c. Geen keuze opgeslagen vóór de gebruiker kiest', s0.q && !s0.q.selected && !s0.q.manual);
  var poging = await page.evaluate(function (ids) {
    var Q = window.MJOPQuantity;
    var ws = JSON.parse(sessionStorage.getItem('mjop-worksessie'));
    var q = ws.plan.elements.filter(function (e) { return e.id === 'dak-hellend'; })[0].quantity;
    return ids.map(function (id) { return Q.selectEvidence(JSON.parse(JSON.stringify(q)), id); });
  }, v.related.map(function (r) { return r.id; }));
  check('5d. Dakpannen kunnen niet als ROOF_SLOPED_AREA gekozen worden (ander_onderwerp)', poging.length === 2 &&
    poging.every(function (p) { return p.ok === false && p.error === 'ander_onderwerp'; }), JSON.stringify(poging));
  check('5e. Alleen de 3D BAG-som heeft een kies-knop', som.selectButtons === 1 && v.rows.every(function (r) { return r.source !== 'IMPORTED_MJOP'; }));

  // 6. voor TESTDOELEINDEN expliciet de 3D BAG-som kiezen
  await page.click('[data-act=qty-select][data-ev="' + som.id + '"]');
  await page.waitForTimeout(150);
  v = await view(page);
  check('6. Expliciete keuze: 1415,57 m² gebruikt (CONFIRMED)', v.status === 'CONFIRMED' && /^1\.415,57 m² × /.test(v.formula), v.formula);
  var s1 = await saved(page, 'dak-hellend');
  var ev = s1.q.evidence.filter(function (e) { return e.subject_key === 'ROOF_SLOPED_AREA'; })[0] || {};
  check('6b. Opgeslagen: keuze = 3D BAG-som, 15 onderdelen, 2x dakpannen-context (niet kiesbaar)', s1.q.selected && s1.q.selected.evidenceId === ev.id &&
    ev.value === 1415.57 && ev.components.length === 15 &&
    s1.q.evidence.filter(function (e) { return e.subject_key === 'ROOF_TILES_REPORTED_AREA' && e.selectable === false; }).length === 2, JSON.stringify(s1.q.selected));

  // 7. herladen
  await page.reload();
  await page.waitForTimeout(300);
  await openElement(page, 'dak-hellend');
  var v2 = await view(page);
  check('7a. Na herladen: selectie blijft (1415,57, CONFIRMED, 15 onderdelen)', v2.status === 'CONFIRMED' && bag(v2).effective &&
    bag(v2).value === '1.415,57 m²' && bag(v2).comps === 15 && /^1\.415,57 m² × /.test(v2.formula), v2.formula);
  check('7b. Dakpannen-context blijft apart en niet kiesbaar', v2.related.length === 2 && v2.related.every(function (r) {
    return r.selectable === 'false' && r.buttons === 0 && r.subject === 'ROOF_TILES_REPORTED_AREA'; }) && !/1\.485/.test(v2.formula));
  await openElement(page, 'dak-plat');
  var vp2 = await view(page);
  check('7c. dak-plat onaangeroerd door de keuze op dak-hellend', vp2.status !== 'CONFIRMED' && auto(vp2).effective && vp2.related.length === 2, vp2.status);

  // 8. DOC-012: gemeten hellend dak 0 m² -> geen dak-hellend-post; de Maldenhof-bundel hoort er niet
  var ctx12 = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  var p12 = await ctx12.newPage();
  p12.on('pageerror', function (e) { errors.push(String(e)); });
  await blockOtherNetwork(p12, extern);
  await mockAddress(p12, SNAP12);
  check('8a. DOC-012-snapshot: b3_opp_dak_schuin is gemeten 0 (geen missing)', SNAP12.threedbag_attributes.b3_opp_dak_schuin === 0);
  await startPlan(p12, 'Meppelweg 819');
  await p12.click('[data-act=set-tab][data-tab=gebouw]');
  await p12.waitForTimeout(100);
  var r12 = await p12.evaluate(function () {
    var ws = JSON.parse(sessionStorage.getItem('mjop-worksessie'));
    return { row: !!document.querySelector('.gb-row[data-id="dak-hellend"]'), el: ws.plan.elements.some(function (e) { return e.id === 'dak-hellend'; }),
      plat: !!document.querySelector('.gb-row[data-id="dak-plat"]'), text: document.body.innerText };
  });
  check('8b. DOC-012: geen dak-hellend-post bij gemeten 0 m²; dak-plat wel', !r12.row && !r12.el && r12.plat);
  check('8c. DOC-012: 0 wordt niet als "niet beschikbaar" gemeld', !/b3_opp_dak_schuin ontbreekt/.test(r12.text));
  var u12 = await uploadBundle(p12, BUNDLE, 'maldenhof_expanded_v3.json');
  check('8d. Maldenhof-bundel wordt geweigerd in het DOC-012-plan (tenant-scheiding)', /15 panden/.test(u12.fout) && !u12.melding, u12.fout);
  await ctx12.close();

  var dataCalls = extern.filter(function (u) { return /pdok|kadaster|3dbag/i.test(u); });
  check('Geen echte PDOK/BAG/3D BAG-calls (nagebootst); overige externe requests geblokkeerd', dataCalls.length === 0, dataCalls.join(' | '));
  check('Geen JavaScript-fouten tijdens het testen', errors.length === 0, errors.join(' | '));
  await page.screenshot({ path: process.env.MJOP_SCREENSHOT || '/dev/null', fullPage: true }).catch(function () {});
  await browser.close();
  var fail = 0;
  checks.forEach(function (c) { console.log((c[1] ? 'OK  ' : 'FAIL') + ' - ' + c[0]); if (!c[1]) fail++; });
  if (fail) { console.log(fail + ' controle(s) mislukt.'); process.exitCode = 1; return; }
  console.log('Alle controles geslaagd.');
}

main().catch(function (e) { console.error(e); process.exitCode = 1; });
