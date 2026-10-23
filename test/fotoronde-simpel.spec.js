'use strict';
// Browsertest: Fotoronde in de EENVOUDIGE weergave (standaard): gewone taal, één duidelijke knop, technische details op verzoek.
// Het gedrag zelf (contract, brug, bevestigen, handmatige waarden) staat in fotoronde.spec.js (uitgebreide weergave).
//   python3 -m http.server 8937 &   ;   node test/fotoronde-simpel.spec.js
let chromium;
try { chromium = require('playwright').chromium; } catch (e) { chromium = require('/opt/node22/lib/node_modules/playwright').chromium; }
var fs = require('fs'), path = require('path');
var BASE = process.env.MJOP_TEST_BASE || 'http://localhost:8937/';
var CHROMIUM_PATH = process.env.MJOP_CHROMIUM || '/opt/pw-browsers/chromium';
var SHOTS = process.env.MJOP_SHOTS || null;
var APP_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MJOPLiveApp/1';
var COUNT = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'photo-round', 'count_building_v2.json'), 'utf8'));
var AREA = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'photo-round', 'area_building_incomplete_v2.json'), 'utf8'));
var checks = [];
function check(n, ok, d) { checks.push([n, !!ok, d]); }
var BRIDGE_STUB = function () {
  window.__posted = [];
  window.webkit = { messageHandlers: { mjopNative: { postMessage: function (m) {
    window.__posted.push(JSON.parse(JSON.stringify(m)));
    if (m.action === 'getCapabilities') setTimeout(function () { window.MJOPNativeBridge.receive({ v: 1, type: 'capabilities', requestId: m.requestId, lidar: true, appVersion: '1' }); }, 10);
  } } } };
};
async function click(page, sel) { await page.evaluate(function (s) { var e = document.querySelector(s); if (e) e.click(); }, sel); await page.waitForTimeout(150); }
async function text(page) { return page.evaluate(function () { return document.body.innerText; }); }
function forPlan(p, ref) { var c = JSON.parse(JSON.stringify(p)); c.project.plan_ref = ref; return c; }

