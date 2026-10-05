'use strict';
// Unit-tests voor de steigerkosten (Facade Quantity Semantics v1, src/quantity.js scaffoldPricing).
// Puur Node, geen browser:   node test/scaffold-pricing.unit.spec.js
//
// Regel: PAND = hoeveelheid × tarief(werkhoogte plan); VvE-scope met alle panden in één tariefklasse =
// scopetotaal × dat tarief; verschillende tariefklassen = SOM(pand-m² × tarief(eigen werkhoogte));
// ontbrekende hoeveelheid of werkhoogte = kosten onbekend (null), nooit € 0 en nooit een willekeurige hoogte.
var assert = require('assert');
var Q = require('../src/quantity.js');

var fouten = 0;
function test(naam, fn) {
  try { fn(); console.log('OK   - ' + naam); } catch (e) { fouten++; console.log('FOUT - ' + naam + '\n       ' + e.message); }
}

var PANDEN = ['0000000000000001', '0000000000000002', '0000000000000003'];
var PLAN_PAND = PANDEN[0];

// v3-bundel (synthetisch, testdata) met een steiger-som over 3 panden en per-pand BUILDING_HEIGHT-context
function bundle(heights, areas) {
  var total = areas.reduce(function (s, a) { return s + Math.round(a * 100); }, 0) / 100;
  return {
    bundle_version: 'mjop_app_quantity_bundle_v3', building_id: 'BAG:' + PANDEN.join('+'), bag_pand_ids: PANDEN,
    building_scope: { building_id: 'BAG:' + PANDEN.join('+'), kind: 'MULTI_PAND_SCOPE', bag_pand_ids: PANDEN, pand_count: 3 },
    entries: [{
      app_element_key: 'steiger', crosswalk_mapping_id: 'XQ-steiger-OUTER_WALL_GROSS_AREA-m2', crosswalk_decision_id: 'XWD-T',
      subject_key: 'OUTER_WALL_GROSS_AREA', role: 'PRIMARY', selectable: true, subject_label_nl: 'Buitenmuuroppervlak bruto',
      evidence: { evidence_id: 'QE-SCOPE', source_type: '3D_BAG', method_class: 'GEOMETRY_DERIVED', value: String(total), unit: 'm2',
        status: 'PROPOSED', scope_level: 'COMPLEX', aggregation: 'SUM', formula: 'SUM', source_ref: {},
        components: PANDEN.map(function (p, i) { return { bag_pand_id: p, value: String(areas[i]), unit: 'm2', evidence_id: 'QE-W' + i }; }) },
      pricing_context: { purpose: 'SCAFFOLD_WORK_HEIGHT', context_subject_key: 'BUILDING_HEIGHT',
        rows: PANDEN.map(function (p, i) {
          return heights[i] === undefined ? null : { bag_pand_id: p, quantity_evidence_id: 'QE-W' + i,
            context_evidence_id: heights[i] == null ? null : 'QE-H' + i, value: heights[i] == null ? null : String(heights[i]), unit: 'm',
            status: heights[i] == null ? 'MISSING' : 'AVAILABLE' };
        }).filter(Boolean) },
    }],
  };
}

function scopeQuantity(heights, areas) {
  var res = Q.bundleEntries(bundle(heights, areas), { identificatie: PLAN_PAND });
  assert.ok(res.ok, res.errors.join(' '));
  var q = Q.create(Q.autoQuantity(120.5, 'm2', Q.SOURCES.THREE_D_BAG, 'auto', null));
  Q.addEvidence(q, res.entries[0].evidence);
  var r = Q.selectEvidence(q, res.entries[0].evidence.id);
  assert.ok(r.ok, JSON.stringify(r));
  return q;
}

