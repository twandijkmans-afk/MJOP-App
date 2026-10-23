'use strict';
// Browsertest: "Toevoegen aan MJOP" in de eenvoudige weergave: één begrijpelijke bevestiging, zonder dat een onzekere scanmaat
// ongemerkt een hoeveelheid wordt of een door jou ingevulde waarde ongemerkt wordt overschreven.
//   python3 -m http.server 8937 &   ;   node test/quantity-check.spec.js
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
async function rows(page) {
  return page.evaluate(function () {
    return { vals: Array.from(document.querySelectorAll('.koz-row .val')).map(function (e) { return e.textContent.trim(); }), hint0: ((document.querySelectorAll('.koz-row')[0] || {}).innerText || '') };
  });
}
async function tick(page, sel) { await page.evaluate(function (s) { var c = document.querySelector(s); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); }, sel); await page.waitForTimeout(120); }

async function openWithResults(browser) {
  var ctx = await browser.newContext({ viewport: { width: 375, height: 667 }, deviceScaleFactor: 2, userAgent: APP_UA, isMobile: true, hasTouch: true });
  var page = await ctx.newPage(); page.__errors = [];
  page.on('pageerror', function (e) { page.__errors.push(String(e)); });
  await page.addInitScript('(' + BRIDGE_STUB.toString() + ')()');
  await page.route(/^https?:\/\/(?!localhost)/, function (r) { return r.abort(); });
  await page.goto(BASE + 'index.html'); await page.waitForTimeout(300);
  await click(page, '[data-act=skip-onboarding]');
  await click(page, '[data-act=set-tab][data-tab=start]');
  await click(page, '[data-act=start-inspecteer]');
  await click(page, '[data-act=photo-round-start]');
  var planRef = (await page.evaluate(function () { return window.__posted; })).filter(function (m) { return m.action === 'startPhotoRound'; })[0].payload.planRef;
  return { page: page, planRef: planRef };
}

