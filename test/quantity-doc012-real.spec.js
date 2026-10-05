'use strict';
// End-to-end met ECHTE data: DOC-012 Quantity Bundle v3 (Meppelweg, één BAG-pand).
//
//   Meppelweg 819 (pand 0518100000354752) -> echte mjop-learning-bundel v3 importeren (dezelfde productieflow als
//   Maldenhof) -> dak-plat: 3D BAG 875,63 m² (plat dakoppervlak, voorstel) en apart de historische bron
//   (801,04 m², gerapporteerde dakbedekking, ander onderwerp, niet kiesbaar) -> niets automatisch gekozen, geen
//   gemiddelde -> voor TESTDOELEINDEN 3D BAG kiezen -> herladen en nieuwe sessie: keuze, 875,63 en de context
//   blijven, zonder vermenging. Daarna: v1-, v2- en de Maldenhof-v3-bundel werken nog.
//
// test/fixtures/real/ bevat een ongewijzigde kopie van de echte bundel en een uitsnede van de canonieke snapshot
// (zie test/fixtures/real/README.md). PDOK/BAG/3D BAG worden daarmee nagebootst; alle overige externe requests
// worden afgebroken. De keuze in deze test is alleen app-persistentie en wordt nergens teruggeschreven.
//
//   python3 -m http.server 8937 &   ;   node test/quantity-doc012-real.spec.js

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
var BUNDLE_FILE = path.join(REAL, 'doc012_meppelweg_v3.json');
var BUNDLE = fs.readFileSync(BUNDLE_FILE, 'utf8');
var BUNDLE_SHA256 = '748ebcbe53e83afc06fd4dba67467f1014d3cc88c728b55c56c3adfd33e0a191';
var SNAP = JSON.parse(fs.readFileSync(path.join(REAL, 'doc012_meppelweg_819_snapshot_excerpt.json'), 'utf8'));
var MALDENHOF = fs.readFileSync(path.join(REAL, 'maldenhof_DOC-005_DOC-006_v3.json'), 'utf8');
var V1 = fs.readFileSync(path.join(__dirname, 'fixtures', 'quantity-bundle.test.json'), 'utf8');
var V2 = fs.readFileSync(path.join(__dirname, 'fixtures', 'quantity-bundle-multipand.test.json'), 'utf8');
var PAND_ID = SNAP.bag_pand_id;
var PT = /POINT\(([\d.]+) ([\d.]+)\)/.exec(SNAP.address.centroide_ll);
var LON = Number(PT[1]), LAT = Number(PT[2]), D = 0.00005;

async function mockAddress(page, naam, centroid, pandId, props, attrs) {
  var m = /POINT\(([\d.]+) ([\d.]+)\)/.exec(centroid), lon = Number(m[1]), lat = Number(m[2]);
  await page.route('**/locatieserver/search/v3_1/suggest**', function (route) {
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ response: { docs: [{ id: 'adr-test', weergavenaam: naam }] } }) });
  });
  await page.route('**/locatieserver/search/v3_1/lookup**', function (route) {
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ response: { docs: [{ weergavenaam: naam, centroide_ll: centroid }] } }) });
  });
  await page.route('**/kadaster/bag/ogc/v2/collections/pand/items**', function (route) {
    var ring = [[lon - D, lat - D], [lon + D, lat - D], [lon + D, lat + D], [lon - D, lat + D], [lon - D, lat - D]];
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ features: [{ geometry: { type: 'Polygon', coordinates: [ring] },
      properties: { identificatie: pandId, bouwjaar: props.bouwjaar, gebruiksdoel: props.gebruiksdoel, aantal_verblijfsobjecten: props.aantal_verblijfsobjecten } }] }) });
  });
  await page.route('**/api.3dbag.nl/**', function (route) {
    var co = {};
    co['NL.IMBAG.Pand.' + pandId] = { attributes: attrs };
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ feature: { CityObjects: co } }) });
  });
}

function mockMeppelweg(page) {
  return mockAddress(page, SNAP.address.weergavenaam, SNAP.address.centroide_ll, PAND_ID, SNAP.bag_properties, SNAP.threedbag_attributes);
}

