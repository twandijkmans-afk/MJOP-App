'use strict';
// End-to-end met ECHTE data: Maldenhof Quantity Bundle v3.
//
//   Maldenhof 240 (pand 0363100012137996, één van de 15 bevestigde panden) -> echte mjop-learning-bundel v3
//   importeren -> dak-plat: 3D BAG-som van 15 panden (190,65 m², plat dakoppervlak, voorstel) en apart de
//   historische bron (425,80 m², gerapporteerde dakbedekking, ander onderwerp, niet kiesbaar) -> 'Bron bekijken'
//   met 15 pandwaarden -> niets automatisch gekozen, geen gemiddelde -> voor TESTDOELEINDEN de 3D BAG-som kiezen
//   -> opslaan/herladen -> keuze, 190,65, 15 onderdelen en de historische context blijven, zonder vermenging.
//
// test/fixtures/real/ bevat een ongewijzigde kopie van de echte bundel en een uitsnede van de canonieke
// BAG/3D BAG-snapshot (zie test/fixtures/real/README.md). PDOK/BAG/3D BAG worden met die data nagebootst: geen
// netwerkcalls. De keuze in deze test is alleen app-persistentie en wordt nergens teruggeschreven.
//
//   python3 -m http.server 8937 &   ;   node test/quantity-maldenhof-real.spec.js

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
var BUNDLE = fs.readFileSync(path.join(REAL, 'maldenhof_DOC-005_DOC-006_v3.json'), 'utf8');
var BUNDLE_SHA256 = 'b1ca1d196eb720744ca7dc0fd2a71a59f350bf4dfa0ff2cde4f81fbe3a4a1933';
var SNAP = JSON.parse(fs.readFileSync(path.join(REAL, 'maldenhof_240_snapshot_excerpt.json'), 'utf8'));
var V1 = fs.readFileSync(path.join(__dirname, 'fixtures', 'quantity-bundle.test.json'), 'utf8');
var V2 = fs.readFileSync(path.join(__dirname, 'fixtures', 'quantity-bundle-multipand.test.json'), 'utf8');
var PAND_ID = SNAP.bag_pand_id;
var PT = /POINT\(([\d.]+) ([\d.]+)\)/.exec(SNAP.address.centroide_ll);
var LON = Number(PT[1]), LAT = Number(PT[2]), D = 0.00005;

async function mockMaldenhof(page) {
  var naam = SNAP.address.weergavenaam;
  await page.route('**/locatieserver/search/v3_1/suggest**', function (route) {
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ response: { docs: [{ id: 'adr-maldenhof-240', weergavenaam: naam }] } }) });
  });
  await page.route('**/locatieserver/search/v3_1/lookup**', function (route) {
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ response: { docs: [{ weergavenaam: naam, centroide_ll: SNAP.address.centroide_ll }] } }) });
  });
  await page.route('**/kadaster/bag/ogc/v2/collections/pand/items**', function (route) {
    var ring = [[LON - D, LAT - D], [LON + D, LAT - D], [LON + D, LAT + D], [LON - D, LAT + D], [LON - D, LAT - D]];
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ features: [{ geometry: { type: 'Polygon', coordinates: [ring] },
      properties: { identificatie: PAND_ID, bouwjaar: SNAP.bag_properties.bouwjaar, gebruiksdoel: SNAP.bag_properties.gebruiksdoel,
        aantal_verblijfsobjecten: SNAP.bag_properties.aantal_verblijfsobjecten } }] }) });
  });
  await page.route('**/api.3dbag.nl/**', function (route) {
    var co = {};
    co['NL.IMBAG.Pand.' + PAND_ID] = { attributes: SNAP.threedbag_attributes };
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ feature: { CityObjects: co } }) });
  });
}

