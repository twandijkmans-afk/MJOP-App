'use strict';
// End-to-end: Building Element Inventory UI v1 (component-inventaris uit mjop-learning).
//   python3 -m http.server 8937 &   ;   node test/inventory-ui.spec.js

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
var PAND_ID = '0363100012070344'; // eerste pand van de Maldenhof-scope in de inventarisbundel
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
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ feature: { CityObjects: metKwaliteit(co) } }) });
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
  await page.click('[data-act=set-tab][data-tab=gebouw]');
  await page.waitForTimeout(100);
}

async function rows(page) {
  return page.evaluate(function () {
    return Array.prototype.map.call(document.querySelectorAll('[data-inv-comp]'), function (r) {
      return { comp: r.dataset.invComp, status: r.dataset.invStatus, source: r.dataset.invSource, question: !!r.querySelector('[data-inv-question]') };
    });
  });
}
async function planIds(page) {
  return page.evaluate(function () { return Array.prototype.map.call(document.querySelectorAll('.gb-row[data-act=open-element]'), function (r) { return r.dataset.id; }); });
}
async function subtitle(page) { return page.evaluate(function () { return document.querySelector('.page-sub').textContent; }); }
function bundleText(n) { return fs.readFileSync(path.join(__dirname, 'fixtures', 'inventory', n), 'utf8'); }
async function upload(page, text) {
  await page.setInputFiles('#inv-bundle-input', { name: 'inventory.json', mimeType: 'application/json', buffer: Buffer.from(text, 'utf8') });
  await page.waitForTimeout(250);
}
async function textOf(page, sel) { return page.evaluate(function (s) { var e = document.querySelector(s); return e ? e.textContent : null; }, sel); }

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
  var legacyIds = await planIds(page);
  var legacySub = await subtitle(page);
  check('legacy: plan zonder inventaris werkt (posten + importveld, geen inventarisrijen)', legacyIds.indexOf('dak-plat') !== -1 && (await rows(page)).length === 0 && !!(await page.$('#inv-bundle-input')), legacyIds.join(','));
  var legacyBlob = await page.evaluate(function () { return JSON.parse(sessionStorage.getItem('mjop-worksessie')).plan; });
  check('legacy: opgeslagen plan bevat geen inventory-sleutel', !('inventory' in legacyBlob));

  // verkeerde bundel
  await upload(page, bundleText('doc012_component_inventory_v1.json'));
  check('bundel van een ander pand wordt geweigerd', /hoort bij 1 pand/.test((await textOf(page, '[data-inv-fout]')) || ''), await textOf(page, '[data-inv-fout]'));

  await page.reload(); await page.waitForTimeout(300);
  await page.click('[data-act=set-tab][data-tab=gebouw]'); await page.waitForTimeout(100);
  await upload(page, bundleText('maldenhof_component_inventory_v1.json'));
  check('inventaris geladen', /Inventaris geladen \(22 bouwdelen\)/.test((await textOf(page, '[data-inv-melding]')) || ''), await textOf(page, '[data-inv-melding]'));
  var rs = await rows(page);
  var by = {}; rs.forEach(function (r) { by[r.comp] = r; });
  check('22 bouwdelen getoond', rs.length === 22);
  check('PRESENT toont aanwezig (✓) zonder vraag', by.ROOF_FLAT_COVERING.status === 'PRESENT' && !by.ROOF_FLAT_COVERING.question);
  check('UNKNOWN toont "Is dit onderdeel aanwezig?" (?)', by.LIFT_INSTALLATION.status === 'UNKNOWN' && by.LIFT_INSTALLATION.question);
  check('geen ABSENT zonder expliciet besluit', !rs.some(function (r) { return r.status === 'ABSENT'; }));
  check('JA / NEE / ONBEKEND-LATER knoppen aanwezig', (await page.$$('[data-inv-comp=LIFT_INSTALLATION] [data-act=inv-answer]')).length === 3);
  check('post lift: nog te bevestigen, blijft zichtbaar', /lift/i.test((await textOf(page, '[data-inv-result=lift]')) || '') && (await page.getAttribute('[data-inv-result=lift]', 'data-result')) === 'NEEDS_CONFIRMATION');
  var idsNa = await planIds(page);
  check('import wijzigt het plan niet (geen stille verwijdering) en kosten blijven gelijk', idsNa.join() === legacyIds.join() && (await subtitle(page)) === legacySub, (await subtitle(page)));
  check('intercom heeft badge "nog te bevestigen" in de lijst', !!(await page.$('.gb-row[data-id=intercom] [data-inv-badge]')));

  // handmatig NEE op intercom: alleen die post verdwijnt
  await page.click('[data-inv-comp=INTERCOM_INSTALLATION] [data-ans=NEE]'); await page.waitForTimeout(100);
  rs = await rows(page); by = {}; rs.forEach(function (r) { by[r.comp] = r; });
  var na = await planIds(page);
  check('NEE: USER_CONFIRMED_MANUAL ABSENT', by.INTERCOM_INSTALLATION.status === 'ABSENT' && by.INTERCOM_INSTALLATION.source === 'USER_CONFIRMED_MANUAL');
  check('NEE: alleen de intercom-post verdwijnt uit het plan', na.indexOf('intercom') === -1 && na.length === legacyIds.length - 1 && legacyIds.filter(function (i) { return na.indexOf(i) === -1; }).join() === 'intercom', na.join());
  check('NEE: post staat als niet van toepassing', (await page.getAttribute('[data-inv-result=intercom]', 'data-result')) === 'NOT_APPLICABLE');

  // blijft na herladen (plan-state)
  await page.reload(); await page.waitForTimeout(300);
  await page.click('[data-act=set-tab][data-tab=gebouw]'); await page.waitForTimeout(100);
  rs = await rows(page); by = {}; rs.forEach(function (r) { by[r.comp] = r; });
  check('keuze blijft staan na herladen', by.INTERCOM_INSTALLATION && by.INTERCOM_INSTALLATION.status === 'ABSENT' && (await planIds(page)).indexOf('intercom') === -1);

  // terugdraaien: ONBEKEND / LATER zet de post terug
  await page.click('[data-inv-comp=INTERCOM_INSTALLATION] [data-ans=LATER]'); await page.waitForTimeout(100);
  check('LATER: post komt terug, status UNKNOWN (handmatig vastgelegd)', (await planIds(page)).indexOf('intercom') !== -1 && (await page.getAttribute('[data-inv-comp=INTERCOM_INSTALLATION]', 'data-inv-status')) === 'UNKNOWN');
  await page.click('[data-inv-comp=LIFT_INSTALLATION] [data-ans=JA]'); await page.waitForTimeout(100);
  check('JA: lift PRESENT door gebruiker, post APPLICABLE', (await page.getAttribute('[data-inv-comp=LIFT_INSTALLATION]', 'data-inv-source')) === 'USER_CONFIRMED_MANUAL' && (await page.getAttribute('[data-inv-result=lift]', 'data-result')) === 'APPLICABLE');
  check('kosten na alle keuzes (intercom terug) gelijk aan legacy', (await subtitle(page)) === legacySub, await subtitle(page));

  // kozijnen
  await page.click('.gb-row[data-act=open-element][data-id=kozijnen-onderhoud]'); await page.waitForTimeout(150);
  var txt = (await textOf(page, '[data-koz-inventory]')) || '';
  check('kozijnen: Status Aanwezig', /Status: Aanwezig/.test(txt), txt);
  check('kozijnen: Materiaal Hout volgens bestaand MJOP', /Materiaal: Hout volgens bestaand MJOP/.test(txt));
  check('kozijnen: Gebouwtotaal nog onbekend', /Hoeveelheid: Gebouwtotaal nog onbekend/.test(txt));
  check('kozijnen: 11 zichtbare kozijnopeningen op één voorgevel-foto + 1 buitendeur', /11 zichtbare kozijnopeningen bevestigd op één voorgevel-foto/.test(txt) && /1 zichtbare buitendeur/.test(txt));
  check('kozijnen: legacy factor als gelabelde schatting, niet gemeten/bevestigd', /Schatting op basis van aantal appartementen/.test(txt) && (await textOf(page, '[data-koz-legacy]')) === 'Schatting op basis van aantal appartementen');
  check('kozijnen: legacy aantallen nog beschikbaar (+/- knoppen)', !!(await page.$('[data-act=koz-plus]')));
  check('kozijnen: 756,80 / ×15 / gebouwtotaal komen nergens voor', !/756|×\s*15/.test(txt));

  check('geen JS-fouten', errors.length === 0, errors.join('; '));
  await browser.close();
  var failed = checks.filter(function (c) { return !c[1]; });
  checks.forEach(function (c) { console.log((c[1] ? 'OK   - ' : 'FOUT - ') + c[0]); });
  console.log(failed.length ? failed.length + ' check(s) mislukt' : 'alle checks geslaagd');
  process.exit(failed.length ? 1 : 0);
}

main().catch(function (e) { console.error(e); process.exit(1); });

// Echte 3D BAG-antwoorden bevatten altijd b3_kwaliteitsindicator; de app neemt alleen bij true automatisch over.
// Mocks zonder die indicator krijgen hier true (zoals bij de echte panden in deze tests, gecontroleerd op 26-10-2026).
function metKwaliteit(co) {
  for (var k in co) if (co[k] && co[k].attributes && co[k].attributes.b3_kwaliteitsindicator === undefined) co[k].attributes = Object.assign({ b3_kwaliteitsindicator: true }, co[k].attributes);
  return co;
}
