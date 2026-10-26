'use strict';
// Browsertest: laden na het kiezen van een adres bij 'Nieuw MJOP maken': het laadscherm verdwijnt altijd en de gebruiker komt automatisch bij 'Is dit je gebouw?'.
// Echte supabase-js met een nagebootst Supabase-netwerk; ingelogd via een vooraf gezette sessie in de opslag.
//   python3 -m http.server 8964 &  ;  MJOP_TEST_BASE=http://localhost:8964/ MJOP_SUPABASE_SDK=/pad/supabase.js node test/lookup-laden.spec.js
let chromium;
try { chromium = require('playwright').chromium; } catch (e) { chromium = require('/opt/node22/lib/node_modules/playwright').chromium; }
var fs = require('fs');
var BASE = process.env.MJOP_TEST_BASE || 'http://localhost:8964/';
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
  var lon = 4.9, lat = 52.37, d = 0.0001;
  await page.route('**/locatieserver/search/v3_1/suggest**', function (r) { r.fulfill({ contentType: 'application/json', body: JSON.stringify({ response: { docs: [{ id: 'adr-1', weergavenaam: 'Teststraat 1, 1000AA Amsterdam' }] } }) }); });
  await page.route('**/locatieserver/search/v3_1/lookup**', function (r) {
    if (o.mode && o.mode.pdok === 'hang') return;
    if (o.mode && o.mode.pdok === 'slow') return setTimeout(function () { r.fulfill({ contentType: 'application/json', body: JSON.stringify({ response: { docs: [{ weergavenaam: 'Teststraat 1, 1000AA Amsterdam', centroide_ll: 'POINT(4.9 52.37)' }] } }) }); }, 2000); r.fulfill({ contentType: 'application/json', body: JSON.stringify({ response: { docs: [{ weergavenaam: 'Teststraat 1, 1000AA Amsterdam', centroide_ll: 'POINT(' + lon + ' ' + lat + ')' }] } }) }); });
  await page.route('**/kadaster/bag/ogc/v2/collections/pand/items**', function (r) {
    if (o.mode && o.mode.bag === 'hang' && !o.state.fixed) return;
    var ring = [[lon - d, lat - d], [lon + d, lat - d], [lon + d, lat + d], [lon - d, lat + d], [lon - d, lat - d]];
    r.fulfill({ contentType: 'application/json', body: JSON.stringify({ features: [{ geometry: { type: 'Polygon', coordinates: [ring] }, properties: { identificatie: '0363100012345678', bouwjaar: 1972, gebruiksdoel: 'woonfunctie', aantal_verblijfsobjecten: 12 } }] }) });
  });
  await page.route('**/api.3dbag.nl/**', function (r) {
    if (o.mode && o.mode.d3 === 'hang') return;
    if (o.mode && o.mode.d3 === 'slow') return setTimeout(function () { r.fulfill({ contentType: 'application/json', body: JSON.stringify({ feature: { CityObjects: { 'NL.IMBAG.Pand.0363100012345678': { attributes: { b3_opp_dak_plat: 312.64, b3_opp_dak_schuin: 0, b3_opp_buitenmuur: 1099.7, b3_opp_grond: 318.2, b3_bouwlagen: 4, b3_dak_type: 'horizontal', b3_h_dak_max: 13.4, b3_h_maaiveld: 0.6 } } } } }) }); }, 2500);
    r.fulfill({ contentType: 'application/json', body: JSON.stringify({ feature: { CityObjects: { 'NL.IMBAG.Pand.0363100012345678': { attributes: { b3_opp_dak_plat: 312.64, b3_opp_dak_schuin: 0, b3_opp_buitenmuur: 1099.7, b3_opp_grond: 318.2, b3_bouwlagen: 4, b3_dak_type: 'horizontal', b3_h_dak_max: 13.4, b3_h_maaiveld: 0.6 } } } } }) });
  });
  if (o.loggedIn) await page.addInitScript(function (s) { try { localStorage.setItem('sb-testproject0000000000-auth-token', JSON.stringify(s)); } catch (e) {} }, session());
  return { page: page, st: st };
}
async function text(page) { return page.evaluate(function () { return document.body.innerText; }); }
async function shot(page, name) { if (SHOTS) await page.screenshot({ path: SHOTS + '/' + name + '.png' }); }
async function fresh(page) { await page.evaluate(function () { sessionStorage.clear(); }); await page.goto(BASE + 'index.html'); await page.waitForTimeout(900); }
async function click(page, sel) { await page.evaluate(function (s) { var e = document.querySelector(s); if (e) e.click(); }, sel); await page.waitForTimeout(250); }


var UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MJOPLiveApp/1';
var PLANS = [{ id: 'p1', label: 'Teststraat 1, 1000AA Amsterdam', adres: 'Teststraat 1, 1000AA Amsterdam', updated_at: new Date().toISOString(), invul: { fonds: true, bijdrage: true } }];
var LOADER = /Pand opzoeken|Bouwjaar en appartementen|Pand en grondvlak verwerken/;

// Opent de app (iPhone-WebView: app-UA + brug) op de adreszoeker van "Nieuw MJOP maken" en kiest het adres.
async function openAndPick(browser, o, limits) {
  var ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: UA });
  o.state = o.state || {};
  var a = await newPage(ctx, Object.assign({ loggedIn: true, plans: PLANS }, o));
  var page = a.page;
  await page.addInitScript(function (l) { window.webkit = { messageHandlers: { mjopNative: { postMessage: function () {} } } }; if (l) window.__mjopLookupMs = l; }, limits || null);
  await page.goto(BASE + 'index.html'); await page.waitForTimeout(800);
  await click(page, '[data-act=wizard-start]');
  await page.fill('#addr-search', 'Teststraat 1'); await page.dispatchEvent('#addr-search', 'input');
  await page.waitForSelector('.suggest-row', { timeout: 5000 });
  await page.evaluate(function () { document.querySelector('.suggest-row').click(); });
  return { ctx: ctx, page: page, a: a };
}

