'use strict';
// Browsertest: Planning en Rapport in de eenvoudige weergave: eerst in gewone taal wat er staat en wat nog aandacht vraagt.
// De cijfers komen uit dezelfde berekeningen als voorheen; de uitgebreide weergave blijft zoals ze was.
//   python3 -m http.server 8937 &   ;   node test/planning-rapport.spec.js
let chromium;
try { chromium = require('playwright').chromium; } catch (e) { chromium = require('/opt/node22/lib/node_modules/playwright').chromium; }
var BASE = process.env.MJOP_TEST_BASE || 'http://localhost:8937/';
var CHROMIUM_PATH = process.env.MJOP_CHROMIUM || '/opt/pw-browsers/chromium';
var SHOTS = process.env.MJOP_SHOTS || null;
var checks = [];
function check(n, ok, d) { checks.push([n, !!ok, d]); }
async function click(page, sel) { await page.evaluate(function (s) { var e = document.querySelector(s); if (e) e.click(); }, sel); await page.waitForTimeout(150); }
async function text(page) { return page.evaluate(function () { return document.body.innerText; }); }
async function open(browser, simpel) {
  var ctx = await browser.newContext({ viewport: { width: 375, height: 667 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  var page = await ctx.newPage(); page.__errors = [];
  page.on('pageerror', function (e) { page.__errors.push(String(e)); });
  await page.addInitScript(function (v) { try { localStorage.setItem('mjop-instellingen', JSON.stringify({ toonCbsBron: true, eenvoudig: v })); } catch (e) {} }, simpel);
  await page.route(/^https?:\/\/(?!localhost)/, function (r) { return r.abort(); });
  await page.goto(BASE + 'index.html'); await page.waitForTimeout(300);
  await click(page, '[data-act=skip-onboarding]');
  return page;
}
async function main() {
  var browser = await chromium.launch({ executablePath: CHROMIUM_PATH });
  var page = await open(browser, true);
  await click(page, '[data-act=set-tab][data-tab=planning]');
  var t = await text(page);
  check('Planning: "In het kort" met eerstvolgend onderhoud', /In het kort/.test(t) && /Eerstvolgend onderhoud:/.test(t), t.slice(0, 300));
  check('Planning: totaal in gewone taal ("ongeveer € … nodig", duurste jaar)', /is ongeveer € [\d.]+ nodig; het duurste jaar is \d{4}/.test(t), t.slice(0, 500));
  check('Planning: fondsstand in één zin', /fonds/i.test(await page.evaluate(function () { return (document.querySelector('[data-kort-fonds]') || {}).textContent || ''; })));
  check('Planning: nog niet beoordeelde onderdelen worden genoemd', /nog niet beoordeeld; daar rekent het plan met de gebruikelijke levensduur/.test(t));
  var geo = await page.evaluate(function () { return document.documentElement.scrollWidth > window.innerWidth; });
  check('Planning 375px: geen horizontaal scrollen', !geo);
  await page.evaluate(function () { window.scrollTo(0, 0); });
  if (SHOTS) await page.screenshot({ path: SHOTS + '/planning-375.png' });
  // saldo leeg -> uitleg in plaats van een oordeel
  await click(page, '[data-act=set-tab][data-tab=home]');
  await page.fill('#fonds-bedrag', ''); await page.dispatchEvent('#fonds-bedrag', 'input'); await page.waitForTimeout(200);
  await click(page, '[data-act=set-tab][data-tab=planning]');
  t = await text(page);
  check('Planning: zonder saldo geen oordeel, wel een duidelijke uitnodiging om in te vullen', /Vul het saldo van de reservekas in/.test(t) && !/blijft het fonds/.test(t));
  await click(page, '[data-act=set-tab][data-tab=rapport]');
  t = await text(page);
  check('Rapport: checklist "Dit mist nog in je rapport"', /Dit mist nog in je rapport/.test(t) && /Saldo van de reservekas nog niet ingevuld/.test(t), t.slice(0, 400));
  check('Rapport: afdrukken blijft mogelijk (indicatie), niets wordt verborgen', !!(await page.$('[data-act=print-rapport]')) && /Indicatie|indicatie/.test(t));
  await page.evaluate(function () { window.scrollTo(0, 0); });
  if (SHOTS) await page.screenshot({ path: SHOTS + '/rapport-375.png' });
  await click(page, '[data-act=set-tab][data-tab=home]');
  await page.fill('#fonds-bedrag', '25000'); await page.dispatchEvent('#fonds-bedrag', 'input'); await page.waitForTimeout(200);
  await click(page, '[data-act=set-tab][data-tab=rapport]');
  t = await text(page);
  check('Rapport: na invullen verdwijnt dat punt uit de lijst', !/Saldo van de reservekas nog niet ingevuld/.test(t) && /Saldo van de reservekas ingevuld/.test(t));
  check('Geen JavaScript-fouten', page.__errors.length === 0, page.__errors.join('; '));
  await page.context().close();

  // uitgebreide weergave: ongewijzigd (geen extra blokken)
  page = await open(browser, false);
  await click(page, '[data-act=set-tab][data-tab=planning]');
  check('Uitgebreide weergave: Planning zonder "In het kort"-blok', !(await page.$('[data-in-het-kort]')));
  await click(page, '[data-act=set-tab][data-tab=rapport]');
  check('Uitgebreide weergave: Rapport zonder checklist-blok', !(await page.$('[data-klaarlijst]')));
  await page.context().close();

  await browser.close();
  var failed = checks.filter(function (c) { return !c[1]; });
  checks.forEach(function (c) { console.log((c[1] ? 'OK   - ' : 'FAIL - ') + c[0] + (c[1] ? '' : ' [' + c[2] + ']')); });
  console.log(failed.length ? failed.length + ' controle(s) mislukt.' : 'Alle controles geslaagd.');
  process.exit(failed.length ? 1 : 0);
}
main().catch(function (e) { console.error(e); process.exit(2); });
