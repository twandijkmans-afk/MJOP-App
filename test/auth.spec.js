'use strict';
// Browsertest: Supabase-inloggen (inloglink / OTP) met echte foutdiagnostiek.
//
// De echte Supabase-SDK (supabase-js 2.116.0, zelfde versie + SRI als index.html) draait in de browser; alleen
// het netwerk naar Supabase wordt nagebootst, met een TEST-configuratie (geen echt project, geen echte sleutel):
//
//   - SDK ontbreekt            -> SDK_NOT_LOADED
//   - config ontbreekt          -> CONFIG_MISSING
//   - fetch faalt (netwerk)     -> NETWORK_ERROR, "Kan geen verbinding maken met de inlogservice." (niet "Failed to fetch")
//   - Supabase-foutantwoord     -> SUPABASE_AUTH_ERROR
//   - geslaagde OTP-aanvraag    -> "Inloglink verstuurd", juiste redirect_to
//   - geen sleutels/tokens in foutmeldingen of console
//   - debug/auth-health.html: health check zonder login
//
// SDK: standaard via de CDN (jsdelivr). Zonder internettoegang kan de SDK lokaal worden aangeboden met
// MJOP_SUPABASE_SDK=/pad/naar/supabase.js (het bestand dist/umd/supabase.js uit het npm-pakket
// @supabase/supabase-js@2.116.0); de SRI-hash in index.html moet dan nog steeds kloppen.
//
//   python3 -m http.server 8937 &   ;   node test/auth.spec.js

let chromium;
try {
  chromium = require('playwright').chromium;
} catch (e) {
  chromium = require('/opt/node22/lib/node_modules/playwright').chromium;
}
var fs = require('fs');

var BASE = process.env.MJOP_TEST_BASE || 'http://localhost:8937/';
var CHROMIUM_PATH = process.env.MJOP_CHROMIUM || '/opt/pw-browsers/chromium';
var SDK_URL = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.116.0/dist/umd/supabase.js';
var SDK_FILE = process.env.MJOP_SUPABASE_SDK || null;
var TEST_HOST = 'testproject0000000000.supabase.co';
var TEST_KEY = 'sb_publishable_TESTONLY_not_a_real_key_123456';
var TEST_CONFIG = "window.SUPABASE_CONFIG = { url: 'https://" + TEST_HOST + "', anonKey: '" + TEST_KEY + "' };";
var REAL_CONFIG = fs.readFileSync(require('path').join(__dirname, '..', 'src', 'config.js'), 'utf8');
var REAL_KEY = (/anonKey:\s*'([^']+)'/.exec(REAL_CONFIG) || [])[1] || '';

async function setup(context, opts) {
  opts = opts || {};
  var page = await context.newPage();
  var state = { requests: [], console: [], errors: [], otpBodies: [] };
  page.on('console', function (m) { state.console.push(m.text()); });
  page.on('pageerror', function (e) { state.errors.push(String(e)); });
  // alles buiten localhost en de nagebootste Supabase-host: niet ophalen (fonts, pdf.js, CBS, …)
  await page.route(/^https?:\/\/(?!localhost)/, function (route) {
    var url = route.request().url();
    if (url === SDK_URL && !opts.noSdk) {
      if (SDK_FILE) return route.fulfill({ status: 200, contentType: 'application/javascript', body: fs.readFileSync(SDK_FILE),
        headers: { 'access-control-allow-origin': '*' } });
      return route.continue();
    }
    if (url.indexOf('https://' + TEST_HOST + '/') === 0) {
      state.requests.push({ url: url, method: route.request().method() });
      if (opts.supabase) return opts.supabase(route, state);
    }
    return route.abort();
  });
  await page.route('**/src/config.js', function (route) {
    route.fulfill({ status: 200, contentType: 'application/javascript', body: opts.config != null ? opts.config : TEST_CONFIG });
  });
  return { page: page, state: state };
}

var CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS' };
function json(route, status, body) {
  if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
  return route.fulfill({ status: status, contentType: 'application/json', headers: CORS, body: JSON.stringify(body) });
}

async function openMagic(page, path) {
  await page.goto(BASE + (path || 'index.html'));
  await page.waitForTimeout(200);
  await page.evaluate(function () { var el = document.querySelector('[data-act=goto-login]'); if (el) el.click(); });
  await page.waitForTimeout(150);
}

async function requestLink(page, email) {
  await page.click('[data-act=auth-mode-magic]');
  await page.waitForTimeout(100);
  await page.fill('#auth-email', email);
  await page.dispatchEvent('#auth-email', 'input');
  await page.click('[data-act=login-request]');
  await page.waitForTimeout(400);
}