function mockGeneric(page) {
  return mockAddress(page, 'Teststraat 1, 1000AA Amsterdam', 'POINT(4.9 52.37)', '0363100012345678',
    { bouwjaar: 1972, gebruiksdoel: 'woonfunctie', aantal_verblijfsobjecten: 12 },
    { b3_opp_dak_plat: 312.64, b3_opp_dak_schuin: 0, b3_opp_buitenmuur: 1099.7, b3_opp_grond: 318.2, b3_bouwlagen: 4,
      b3_dak_type: 'horizontal', b3_h_dak_max: 13.4, b3_h_maaiveld: 0.6 });
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

async function openDakPlat(page) {
  await page.click('[data-act=set-tab][data-tab=gebouw]');
  await page.waitForTimeout(100);
  await page.click('.gb-row[data-act=open-element][data-id=dak-plat]');
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
        status: t(r, '[data-qty-related-status]'), detail: t(r, '[data-qty-source-detail]'), buttons: r.querySelectorAll('button').length };
    });
    return { status: p && p.dataset.qtyStatus, source: p && p.dataset.qtySource, statusLabel: t(document, '[data-qty-status-label]'),
      formula: t(document, '[data-qty-formula]'), rows: rows, related: related, relatedHeading: t(document, '[data-qty-related] > .label') };
  });
}

async function saved(page) {
  return page.evaluate(function () {
    var ws = JSON.parse(sessionStorage.getItem('mjop-worksessie'));
    return { plan: ws.plan, q: ws.plan.elements.filter(function (e) { return e.id === 'dak-plat'; })[0].quantity };
  });
}

function bundleRow(v) { return v.rows.filter(function (r) { return r.source === '3D_BAG' && r.id !== 'auto'; })[0] || {}; }

