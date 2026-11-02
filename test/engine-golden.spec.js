'use strict';
// GOLDEN MASTER van de bestaande MJOP-rekenlogica (stap 0 van de gedeelde rekenkern; zie docs/engine-golden-master.md).
//
// Doel: de uitkomsten van de HUIDIGE berekeningen vastleggen vóór er ook maar iets wordt losgekoppeld of verplaatst, zodat later exact bewezen kan
// worden dat de uitkomsten gelijk blijven. Dit bestand verandert niets aan src/: de echte website wordt in een browser geladen en tijdens de test
// wordt een meetpunt in de broncode van app.js ingevoegd (alleen in het geheugen, via een request-onderschepping), om bij de privéfuncties te komen.
//
// Vastgezet voor herhaalbaarheid: de klok (Date) staat op een vaste datum, het netwerk is uit (de CBS-indexering mislukt dus en de vaste terugval van
// 3% per jaar geldt), geen opgeslagen sessie. Elke uitkomst wordt als tekst op de letter vergeleken (geen tolerantie).
//
//   python3 -m http.server 8969 &  ;  node test/engine-golden.spec.js              (vergelijken met de opgeslagen uitkomsten)
//   GOLDEN_UPDATE=1 node test/engine-golden.spec.js                                (alleen bewust: opnieuw vastleggen; nooit in CI)
let chromium;
try { chromium = require('playwright').chromium; } catch (e) { chromium = require('/opt/node22/lib/node_modules/playwright').chromium; }
var fs = require('fs'), path = require('path');
var BASE = process.env.MJOP_TEST_BASE || 'http://localhost:8969/';
var CHROMIUM_PATH = process.env.MJOP_CHROMIUM || '/opt/pw-browsers/chromium';
var UPDATE = process.env.GOLDEN_UPDATE === '1';
var GOLDEN_DIR = path.join(__dirname, 'golden', 'engine_v0');
var FIXED_NOW = '2026-06-15T12:00:00.000Z';      // vaste "nu": jaar 2026, horizon 2026-2035
var APP_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');

// Het meetpunt komt vlak vóór het sluiten van de IIFE in app.js. Er wordt niets aan de berekeningen veranderd; het geeft alleen toegang.
var HOOK = [
  ';window.__golden = (function () {',
  '  function plain(x) { return JSON.parse(JSON.stringify(x === undefined ? null : x)); }',
  '  return {',
  '    api: { Q: Q, defaultBuilding: defaultBuilding, buildDefaultElements: buildDefaultElements, instantiateLibraryEl: instantiateLibraryEl,',
  '           ELEMENT_LIBRARY: ELEMENT_LIBRARY, KOZ_MATERIAAL: KOZ_MATERIAAL, qv: qv },',
  '    apply: function (blob) { applyPlanBlob(JSON.parse(JSON.stringify(blob))); },',
  '    run: function () {',
  '      var s = state, out = {};',
  '      out.pinned = { nowIso: new Date().toISOString(), currentYear: CURRENT_YEAR, horizon: HORIZON, cbsIndexatie: plain(cbsIndexatie), indexatiePct: INDEXATIE_PCT };',
  '      out.input = { building: plain(s.building), fonds: s.fonds, bijdrage: s.bijdrage, elementCount: s.elements.length };',
  '      out.elements = s.elements.map(function (el) {',
  '        return { id: el.id, naam: el.naam, type: el.type, categorie: el.categorie, quantity: qv(el), cost: elementCost(el, s),',
  '                 conditionScore: conditionScore(el), conditionYear: el.type === "kozijnen" ? null : conditionYear(el),',
  '                 kozijnGroepen: el.type === "kozijnen" ? plain(kozGroepen(el)) : null, schedule: plain(scheduleFor(el, s)), meta: elementMeta(el) };',
  '      });',
  '      out.fullPlan = plain(fullPlan(s)); out.categorieTotalen = plain(categorieTotalen(s)); out.perJaarKosten = plain(perJaarKosten(s));',
  '      out.kasstroom = plain(kasstroom(s)); out.benodigdeBijdrage = benodigdeBijdrage(s);',
  '      out.kostenOnbekend = costUnknownElements(s).map(function (e) { return e.id; });',
  '      out.offertes = {};',
  '      Object.keys(s.offertes || {}).forEach(function (elId) {',
  '        out.offertes[elId] = s.offertes[elId].map(function (o) { return { id: o.id, bedragen: plain(offerteBedragen(o)), totaal: offerteTotal(o) }; });',
  '      });',
  '      out.bibliotheekAuto = ELEMENT_LIBRARY.map(function (d) { return { key: d.key, auto: plain(autoForEl(d, s.building)) }; });',
  '      return out;',
  '    },',
  '  };',
  '})();',
].join('\n');

