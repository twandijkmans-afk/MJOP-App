'use strict';
// Browsertest: de 3D BAG-koppeling. De wizard wacht niet op de 3D BAG; elke uitkomst (OK, time-out, netwerkfout,
// HTTP-fout, ontbrekend pand, onleesbaar antwoord, ontbrekende attributen) krijgt een eigen melding; opnieuw ophalen
// werkt; ontbrekende waarden worden nooit verzonnen; handmatig vastgelegde/bevestigde hoeveelheden en andere projecten
// worden nooit overschreven. iPhone-WebView-UA + brug; 3D BAG-antwoord in de vorm van een echte CityJSONFeature
// (attributen van Maldenhof 240, zie test/fixtures/real/maldenhof_240_snapshot_excerpt.json).
//   python3 -m http.server 8967 &  ;  MJOP_TEST_BASE=http://localhost:8967/ MJOP_SUPABASE_SDK=/pad/supabase.js node test/3dbag-status.spec.js
let chromium;
try { chromium = require('playwright').chromium; } catch (e) { chromium = require('/opt/node22/lib/node_modules/playwright').chromium; }
var fs = require('fs');
var path = require('path');
var BASE = process.env.MJOP_TEST_BASE || 'http://localhost:8967/';
var CHROMIUM_PATH = process.env.MJOP_CHROMIUM || '/opt/pw-browsers/chromium';
var SDK_URL = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.116.0/dist/umd/supabase.js';
var SDK_FILE = process.env.MJOP_SUPABASE_SDK || null;
var TEST_HOST = 'testproject0000000000.supabase.co';
var TEST_CONFIG = "window.SUPABASE_CONFIG = { url: 'https://" + TEST_HOST + "', anonKey: 'sb_publishable_TESTKEYabcdefghijklmnop' };";
var CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS' };
var UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MJOPLiveApp/1';
var FIX = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'real', 'maldenhof_240_snapshot_excerpt.json'), 'utf8'));
var PAND = '0424100000003525';                  // Singelstraat 8, Muiden (echte BAG-koppeling vbo 0424010000001273)
var checks = [];
function check(name, ok, detail) { checks.push([name, !!ok, detail]); }
var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
function b64u(o) { return Buffer.from(JSON.stringify(o)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'); }
function session() {
  var jwt = b64u({ alg: 'HS256' }) + '.' + b64u({ sub: 'u1', role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 }) + '.c2ln';
  return { access_token: jwt, token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'r-abc',
    user: { id: 'u1', aud: 'authenticated', role: 'authenticated', email: 'test@example.org', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' } };
}
function feature(attrs, pand) {   // CityJSONFeature zoals api.3dbag.nl die levert (pand + deel)
  pand = pand || PAND;
  var co = {}; co['NL.IMBAG.Pand.' + pand] = { type: 'Building', attributes: attrs, children: ['NL.IMBAG.Pand.' + pand + '-0'] };
  co['NL.IMBAG.Pand.' + pand + '-0'] = { type: 'BuildingPart', parents: ['NL.IMBAG.Pand.' + pand] };
  return JSON.stringify({ type: 'CityJSONFeature', id: 'NL.IMBAG.Pand.' + pand, feature: { type: 'CityJSONFeature', id: 'NL.IMBAG.Pand.' + pand, CityObjects: co, vertices: [] } });
}
// Het snapshot-excerpt bevat de kwaliteitsvelden niet; live op 26-10-2026 gaf de API voor dit pand
// b3_kwaliteitsindicator = true en b3_val3dity_lod22 = []. MALDENHOF_ZONDER_KWALITEIT test het ontbreken ervan.
var MALDENHOF_ZONDER_KWALITEIT = FIX.threedbag_attributes;
var MALDENHOF = Object.assign({ b3_kwaliteitsindicator: true, b3_val3dity_lod22: [] }, FIX.threedbag_attributes);
var SINGEL8 = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'real', 'singelstraat8_3dbag_20261026_excerpt.json'), 'utf8')).threedbag_attributes;
var SAVED_BLOB = { building: { adres: 'Bestaandstraat 5, 2000BB Utrecht', bouwjaar: 1980, units: 10, opp: 300, omtrek: 80, dakM2: 300, gevelM2: 700, d3: null, identificatie: '0344100000000001' },
  elements: [], fonds: 1000, bijdrage: 60, invul: { fonds: true, bijdrage: true }, offertes: {}, bijvullen: {} };

// o.d3: functie(route, n) die het n-de 3D BAG-verzoek afhandelt
async function newPage(browser, o) {
  var ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: UA });
  var page = await ctx.newPage();
  var st = { errors: [], writes: [], d3n: 0 };
  page.on('pageerror', function (e) { st.errors.push(String(e)); });
  await page.route(/^https?:\/\/(?!localhost)/, function (route) {
    var req = route.request(), url = req.url();
    if (url === SDK_URL) return SDK_FILE ? route.fulfill({ status: 200, contentType: 'application/javascript', body: fs.readFileSync(SDK_FILE), headers: { 'access-control-allow-origin': '*' } }) : route.continue();
    if (url.indexOf('https://' + TEST_HOST + '/') === 0) {
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
      var j = function (status, body) { return route.fulfill({ status: status, contentType: 'application/json', headers: CORS, body: JSON.stringify(body) }); };
      if (/\/auth\/v1\/user/.test(url)) return j(200, session().user);
      if (/\/rest\/v1\/subscriptions/.test(url)) return j(200, { status: 'active', current_period_end: '2099-01-01T00:00:00Z' });
      if (/\/rest\/v1\/saved_plans/.test(url)) {
        if (req.method() === 'POST' || req.method() === 'PATCH') { st.writes.push({ method: req.method(), url: url, body: req.postData() }); return j(200, { id: 'p-nieuw' }); }
        if (/[?&]id=eq\.p1/.test(url)) return j(200, { id: 'p1', state: SAVED_BLOB });
        return j(200, [{ id: 'p1', label: SAVED_BLOB.building.adres, adres: SAVED_BLOB.building.adres, updated_at: new Date().toISOString(), invul: { fonds: true, bijdrage: true } }]);
      }
      if (/\/rest\/v1\//.test(url)) return j(200, null);
      return j(200, {});
    }
    if (/api\.3dbag\.nl\/collections\/pand\/items\//.test(url)) { st.d3n++; st.d3url = url; return o.d3(route, st.d3n); }
    if (/locatieserver\/search\/v3_1\/suggest/.test(url)) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ response: { docs: [{ id: 'adr-6e2a59707541ce9e13944981f155cc83', weergavenaam: 'Singelstraat 8, 1398BN Muiden' }] } }) });
    if (/locatieserver\/search\/v3_1\/lookup/.test(url)) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ response: { docs: [{ weergavenaam: 'Singelstraat 8, 1398BN Muiden', centroide_ll: 'POINT(5.06698347 52.33004363)' }] } }) });
    if (/kadaster\/bag\/ogc\/v2\/collections\/pand\/items/.test(url)) {
      var lon = 5.06698347, lat = 52.33004363, d = 0.00004;
      var ring = [[lon - d, lat - d], [lon + d, lat - d], [lon + d, lat + d], [lon - d, lat + d], [lon - d, lat - d]];
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ features: [{ geometry: { type: 'Polygon', coordinates: [ring] }, properties: { identificatie: PAND, bouwjaar: 1925, gebruiksdoel: 'woonfunctie', aantal_verblijfsobjecten: 1 } }] }) });
    }
    return route.abort();
  });
  await page.route('**/src/config.js', function (route) { route.fulfill({ status: 200, contentType: 'application/javascript', body: TEST_CONFIG }); });
  await page.addInitScript(function (a) {
    try { localStorage.setItem('sb-testproject0000000000-auth-token', JSON.stringify(a.s)); } catch (e) {}
    window.webkit = { messageHandlers: { mjopNative: { postMessage: function () {} } } };
    if (a.l) window.__mjopLookupMs = a.l;
  }, { s: session(), l: o.limits || null });
  return { ctx: ctx, page: page, st: st };
}
async function click(page, sel) { await page.evaluate(function (s) { var e = document.querySelector(s); if (e) e.click(); }, sel); await page.waitForTimeout(150); }
async function text(page) { return page.evaluate(function () { return document.body.innerText; }); }
async function werk(page) { return page.evaluate(function () { return JSON.parse(sessionStorage.getItem('mjop-worksessie') || 'null'); }); }
async function d3status(page) { return page.evaluate(function () { var e = document.querySelector('[data-d3-status]'); return e ? e.dataset.d3Status : null; }); }
async function rijen(page) {
  return page.evaluate(function () {
    var out = {}; document.querySelectorAll('[data-d3-rij]').forEach(function (e) { out[e.dataset.d3Rij] = { soort: e.dataset.d3Soort, tekst: e.querySelector('.wz-feit-w').textContent }; }); return out;
  });
}
async function kiesAdres(r) {
  await r.page.goto(BASE + 'index.html'); await r.page.waitForTimeout(800);
  await click(r.page, '[data-act=wizard-start]');
  await r.page.fill('#addr-search', 'Singelstraat 8'); await r.page.dispatchEvent('#addr-search', 'input');
  await r.page.waitForSelector('.suggest-row', { timeout: 5000 });
  var t0 = Date.now();
  await r.page.evaluate(function () { document.querySelector('.suggest-row').click(); });
  await r.page.waitForSelector('.wz-voortgang', { timeout: 8000 });
  return Date.now() - t0;
}
async function waitStatus(page, wanted, ms) {
  var end = Date.now() + (ms || 8000);
  while (Date.now() < end) { if (wanted.indexOf(await d3status(page)) > -1) return true; await sleep(100); }
  return false;
}
var ok = function (attrs, delay) { return function (route) {
  var pand = (route.request().url().match(/NL\.IMBAG\.Pand\.(\d+)/) || [])[1];
  var f = function () { route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: feature(attrs, pand) }); }; if (delay) setTimeout(f, delay); else f(); }; };