test('tarief: bestaande grens (> 8 m -> € 11, anders € 6); onbekende werkhoogte -> null', function () {
  assert.strictEqual(Q.scaffoldRate(8), 6);
  assert.strictEqual(Q.scaffoldRate(9), 11);
  assert.strictEqual(Q.scaffoldRate(null), null);
  assert.strictEqual(Q.scaffoldRate(NaN), null);
});

test('werkhoogte = gebouwhoogte op 0,1 m en dan op hele meters (zoals bij het ophalen van het gebouw)', function () {
  assert.strictEqual(Q.workHeightFromBuildingHeight(9.444), 9);
  assert.strictEqual(Q.workHeightFromBuildingHeight(8.46), 9);   // 8,5 -> 9 -> € 11
  assert.strictEqual(Q.workHeightFromBuildingHeight(8.44), 8);   // 8,4 -> 8 -> € 6
  assert.strictEqual(Q.workHeightFromBuildingHeight(null), null);
});

test('D. enkel pand: buitenmuur × tarief van de eigen werkhoogte (ongewijzigde formule)', function () {
  var q = Q.create(Q.autoQuantity(3048.46, 'm2', Q.SOURCES.THREE_D_BAG, 'auto', null));
  var p = Q.scaffoldPricing(q, 20);
  assert.deepStrictEqual([p.mode, p.rate, p.cost], ['PAND', 11, Math.round(3048.46 * 11)]);
  p = Q.scaffoldPricing(q, 7);
  assert.deepStrictEqual([p.mode, p.rate, p.cost], ['PAND', 6, Math.round(3048.46 * 6)]);
});

test('E. scope, alle panden in één tariefklasse: scopetotaal × gemeenschappelijk tarief', function () {
  var q = scopeQuantity([12.1, 12.2, 9.44], [100.84, 132.64, 118.32]);
  var p = Q.scaffoldPricing(q, 9);
  assert.strictEqual(p.mode, 'SCOPE_UNIFORM');
  assert.strictEqual(p.rate, 11);
  assert.strictEqual(p.cost, Math.round(351.8 * 11));
  assert.strictEqual(p.rows.length, 3);
});

test('F. scope over verschillende tariefklassen: geen berekening met één tarief', function () {
  var q = scopeQuantity([12.1, 6.2, 7.9], [100, 200, 300]);
  var p = Q.scaffoldPricing(q, 12);       // planwerkhoogte 12 m mag NIET op de hele scope
  assert.strictEqual(p.mode, 'SCOPE_PER_PAND');
  assert.strictEqual(p.rate, null);
  assert.notStrictEqual(p.cost, Math.round(600 * 11));  // max-hoogte op alle m²
  assert.notStrictEqual(p.cost, Math.round(600 * 6));   // laagste tarief op alle m²
  p = Q.scaffoldPricing(q, 7);            // ook niet met een lage planwerkhoogte
  assert.notStrictEqual(p.cost, Math.round(600 * 6));
});

test('G. mixed-band: kosten exact gelijk aan de som van de pandkosten', function () {
  var areas = [101.13, 197.42, 116.45], heights = [12.11, 6.5, 8.46];
  var q = scopeQuantity(heights, areas);
  var p = Q.scaffoldPricing(q, 9);
  var verwachtCent = 10113 * 11 + 19742 * 6 + 11645 * 11;   // 8,46 -> 9 m -> € 11
  assert.strictEqual(p.cost, Math.round(verwachtCent / 100));
  assert.deepStrictEqual(p.rows.map(function (r) { return [r.werkhoogte, r.rate, r.band]; }), [[12, 11, 'GT_8M'], [7, 6, 'LE_8M'], [9, 11, 'GT_8M']]);
  var somRijen = p.rows.reduce(function (s, r) { return s + Math.round(r.cost * 100); }, 0);
  assert.strictEqual(somRijen, verwachtCent);
  // geen gewogen gemiddelde hoogte
  var gemH = (101.13 * 12.11 + 197.42 * 6.5 + 116.45 * 8.46) / 415;
  assert.notStrictEqual(p.cost, Math.round(415 * Q.scaffoldRate(Q.workHeightFromBuildingHeight(gemH))));
});

