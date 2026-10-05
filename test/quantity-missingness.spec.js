'use strict';
// Browsertest: Quantity Missingness Safety v1 — MISSING != 0.
//
// 3D BAG (nagebootst) levert b3_opp_dak_plat = 120,5, b3_opp_buitenmuur = 0 (een echte, gemeten 0) en GEEN
// b3_opp_dak_schuin. Dan moet:
//   - 'Dakinspectie' (op het totale dakoppervlak) NIET 120,5 + 0 rekenen: hoeveelheid niet beschikbaar, kosten
//     onbekend (geen € 0-post), melding op Overzicht/Planning/Rapport, en handmatig in te vullen;
//   - de gevel een geldige 0 m² uit 3D BAG tonen (geen truthiness-terugval op een schatting);
//   - na handmatig invullen de kosten wél tellen, ook na herladen.
//
//   python3 -m http.server 8937 &   ;   node test/quantity-missingness.spec.js

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
var ATTRS = { b3_opp_dak_plat: 120.5, b3_opp_buitenmuur: 0, b3_opp_grond: 130, b3_bouwlagen: 4, b3_dak_type: 'horizontal',
  b3_h_dak_max: 13.4, b3_h_maaiveld: 0.6 };  // b3_opp_dak_schuin ontbreekt bewust

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

async function tab(page, naam) {
  await page.click('[data-act=set-tab][data-tab=' + naam + ']');
  await page.waitForTimeout(120);
}

async function openEl(page, id) {
  await tab(page, 'gebouw');
  await page.click('.gb-row[data-act=open-element][data-id=' + id + ']');
  await page.waitForTimeout(120);
}

async function row(page, id) {
  return page.evaluate(function (id) {
    var r = document.querySelector('.gb-row[data-id="' + id + '"]');
    if (!r) return null;
    var c = r.querySelector('.gb-cell-bedrag');
    return { bedrag: c.textContent, unknown: c.hasAttribute('data-cost-unknown'), meta: (r.querySelector('.gb-post-meta') || {}).textContent || '' };
  }, id);
}

async function panel(page) {
  return page.evaluate(function () {
    var p = document.querySelector('.qty-panel');
    var inp = p && p.querySelector('input[data-change=qty-input]');
    var f = document.querySelector('[data-qty-formula]');
    return { status: p && p.dataset.qtyStatus, source: p && p.dataset.qtySource,
      statusLabel: (document.querySelector('[data-qty-status-label]') || {}).textContent || '',
      sourceLabel: (document.querySelector('[data-qty-source-label]') || {}).textContent || '',
      value: inp && inp.value, placeholder: inp && inp.placeholder, hint: (p && p.querySelector('.hint') || {}).textContent || '',
      formula: f ? f.textContent : '', formulaUnknown: !!(f && f.hasAttribute('data-cost-unknown')),
      confirmBtn: !!document.querySelector('[data-act=qty-confirm]'), amount: (document.querySelector('.kv.strong .amount') || {}).textContent || '' };
  });
}

async function notice(page) {
  return page.evaluate(function () { return (document.querySelector('[data-cost-unknown-notice]') || {}).textContent || ''; });
}

