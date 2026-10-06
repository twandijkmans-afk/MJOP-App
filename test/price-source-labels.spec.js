'use strict';
// Browsertest: prijsbron-labels (Kengetal Product Bridge Review v1).
//
// De standaardprijzen van de app zijn app-schattingen zonder vastgelegd prijspeil. De UI mag ze niet presenteren
// als onderbouwde kengetallen of als "prijspeil <huidig jaar>", en mag niet beweren dat een offerte het tarief
// overschrijft (offertes worden alleen getoond en vergeleken). Posten per appartement tonen geen m² in de formule.
// Bedragen zelf blijven ongewijzigd. PDOK/BAG/3D BAG worden nagebootst: geen netwerkcalls.
//
//   python3 -m http.server 8937 &   ;   node test/price-source-labels.spec.js

let chromium;
try {
  chromium = require('playwright').chromium;
} catch (e) {
  chromium = require('/opt/node22/lib/node_modules/playwright').chromium;
}

var APP_URL = process.env.MJOP_TEST_URL || 'http://localhost:8937/index.html';
var CHROMIUM_PATH = process.env.MJOP_CHROMIUM || '/opt/pw-browsers/chromium';
var PAND_ID = '0363100012345678', LON = 4.9, LAT = 52.37, D = 0.0001;
var ATTRS = { b3_opp_dak_plat: 312.64, b3_opp_dak_schuin: 0, b3_opp_buitenmuur: 1099.7, b3_opp_grond: 318.2, b3_bouwlagen: 4,
  b3_dak_type: 'horizontal', b3_h_dak_max: 13.4, b3_h_maaiveld: 0.6 };
var JAAR = new Date().getFullYear();

async function mockApis(page) {
  await page.route(/^https?:\/\/(?!localhost)/, function (route) { route.abort(); });
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
    co['NL.IMBAG.Pand.' + PAND_ID] = { attributes: ATTRS };
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ feature: { CityObjects: co } }) });
  });
}

async function tab(page, naam) { await page.click('[data-act=set-tab][data-tab=' + naam + ']'); await page.waitForTimeout(120); }
async function openEl(page, id) { await tab(page, 'gebouw'); await page.click('.gb-row[data-act=open-element][data-id=' + id + ']'); await page.waitForTimeout(120); }
async function text(page) { return page.evaluate(function () { return document.body.innerText; }); }
async function formula(page) { return page.evaluate(function () { return (document.querySelector('[data-qty-formula]') || {}).textContent || ''; }); }

async function main() {
  var browser = await chromium.launch({ executablePath: CHROMIUM_PATH });
  var ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  var page = await ctx.newPage();
  page.setDefaultTimeout(8000);
  var errors = [], checks = [];
  page.on('pageerror', function (e) { errors.push(String(e)); });
  function check(naam, ok, info) { checks.push([naam + (info ? ' (' + info + ')' : ''), !!ok]); }
  await mockApis(page);

  await page.goto(APP_URL);
  await page.waitForTimeout(150);
  var start = await text(page);
  check('Startscherm: geen "Kengetallen zijn indicatieve richtprijzen"; wel "app-schattingen"', !/Kengetallen zijn indicatieve richtprijzen/.test(start));
  await page.click('[data-act=goto-onboarding]').catch(function () {});
  await page.waitForTimeout(150);
  var onboarding = await text(page);
  check('Onboarding-voetnoot: "Prijzen zijn indicatieve app-schattingen"', /Prijzen zijn indicatieve app-schattingen/.test(onboarding) && !/Kengetallen zijn indicatieve/.test(onboarding));
  await page.fill('#addr-search', 'Teststraat 1');
  await page.waitForSelector('.suggest-row', { timeout: 5000 });
  await page.click('.suggest-row');
  await page.waitForSelector('[data-act=set-tab][data-tab=gebouw]', { timeout: 8000 });

  await tab(page, 'home');
  var note = await page.evaluate(function () { return (document.querySelector('.ov-hint[data-price-source-note]') || {}).textContent || ''; });
  check('Overzicht: app-schattingen, geen onderbouwd kengetal, zonder vastgelegd prijspeil', /indicatieve app-schattingen/.test(note) &&
    /geen onderbouwd kengetal/.test(note) && /zonder vastgelegd prijspeil/.test(note) && note.indexOf('prijspeil ' + JAAR) === -1, note);

  await openEl(page, 'kozijnen-onderhoud');
  var koz = await text(page);
  check('Kozijnen: geen onjuiste claim dat een offerte het tarief overschrijft', !/een offerte overschrijft het tarief/.test(koz) &&
    /Offertes worden ter vergelijking getoond en veranderen het tarief niet automatisch/.test(koz));

  await openEl(page, 'dakgoten');
  var f = await formula(page);
  check('Dakgoten (per appartement): formule in app., niet m² — bedrag ongewijzigd (€ 300 + 12 × € 90 = € 1.380)', f === '€ 300 vast + 12 app. × € 90 = € 1.380 per keer', f);
  await openEl(page, 'riolering');
  f = await formula(page);
  check('Riolering: € 1.100 + 12 app. × € 120 = € 2.540', f === '€ 1.100 vast + 12 app. × € 120 = € 2.540 per keer', f);
  await openEl(page, 'dakinspectie');
  f = await formula(page);
  check('Dakinspectie (op dakoppervlak) blijft m²: € 420 + 312,64 m² × € 2', f === '€ 420 vast + 312,64 m² × € 2 = € 1.045 per keer', f);
  await openEl(page, 'gevel-metselwerk');
  f = await formula(page);
  check('Gevel-metselwerk: bedrag ongewijzigd (1.099,7 m² × € 26)', f === '1.099,7 m² × € 26 = € 28.592 per keer', f);

  await tab(page, 'rapport').catch(function () {});
  await browser.close();
  check('Geen JavaScript-fouten tijdens het testen', errors.length === 0, errors.join(' | '));
  var fail = 0;
  checks.forEach(function (c) { console.log((c[1] ? 'OK  ' : 'FAIL') + ' - ' + c[0]); if (!c[1]) fail++; });
  if (fail) { console.log(fail + ' controle(s) mislukt.'); process.exitCode = 1; return; }
  console.log('Alle controles geslaagd.');
}

main().catch(function (e) { console.error(e); process.exit(1); });
