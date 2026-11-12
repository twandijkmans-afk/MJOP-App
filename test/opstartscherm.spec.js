'use strict';
// Browsertest: opstartscherm met logo-animatie. Staat er direct, verdwijnt vanzelf, blokkeert de app niet, komt één keer per sessie,
// en blijft weg tijdens geautomatiseerde tests tenzij ?splash=1 (zodat andere tests er niet door worden vertraagd).
//   python3 -m http.server 8996 &  ;  MJOP_TEST_BASE=http://localhost:8996/ node test/opstartscherm.spec.js
let chromium;
try { chromium = require('playwright').chromium; } catch (e) { chromium = require('/opt/node22/lib/node_modules/playwright').chromium; }
var fs = require('fs');
var BASE = process.env.MJOP_TEST_BASE || 'http://localhost:8996/';
var CHROMIUM_PATH = process.env.MJOP_CHROMIUM || '/opt/pw-browsers/chromium';
var checks = [];
function check(n, ok, d) { checks.push([n, !!ok, d]); }
async function nieuwePagina(browser, opts, errors) {
  var ctx = await browser.newContext(Object.assign({ viewport: { width: 390, height: 844 } }, opts || {}));
  var page = await ctx.newPage();
  page.on('pageerror', function (e) { errors.push(String(e)); });
  await page.route(/^https?:\/\/(?!localhost)/, function (r) { return r.abort(); });
  return { ctx: ctx, page: page };
}
async function main() {
  var browser = await chromium.launch(fs.existsSync(CHROMIUM_PATH) ? { executablePath: CHROMIUM_PATH } : {});
  var errors = [];

  // 1. gewone test (webdriver): geen opstartscherm
  var a = await nieuwePagina(browser, null, errors);
  await a.page.goto(BASE + 'index.html'); await a.page.waitForTimeout(300);
  check('1. in geautomatiseerde tests geen opstartscherm (andere tests blijven snel)', !(await a.page.$('#splash')));
  await a.ctx.close();

  // 2. met ?splash=1: direct zichtbaar, met logo en naam, blokkeert niets, verdwijnt vanzelf
  var b = await nieuwePagina(browser, null, errors), page = b.page;
  await page.goto(BASE + 'index.html?splash=1', { waitUntil: 'commit' });
  await page.waitForSelector('#splash', { timeout: 3000 });
  var info = await page.evaluate(function () {
    var s = document.getElementById('splash'), r = s.getBoundingClientRect();
    return { w: r.width, h: r.height, t: s.innerText, ptr: getComputedStyle(s).pointerEvents, aria: s.getAttribute('aria-hidden') };
  });
  check('2. opstartscherm vult het scherm, toont logo en naam, is verborgen voor schermlezers', info.w >= 389 && info.h >= 843 && /M/.test(info.t) && /MJOP Live/.test(info.t) && info.aria === 'true', JSON.stringify(info));
  check('3. het opstartscherm vangt geen tikken af (de app eronder blijft bruikbaar)', info.ptr === 'none');
  await page.waitForFunction(function () { return !document.getElementById('splash'); }, null, { timeout: 4000 });
  check('4. het opstartscherm verdwijnt vanzelf', !(await page.$('#splash')));
  check('5. de app is daarna zichtbaar en bruikbaar', await page.evaluate(function () { return !!document.querySelector('#addr-search, [data-bind=addr-q], [data-act=skip-onboarding]'); }));

  // 3. tweede keer in dezelfde sessie: geen opstartscherm meer
  await page.goto(BASE + 'index.html'); await page.waitForTimeout(200);
  check('6. in dezelfde sessie komt het opstartscherm niet opnieuw', !(await page.$('#splash')));
  await b.ctx.close();

  // 4. minder beweging: geen animatie, wel kort zichtbaar en daarna weg
  var c = await nieuwePagina(browser, { reducedMotion: 'reduce' }, errors);
  await c.page.goto(BASE + 'index.html?splash=1', { waitUntil: 'commit' });
  await c.page.waitForSelector('#splash.splash-kort', { timeout: 3000 });
  var anim = await c.page.evaluate(function () { return getComputedStyle(document.querySelector('.splash-mark')).animationName; });
  check('7. bij "minder beweging" geen animatie', anim === 'none', anim);
  await c.page.waitForFunction(function () { return !document.getElementById('splash'); }, null, { timeout: 3000 });
  check('8. ook dan verdwijnt het opstartscherm', !(await c.page.$('#splash')));
  await c.ctx.close();

  check('9. geen scriptfouten', errors.length === 0, errors.join('; '));
  await browser.close();
  var failed = checks.filter(function (x) { return !x[1]; });
  checks.forEach(function (x) { console.log((x[1] ? 'OK   - ' : 'FAIL - ') + x[0] + (x[1] ? '' : ' [' + x[2] + ']')); });
  console.log(failed.length ? failed.length + ' controle(s) mislukt.' : 'Alle controles geslaagd.');
  process.exit(failed.length ? 1 : 0);
}
main().catch(function (e) { console.error(e); process.exit(2); });