async function main() {
  var browser = await chromium.launch({ executablePath: CHROMIUM_PATH });
  var context = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  var page = await context.newPage();
  page.setDefaultTimeout(8000);
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

  // Gebouw-lijst
  await tab(page, 'gebouw');
  var r = await row(page, 'dakinspectie');
  check('Gebouw: Dakinspectie toont "kosten onbekend", geen € 0 / € 420', r && r.unknown && r.bedrag === 'kosten onbekend', JSON.stringify(r));
  check('Gebouw: meta "hoeveelheid onbekend — vul zelf in"', r && /hoeveelheid onbekend — vul zelf in/.test(r.meta), r && r.meta);
  var hellend = await page.evaluate(function () { return !!document.querySelector('.gb-row[data-id="dak-hellend"]'); });
  check('Onbekend hellend dak levert geen dak-hellend-post met 0 m² op', !hellend);

  // Detail dakinspectie
  await openEl(page, 'dakinspectie');
  var p = await panel(page);
  check('Detail: status "Niet beschikbaar", bron "Niet beschikbaar"', p.status === 'NOT_AVAILABLE' && p.statusLabel === 'Niet beschikbaar' &&
    p.source === 'NOT_AVAILABLE' && p.sourceLabel === 'Niet beschikbaar', JSON.stringify(p));
  check('Detail: geen "0 m²"; leeg veld met uitleg', p.value === '' && /Niet beschikbaar — vul zelf in/.test(p.placeholder) &&
    /Totaal dakoppervlak niet volledig beschikbaar: b3_opp_dak_schuin ontbreekt/.test(p.hint), p.hint);
  check('Detail: geen bevestig-knop voor een onbekende hoeveelheid', !p.confirmBtn);
  check('Detail: kosten niet berekend (geen € 0, geen € 420)', p.formulaUnknown && /kosten niet berekend/.test(p.formula) && p.amount === 'kosten onbekend', p.formula + ' | ' + p.amount);

  // Overzicht / Planning / Rapport: expliciete melding, geen stille € 0-post
  for (var t of ['home', 'planning', 'rapport']) {
    await tab(page, t);
    var n = await notice(page);
    check(t + ': melding "zonder bekende hoeveelheid … niet berekend"', /1 post zonder bekende hoeveelheid \(Dakinspectie en klein onderhoud\)/.test(n) && /niet berekend/.test(n), n);
  }
  await tab(page, 'planning');
  var inPlanning = await page.evaluate(function () {
    var clone = document.body.cloneNode(true);
    Array.prototype.forEach.call(clone.querySelectorAll('[data-cost-unknown-notice], .pr-doc'), function (e) { e.remove(); });
    return /Dakinspectie/.test(clone.textContent);
  });
  check('Planning: geen posten voor Dakinspectie (niet als € 0 meegeteld)', !inPlanning);
  var printRow = await page.evaluate(function () {
    var tr = Array.prototype.filter.call(document.querySelectorAll('.pr-table tr'), function (t) { return /Dakinspectie/.test(t.textContent); })[0];
    var doc = document.querySelector('.pr-doc');
    return { row: tr ? tr.textContent : '', notice: doc && doc.querySelector('[data-cost-unknown-notice]') ? true : false,
      bouw: doc ? (/geschat uit het BAG-grondvlak, geen 3D BAG-waarde/.test(doc.textContent)) : false };
  });
  check('Printrapport: Dakinspectie "kosten onbekend" (geen € 0), met melding; dakoppervlak niet als 3D BAG gepresenteerd',
    /kosten onbekend$/.test(printRow.row) && printRow.notice && printRow.bouw, JSON.stringify(printRow));

  // Gevel: echte gemeten 0
  await openEl(page, 'gevel-metselwerk');
  p = await panel(page);
  check('Gevel: b3_opp_buitenmuur = 0 is een geldige 0 m² uit 3D BAG (geen schatting)', p.value === '0' && p.source === '3D_BAG' &&
    p.status === 'PROPOSED' && !p.formulaUnknown, JSON.stringify({ v: p.value, s: p.source, st: p.status }));

  // Plat dak: aanwezig
  await openEl(page, 'dak-plat');
  p = await panel(page);
  check('Plat dak: 120,5 m² uit 3D BAG', p.value === '120,5' && p.source === '3D_BAG', p.value);

  // Handmatig invullen
  await openEl(page, 'dakinspectie');
  await page.fill('#hv-dakinspectie', '210');
  await page.press('#hv-dakinspectie', 'Tab');
  await page.waitForTimeout(150);
  p = await panel(page);
  check('Handmatig 210: status aangepast, kosten € 420 + 210 × € 2 = € 840', p.status === 'USER_OVERRIDDEN' && p.value === '210' &&
    /= € 840 per keer/.test(p.formula) && p.amount === '€ 840', p.formula + ' | ' + p.amount);
  await tab(page, 'planning');
  check('Na invullen: geen melding meer, Dakinspectie in de planning', !(await notice(page)) &&
    await page.evaluate(function () { return /Dakinspectie/.test(document.body.textContent); }));

  // Herladen
  await page.reload();
  await page.waitForTimeout(300);
  await openEl(page, 'dakinspectie');
  p = await panel(page);
  check('Na herladen: handmatige 210 en € 840 blijven', p.status === 'USER_OVERRIDDEN' && p.value === '210' && p.amount === '€ 840', p.amount);
  var opgeslagen = await page.evaluate(function () {
    var ws = JSON.parse(sessionStorage.getItem('mjop-worksessie'));
    var el = ws.plan.elements.filter(function (e) { return e.id === 'dakinspectie'; })[0];
    return { auto: el.quantity.auto, manual: el.quantity.manual && el.quantity.manual.value };
  });
  check('Opgeslagen: automatische waarde blijft null (niet 0), handmatig 210', opgeslagen.auto.value === null && opgeslagen.auto.source === 'NOT_AVAILABLE' &&
    opgeslagen.manual === 210, JSON.stringify(opgeslagen));

  check('Geen JavaScript-fouten tijdens het testen', errors.length === 0, errors.join(' | '));
  await browser.close();
  var fail = 0;
  checks.forEach(function (c) { console.log((c[1] ? 'OK  ' : 'FAIL') + ' - ' + c[0]); if (!c[1]) fail++; });
  if (fail) { console.log(fail + ' controle(s) mislukt.'); process.exitCode = 1; return; }
  console.log('Alle controles geslaagd.');
}

main().catch(function (e) { console.error(e); process.exitCode = 1; });
