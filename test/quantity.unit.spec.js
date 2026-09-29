'use strict';
// Unit-tests voor src/quantity.js (Quantity Foundation v1). Puur Node, geen
// browser en geen dependencies:   node test/quantity.unit.spec.js
var assert = require('assert');
var Q = require('../src/quantity.js');

var fouten = 0;
function test(naam, fn) {
  try { fn(); console.log('OK   - ' + naam); } catch (e) { fouten++; console.log('FOUT - ' + naam + '\n       ' + e.message); }
}

// --- getallen lezen -----------------------------------------------------
test('312,6 wordt 312.6 (nooit 3126)', function () {
  assert.deepStrictEqual(Q.parseQuantity('312,6'), { ok: true, value: 312.6 });
});
test('312.6 wordt 312.6', function () { assert.strictEqual(Q.parseQuantity('312.6').value, 312.6); });
test('1.250,5 wordt 1250.5', function () { assert.strictEqual(Q.parseQuantity('1.250,5').value, 1250.5); });
test('1.250.000 wordt 1250000', function () { assert.strictEqual(Q.parseQuantity('1.250.000').value, 1250000); });
test('1,250.5 (Engels) wordt 1250.5', function () { assert.strictEqual(Q.parseQuantity('1,250.5').value, 1250.5); });
test('1.250 is onduidelijk en wordt geweigerd', function () {
  assert.deepStrictEqual(Q.parseQuantity('1.250'), { ok: false, error: 'onduidelijk_decimaalteken' });
});
test('negatief, leeg en tekst worden geweigerd', function () {
  assert.strictEqual(Q.parseQuantity('-5').ok, false);
  assert.strictEqual(Q.parseQuantity('').ok, false);
  assert.strictEqual(Q.parseQuantity('abc').ok, false);
  assert.strictEqual(Q.parseQuantity('12,5 m2').ok, false);
});
test('bedrag: 22,50 -> 22.5 en 1.250 -> 1250 (geld)', function () {
  assert.strictEqual(Q.parseAmount('22,50').value, 22.5);
  assert.strictEqual(Q.parseAmount('€ 1.250').value, 1250);
});
test('eenheden normaliseren', function () {
  assert.strictEqual(Q.normalizeUnit('m2'), 'm2');
  assert.strictEqual(Q.normalizeUnit('M²'), 'm2');
  assert.strictEqual(Q.normalizeUnit('stuks'), 'st');
  assert.strictEqual(Q.normalizeUnit('pst'), 'post');
  assert.strictEqual(Q.normalizeUnit('xyz'), null);
});

// --- statusmodel ---------------------------------------------------------
function dakAuto(v) { return Q.autoQuantity(v, 'm2', Q.SOURCES.THREE_D_BAG, 'test', { field: 'b3_opp_dak_plat', value: v }); }

test('nieuw object is PROPOSED met bron 3D_BAG', function () {
  var q = Q.create(dakAuto(312.64));
  assert.strictEqual(q.status, 'PROPOSED');
  assert.strictEqual(q.source, '3D_BAG');
  assert.strictEqual(q.value, 312.64);
});
test('bevestigen -> CONFIRMED, waarde ongewijzigd', function () {
  var q = Q.confirm(Q.create(dakAuto(312.64)));
  assert.strictEqual(q.status, 'CONFIRMED');
  assert.strictEqual(q.value, 312.64);
});
test('aanpassen -> USER_OVERRIDDEN, bron MANUAL, auto blijft bewaard', function () {
  var q = Q.override(Q.confirm(Q.create(dakAuto(312.64))), 305.5, '305,5');
  assert.strictEqual(q.status, 'USER_OVERRIDDEN');
  assert.strictEqual(q.source, 'MANUAL');
  assert.strictEqual(q.value, 305.5);
  assert.strictEqual(q.auto.value, 312.64);
  assert.strictEqual(q.manual.text, '305,5');
});
test('nieuwe automatische waarde overschrijft een handmatige waarde NIET', function () {
  var q = Q.override(Q.create(dakAuto(312.64)), 305.5);
  Q.updateAuto(q, dakAuto(400));
  assert.strictEqual(q.value, 305.5);
  assert.strictEqual(q.status, 'USER_OVERRIDDEN');
  assert.strictEqual(q.auto.value, 400);
  assert.strictEqual(q.history[q.history.length - 1].event, 'AUTO_CHANGED_MANUAL_KEPT');
});
test('terug naar automatisch -> PROPOSED met de automatische waarde', function () {
  var q = Q.override(Q.create(dakAuto(312.64)), 305.5);
  Q.resetToAuto(q);
  assert.strictEqual(q.status, 'PROPOSED');
  assert.strictEqual(q.value, 312.64);
  assert.strictEqual(q.manual, null);
});
test('bevestiging vervalt als de automatische waarde verandert', function () {
  var q = Q.confirm(Q.create(dakAuto(312.64)));
  Q.updateAuto(q, dakAuto(330));
  assert.strictEqual(q.status, 'PROPOSED');
  assert.strictEqual(q.value, 330);
});
test('bevestiging blijft staan als de automatische waarde gelijk blijft', function () {
  var q = Q.confirm(Q.create(dakAuto(312.64)));
  Q.updateAuto(q, dakAuto(312.64));
  assert.strictEqual(q.status, 'CONFIRMED');
});
test('historie is append-only en compleet', function () {
  var q = Q.create(dakAuto(312.64));
  Q.confirm(q); Q.override(q, 300); Q.resetToAuto(q);
  assert.deepStrictEqual(q.history.map(function (h) { return h.event; }), ['PROPOSED', 'CONFIRMED', 'USER_OVERRIDDEN', 'RESET_TO_AUTO']);
});

