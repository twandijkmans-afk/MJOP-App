'use strict';
// Regressietest "toetsenbord springt terug naar letters" (iPhone: 123 -> direct weer ABC).
//
// Oorzaak (bewezen door deze test op de oude code): render() vervangt bij elke toetsaanslag (globale 'input'-handler) en bij elke 'resize'
// (iOS wijzigt de venstermaat zodra het toetsenbord opent of wisselt tussen ABC en 123) de HELE root.innerHTML. Het veld waarin je typt wordt dus
// vernietigd en als NIEUW element opnieuw gefocust; iOS gooit daarbij de gekozen toetsenbordstand weg.
// Deze test meet daarom niet "welk toetsenbord", dat kan alleen op een toestel, maar de oorzaak: blijft ÉÉN en hetzelfde DOM-element
// (expando-markering) bestaan en gefocust, blijft de tekst en de cursor staan, en blijven de live-berekeningen werken?
//
//   python3 -m http.server 8937 &   ;   node test/keyboard-focus.spec.js
let chromium;
try { chromium = require('playwright').chromium; } catch (e) { chromium = require('/opt/node22/lib/node_modules/playwright').chromium; }
var fs = require('fs');
var BASE = process.env.MJOP_TEST_BASE || 'http://localhost:8937/';
var CHROMIUM_PATH = process.env.MJOP_CHROMIUM || '/opt/pw-browsers/chromium';
var SDK_URL = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.116.0/dist/umd/supabase.js';
var SDK_FILE = process.env.MJOP_SUPABASE_SDK || null;
var IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
var APP_UA = IPHONE_UA.replace('Safari/604.1', 'MJOPLiveApp/1');

var checks = [];
function check(name, ok, detail) { checks.push([name, !!ok, detail]); }

async function newPage(browser, ua, w, h) {
  var ctx = await browser.newContext({ viewport: { width: w || 390, height: h || 844 }, userAgent: ua, isMobile: true, hasTouch: true });
  var page = await ctx.newPage();
  page.__errors = [];
  page.on('pageerror', function (e) { page.__errors.push(String(e)); });
  await page.route(/^https?:\/\/(?!localhost)/, function (route) {
    if (route.request().url() === SDK_URL && SDK_FILE) return route.fulfill({ status: 200, contentType: 'application/javascript', body: fs.readFileSync(SDK_FILE), headers: { 'access-control-allow-origin': '*' } });
    return route.abort();
  });
  return page;
}
async function click(page, sel) { await page.evaluate(function (s) { var e = document.querySelector(s); if (e) e.click(); }, sel); await page.waitForTimeout(120); }
async function state(page, id) {
  return page.evaluate(function (id) {
    var e = document.getElementById(id), a = document.activeElement;
    return { exists: !!e, same: !!e && e.__m === true, focused: !!e && a === e, value: e ? e.value : null, start: e && e.selectionStart != null ? e.selectionStart : null };
  }, id);
}
async function mark(page, id) { await page.evaluate(function (id) { var e = document.getElementById(id); e.__m = true; e.focus(); }, id); }

// Typt teken voor teken en controleert na ELK teken dat het element hetzelfde bleef, gefocust is en de tekst + cursor kloppen.
async function typeAndVerify(page, label, id, text, opts) {
  opts = opts || {};
  await mark(page, id);
  if (opts.selectAll) await page.evaluate(function (id) { document.getElementById(id).select(); }, id);
  var bad = null, typed = '';
  for (var i = 0; i < text.length; i++) {
    await page.keyboard.type(text[i]);
    typed += text[i];
    await page.waitForTimeout(25);
    var s = await state(page, id);
    var expectVal = opts.expectValue ? opts.expectValue(typed) : typed;
    if (!s.exists || !s.same || !s.focused || s.value !== expectVal || (s.start != null && s.start !== expectVal.length)) { bad = { after: typed, s: s, expectVal: expectVal }; break; }
  }
  check(label + ': zelfde element, gefocust, tekst en cursor intact na elk teken', !bad, bad && JSON.stringify(bad));
}

