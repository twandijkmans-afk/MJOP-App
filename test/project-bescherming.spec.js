'use strict';
// Browsertest: bescherming van bestaande (opgeslagen) projecten tegen late antwoorden bij 'Nieuw MJOP maken'.
// Een adres-zoekopdracht of 'plan openen' die nog loopt, mag nooit een intussen geopend opgeslagen project wijzigen, en
// opslaan (handmatig of automatisch) mag nooit een bestaand project overschrijven met een ander gebouw.
// Echte supabase-js met een nagebootst Supabase-netwerk (met actief abonnement, dus automatisch opslaan staat aan).
//   python3 -m http.server 8965 &  ;  MJOP_TEST_BASE=http://localhost:8965/ MJOP_SUPABASE_SDK=/pad/supabase.js node test/project-bescherming.spec.js
let chromium;
try { chromium = require('playwright').chromium; } catch (e) { chromium = require('/opt/node22/lib/node_modules/playwright').chromium; }
var fs = require('fs');
var BASE = process.env.MJOP_TEST_BASE || 'http://localhost:8965/';
var CHROMIUM_PATH = process.env.MJOP_CHROMIUM || '/opt/pw-browsers/chromium';
var SDK_URL = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.116.0/dist/umd/supabase.js';
var SDK_FILE = process.env.MJOP_SUPABASE_SDK || null;
var TEST_HOST = 'testproject0000000000.supabase.co';
var TEST_CONFIG = "window.SUPABASE_CONFIG = { url: 'https://" + TEST_HOST + "', anonKey: 'sb_publishable_TESTKEYabcdefghijklmnop' };";
var CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS' };
var UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MJOPLiveApp/1';
var checks = [];
function check(name, ok, detail) { checks.push([name, !!ok, detail]); }
function b64u(o) { return Buffer.from(JSON.stringify(o)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'); }
function session() {
  var jwt = b64u({ alg: 'HS256' }) + '.' + b64u({ sub: 'u1', role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 }) + '.c2ln';
  return { access_token: jwt, token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'r-abc',
    user: { id: 'u1', aud: 'authenticated', role: 'authenticated', email: 'test@example.org', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' } };
}
var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

// Twee opgeslagen projecten en twee nieuwe adressen (elk met een eigen BAG-pand).
function blob(adres, id) {
  return { building: { adres: adres, bouwjaar: 1980, units: 10, opp: 300, omtrek: 80, dakM2: 300, gevelM2: 700, d3: null, identificatie: id },
    elements: [], fonds: 1000, bijdrage: 60, invul: { fonds: true, bijdrage: true }, offertes: {}, bijvullen: {} };
}
var SAVED = {
  p1: { id: 'p1', label: 'Bestaandstraat 5, 2000BB Utrecht', adres: 'Bestaandstraat 5, 2000BB Utrecht', blob: blob('Bestaandstraat 5, 2000BB Utrecht', '0344100000000001') },
  p2: { id: 'p2', label: 'Anderstraat 9, 3000CC Rotterdam', adres: 'Anderstraat 9, 3000CC Rotterdam', blob: blob('Anderstraat 9, 3000CC Rotterdam', '0599100000000002') },
};
var ADRESSEN = {
  'adr-a': { naam: 'Teststraat 1, 1000AA Amsterdam', lon: 4.9, lat: 52.37, pand: '0363100012345678' },
  'adr-b': { naam: 'Nieuwweg 2, 1000BB Amsterdam', lon: 4.95, lat: 52.38, pand: '0363100087654321' },
};

// o.delay = { 'adr-a': ms, 'adr-b': ms (PDOK-lookup), bag: { 'adr-a': ms }, p1: ms, p2: ms (plan openen) }
async function newPage(browser, o) {
  var ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: UA });
  var page = await ctx.newPage();
  var st = { errors: [], writes: [], warns: [] };
  page.on('pageerror', function (e) { st.errors.push(String(e)); });
  page.on('console', function (m) { if (m.type() === 'warning') st.warns.push(m.text()); });
  var later = function (ms, fn) { if (ms) setTimeout(fn, ms); else fn(); };
  await page.route(/^https?:\/\/(?!localhost)/, function (route) {
    var req = route.request(), url = req.url();
    if (url === SDK_URL) return SDK_FILE ? route.fulfill({ status: 200, contentType: 'application/javascript', body: fs.readFileSync(SDK_FILE), headers: { 'access-control-allow-origin': '*' } }) : route.continue();
    if (url.indexOf('https://' + TEST_HOST + '/') === 0) {
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
      var j = function (status, body) { return route.fulfill({ status: status, contentType: 'application/json', headers: CORS, body: JSON.stringify(body) }); };
      if (/\/auth\/v1\/user/.test(url)) return j(200, session().user);
      if (/\/rest\/v1\/subscriptions/.test(url)) return j(200, { status: 'active', current_period_end: '2099-01-01T00:00:00Z' });
      if (/\/rest\/v1\/saved_plans/.test(url)) {
        var m = req.method();
        if (m === 'POST' || m === 'PATCH') {
          var body = {}; try { body = JSON.parse(req.postData() || '{}'); } catch (e) {}
          var idm = /[?&]id=eq\.([^&]+)/.exec(url);
          var w = { method: m, id: idm ? idm[1] : null, adres: body.adres || (body.state && body.state.building && body.state.building.adres) || null };
          st.writes.push(w);
          return j(m === 'POST' ? 201 : 200, { id: w.id || 'p-nieuw', label: body.label, adres: body.adres, state: body.state, updated_at: new Date().toISOString() });
        }
        var gm = /[?&]id=eq\.([^&]+)/.exec(url);
        if (gm && SAVED[gm[1]]) { var p = SAVED[gm[1]]; return later((o.delay || {})[p.id], function () { j(200, { id: p.id, state: p.blob }); }); }
        return j(200, [SAVED.p1, SAVED.p2].map(function (p) { return { id: p.id, label: p.label, adres: p.adres, updated_at: new Date().toISOString(), invul: { fonds: true, bijdrage: true } }; }));
      }
      if (/\/rest\/v1\//.test(url)) return j(200, null);
      return j(200, {});
    }
    return route.abort();
  });
  await page.route('**/src/config.js', function (route) { route.fulfill({ status: 200, contentType: 'application/javascript', body: TEST_CONFIG }); });
  await page.route('**/locatieserver/search/v3_1/suggest**', function (r) {
    r.fulfill({ contentType: 'application/json', body: JSON.stringify({ response: { docs: Object.keys(ADRESSEN).map(function (k) { return { id: k, weergavenaam: ADRESSEN[k].naam }; }) } }) });
  });
  await page.route('**/locatieserver/search/v3_1/lookup**', function (r) {
    var id = /[?&]id=([^&]+)/.exec(r.request().url())[1], a = ADRESSEN[id];
    later((o.delay || {})[id], function () { r.fulfill({ contentType: 'application/json', body: JSON.stringify({ response: { docs: [{ weergavenaam: a.naam, centroide_ll: 'POINT(' + a.lon + ' ' + a.lat + ')' }] } }) }); });
  });
  await page.route('**/kadaster/bag/ogc/v2/collections/pand/items**', function (r) {
    var bbox = /bbox=([^&]+)/.exec(r.request().url())[1].split(',').map(Number), lon = (bbox[0] + bbox[2]) / 2;
    var key = Object.keys(ADRESSEN).filter(function (k) { return Math.abs(ADRESSEN[k].lon - lon) < 0.01; })[0], a = ADRESSEN[key], d = 0.0001;
    var ring = [[a.lon - d, a.lat - d], [a.lon + d, a.lat - d], [a.lon + d, a.lat + d], [a.lon - d, a.lat + d], [a.lon - d, a.lat - d]];
    later(((o.delay || {}).bag || {})[key], function () {
      r.fulfill({ contentType: 'application/json', body: JSON.stringify({ features: [{ geometry: { type: 'Polygon', coordinates: [ring] }, properties: { identificatie: a.pand, bouwjaar: 1972, gebruiksdoel: 'woonfunctie', aantal_verblijfsobjecten: 12 } }] }) });
    });
  });
  await page.route('**/api.3dbag.nl/**', function (r) { r.fulfill({ status: 404, contentType: 'application/json', body: '{}' }); });
  await page.addInitScript(function (a) {
    if (a.s) { try { localStorage.setItem('sb-testproject0000000000-auth-token', JSON.stringify(a.s)); } catch (e) {} }
    window.webkit = { messageHandlers: { mjopNative: { postMessage: function () {} } } };
  }, { s: o.loggedOut ? null : session() });
  return { ctx: ctx, page: page, st: st };
}
async function open(r) { await r.page.goto(BASE + 'index.html'); await r.page.waitForTimeout(900); }
async function click(page, sel) { await page.evaluate(function (s) { var e = document.querySelector(s); if (e) e.click(); }, sel); await page.waitForTimeout(150); }
async function werk(page) { return page.evaluate(function () { return JSON.parse(sessionStorage.getItem('mjop-worksessie') || 'null'); }); }
async function text(page) { return page.evaluate(function () { return document.body.innerText; }); }
async function startNieuw(page) {   // 'Nieuw MJOP maken' (begeleide stappen) -> adreszoeker met suggesties
  // eerst terug naar Start, zoals een gebruiker dat doet: '‹ Start' op het zoekscherm, anders het tabblad Start
  if (!(await page.$('[data-act=wizard-start]'))) await click(page, '[data-act=wizard-stop]');
  if (!(await page.$('[data-act=wizard-start]'))) await click(page, '[data-act=set-tab][data-tab=start]');
  await click(page, '[data-act=wizard-start]');
  await page.fill('#addr-search', 'Teststraat 1'); await page.dispatchEvent('#addr-search', 'input');
  await page.waitForSelector('.suggest-row', { timeout: 5000 });
}
async function kies(page, id) { await click(page, '.suggest-row[data-id="' + id + '"]'); }
async function openPlan(page, id) { await page.evaluate(function (pid) { var e = document.querySelector('[data-act=open-plan][data-id="' + pid + '"]'); if (e) e.click(); }, id); await page.waitForTimeout(150); }
function adres(w) { return w && w.plan && w.plan.building ? w.plan.building.adres : null; }
// Geen enkele schrijfactie mag een bestaand project bijwerken met een ander gebouw dan dat project.
function geenOverschrijving(st) {
  return st.writes.filter(function (w) { return w.method === 'PATCH' && w.id && SAVED[w.id] && w.adres !== SAVED[w.id].adres; });
}

async function main() {
  var browser = await chromium.launch({ executablePath: CHROMIUM_PATH });
  var r, w, t;

  // 1. Het gemelde probleem: tijdens het zoeken een opgeslagen project openen; het late BAG-antwoord mag dat project niet wijzigen.
  r = await newPage(browser, { delay: { bag: { 'adr-a': 2500 } } });
  await open(r); await startNieuw(r.page); await kies(r.page, 'adr-a');
  check('1. tijdens het zoeken staat "Openen" van het opgeslagen project op het scherm', !!(await r.page.$('[data-act=open-plan][data-id=p1]')));
  await openPlan(r.page, 'p1');
  await sleep(5500);                                                   // laat BAG-antwoord + ruim de 2 s van automatisch opslaan
  w = await werk(r.page);
  check('1. geopend project blijft p1 met zijn eigen adres', w.currentPlanId === 'p1' && adres(w) === SAVED.p1.adres, JSON.stringify([w.currentPlanId, adres(w)]));
  check('1. niet alsnog naar "Is dit je gebouw?" gesprongen', w.tab !== 'wizard' && !/Is dit je gebouw\?/.test(await text(r.page)), w.tab);
  check('1. geen enkele opslag die een bestaand project met een ander gebouw bijwerkt', geenOverschrijving(r.st).length === 0, JSON.stringify(r.st.writes));
  check('1. ook geen nieuw project voor het verlaten adres opgeslagen', !r.st.writes.some(function (x) { return /Teststraat/.test(x.adres || ''); }), JSON.stringify(r.st.writes));
  check('1. geen JavaScript-fouten', r.st.errors.length === 0, r.st.errors.join('; '));
  await r.ctx.close();

  // 2. Zoekscherm verlaten (‹ Start) tijdens het zoeken: het late antwoord doet niets meer.
  r = await newPage(browser, { delay: { bag: { 'adr-a': 2000 } } });
  await open(r); await startNieuw(r.page); await kies(r.page, 'adr-a');
  await click(r.page, '[data-act=wizard-stop]');
  await sleep(3500);
  w = await werk(r.page);
  check('2. na ‹ Start tijdens het zoeken: geen gebouw toegepast, blijft op Start', !adres(w) && w.tab === 'start', JSON.stringify([w.tab, adres(w)]));
  check('2. geen opslag', r.st.writes.length === 0, JSON.stringify(r.st.writes));
  await r.ctx.close();

  // 3. Een nieuwe zoekopdracht maakt de vorige ongeldig: alleen het laatst gekozen adres wint.
  r = await newPage(browser, { delay: { bag: { 'adr-a': 2500 } } });
  await open(r); await startNieuw(r.page); await kies(r.page, 'adr-a');
  await click(r.page, '[data-act=annuleer-zoeken]');
  await r.page.fill('#addr-search', 'Nieuwweg 2'); await r.page.dispatchEvent('#addr-search', 'input');
  await r.page.waitForSelector('.suggest-row', { timeout: 5000 });
  await kies(r.page, 'adr-b');
  await r.page.waitForSelector('.wz-voortgang', { timeout: 8000 });
  await sleep(3000);                                                   // het late antwoord voor adres A komt binnen
  w = await werk(r.page);
  check('3. tweede zoekopdracht wint; het late antwoord van de eerste verandert niets', adres(w) === ADRESSEN['adr-b'].naam && w.currentPlanId !== 'p1' && w.currentPlanId !== 'p2', JSON.stringify([w.currentPlanId, adres(w)]));
  check('3. nieuw gebouw is niet gekoppeld aan een bestaand project; opslaan maakt een NIEUW project', geenOverschrijving(r.st).length === 0
    && r.st.writes.every(function (x) { return x.method === 'POST' || x.id === 'p-nieuw'; }), JSON.stringify(r.st.writes));
  await r.ctx.close();

  // 4. Snel wisselen tussen projecten: alleen het laatst gekozen project wordt geopend.
  r = await newPage(browser, { delay: { p1: 2000 } });
  await r.page.addInitScript(function () { sessionStorage.setItem('mjop-worksessie', JSON.stringify({ screen: 'app', tab: 'mijngebouwen' })); });
  await open(r);
  await openPlan(r.page, 'p1'); await openPlan(r.page, 'p2');
  await sleep(3500);
  w = await werk(r.page);
  check('4. snel wisselen p1 -> p2: p2 blijft open, het late antwoord van p1 vervangt het niet', w.currentPlanId === 'p2' && adres(w) === SAVED.p2.adres, JSON.stringify([w.currentPlanId, adres(w)]));
  check('4. geen overschrijving', geenOverschrijving(r.st).length === 0, JSON.stringify(r.st.writes));
  await r.ctx.close();

  // 5. Combinatie: project openen, nieuw MJOP met vertraagde BAG, tussendoor (vertraagd) een ander project openen,
  //    opnieuw beginnen en een ander adres kiezen. Eindtoestand: alleen het laatste adres, als nieuw project.
  r = await newPage(browser, { delay: { bag: { 'adr-a': 2500 }, p1: 1500 } });
  await r.page.addInitScript(function () { sessionStorage.setItem('mjop-worksessie', JSON.stringify({ screen: 'app', tab: 'mijngebouwen' })); });
  await open(r);
  await openPlan(r.page, 'p2'); await sleep(600);
  await startNieuw(r.page); await kies(r.page, 'adr-a');               // BAG voor A is traag
  await openPlan(r.page, 'p1');                                         // p1 openen is ook traag
  await startNieuw(r.page);                                             // opnieuw beginnen terwijl beide nog lopen
  await kies(r.page, 'adr-b');
  await r.page.waitForSelector('.wz-voortgang', { timeout: 8000 });
  await sleep(5000);                                                    // late antwoorden van A en p1 + automatisch opslaan
  w = await werk(r.page);
  t = await text(r.page);
  check('5. eindtoestand: alleen het laatst gekozen adres (B), in de begeleide stappen', adres(w) === ADRESSEN['adr-b'].naam && /Is dit je gebouw\?/.test(t), JSON.stringify([w.currentPlanId, adres(w), w.tab]));
  check('5. niet gekoppeld aan p1 of p2', w.currentPlanId !== 'p1' && w.currentPlanId !== 'p2', w.currentPlanId);
  check('5. p1 en p2 nooit bijgewerkt', !r.st.writes.some(function (x) { return x.method === 'PATCH' && (x.id === 'p1' || x.id === 'p2'); }), JSON.stringify(r.st.writes));
  check('5. geen JavaScript-fouten', r.st.errors.length === 0, r.st.errors.join('; '));
  await r.ctx.close();

  // 6. Laatste vangnet bij opslaan: staat er (bijv. door een oude werksessie) een ander gebouw in het geheugen dan het
  //    gekoppelde project, dan maakt (automatisch) opslaan een NIEUW project en blijft het bestaande ongewijzigd.
  r = await newPage(browser, {});
  await r.page.addInitScript(function (p1) {
    var mismatch = JSON.parse(JSON.stringify(p1.blob)); mismatch.building.adres = 'Teststraat 1, 1000AA Amsterdam'; mismatch.building.identificatie = '0363100012345678';
    sessionStorage.setItem('mjop-worksessie', JSON.stringify({ screen: 'app', tab: 'home', currentPlanId: 'p1', lastSavedSnapshot: JSON.stringify(p1.blob), plan: mismatch }));
  }, SAVED.p1);
  await open(r);
  await sleep(3500);                                                   // automatisch opslaan na 2 s
  check('6. bestaand project p1 wordt niet bijgewerkt met een ander gebouw', !r.st.writes.some(function (x) { return x.method === 'PATCH' && x.id === 'p1'; }), JSON.stringify(r.st.writes));
  check('6. het werk gaat niet verloren: opgeslagen als nieuw project', r.st.writes.some(function (x) { return x.method === 'POST' && /Teststraat/.test(x.adres || ''); }), JSON.stringify(r.st.writes));
  await r.ctx.close();

  // 7. Gewone bewerking van een geopend project blijft dat project bijwerken (het vangnet blokkeert geen normaal werk).
  r = await newPage(browser, {});
  await r.page.addInitScript(function (p1) {
    var bewerkt = JSON.parse(JSON.stringify(p1.blob)); bewerkt.fonds = 2500;
    sessionStorage.setItem('mjop-worksessie', JSON.stringify({ screen: 'app', tab: 'home', currentPlanId: 'p1', lastSavedSnapshot: JSON.stringify(p1.blob), plan: bewerkt }));
  }, SAVED.p1);
  await open(r);
  await sleep(3500);
  check('7. bewerking van hetzelfde gebouw werkt het eigen project bij (PATCH p1)', r.st.writes.some(function (x) { return x.method === 'PATCH' && x.id === 'p1' && x.adres === SAVED.p1.adres; })
    && !r.st.writes.some(function (x) { return x.method === 'POST'; }), JSON.stringify(r.st.writes));
  await r.ctx.close();

  // 8. Niet ingelogd op een iPhone: het zoekscherm wordt getoond terwijl het interne scherm nog 'marketing' heet.
  //    De beveiliging mag de gewone zoekopdracht dan niet tegenhouden: het laadscherm verdwijnt en het gebouw verschijnt.
  r = await newPage(browser, { loggedOut: true, delay: { bag: { 'adr-a': 1200 } } });
  await open(r);
  await r.page.waitForSelector('#addr-search', { timeout: 5000 });
  await r.page.fill('#addr-search', 'Teststraat 1'); await r.page.dispatchEvent('#addr-search', 'input');
  await r.page.waitForSelector('.suggest-row', { timeout: 5000 });
  await kies(r.page, 'adr-a');
  await sleep(3000);
  w = await werk(r.page); t = await text(r.page);
  check('8. niet ingelogd (iPhone): na het kiezen van een adres verdwijnt het laadscherm en staat het gebouw er', adres(w) === ADRESSEN['adr-a'].naam
    && !/Pand opzoeken|Bouwjaar en appartementen|Dakoppervlak, gevels en hoogte/.test(t), JSON.stringify([w.screen, adres(w)]) + ' ' + t.slice(0, 120));
  check('8. geen opslag zonder account', r.st.writes.length === 0, JSON.stringify(r.st.writes));
  check('8. geen JavaScript-fouten', r.st.errors.length === 0, r.st.errors.join('; '));
  await r.ctx.close();

  await browser.close();
  var failed = checks.filter(function (c) { return !c[1]; });
  checks.forEach(function (c) { console.log((c[1] ? 'OK   - ' : 'FAIL - ') + c[0] + (c[1] ? '' : ' [' + c[2] + ']')); });
  console.log(failed.length ? failed.length + ' controle(s) mislukt.' : 'Alle controles geslaagd.');
  process.exit(failed.length ? 1 : 0);
}
main().catch(function (e) { console.error(e); process.exit(2); });