function instrumentedSource(mutation) {
  var src = APP_SOURCE;
  if (mutation) {                                   // alleen voor de zelftest hieronder, in het geheugen: nooit naar schijf
    if (src.split(mutation.from).length !== 2) throw new Error('zelftest-mutatie "' + mutation.name + '": de te veranderen tekst komt niet precies één keer voor in src/app.js');
    src = src.replace(mutation.from, mutation.to);
  }
  var i = src.lastIndexOf('})();');
  if (i < 0) throw new Error('src/app.js eindigt niet meer op "})();": pas de plek van het meetpunt aan (de golden-master blijft ongewijzigd)');
  return src.slice(0, i) + HOOK + '\n' + src.slice(i);
}

// Zelftest: bewust (in het geheugen) veranderde berekeningen MOETEN door de golden master worden opgemerkt, anders meet de test niets.
var MUTATIONS = [
  { name: 'indexeringspercentage 3% -> 3,1%', from: 'var INDEXATIE_PCT = 0.03;', to: 'var INDEXATIE_PCT = 0.031;' },
  { name: 'kozijntarief afronden: round -> floor', from: 'return k.eigenTarief != null ? k.eigenTarief : Math.round(k.tarief * mat.factor);', to: 'return k.eigenTarief != null ? k.eigenTarief : Math.floor(k.tarief * mat.factor);' },
  { name: 'benodigde bijdrage: stap 5 -> 10 euro', from: 'bijdrage += 5;', to: 'bijdrage += 10;' },
];

// ---------------------------------------------------------------------------------------------------------------------------------
// Scenario's. Elke functie krijgt de hulpmiddelen van het meetpunt (G) en geeft een plan zoals het in saved_plans.state staat.
// Alleen synthetische, door ons verzonnen testgebouwen; er is nergens productiedata gebruikt.
// ---------------------------------------------------------------------------------------------------------------------------------
function base(G, over, extraOptional) {
  var b = Object.assign(G.api.defaultBuilding(), over || {});
  var els = G.api.buildDefaultElements(b);
  if (extraOptional) G.api.ELEMENT_LIBRARY.filter(function (d) { return d.optioneel; }).forEach(function (d) { els.push(G.api.instantiateLibraryEl(d, b)); });
  return { building: b, elements: els, fonds: 0, bijdrage: 55, invul: { fonds: false, bijdrage: false }, offertes: {}, bijvullen: {} };
}
function byId(p, id) { return p.elements.filter(function (e) { return e.id === id; })[0]; }