test('H. ontbrekende pandhoogte: kosten onbekend (null), niet € 0 en geen willekeurige hoogte', function () {
  var q = scopeQuantity([12.1, null, 12.2], [100, 200, 300]);
  var p = Q.scaffoldPricing(q, 9);
  assert.deepStrictEqual([p.mode, p.cost, p.reason], ['UNKNOWN', null, 'werkhoogte_per_pand_ontbreekt']);
  assert.deepStrictEqual(p.missing, [PANDEN[1]]);
  q = scopeQuantity([12.1, undefined, 12.2], [100, 200, 300]);   // rij ontbreekt helemaal
  assert.strictEqual(Q.scaffoldPricing(q, 9).cost, null);
});

test('H2. scope zonder prijscontext: kosten onbekend (geen stille terugval op de planwerkhoogte)', function () {
  var b = bundle([12, 12, 12], [1, 2, 3]);
  delete b.entries[0].pricing_context;
  var res = Q.bundleEntries(b, { identificatie: PLAN_PAND });
  var q = Q.create(Q.autoQuantity(5, 'm2', Q.SOURCES.THREE_D_BAG, 'auto', null));
  Q.addEvidence(q, res.entries[0].evidence);
  Q.selectEvidence(q, res.entries[0].evidence.id);
  var p = Q.scaffoldPricing(q, 9);
  assert.deepStrictEqual([p.mode, p.cost], ['UNKNOWN', null]);
});

test('H3. enkel pand zonder werkhoogte: kosten onbekend', function () {
  var q = Q.create(Q.autoQuantity(100, 'm2', Q.SOURCES.THREE_D_BAG, 'auto', null));
  assert.deepStrictEqual([Q.scaffoldPricing(q, null).cost, Q.scaffoldPricing(q, null).reason], [null, 'werkhoogte_onbekend']);
  var leeg = Q.create(Q.unavailableQuantity('m2', 'onbekend', null));
  assert.deepStrictEqual([Q.scaffoldPricing(leeg, 9).cost, Q.scaffoldPricing(leeg, 9).reason], [null, 'hoeveelheid_onbekend']);
});

test('I. handmatige hoeveelheid blijft mogelijk en rekent met de werkhoogte van het plan', function () {
  var q = scopeQuantity([12.1, 6.2, 7.9], [100, 200, 300]);
  Q.override(q, 250, '250');
  var p = Q.scaffoldPricing(q, 7);
  assert.deepStrictEqual([p.mode, p.rate, p.cost], ['PAND', 6, 1500]);
});

test('J. prijscontext overleeft JSON (opslaan/herladen)', function () {
  var q = JSON.parse(JSON.stringify(scopeQuantity([12.1, 6.2, 7.9], [100, 200, 300])));
  var p = Q.scaffoldPricing(Q.refresh(q), 9);
  assert.strictEqual(p.mode, 'SCOPE_PER_PAND');
  assert.strictEqual(p.cost, Math.round((10000 * 11 + 20000 * 6 + 30000 * 6) / 100));
});

test('BUILDING_HEIGHT is geen kiesbare bron: de bundel levert hem alleen als prijscontext', function () {
  var res = Q.bundleEntries(bundle([12, 12, 12], [1, 2, 3]), { identificatie: PLAN_PAND });
  assert.strictEqual(res.entries.length, 1);
  assert.strictEqual(res.entries[0].evidence.subject_key, 'OUTER_WALL_GROSS_AREA');
  assert.strictEqual(res.entries[0].evidence.pricing_context.context_subject_key, 'BUILDING_HEIGHT');
});

if (fouten) { console.log('\n' + fouten + ' test(s) mislukt.'); process.exit(1); }
console.log('\nAlle scaffold-pricing-unit-tests geslaagd.');
