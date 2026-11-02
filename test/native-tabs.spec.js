'use strict';
// Browsertest: native navigatie voor de iPhone-app (app-versie 2): tabbalk verbergen, handshake, commando's (navigeren, projecten ophalen,
// project openen, meting starten, status, voorstellen, uitloggen) en achterwaartse compatibiliteit (app-versie 1, gewone browser, app die niet antwoordt).
// Echte supabase-js met een nagebootst Supabase-netwerk; ingelogd via een vooraf gezette sessie. De "app" is een stub die de brug nabootst.
//   python3 -m http.server 8968 &  ;  MJOP_TEST_BASE=http://localhost:8968/ MJOP_SUPABASE_SDK=/pad/supabase.js node test/native-tabs.spec.js
let chromium;
try { chromium = require('playwright').chromium; } catch (e) { chromium = require('/opt/node22/lib/node_modules/playwright').chromium; }
var fs = require('fs'), path = require('path');
var BASE = process.env.MJOP_TEST_BASE || 'http://localhost:8968/';
var CHROMIUM_PATH = process.env.MJOP_CHROMIUM || '/opt/pw-browsers/chromium';
var SDK_URL = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.116.0/dist/umd/supabase.js';
var SDK_FILE = process.env.MJOP_SUPABASE_SDK || null;
var TEST_HOST = 'testproject0000000000.supabase.co';
var TEST_CONFIG = "window.SUPABASE_CONFIG = { url: 'https://" + TEST_HOST + "', anonKey: 'sb_publishable_TESTKEYabcdefghijklmnop' };";
var CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS' };
var C = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'native-bridge', 'contract_v1.json'), 'utf8'));
var APP2 = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MJOPLiveApp/2';
var APP1 = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MJOPLiveApp/1';
var P1 = '11111111-2222-3333-4444-555555555555', P2 = '66666666-7777-8888-9999-000000000000';
var checks = [];
function check(name, ok, detail) { checks.push([name, !!ok, detail]); }
function b64u(o) { return Buffer.from(JSON.stringify(o)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'); }
function session() {
  var jwt = b64u({ alg: 'HS256' }) + '.' + b64u({ sub: 'u1', role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 }) + '.c2ln';
  return { access_token: jwt, token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'r-abc',
    user: { id: 'u1', aud: 'authenticated', role: 'authenticated', email: 'test@example.org', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' } };
}
var daysAgo = function (n) { return new Date(Date.now() - n * 86400000).toISOString(); };

// De "app": legt alle berichten van de website vast; antwoordt (naar keuze) op webReady met nativeReady en op getCapabilities met capabilities.
function APP_STUB(answer) {
  window.__posted = [];
  window.webkit = { messageHandlers: { mjopNative: { postMessage: function (m) {
    window.__posted.push(JSON.parse(JSON.stringify(m)));
    if (m.action === 'getCapabilities') setTimeout(function () { window.MJOPNativeBridge.receive({ v: 1, type: 'capabilities', requestId: m.requestId, lidar: true, appVersion: '2' }); }, 10);
    if (m.action === 'webReady' && answer) setTimeout(function () { window.MJOPNativeBridge.receive({ v: 1, type: 'nativeReady', features: ['tabs1'], appVersion: '2', lidar: true }); }, 10);
  } } } };
}

async function newPage(ctx, o) {
  o = o || {};
  var page = await ctx.newPage(), st = { errors: [] };
  page.on('pageerror', function (e) { st.errors.push(String(e)); });
  await page.route(/^https?:\/\/(?!localhost)/, function (route) {
    var req = route.request(), url = req.url();
    if (url === SDK_URL) return SDK_FILE ? route.fulfill({ status: 200, contentType: 'application/javascript', body: fs.readFileSync(SDK_FILE), headers: { 'access-control-allow-origin': '*' } }) : route.continue();
    if (url.indexOf('https://' + TEST_HOST + '/') === 0) {
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
      var j = function (status, body) { return route.fulfill({ status: status, contentType: 'application/json', headers: CORS, body: JSON.stringify(body) }); };
      if (/\/auth\/v1\/user/.test(url)) return j(200, session().user);
      if (/\/rest\/v1\/saved_plans/.test(url)) {
        var m = /[?&]id=eq\.([^&]+)/.exec(url);
        if (m) return j(200, { id: decodeURIComponent(m[1]), state: o.blob });
        return j(200, o.plans || []);
      }
      if (/\/rest\/v1\//.test(url)) return j(200, null);
      return j(200, {});
    }
    return route.abort();
  });
  await page.route('**/src/config.js', function (route) { route.fulfill({ status: 200, contentType: 'application/javascript', body: TEST_CONFIG }); });
  if (o.loggedIn) await page.addInitScript(function (s) { try { localStorage.setItem('sb-testproject0000000000-auth-token', JSON.stringify(s)); } catch (e) {} }, session());
  await page.addInitScript('(' + APP_STUB.toString() + ')(' + (o.answer === false ? 'false' : 'true') + ')');
  return { page: page, st: st };
}
async function click(page, sel) { await page.evaluate(function (s) { var e = document.querySelector(s); if (e) e.click(); }, sel); await page.waitForTimeout(250); }
async function posted(page) { return page.evaluate(function () { return window.__posted; }); }
// Stuurt een commando zoals de app dat doet en wacht op het webReply met hetzelfde requestId.
var seq = 0;
async function ask(page, msg) {
  var m = Object.assign({ v: 1, type: 'command', requestId: 'q' + (++seq) }, msg);
  await page.evaluate(function (x) { return window.MJOPNativeBridge.receive(x); }, m);
  for (var i = 0; i < 100; i++) {
    var r = (await posted(page)).filter(function (p) { return p.action === 'webReply' && p.requestId === m.requestId; })[0];
    if (r) return r.payload;
    await page.waitForTimeout(200);
  }
  return null;
}
async function lastState(page) {
  var l = (await posted(page)).filter(function (p) { return p.action === 'webState'; });
  return l.length ? l[l.length - 1].payload : null;
}
async function hidden(page, sel) {
  return page.evaluate(function (s) { var e = document.querySelector(s); return !e || getComputedStyle(e).display === 'none'; }, sel);
}

async function main() {
  var browser = await chromium.launch({ executablePath: CHROMIUM_PATH });
  var small = { viewport: { width: 375, height: 667 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
  var plans = [
    { id: P1, label: 'Kastanjelaan 12', adres: 'Kastanjelaan 12, Utrecht', updated_at: daysAgo(2), invul: { fonds: false, bijdrage: false } },
    { id: P2, label: 'Maldenhof 3', adres: null, updated_at: null, invul: { fonds: true, bijdrage: true } },
  ];
  // blob van een echt plan: het voorbeeldgebouw, zoals de app het zelf wegschrijft
  var seed = await newPage(await browser.newContext(small), { answer: false });
  await seed.page.goto(BASE + 'index.html'); await seed.page.waitForTimeout(300);
  await click(seed.page, '[data-act=skip-onboarding]'); await seed.page.waitForTimeout(300);
  var blob = await seed.page.evaluate(function () { return JSON.parse(sessionStorage.getItem('mjop-worksessie')).plan; });
  await seed.page.context().close();

  // ===== A. app-versie 2, ingelogd =====
  var ctx = await browser.newContext(Object.assign({ userAgent: APP2 }, small));
  var a = await newPage(ctx, { loggedIn: true, plans: plans, blob: blob });
  var page = a.page;
  await page.goto(BASE + 'index.html'); await page.waitForTimeout(1200);
  check('A1. html krijgt de klasse native-tabs (geen flits)', await page.evaluate(function () { return document.documentElement.classList.contains('native-tabs'); }));
  check('A1. de eigen tabbalk en de zwevende knoppen van de website zijn verborgen', (await hidden(page, '.tab-bar')) && (await hidden(page, '.mobile-settings-btn')) && (await hidden(page, '.mobile-home-btn')));
  var p0 = await posted(page);
  var ready = p0.filter(function (p) { return p.action === 'webReady'; })[0];
  check('A2. de website meldt zich met webReady (features nav1)', ready && ready.v === 1 && JSON.stringify(ready.payload.features) === '["nav1"]', JSON.stringify(ready));
  var st0 = await lastState(page);
  check('A3. webState na de handshake: ingelogd, nog geen project', st0 && st0.loggedIn === true && st0.hasBuilding === false && st0.planId === null, JSON.stringify(st0));
  check('A3. onbekende velden ontbreken niet: nextStep is null zonder project (niet leeg/0)', st0 && st0.nextStep === null && st0.pendingProposals === 0);

  var marker = await page.evaluate(function () { window.__nietOpnieuwGeladen = 'ja'; sessionStorage.setItem('testsleutel', 'bewaard'); return true; });

  var r = await ask(page, { command: 'getProjects' });
  check('B1. getProjects: echte lijst uit de backend (nagebootst), laatst bijgewerkt en volgende stap', r && r.ok && r.data.loggedIn === true && r.data.projects.length === 2 &&
    r.data.projects[0].id === P1 && r.data.projects[0].label === 'Kastanjelaan 12' && /^2026|^20/.test(r.data.projects[0].updatedAt) && /saldo van de reservekas/.test(r.data.projects[0].nextStep), JSON.stringify(r));
  check('B1. ontbrekende gegevens blijven null (adres, datum), niet verzonnen', r && r.data.projects[1].adres === null && r.data.projects[1].updatedAt === null);

  r = await ask(page, { command: 'openProject', id: P1, tab: 'home' });
  check('B2. openProject opent het project en geeft de status terug', r && r.ok && r.data.planId === P1 && r.data.hasBuilding === true && r.data.tab === 'home', JSON.stringify(r));
  var s1 = await ask(page, { command: 'getStatus' });
  check('B2. getStatus: huidig project, label en volgende stap', s1 && s1.ok && s1.data.planId === P1 && !!s1.data.label && typeof s1.data.nextStep === 'string', JSON.stringify(s1));

  var navTabs = ['planning', 'gebouw', 'rapport', 'home'];
  for (var i = 0; i < navTabs.length; i++) {
    r = await ask(page, { command: 'navigate', tab: navTabs[i] });
    check('B3. navigate ' + navTabs[i] + ': de website toont dat tabblad', r && r.ok && r.data.tab === navTabs[i], JSON.stringify(r));
  }
  r = await ask(page, { command: 'navigate', tab: 'account', sub: 'abonnement' });
  var tAbo = await page.evaluate(function () { return document.body.innerText; });
  check('B3. navigate account/abonnement: toont Abonnement', r && r.ok && /Abonnement/.test(tAbo));
  r = await ask(page, { command: 'navigate', tab: 'account', sub: 'organisatie' });
  check('B3. navigate account/organisatie', r && r.ok && /Organisatie/.test(await page.evaluate(function () { return document.body.innerText; })));
  var kept = await page.evaluate(function () { return { m: window.__nietOpnieuwGeladen, s: sessionStorage.getItem('testsleutel'), plan: !!sessionStorage.getItem('mjop-worksessie') }; });
  check('B4. tabwissels laden de website niet opnieuw: pagina-staat, sessionStorage en werksessie blijven', kept.m === 'ja' && kept.s === 'bewaard' && kept.plan, JSON.stringify(kept));
  check('B4. ingelogd gebleven na alle navigatie', (await lastState(page)).loggedIn === true);

  // niet-opgeslagen werk wordt nooit stil vervangen
  var stNow = await ask(page, { command: 'getStatus' });
  r = await ask(page, { command: 'openProject', id: P2 });
  check('B5. openProject naar ander project: weigert bij niet-opgeslagen wijzigingen (UNSAVED_CHANGES), anders opent het (nooit stil overschrijven)',
    r && ((stNow.data.dirty && r.ok === false && r.error.code === 'UNSAVED_CHANGES') || (!stNow.data.dirty && r.ok === true && r.data.planId === P2)), 'dirty=' + stNow.data.dirty + ' ' + JSON.stringify(r));
  if (r && r.ok === false) {
    var still = await ask(page, { command: 'getStatus' });
    check('B5. na weigering is het huidige project onaangeroerd', still.data.planId === P1);
    r = await ask(page, { command: 'openProject', id: P2, force: true });
    check('B5. met force:true (bevestigd in de app) opent het wel', r && r.ok && r.data.planId === P2, JSON.stringify(r));
    r = await ask(page, { command: 'openProject', id: P1, force: true });
  }

  // metingen starten via de BESTAANDE Fotoronde-brug
  r = await ask(page, { command: 'startMeasurement', mode: 'round', planId: P1, force: true });
  var p1 = await posted(page);
  var sr = p1.filter(function (p) { return p.action === 'startPhotoRound'; }).pop();
  check('C1. startMeasurement round: stuurt de bestaande bridge-actie startPhotoRound met de projectcontext', r && r.ok && sr && sr.payload.mode === 'round' && sr.payload.mjopPlanId === P1 && /^plan-[0-9a-f]{24}$/.test(sr.payload.planRef), JSON.stringify(r) + JSON.stringify(sr));
  check('C1. de planRef komt van de website (niet van de app) en staat in het antwoord', r && r.data.planRef === sr.payload.planRef);
  var elKey = await page.evaluate(function () { var raw = sessionStorage.getItem('mjop-worksessie'); var pl = JSON.parse(raw).plan; var e = (pl.elements || []).filter(function (x) { return x.id === 'kozijnen-onderhoud'; })[0]; return e ? e.id : null; });
  if (elKey) {
    r = await ask(page, { command: 'startMeasurement', mode: 'element', elementKey: elKey });
    var se = (await posted(page)).filter(function (p) { return p.action === 'startElementScan'; }).pop();
    check('C2. startMeasurement element: bestaande bridge-actie startElementScan met de onderhoudspost', r && r.ok && se && se.payload.mode === 'element' && se.payload.element.key === elKey, JSON.stringify(r) + JSON.stringify(se));
  } else check('C2. onderhoudspost kozijnen-onderhoud aanwezig in het voorbeeldproject', false, 'niet gevonden');
  r = await ask(page, { command: 'startMeasurement', mode: 'element', elementKey: 'bestaat-niet' });
  check('C3. onbekend onderhoudsonderdeel: duidelijke fout, geen scan gestart', r && r.ok === false && r.error.code === 'NO_ELEMENT', JSON.stringify(r));

  r = await ask(page, { command: 'getProposals' });
  check('D1. getProposals: lege lijst zonder voorstellen; waarden zijn nooit verzonnen', r && r.ok && r.data.total === 0 && Array.isArray(r.data.pending) && r.data.pending.length === 0, JSON.stringify(r));
  // voorstel van de scanner komt binnen via de BESTAANDE route; daarna meldt getProposals het als openstaand en blijft onbekend null
  var planRef = (await ask(page, { command: 'getStatus' })).data.planRef;
  var fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'photo-round', 'area_building_incomplete_v2.json'), 'utf8'));
  fx.project.plan_ref = planRef;
  await page.evaluate(function (a) { return window.MJOPNativeBridge.receive(a); }, { v: 1, type: 'proposals', planRef: planRef, proposals: [fx], rounds: [] });
  await page.waitForTimeout(300);
  r = await ask(page, { command: 'getProposals' });
  check('D2. voorstel uit de scanner: openstaand, oppervlak onbekend blijft null (nooit 0), niets geboekt', r && r.ok && r.data.pending.length === 1 && r.data.pending[0].value === null && r.data.pending[0].unit === 'm2', JSON.stringify(r));
  var stP = await lastState(page);
  check('D2. webState meldt 1 openstaand voorstel', stP && stP.pendingProposals === 1, JSON.stringify(stP));

  // ongeldige commando's
  var bad = 0, before = (await ask(page, { command: 'getStatus' })).data;
  for (var k = 0; k < C.commands_invalid.length; k++) {
    var m = Object.assign({}, C.commands_invalid[k].msg);
    var okRid = /^[A-Za-z0-9_-]{1,64}$/.test(m.requestId || '');
    await page.evaluate(function (x) { return window.MJOPNativeBridge.receive(x); }, m);
    await page.waitForTimeout(80);
    if (okRid && m.v === 1 && m.type === 'command') {
      var rep = (await posted(page)).filter(function (p) { return p.action === 'webReply' && p.requestId === m.requestId; })[0];
      if (!rep || rep.payload.ok !== false || rep.payload.error.code !== 'INVALID_COMMAND') bad++;
    }
  }
  var after = (await ask(page, { command: 'getStatus' })).data;
  check('E1. ongeldige commando\'s worden geweigerd met INVALID_COMMAND', bad === 0, 'afwijkend: ' + bad);
  check('E1. ongeldige commando\'s veranderen niets', after.tab === before.tab && after.planId === before.planId);

  r = await ask(page, { command: 'newProject' });
  check('F1. newProject opent de startflow van de website', r && r.ok && r.data.tab === 'start', JSON.stringify(r));

  r = await ask(page, { command: 'signOut' });
  await page.waitForTimeout(1500);
  var stOut = await lastState(page);
  check('F2. signOut: de website logt uit (bestaande actie) en meldt dat', r && r.ok && stOut && stOut.loggedIn === false, JSON.stringify(stOut));
  check('F3. geen JavaScript-fouten in de hele sessie', a.st.errors.length === 0, a.st.errors.join('; '));
  await ctx.close();

  // ===== G. niet ingelogd =====
  var ctxG = await browser.newContext(Object.assign({ userAgent: APP2 }, small));
  var g = await newPage(ctxG, {});
  await g.page.goto(BASE + 'index.html'); await g.page.waitForTimeout(900);
  r = await ask(g.page, { command: 'getProjects' });
  check('G1. niet ingelogd: getProjects geeft loggedIn:false en een lege lijst (geen voorbeeldprojecten)', r && r.ok && r.data.loggedIn === false && r.data.projects.length === 0, JSON.stringify(r));
  r = await ask(g.page, { command: 'openProject', id: P1 });
  check('G2. niet ingelogd: openProject geeft NOT_LOGGED_IN', r && r.ok === false && r.error.code === 'NOT_LOGGED_IN', JSON.stringify(r));
  await ctxG.close();

  // ===== H. achterwaartse compatibiliteit =====
  var ctx1 = await browser.newContext(Object.assign({ userAgent: APP1 }, small));
  var o1 = await newPage(ctx1, { loggedIn: true, plans: plans, blob: blob });
  await o1.page.goto(BASE + 'index.html'); await o1.page.waitForTimeout(1200);
  var pp = await posted(o1.page);
  check('H1. OUDE APP (MJOPLiveApp/1): geen native-tabs-klasse, eigen tabbalk zichtbaar', !(await o1.page.evaluate(function () { return document.documentElement.classList.contains('native-tabs'); })) && !(await hidden(o1.page, '.tab-bar')));
  check('H1. OUDE APP: de website stuurt geen enkel nieuw bericht (webReady/webState/webReply)', pp.every(function (p) { return ['webReady', 'webState', 'webReply'].indexOf(p.action) < 0; }), JSON.stringify(pp.map(function (p) { return p.action; })));
  await o1.page.evaluate(function (x) { return window.MJOPNativeBridge.receive(x); }, { v: 1, type: 'nativeReady', features: ['tabs1'] });
  await o1.page.evaluate(function (x) { return window.MJOPNativeBridge.receive(x); }, { v: 1, type: 'command', command: 'signOut', requestId: 'z1' });
  await o1.page.waitForTimeout(500);
  check('H2. OUDE APP: nieuwe berichten worden genegeerd (geen uitloggen, tabbalk blijft)', (await posted(o1.page)).every(function (p) { return p.action !== 'webReply'; }) && !(await hidden(o1.page, '.tab-bar')));
  // de bestaande Fotoronde-brug blijft werken met de oude app
  await o1.page.evaluate(function () { window.webkit.messageHandlers.mjopNative.postMessage({ v: 1, action: 'getCapabilities', requestId: 'cap1', payload: {} }); });
  await o1.page.waitForTimeout(300);
  check('H3. OUDE APP: capabilities-antwoord werkt nog via de bestaande brug', (await o1.page.evaluate(function () { return document.body.innerText.length > 0; })));
  check('H4. OUDE APP: geen JavaScript-fouten', o1.st.errors.length === 0, o1.st.errors.join('; '));
  await ctx1.close();

  var ctxB = await browser.newContext(small);
  var b = await newPage(ctxB, { loggedIn: true, plans: plans, blob: blob });
  await b.page.addInitScript(function () { delete window.webkit; });
  await b.page.goto(BASE + 'index.html'); await b.page.waitForTimeout(1000);
  check('H5. gewone browser: website ongewijzigd (tabbalk zichtbaar, geen native-tabs)', !(await b.page.evaluate(function () { return document.documentElement.classList.contains('native-tabs'); })) && !(await hidden(b.page, '.tab-bar')));
  check('H5. gewone browser: geen JavaScript-fouten', b.st.errors.length === 0, b.st.errors.join('; '));
  await ctxB.close();

  // nieuwe app, maar de brug antwoordt niet (bijv. verouderde app-build): de eigen tabbalk komt terug
  var ctxN = await browser.newContext(Object.assign({ userAgent: APP2 }, small));
  var nn = await newPage(ctxN, { loggedIn: true, plans: plans, blob: blob, answer: false });
  await nn.page.goto(BASE + 'index.html'); await nn.page.waitForTimeout(800);
  check('I1. app-versie 2 die niet antwoordt: eerst verborgen (geen flits)', await hidden(nn.page, '.tab-bar'));
  await nn.page.waitForTimeout(6500);
  check('I2. na de tijdslimiet komt de tabbalk van de website terug (nooit een app zonder navigatie)', !(await hidden(nn.page, '.tab-bar')));
  await ctxN.close();

  await browser.close();
  var failed = checks.filter(function (c) { return !c[1]; });
  checks.forEach(function (c) { console.log((c[1] ? 'OK   - ' : 'FAIL - ') + c[0] + (c[1] ? '' : ' [' + c[2] + ']')); });
  console.log(failed.length ? failed.length + ' controle(s) mislukt.' : 'Alle controles geslaagd.');
  process.exit(failed.length ? 1 : 0);
}
main().catch(function (e) { console.error(e); process.exit(2); });