var SCENARIOS = [
  { name: '01_voorbeeld_standaard', build: function (G) { return base(G); } },
  { name: '02_voorbeeld_fonds_en_bijdrage', build: function (G) { var p = base(G); p.fonds = 42000; p.bijdrage = 70; p.invul = { fonds: true, bijdrage: true }; return p; } },
  { name: '03_groot_complex_alle_posten', build: function (G) {
    var p = base(G, { adres: 'Testcomplex A', bouwjaar: 1965, units: 48, unitsBron: 48, dakM2: 900, gevelM2: 1800, werkhoogte: 18, opp: 900, omtrek: 180, isVoorbeeld: false }, true);
    p.fonds = 120000; p.bijdrage = 95; p.invul = { fonds: true, bijdrage: true }; return p; } },
  { name: '04_klein_pand_nieuwbouw', build: function (G) {
    var p = base(G, { adres: 'Testpand B', bouwjaar: 2005, units: 4, unitsBron: 4, dakM2: 60, gevelM2: 90, werkhoogte: 6, opp: 60, omtrek: 32, isVoorbeeld: false });
    p.fonds = 5000; p.bijdrage = 35; p.invul = { fonds: true, bijdrage: true }; return p; } },
  { name: '05_gebreken_en_conditiescores', build: function (G) {
    var p = base(G); p.fonds = 20000; p.bijdrage = 60; p.invul = { fonds: true, bijdrage: true };
    byId(p, 'dak-plat').gebreken = [{ omschrijving: 'Blaasvorming', ernst: 3, omvang: 3, intensiteit: 3 }];
    byId(p, 'gevel-metselwerk').gebreken = [{ omschrijving: 'Voegen los', ernst: 2, omvang: 1, intensiteit: 1 }, { omschrijving: 'Scheur', ernst: 2, omvang: 2, intensiteit: 3 }];
    byId(p, 'schilderwerk-buiten').gebreken = [{ omschrijving: 'Afbladdering', ernst: 1, omvang: 2, intensiteit: 1 }];
    byId(p, 'kozijnen-onderhoud').gebreken = [{ omschrijving: 'Houtrot', ernst: 3, omvang: 2, intensiteit: 2 }];
    return p; } },
  { name: '06_handmatige_en_onbekende_hoeveelheden', build: function (G) {
    var p = base(G); p.fonds = 15000; p.bijdrage = 50; p.invul = { fonds: true, bijdrage: true };
    G.api.Q.override(byId(p, 'dakgoten').quantity, 777);
    G.api.Q.override(byId(p, 'intercom').quantity, 14);
    byId(p, 'gevel-metselwerk').quantity = G.api.Q.create(G.api.Q.unavailableQuantity('m2', 'Onbekend in test'));
    G.api.Q.override(byId(p, 'kozijnen-onderhoud').koz[1].quantity, 31);
    return p; } },
  { name: '07_kozijnmaterialen_en_eigen_tarief', build: function (G) {
    var p = base(G); p.fonds = 30000; p.bijdrage = 65; p.invul = { fonds: true, bijdrage: true };
    var k = byId(p, 'kozijnen-onderhoud').koz;
    k[0].materiaal = 'aluminium'; k[1].materiaal = 'kunststof'; k[2].materiaal = 'staal'; k[3].eigenTarief = 410;
    G.api.Q.override(k[0].quantity, 12); G.api.Q.override(k[2].quantity, 3);
    return p; } },
  { name: '08_steiger_werkhoogte_onbekend', build: function (G) {
    var p = base(G, { werkhoogte: null }); byId(p, 'steiger').werkhoogte = null; p.fonds = 10000; p.bijdrage = 45; p.invul = { fonds: true, bijdrage: true }; return p; } },
  { name: '09_steiger_hoog_gebouw', build: function (G) {
    var p = base(G, { adres: 'Testtoren C', units: 60, unitsBron: 60, dakM2: 700, gevelM2: 4200, werkhoogte: 27, isVoorbeeld: false }); p.fonds = 80000; p.bijdrage = 90; p.invul = { fonds: true, bijdrage: true }; return p; } },
  { name: '10_eigen_posten_met_indexering', build: function (G) {
    var p = base(G); p.fonds = 25000; p.bijdrage = 55; p.invul = { fonds: true, bijdrage: true };
    p.elements.push({ id: 'custom-a', naam: 'Liftrenovatie (import)', categorie: 'Installaties', type: 'custom', cyclus: 0, jaar: 2028, bedrag: 18500, basisjaar: 2022, gebreken: [], metaTekst: 'geïmporteerd' });
    p.elements.push({ id: 'custom-b', naam: 'Herhalend onderhoud (import)', categorie: 'Gevel', type: 'custom', cyclus: 12, jaar: 2027, bedrag: 6200, basisjaar: 2019, gebreken: [], metaTekst: 'geïmporteerd' });
    p.elements.push({ id: 'custom-c', naam: 'Eenmalig zonder prijspeil', categorie: 'Binnen', type: 'custom', cyclus: 0, jaar: 2031, bedrag: 4100, gebreken: [], metaTekst: 'handmatig toegevoegd' });
    p.elements.push({ id: 'custom-d', naam: 'Buiten de horizon', categorie: 'Binnen', type: 'custom', cyclus: 0, jaar: 2040, bedrag: 9900, basisjaar: 2020, gebreken: [], metaTekst: 'geïmporteerd' });
    return p; } },
  { name: '11_offertes', build: function (G) {
    var p = base(G); p.fonds = 9000; p.bijdrage = 40; p.invul = { fonds: true, bijdrage: true };
    p.offertes = { 'schilderwerk-buiten': [
      { id: 'o1', naam: 'Schildersbedrijf A', btw: true, regels: [{ naam: 'Schilderwerk', bedrag: '12.500,50' }, { naam: 'Steiger', bedrag: '3.200' }] },
      { id: 'o2', naam: 'Schildersbedrijf B', btw: false, regels: [{ naam: 'Totaal', bedrag: '14000' }] },
      { id: 'o3', naam: 'Dubbelzinnig', btw: false, regels: [{ naam: 'Regel 1', bedrag: '1.250' }, { naam: 'Regel 2', bedrag: '300,5' }, { naam: 'Regel 3', bedrag: 'n.v.t.' }] },
    ] };
    p.bijvullen = { 'schilderwerk-buiten': true };
    return p; } },
  { name: '12_oud_plan_zonder_hoeveelheidsobject', build: function (G) {
    // Plannen van vóór Quantity Foundation v1 hebben alleen el.hoeveelheid / k.aantal; ze moeten bij openen ongewijzigd doorgerekend worden.
    var p = base(G); p.fonds = 33000; p.bijdrage = 58; p.invul = { fonds: true, bijdrage: true };
    p.elements.forEach(function (el) {
      if (el.quantity) { el.hoeveelheid = G.api.qv(el) == null ? 0 : G.api.qv(el); delete el.quantity; }
      if (el.koz) el.koz.forEach(function (k) { k.aantal = k.quantity && k.quantity.value != null ? k.quantity.value : 0; delete k.quantity; });
    });
    return p; } },
];