// --- migratie oude plannen ---------------------------------------------
test('legacy: gelijk aan automatisch -> PROPOSED', function () {
  var q = Q.fromLegacy(313, dakAuto(313));
  assert.strictEqual(q.status, 'PROPOSED');
});
test('legacy: afwijkend -> USER_OVERRIDDEN, waarde behouden', function () {
  var q = Q.fromLegacy(3126, dakAuto(313));
  assert.strictEqual(q.status, 'USER_OVERRIDDEN');
  assert.strictEqual(q.value, 3126);
  assert.strictEqual(q.manual.migrated, true);
});

// --- automatische regels -------------------------------------------------
var gebouw3d = {
  units: 12, unitsBron: 12, opp: 320, omtrek: 80, dakM2: 313, gevelM2: 1100,
  identificatie: '0363100012345678',
  d3: { plat: 313, schuin: 0, dak: 313, gevel: 1100 },
  d3raw: { pandId: 'NL.IMBAG.Pand.0363100012345678', fetchedAt: '2026-10-01T00:00:00Z',
    attributes: { b3_opp_dak_plat: 312.64, b3_opp_dak_schuin: 0, b3_opp_buitenmuur: 1099.7 } },
  bagRaw: { footprintM2: 319.8, omtrekM: 80.2 },
};
test('plat dak uit 3D BAG: ongeronde waarde, bron 3D_BAG, ruwe waarde bewaard', function () {
  var a = Q.autoFor('dakPlatM2', gebouw3d);
  assert.strictEqual(a.value, 312.64);
  assert.strictEqual(a.source, '3D_BAG');
  assert.strictEqual(a.raw.field, 'b3_opp_dak_plat');
  assert.strictEqual(a.raw.pand_id, 'NL.IMBAG.Pand.0363100012345678');
});
test('dak totaal = GEOMETRY_DERIVED (plat + schuin)', function () {
  assert.strictEqual(Q.autoFor('dakM2', gebouw3d).source, 'GEOMETRY_DERIVED');
});
test('buitenmuur als schilderwerk-oppervlak = ESTIMATED (benadering)', function () {
  assert.strictEqual(Q.autoFor('gevelM2', gebouw3d, { benadering: true }).source, 'ESTIMATED');
  assert.strictEqual(Q.autoFor('gevelM2', gebouw3d).source, '3D_BAG');
});
test('aantal appartementen = BAG; na eigen aanpassing = MANUAL', function () {
  assert.strictEqual(Q.autoFor('units', gebouw3d).source, 'BAG');
  var aangepast = Object.assign({}, gebouw3d, { units: 14 });
  assert.strictEqual(Q.autoFor('units', aangepast).source, 'MANUAL');
});
test('zonder 3D BAG: plat dak = ESTIMATED (grondvlak als benadering)', function () {
  var b = Object.assign({}, gebouw3d, { d3: null, d3raw: null });
  var a = Q.autoFor('dakPlatM2', b);
  assert.strictEqual(a.source, 'ESTIMATED');
  assert.strictEqual(a.value, 319.8);
});
test('oud plan (alleen afgeronde d3): zelfde getal als vroeger', function () {
  var b = { units: 8, unitsBron: 8, opp: 140, omtrek: 60, dakM2: 141, gevelM2: 540, d3: { plat: 100, schuin: 40, dak: 141, gevel: 540 } };
  assert.strictEqual(Q.autoFor('dakPlatM2', b).value, 100);
  assert.strictEqual(Q.autoFor('dakM2', b).value, 141);
  assert.strictEqual(Q.autoFor('gevelM2', b).value, 540);
});
test('kozijnaantal is altijd ESTIMATED', function () {
  var a = Q.autoKozijn(1, gebouw3d);
  assert.strictEqual(a.source, 'ESTIMATED');
  assert.strictEqual(a.value, 3);
});

if (fouten) { console.log('\n' + fouten + ' test(s) mislukt.'); process.exit(1); }
console.log('\nAlle quantity-unit-tests geslaagd.');