async function main() {
  var browser = await chromium.launch({ executablePath: CHROMIUM_PATH });

  // ===== scenario 1: gewone toevoeging =====
  var o = await openWithResults(browser), page = o.page;
  await page.evaluate(function (a) { return window.MJOPNativeBridge.receive(a); }, { v: 1, type: 'proposals', planRef: o.planRef, proposals: [forPlan(COUNT, o.planRef), forPlan(AREA, o.planRef)], rounds: [] });
  await page.waitForTimeout(200);
  var t = await text(page);
  check('Samenvatting "Dit is gevonden": aantal en oppervlak in gewone taal', /Dit is gevonden/.test(t) && /Aantal kozijnen: 12 \(voorlopig\)/.test(t) && /Kozijnoppervlak: nog niet te bepalen/.test(t) && /17,4/.test(t), t.slice(0, 400));
  check('Samenvatting zegt dat er nog niets is overgenomen', /Nog niets is overgenomen/.test(t));
  var cardId = await page.evaluate(function () { return document.querySelector('[data-pr-card] [data-act=pr-toevoegen]').dataset.id; });
  check('Eén knop "Toevoegen aan MJOP" i.p.v. "Voeg toe als bron" + "Gebruik als hoeveelheid"', !(await page.$('[data-act=pr-add-source]')) && /Toevoegen aan MJOP/.test(t));
  check('Duidelijk wat er gebeurt: "Dit wordt toegevoegd: 12 st"', /Dit wordt toegevoegd: 12 st/.test(await text(page)) || await page.evaluate(function () { return /12/.test((document.querySelector('[data-pr-dit-wordt]') || {}).textContent || ''); }));
  var layout = await page.evaluate(function () { var g = document.querySelector('.mobile-settings-btn').getBoundingClientRect(); var wide = []; document.querySelectorAll('body *').forEach(function (e) { var b = e.getBoundingClientRect(); if (b.right > window.innerWidth + 1 && b.width > 0) wide.push(e.tagName + '.' + String(e.className).slice(0, 30) + ':' + Math.round(b.right)); }); return { iw: window.innerWidth, sw: document.documentElement.scrollWidth, sx: window.scrollX, gearRight: Math.round(g.right), wide: wide.slice(0, 6) }; });
  check('375px met resultaten: niets steekt buiten het scherm', layout.gearRight <= layout.iw && layout.wide.length === 0 && layout.sx === 0, JSON.stringify(layout));
  if (SHOTS) await page.screenshot({ path: SHOTS + '/controle-375.png', fullPage: false });
  await page.selectOption('#pr-target-' + cardId, 'kozijnen-onderhoud:0'); await page.waitForTimeout(100);
  await click(page, '[data-act=pr-toevoegen][data-id="' + cardId + '"]');
  check('Zonder bevestiging wordt niets toegevoegd (duidelijke melding)', /Bevestig eerst/.test(await text(page)) && !(await page.$('[data-pr-status=IN_USE]')) && !(await page.$('[data-pr-status=SOURCE_ADDED]')));
  await click(page, '[data-act=set-tab][data-tab=gebouw]'); await click(page, '[data-act=open-element][data-id=kozijnen-onderhoud]');
  var before = await rows(page);
  await click(page, '[data-act=set-tab][data-tab=fotoronde]');
  await tick(page, '#pr-ack-' + cardId);
  await click(page, '[data-act=pr-toevoegen][data-id="' + cardId + '"]');
  t = await text(page);
  check('Met bevestiging: in één klik toegevoegd ("Toegevoegd aan je MJOP")', !!(await page.$('[data-pr-status=IN_USE]')) && /Toegevoegd aan je MJOP/.test(t) && /door jou gekozen/.test(t));
  await click(page, '[data-act=set-tab][data-tab=gebouw]'); await click(page, '[data-act=open-element][data-id=kozijnen-onderhoud]');
  var after = await rows(page);
  check('Kozijnrij 1 is nu 12; andere rijen ongewijzigd', after.vals[0] === '12' && after.vals.slice(1).join() === before.vals.slice(1).join(), JSON.stringify([before.vals, after.vals]));
  check('Geen JavaScript-fouten', page.__errors.length === 0, page.__errors.join('; '));
  await page.context().close();

  // ===== scenario 2: eigen waarde nooit ongemerkt overschreven =====
  o = await openWithResults(browser); page = o.page;
  await click(page, '[data-act=set-tab][data-tab=gebouw]');
  await click(page, '[data-act=open-element][data-id=kozijnen-onderhoud]');
  await click(page, '[data-act=koz-plus][data-id=kozijnen-onderhoud][data-i="0"]');
  await click(page, '[data-act=koz-plus][data-id=kozijnen-onderhoud][data-i="0"]');
  var man = await rows(page);
  check('Eigen waarde ingevuld ("Door jou aangepast")', /Door jou aangepast/.test(man.hint0), man.hint0);
  await page.evaluate(function (a) { return window.MJOPNativeBridge.receive(a); }, { v: 1, type: 'proposals', planRef: o.planRef, proposals: [forPlan(COUNT, o.planRef)], rounds: [] });
  await click(page, '[data-act=set-tab][data-tab=fotoronde]');
  cardId = await page.evaluate(function () { return document.querySelector('[data-pr-card] [data-act=pr-toevoegen]').dataset.id; });
  await page.selectOption('#pr-target-' + cardId, 'kozijnen-onderhoud:0'); await page.waitForTimeout(100);
  check('Bij een eigen waarde staat de vervang-keuze er expliciet bij', await page.evaluate(function (id) { return !!document.getElementById('pr-replace-' + id); }, cardId));
  await tick(page, '#pr-ack-' + cardId);
  await click(page, '[data-act=pr-toevoegen][data-id="' + cardId + '"]');
  check('Zonder "vervangen" wordt de eigen waarde niet overschreven (melding)', /door jou ingevulde waarde/.test(await text(page)) && !(await page.$('[data-pr-status=IN_USE]')));
  await click(page, '[data-act=set-tab][data-tab=gebouw]'); await click(page, '[data-act=open-element][data-id=kozijnen-onderhoud]');
  var still = await rows(page);
  check('… en de eigen waarde is onveranderd', still.vals[0] === man.vals[0] && /Door jou aangepast/.test(still.hint0), JSON.stringify([man.vals, still.vals]));
  await click(page, '[data-act=set-tab][data-tab=fotoronde]');
  await tick(page, '#pr-replace-' + cardId);
  await click(page, '[data-act=pr-toevoegen][data-id="' + cardId + '"]');
  await click(page, '[data-act=set-tab][data-tab=gebouw]'); await click(page, '[data-act=open-element][data-id=kozijnen-onderhoud]');
  var repl = await rows(page);
  check('Pas na uitdrukkelijk "vervangen" wordt de waarde 12 (bron blijft bewaard)', repl.vals[0] === '12' && !/Door jou aangepast/.test(repl.hint0), JSON.stringify(repl.vals));
  check('Geen JavaScript-fouten (scenario 2)', page.__errors.length === 0, page.__errors.join('; '));
  await page.context().close();

  await browser.close();
  var failed = checks.filter(function (c) { return !c[1]; });
  checks.forEach(function (c) { console.log((c[1] ? 'OK   - ' : 'FAIL - ') + c[0] + (c[1] ? '' : ' [' + c[2] + ']')); });
  console.log(failed.length ? failed.length + ' controle(s) mislukt.' : 'Alle controles geslaagd.');
  process.exit(failed.length ? 1 : 0);
}
main().catch(function (e) { console.error(e); process.exit(2); });
