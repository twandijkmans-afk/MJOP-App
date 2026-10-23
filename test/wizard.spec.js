'use strict';
// Browsertest: begeleide stappen (wizard) 'Nieuw MJOP maken': gebouw kiezen -> controleren -> inspecteren -> onderhoudsplan.
// Echte supabase-js met een nagebootst Supabase-netwerk; ingelogd via een vooraf gezette sessie in de opslag.
//   python3 -m http.server 8963 &  ;  MJOP_TEST_BASE=http://localhost:8963/ MJOP_SUPABASE_SDK=/pad/supabase.js node test/wizard.spec.js
let chromium;
try { chromium = require('playwright').chromium; } catch (e) { chromium = require('/opt/node22/lib/node_modules/playwright').chromium; }
var fs = require('fs');
var BASE = process.env.MJOP_TEST_BASE || 'http://localhost:8963/';
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
  await page.route('**/locatieserver/search/v3_1/lookup**', function (r) { r.fulfill({ contentType: 'application/json', body: JSON.stringify({ response: { docs: [{ weergavenaam: 'Teststraat 1, 1000AA Amsterdam', centroide_ll: 'POINT(' + lon + ' ' + lat + ')' }] } }) }); });
  await page.route('**/kadaster/bag/ogc/v2/collections/pand/items**', function (r) {
    var ring = [[lon - d, lat - d], [lon + d, lat - d], [lon + d, lat + d], [lon - d, lat + d], [lon - d, lat - d]];
    r.fulfill({ contentType: 'application/json', body: JSON.stringify({ features: [{ geometry: { type: 'Polygon', coordinates: [ring] }, properties: { identificatie: '0363100012345678', bouwjaar: 1972, gebruiksdoel: 'woonfunctie', aantal_verblijfsobjecten: 12 } }] }) });
  });
  await page.route('**/api.3dbag.nl/**', function (r) {
    r.fulfill({ contentType: 'application/json', body: JSON.stringify({ feature: { CityObjects: { 'NL.IMBAG.Pand.0363100012345678': { attributes: { b3_opp_dak_plat: 312.64, b3_opp_dak_schuin: 0, b3_opp_buitenmuur: 1099.7, b3_opp_grond: 318.2, b3_bouwlagen: 4, b3_dak_type: 'horizontal', b3_h_dak_max: 13.4, b3_h_maaiveld: 0.6 } } } } }) });
  });
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
  var TECH = /PROPOSED|PHOTO_WALK_SCAN|LiDAR|schema|bridge|keyframe/i;
  var ctx = await browser.newContext(small);
  var a = await newPage(ctx, { loggedIn: true, plans: [] });
  var page = a.page;
  await page.goto(BASE + 'index.html'); await page.waitForTimeout(900);

  // 1. start -> adres kiezen
  await click(page, '[data-act=wizard-start]');
  var t = await text(page);
  check('1. wizard start op het adresscherm met "Stap 1 van 4"', /Stap 1 van 4/i.test(t) && /Gebouw kiezen/i.test(t), t.slice(0, 120));
  await page.fill('#addr-search', 'Teststraat 1');
  await page.dispatchEvent('#addr-search', 'input');
  await page.waitForSelector('.suggest-row', { timeout: 5000 });
  await page.evaluate(function () { document.querySelector('.suggest-row').click(); });
  await page.waitForSelector('.wz-voortgang', { timeout: 8000 });
  t = await text(page);
  check('1. gebouw gevonden: "Is dit je gebouw?" met adres en bron-labels', /Is dit je gebouw\?/.test(t) && /Teststraat 1/.test(t) && /Uit de BAG/i.test(t) && /Geschat/i.test(t), t.slice(0, 300));
  check('1. voortgang: stap 1 van 4', /Stap 1 van 4/i.test(t));
  await shot(page, 'wizard-1-gebouw');

  // 2. gebouw controleren
  await click(page, '[data-act=wizard-volgende]');
  t = await text(page);
  check('2. stap 2: vragen in gewone taal', /Controleer je gebouw/.test(t) && /Heeft het gebouw een lift\?/.test(t) && /Weet ik niet/.test(t));
  var n0 = await page.evaluate(function () { return document.querySelectorAll('.wz-details li').length; });
  await click(page, '[data-act=wizard-vraag][data-key=lift][data-antwoord=ja]');
  var n1 = await page.evaluate(function () { return document.querySelectorAll('.wz-details li').length; });
  check('2. "Ja" voegt de post toe (één keer)', n1 === n0 + 1, n0 + '->' + n1);
  await click(page, '[data-act=wizard-vraag][data-key=lift][data-antwoord=ja]');
  var n2 = await page.evaluate(function () { return document.querySelectorAll('.wz-details li').length; });
  check('2. nogmaals "Ja" maakt geen dubbele post', n2 === n1, n1 + '->' + n2);
  await click(page, '[data-act=wizard-vraag][data-key=lift][data-antwoord=nee]');
  var n3 = await page.evaluate(function () { return document.querySelectorAll('.wz-details li').length; });
  check('2. "Nee" haalt een post die de stappen zelf toevoegden weer weg', n3 === n0, n0 + '->' + n3);
  await click(page, '[data-act=wizard-vraag][data-key=lift][data-antwoord=onbekend]');
  t = await text(page);
  check('2. "Weet ik niet": onbekend, niet meegerekend', /Nog onbekend: we nemen deze post niet mee/.test(t));
  await click(page, '[data-act=wizard-vraag][data-key=lift][data-antwoord=ja]');
  await click(page, '[data-act=wizard-vraag][data-key=ventilatie][data-antwoord=onbekend]');
  await shot(page, 'wizard-2-controleren');
  var geo = await page.evaluate(function () { return { overflow: document.documentElement.scrollWidth > window.innerWidth, minOpt: Math.min.apply(null, Array.prototype.slice.call(document.querySelectorAll('.wz-opt')).map(function (b) { return b.getBoundingClientRect().height; })) }; });
  check('2. 375px: geen horizontaal scrollen; keuzeknoppen ≥44px', !geo.overflow && geo.minOpt >= 44, JSON.stringify(geo));

  // 3. terug, stoppen en hervatten
  await click(page, '[data-act=wizard-vorige]');
  check('3. terug naar stap 1 zonder gegevensverlies', /Is dit je gebouw\?/.test(await text(page)) && /Teststraat 1/.test(await text(page)));
  await click(page, '[data-act=wizard-volgende]');
  var pressed = await page.evaluate(function () { return Array.prototype.slice.call(document.querySelectorAll('.wz-opt[aria-pressed=true]')).map(function (b) { return b.dataset.key + ':' + b.dataset.antwoord; }); });
  check('3. antwoorden blijven staan na terug/vooruit', pressed.indexOf('lift:ja') > -1 && pressed.indexOf('ventilatie:onbekend') > -1, pressed.join(','));
  await click(page, '[data-act=wizard-stop]');
  t = await text(page);
  check('3. "Opslaan en later verdergaan" -> Start met hervatten-tekst', /Wat wil je doen\?/.test(t) && /Ga verder met de begeleide stappen \(stap 2 van 4/i.test(t), t.slice(0, 250));
  await click(page, '[data-act=set-tab][data-tab=wizard]').catch(function () {});
  await click(page, '.st-proj-knop');
  t = await text(page);
  check('3. "Verder" hervat op dezelfde stap met dezelfde antwoorden', /Controleer je gebouw/.test(t));

  // 4. herladen: stand blijft
  await page.reload(); await page.waitForTimeout(900);
  check('4. na herladen: nog op stap 2', /Controleer je gebouw/.test(await text(page)));

  // 5. inspecteren (browser: geen app)
  await click(page, '[data-act=wizard-volgende]');
  t = await text(page);
  check('5. stap 3: uitleg wat te fotograferen, optioneel, overslaan mogelijk', /Gebouw inspecteren/.test(t) && /Zorg dat het hele kozijn in beeld staat\./.test(t) && /Overslaan en verder/.test(t), t.slice(0, 300));
  check('5. buiten de app: eerlijke melding dat Fotoronde in de iPhone-app werkt', /Fotoronde werkt in de MJOP Live-app/.test(t));
  await shot(page, 'wizard-3-inspecteren');
  await click(page, '[data-act=wizard-volgende-overslaan]');

  // 6. onderhoudsplan
  t = await text(page);
  check('6. stap 4: onderhoudsplan met kosten en checklist', /Je onderhoudsplan/.test(t) && /€/.test(t) && /Saldo van de reservekas nog niet ingevuld/.test(t) && /Nog onbekend: mechanisch ventilatiesysteem|Nog onbekend: mechanische ventilatie/i.test(t), t.slice(0, 500));
  check('6. ontbrekende hoeveelheid/saldo wordt niet als 0 getoond', !/Saldo van de reservekas ingevuld/.test(t));
  check('6. duidelijke volgende actie', /Naar het overzicht/.test(t));
  await shot(page, 'wizard-4-plan');
  var alles = '';
  await click(page, '[data-act=wizard-vorige]'); alles += await text(page);
  check('6. geen technische termen in de stappen', !TECH.test(t + alles));
  await click(page, '[data-act=wizard-volgende-overslaan]');
  await click(page, '[data-act=wizard-naar-overzicht]');
  var act = await page.evaluate(function () { return document.querySelector('.tab-item.active').textContent.trim(); });
  check('6. "Naar het overzicht" opent het Overzicht (bestaande berekeningen)', act === 'Overzicht', act);
  check('6. geen JavaScript-fouten', a.st.errors.length === 0, a.st.errors.join('; '));
  await ctx.close();

  // 7. hervatten vanuit opgeslagen plan
  var seed = await newPage(await browser.newContext(small));
  await seed.page.goto(BASE + 'index.html'); await seed.page.waitForTimeout(300);
  await click(seed.page, '[data-act=skip-onboarding]'); await seed.page.waitForTimeout(300);
  var blob = await seed.page.evaluate(function () { return JSON.parse(sessionStorage.getItem('mjop-worksessie')).plan; });
  await seed.page.context().close();
  blob.wizard = { stap: 3, vragen: {}, toegevoegd: [], fotoronde: null, klaar: false };
  var ctx2 = await browser.newContext(small);
  var b = await newPage(ctx2, { loggedIn: true, blob: blob, plans: [{ id: 'p1', label: 'Kastanjelaan 12', adres: 'Kastanjelaan 12', updated_at: new Date().toISOString(), invul: { fonds: false, bijdrage: false }, wizard: blob.wizard }] });
  await b.page.goto(BASE + 'index.html'); await b.page.waitForTimeout(900);
  t = await text(b.page);
  check('7. Start toont "stap 3 van 4" voor een onafgemaakt plan', /stap 3 van 4: inspecteren/i.test(t), t.slice(0, 300));
  await click(b.page, '[data-act=open-plan][data-id=p1][data-na=wizard]'); await b.page.waitForTimeout(500);
  check('7. "Verder" opent direct stap 3', /Gebouw inspecteren/.test(await text(b.page)) && /Stap 3 van 4/i.test(await text(b.page)));
  // een afgerond plan zonder wizard blijft gewoon naar het Overzicht gaan
  await ctx2.close();

  await browser.close();
  var failed = checks.filter(function (c) { return !c[1]; });
  checks.forEach(function (c) { console.log((c[1] ? 'OK   - ' : 'FAIL - ') + c[0] + (c[1] ? '' : ' [' + c[2] + ']')); });
  console.log(failed.length ? failed.length + ' controle(s) mislukt.' : 'Alle controles geslaagd.');
  process.exit(failed.length ? 1 : 0);
}
main().catch(function (e) { console.error(e); process.exit(2); });
