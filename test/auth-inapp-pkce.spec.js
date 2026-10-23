'use strict';
// Browsertest: inloggen in de iPhone-app (User-Agent "MJOPLiveApp/1"), end-to-end met de ECHTE supabase-js (2.116.0) en een nagebootst Supabase-netwerk.
//
//   1. inlogaanvraag in de app: PKCE (code_challenge) + redirect_to = brugpagina; de code-verifier wordt in localStorage van DEZE WebView bewaard
//   2. terugkeer met ?code=<code> op de startpagina (zoals de app dat laadt na mjoplive://auth-callback): supabase-js wisselt in via
//      POST /auth/v1/token?grant_type=pkce met auth_code + exact die verifier; er staan GEEN tokens in de URL
//   3. de gebruiker is ingelogd, opgeslagen MJOP's worden geladen (saved_plans met het toegangsbewijs van de sessie)
//   4. sessiebehoud: na herladen (en in een nieuwe pagina van dezelfde context = "app opnieuw geopend") nog steeds ingelogd, zonder verifier
//   5. verkeerde/verlopen code: duidelijke foutmelding, niet ingelogd
//   6. brugpagina in de app-WebView stuurt rechtstreeks door naar ./?code=…; buiten de app naar mjoplive://
//
//   python3 -m http.server 8937 &   ;   MJOP_SUPABASE_SDK=/pad/supabase.js node test/auth-inapp-pkce.spec.js
let chromium;
try { chromium = require('playwright').chromium; } catch (e) { chromium = require('/opt/node22/lib/node_modules/playwright').chromium; }
var fs = require('fs');

var BASE = process.env.MJOP_TEST_BASE || 'http://localhost:8937/';
var CHROMIUM_PATH = process.env.MJOP_CHROMIUM || '/opt/pw-browsers/chromium';
var SDK_URL = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.116.0/dist/umd/supabase.js';
var SDK_FILE = process.env.MJOP_SUPABASE_SDK || null;
var TEST_HOST = 'testproject0000000000.supabase.co';
var TEST_KEY = 'sb_publishable_TESTKEYabcdefghijklmnop';
var TEST_CONFIG = "window.SUPABASE_CONFIG = { url: 'https://" + TEST_HOST + "', anonKey: '" + TEST_KEY + "' };";
var APP_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MJOPLiveApp/1';
var CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS' };
var CODE = '3f1c2d7e-1111-2222-3333-444455556666';