async function main() {
  var browser = await chromium.launch({ executablePath: CHROMIUM_PATH });

  // ---------- gewone mobiele website (Safari-UA) ----------
  var page = await newPage(browser, IPHONE_UA);
  await page.goto(BASE + 'index.html'); await page.waitForTimeout(300);

  await typeAndVerify(page, 'Adres (onboarding, #addr-search)', 'addr-search', 'Kastanjelaan 12 Amersfoort');

  // resize terwijl het veld focus heeft (iOS: toetsenbord opent/wisselt van hoogte) -> mag het veld niet vervangen
  await mark(page, 'addr-search');
  await page.setViewportSize({ width: 390, height: 520 }); await page.waitForTimeout(300);
  await page.setViewportSize({ width: 390, height: 470 }); await page.waitForTimeout(300);
  await page.evaluate(function () { window.dispatchEvent(new Event('resize')); if (window.visualViewport) window.visualViewport.dispatchEvent(new Event('resize')); });
  await page.waitForTimeout(350);
  var s = await state(page, 'addr-search');
  check('Resize/toetsenbordhoogte-wijziging terwijl het veld focus heeft: zelfde element, nog gefocust, tekst intact', s.same && s.focused && s.value === 'Kastanjelaan 12 Amersfoort', JSON.stringify(s));
  await page.setViewportSize({ width: 390, height: 844 });

  // cursor midden in de tekst: knip "abc" -> "aXbc" zonder naar het einde te springen
  await page.evaluate(function () { var e = document.getElementById('addr-search'); e.value = ''; e.dispatchEvent(new Event('input', { bubbles: true })); });
  await mark(page, 'addr-search');
  await page.keyboard.type('abc'); await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowLeft'); await page.keyboard.type('X');
  await page.waitForTimeout(80);
  s = await state(page, 'addr-search');
  check('Invoegen midden in de tekst: waarde "aXbc", cursor na de X (niet naar begin of einde gesprongen)', s.same && s.focused && s.value === 'aXbc' && s.start === 2, JSON.stringify(s));

  // naar de app (voorbeeldgebouw)
  await click(page, '[data-act=skip-onboarding]');
  await click(page, '[data-act=set-tab][data-tab=home]');

  var before = await page.evaluate(function () { return document.body.innerText; });
  await typeAndVerify(page, 'Reservefonds nu (#fonds-bedrag, inputmode=numeric)', 'fonds-bedrag', '125000', { selectAll: true });
  var after = await page.evaluate(function () { return document.body.innerText; });
  check('Live-berekening blijft werken: verdict/saldo-tabel op Overzicht volgt het ingevulde saldo', before !== after && /laagste saldo in deze periode is € 10\d\.\d{3}/.test(after) && !/laagste saldo in deze periode is € 10\d\.\d{3}/.test(before), after.split('\n').filter(function (l) { return /laagste saldo/.test(l); }).join(' | '));

  await click(page, '[data-act=set-tab][data-tab=gebouw]');
  await mark(page, 'building-units');
  await page.evaluate(function () { document.getElementById('building-units').select(); });
  await page.keyboard.type('24'); await page.waitForTimeout(80);
  s = await state(page, 'building-units');
  check('Aantal appartementen (#building-units, type=number): zelfde element, gefocust, waarde 24', s.same && s.focused && s.value === '24', JSON.stringify(s));
  await click(page, '[data-act=set-tab][data-tab=home]');
  var txt = await page.evaluate(function () { return document.body.innerText; });
  check('Live-berekening blijft werken: Overzicht toont "24 appartementen" na de invoer', /24 appartementen/.test(txt));
  await click(page, '[data-act=set-tab][data-tab=gebouw]'); await click(page, '[data-act=set-tab][data-tab=home]');

  // hoeveelheid/prijs in een onderhoudselement
  await click(page, '[data-act=set-tab][data-tab=home]');
  await click(page, '[data-act=open-element][data-id=schilderwerk-buiten]');
  var hv = await page.evaluate(function () { return Array.from(document.querySelectorAll('input[id]')).map(function (e) { return e.id + ':' + e.dataset.bind + ':' + (e.type || ''); }); });
  var qtyId = (hv.map(function (x) { return x.split(':'); }).filter(function (p) { return /^(hv-|kg-|el-bedrag|el-jaar)/.test(p[0]); })[0] || [])[0];
  check('Element-detail heeft een bindbaar invoerveld (hoeveelheid/bedrag/jaar)', !!qtyId, hv.join(' '));
  if (qtyId) {
    await typeAndVerify(page, 'Element-invoer (#' + qtyId + ')', qtyId, '4321', { selectAll: true });
    var pre = await page.evaluate(function () { return document.body.innerText; });
    await page.keyboard.press('Tab'); await page.waitForTimeout(200);
    var post = await page.evaluate(function () { return document.body.innerText; });
    check('Na verlaten van het veld (change) wordt de hoeveelheid/kosten bijgewerkt', pre !== post, post.slice(0, 120).replace(/\n/g, ' | '));
  }

  // inloggen: e-mail (type=text, inputmode=email) en wachtwoord (type=password)
  await click(page, '[data-act=set-tab][data-tab=account]');
  await click(page, '[data-act=auth-mode-password]');
  if (await page.$('#auth-email')) {
    await typeAndVerify(page, 'Inloggen e-mail (#auth-email)', 'auth-email', 'naam@voorbeeld.nl');
    if (await page.$('#auth-password')) await typeAndVerify(page, 'Inloggen wachtwoord (#auth-password, type=password)', 'auth-password', 'Geheim#123', {});
  } else check('Inlogformulier gevonden', false, await page.evaluate(function () { return Array.from(document.querySelectorAll('[data-act]')).map(function (e) { return e.dataset.act; }).join(' '); }));
  check('Geen JavaScript-fouten (website)', page.__errors.length === 0, page.__errors.join('; '));
  await page.context().close();

  // ---------- iPhone-app (WKWebView met app-User-Agent): zelfde code, zelfde garantie ----------
  var app = await newPage(browser, APP_UA);
  await app.goto(BASE + 'index.html'); await app.waitForTimeout(300);
  await typeAndVerify(app, 'App-WebView: adres', 'addr-search', 'Dorpsstraat 1');
  await click(app, '[data-act=skip-onboarding]');
  await click(app, '[data-act=set-tab][data-tab=home]');
  await typeAndVerify(app, 'App-WebView: reservefonds', 'fonds-bedrag', '98765', { selectAll: true });
  await mark(app, 'fonds-bedrag');
  await app.setViewportSize({ width: 390, height: 500 }); await app.waitForTimeout(350);
  s = await state(app, 'fonds-bedrag');
  check('App-WebView: toetsenbord-resize vervangt het veld niet', s.same && s.focused && s.value === '98765', JSON.stringify(s));
  await app.context().close();

  // ---------- desktop: een breedtewissel moet nog wel van scherm wisselen (marketing <-> app) ----------
  var desk = await newPage(browser, undefined, 1280, 900);
  await desk.goto(BASE + 'index.html'); await desk.waitForTimeout(300);
  var hasMkt = await desk.evaluate(function () { return !!document.querySelector('.mkt-hero, .mkt-nav, [data-act=goto-login]'); });
  await desk.setViewportSize({ width: 390, height: 844 }); await desk.waitForTimeout(400);
  var hasOnb = await desk.evaluate(function () { return !!document.getElementById('addr-search'); });
  check('Desktop -> smal venster: marketing-pagina wisselt nog steeds naar het adresscherm (resize-gedrag behouden)', hasMkt && hasOnb, 'marketing=' + hasMkt + ' onboarding=' + hasOnb);
  await desk.context().close();

  await browser.close();
  var fail = 0;
  checks.forEach(function (c) { console.log((c[1] ? 'OK  ' : 'FAIL') + ' - ' + c[0] + (c[1] || !c[2] ? '' : '\n         ' + c[2])); if (!c[1]) fail++; });
  if (fail) { console.log(fail + ' controle(s) mislukt.'); process.exitCode = 1; return; }
  console.log('Alle controles geslaagd.');
}
main().catch(function (e) { console.error(e); process.exitCode = 1; });
