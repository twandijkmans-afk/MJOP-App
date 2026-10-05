'use strict';
// Browsertest: Facade Quantity Semantics v1.
//
//   A/B/C  gevel-metselwerk en voegwerk tonen het bruto 3D BAG-buitenmuuroppervlak als BENADERING (ESTIMATED,
//          'Schatting', 'Benadering: …'), net als schilderwerk-buiten; kosten numeriek ongewijzigd; een opgeslagen
//          plan van vóór de markering krijgt het juiste label zonder dat waarde of kosten veranderen.
//   D      steiger, één pand: 'Bruto buitenmuuroppervlak' uit 3D BAG × tarief van de eigen werkhoogte.
//   E/F/G  steiger met een (synthetische, test-)bundel over 3 panden: één tariefklasse -> scopetotaal × tarief;
//          verschillende tariefklassen -> per pand met eigen werkhoogte, exact de som van de pandkosten.
//   H      ontbrekende werkhoogte (plan of pand): kosten onbekend, nooit € 0 of een willekeurige 9 m.
//   I      handmatige hoeveelheid blijft mogelijk.
//   J      opslaan/herladen behoudt keuze en prijscontext.
// PDOK/BAG/3D BAG worden nagebootst: geen netwerkcalls.
//
//   python3 -m http.server 8937 &   ;   node test/facade-scaffold.spec.js

let chromium;
try {
  chromium = require('playwright').chromium;
} catch (e) {
  chromium = require('/opt/node22/lib/node_modules/playwright').chromium;
}

var APP_URL = process.env.MJOP_TEST_URL || 'http://localhost:8937/index.html';
var CHROMIUM_PATH = process.env.MJOP_CHROMIUM || '/opt/pw-browsers/chromium';
var PAND_ID = '0363100012345678';
var LON = 4.9, LAT = 52.37, D = 0.0001;
var ATTRS = { b3_opp_dak_plat: 312.64, b3_opp_dak_schuin: 0, b3_opp_buitenmuur: 1099.7, b3_opp_grond: 318.2, b3_bouwlagen: 4,
  b3_dak_type: 'horizontal', b3_h_dak_max: 13.4, b3_h_maaiveld: 0.6 };   // hoogte 12,8 m -> werkhoogte 13 m -> € 11
var SCOPE = [PAND_ID, '0363100012345679', '0363100012345680'];

async function mockApis(page, attrs) {
  await page.route(/^https?:\/\/(?!localhost)/, function (route) { route.abort(); });
  await page.route('**/locatieserver/search/v3_1/suggest**', function (route) {
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ response: { docs: [{ id: 'adr-1', weergavenaam: 'Teststraat 1, 1000AA Amsterdam' }] } }) });
  });
  await page.route('**/locatieserver/search/v3_1/lookup**', function (route) {
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ response: { docs: [{ weergavenaam: 'Teststraat 1, 1000AA Amsterdam', centroide_ll: 'POINT(' + LON + ' ' + LAT + ')' }] } }) });
  });
  await page.route('**/kadaster/bag/ogc/v2/collections/pand/items**', function (route) {
    var ring = [[LON - D, LAT - D], [LON + D, LAT - D], [LON + D, LAT + D], [LON - D, LAT + D], [LON - D, LAT - D]];
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ features: [{ geometry: { type: 'Polygon', coordinates: [ring] },
      properties: { identificatie: PAND_ID, bouwjaar: 1972, gebruiksdoel: 'woonfunctie', aantal_verblijfsobjecten: 12 } }] }) });
  });
  await page.route('**/api.3dbag.nl/**', function (route) {
    var co = {};
    co['NL.IMBAG.Pand.' + PAND_ID] = { attributes: attrs };
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ feature: { CityObjects: co } }) });
  });
}