var checks = [];
function check(name, ok, detail) { checks.push([name, !!ok, detail]); }
function b64u(o) { return Buffer.from(JSON.stringify(o)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'); }
function fakeJwt() { return b64u({ alg: 'HS256' }) + '.' + b64u({ sub: 'u1', role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 }) + '.c2ln'; }
function session() {
  return { access_token: fakeJwt(), token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'r-' + CODE.slice(0, 8),
    user: { id: 'u1', aud: 'authenticated', role: 'authenticated', email: 'test@example.org', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' } };
}

async function newAppPage(ctx, hooks) {
  var page = await ctx.newPage();
  var st = { reqs: [], tokenBodies: [], restAuth: [], urls: [], errors: [] };
  page.on('pageerror', function (e) { st.errors.push(String(e)); });
  page.on('framenavigated', function (f) { if (f === page.mainFrame()) st.urls.push(f.url()); });
  await page.route(/^https?:\/\/(?!localhost)/, function (route) {
    var req = route.request(), url = req.url();
    if (url === SDK_URL) return SDK_FILE ? route.fulfill({ status: 200, contentType: 'application/javascript', body: fs.readFileSync(SDK_FILE), headers: { 'access-control-allow-origin': '*' } }) : route.continue();
    if (url.indexOf('https://' + TEST_HOST + '/') === 0) {
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
      st.reqs.push(req.method() + ' ' + url);
      var j = function (status, body) { return route.fulfill({ status: status, contentType: 'application/json', headers: CORS, body: JSON.stringify(body) }); };
      if (/\/auth\/v1\/otp/.test(url)) return j(200, {});
      if (/\/auth\/v1\/token\?grant_type=pkce/.test(url)) {
        var body = JSON.parse(req.postData() || '{}'); st.tokenBodies.push(body);
        if (hooks && hooks.rejectCode) return j(400, { code: 'validation_failed', error_code: 'validation_failed', msg: 'invalid flow state, no valid flow state found' });
        return j(200, session());
      }
      if (/\/auth\/v1\/user/.test(url)) return j(200, session().user);
      if (/\/rest\/v1\/saved_plans/.test(url)) { st.restAuth.push(req.headers().authorization || ''); return j(200, [{ id: 'p1', label: 'Mijn VvE', adres: 'Kastanjelaan 12', updated_at: '2026-10-01T00:00:00Z' }]); }
      if (/\/rest\/v1\//.test(url)) return j(200, null);
      return j(200, {});
    }
    return route.abort();
  });
  await page.route('**/src/config.js', function (route) { route.fulfill({ status: 200, contentType: 'application/javascript', body: TEST_CONFIG }); });
  return { page: page, st: st };
}
async function text(page) { return page.evaluate(function () { return document.body.innerText; }); }
// supabase-js 2.116 bewaart een code-verifier per "flow" (meerdere openstaande aanvragen), JSON-gequote, onder sleutels die op -code-verifier eindigen.
async function verifiersInStorage(page) {
  return page.evaluate(function () {
    var out = [];
    Object.keys(localStorage).forEach(function (k) {
      if (!/code-verifier$/.test(k)) return;
      try { var v = JSON.parse(localStorage.getItem(k)); if (typeof v === 'string' && v.length >= 43) out.push(v); } catch (e) {}
    });
    return out;
  });
}

async function main() {
  var browser = await chromium.launch({ executablePath: CHROMIUM_PATH });
  // mobiel venster, zoals in de app
  var ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, userAgent: APP_UA, isMobile: true, hasTouch: true });
  var a = await newAppPage(ctx);
  var page = a.page, st = a.st;

  // 1. inlogaanvraag (mobiel: tabblad Account -> inlogformulier)
  await page.goto(BASE + 'index.html');
  await page.waitForTimeout(300);
  await page.evaluate(function () { var b = document.querySelector('[data-act=skip-onboarding]'); if (b) b.click(); });
  await page.waitForTimeout(250);
  await page.evaluate(function () { var t = document.querySelector('[data-act=set-tab][data-tab=account]'); if (t) t.click(); });
  await page.waitForTimeout(200);
  await page.evaluate(function () { var b = document.querySelector('[data-act=auth-mode-magic]'); if (b) b.click(); });
  await page.waitForTimeout(150);
  await page.fill('#auth-email', 'test@example.org');
  await page.dispatchEvent('#auth-email', 'input');
  var otpReq = page.waitForRequest(function (r) { return /\/auth\/v1\/otp/.test(r.url()); }, { timeout: 5000 }).catch(function () { return null; });
  await page.click('[data-act=login-request]');
  var otp = await otpReq;
  var otpUrl = otp ? new URL(otp.url()) : null;
  var otpBody = otp ? JSON.parse(otp.postData() || '{}') : {};
  check('1. aanvraag in de app: PKCE (code_challenge S256)', otpBody.code_challenge && /s256/i.test(otpBody.code_challenge_method || ''), JSON.stringify(otpBody));
  check('1. redirect_to = brugpagina app-callback.html', otpUrl && otpUrl.searchParams.get('redirect_to') === BASE + 'app-callback.html', otpUrl && otpUrl.search);
  await page.waitForTimeout(300);
  var verifiers = await verifiersInStorage(page);
  if (process.env.DEBUG_LS) console.log(JSON.stringify(await page.evaluate(function () { var o = {}; Object.keys(localStorage).forEach(function (k) { o[k] = String(localStorage.getItem(k)).slice(0, 80); }); return o; })));
  check('1. code-verifier bewaard in de localStorage van deze WebView (blijft na herstart van de app bestaan)', verifiers.length >= 1, verifiers.length);
  var hint = await page.evaluate(function () { return !!document.querySelector('[data-inapp-login-hint]'); });
  check('1. in de app: hulptekst "Inloglink of code plakken" zichtbaar na versturen', hint);

  // 2. terugkeer met ?code
  var tokenReq = page.waitForRequest(function (r) { return /grant_type=pkce/.test(r.url()); }, { timeout: 8000 }).catch(function () { return null; });
  await page.goto(BASE + '?code=' + CODE);
  await tokenReq;
  await page.waitForTimeout(700);
  var tb = st.tokenBodies[0] || {};
  check('2. code ingewisseld via grant_type=pkce met auth_code', tb.auth_code === CODE, JSON.stringify(Object.keys(tb)));
  check('2. mét exact de bewaarde code-verifier', verifiers.some(function (v) { return String(tb.code_verifier).indexOf(v) === 0; }), 'sent=' + String(tb.code_verifier).length + ' stored=' + verifiers.map(function (v) { return v.length; }));
  check('2. URL na inloggen bevat geen code of tokens meer', !/code=|access_token|refresh_token/.test(page.url()), page.url());
  check('2. geen tokens in enige navigatie-URL', st.urls.every(function (u) { return !/access_token|refresh_token/.test(u); }), st.urls.join(' '));

  // 3. ingelogd + opgeslagen MJOP's
  var t3 = await text(page);
  check('3. ingelogd: e-mailadres zichtbaar', /test@example\.org/.test(t3), t3.slice(0, 120));
  check('3. opgeslagen MJOP-aanvraag met Bearer-toegangsbewijs van de sessie (RLS)', st.restAuth.length > 0 && st.restAuth.every(function (h) { return /^Bearer eyJ/.test(h); }), JSON.stringify(st.restAuth.slice(0, 1)));
  check('3. geen JavaScript-fouten', st.errors.length === 0, st.errors.join('; '));

  // 4. sessiebehoud: herladen + "app opnieuw geopend" (nieuwe pagina, zelfde opslag)
  await page.reload(); await page.waitForTimeout(700);
  check('4. na herladen nog ingelogd', /test@example\.org/.test(await text(page)));
  var again = await newAppPage(ctx);
  await again.page.goto(BASE + 'index.html'); await again.page.waitForTimeout(800);
  check('4. nieuwe pagina in dezelfde opslag (app heropend): opgeslagen MJOP "Mijn VvE" geladen met sessie, zonder nieuwe code-uitwisseling', /Mijn VvE/.test(await text(again.page)) && again.st.restAuth.length > 0 && again.st.tokenBodies.length === 0, 'tokenBodies=' + again.st.tokenBodies.length + ' text=' + (await text(again.page)).slice(0,80).replace(/\n/g,' '));
  await again.page.close();
  await ctx.close();

  // 5. verkeerde/verlopen code
  ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, userAgent: APP_UA, isMobile: true, hasTouch: true });
  var b = await newAppPage(ctx, { rejectCode: true });
  await b.page.goto(BASE + '?code=' + CODE); await b.page.waitForTimeout(900);
  var t5 = await text(b.page);
  check('5. ongeldige code: niet ingelogd', !/test@example\.org/.test(t5));
  await ctx.close();

  // 6. brugpagina
  ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, userAgent: APP_UA });
  var c = await newAppPage(ctx);
  await c.page.goto(BASE + 'app-callback.html?code=' + CODE, { waitUntil: 'domcontentloaded' }); await c.page.waitForTimeout(600);
  check('6. brugpagina in de app-WebView: rechtstreeks door naar ./?code=…', c.st.urls.some(function (u) { return u.indexOf(BASE + '?code=' + CODE) === 0; }), c.st.urls.join(' '));
  await c.page.goto(BASE + 'app-callback.html?error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired');
  await c.page.waitForTimeout(300);
  check('6. fout op de brugpagina (in app): melding, geen doorsturen met code', /niet gelukt/.test(await text(c.page)));
  await ctx.close();
  ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  var d = await ctx.newPage();
  await d.goto(BASE + 'app-callback.html?code=' + CODE, { waitUntil: 'domcontentloaded' }).catch(function () {}); await d.waitForTimeout(300);
  var shown = await d.evaluate(function () { return { href: document.getElementById('open').getAttribute('href'), help: !document.getElementById('hulp').hidden, copy: !document.getElementById('kopieer').hidden }; });
  check('6. buiten de app (Safari): knop "Open MJOP Live" -> mjoplive://, hulptekst en "Kopieer inlogcode"', shown.href === 'mjoplive://auth-callback?code=' + CODE && shown.help && shown.copy, JSON.stringify(shown));
  await d.goto(BASE + 'app-callback.html?error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired', { waitUntil: 'domcontentloaded' }).catch(function () {});
  await d.waitForTimeout(200);
  var errHref = await d.evaluate(function () { return document.getElementById('open').getAttribute('href'); });
  check('6. verlopen link: mjoplive://…?error_description=…&error_code=otp_expired (geen code)', /^mjoplive:\/\/auth-callback\?error_description=.*&error_code=otp_expired$/.test(errHref) && errHref.indexOf('code=' + CODE) < 0, errHref);
  await ctx.close();

  await browser.close();
  var fail = 0;
  checks.forEach(function (c2) { console.log((c2[1] ? 'OK  ' : 'FAIL') + ' - ' + c2[0] + (c2[1] || !c2[2] ? '' : ' [' + c2[2] + ']')); if (!c2[1]) fail++; });
  if (fail) { console.log(fail + ' controle(s) mislukt.'); process.exitCode = 1; return; }
  console.log('Alle controles geslaagd.');
}
main().catch(function (e) { console.error(e); process.exitCode = 1; });