async function mockGeneric(page) {
  // voor de oude v1/v2-bundels (synthetisch pand 0363100012345678)
  var lon = 4.9, lat = 52.37, d = 0.0001;
  await page.route('**/locatieserver/search/v3_1/suggest**', function (route) {
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ response: { docs: [{ id: 'adr-1', weergavenaam: 'Teststraat 1, 1000AA Amsterdam' }] } }) });
  });
  await page.route('**/locatieserver/search/v3_1/lookup**', function (route) {
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ response: { docs: [{ weergavenaam: 'Teststraat 1, 1000AA Amsterdam', centroide_ll: 'POINT(' + lon + ' ' + lat + ')' }] } }) });
  });
  await page.route('**/kadaster/bag/ogc/v2/collections/pand/items**', function (route) {
    var ring = [[lon - d, lat - d], [lon + d, lat - d], [lon + d, lat + d], [lon - d, lat + d], [lon - d, lat - d]];
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ features: [{ geometry: { type: 'Polygon', coordinates: [ring] },
      properties: { identificatie: '0363100012345678', bouwjaar: 1972, gebruiksdoel: 'woonfunctie', aantal_verblijfsobjecten: 12 } }] }) });
  });
  await page.route('**/api.3dbag.nl/**', function (route) {
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ feature: { CityObjects: { 'NL.IMBAG.Pand.0363100012345678': { attributes: {
      b3_opp_dak_plat: 312.64, b3_opp_dak_schuin: 0, b3_opp_buitenmuur: 1099.7, b3_opp_grond: 318.2, b3_bouwlagen: 4, b3_dak_type: 'horizontal',
      b3_h_dak_max: 13.4, b3_h_maaiveld: 0.6 } } } } }) });
  });
}

async function blockOtherNetwork(page, log) {
  // alles wat niet lokaal of nagebootst is, wordt geweigerd en gelogd (geen echte netwerkcalls)
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
        diff: t(r, '[data-qty-source-diff]'), detail: t(r, '[data-qty-source-detail]'), summary: t(r, '[data-qty-components] summary'),
        comps: Array.prototype.map.call(r.querySelectorAll('[data-qty-component]'), function (c) { return { pand: c.dataset.qtyComponent, text: c.textContent }; }),
        selectButtons: r.querySelectorAll('[data-act=qty-select]').length };
    });
    var related = Array.prototype.map.call(document.querySelectorAll('[data-qty-related-row]'), function (r) {
      return { id: r.dataset.qtyRelatedRow, source: r.dataset.source, subject: r.dataset.subject, selectable: r.dataset.selectable,
        level: r.dataset.scopeLevel, method: r.dataset.method || '', label: t(r, '[data-qty-source-label]'), value: t(r, '[data-qty-source-value]'),
        subjectText: t(r, '[data-qty-related-subject]'), definition: t(r, '[data-qty-related-definition]'), diff: t(r, '[data-qty-related-diff]'),
        status: t(r, '[data-qty-related-status]'), detail: t(r, '[data-qty-source-detail]'), buttons: r.querySelectorAll('button').length };
    });
    return { status: p && p.dataset.qtyStatus, source: p && p.dataset.qtySource, statusLabel: t(document, '[data-qty-status-label]'),
      formula: t(document, '[data-qty-formula]'), rows: rows, related: related,
      relatedHeading: t(document, '[data-qty-related] > .label') };
  });
}

async function saved(page) {
  return page.evaluate(function () {
    var ws = JSON.parse(sessionStorage.getItem('mjop-worksessie'));
    var el = ws.plan.elements.filter(function (e) { return e.id === 'dak-plat'; })[0];
    return { plan: ws.plan, q: el.quantity };
  });
}

