'use strict';
// Browsertest Gevelinventaris (Gevelscanner 2.0) met een NAGEBOOTSTE native brug.
// Bewijst de website-kant: alleen opvragen bij een app die het kent, projectcontrole, tonen van gescheiden hoeveelheden met herkomst,
// GEEN_KENGETAL waar de bibliotheek geen post heeft, hoeveelheid -> bron -> (na bevestiging) effectieve hoeveelheid, behoud na herladen.
// Bewijst NIET de echte app, camera of LiDAR.
//   python3 -m http.server 8971 &   ;   MJOP_TEST_BASE=http://localhost:8971/ node test/gevel-inventaris.spec.js
let chromium;
try { chromium = require('playwright').chromium; } catch (e) { chromium = require('/opt/node22/lib/node_modules/playwright').chromium; }
var fs = require('fs');
var path = require('path');
var BASE = process.env.MJOP_TEST_BASE || 'http://localhost:8971/';
var CHROMIUM_PATH = process.env.MJOP_CHROMIUM || '/opt/pw-browsers/chromium';
var APP_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MJOPLiveApp/1';
var EX = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'gevel-inventory', 'gevel_inventory_v1_example.json'), 'utf8'));
var checks = [];
function check(n, ok, d) { checks.push([n, !!ok, d]); }

var BRIDGE_STUB = function (features) {
  window.__posted = [];
  window.webkit = { messageHandlers: { mjopNative: { postMessage: function (m) {
    window.__posted.push(JSON.parse(JSON.stringify(m)));
    if (m.action === 'getCapabilities') setTimeout(function () {
      var r = { v: 1, type: 'capabilities', requestId: m.requestId, lidar: true, appVersion: '2' };
      if (features) r.features = features;
      window.MJOPNativeBridge.receive(r);
    }, 10);
  } } } };
};

async function newPage(browser, features) {
  var ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, userAgent: APP_UA, isMobile: true, hasTouch: true });
  var page = await ctx.newPage();
  page.__errors = [];
  page.on('pageerror', function (e) { page.__errors.push(String(e)); });
  await page.addInitScript(function () { try { localStorage.setItem('mjop-instellingen', JSON.stringify({ toonCbsBron: true, eenvoudig: false })); } catch (e) {} });
  await page.addInitScript('(' + BRIDGE_STUB.toString() + ')(' + JSON.stringify(features) + ')');
  await page.route(/^https?:\/\/(?!localhost)/, function (r) { return r.abort(); });
  await page.goto(BASE + 'index.html'); await page.waitForTimeout(300);
  return page;
}
async function click(page, sel) { await page.evaluate(function (s) { var e = document.querySelector(s); if (e) e.click(); }, sel); await page.waitForTimeout(150); }
async function text(page) { return page.evaluate(function () { return document.body.innerText; }); }
async function posted(page) { return page.evaluate(function () { return window.__posted; }); }
async function receive(page, msg) { var r = await page.evaluate(function (m) { return window.MJOPNativeBridge.receive(m); }, msg); await page.waitForTimeout(150); return r; }
function forPlan(inv, ref, patch) { var c = JSON.parse(JSON.stringify(inv)); c.project.plan_ref = ref; Object.keys(patch || {}).forEach(function (k) { c[k] = patch[k]; }); return c; }
async function kozVals(page) {
  return page.evaluate(function () { return Array.from(document.querySelectorAll('.koz-row .val')).map(function (e) { return e.textContent.trim(); }); });
}