// Synthetische v3-bundel (testdata, geen echte VvE): steiger-som over 3 panden met per-pand BUILDING_HEIGHT-context.
function scaffoldBundle(tag, areas, heights) {
  var total = areas.reduce(function (s, a) { return s + Math.round(a * 100); }, 0) / 100;
  var bid = 'BAG:' + SCOPE.slice().sort().join('+');
  return JSON.stringify({
    bundle_version: 'mjop_app_quantity_bundle_v3', building_id: bid, bag_pand_ids: SCOPE.slice().sort(),
    building_scope: { building_id: bid, kind: 'MULTI_PAND_SCOPE', bag_pand_ids: SCOPE.slice().sort(), pand_count: 3 },
    entries: [{
      app_element_key: 'steiger', crosswalk_mapping_id: 'XQ-steiger-OUTER_WALL_GROSS_AREA-m2', crosswalk_decision_id: 'XWD-TEST',
      subject_key: 'OUTER_WALL_GROSS_AREA', role: 'PRIMARY', selectable: true, subject_label_nl: 'Buitenmuuroppervlak bruto (openingen niet afgetrokken)',
      evidence: { evidence_id: 'QE-' + tag + '-SCOPE', source_type: '3D_BAG', method_class: 'GEOMETRY_DERIVED', value: total.toFixed(2), unit: 'm2',
        status: 'PROPOSED', review_reasons: [], scope_caveats: [], source_ref: { rule_id: 'scope.sum_over_confirmed_panden' },
        scope_level: 'COMPLEX', aggregation: 'SUM', formula: 'SUM(child OUTER_WALL_GROSS_AREA)',
        components: SCOPE.map(function (p, i) { return { bag_pand_id: p, value: areas[i].toFixed(2), unit: 'm2', evidence_id: 'QE-' + tag + '-W' + i,
          method_class: 'DIRECT_MEASURED', rule_id: 'bag3d.outer_wall_gross_area' }; }) },
      pricing_context: { purpose: 'SCAFFOLD_WORK_HEIGHT', context_subject_key: 'BUILDING_HEIGHT',
        rows: SCOPE.map(function (p, i) {
          return { bag_pand_id: p, quantity_evidence_id: 'QE-' + tag + '-W' + i, context_evidence_id: heights[i] == null ? null : 'QE-' + tag + '-H' + i,
            value: heights[i] == null ? null : String(heights[i]), unit: 'm', status: heights[i] == null ? 'MISSING' : 'AVAILABLE' };
        }) },
    }],
  });
}

async function tab(page, naam) { await page.click('[data-act=set-tab][data-tab=' + naam + ']'); await page.waitForTimeout(120); }
async function openEl(page, id) { await tab(page, 'gebouw'); await page.click('.gb-row[data-act=open-element][data-id=' + id + ']'); await page.waitForTimeout(120); }

async function startPlan(page) {
  await page.goto(APP_URL);
  await page.waitForTimeout(150);
  await page.click('[data-act=goto-onboarding]').catch(function () {});
  await page.waitForTimeout(150);
  await page.fill('#addr-search', 'Teststraat 1');
  await page.waitForSelector('.suggest-row', { timeout: 5000 });
  await page.click('.suggest-row');
  await page.waitForSelector('[data-act=set-tab][data-tab=gebouw]', { timeout: 8000 });
}

async function row(page, id) {
  await tab(page, 'gebouw');
  return page.evaluate(function (id) {
    var r = document.querySelector('.gb-row[data-id="' + id + '"]');
    if (!r) return null;
    var c = r.querySelector('.gb-cell-bedrag');
    return { bedrag: c.textContent, unknown: c.hasAttribute('data-cost-unknown'), meta: (r.querySelector('.gb-post-meta') || {}).textContent || '' };
  }, id);
}

async function panel(page) {
  return page.evaluate(function () {
    var p = document.querySelector('.qty-panel');
    var inp = p && p.querySelector('input[data-change=qty-input]');
    var f = document.querySelector('[data-qty-formula]');
    var sp = document.querySelector('[data-steiger-pricing]');
    return { status: p && p.dataset.qtyStatus, source: p && p.dataset.qtySource,
      label: (p && p.querySelector('label') || {}).textContent || '',
      sourceLabel: (document.querySelector('[data-qty-source-label]') || {}).textContent || '',
      value: inp && inp.value, hint: (p && p.querySelector('.hint') || {}).textContent || '',
      formula: f ? f.textContent : '', formulaUnknown: !!(f && f.hasAttribute('data-cost-unknown')),
      mode: sp && sp.dataset.steigerPricing, reason: sp && sp.dataset.steigerReason, note: (document.querySelector('[data-steiger-note]') || {}).textContent || '',
      whInput: !!document.querySelector('input[data-change=el-werkhoogte]'), whValue: (document.querySelector('input[data-change=el-werkhoogte]') || {}).value,
      rows: Array.prototype.map.call(document.querySelectorAll('[data-steiger-row]'), function (r) { return { pand: r.dataset.steigerRow, band: r.dataset.band, text: r.textContent }; }),
      bagRows: Array.prototype.map.call(document.querySelectorAll('[data-qty-source-row]'), function (r) { return { id: r.dataset.qtySourceRow, source: r.dataset.source, label: (r.querySelector('[data-qty-source-label]') || {}).textContent }; }) };
  });
}