async function errorBox(page) {
  return page.evaluate(function () {
    var e = document.querySelector('[data-auth-error]');
    return e ? { code: e.getAttribute('data-auth-error-code'), text: e.textContent } : null;
  });
}

async function main() {
  var browser = await chromium.launch({ executablePath: CHROMIUM_PATH });
  var checks = [];
  function check(naam, ok, info) { checks.push([naam + (info ? ' (' + info + ')' : ''), !!ok]); }
  var allConsole = [], allText = [];

  // 1. SDK ontbreekt
  var ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  var s = await setup(ctx, { noSdk: true });
  await openMagic(s.page);
  var e = await errorBox(s.page);
  check('SDK ontbreekt -> SDK_NOT_LOADED met uitleg', e && e.code === 'SDK_NOT_LOADED' && /inlogmodule kon niet geladen worden/.test(e.text), JSON.stringify(e));
  check('SDK ontbreekt: geen JavaScript-fouten', s.state.errors.length === 0, s.state.errors.join(' | '));
  allConsole = allConsole.concat(s.state.console); allText.push(e && e.text);
  await ctx.close();

  // 2. config ontbreekt
  ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  s = await setup(ctx, { config: "window.SUPABASE_CONFIG = { url: '', anonKey: '' };" });
  await openMagic(s.page);
  e = await errorBox(s.page);
  check('Config ontbreekt -> CONFIG_MISSING', e && e.code === 'CONFIG_MISSING' && /nog niet geconfigureerd/.test(e.text), JSON.stringify(e));
  await ctx.close();

  // 2b. geheime sleutel in config -> geweigerd, geen client
  ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  s = await setup(ctx, { config: "window.SUPABASE_CONFIG = { url: 'https://" + TEST_HOST + "', anonKey: 'sb_secret_DONOTUSE123' };" });
  await openMagic(s.page);
  e = await errorBox(s.page);
  check('Geheime sleutel in config wordt geweigerd (CONFIG_MISSING), sleutel niet getoond', e && e.code === 'CONFIG_MISSING' &&
    /GEHEIME sleutel/.test(e.text) && e.text.indexOf('DONOTUSE') === -1, JSON.stringify(e));
  await ctx.close();

  // 3. netwerkfout (fetch reject) — precies de productieklacht "Failed to fetch"
  ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  s = await setup(ctx, { supabase: function (route) { return route.abort('namenotresolved'); } });
  await openMagic(s.page);
  var sdkLoaded = await s.page.evaluate(function () { return !!(window.supabase && window.supabase.createClient); });
  check('Echte Supabase-SDK geladen (SRI geldig)', sdkLoaded);
  await requestLink(s.page, 'test@example.org');
  e = await errorBox(s.page);
  check('Netwerkfout -> NETWORK_ERROR: "Kan geen verbinding maken met de inlogservice."', e && e.code === 'NETWORK_ERROR' &&
    /^Kan geen verbinding maken met de inlogservice\./.test(e.text) && !/Failed to fetch/.test(e.text), JSON.stringify(e));
  check('Netwerkfout: het OTP-verzoek ging echt naar <project>/auth/v1/otp', s.state.requests.some(function (r) { return /\/auth\/v1\/otp\?/.test(r.url); }),
    s.state.requests.map(function (r) { return r.method + ' ' + r.url; }).join(' | '));
  var log = s.state.console.filter(function (l) { return /^\[auth\] NETWORK_ERROR/.test(l); })[0] || '';
  check('Development-log: code, actie, host, error.name, error.message', /action=signInWithOtp host=testproject0000000000\.supabase\.co error\.name=AuthRetryableFetchError error\.message=Failed to fetch/.test(log), log);
  allConsole = allConsole.concat(s.state.console); allText.push(e && e.text);
  await ctx.close();

  // 4. Supabase-foutantwoord
  ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  s = await setup(ctx, { supabase: function (route) { return json(route, 429, { code: 429, error_code: 'over_email_send_rate_limit', msg: 'email rate limit exceeded' }); } });
  await openMagic(s.page);
  await requestLink(s.page, 'test@example.org');
  e = await errorBox(s.page);
  check('Supabase-fout (429) -> SUPABASE_AUTH_ERROR met NL-uitleg', e && e.code === 'SUPABASE_AUTH_ERROR' && /te veel inlogmails/.test(e.text), JSON.stringify(e));
  allConsole = allConsole.concat(s.state.console); allText.push(e && e.text);
  await ctx.close();

  // 5. geslaagde OTP-aanvraag + juiste redirect_to (index.html -> map)
  ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  var otpReq = null;
  s = await setup(ctx, { supabase: function (route) {
    var req = route.request();
    if (req.method() === 'POST' && /\/auth\/v1\/otp/.test(req.url())) otpReq = { url: req.url(), body: req.postData(), headers: req.headers() };
    return json(route, 200, {});
  } });
  await openMagic(s.page, 'index.html');
  await requestLink(s.page, 'test@example.org');
  var sent = await s.page.evaluate(function () { return document.body.innerText; });
  var redirect = otpReq ? new URL(otpReq.url).searchParams.get('redirect_to') : null;
  check('Geslaagd: "Inloglink verstuurd", geen foutmelding', /Inloglink verstuurd/.test(sent) && !(await errorBox(s.page)));
  check('redirect_to = origin + map (zonder index.html): ' + BASE, redirect === BASE, redirect);
  check('OTP-body bevat alleen het e-mailadres (geen wachtwoord)', otpReq && JSON.parse(otpReq.body).email === 'test@example.org' && !/password/.test(otpReq.body), otpReq && otpReq.body);
  check('Publieke sleutel gaat alleen als apikey-header mee (zoals de SDK hoort)', otpReq && otpReq.headers.apikey === TEST_KEY);
  allConsole = allConsole.concat(s.state.console);
  await ctx.close();

  // 6. redirect via de map zelf (/), zoals op GitHub Pages /MJOP-App/
  ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  otpReq = null;
  s = await setup(ctx, { supabase: function (route) {
    var req = route.request();
    if (req.method() === 'POST' && /\/auth\/v1\/otp/.test(req.url())) otpReq = { url: req.url() };
    return json(route, 200, {});
  } });
  await openMagic(s.page, '');
  await requestLink(s.page, 'test@example.org');
  redirect = otpReq ? new URL(otpReq.url).searchParams.get('redirect_to') : null;
  check('Via de map (/): zelfde redirect_to', redirect === BASE, redirect);
  await ctx.close();

  // 7. health check (debugpagina): ok en netwerkfout, zonder login
  ctx = await browser.newContext({ viewport: { width: 1000, height: 800 } });
  s = await setup(ctx, { supabase: function (route) { return json(route, 200, { name: 'GoTrue', version: 'test' }); } });
  await s.page.goto(BASE + 'debug/auth-health.html');
  await s.page.click('#run');
  await s.page.waitForSelector('#summary');
  var h = await s.page.evaluate(function () {
    return { ok: document.querySelector('#summary').dataset.healthOk, steps: Array.prototype.map.call(document.querySelectorAll('[data-step]'), function (r) { return r.dataset.step + ':' + r.dataset.ok; }),
      text: document.body.innerText };
  });
  check('Health check: alle stappen OK', h.ok === 'true' && h.steps.join(',') === 'SDK_LOADED:true,CONFIG_PRESENT:true,URL_PARSEABLE:true,REDIRECT_URL:true,HOST_REACHABLE:true', h.steps.join(','));
  check('Health check: alleen GET /auth/v1/health, geen login/POST', s.state.requests.length === 1 && s.state.requests[0].method === 'GET' &&
    /\/auth\/v1\/health$/.test(s.state.requests[0].url), s.state.requests.map(function (r) { return r.method + ' ' + r.url; }).join(' | '));
  check('Health check toont geen sleutel; redirect = app-map', h.text.indexOf(TEST_KEY) === -1 && h.text.indexOf(BASE) > -1);
  await ctx.close();
  ctx = await browser.newContext({ viewport: { width: 1000, height: 800 } });
  s = await setup(ctx, { supabase: function (route) { return route.abort('namenotresolved'); } });
  await s.page.goto(BASE + 'debug/auth-health.html');
  await s.page.click('#run');
  await s.page.waitForSelector('#summary');
  h = await s.page.evaluate(function () { return { ok: document.querySelector('#summary').dataset.healthOk, code: document.querySelector('#summary').dataset.healthCode }; });
  check('Health check bij onbereikbare host -> NETWORK_ERROR', h.ok === 'false' && h.code === 'NETWORK_ERROR', JSON.stringify(h));
  await ctx.close();

  // 8. geen secrets in meldingen of console
  var blob = allConsole.join('\n') + '\n' + allText.join('\n');
  check('Geen sleutels/tokens in foutmeldingen of console', blob.indexOf(TEST_KEY) === -1 && (!REAL_KEY || blob.indexOf(REAL_KEY) === -1) &&
    !/eyJ[A-Za-z0-9_\-]{10,}\./.test(blob) && !/sb_secret_/.test(blob));

  await browser.close();
  var fail = 0;
  checks.forEach(function (c) { console.log((c[1] ? 'OK  ' : 'FAIL') + ' - ' + c[0]); if (!c[1]) fail++; });
  if (fail) { console.log(fail + ' controle(s) mislukt.'); process.exitCode = 1; return; }
  console.log('Alle controles geslaagd.');
}

main().catch(function (e) { console.error(e); process.exitCode = 1; });