async function main() {
  var browser = await chromium.launch({ executablePath: CHROMIUM_PATH });
  var t;

  // A. trage maar succesvolle 3D BAG (2,5 s): de wizard wacht er niet op; de 3D-waarden komen daarna binnen
  var r = await openAndPick(browser, { mode: { d3: 'slow' } });
  await r.page.waitForSelector('.wz-voortgang', { timeout: 2000 });
  t = await text(r.page);
  check('A. "Is dit je gebouw?" verschijnt zonder op de 3D BAG te wachten, met voortgang voor de 3D BAG', /Is dit je gebouw\?/.test(t) && (await r.page.$eval('[data-d3-status]', function (e) { return e.dataset.d3Status; })) === 'LADEN');
  await r.page.waitForSelector('[data-d3-status=OK]', { timeout: 8000 });
  t = await text(r.page);
  check('A. daarna verdwijnt het laadscherm automatisch', !LOADER.test(t), t.slice(0, 120));
  check('A. automatisch naar "Is dit je gebouw?" met adres en gegevens (zonder extra tik)', /Is dit je gebouw\?/.test(t) && /Teststraat 1/.test(t) && /Stap 1 van 4/i.test(t) && /Uit de BAG/i.test(t));
  check('A. geen melding "geen 3D BAG" als de 3D BAG wel antwoordde', !(await r.page.$('[data-wz-geen-3d]')));
  var st = await r.page.evaluate(function () { return JSON.parse(sessionStorage.getItem('mjop-worksessie')); });
  check('A. werkstand: scherm app, tab wizard, stap 1, gebouw staat in het plan', st.screen === 'app' && st.tab === 'wizard' && st.plan.wizard && st.plan.wizard.stap === 1 && /Teststraat 1/.test(st.plan.building.adres), JSON.stringify([st.screen, st.tab]));
  await click(r.page, '[data-act=wizard-volgende]');
  check('A. bevestigen gaat door naar stap 2', /Controleer je gebouw/.test(await text(r.page)));
  check('A. geen JavaScript-fouten', r.a.st.errors.length === 0, r.a.st.errors.join('; '));
  await r.ctx.close();

  // B. 3D BAG antwoordt nooit: na de tijdslimiet toch "Is dit je gebouw?" met een eerlijke melding
  r = await openAndPick(browser, { mode: { d3: 'hang' } }, { d3: 1200 });
  await r.page.waitForSelector('.wz-voortgang', { timeout: 8000 });
  t = await text(r.page);
  check('B. 3D BAG hangt: laadscherm verdwijnt en "Is dit je gebouw?" verschijnt', !LOADER.test(t) && /Is dit je gebouw\?/.test(t));
  await r.page.waitForSelector('[data-d3-status=TIMEOUT]', { timeout: 5000 });
  t = await text(r.page);
  check('B. eerlijke melding: 3D BAG gaf geen gegevens, dak en gevel geschat', !!(await r.page.$('[data-wz-geen-3d]')) && /geschat uit het grondvlak/.test(t));
  await r.page.screenshot({ path: (process.env.MJOP_SHOTS || '/tmp') + '/laden-3dbag-hangt.png' });
  await r.ctx.close();

  // C. BAG-pand hangt: duidelijke foutmelding, laadscherm weg, opnieuw proberen werkt
  var o = { mode: { bag: 'hang' }, state: { fixed: false } };
  r = await openAndPick(browser, o, { bag: 1000 });
  await r.page.waitForSelector('.notice.error', { timeout: 8000 });
  t = await text(r.page);
  check('C. BAG hangt: foutmelding "duurt te lang", geen laadscherm meer', /duurt te lang/.test(t) && !LOADER.test(t), t.slice(0, 200));
  check('C. zoekveld blijft bruikbaar', !!(await r.page.$('#addr-search')));
  o.state.fixed = true;
  await r.page.fill('#addr-search', 'Teststraat 1'); await r.page.dispatchEvent('#addr-search', 'input');
  await r.page.waitForSelector('.suggest-row', { timeout: 5000 });
  await r.page.evaluate(function () { document.querySelector('.suggest-row').click(); });
  await r.page.waitForSelector('.wz-voortgang', { timeout: 8000 });
  check('C. opnieuw proberen lukt en brengt bij "Is dit je gebouw?"', /Is dit je gebouw\?/.test(await text(r.page)));
  await r.ctx.close();

  // D. alles hangt: totale tijdslimiet
  r = await openAndPick(browser, { mode: { pdok: 'hang' } }, { pdok: 60000, totaal: 1500 });
  await r.page.waitForSelector('.notice.error', { timeout: 8000 });
  check('D. totale tijdslimiet: melding i.p.v. eeuwig laden', /duurt te lang/.test(await text(r.page)) && !LOADER.test(await text(r.page)));
  await r.ctx.close();

  // E. annuleren: een later binnenkomend antwoord overschrijft niets
  r = await openAndPick(browser, { mode: { pdok: 'slow' } });
  await r.page.waitForSelector('[data-act=annuleer-zoeken]', { timeout: 3000 });
  await click(r.page, '[data-act=annuleer-zoeken]');
  check('E. annuleren: laadscherm weg, zoekveld terug', !LOADER.test(await text(r.page)) && !!(await r.page.$('#addr-search')));
  await r.page.waitForTimeout(4500);
  t = await text(r.page);
  check('E. een laat antwoord na annuleren verandert niets (geen wizard, nog op het adresscherm)', !(await r.page.$('.wz-voortgang')) && !!(await r.page.$('#addr-search')), t.slice(0, 100));
  await r.ctx.close();

  // F. gevonden gebouw (nog niet opgeslagen) wordt niet verward met een opgeslagen project met hetzelfde adres
  r = await openAndPick(browser, {});
  await r.page.waitForSelector('.wz-voortgang', { timeout: 8000 });
  await click(r.page, '[data-act=wizard-stop]');
  var badges = await r.page.evaluate(function () { return Array.prototype.slice.call(document.querySelectorAll('[data-st-soort]')).map(function (e) { return e.dataset.stSoort + ':' + e.textContent.trim(); }); });
  check('F. Start toont het nieuwe gebouw apart: "Nieuw, nog niet opgeslagen" naast "Opgeslagen project"', badges.length === 2 && badges.some(function (b) { return /^nieuw:Nieuw, nog niet opgeslagen/.test(b); }) && badges.some(function (b) { return /^opgeslagen:Opgeslagen project/.test(b); }), JSON.stringify(badges));
  t = await text(r.page);
  check('F. het nieuwe gebouw biedt het hervatten van de stappen, het opgeslagen project niet', /Ga verder met de begeleide stappen \(stap 1 van 4/i.test(t));
  await r.ctx.close();

  // G. render-terugval: faalt het bijwerken van de DOM, dan wordt het nieuwe scherm toch getoond
  var ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: UA });
  var g = await newPage(ctx, { loggedIn: true, plans: [], state: {} });
  await g.page.addInitScript(function () { window.webkit = { messageHandlers: { mjopNative: { postMessage: function () {} } } }; });
  await g.page.goto(BASE + 'index.html'); await g.page.waitForTimeout(800);
  await g.page.evaluate(function () { var orig = window.MJOPDomPatch.patch; var n = 0; window.MJOPDomPatch.patch = function (a, b) { if (n++ === 0) throw new Error('patch kapot'); return orig(a, b); }; });
  await click(g.page, '[data-act=wizard-start]');
  check('G. patch faalt eenmalig: het nieuwe scherm (adreszoeker) staat er toch', !!(await g.page.$('#addr-search')) && /Stap 1 van 4/i.test(await text(g.page)));
  await ctx.close();

  await browser.close();
  var failed = checks.filter(function (c) { return !c[1]; });
  checks.forEach(function (c) { console.log((c[1] ? 'OK   - ' : 'FAIL - ') + c[0] + (c[1] ? '' : ' [' + c[2] + ']')); });
  console.log(failed.length ? failed.length + ' controle(s) mislukt.' : 'Alle controles geslaagd.');
  process.exit(failed.length ? 1 : 0);
}
main().catch(function (e) { console.error(e); process.exit(2); });