async function main() {
  var browser = await chromium.launch({ executablePath: CHROMIUM_PATH });
  var context = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  var page = await context.newPage();
  var errors = [], extern = [];
  page.on('pageerror', function (e) { errors.push(String(e)); });
  await blockOtherNetwork(page, extern);
  await mockMaldenhof(page);
  var checks = [];
  function check(naam, ok, info) { checks.push([naam + (info ? ' (' + info + ')' : ''), !!ok]); }

  check('Fixture is de ongewijzigde echte bundel (sha256)', crypto.createHash('sha256').update(fs.readFileSync(path.join(REAL, 'maldenhof_DOC-005_DOC-006_v3.json'))).digest('hex') === BUNDLE_SHA256);
  var b = JSON.parse(BUNDLE);
  check('Echte bundel: v3, 15 panden, plan-pand in de scope', b.bundle_version === 'mjop_app_quantity_bundle_v3' && b.bag_pand_ids.length === 15 &&
    b.bag_pand_ids.indexOf(PAND_ID) !== -1, b.bundle_version);

  // 1. Maldenhof-plan met een pand uit de scope
  await startPlan(page, 'Maldenhof 240');
  var gebouw = await page.evaluate(function () { return document.body.innerText; });
  check('1. Plan voor Maldenhof 240 (pand ' + PAND_ID + ')', /Maldenhof 240/.test(gebouw));

  // 2. echte bundel importeren
  var up = await uploadBundle(page, BUNDLE, 'maldenhof_DOC-005_DOC-006_v3.json');
  check('2. Import: 3 bronnen, waarvan 2 ter vergelijking; VvE-scope van 15 panden',
    /^3 bronnen toegevoegd \(waarvan 2 ter vergelijking: ander onderwerp, niet kiesbaar\)/.test(up.melding) && /VvE-scope van 15 panden/.test(up.melding), up.melding || up.fout);

  // 3./4. dak-plat
  await openDakPlat(page);
  var v = await view(page);
  var auto = v.rows.filter(function (r) { return r.id === 'auto'; })[0] || {};
  var som = v.rows.filter(function (r) { return r.source === '3D_BAG' && r.id !== 'auto'; })[0] || {};
  check('4a. 3D BAG — som van 15 panden, 190,65 m²', /3D BAG — som van 15 panden/.test(som.label) && som.value === '190,65 m²', som.label + ' / ' + som.value);
  check('4b. onderwerp plat dakoppervlak, GEOMETRY_DERIVED, complexniveau', /onderwerp: plat dakoppervlak/.test(som.detail) &&
    som.method === 'GEOMETRY_DERIVED' && som.level === 'COMPLEX', som.detail);
  check('4c. PROPOSED / nog niet bevestigd', v.status === 'PROPOSED' && /voorstel \(PROPOSED\) — nog niet bevestigd/.test(som.detail) && v.statusLabel === 'Voorstel', v.status + ' / ' + v.statusLabel);
  check('4d. Kop "Historische bron — ander onderwerp"', /^Historische bron — ander onderwerp/.test(v.relatedHeading), v.relatedHeading);
  check('4e. Historisch 425,80 m² (DOC-005 en DOC-006), oud MJOP, complexniveau, SOURCE_REPORTED', v.related.length === 2 &&
    v.related.every(function (r) { return r.value === '425,80 m²'; }) &&
    v.related.every(function (r) { return r.source === 'IMPORTED_MJOP' && r.level === 'COMPLEX' && r.method === 'SOURCE_REPORTED'; }) &&
    /document DOC-005/.test(v.related.map(function (r) { return r.detail; }).join()) && /document DOC-006/.test(v.related.map(function (r) { return r.detail; }).join()),
    v.related.map(function (r) { return r.value; }).join(', '));
  check('4f. gerapporteerde dakbedekking', v.related.every(function (r) { return r.subject === 'ROOF_COVERING_REPORTED_AREA' && r.subjectText === 'Onderwerp: door bron/MJOP gerapporteerde oppervlakte dakbedekking'; }));
  check('4g. Definitie wijkt mogelijk af', v.related.every(function (r) { return /Definitie wijkt mogelijk af van plat dakoppervlak/.test(r.definition); }));
  check('4h. niet selecteerbaar (geen knop, data-selectable=false)', v.related.every(function (r) { return r.selectable === 'false' && r.buttons === 0; }));
  check('4i. DOC-005/DOC-006 afhankelijkheid zichtbaar (geen onafhankelijke bevestiging)', v.related.every(function (r) { return /geen onafhankelijke bevestiging/.test(r.detail); }));
  check('4j. Bronverschil als andere definitie: +235,15 m² t.o.v. 3D BAG — som van 15 panden', v.related.every(function (r) {
    return /Bronverschil t\.o\.v\. 3D BAG — som van 15 panden: \+235,15 m² \(\+123,3%\) — andere definitie/.test(r.diff); }), (v.related[0] || {}).diff);

  // 5. Bron bekijken: 15 pandwaarden
  await page.click('[data-qty-source-row="' + som.id + '"] [data-qty-components] summary');
  var comps = som.comps;
  var bundlePrim = b.entries.filter(function (e) { return e.role === 'PRIMARY'; })[0].evidence;
  var verwacht = bundlePrim.components.map(function (c) { return c.bag_pand_id; }).sort();
  check('5. Bron bekijken (15 panden): alle 15 pandwaarden', /Bron bekijken \(15 panden\)/.test(som.summary) && comps.length === 15 &&
    JSON.stringify(comps.map(function (c) { return c.pand; }).sort()) === JSON.stringify(verwacht), som.summary);
  var sum = bundlePrim.components.reduce(function (s, c) { return s + Math.round(Number(c.value) * 100); }, 0);
  check('5b. pandwaarden tellen exact op tot 190,65 (in centen)', sum === 19065 && comps.some(function (c) { return /0363100012137996: 12,74/.test(c.text); }), String(sum));

  // 6. niets automatisch, geen gemiddelde, historisch niet kiesbaar als ROOF_FLAT_AREA
  check('6a. Niets automatisch gekozen: automatische pandwaarde 12,74 m² blijft effectief', auto.effective && auto.value === '12,74 m²' && !som.effective, auto.value);
  check('6b. Geen gemiddelde: kosten op 12,74 × € 165', /^12,74 m² × € 165/.test(v.formula) && !/308/.test(v.formula), v.formula);
  var s0 = await saved(page);
  check('6c. Geen keuze opgeslagen vóór de gebruiker kiest', !s0.q.selected && !s0.q.manual && s0.q.status === 'PROPOSED');
  var poging = await page.evaluate(function (ids) {
    var Q = window.MJOPQuantity, el = null;
    var ws = JSON.parse(sessionStorage.getItem('mjop-worksessie'));
    var q = ws.plan.elements.filter(function (e) { return e.id === 'dak-plat'; })[0].quantity;
    return ids.map(function (id) { return Q.selectEvidence(JSON.parse(JSON.stringify(q)), id); });
  }, v.related.map(function (r) { return r.id; }));
  check('6d. Historische bron kan niet als ROOF_FLAT_AREA gekozen worden (ander_onderwerp)', poging.every(function (p) { return p.ok === false && p.error === 'ander_onderwerp'; }), JSON.stringify(poging));
  check('6e. Alleen de 3D BAG-som heeft een kies-knop', som.selectButtons === 1 && v.rows.every(function (r) { return r.source !== 'IMPORTED_MJOP'; }));

  // 7. voor TESTDOELEINDEN expliciet de 3D BAG-som kiezen in de UI
  await page.click('[data-act=qty-select][data-ev="' + som.id + '"]');
  await page.waitForTimeout(150);
  v = await view(page);
  check('7. Expliciete keuze: 190,65 m² gebruikt (CONFIRMED, 190,65 × € 165)', v.status === 'CONFIRMED' && /^190,65 m² × € 165/.test(v.formula), v.formula);

  // 8. opslaan: het plan-blob (serializePlan, hetzelfde blob dat 'Opslaan' naar saved_plans stuurt) in de werksessie
  var s1 = await saved(page);
  var bag = s1.q.evidence.filter(function (e) { return e.subject_key === 'ROOF_FLAT_AREA'; })[0] || {};
  check('8. Opgeslagen: keuze = 3D BAG-som, 15 onderdelen, 2 x historische context (niet kiesbaar)',
    s1.q.selected && s1.q.selected.evidenceId === bag.id && bag.value === 190.65 && bag.components.length === 15 &&
    s1.q.evidence.filter(function (e) { return e.subject_key === 'ROOF_COVERING_REPORTED_AREA' && e.selectable === false; }).length === 2, JSON.stringify(s1.q.selected));

  // 9. herladen (zelfde tabblad)
  await page.reload();
  await page.waitForTimeout(300);
  await openDakPlat(page);
  var v2 = await view(page);
  var som2 = v2.rows.filter(function (r) { return r.source === '3D_BAG' && r.id !== 'auto'; })[0] || {};
  // 10. controles na herladen
  check('10a. Na herladen: selectie blijft bewaard', v2.status === 'CONFIRMED' && v2.source === '3D_BAG' && som2.effective, v2.status);
  check('10b. 190,65 blijft', som2.value === '190,65 m²' && /^190,65 m² × € 165/.test(v2.formula), v2.formula);
  check('10c. 15 onderdelen blijven', som2.comps.length === 15);
  check('10d. Historische 425,80-context blijft, apart en niet kiesbaar', v2.related.length === 2 && v2.related.every(function (r) {
    return r.selectable === 'false' && r.buttons === 0 && r.subject === 'ROOF_COVERING_REPORTED_AREA'; }));
  check('10e. Geen semantische vermenging: geen historische bron tussen de kiesbare bronnen; kosten niet op 425,80',
    v2.rows.every(function (r) { return r.source !== 'IMPORTED_MJOP'; }) && !/425/.test(v2.formula));

  // opgeslagen plan in een nieuw tabblad/context openen (zoals 'open-plan' met applyPlanBlob)
  var s2 = await saved(page);
  var ctx2 = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  var page2 = await ctx2.newPage();
  page2.on('pageerror', function (e) { errors.push(String(e)); });
  await blockOtherNetwork(page2, extern);
  await mockMaldenhof(page2);
  await page2.goto(APP_URL);
  await page2.evaluate(function (blob) {
    sessionStorage.setItem('mjop-worksessie', JSON.stringify({ screen: 'app', tab: 'gebouw', currentPlanId: null, lastSavedSnapshot: null, plan: blob }));
  }, s2.plan);
  await page2.reload();
  await page2.waitForTimeout(300);
  await openDakPlat(page2);
  var v3 = await view(page2);
  var som3 = v3.rows.filter(function (r) { return r.source === '3D_BAG' && r.id !== 'auto'; })[0] || {};
  check('10f. Opgeslagen plan in een nieuwe sessie: keuze, 190,65, 15 onderdelen en context blijven', v3.status === 'CONFIRMED' &&
    som3.effective && som3.value === '190,65 m²' && som3.comps.length === 15 && v3.related.length === 2, v3.status);
  await ctx2.close();

  // oude v1/v2-bundels blijven werken
  var ctx3 = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  var p3 = await ctx3.newPage();
  p3.on('pageerror', function (e) { errors.push(String(e)); });
  await blockOtherNetwork(p3, extern);
  await mockGeneric(p3);
  await startPlan(p3, 'Teststraat 1');
  var u1 = await uploadBundle(p3, V1, 'v1.json');
  check('v1-bundel importeert nog (2 bronnen, geen context)', /^2 bronnen toegevoegd/.test(u1.melding) && !/ter vergelijking/.test(u1.melding), u1.melding || u1.fout);
  var u2 = await uploadBundle(p3, V2, 'v2.json');
  check('v2-bundel importeert nog (VvE-scope van 3 panden, geen context)', /VvE-scope van 3 panden/.test(u2.melding) && !/ter vergelijking/.test(u2.melding), u2.melding || u2.fout);
  var u3 = await uploadBundle(p3, BUNDLE, 'maldenhof.json');
  check('Echte Maldenhof-bundel wordt geweigerd in een plan buiten de scope', /15 panden/.test(u3.fout) && /0363100012345678/.test(u3.fout), u3.fout);
  await ctx3.close();

  // Alles buiten localhost wordt afgebroken (niet opgehaald): CDN-assets, fonts en de CBS-index worden dus
  // geblokkeerd. PDOK/BAG/3D BAG worden nagebootst; er mag geen enkele zo'n call ongemockt zijn gebleven.
  var dataCalls = extern.filter(function (u) { return /pdok|kadaster|3dbag/i.test(u); });
  check('Geen echte PDOK/BAG/3D BAG-calls (nagebootst met de canonieke snapshot); overige externe requests geblokkeerd',
    dataCalls.length === 0, dataCalls.join(' | ') + ' [geblokkeerd overig: ' + extern.length + ']');
  check('Geen JavaScript-fouten tijdens het testen', errors.length === 0, errors.join(' | '));
  await page.screenshot({ path: process.env.MJOP_SCREENSHOT || '/dev/null', fullPage: true }).catch(function () {});
  await browser.close();
  var fail = 0;
  checks.forEach(function (c) { console.log((c[1] ? 'OK  ' : 'FAIL') + ' - ' + c[0]); if (!c[1]) fail++; });
  if (fail) { console.log(fail + ' controle(s) mislukt.'); process.exitCode = 1; return; }
  console.log('Alle controles geslaagd.');
}

main().catch(function (e) { console.error(e); process.exitCode = 1; });