async function main() {
  var browser = await chromium.launch({ executablePath: CHROMIUM_PATH });

  // ===== app die Gevelscanner 2.0 kent =====
  var page = await newPage(browser, ['gevelscan2']);
  await click(page, '[data-act=skip-onboarding]');
  await click(page, '[data-act=set-tab][data-tab=fotoronde]');
  await page.waitForTimeout(200);
  await click(page, '[data-act=photo-round-start]');
  var msgs = await posted(page);
  var start = msgs.filter(function (m) { return m.action === 'startPhotoRound'; })[0];
  var planRef = start && start.payload.planRef;
  check('Fotoronde gestart met een planRef', !!planRef, JSON.stringify(start));
  await click(page, '[data-act=photo-round-refresh]');
  msgs = await posted(page);
  var ask = msgs.filter(function (m) { return m.action === 'listFacadeInventory'; }).pop();
  check('De website vraagt de gevelinventaris op voor dit project (bericht v1)', ask && ask.v === 1 && ask.payload.planRef === planRef, JSON.stringify(ask));

  // ander project -> nooit toegepast
  await receive(page, { v: 1, type: 'facade-inventory', planRef: planRef, inventories: [forPlan(EX, 'plan-ander-project-xxxxxxxx')] });
  check('Inventaris van een ander project wordt niet getoond', !(await page.$('[data-gi-card]')) && /ander project/.test(await text(page)));
  await receive(page, { v: 1, type: 'facade-inventory', planRef: 'plan-ander-project-xxxxxxxx', inventories: [forPlan(EX, planRef)] });
  check('Bericht voor een andere planRef wordt genegeerd', !(await page.$('[data-gi-card]')));
  // ongeldig (boeking toegestaan) -> geweigerd
  await receive(page, { v: 1, type: 'facade-inventory', planRef: planRef, inventories: [forPlan(EX, planRef, { booking_allowed: true })] });
  check('Ongeldige inventaris wordt geweigerd', !(await page.$('[data-gi-card]')) && /ongeldige gevelinventaris/.test(await text(page)));

  // geldig
  var inv = forPlan(EX, planRef);
  await receive(page, { v: 1, type: 'facade-inventory', planRef: planRef, inventories: [inv] });
  var t = await text(page);
  check('Inventaris wordt getoond als voorlopige uitkomst', !!(await page.$('[data-gi-card]')) && /niets automatisch overgenomen/.test(t), t.slice(0, 120));
  check('Gescheiden hoeveelheden zichtbaar', /Aantal kozijnen/.test(t) && /Kozijnoppervlak \(buitenmaat\)/.test(t) && /Glasoppervlak/.test(t) && /Draaiende delen/.test(t) && /Vaste delen/.test(t));
  check('Herkomst zichtbaar: glas is afgeleid, geen directe meting', /afgeleid uit de foto op het gemeten kozijnvlak \(geen directe meting\)/.test(t));
  check('Onbekend blijft onbekend (deurkozijnen)', /Deurkozijnen\s*\n?\s*Nog niet vast te stellen/.test(t), '');
  check('Zonder kengetal geen kosten: melding bij oppervlak en glas', (await page.$$('[data-gi-geen-kengetal]')).length >= 3 && /Geen kengetal per m² glas/.test(t));
  check('Geen NEN 2767-score geclaimd', /geen NEN 2767-conditiescore/.test(t));
  msgs = await posted(page);
  var ack = msgs.filter(function (m) { return m.action === 'ackProposals'; }).pop();
  check('Ontvangst bevestigd aan de app (bestaande ackProposals)', ack && ack.payload.proposalIds.indexOf(inv.inventory_id) >= 0, JSON.stringify(ack));
  // idempotent
  await receive(page, { v: 1, type: 'facade-inventory', planRef: planRef, inventories: [inv] });
  check('Twee keer dezelfde inventaris = één kaart', (await page.$$('[data-gi-card]')).length === 1);

  // hoeveelheid -> bron -> effectieve hoeveelheid, met de bestaande kozijnrij en haar eigen kengetal
  // De kozijnpost geldt voor het hele gebouw: bij meerdere gevels wordt alleen het GEBOUWTOTAAL aangeboden, nooit het aantal van één gevel.
  var facade = inv.facades[0].facade_id, key = '*|operable_parts', n = inv.building_totals.operable_parts.value;
  check('Bij meerdere gevels: geen overnameknop per gevel, wel uitleg', !(await page.$('[data-act=gi-add-source][data-key="f:' + facade + '|operable_parts"]')) && (await page.$$('[data-gi-alleen-gebouw]')).length >= 1);
  await click(page, '[data-act=set-tab][data-tab=gebouw]');
  await click(page, '[data-act=open-element][data-id=kozijnen-onderhoud]');
  var before = await kozVals(page);
  await click(page, '[data-act=set-tab][data-tab=fotoronde]');
  await click(page, '[data-act=gi-add-source][data-key="' + key + '"]');
  await click(page, '[data-act=set-tab][data-tab=gebouw]');
  await click(page, '[data-act=open-element][data-id=kozijnen-onderhoud]');
  check('Toevoegen als bron verandert de hoeveelheid NIET', JSON.stringify(await kozVals(page)) === JSON.stringify(before), JSON.stringify(before));
  await click(page, '[data-act=set-tab][data-tab=fotoronde]');
  await click(page, '[data-act=gi-use][data-key="' + key + '"]');
  check('Gebruiken zonder bevestiging van de onzekerheid wordt geweigerd', !!(await page.$('[data-gi-fout]')));
  await page.evaluate(function (k) { var c = document.querySelector('[data-change=gi-ack][data-key="' + k + '"]'); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); }, key);
  await page.waitForTimeout(150);
  await click(page, '[data-act=gi-use][data-key="' + key + '"]');
  check('Na bevestiging: in gebruik bij de post Draaiend raam', !!(await page.$('[data-gi-in-gebruik]')) && /In gebruik als hoeveelheid bij Onderhoud buitenkozijnen — Draaiend raam/.test(await text(page)));
  await click(page, '[data-act=set-tab][data-tab=gebouw]');
  await click(page, '[data-act=open-element][data-id=kozijnen-onderhoud]');
  var after = await kozVals(page);
  check('De rij Draaiend raam heeft nu het aantal uit de inventaris; de andere rijen zijn ongewijzigd', after[0] === String(n) && JSON.stringify(after.slice(1)) === JSON.stringify(before.slice(1)), JSON.stringify(after));
  check('Geen JavaScript-fouten', page.__errors.length === 0, page.__errors.join('; '));
  await page.context().close();

  // ===== app die Gevelscanner 2.0 NIET kent (geen features in capabilities) =====
  page = await newPage(browser, null);
  await click(page, '[data-act=skip-onboarding]');
  await click(page, '[data-act=set-tab][data-tab=fotoronde]');
  await page.waitForTimeout(200);
  await click(page, '[data-act=photo-round-start]');
  await click(page, '[data-act=photo-round-refresh]');
  msgs = await posted(page);
  check('Oudere app: de website stuurt GEEN listFacadeInventory', msgs.filter(function (m) { return m.action === 'listFacadeInventory'; }).length === 0);
  check('Oudere app: bestaande berichten ongewijzigd (listProposals wordt nog gestuurd)', msgs.some(function (m) { return m.action === 'listProposals'; }));
  check('Oudere app: geen JavaScript-fouten', page.__errors.length === 0, page.__errors.join('; '));
  await page.context().close();

  await browser.close();
  var fail = 0;
  checks.forEach(function (c) { console.log((c[1] ? 'OK  ' : 'FAIL') + ' - ' + c[0] + (c[1] || !c[2] ? '' : '\n         ' + c[2])); if (!c[1]) fail++; });
  if (fail) { console.log(fail + ' controle(s) mislukt.'); process.exitCode = 1; return; }
  console.log('Alle controles geslaagd.');
}
main().catch(function (e) { console.error(e); process.exitCode = 1; });