async function main() {
  var browser = await chromium.launch({ executablePath: CHROMIUM_PATH });
  var TECH = /PROPOSED|PHOTO_WALK_SCAN|LiDAR multi-frame|schema|mjop_scan_proposal/i;

  // ===== in de app, 375x667 =====
  var ctx = await browser.newContext({ viewport: { width: 375, height: 667 }, deviceScaleFactor: 2, userAgent: APP_UA, isMobile: true, hasTouch: true });
  var page = await ctx.newPage(); var errors = [];
  page.on('pageerror', function (e) { errors.push(String(e)); });
  await page.addInitScript('(' + BRIDGE_STUB.toString() + ')()');
  await page.route(/^https?:\/\/(?!localhost)/, function (r) { return r.abort(); });
  await page.goto(BASE + 'index.html'); await page.waitForTimeout(300);
  await click(page, '[data-act=skip-onboarding]');
  var tabs = await page.evaluate(function () { return Array.from(document.querySelectorAll('.tab-item')).map(function (e) { return e.textContent.trim(); }); });
  check('Eenvoudige weergave: geen Fotoronde-tab zolang er geen resultaten zijn', tabs.indexOf('Fotoronde') < 0 && tabs.indexOf('Inspectie') < 0, tabs.join(','));
  await click(page, '[data-act=set-tab][data-tab=start]');
  await click(page, '[data-act=start-inspecteer]');
  var t = await text(page);
  check('Titel "Gebouw inspecteren" en gewone uitleg', /Gebouw inspecteren/.test(t) && /Zorg dat het hele kozijn in beeld staat/.test(t), t.slice(0, 200));
  check('Eén duidelijke knop "Foto\'s maken"', /Foto's maken/.test(t) && !!(await page.$('[data-act=photo-round-start]')));
  check('Gevels noteren is verborgen achter "Meer opties"', !(await page.$('#pr-plan-naam')) && /Meer opties/.test(t));
  await click(page, '[data-act=pr-opties]');
  check('Na "Meer opties": gevel noteren beschikbaar', !!(await page.$('#pr-plan-naam')));
  await click(page, '[data-act=pr-opties]');
  await click(page, '[data-act=photo-round-start]');
  var posted = await page.evaluate(function () { return window.__posted; }); if (process.env.DEBUG_POSTED) console.log(JSON.stringify(posted), (await text(page)).slice(0, 400));
  var start = posted.filter(function (m) { return m.action === 'startPhotoRound'; })[0];
  check('Starten stuurt dezelfde brugboodschap als voorheen (zonder gevels: lege lijst, de app maakt er zelf één)', start && start.payload.plannedFacades.length === 0 && /^plan-/.test(start.payload.planRef), JSON.stringify(start && start.payload.plannedFacades));
  var planRef = start.payload.planRef;
  await page.evaluate(function (a) { return window.MJOPNativeBridge.receive(a); }, { v: 1, type: 'proposals', planRef: planRef, proposals: [forPlan(COUNT, planRef), forPlan(AREA, planRef)], rounds: [{ roundId: 'r1a2b3c4-demo', status: 'COMPLETED', photos: 4, objects: 12, synced: true }] });
  await page.waitForTimeout(200);
  t = await text(page);
  check('Resultaten in gewone taal: "Mogelijke kozijnen", "12 st"', /Mogelijke kozijnen/.test(t) && /12 st/.test(t));
  check('Duidelijke vraag: "Controleer of alle kozijnen kloppen."', /Controleer of alle kozijnen kloppen\./.test(t));
  check('Onbetrouwbare maat: "Deze maat is nog niet betrouwbaar genoeg."', /Deze maat is nog niet betrouwbaar genoeg\./.test(t));
  check('Waarschuwingen blijven zichtbaar (nog niet gevalideerd, andere scanmomenten)', /nog niet gevalideerd/.test(t) && /verschillende scanmomenten/.test(t));
  check('Standaard geen technische termen/fasen', !TECH.test(t) && !/Detectie: \d+ automatisch/.test(t) && !/Bevestiging: nog niet/.test(t));
  check('Eerdere foto\'s: "4 foto\'s · 12 mogelijke kozijnen"', /4 foto's · 12 mogelijke kozijnen/.test(t));
  var tabs2 = await page.evaluate(function () { return Array.from(document.querySelectorAll('.tab-item')).map(function (e) { return e.textContent.trim(); }); });
  check('Met resultaten: tab "Inspectie" zichtbaar', tabs2.indexOf('Inspectie') >= 0, tabs2.join(','));
  var geo = await page.evaluate(function () { return document.documentElement.scrollWidth > window.innerWidth; });
  check('375px: geen horizontaal scrollen', !geo);
  if (SHOTS) await page.screenshot({ path: SHOTS + '/fotoronde-simpel-375.png' });
  await click(page, '[data-act=pr-tech]');
  t = await text(page);
  check('"Technische details" toont fasen en bron op verzoek', /Detectie: 11 automatisch/.test(t) && /Meting: LiDAR, geschat/.test(t) && /Bevestiging: nog niet/.test(t) && /Waarop is dit gebaseerd/.test(t));
  if (SHOTS) await page.screenshot({ path: SHOTS + '/fotoronde-simpel-details-375.png' });
  var kan = await page.evaluate(function () { return !!document.querySelector('[data-act=pr-add-source]'); });
  check('Het voorstel blijft een voorstel: bevestigen/gebruiken werkt zoals voorheen (knop "Voeg toe als bron")', kan);
  check('Geen JavaScript-fouten', errors.length === 0, errors.join('; '));
  await ctx.close();

  // ===== website =====
  var ctx2 = await browser.newContext({ viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true });
  var p2 = await ctx2.newPage();
  await p2.route(/^https?:\/\/(?!localhost)/, function (r) { return r.abort(); });
  await p2.goto(BASE + 'index.html'); await p2.waitForTimeout(300);
  await click(p2, '[data-act=skip-onboarding]');
  await click(p2, '[data-act=set-tab][data-tab=start]');
  await click(p2, '[data-act=start-inspecteer]');
  t = await text(p2);
  check('Website: uitleg dat de camera in de iPhone-app zit, geen kapotte knoppen', /MJOP Live-app op de iPhone/.test(t) && !(await p2.$('[data-act=photo-round-start]')));
  await ctx2.close();

  await browser.close();
  var failed = checks.filter(function (c) { return !c[1]; });
  checks.forEach(function (c) { console.log((c[1] ? 'OK   - ' : 'FAIL - ') + c[0] + (c[1] ? '' : ' [' + c[2] + ']')); });
  console.log(failed.length ? failed.length + ' controle(s) mislukt.' : 'Alle controles geslaagd.');
  process.exit(failed.length ? 1 : 0);
}
main().catch(function (e) { console.error(e); process.exit(2); });