async function main() {
  var browser = await chromium.launch({ executablePath: CHROMIUM_PATH });
  var context = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  var page = await context.newPage();
  var errors = [], extern = [];
  page.on('pageerror', function (e) { errors.push(String(e)); });
  await blockOtherNetwork(page, extern);
  await mockMeppelweg(page);
  var checks = [];
  function check(naam, ok, info) { checks.push([naam + (info ? ' (' + info + ')' : ''), !!ok]); }

  check('Fixture is de ongewijzigde echte DOC-012-bundel (sha256)', crypto.createHash('sha256').update(fs.readFileSync(BUNDLE_FILE)).digest('hex') === BUNDLE_SHA256);
  var b = JSON.parse(BUNDLE);
  check('Echte bundel: v3, één pand, scope SINGLE_PAND BAG:' + PAND_ID, b.bundle_version === 'mjop_app_quantity_bundle_v3' &&
    b.building_id === 'BAG:' + PAND_ID && b.building_scope.kind === 'SINGLE_PAND' && b.building_scope.pand_count === 1);

  // 1. plan op Meppelweg 819
  await startPlan(page, 'Meppelweg 819');
  check('1. Plan voor Meppelweg 819 (pand ' + PAND_ID + ')', /Meppelweg 819/.test(await page.evaluate(function () { return document.body.innerText; })));

  // 2. echte bundel importeren
  var up = await uploadBundle(page, BUNDLE, 'doc012_meppelweg_v3.json');
  check('2. Import: 2 bronnen, waarvan 1 ter vergelijking; geen VvE-scope-tekst (één pand)',
    /^2 bronnen toegevoegd \(waarvan 1 ter vergelijking: ander onderwerp, niet kiesbaar\)\.$/.test(up.melding), up.melding || up.fout);

  // 3./4. dak-plat
  await openDakPlat(page);
  var v = await view(page);
  var auto = v.rows.filter(function (r) { return r.id === 'auto'; })[0] || {};
  var bag = bundleRow(v);
  check('4a. 3D BAG 875,63 m² (bundelbron, plat dakoppervlak)', bag.value === '875,63 m²' && bag.label === '3D BAG' && /onderwerp: plat dakoppervlak/.test(bag.detail), bag.label + ' / ' + bag.value);
  check('4b. voorstel / nog niet bevestigd', v.status === 'PROPOSED' && v.statusLabel === 'Voorstel' && /voorstel \(PROPOSED\) — nog niet bevestigd/.test(bag.detail), bag.detail);
  check('4c. Eén pandcomponent: bron verwijst naar pand ' + PAND_ID + ', pandniveau, geen som', /pand 0518100000354752/.test(bag.detail) &&
    bag.level === 'PAND' && bag.comps === 0 && !/som van/.test(bag.label) && bag.method === 'DIRECT_MEASURED', bag.detail);
  check('4d. Kop "Historische bron — ander onderwerp"', /^Historische bron — ander onderwerp/.test(v.relatedHeading), v.relatedHeading);
  var h = v.related[0] || {};
  check('4e. Historisch 801,04 m², oud MJOP, SOURCE_REPORTED, DOC-012 p. 7', v.related.length === 1 && h.value === '801,04 m²' &&
    h.source === 'IMPORTED_MJOP' && h.method === 'SOURCE_REPORTED' && /document DOC-012, p\. 7/.test(h.detail) && /Dakbedekking app/.test(h.detail), h.value + ' / ' + h.detail);
  check('4f. Onderwerp: door bron/MJOP gerapporteerde oppervlakte dakbedekking', h.subject === 'ROOF_COVERING_REPORTED_AREA' &&
    h.subjectText === 'Onderwerp: door bron/MJOP gerapporteerde oppervlakte dakbedekking', h.subjectText);
  check('4g. Definitie wijkt mogelijk af; niet selecteerbaar', /Definitie wijkt mogelijk af van plat dakoppervlak/.test(h.definition) &&
    h.selectable === 'false' && h.buttons === 0);
  check('4h. Bronverschil als andere definitie: -74,59 m² (-8,5%) t.o.v. 3D BAG', /Bronverschil t\.o\.v\. 3D BAG: -74,59 m² \(-8,5%\) — andere definitie/.test(h.diff), h.diff);
  check('4i. Geen onafhankelijkheidswaarschuwing nodig (geen verwant document)', !/ook in /.test(h.detail));

  // niets automatisch, geen gemiddelde, historisch niet kiesbaar
  check('6a. Niets automatisch gekozen: automatische waarde 875,63 effectief', auto.effective && auto.value === '875,63 m²' && !bag.effective, auto.value);
  check('6b. Geen gemiddelde: kosten op 875,63 × € 165', /^875,63 m² × € 165/.test(v.formula) && !/838/.test(v.formula), v.formula);
  var s0 = await saved(page);
  check('6c. Geen keuze opgeslagen', !s0.q.selected && !s0.q.manual && s0.q.status === 'PROPOSED');
  var poging = await page.evaluate(function (id) {
    var ws = JSON.parse(sessionStorage.getItem('mjop-worksessie'));
    var q = ws.plan.elements.filter(function (e) { return e.id === 'dak-plat'; })[0].quantity;
    return window.MJOPQuantity.selectEvidence(q, id);
  }, h.id);
  check('6d. Historische bron kan niet als ROOF_FLAT_AREA gekozen worden', poging.ok === false && poging.error === 'ander_onderwerp', JSON.stringify(poging));
  check('6e. Alleen de 3D BAG-bundelbron heeft een kies-knop; historisch niet bij de kiesbare bronnen',
    bag.selectButtons === 1 && v.rows.every(function (r) { return r.source !== 'IMPORTED_MJOP'; }));
  var ev = s0.q.evidence.filter(function (e) { return e.subject_key === 'ROOF_FLAT_AREA'; })[0] || {};
  check('6f. Provenance bewaard: pand, regel, scope', ev.source_ref && ev.source_ref.bag_pand_id === PAND_ID && ev.source_ref.rule_id === 'bag3d.roof_flat_area' && !ev.scope_level,
    JSON.stringify(ev.source_ref && { pand: ev.source_ref.bag_pand_id, rule: ev.source_ref.rule_id }));

  // 7. voor TESTDOELEINDEN expliciet 3D BAG kiezen
  await page.click('[data-act=qty-select][data-ev="' + bag.id + '"]');
  await page.waitForTimeout(150);
  v = await view(page);
  check('7. Expliciete keuze: 3D BAG-bundelbron gebruikt (CONFIRMED, 875,63 × € 165)', v.status === 'CONFIRMED' && bundleRow(v).effective &&
    /^875,63 m² × € 165/.test(v.formula), v.formula);
  var s1 = await saved(page);
  check('8. Opgeslagen: keuze = 3D BAG, historische context niet kiesbaar', s1.q.selected && s1.q.selected.evidenceId === bag.id &&
    s1.q.evidence.filter(function (e) { return e.subject_key === 'ROOF_COVERING_REPORTED_AREA' && e.selectable === false && e.value === 801.04; }).length === 1);

  // 9./10. herladen
  await page.reload();
  await page.waitForTimeout(300);
  await openDakPlat(page);
  var v2 = await view(page);
  check('10a. Na herladen: keuze blijft, 875,63', v2.status === 'CONFIRMED' && v2.source === '3D_BAG' && bundleRow(v2).effective &&
    bundleRow(v2).value === '875,63 m²', v2.status);
  check('10b. Historische context 801,04 blijft apart en niet kiesbaar', v2.related.length === 1 && v2.related[0].value === '801,04 m²' &&
    v2.related[0].selectable === 'false' && v2.related[0].buttons === 0);
  check('10c. Geen semantische vermenging', v2.rows.every(function (r) { return r.source !== 'IMPORTED_MJOP'; }) && !/801/.test(v2.formula));

  // nieuwe sessie met het opgeslagen plan-blob (zoals 'Openen')
  var s2 = await saved(page);
  var ctx2 = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  var page2 = await ctx2.newPage();
  page2.on('pageerror', function (e) { errors.push(String(e)); });
  await blockOtherNetwork(page2, extern);
  await mockMeppelweg(page2);
  await page2.goto(APP_URL);
  await page2.evaluate(function (blob) {
    sessionStorage.setItem('mjop-worksessie', JSON.stringify({ screen: 'app', tab: 'gebouw', currentPlanId: null, lastSavedSnapshot: null, plan: blob }));
  }, s2.plan);
  await page2.reload();
  await page2.waitForTimeout(300);
  await openDakPlat(page2);
  var v3 = await view(page2);
  check('10d. Nieuwe sessie: keuze, 875,63 en context 801,04 blijven', v3.status === 'CONFIRMED' && bundleRow(v3).effective &&
    bundleRow(v3).value === '875,63 m²' && v3.related.length === 1 && v3.related[0].value === '801,04 m²');
  // Maldenhof-bundel hoort niet bij dit pand
  up = await uploadBundle(page2, MALDENHOF, 'maldenhof.json');
  check('Maldenhof-bundel wordt geweigerd in het DOC-012-plan (andere scope)', /15 panden/.test(up.fout) && new RegExp(PAND_ID).test(up.fout), up.fout);
  await ctx2.close();

  // v1/v2-bundels blijven werken; DOC-012-bundel geweigerd buiten het pand
  var ctx3 = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  var p3 = await ctx3.newPage();
  p3.on('pageerror', function (e) { errors.push(String(e)); });
  await blockOtherNetwork(p3, extern);
  await mockGeneric(p3);
  await startPlan(p3, 'Teststraat 1');
  var u1 = await uploadBundle(p3, V1, 'v1.json');
  check('v1-bundel importeert nog', /^2 bronnen toegevoegd/.test(u1.melding), u1.melding || u1.fout);
  var u2 = await uploadBundle(p3, V2, 'v2.json');
  check('v2-bundel importeert nog', /VvE-scope van 3 panden/.test(u2.melding), u2.melding || u2.fout);
  var u3 = await uploadBundle(p3, BUNDLE, 'doc012.json');
  check('DOC-012-bundel wordt geweigerd in een plan voor een ander pand', /hoort bij pand 0518100000354752/.test(u3.fout), u3.fout);
  await ctx3.close();

  var dataCalls = extern.filter(function (u) { return /pdok|kadaster|3dbag/i.test(u); });
  check('Geen echte PDOK/BAG/3D BAG-calls; overige externe requests geblokkeerd', dataCalls.length === 0, dataCalls.join(' | '));
  check('Geen JavaScript-fouten tijdens het testen', errors.length === 0, errors.join(' | '));
  await page.screenshot({ path: process.env.MJOP_SCREENSHOT || '/dev/null', fullPage: true }).catch(function () {});
  await browser.close();
  var fail = 0;
  checks.forEach(function (c) { console.log((c[1] ? 'OK  ' : 'FAIL') + ' - ' + c[0]); if (!c[1]) fail++; });
  if (fail) { console.log(fail + ' controle(s) mislukt.'); process.exitCode = 1; return; }
  console.log('Alle controles geslaagd.');
}

main().catch(function (e) { console.error(e); process.exitCode = 1; });
