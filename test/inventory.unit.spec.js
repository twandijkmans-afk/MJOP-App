'use strict';
// Unit-tests voor src/inventory.js (Building Element Inventory UI v1). Puur Node:   node test/inventory.unit.spec.js
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var INV = require('../src/inventory.js');

var fouten = 0;
function test(naam, fn) {
  try { fn(); console.log('OK   - ' + naam); } catch (e) { fouten++; console.log('FOUT - ' + naam + '\n       ' + e.message); }
}
function fixture(n) { return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'inventory', n), 'utf8')); }
var M = fixture('maldenhof_component_inventory_v1.json');
var D = fixture('doc012_component_inventory_v1.json');
var PAND_M = M.building.bag_pand_ids[0];
function load(b, pand) { var r = INV.loadBundle(b, { identificatie: pand }); assert.ok(r.ok, (r.errors || []).join()); return r.inventory; }
function el(id, type) { return { id: id, naam: id, type: type || 'vast-variabel', gebreken: [] }; }

test('bundel laden: juiste pand, verkleind, geen bronfragmenten', function () {
  var inv = load(M, PAND_M);
  assert.strictEqual(inv.components.length, 22);
  assert.ok(!('source_summary' in inv.components[0]));
  assert.deepStrictEqual(inv.answers, {});
});
test('bundel laden: verkeerd pand, verkeerde versie en leeg worden geweigerd', function () {
  assert.strictEqual(INV.loadBundle(M, { identificatie: '999' }).ok, false);
  assert.strictEqual(INV.loadBundle(M, {}).ok, false);
  assert.strictEqual(INV.loadBundle({ bundle_version: 'x' }, { identificatie: PAND_M }).ok, false);
  assert.strictEqual(INV.loadBundle(null, { identificatie: PAND_M }).ok, false);
});
test('present / unknown weergave: PRESENT ✓, UNKNOWN ?, nooit stil ABSENT', function () {
  var inv = load(M, PAND_M);
  assert.strictEqual(INV.effectiveStatus(inv, 'ROOF_FLAT_COVERING').status, 'PRESENT');
  assert.strictEqual(INV.effectiveStatus(inv, 'LIFT_INSTALLATION').status, 'UNKNOWN');
  assert.strictEqual(INV.STATUS_SYMBOLS.UNKNOWN, '?');
  assert.ok(!inv.components.some(function (c) { return c.status === 'ABSENT'; }));
  assert.strictEqual(INV.requirementResult(inv, 'lift'), 'NEEDS_CONFIRMATION');
  assert.strictEqual(INV.requirementResult(inv, 'dak-plat'), 'APPLICABLE');
});
test('DOC-012: voorgestelde afwezigheid (3D BAG nul) blijft UNKNOWN / NEEDS_CONFIRMATION', function () {
  var inv = load(D, D.building.bag_pand_ids[0]);
  assert.strictEqual(INV.effectiveStatus(inv, 'ROOF_SLOPED_COVERING').status, 'UNKNOWN');
  assert.strictEqual(INV.requirementResult(inv, 'dak-hellend'), 'NEEDS_CONFIRMATION');
});
test('niet-presence-gedreven posten', function () {
  var inv = load(M, PAND_M);
  assert.strictEqual(INV.requirementResult(inv, 'steiger'), 'NOT_PRESENCE_DRIVEN');
  assert.strictEqual(INV.requirementResult(inv, 'dakisolatie'), 'USER_SELECTED');
  assert.strictEqual(INV.requirementResult(inv, 'schilderwerk-buiten'), 'NEEDS_ATTRIBUTE_CONFIRMATION');
});
test('bundel zonder gebruikerskeuze verwijdert niets (unknown item blijft zichtbaar)', function () {
  var inv = load(M, PAND_M);
  var els = [el('lift'), el('intercom'), el('dak-plat'), el('steiger')];
  var r = INV.applyToElements(inv, els);
  assert.strictEqual(r.elements.length, 4);
  assert.deepStrictEqual(r.removed, []);
});
test('handmatige bevestiging JA: USER_CONFIRMED_MANUAL, PRESENT, post APPLICABLE', function () {
  var inv = load(M, PAND_M);
  assert.ok(INV.setAnswer(inv, 'LIFT_INSTALLATION', 'JA', '2026-10-12T10:00:00Z'));
  var e = INV.effectiveStatus(inv, 'LIFT_INSTALLATION');
  assert.deepStrictEqual([e.status, e.source, e.user_confirmed], ['PRESENT', 'USER_CONFIRMED_MANUAL', true]);
  assert.strictEqual(INV.requirementResult(inv, 'lift'), 'APPLICABLE');
  assert.strictEqual(inv.components.filter(function (c) { return c.component_type === 'LIFT_INSTALLATION'; })[0].status, 'UNKNOWN'); // bundel ongewijzigd
});
test('handmatige afwezigheid NEE haalt alleen de bijbehorende post weg, en LATER/JA zet hem terug', function () {
  var inv = load(M, PAND_M);
  var els = [el('lift'), el('intercom'), el('dak-plat'), el('steiger')];
  INV.setAnswer(inv, 'LIFT_INSTALLATION', 'NEE');
  assert.strictEqual(INV.requirementResult(inv, 'lift'), 'NOT_APPLICABLE');
  var r = INV.applyToElements(inv, els);
  assert.deepStrictEqual(r.removed, ['lift']);
  assert.deepStrictEqual(r.elements.map(function (x) { return x.id; }).sort(), ['dak-plat', 'intercom', 'steiger']);
  INV.setAnswer(inv, 'LIFT_INSTALLATION', 'LATER');
  var r2 = INV.applyToElements(inv, r.elements);
  assert.deepStrictEqual(r2.restored, ['lift']);
  assert.strictEqual(r2.elements.length, 4);
  assert.deepStrictEqual(inv.removed, {});
});
test('NEE op een van twee dakdelen laat dakinspectie staan (ANY-regel); beide NEE verwijdert hem', function () {
  var inv = load(M, PAND_M);
  INV.setAnswer(inv, 'ROOF_FLAT_COVERING', 'NEE');
  assert.strictEqual(INV.requirementResult(inv, 'dakinspectie'), 'APPLICABLE');
  assert.strictEqual(INV.requirementResult(inv, 'dak-plat'), 'NOT_APPLICABLE');
  INV.setAnswer(inv, 'ROOF_SLOPED_COVERING', 'NEE');
  assert.strictEqual(INV.requirementResult(inv, 'dakinspectie'), 'NOT_APPLICABLE');
});
test('eigen (custom) posten worden nooit door de inventaris verwijderd', function () {
  var inv = load(M, PAND_M);
  INV.setAnswer(inv, 'LIFT_INSTALLATION', 'NEE');
  var r = INV.applyToElements(inv, [{ id: 'lift', type: 'custom', gebreken: [] }]);
  assert.strictEqual(r.elements.length, 1);
});
test('ongeldige keuze of onbekend bouwdeel wordt geweigerd', function () {
  var inv = load(M, PAND_M);
  assert.strictEqual(INV.setAnswer(inv, 'LIFT_INSTALLATION', 'MISSCHIEN'), false);
  assert.strictEqual(INV.setAnswer(inv, 'NOPE', 'JA'), false);
});
test('kozijnen Maldenhof: aanwezig, hout volgens bron, 11/11/1 zichtbaar, gebouwtotaal onbekend, legacy label', function () {
  var f = INV.frameSummary(load(M, PAND_M));
  assert.strictEqual(f.presence.status, 'PRESENT');
  assert.deepStrictEqual([f.material_as_reported, f.material_basis], ['hout', 'SOURCE_REPORTED_BUILDING_LEVEL']);
  assert.deepStrictEqual([f.photo_visible.frames, f.photo_visible.windows, f.photo_visible.doors], [11, 11, 1]);
  assert.strictEqual(f.building_total_known, false);
  assert.strictEqual(f.legacy_label, 'Schatting op basis van aantal appartementen');
  assert.strictEqual(INV.frameSummary(load(D, D.building.bag_pand_ids[0])).photo_visible, null);
});
test('geen scores, prijzen of hoeveelheden in de opgeslagen inventaris', function () {
  var txt = JSON.stringify(load(M, PAND_M)).toLowerCase();
  ['confidence', '"score', 'kengetal', '"price', 'cashflow'].forEach(function (w) { assert.ok(txt.indexOf(w) === -1, w); });
});
console.log(fouten ? fouten + ' test(s) mislukt' : 'alle tests geslaagd');
process.exit(fouten ? 1 : 0);