// Volledige tekst van het 3D-blok, inclusief de (ingeklapte) technische details.
async function blokTekst(page) { return page.evaluate(function () { var e = document.querySelector('[data-d3-status]'); return e ? e.textContent : ''; }); }
async function kwaliteit(page) { return page.evaluate(function () { var e = document.querySelector('[data-d3-status]'); return e ? (e.dataset.d3Kwaliteit || null) : null; }); }
var elQ = function (plan, id) { var e = plan.elements.filter(function (x) { return x.id === id; })[0]; return e ? e.quantity : null; };

async function main() {
  var browser = await chromium.launch({ executablePath: CHROMIUM_PATH });
  var r, t, rows, w;

  // 1. Trage maar geslaagde 3D BAG: de wizard komt meteen (wacht niet), daarna worden de 3D-waarden toegepast.
  r = await newPage(browser, { d3: ok(MALDENHOF, 3000) });
  var dt = await kiesAdres(r);
  t = await text(r.page);
  check('1. wizard verschijnt zonder op de 3D BAG te wachten (' + dt + ' ms)', dt < 2500 && /Is dit je gebouw\?/.test(t), dt);
  check('1. tijdens het ophalen: duidelijke voortgang', (await d3status(r.page)) === 'LADEN' && /3D BAG-gegevens ophalen/.test(t));
  check('1. juiste 3D BAG-URL voor het geselecteerde pand', r.st.d3url === 'https://api.3dbag.nl/collections/pand/items/NL.IMBAG.Pand.' + PAND, r.st.d3url);
  check('1. tijdens het laden dak/gevel als BAG-afleiding, niet als 3D BAG', /BAG-afleiding/.test(t) && !/3DBAG-modelwaarde/.test(t));
  check('1. na het antwoord: status OK', await waitStatus(r.page, ['OK'], 6000));
  rows = await rijen(r.page); t = await text(r.page);
  check('1. bouwhoogte = b3_h_dak_max − b3_h_maaiveld uit de 3D BAG', rows.Bouwhoogte.soort === 'd3bag' && /9,4 m/.test(rows.Bouwhoogte.tekst), JSON.stringify(rows.Bouwhoogte));
  check('1. daktype uit de 3D BAG (slanted -> hellend)', rows.Daktype.soort === 'd3bag' && /hellend/.test(rows.Daktype.tekst), JSON.stringify(rows.Daktype));
  check('1. plat (13 m²) en hellend (74 m²) dakoppervlak uit de 3D BAG', rows['Plat dakoppervlak'].soort === 'd3bag' && /13 m²/.test(rows['Plat dakoppervlak'].tekst)
    && rows['Hellend dakoppervlak'].soort === 'd3bag' && /74 m²/.test(rows['Hellend dakoppervlak'].tekst), JSON.stringify([rows['Plat dakoppervlak'], rows['Hellend dakoppervlak']]));
  check('1. buitenmuuroppervlak (118 m²), grondvlak en bouwlagen uit de 3D BAG', rows.Buitenmuuroppervlak.soort === 'd3bag' && /118 m²/.test(rows.Buitenmuuroppervlak.tekst)
    && rows.Grondvlak.soort === 'd3bag' && rows.Bouwlagen.soort === 'd3bag' && /2/.test(rows.Bouwlagen.tekst), JSON.stringify(rows));
  check('1. stap 1: dak en gevel nu als 3DBAG-modelwaarde', /87 m²/.test(t) && /3DBAG-modelwaarde/.test(t));
  w = await werk(r.page);
  var ids = w.plan.elements.map(function (e) { return e.id; });
  check('1. onaangeroerde standaardposten opnieuw opgebouwd: hellend dak erbij, hoeveelheden uit 3D BAG', ids.indexOf('dak-hellend') > -1
    && w.plan.elements.filter(function (e) { return e.id === 'dak-hellend'; })[0].quantity.source === '3D_BAG', JSON.stringify(ids));
  check('1. ruwe 3D BAG-attributen bewaard (d3raw) met pandnummer', w.plan.building.d3raw && w.plan.building.d3raw.pandId === 'NL.IMBAG.Pand.' + PAND && w.plan.building.d3raw.attributes.b3_opp_dak_schuin === 74.07);
  check('1. geen JavaScript-fouten', r.st.errors.length === 0, r.st.errors.join('; '));
  await r.ctx.close();

  // 2. Netwerkfout (zoals op de iPhone bij een geweigerde beveiligde verbinding): eigen melding, niets verzonnen.
  r = await newPage(browser, { d3: function (route) { route.abort('failed'); } });
  await kiesAdres(r);
  check('2. netwerkfout: status NETWERK', await waitStatus(r.page, ['NETWERK'], 6000));
  rows = await rijen(r.page); t = await text(r.page);
  check('2. melding noemt de oorzaak (geen verbinding met de server), niet het adres', /Geen verbinding met de 3D BAG-server/.test(t) && /Aan het gekozen adres ligt het niet/.test(t) && /niet vast te stellen/.test(await blokTekst(r.page)));
  check('2. technische oorzaak staat ingeklapt onder "Technische details", niet in de hoofdtekst', !/niet vast te stellen/.test(t) && /Technische details/.test(t));
  check('2. knop "3D BAG opnieuw ophalen" aanwezig', !!(await r.page.$('[data-act=d3-opnieuw]')));
  check('2. niets verzonnen: hoogte, daktype, hellend dak en bouwlagen onbekend', rows.Bouwhoogte.soort === 'onbekend' && rows.Daktype.soort === 'onbekend'
    && rows['Hellend dakoppervlak'].soort === 'onbekend' && rows.Bouwlagen.soort === 'onbekend' && /—/.test(rows.Bouwhoogte.tekst), JSON.stringify(rows));
  check('2. plat dak en buitenmuur zijn een gemarkeerde BAG-afleiding', rows['Plat dakoppervlak'].soort === 'bagafl' && rows.Buitenmuuroppervlak.soort === 'bagafl', JSON.stringify(rows));
  check('2. gevel zonder 3D BAG expliciet als grove aanname (omtrek × 9 m), geen meting of registratie', /omtrek van het BAG-pand × een aangenomen hoogte van 9 m/.test(rows.Buitenmuuroppervlak.tekst) && /Geen gemeten of geregistreerd geveloppervlak/.test(rows.Buitenmuuroppervlak.tekst), rows.Buitenmuuroppervlak.tekst);
  var stap1 = await r.page.evaluate(function () { return Array.prototype.map.call(document.querySelectorAll('[data-feit-aanname]'), function (e) { return e.textContent; }); });
  check('2. stap 1 "Is dit je gebouw?" noemt bij de gevel dezelfde aanname', stap1.some(function (x) { return /aangenomen hoogte van 9 m/.test(x) && /Geen gemeten of geregistreerd/.test(x); }), JSON.stringify(stap1));
  w = await werk(r.page);
  var gm = w.plan.elements.filter(function (e) { return e.id === 'gevel-metselwerk'; })[0];
  check('2. herkomst van de gevelhoeveelheid noemt de aanname', gm && /grove geometrische aanname/.test(gm.quantity.auto.reason || JSON.stringify(gm.quantity)), gm && JSON.stringify(gm.quantity).slice(0, 300));
  check('2. geen 3D-waarden in het plan (d3 en d3raw leeg)', !w.plan.building.d3 && !w.plan.building.d3raw && w.plan.building.werkhoogte == null);
  await r.ctx.close();

  // 3. Time-out en opnieuw ophalen met voortgang.
  r = await newPage(browser, { limits: { d3: 1000, d3Opnieuw: 4000 }, d3: function (route, n) { if (n === 1) return; ok(MALDENHOF, 1200)(route); } });
  await kiesAdres(r);
  check('3. time-out: status TIMEOUT met de limiet in de melding', await waitStatus(r.page, ['TIMEOUT'], 6000) && /niet op tijd \(binnen 1 seconden\)/.test(await text(r.page)));
  await click(r.page, '[data-act=d3-opnieuw]');
  t = await text(r.page);
  check('3. opnieuw ophalen toont voortgang', (await d3status(r.page)) === 'LADEN' && /3D BAG-gegevens ophalen.*maximaal 4 s/.test(t), t.slice(0, 200));
  check('3. tweede poging slaagt en past de 3D-waarden toe', await waitStatus(r.page, ['OK'], 6000) && (await rijen(r.page)).Bouwhoogte.soort === 'd3bag');
  await r.ctx.close();

  // 4-7. Overige oorzaken, elk met een eigen melding.
  var gevallen = [
    ['4. HTTP 500', function (route) { route.fulfill({ status: 500, contentType: 'text/plain', body: 'error' }); }, 'HTTP', /server gaf een fout.*HTTP 500/],
    ['5. pand niet in 3D BAG (404)', function (route) { route.fulfill({ status: 404, contentType: 'application/json', body: '{"code":"NotFound"}' }); }, 'NIET_GEVONDEN', /staat niet in de 3D BAG/],
    ['6. onleesbaar antwoord (geen JSON)', function (route) { route.fulfill({ status: 200, contentType: 'text/html', body: '<html>onderhoud</html>' }); }, 'ONGELDIG_ANTWOORD', /niet kon lezen.*geen geldige JSON/],
    ['6b. JSON zonder CityJSONFeature', function (route) { route.fulfill({ status: 200, contentType: 'application/json', body: '{"type":"FeatureCollection","features":[]}' }); }, 'ONGELDIG_ANTWOORD', /niet kon lezen.*geen CityJSONFeature/],
    ['7. pand zonder attributen', ok({}, 0), 'GEEN_ATTRIBUTEN', /zonder dak-, gevel- of hoogtegegevens/],
  ];
  for (var i = 0; i < gevallen.length; i++) {
    r = await newPage(browser, { d3: gevallen[i][1] });
    await kiesAdres(r);
    var gelukt = await waitStatus(r.page, [gevallen[i][2]], 6000);
    t = await blokTekst(r.page);
    check(gevallen[i][0] + ': status ' + gevallen[i][2] + ' met eigen melding en opnieuw-knop', gelukt && gevallen[i][3].test(t) && !!(await r.page.$('[data-act=d3-opnieuw]')), (await d3status(r.page)) + ' ' + t.slice(0, 160));
    await r.ctx.close();
  }

  // 8. Deels aanwezige attributen: alleen wat er is; ontbrekend blijft onbekend (nooit 0) en wordt genoemd.
  r = await newPage(browser, { d3: ok({ b3_opp_dak_plat: 51.2, b3_opp_buitenmuur: 140.6, b3_opp_grond: 51.9, b3_kwaliteitsindicator: true }, 0) });
  await kiesAdres(r);
  await waitStatus(r.page, ['OK'], 6000);
  rows = await rijen(r.page); t = await text(r.page);
  check('8. aanwezige velden uit de 3D BAG', rows['Plat dakoppervlak'].soort === 'd3bag' && /51 m²/.test(rows['Plat dakoppervlak'].tekst) && rows.Buitenmuuroppervlak.soort === 'd3bag', JSON.stringify(rows));
  check('8. ontbrekend hellend dak/hoogte/daktype blijft onbekend, niet 0', rows['Hellend dakoppervlak'].soort === 'onbekend' && rows.Bouwhoogte.soort === 'onbekend' && rows.Daktype.soort === 'onbekend' && !/0 m²/.test(rows['Hellend dakoppervlak'].tekst), JSON.stringify(rows));
  check('8. melding zegt eenvoudig dat niet alle maten in het model staan; de velden staan bij de technische details', /Niet alle maten staan in het 3D-model/.test(t) && /Niet in het model: .*b3_opp_dak_schuin/.test(await blokTekst(r.page)));
  w = await werk(r.page);
  check('8. totaal dakoppervlak niet als som verzonnen (dak blijft BAG-afleiding)', w.plan.building.d3.dak == null && w.plan.building.d3.schuin == null, JSON.stringify(w.plan.building.d3));
  await r.ctx.close();

  // 9. Bestaand project (hersteld na herladen) met handmatige en bevestigde hoeveelheden: een latere geslaagde 3D BAG-poging
  //    wijzigt NIETS in het plan; de 3D-waarden worden alleen als voorstel getoond.
  r = await newPage(browser, { d3: function (route, n) { if (n === 1) return route.abort('failed'); ok(MALDENHOF, 0)(route); } });
  await kiesAdres(r);
  await waitStatus(r.page, ['NETWERK'], 6000);
  w = await werk(r.page);
  var plan = w.plan, now = new Date().toISOString();
  var dakPlat = plan.elements.filter(function (e) { return e.id === 'dak-plat'; })[0];
  var gevel = plan.elements.filter(function (e) { return e.id === 'gevel-metselwerk'; })[0];
  dakPlat.quantity.manual = { value: 48, unit: 'm2', text: '48', at: now }; dakPlat.quantity.value = 48; dakPlat.quantity.source = 'MANUAL'; dakPlat.quantity.status = 'USER_OVERRIDDEN';
  gevel.quantity.confirmed = { value: gevel.quantity.auto.value, at: now }; gevel.quantity.status = 'CONFIRMED';
  var steigerVoor = plan.elements.filter(function (e) { return e.id === 'steiger'; })[0];
  if (steigerVoor) steigerVoor.werkhoogte = 11.5;
  await r.page.evaluate(function (x) { sessionStorage.setItem('mjop-worksessie', JSON.stringify(x)); }, w);
  await r.page.reload(); await r.page.waitForTimeout(900);
  var voorPlan = (await werk(r.page)).plan;
  await click(r.page, '[data-act=d3-opnieuw]');
  await waitStatus(r.page, ['OK'], 6000);
  w = await werk(r.page);
  var q = function (id) { return w.plan.elements.filter(function (e) { return e.id === id; })[0].quantity; };
  check('9. handmatige hoeveelheid (plat dak 48 m²) blijft staan', q('dak-plat').manual && q('dak-plat').value === 48 && q('dak-plat').status === 'USER_OVERRIDDEN', JSON.stringify(q('dak-plat')).slice(0, 200));
  check('9. bevestigde hoeveelheid (gevel) blijft bevestigd met dezelfde waarde', q('gevel-metselwerk').confirmed && q('gevel-metselwerk').status === 'CONFIRMED' && q('gevel-metselwerk').value === voorPlan.elements.filter(function (e) { return e.id === 'gevel-metselwerk'; })[0].quantity.value);
  check('9. bestaand project: alle posten exact ongewijzigd (ook automatische)', JSON.stringify(w.plan.elements) === JSON.stringify(voorPlan.elements));
  check('9. bestaand project: dak, gevel, werkhoogte en d3 van het gebouw ongewijzigd', w.plan.building.dakM2 === voorPlan.building.dakM2 && w.plan.building.gevelM2 === voorPlan.building.gevelM2
    && w.plan.building.werkhoogte === voorPlan.building.werkhoogte && !w.plan.building.d3 && !w.plan.building.d3raw);
  check('9. 3D-waarden wel bewaard en getoond als voorstel, met duidelijke melding', w.plan.building.d3voorstel && w.plan.building.d3voorstel.d3raw.attributes.b3_opp_dak_schuin === 74.07
    && !!(await r.page.$('[data-d3-voorstel]')) && /bestaand project: je posten en kosten zijn niet automatisch aangepast/.test(await text(r.page)) && !!(await r.page.$('[data-act=d3-overnemen]')));
  rows = await rijen(r.page);
  check('9. Gebouw/stap 1 toont "Handmatig bevestigd" bij plat dak en buitenmuur', rows['Plat dakoppervlak'].soort === 'handmatig' && rows.Buitenmuuroppervlak.soort === 'handmatig', JSON.stringify(rows));
  await r.ctx.close();

  // 9b. Nieuw gebouw in dezelfde sessie: handmatige hoeveelheid en zelf ingevulde werkhoogte blijven staan bij een
  //     latere geslaagde poging; alleen niet-vastgelegde automatische waarden worden bijgewerkt, en dat wordt gemeld.
  r = await newPage(browser, { d3: function (route, n) { if (n === 1) return route.abort('failed'); ok(MALDENHOF, 0)(route); } });
  await kiesAdres(r);
  await waitStatus(r.page, ['NETWERK'], 6000);
  await click(r.page, '[data-act=wizard-stop]');
  await r.page.evaluate(function () { var e = document.querySelector('[data-act=set-tab][data-tab=gebouw]'); if (e) e.click(); }); await sleep(200);
  await r.page.evaluate(function () { var e = document.querySelector('.gb-row[data-act=open-element][data-id=dak-plat]'); if (e) e.click(); }); await sleep(200);
  await r.page.fill('#hv-dak-plat', '48'); await r.page.press('#hv-dak-plat', 'Tab'); await sleep(200);
  await r.page.evaluate(function () { var e = document.querySelector('[data-act=set-tab][data-tab=gebouw]'); if (e) e.click(); }); await sleep(200);
  await r.page.evaluate(function () { var e = document.querySelector('.gb-row[data-act=open-element][data-id=steiger]'); if (e) e.click(); }); await sleep(200);
  var heeftWh = !!(await r.page.$('#wh-steiger'));
  if (heeftWh) { await r.page.fill('#wh-steiger', '11,5'); await r.page.press('#wh-steiger', 'Tab'); await sleep(200); }
  w = await werk(r.page);
  var inspVoor = w.plan.elements.filter(function (e) { return e.id === 'dakinspectie'; })[0].quantity.value;
  await r.page.evaluate(function () { var e = document.querySelector('[data-act=set-tab][data-tab=gebouw]'); if (e) e.click(); }); await sleep(200);
  await click(r.page, '[data-act=d3-opnieuw]');
  check('9b. opnieuw ophalen slaagt', await waitStatus(r.page, ['OK'], 6000));
  w = await werk(r.page);
  var el9 = function (id) { return w.plan.elements.filter(function (e) { return e.id === id; })[0]; };
  check('9b. handmatig ingevoerde 48 m² (via het invoerveld) blijft staan', el9('dak-plat').quantity.value === 48 && !!el9('dak-plat').quantity.manual, JSON.stringify(el9('dak-plat').quantity).slice(0, 200));
  check('9b. zelf ingevulde werkhoogte 11,5 m blijft staan', heeftWh && el9('steiger').werkhoogte === 11.5, String(heeftWh) + ' ' + (el9('steiger') && el9('steiger').werkhoogte));
  check('9b. niet-vastgelegde automatische hoeveelheid krijgt de 3D BAG-waarde', el9('dakinspectie').quantity.value === 86.81 && inspVoor !== 86.81, inspVoor + ' -> ' + el9('dakinspectie').quantity.value);
  t = await text(r.page);
  check('9b. melding noemt wat automatisch is bijgewerkt', /Automatisch bijgewerkt: .*Dakinspectie/i.test(t) && !/Automatisch bijgewerkt: [^.]*Dakbedekking plat/.test(t), (t.match(/Automatisch bijgewerkt[^\n]*/) || [''])[0]);
  check('9b. geen JavaScript-fouten', r.st.errors.length === 0, r.st.errors.join('; '));
  await r.ctx.close();

  // 10. Ander project geopend terwijl de 3D BAG nog laadt: het antwoord wijzigt dat project niet.
  r = await newPage(browser, { d3: ok(MALDENHOF, 2500) });
  await kiesAdres(r);
  await click(r.page, '[data-act=wizard-stop]');
  await r.page.evaluate(function () { var e = document.querySelector('[data-act=open-plan][data-id=p1]'); if (e) e.click(); });
  await sleep(4000);
  w = await werk(r.page);
  check('10. geopend project p1 kreeg geen 3D BAG-gegevens van het andere pand', w.currentPlanId === 'p1' && w.plan.building.adres === SAVED_BLOB.building.adres && !w.plan.building.d3 && !w.plan.building.d3raw, JSON.stringify([w.currentPlanId, w.plan.building.adres, !!w.plan.building.d3]));
  check('10. p1 is niet bijgewerkt in de database', !r.st.writes.some(function (x) { return /id=eq\.p1/.test(x.url); }), JSON.stringify(r.st.writes.map(function (x) { return x.method + ' ' + x.url; })));
  await r.ctx.close();

  // 11. Herladen tijdens het ophalen: status ONDERBROKEN met de knop opnieuw ophalen (niet eeuwig "laden").
  r = await newPage(browser, { d3: function (route, n) { if (n === 1) return; ok(MALDENHOF, 0)(route); } });
  await kiesAdres(r);
  await r.page.reload(); await r.page.waitForTimeout(900);
  check('11. na herladen: ONDERBROKEN met opnieuw-knop', (await d3status(r.page)) === 'ONDERBROKEN' && !!(await r.page.$('[data-act=d3-opnieuw]')));
  await click(r.page, '[data-act=d3-opnieuw]');
  check('11. opnieuw ophalen na herladen werkt', await waitStatus(r.page, ['OK'], 6000));
  await r.ctx.close();

  // 12. Echte 3D BAG-attributen van Singelstraat 8 (pand 0424100000003525, opgehaald 26-10-2026): kwaliteitsindicator FALSE,
  //     val3dity_lod22 [102]. Tonen als voorstel met "controle nodig"; niets automatisch in posten of kosten.
  r = await newPage(browser, { d3: ok(SINGEL8, 600) });
  await kiesAdres(r);
  var planVoor = (await werk(r.page)).plan;
  check('12. Singelstraat 8: status OK', await waitStatus(r.page, ['OK'], 6000));
  rows = await rijen(r.page); w = await werk(r.page); t = await text(r.page);
  check('12. kwaliteitsindicator false en val3dity [102] gelezen en bewaard (voorstel)', w.plan.building.d3voorstel && w.plan.building.d3voorstel.d3raw.attributes.b3_kwaliteitsindicator === false
    && JSON.stringify(w.plan.building.d3voorstel.d3raw.attributes.b3_val3dity_lod22) === '[102]' && (await kwaliteit(r.page)) === 'CONTROLE');
  check('12. melding "3D-model beschikbaar — controle nodig" in eenvoudige taal', /3D-model beschikbaar — controle nodig/.test(t) && /mogelijk niet correct/.test(t) && /pas in je onderhoudsposten en kosten gebruikt als je ze overneemt/.test(t));
  check('12. technische details tonen b3_kwaliteitsindicator: false en b3_val3dity_lod22: [102]', /b3_kwaliteitsindicator: false/.test(await blokTekst(r.page)) && /b3_val3dity_lod22: \[102\]/.test(await blokTekst(r.page)) && !/\[102\]/.test(t));
  check('12. waarden zichtbaar: hoogte 7,7 m, hellend dak, plat 6 m², hellend 62 m², buitenmuur 114 m², grondvlak 52 m², 2 bouwlagen (als voorstel)',
    /7,7 m/.test(rows.Bouwhoogte.tekst) && /hellend/.test(rows.Daktype.tekst) && /^6 m²/.test(rows['Plat dakoppervlak'].tekst) && /^62 m²/.test(rows['Hellend dakoppervlak'].tekst)
    && /^114 m²/.test(rows.Buitenmuuroppervlak.tekst) && /^52 m²/.test(rows.Grondvlak.tekst) && rows.Bouwlagen.tekst === '2' && rows.Bouwhoogte.soort === 'voorstel' && rows.Buitenmuuroppervlak.soort === 'voorstel'
    && rows['Kwaliteit 3D-model'].soort === 'controle', JSON.stringify(rows));
  check('12. NIET automatisch overgenomen: posten, dak, gevel, werkhoogte en d3 ongewijzigd', JSON.stringify(w.plan.elements) === JSON.stringify(planVoor.elements)
    && w.plan.building.dakM2 === planVoor.building.dakM2 && w.plan.building.gevelM2 === planVoor.building.gevelM2 && w.plan.building.werkhoogte == null && !w.plan.building.d3 && !w.plan.building.d3raw
    && elQ(w.plan, 'gevel-metselwerk').source !== '3D_BAG', JSON.stringify([w.plan.building.dakM2, w.plan.building.gevelM2]));
  check('12. stap 1 blijft dak en gevel als BAG-afleiding tonen (geen 3DBAG-modelwaarde in het plan)', /BAG-afleiding/.test(t));
  // handmatige hoeveelheid vóór het overnemen (via het invoerveld)
  await click(r.page, '[data-act=wizard-stop]');
  await click(r.page, '[data-act=set-tab][data-tab=gebouw]');
  await click(r.page, '.gb-row[data-act=open-element][data-id=dak-plat]');
  await r.page.fill('#hv-dak-plat', '48'); await r.page.press('#hv-dak-plat', 'Tab'); await sleep(200);
  await click(r.page, '[data-act=set-tab][data-tab=gebouw]');
  await click(r.page, '.gb-row[data-act=open-element][data-id=gevel-metselwerk]');
  await click(r.page, '[data-act=qty-confirm][data-id=gevel-metselwerk]');
  w = await werk(r.page);
  var gevelBevestigd = elQ(w.plan, 'gevel-metselwerk');
  check('12. (voorbereiding) gevelhoeveelheid is bevestigd vóór het overnemen', gevelBevestigd.status === 'CONFIRMED', gevelBevestigd.status);
  await click(r.page, '[data-act=set-tab][data-tab=gebouw]');
  check('12. Gebouw toont knop om na controle over te nemen', !!(await r.page.$('[data-act=d3-overnemen]')));
  await click(r.page, '[data-act=d3-overnemen]');
  w = await werk(r.page); t = await text(r.page);
  var b12 = w.plan.building;
  check('12. na expliciet overnemen: dak 68 m² en gevel 114 m² in het plan, werkhoogte uit de hoogte', b12.d3 && b12.d3.dak === 68 && b12.d3.gevel === 114 && b12.dakM2 === 68 && b12.gevelM2 === 114 && b12.werkhoogte != null && !b12.d3voorstel, JSON.stringify([b12.dakM2, b12.gevelM2, b12.werkhoogte]));
  check('12. overname vastgelegd met bron, kwaliteitsindicator (false), val3dity en ophaaldatum', b12.d3raw && b12.d3raw.overgenomen && b12.d3raw.overgenomen.door === 'gebruiker' && /3D BAG/.test(b12.d3raw.overgenomen.bron)
    && b12.d3raw.overgenomen.b3_kwaliteitsindicator === false && JSON.stringify(b12.d3raw.overgenomen.b3_val3dity_lod22) === '[102]' && b12.d3raw.overgenomen.opgehaald === b12.d3raw.fetchedAt && !!b12.d3raw.fetchedAt, JSON.stringify(b12.d3raw && b12.d3raw.overgenomen));
  var insp = elQ(w.plan, 'dakinspectie');
  var meta = insp && insp.auto && insp.auto.raw && (insp.auto.raw.inputs ? insp.auto.raw.inputs[0] : insp.auto.raw);
  check('12. herkomst van een overgenomen hoeveelheid noemt 3D BAG, kwaliteitsindicator, ophaaldatum en overname', /3D BAG/.test(insp.auto.basis) && JSON.stringify(insp).indexOf('"quality_indicator":false') > -1
    && JSON.stringify(insp).indexOf('"accepted_by_user_at":"') > -1 && JSON.stringify(insp).indexOf('"fetched_at":"' + b12.d3raw.fetchedAt + '"') > -1, JSON.stringify(insp).slice(0, 400));
  check('12. handmatige hoeveelheid (plat dak 48 m²) blijft na overnemen staan', elQ(w.plan, 'dak-plat').value === 48 && !!elQ(w.plan, 'dak-plat').manual);
  check('12. bevestigde gevelhoeveelheid blijft na overnemen bevestigd en ongewijzigd', elQ(w.plan, 'gevel-metselwerk').status === 'CONFIRMED' && elQ(w.plan, 'gevel-metselwerk').value === gevelBevestigd.value, JSON.stringify(elQ(w.plan, 'gevel-metselwerk')).slice(0, 200));
  check('12. melding "overgenomen na controle" met wat er is bijgewerkt', /3D-model overgenomen na controle/.test(t) && /Automatisch bijgewerkt: .*Dakinspectie/.test(t), (t.match(/overgenomen na controle[^\n]*\n[^\n]*/) || [''])[0]);
  await click(r.page, '[data-act=set-tab][data-tab=rapport]');
  t = await r.page.evaluate(function () { return document.body.textContent; });   // afdrukrapport staat (verborgen) in de pagina
  check('12. rapport vermeldt dat de 3D-maten na controle zijn overgenomen en dat het model mogelijk niet correct is', /na controle door de gebruiker overgenomen; volgens de 3D BAG is het 3D-model van dit pand mogelijk niet correct/.test(t), (t.match(/Bouwgegevens[^\n]*/) || [''])[0].slice(0, 400));
  check('12. geen JavaScript-fouten', r.st.errors.length === 0, r.st.errors.join('; '));
  await r.ctx.close();

  // 13. Kwaliteitsindicator TRUE bij een nieuw gebouw: automatisch overgenomen (zie 1), geen overneemknop, herkomst bewaart true.
  r = await newPage(browser, { d3: ok(MALDENHOF, 0) });
  await kiesAdres(r);
  await waitStatus(r.page, ['OK'], 6000);
  w = await werk(r.page);
  check('13. kwaliteit true: in het plan gebruikt, geen voorstel en geen overneemknop', (await kwaliteit(r.page)) === 'GOED' && w.plan.building.d3 && !w.plan.building.d3voorstel && !(await r.page.$('[data-act=d3-overnemen]')) && !/controle nodig/.test(await text(r.page)));
  check('13. herkomst van een hoeveelheid bewaart quality_indicator true', JSON.stringify(elQ(w.plan, 'dakinspectie')).indexOf('"quality_indicator":true') > -1);
  await r.ctx.close();

  // 14. Kwaliteitsindicator ONTBREEKT: als onbekend behandeld (controle nodig), niet automatisch overgenomen.
  r = await newPage(browser, { d3: ok(MALDENHOF_ZONDER_KWALITEIT, 0) });
  await kiesAdres(r);
  planVoor = (await werk(r.page)).plan;
  await waitStatus(r.page, ['OK'], 6000);
  w = await werk(r.page); t = await text(r.page);
  check('14. kwaliteit ontbreekt: "controle nodig", uitleg dat de 3D BAG het niet aangeeft', (await kwaliteit(r.page)) === 'ONBEKEND' && /3D-model beschikbaar — controle nodig/.test(t) && /geeft niet aan of dit model betrouwbaar is/.test(t)
    && /b3_kwaliteitsindicator: ontbreekt/.test(await blokTekst(r.page)));
  check('14. kwaliteit ontbreekt: plan ongewijzigd, wel voorstel en overneemknop', JSON.stringify(w.plan.elements) === JSON.stringify(planVoor.elements) && !w.plan.building.d3 && w.plan.building.d3voorstel && !!(await r.page.$('[data-act=d3-overnemen]')));
  await click(r.page, '[data-act=d3-overnemen]');
  w = await werk(r.page);
  check('14. na overnemen: kwaliteitsindicator als onbekend (null) vastgelegd', w.plan.building.d3raw.overgenomen && w.plan.building.d3raw.overgenomen.b3_kwaliteitsindicator === null && w.plan.building.d3raw.overgenomen.kwaliteit === 'ONBEKEND');
  await r.ctx.close();

  // 15. Opslaan: 3D-status en -voorstel veroorzaken nooit zelf een (auto)save.
  // 15a. Nieuw gebouw: na de eerste autosave komt een voorstel (kwaliteit false) binnen -> geen extra schrijfactie.
  r = await newPage(browser, { d3: ok(SINGEL8, 3500) });
  await kiesAdres(r);
  await sleep(2800);
  var na1 = r.st.writes.length;
  await waitStatus(r.page, ['OK'], 6000); await sleep(3000);
  check('15a. nieuw gebouw: eerste autosave gebeurt; het latere 3D-voorstel veroorzaakt geen extra opslag', na1 === 1 && r.st.writes.length === na1, na1 + ' -> ' + r.st.writes.length);
  await r.ctx.close();
  // 15b. Opgeslagen project p1 openen en 3D opnieuw ophalen: status en voorstel wijzigen het opgeslagen project niet.
  r = await newPage(browser, { d3: ok(MALDENHOF, 0) });
  await r.page.goto(BASE + 'index.html'); await r.page.waitForTimeout(900);
  await r.page.evaluate(function () { var e = document.querySelector('[data-act=open-plan][data-id=p1]'); if (e) e.click(); }); await sleep(800);
  await click(r.page, '[data-act=set-tab][data-tab=gebouw]');
  var heeftKnop = !!(await r.page.$('[data-act=d3-opnieuw]'));
  await click(r.page, '[data-act=d3-opnieuw]');
  var okP1 = await waitStatus(r.page, ['OK'], 6000);
  await sleep(3200);
  w = await werk(r.page);
  check('15b. opgeslagen project: 3D opnieuw ophalen geeft een voorstel maar GEEN schrijfactie naar de database', heeftKnop && okP1 && w.currentPlanId === 'p1' && w.plan.building.d3voorstel && r.st.writes.length === 0,
    JSON.stringify([heeftKnop, okP1, w.currentPlanId, r.st.writes.map(function (x) { return x.method; })]));
  check('15b. opslagstatus blijft "Alles is opgeslagen"', !/Bezig met opslaan/.test(await text(r.page)));
  await click(r.page, '[data-act=d3-overnemen]');
  await sleep(3200);
  var patch = r.st.writes.filter(function (x) { return x.method === 'PATCH' && /id=eq\.p1/.test(x.url); });
  check('15b. pas na expliciet overnemen wordt het project bewaard, mét de overname-gegevens', patch.length === 1 && /"overgenomen"/.test(patch[0].body) && /"b3_kwaliteitsindicator":true/.test(patch[0].body), r.st.writes.length + ' ' + (patch[0] ? patch[0].body.slice(0, 120) : ''));
  await r.ctx.close();

  await browser.close();
  var failed = checks.filter(function (c) { return !c[1]; });
  checks.forEach(function (c) { console.log((c[1] ? 'OK   - ' : 'FAIL - ') + c[0] + (c[1] ? '' : ' [' + c[2] + ']')); });
  console.log(failed.length ? failed.length + ' controle(s) mislukt.' : 'Alle controles geslaagd.');
  process.exit(failed.length ? 1 : 0);
}
main().catch(function (e) { console.error(e); process.exit(2); });
