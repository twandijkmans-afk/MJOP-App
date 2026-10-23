'use strict';
// Browsertest: eenvoudige Start-pagina na het inloggen (drie keuzes), eenvoudige/uitgebreide weergave en projectkeuze.
// Echte supabase-js met een nagebootst Supabase-netwerk; ingelogd via een vooraf gezette sessie in de opslag.
//   python3 -m http.server 8962 &  ;  MJOP_TEST_BASE=http://localhost:8962/ MJOP_SUPABASE_SDK=/pad/supabase.js node test/start.spec.js
let chromium;
try { chromium = require('playwright').chromium; } catch (e) { chromium = require('/opt/node22/lib/node_modules/playwright').chromium; }
var fs = require('fs');
var BASE = process.env.MJOP_TEST_BASE || 'http://localhost:8962/';
var CHROMIUM_PATH = process.env.MJOP_CHROMIUM || '/opt/pw-browsers/chromium';
var SDK_URL = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.116.0/dist/umd/supabase.js';
var SDK_FILE = process.env.MJOP_SUPABASE_SDK || null;
var SHOTS = process.env.MJOP_SHOTS || null;
var TEST_HOST = 'testproject0000000000.supabase.co';
var TEST_CONFIG = "window.SUPABASE_CONFIG = { url: 'https://" + TEST_HOST + "', anonKey: 'sb_publishable_TESTKEYabcdefghijklmnop' };";
var CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS' };
var checks = [];
function check(name, ok, detail) { checks.push([name, !!ok, detail]); }
function b64u(o) { return Buffer.from(JSON.stringify(o)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'); }
function session() {
  var jwt = b64u({ alg: 'HS256' }) + '.' + b64u({ sub: 'u1', role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 }) + '.c2ln';
  return { access_token: jwt, token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'r-abc',
    user: { id: 'u1', aud: 'authenticated', role: 'authenticated', email: 'test@example.org', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' } };
}
var daysAgo = function (n) { return new Date(Date.now() - n * 86400000).toISOString(); };

async function newPage(ctx, o) {
  o = o || {};
  var page = await ctx.newPage(), st = { errors: [], plansUrls: [] };
  page.on('pageerror', function (e) { st.errors.push(String(e)); });
  await page.route(/^https?:\/\/(?!localhost)/, function (route) {
    var req = route.request(), url = req.url();
    if (url === SDK_URL) return SDK_FILE ? route.fulfill({ status: 200, contentType: 'application/javascript', body: fs.readFileSync(SDK_FILE), headers: { 'access-control-allow-origin': '*' } }) : route.continue();
    if (url.indexOf('https://' + TEST_HOST + '/') === 0) {
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
      var j = function (status, body) { return route.fulfill({ status: status, contentType: 'application/json', headers: CORS, body: JSON.stringify(body) }); };
      if (/\/auth\/v1\/user/.test(url)) return j(200, session().user);
      if (/\/rest\/v1\/saved_plans/.test(url)) {
        st.plansUrls.push(url);
        if (/[?&]id=eq\./.test(url)) return j(200, { id: 'p1', state: o.blob });
        if (o.rejectAlias && /invul/.test(url)) return j(400, { message: 'column not found' });
        return j(200, o.plans || []);
      }
      if (/\/rest\/v1\//.test(url)) return j(200, null);
      return j(200, {});
    }
    return route.abort();
  });
  await page.route('**/src/config.js', function (route) { route.fulfill({ status: 200, contentType: 'application/javascript', body: TEST_CONFIG }); });
  if (o.loggedIn) await page.addInitScript(function (s) { try { localStorage.setItem('sb-testproject0000000000-auth-token', JSON.stringify(s)); } catch (e) {} }, session());
  return { page: page, st: st };
}
async function text(page) { return page.evaluate(function () { return document.body.innerText; }); }
async function shot(page, name) { if (SHOTS) await page.screenshot({ path: SHOTS + '/' + name + '.png' }); }
async function fresh(page) { await page.evaluate(function () { sessionStorage.clear(); }); await page.goto(BASE + 'index.html'); await page.waitForTimeout(900); }
async function click(page, sel) { await page.evaluate(function (s) { var e = document.querySelector(s); if (e) e.click(); }, sel); await page.waitForTimeout(250); }

async function main() {
  var browser = await chromium.launch({ executablePath: CHROMIUM_PATH });
  var small = { viewport: { width: 375, height: 667 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
  var plans = [
    { id: 'p1', label: 'Kastanjelaan 12', adres: 'Kastanjelaan 12, Utrecht', updated_at: daysAgo(2), invul: { fonds: false, bijdrage: false } },
    { id: 'p2', label: 'Maldenhof 3', adres: 'Maldenhof 3, Zeist', updated_at: daysAgo(0), invul: { fonds: true, bijdrage: true } },
  ];

  // blob van een echt plan: het voorbeeldgebouw, zoals de app het zelf wegschrijft
  var seed = await newPage(await browser.newContext(small));
  await seed.page.goto(BASE + 'index.html'); await seed.page.waitForTimeout(300);
  await click(seed.page, '[data-act=skip-onboarding]'); await seed.page.waitForTimeout(300);
  var blob = await seed.page.evaluate(function () { return JSON.parse(sessionStorage.getItem('mjop-worksessie')).plan; });
  await seed.page.context().close();

  // 1. niet ingelogd op mobiel: ongewijzigd direct het adresscherm
  var ctx0 = await browser.newContext(small);
  var n = await newPage(ctx0);
  await n.page.goto(BASE + 'index.html'); await n.page.waitForTimeout(400);
  check('1. niet ingelogd: adreszoeker blijft de eerste stap', await n.page.evaluate(function () { return !!document.querySelector('#addr-search, [data-bind=addr-q]'); }));
  await ctx0.close();

  // 2. ingelogd: Start met drie keuzes
  var ctx = await browser.newContext(small);
  var a = await newPage(ctx, { loggedIn: true, plans: plans, blob: blob });
  var page = a.page;
  await page.goto(BASE + 'index.html'); await page.waitForTimeout(900);
  var t = await text(page);
  check('2. na inloggen: Start "Wat wil je doen?"', /Wat wil je doen\?/.test(t), t.slice(0, 100));
  check('2. drie hoofdacties', /Verder met mijn gebouw/.test(t) && /Nieuw MJOP maken/.test(t) && /Gebouw inspecteren/.test(t));
  check('2. per gebouw: laatste activiteit en volgende stap', /Laatst bewerkt 2 dagen geleden/.test(t) && /Volgende stap\s*Vul het saldo van de reservekas in/i.test(t) && /Laatst bewerkt vandaag/.test(t) && /Controleer het onderhoud/.test(t), t.slice(0, 600));
  check('2. geen technische termen op Start', !/PROPOSED|PHOTO_WALK_SCAN|LiDAR|schema|bridge/i.test(t));
  var geo = await page.evaluate(function () {
    var btns = Array.prototype.slice.call(document.querySelectorAll('.ov-btn')).map(function (b) { return b.getBoundingClientRect().height; });
    return { overflow: document.documentElement.scrollWidth > window.innerWidth, minBtn: Math.min.apply(null, btns), tabs: Array.prototype.slice.call(document.querySelectorAll('.tab-item')).map(function (e) { return e.textContent.trim(); }) };
  });
  check('2. 375px: geen horizontaal scrollen, knoppen minstens 44px hoog', !geo.overflow && geo.minBtn >= 44, JSON.stringify(geo));
  check('2. eenvoudige weergave: geen Fotoronde-tab, wel Start', geo.tabs.indexOf('Fotoronde') < 0 && geo.tabs.indexOf('Start') >= 0, geo.tabs.join(','));
  check('2. extra kolom "invul" gevraagd (alleen klein veld, geen hele blob)', a.st.plansUrls.some(function (u) { return /invul/.test(u) && !/select=[^&]*[,=]state(&|,|$)/.test(decodeURIComponent(u).replace('state->invul', '')); }), a.st.plansUrls[0]);
  await shot(page, 'start-375');

  // 3. Nieuw MJOP maken -> adreszoeker
  await click(page, '[data-act=wizard-start]');
  check('3. "Nieuw MJOP maken" opent de adreszoeker', await page.evaluate(function () { return !!document.querySelector('#addr-search, [data-bind=addr-q]'); }));

  // 4. Gebouw inspecteren zonder geopend gebouw: eerst kiezen
  await fresh(page);
  await click(page, '[data-act=start-inspecteer]');
  t = await text(page);
  check('4. "Gebouw inspecteren" vraagt eerst welk gebouw', /Welk gebouw wil je inspecteren\?/.test(t) && /Kastanjelaan 12/.test(t) && /Maldenhof 3/.test(t), t.slice(0, 200));
  await shot(page, 'start-kies-gebouw');
  await click(page, '[data-act=open-plan][data-id=p1][data-na=fotoronde]'); await page.waitForTimeout(500);
  var act = await page.evaluate(function () { var e = document.querySelector('.tab-item.active'); return e ? e.textContent.trim() : ''; });
  check('4. na kiezen: Fotoronde van dat gebouw open', act === 'Inspectie', act);
  check('4. gebouw is geladen (geen lege staat)', /Gebouw inspecteren/.test(await text(page)));

  // 5. Verder met mijn gebouw -> Overzicht van het gekozen gebouw
  await fresh(page);
  await click(page, '[data-act=open-plan][data-id=p2]'); await page.waitForTimeout(500);
  check('5. "Verder" opent het Overzicht', /Overzicht/.test(await page.evaluate(function () { return document.querySelector('.tab-item.active').textContent; })));
  // terug naar Start via tab, gebouw blijft staan en verschijnt bovenaan
  await click(page, '[data-act=set-tab][data-tab=start]');
  t = await text(page);
  check('5. terug naar Start: geopend gebouw staat bovenaan', /Wat wil je doen\?/.test(t) && t.indexOf('Maldenhof 3') > -1);
  check('5. gebouw met een open plan: "Gebouw inspecteren" gaat direct naar de Fotoronde', await (async function () { await click(page, '[data-act=start-inspecteer]'); return (await page.evaluate(function () { return document.querySelector('.tab-item.active').textContent; })) === 'Inspectie'; })());

  // 6. uitgebreide weergave: alle tabs
  await click(page, '[data-act=set-tab][data-tab=instellingen]');
  await click(page, '[data-act=toggle-eenvoudig]');
  var tabs2 = await page.evaluate(function () { return Array.prototype.slice.call(document.querySelectorAll('.tab-item')).map(function (e) { return e.textContent.trim(); }); });
  var s = await page.evaluate(function () { return localStorage.getItem('mjop-instellingen'); });
  check('6. instelling bewaard in localStorage', /eenvoudig/.test(s || ''), s);
  check('6. eenvoudige weergave uit: Fotoronde-tab zichtbaar', tabs2.indexOf('Fotoronde') >= 0, tabs2.join(','));
  check('6. geen JavaScript-fouten', a.st.errors.length === 0, a.st.errors.join('; '));
  await ctx.close();

  // 7. terugval: kolomverwijzing werkt niet -> lichte lijst, Start werkt nog
  var ctx2 = await browser.newContext(small);
  var b = await newPage(ctx2, { loggedIn: true, plans: plans, rejectAlias: true });
  await b.page.goto(BASE + 'index.html'); await b.page.waitForTimeout(900);
  t = await text(b.page);
  check('7. terugval op lichte lijst: gebouwen zichtbaar, volgende stap neutraal', /Kastanjelaan 12/.test(t) && b.st.plansUrls.length >= 2, b.st.plansUrls.length + ' ' + t.slice(0, 80));
  await ctx2.close();

  // 8. ingelogd, geen gebouwen: duidelijke lege staat
  var ctx3 = await browser.newContext(small);
  var c = await newPage(ctx3, { loggedIn: true, plans: [] });
  await c.page.goto(BASE + 'index.html'); await c.page.waitForTimeout(900);
  t = await text(c.page);
  check('8. nog geen gebouwen: uitleg + Nieuw MJOP maken', /Je hebt nog geen gebouw/.test(t));
  await shot(c.page, 'start-leeg-375');
  await ctx3.close();

  await browser.close();
  var failed = checks.filter(function (c) { return !c[1]; });
  checks.forEach(function (c) { console.log((c[1] ? 'OK   - ' : 'FAIL - ') + c[0] + (c[1] ? '' : ' [' + c[2] + ']')); });
  console.log(failed.length ? failed.length + ' controle(s) mislukt.' : 'Alle controles geslaagd.');
  process.exit(failed.length ? 1 : 0);
}
main().catch(function (e) { console.error(e); process.exit(2); });