function firstDifference(a, b, p) {
  p = p || '';
  if (JSON.stringify(a) === JSON.stringify(b)) return null;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    var keys = Object.keys(Object.assign({}, a, b));
    for (var i = 0; i < keys.length; i++) {
      var d = firstDifference(a[keys[i]], b[keys[i]], p + (Array.isArray(a) ? '[' + keys[i] + ']' : '.' + keys[i]));
      if (d) return d;
    }
  }
  return p + ': ' + JSON.stringify(a) + '  !=  ' + JSON.stringify(b);
}

async function openPage(browser, mutation) {
  var ctx = await browser.newContext({ viewport: { width: 375, height: 667 }, locale: 'nl-NL', timezoneId: 'Europe/Amsterdam' });
  var page = await ctx.newPage(), errors = [];
  page.on('pageerror', function (e) { errors.push(String(e)); });
  await page.addInitScript('(' + function (iso) {
    var Real = Date, fixed = new Real(iso).getTime();
    function Fake() { var a = arguments; if (!(this instanceof Fake)) return new Real(fixed).toString(); return a.length === 0 ? new Real(fixed) : new (Function.prototype.bind.apply(Real, [null].concat([].slice.call(a))))(); }
    Fake.prototype = Real.prototype; Fake.now = function () { return fixed; }; Fake.UTC = Real.UTC; Fake.parse = Real.parse;
    window.Date = Fake;
  }.toString() + ')(' + JSON.stringify(FIXED_NOW) + ')');
  await page.route(/^https?:\/\/(?!localhost)/, function (r) { return r.abort(); });            // geen netwerk: CBS-indexering valt terug op 3%
  await page.route('**/src/app.js', function (r) { return r.fulfill({ status: 200, contentType: 'application/javascript', body: instrumentedSource(mutation) }); });
  await page.goto(BASE + 'index.html'); await page.waitForTimeout(500);
  var ok = await page.evaluate(function () { return !!(window.__golden && window.__golden.run); });
  if (!ok) throw new Error('meetpunt niet geladen');
  return { page: page, ctx: ctx, errors: errors };
}