async function upload(page, text) {
  await tab(page, 'gebouw');
  await page.setInputFiles('#qty-bundle-input', { name: 'b.json', mimeType: 'application/json', buffer: Buffer.from(text, 'utf8') });
  await page.waitForTimeout(250);
  return page.evaluate(function () { return ((document.querySelector('[data-bundle-melding]') || {}).textContent || '') + ((document.querySelector('[data-bundle-fout]') || {}).textContent || ''); });
}

async function selectScope(page) {
  var p = await panel(page);
  var som = p.bagRows.filter(function (r) { return r.source === '3D_BAG' && r.id !== 'auto'; })[0];
  await page.click('[data-act=qty-select][data-ev="' + som.id + '"]');
  await page.waitForTimeout(150);
  return panel(page);
}

function eurTxt(n) { return '€ ' + Math.round(n).toLocaleString('nl-NL'); }

async function main() {
  var browser = await chromium.launch({ executablePath: CHROMIUM_PATH });
  var errors = [];
  var checks = [];
  function check(naam, ok, info) { checks.push([naam + (info ? ' (' + info + ')' : ''), !!ok]); }
  async function newPage(attrs) {
    var ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } });
    var page = await ctx.newPage();
    page.setDefaultTimeout(8000);
    page.on('pageerror', function (e) { errors.push(String(e)); });
    await mockApis(page, attrs);
    return { ctx: ctx, page: page };
  }

  // ---------------- A/B/C: gevel-metselwerk, voegwerk, schilderwerk-buiten ----------------
  var a = await newPage(ATTRS), page = a.page;
  await startPlan(page);
  await tab(page, 'gebouw');
  await page.click('[data-act=open-add-element]');
  await page.waitForTimeout(120);
  await page.click('[data-act=add-from-library][data-key=voegwerk]');
  await page.waitForTimeout(150);
  var kengetal = { 'gevel-metselwerk': 26, voegwerk: 45, 'schilderwerk-buiten': 22 };
  var kostenNa = {};
  for (var key of ['gevel-metselwerk', 'voegwerk', 'schilderwerk-buiten']) {
    await openEl(page, key);
    var p = await panel(page);
    var letter = { 'gevel-metselwerk': 'A', voegwerk: 'B', 'schilderwerk-buiten': 'C' }[key];
    check(letter + '. ' + key + ': bruto 3D BAG-getal 1.099,7 m² als benadering (ESTIMATED, "Schatting", "Benadering: …")',
      p.value === '1.099,7' && p.source === 'ESTIMATED' && p.sourceLabel === 'Schatting' && /^Benadering: het hele buitenmuuroppervlak uit 3D BAG \(bruto, incl\. ramen\)/.test(p.hint),
      JSON.stringify({ v: p.value, s: p.source, l: p.sourceLabel }));
    check(letter + '2. ' + key + ': niet als exacte 3D BAG-meting gepresenteerd', p.source !== '3D_BAG' && !/^Buitenmuuroppervlak uit het 3D BAG-model/.test(p.hint));
    var r = await row(page, key);
    kostenNa[key] = r.bedrag;
    check(letter + '3. ' + key + ': kosten = 1.099,7 × € ' + kengetal[key] + ' (numeriek ongewijzigd)', r.bedrag.indexOf(eurTxt(1099.7 * kengetal[key])) !== -1, r.bedrag);
  }

  // Opgeslagen plan van vóór de markering: gevel-metselwerk met auto-bron '3D_BAG' -> label wordt Schatting, waarde/kosten gelijk
  var blob = await page.evaluate(function () {
    var ws = JSON.parse(sessionStorage.getItem('mjop-worksessie'));
    ws.plan.elements.forEach(function (el) {
      if (el.id === 'gevel-metselwerk' || el.id === 'voegwerk') {
        el.quantity.auto.source = '3D_BAG';
        el.quantity.auto.basis = 'Buitenmuuroppervlak uit het 3D BAG-model (b3_opp_buitenmuur, bruto: ramen en deuren niet afgetrokken).';
        el.quantity.source = '3D_BAG';
      }
    });
    return ws.plan;
  });
  var o = await newPage(ATTRS);
  await o.page.goto(APP_URL);
  await o.page.evaluate(function (blob) {
    sessionStorage.setItem('mjop-worksessie', JSON.stringify({ screen: 'app', tab: 'gebouw', currentPlanId: null, lastSavedSnapshot: null, plan: blob }));
  }, blob);
  await o.page.reload();
  await o.page.waitForTimeout(300);
  for (var k2 of ['gevel-metselwerk', 'voegwerk']) {
    await openEl(o.page, k2);
    var po = await panel(o.page);
    var ro = await row(o.page, k2);
    check('Oud opgeslagen plan: ' + k2 + ' wordt benadering (ESTIMATED), zelfde 1.099,7 en zelfde kosten', po.source === 'ESTIMATED' && po.value === '1.099,7' &&
      /^Benadering/.test(po.hint) && ro.bedrag === kostenNa[k2], JSON.stringify({ s: po.source, b: ro.bedrag }));
  }
  await o.ctx.close();

  // ---------------- D: steiger, één pand ----------------
  await openEl(page, 'steiger');
  p = await panel(page);
  check('D. steiger: "Bruto buitenmuuroppervlak" 1.099,7 m² uit 3D BAG (geen schatting)', /^Bruto buitenmuuroppervlak/.test(p.label) && p.value === '1.099,7' &&
    p.source === '3D_BAG' && p.sourceLabel === '3D BAG', p.label + ' / ' + p.sourceLabel);
  check('D2. werkhoogte 13 m (12,8 m gebouwhoogte) -> € 11: 1.099,7 × € 11 = ' + eurTxt(1099.7 * 11), p.mode === 'PAND' && p.whValue === '13' &&
    p.formula === '1.099,7 m² × € 11 = ' + eurTxt(1099.7 * 11) + ' per keer', p.formula);
  await page.fill('#wh-steiger', '7');
  await page.press('#wh-steiger', 'Tab');
  await page.waitForTimeout(150);
  p = await panel(page);
  check('D3. werkhoogte zelf aanpassen (7 m) -> € 6', p.formula === '1.099,7 m² × € 6 = ' + eurTxt(1099.7 * 6) + ' per keer', p.formula);
  await page.fill('#wh-steiger', '13');
  await page.press('#wh-steiger', 'Tab');
  await page.waitForTimeout(150);

  // ---------------- F/G: scope met verschillende tariefklassen ----------------
  var areas = [1099.7, 197.42, 116.45], heights = [12.8, 6.5, 8.46];   // 13 m, 7 m (€ 6), 8,5 -> 9 m (€ 11)
  var m = await upload(page, scaffoldBundle('MIX', areas, heights));
  check('Synthetische scope-bundel geïmporteerd (1 bron, VvE-scope van 3 panden)', /^1 bron toegevoegd/.test(m) && /VvE-scope van 3 panden/.test(m), m);
  await openEl(page, 'steiger');
  p = await selectScope(page);
  var cents = Math.round(1099.7 * 100) * 11 + Math.round(197.42 * 100) * 6 + Math.round(116.45 * 100) * 11;
  check('F. verschillende tariefklassen: per pand (geen één-tarief-berekening, geen werkhoogte-invoer voor de scope)', p.mode === 'SCOPE_PER_PAND' && !p.whInput &&
    /^Kosten per pand berekend op basis van eigen werkhoogte\./.test(p.note) && !/× € 11 =|× € 6 =/.test(p.formula), p.formula);
  check('G. mixed-band: kosten exact de som van de pandkosten (' + eurTxt(cents / 100) + ')', p.formula === 'Som per pand = ' + eurTxt(cents / 100) + ' per keer' &&
    p.formula !== 'Som per pand = ' + eurTxt(1413.57 * 11) + ' per keer', p.formula);
  check('G2. 3 pandregels met eigen werkhoogte en tariefklasse', p.rows.length === 3 &&
    JSON.stringify(p.rows.map(function (r) { return r.band; })) === JSON.stringify(['GT_8M', 'LE_8M', 'GT_8M']) &&
    /werkhoogte 7 m · € 6\/m² = € 1\.184,52$/.test(p.rows[1].text), p.rows.map(function (r) { return r.text; }).join(' | '));
  var gr = await row(page, 'steiger');
  check('G3. Gebouw-lijst: steigerkosten = som per pand, meta "werkhoogte per pand"', gr.bedrag.indexOf(eurTxt(cents / 100)) !== -1 && /werkhoogte per pand \(3 panden\)/.test(gr.meta), gr.bedrag + ' / ' + gr.meta);

  // ---------------- J: opslaan/herladen ----------------
  await page.reload();
  await page.waitForTimeout(300);
  await openEl(page, 'steiger');
  p = await panel(page);
  check('J. Na herladen: keuze, per-pand-berekening en 3 pandregels blijven', p.status === 'CONFIRMED' && p.mode === 'SCOPE_PER_PAND' && p.rows.length === 3 &&
    p.formula === 'Som per pand = ' + eurTxt(cents / 100) + ' per keer', p.formula);

  // ---------------- I: handmatige hoeveelheid ----------------
  await page.fill('#hv-steiger', '500');
  await page.press('#hv-steiger', 'Tab');
  await page.waitForTimeout(150);
  p = await panel(page);
  check('I. handmatige hoeveelheid blijft mogelijk: 500 m² × werkhoogte plan (13 m, € 11)', p.status === 'USER_OVERRIDDEN' && p.mode === 'PAND' &&
    p.formula === '500 m² × € 11 = € 5.500 per keer' && p.whInput, p.formula);
  await a.ctx.close();

  // ---------------- E: scope in één tariefklasse; H: ontbrekende pandhoogte ----------------
  var e = await newPage(ATTRS);
  await startPlan(e.page);
  await upload(e.page, scaffoldBundle('UNI', [100.84, 132.64, 118.32], [12.17, 12.19, 9.44]));
  await openEl(e.page, 'steiger');
  p = await selectScope(e.page);
  check('E. alle panden in één tariefklasse: scopetotaal 351,8 m² × € 11', p.mode === 'SCOPE_UNIFORM' && p.formula === '351,8 m² × € 11 = ' + eurTxt(351.8 * 11) + ' per keer' &&
    /^Alle 3 panden vallen in dezelfde tariefklasse/.test(p.note) && !p.whInput, p.formula);
  await upload(e.page, scaffoldBundle('MIS', [100, 200, 300], [12.1, null, 12.2]));
  await openEl(e.page, 'steiger');
  var pm = await e.page.evaluate(function () {
    var r = Array.prototype.filter.call(document.querySelectorAll('[data-qty-source-row]'), function (x) { return /QE-MIS-SCOPE/.test(x.dataset.qtySourceRow); })[0];
    return r && r.dataset.qtySourceRow;
  });
  await e.page.click('[data-act=qty-select][data-ev="' + pm + '"]');
  await e.page.waitForTimeout(150);
  p = await panel(e.page);
  var hr = await row(e.page, 'steiger');
  check('H. pandhoogte ontbreekt: kosten onbekend (geen € 0, geen willekeurige werkhoogte)', p.mode === 'UNKNOWN' && p.reason === 'werkhoogte_per_pand_ontbreekt' &&
    p.formulaUnknown && /0363100012345679/.test(p.formula) && hr.unknown && hr.bedrag === 'kosten onbekend', p.formula + ' / ' + hr.bedrag);
  await e.ctx.close();

  // H: plan zonder 3D BAG-hoogte -> werkhoogte onbekend (vroeger stil 9 m)
  var noH = JSON.parse(JSON.stringify(ATTRS));
  delete noH.b3_h_dak_max;
  var h = await newPage(noH);
  await startPlan(h.page);
  await openEl(h.page, 'steiger');
  p = await panel(h.page);
  var hr2 = await row(h.page, 'steiger');
  check('H2. geen 3D BAG-hoogte: werkhoogte leeg, kosten onbekend (geen 9 m, geen € 0)', p.mode === 'UNKNOWN' && p.reason === 'werkhoogte_onbekend' && p.whValue === '' &&
    p.formulaUnknown && hr2.unknown && hr2.bedrag === 'kosten onbekend' && /werkhoogte onbekend/.test(hr2.meta), JSON.stringify({ wh: p.whValue, b: hr2.bedrag }));
  await openEl(h.page, 'steiger');
  await h.page.fill('#wh-steiger', '6');
  await h.page.press('#wh-steiger', 'Tab');
  await h.page.waitForTimeout(150);
  p = await panel(h.page);
  check('H3. werkhoogte zelf invullen maakt de kosten weer berekenbaar', p.mode === 'PAND' && p.formula === '1.099,7 m² × € 6 = ' + eurTxt(1099.7 * 6) + ' per keer', p.formula);
  await h.ctx.close();

  await browser.close();
  check('Geen JavaScript-fouten tijdens het testen', errors.length === 0, errors.join(' | '));
  var fail = 0;
  checks.forEach(function (c) { console.log((c[1] ? 'OK  ' : 'FAIL') + ' - ' + c[0]); if (!c[1]) fail++; });
  if (fail) { console.log(fail + ' controle(s) mislukt.'); process.exitCode = 1; return; }
  console.log('Alle controles geslaagd.');
}

main().catch(function (e) { console.error(e); process.exit(1); });