async function runScenario(page, sc) {
  return page.evaluate(function (src) {
    var G = window.__golden, build = (0, eval)(src);
    var blob = build(G);
    G.apply(blob);
    var first = G.run();
    var second = G.run();                                   // dezelfde staat nogmaals: rekenen mag niets in de staat veranderen
    return { first: first, idempotent: JSON.stringify(first) === JSON.stringify(second) };
  }, '(function () { var base = ' + base.toString() + '; var byId = ' + byId.toString() + '; return ' + sc.build.toString() + '; })()');
}

async function main() {
  var checks = [];
  function check(n, ok, d) { checks.push([n, !!ok, d]); }
  fs.mkdirSync(GOLDEN_DIR, { recursive: true });
  var browser = await chromium.launch({ executablePath: CHROMIUM_PATH });
  var A = await openPage(browser), B = await openPage(browser);
  var clockA = await A.page.evaluate(function () { return { iso: new Date().toISOString(), year: new Date().getFullYear(), now: Date.now() }; });
  check('0. de klok staat vast op ' + FIXED_NOW + ' (jaar 2026)', clockA.iso === FIXED_NOW && clockA.year === 2026 && clockA.now === new Date(FIXED_NOW).getTime(), JSON.stringify(clockA));
  for (var i = 0; i < SCENARIOS.length; i++) {
    var sc = SCENARIOS[i];
    var ra = await runScenario(A.page, sc), rb = await runScenario(B.page, sc);
    var text = JSON.stringify(ra.first, null, 2) + '\n';
    check(sc.name + ': rekenen verandert de staat niet (twee keer dezelfde uitkomst)', ra.idempotent);
    check(sc.name + ': twee onafhankelijke paginaladingen geven exact dezelfde uitkomst', JSON.stringify(ra.first) === JSON.stringify(rb.first), firstDifference(ra.first, rb.first));
    check(sc.name + ': vaste klok en vaste indexering (jaar 2026, geen CBS-waarde)', ra.first.pinned.currentYear === 2026 && ra.first.pinned.cbsIndexatie === null && ra.first.pinned.indexatiePct === 0.03, JSON.stringify(ra.first.pinned));
    var file = path.join(GOLDEN_DIR, sc.name + '.json');
    if (UPDATE) { fs.writeFileSync(file, text); check(sc.name + ': opnieuw vastgelegd (GOLDEN_UPDATE=1)', true); continue; }
    if (!fs.existsSync(file)) { check(sc.name + ': opgeslagen uitkomst aanwezig', false, file + ' ontbreekt'); continue; }
    var stored = fs.readFileSync(file, 'utf8');
    check(sc.name + ': uitkomst is op de letter gelijk aan de golden master', stored === text, firstDifference(JSON.parse(stored), ra.first));
  }
  check('geen JavaScript-fouten in de pagina', A.errors.length === 0 && B.errors.length === 0, A.errors.concat(B.errors).join('; '));

  if (!UPDATE) {
    for (var m = 0; m < MUTATIONS.length; m++) {
      var M = await openPage(browser, MUTATIONS[m]), differing = [];
      for (var k = 0; k < SCENARIOS.length; k++) {
        var rm = await runScenario(M.page, SCENARIOS[k]);
        var storedText = fs.readFileSync(path.join(GOLDEN_DIR, SCENARIOS[k].name + '.json'), 'utf8');
        if (JSON.stringify(rm.first, null, 2) + '\n' !== storedText) differing.push(SCENARIOS[k].name);
      }
      check('zelftest: een veranderde berekening wordt opgemerkt (' + MUTATIONS[m].name + ')', differing.length > 0, 'de golden master merkte niets');
      await M.ctx.close();
    }
  }
  await browser.close();
  var failed = checks.filter(function (c) { return !c[1]; });
  checks.forEach(function (c) { console.log((c[1] ? 'OK   - ' : 'FAIL - ') + c[0] + (c[1] ? '' : ' [' + c[2] + ']')); });
  console.log(failed.length ? failed.length + ' controle(s) mislukt.' : 'Alle controles geslaagd.');
  process.exit(failed.length ? 1 : 0);
}
main().catch(function (e) { console.error(e); process.exit(2); });
