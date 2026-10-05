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

// --- meerdere bronnen (v2) ----------------------------------------------------
function histEv(v) { return { id: 'bundle:QE-1', source: 'IMPORTED_MJOP', method_class: 'SOURCE_REPORTED', value: v, unit: 'm2', basis: 'test', source_ref: { document_id: 'DOC-TEST' } }; }
test('bron toevoegen overschrijft nooit (zelfde id)', function () {
  var q = Q.create(dakAuto(312.64));
  assert.strictEqual(Q.addEvidence(q, histEv(308)), true);
  assert.strictEqual(Q.addEvidence(q, histEv(999)), false);
  assert.strictEqual(Q.findEvidence(q, 'bundle:QE-1').value, 308);
  assert.strictEqual(q.value, 312.64);                         // toevoegen kiest niets
});
test('bron kiezen -> CONFIRMED met waarde van die bron', function () {
  var q = Q.create(dakAuto(312.64)); Q.addEvidence(q, histEv(308));
  assert.deepStrictEqual(Q.selectEvidence(q, 'bundle:QE-1'), { ok: true });
  assert.strictEqual(q.value, 308); assert.strictEqual(q.source, 'IMPORTED_MJOP'); assert.strictEqual(q.status, 'CONFIRMED');
});
test('bron met andere eenheid kan niet gekozen worden', function () {
  var q = Q.create(dakAuto(312.64)); var e = histEv(84); e.id = 'x'; e.unit = 'm1'; Q.addEvidence(q, e);
  assert.strictEqual(Q.selectEvidence(q, 'x').ok, false); assert.strictEqual(q.value, 312.64);
});
test('handmatig na gekozen bron: handmatige waarde wordt ook bron; andere bron kiezen bewaart hem', function () {
  var q = Q.create(dakAuto(312.64)); Q.addEvidence(q, histEv(308)); Q.selectEvidence(q, 'bundle:QE-1');
  Q.override(q, 311, '311');
  assert.strictEqual(q.status, 'USER_OVERRIDDEN'); assert.strictEqual(q.value, 311);
  Q.selectEvidence(q, 'bundle:QE-1');
  assert.strictEqual(q.value, 308);
  assert.ok(q.evidence.some(function (e) { return e.source === 'MANUAL' && e.value === 311; }));
});
test('reset na gekozen bron -> automatisch, bronnen blijven', function () {
  var q = Q.create(dakAuto(312.64)); Q.addEvidence(q, histEv(308)); Q.selectEvidence(q, 'bundle:QE-1');
  Q.resetToAuto(q);
  assert.strictEqual(q.status, 'PROPOSED'); assert.strictEqual(q.value, 312.64); assert.strictEqual(q.evidence.length, 1);
});
test('verschil is feitelijk: absoluut en procent t.o.v. gekozen hoeveelheid', function () {
  var q = Q.create(dakAuto(312.64));
  assert.deepStrictEqual(Q.difference(q, 308), { absolute: -4.64, percentage: -1.5 });
});
test('v1-object zonder bronnenlijst blijft werken', function () {
  var q = { auto: dakAuto(100), manual: null, confirmed: null, history: [] };
  Q.refresh(q); assert.strictEqual(q.value, 100); assert.strictEqual(Q.selectEvidence(q, 'x').ok, false);
});
test('bundel: alleen eigen pand, één pand', function () {
  var b = { bundle_version: 'mjop_app_quantity_bundle_v1', bag_pand_ids: ['1'], entries: [
    { app_element_key: 'dak-plat', crosswalk_mapping_id: 'XW', evidence: { evidence_id: 'QE-1', source_type: 'MJOP_ELEMENT_OVERVIEW', method_class: 'SOURCE_REPORTED', value: '308.00', unit: 'm2', source_ref: { document_id: 'D' } } }] };
  assert.strictEqual(Q.bundleEntries(b, { identificatie: '2' }).ok, false);
  assert.strictEqual(Q.bundleEntries(Object.assign({}, b, { bag_pand_ids: ['1', '2'] }), { identificatie: '1' }).ok, false);
  var r = Q.bundleEntries(b, { identificatie: '1' });
  assert.strictEqual(r.ok, true); assert.strictEqual(r.entries[0].evidence.value, 308); assert.strictEqual(r.entries[0].evidence.source, 'IMPORTED_MJOP');
});

// --- offertebedragen -------------------------------------------------------------
function amounts(list) { return Q.parseOfferteAmounts(list).map(function (p) { return p.ok ? p.value : p.error; }); }
test('offerte: 1.250,50 / 1250,50 / 1250.50 / 1,250.50 -> 1250.5', function () {
  assert.deepStrictEqual(amounts(['1.250,50', '1250,50', '1250.50', '1,250.50']), [1250.5, 1250.5, 1250.5, 1250.5]);
});
test('offerte: 1.250 alleen met hele-euro-bewijs als 1250, anders niet geraden', function () {
  assert.deepStrictEqual(amounts(['1.250', '3.400', '500']), [1250, 3400, 500]);
  assert.deepStrictEqual(amounts(['1.250', '99,50']), ['ambiguous_thousands_or_decimal', 99.5]);
});
test('offerte: leeg telt als 0, onzin wordt geweigerd', function () {
  assert.deepStrictEqual(amounts(['', 'abc']), [0, 'not_a_number']);
});

// --- multi-pand bundel (v2) -------------------------------------------------
var fs = require('fs');
var path = require('path');
var V2 = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'quantity-bundle-multipand.test.json'), 'utf8'));
var V1 = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'quantity-bundle.test.json'), 'utf8'));
test('oude v1-bundel (één pand) wordt nog steeds gelezen, zonder scope', function () {
  var r = Q.bundleEntries(V1, { identificatie: V1.bag_pand_ids[0] });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.scope, null);
  assert.ok(r.entries.every(function (e) { return e.evidence.scope_level === undefined && e.evidence.components === undefined; }));
});
test('v2-bundel: plan-pand in de scope -> complexbronnen met som en onderdelen per pand', function () {
  var r = Q.bundleEntries(V2, { identificatie: '0363100012345679' });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.scope.bag_pand_ids, V2.building_scope.bag_pand_ids);
  var bag = r.entries.filter(function (e) { return e.evidence.source === '3D_BAG'; })[0].evidence;
  var hist = r.entries.filter(function (e) { return e.evidence.source === 'IMPORTED_MJOP'; })[0].evidence;
  assert.strictEqual(bag.value, 463.39);
  assert.strictEqual(bag.method_class, 'GEOMETRY_DERIVED');
  assert.strictEqual(bag.scope_level, 'COMPLEX');
  assert.deepStrictEqual(bag.components.map(function (c) { return [c.bag_pand_id, c.value]; }),
    [['0363100012345678', 312.64], ['0363100012345679', 100.25], ['0363100012345680', 50.5]]);
  assert.ok(/som van 3 panden/.test(bag.basis));
  assert.strictEqual(hist.value, 520);
  assert.strictEqual(hist.scope_level, 'COMPLEX');
  assert.deepStrictEqual(hist.components, []);
  assert.ok(/complexniveau/.test(hist.basis) && /niet over panden verdeeld/.test(hist.basis));
});
test('v2-bundel: plan-pand buiten de scope of inconsistente scope wordt geweigerd', function () {
  assert.strictEqual(Q.bundleEntries(V2, { identificatie: '0363100099999999' }).ok, false);
  var kapot = JSON.parse(JSON.stringify(V2)); kapot.building_scope.bag_pand_ids.pop();
  assert.strictEqual(Q.bundleEntries(kapot, { identificatie: '0363100012345678' }).ok, false);
  var v1meer = JSON.parse(JSON.stringify(V1)); v1meer.bag_pand_ids = ['1', '2'];
  assert.strictEqual(Q.bundleEntries(v1meer, { identificatie: '1' }).ok, false);
});
test('v2: importeren kiest niets en middelt niets; verschil alleen op hetzelfde niveau', function () {
  var q = Q.create(dakAuto(312.64));
  var r = Q.bundleEntries(V2, { identificatie: '0363100012345678' });
  r.entries.forEach(function (e) { Q.addEvidence(q, e.evidence); });
  assert.ok(!q.selected);                                                    // niets automatisch gekozen
  assert.strictEqual(q.value, 312.64);
  assert.strictEqual(q.status, 'PROPOSED');
  assert.strictEqual(Q.effectiveScopeLevel(q), 'PAND');
  var bag = r.entries.filter(function (e) { return e.evidence.source === '3D_BAG'; })[0].evidence;
  assert.strictEqual(Q.scopeLevel(bag), 'COMPLEX');
  assert.deepStrictEqual(Q.selectEvidence(q, bag.id), { ok: true });       // alleen op expliciete keuze
  assert.strictEqual(q.value, 463.39);
  assert.strictEqual(Q.effectiveScopeLevel(q), 'COMPLEX');
  var bewaard = JSON.parse(JSON.stringify(q));                              // opslaan/herladen
  assert.deepStrictEqual(bewaard.evidence.filter(function (e) { return e.source === '3D_BAG'; })[0].components.length, 3);
});

// --- Related Quantity Sources v1: bundel v3 met verwant maar ander onderwerp ------------
var V3 = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, 'fixtures', 'quantity-bundle-related.test.json'), 'utf8'));

test('v3-bundel: hoofdonderwerp kiesbaar, historische dakbedekking als niet-kiesbare context', function () {
  var r = Q.bundleEntries(V3, { identificatie: '0363100012345680' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.scope.pand_count, 3);
  var prim = r.entries.filter(function (e) { return !Q.isRelatedContext(e.evidence); });
  var ctx = r.entries.filter(function (e) { return Q.isRelatedContext(e.evidence); });
  assert.strictEqual(prim.length, 1);
  assert.strictEqual(prim[0].evidence.subject_key, 'ROOF_FLAT_AREA');
  assert.strictEqual(prim[0].evidence.value, 463.39);
  assert.strictEqual(prim[0].evidence.components.length, 3);
  assert.strictEqual(ctx.length, 1);
  var c = ctx[0].evidence;
  assert.strictEqual(c.subject_key, 'ROOF_COVERING_REPORTED_AREA');
  assert.strictEqual(c.selectable, false);
  assert.strictEqual(c.relation.relation, 'RELATED_NOT_EQUIVALENT');
  assert.strictEqual(c.relation.resolvable_as_same_quantity, false);
  assert.strictEqual(c.primary_subject_key, 'ROOF_FLAT_AREA');
  assert.strictEqual(c.value, 520);
  assert.strictEqual(c.scope_level, 'COMPLEX');
  assert.ok(/ander onderwerp/i.test(c.basis) && /niet kiesbaar/.test(c.basis));
});

test('v3: context kan niet gekozen worden; geen automatische keuze, geen gemiddelde', function () {
  var q = Q.create(Q.autoQuantity(312.64, 'm2', '3D_BAG', 'plan-pand', null), '2026-10-05T10:00:00Z');
  Q.bundleEntries(V3, { identificatie: '0363100012345678' }).entries.forEach(function (e) { Q.addEvidence(q, e.evidence); });
  assert.ok(!q.selected);
  assert.strictEqual(q.value, 312.64);
  assert.strictEqual(q.status, 'PROPOSED');
  var ctx = q.evidence.filter(Q.isRelatedContext)[0];
  assert.deepStrictEqual(Q.selectEvidence(q, ctx.id), { ok: false, error: 'ander_onderwerp' });
  assert.strictEqual(q.value, 312.64);
  assert.ok(!q.selected);
  assert.ok(q.history.every(function (h) { return h.event !== 'SOURCE_SELECTED'; }));
  // het bronverschil is ten opzichte van de 3D BAG-som op hetzelfde (complex)niveau, als andere definitie
  var d = Q.sourceDifference(q, ctx);
  assert.strictEqual(d.absolute, 56.61);
  assert.strictEqual(d.percentage, 12.2);
  assert.strictEqual(d.reference.subject_key, 'ROOF_FLAT_AREA');
  assert.ok([312.64, 463.39, 520].indexOf(q.value) !== -1 && q.value !== (463.39 + 520) / 2);
  // het hoofdonderwerp blijft expliciet kiesbaar
  var bag = q.evidence.filter(function (e) { return e.subject_key === 'ROOF_FLAT_AREA'; })[0];
  assert.deepStrictEqual(Q.selectEvidence(q, bag.id), { ok: true });
  assert.strictEqual(q.value, 463.39);
  var bewaard = JSON.parse(JSON.stringify(q));                              // opslaan/herladen
  assert.strictEqual(Q.isRelatedContext(bewaard.evidence.filter(function (e) { return e.subject_key === 'ROOF_COVERING_REPORTED_AREA'; })[0]), true);
});

test('v3: inconsistente scope of plan-pand buiten de scope wordt geweigerd; v1/v2 ongewijzigd', function () {
  assert.strictEqual(Q.bundleEntries(V3, { identificatie: '0363100099999999' }).ok, false);
  var kapot = JSON.parse(JSON.stringify(V3)); kapot.building_scope.bag_pand_ids.pop();
  assert.strictEqual(Q.bundleEntries(kapot, { identificatie: '0363100012345678' }).ok, false);
  var v2 = Q.bundleEntries(V2, { identificatie: '0363100012345678' });
  assert.ok(v2.ok && v2.entries.every(function (e) { return !Q.isRelatedContext(e.evidence); }));
  var v1 = Q.bundleEntries(V1, { identificatie: V1.bag_pand_ids[0] });
  assert.ok(v1.ok && v1.entries.every(function (e) { return !Q.isRelatedContext(e.evidence); }));
});

test('bronwaarde houdt de precisie van de bron (425.80 -> 425,80), zonder brontekst gewoon formatNumber', function () {
  assert.strictEqual(Q.formatSourceValue({ value: 425.8, value_text: '425.80' }), '425,80');
  assert.strictEqual(Q.formatSourceValue({ value: 190.65, value_text: '190.65' }), '190,65');
  assert.strictEqual(Q.formatSourceValue({ value: 1415.57, value_text: '1415.57' }), '1.415,57');
  assert.strictEqual(Q.formatSourceValue({ value: 12.5 }), '12,5');
  assert.strictEqual(Q.formatSourceValue({ value: 3, value_text: 'drie' }), '3');
});

// --- Quantity Missingness Safety v1: MISSING != 0 ---------------------------------
function gebouw(attrs) {
  return { identificatie: '0363100012345678', opp: 300, omtrek: 70, units: 12, unitsBron: 12,
    bagRaw: { footprintM2: 300.4, omtrekM: 70.2 }, d3: {},
    d3raw: { pandId: 'NL.IMBAG.Pand.0363100012345678', fetchedAt: '2026-10-05T10:00:00Z', attributes: attrs } };
}

test('A. b3_opp_dak_schuin = 0 aanwezig -> 0 is geldig, bron 3D BAG', function () {
  var a = Q.autoFor('dakSchuinM2', gebouw({ b3_opp_dak_plat: 120, b3_opp_dak_schuin: 0 }));
  assert.strictEqual(a.value, 0);
  assert.strictEqual(a.source, '3D_BAG');
  var q = Q.create(a);
  assert.strictEqual(q.status, 'PROPOSED');
  assert.ok(Q.isKnown(q));
});

test('B. b3_opp_dak_schuin ontbreekt -> GEEN 0, niet beschikbaar', function () {
  var a = Q.autoFor('dakSchuinM2', gebouw({ b3_opp_dak_plat: 120 }));
  assert.strictEqual(a.value, null);
  assert.strictEqual(a.source, 'NOT_AVAILABLE');
  assert.ok(/b3_opp_dak_schuin ontbreekt/.test(a.basis));
  var q = Q.create(a);
  assert.strictEqual(q.value, null);
  assert.strictEqual(q.status, 'NOT_AVAILABLE');
  assert.strictEqual(Q.isKnown(q), false);
  // ook zonder 3D BAG: geen '0 aangenomen' meer
  var geen = Q.autoFor('dakSchuinM2', { identificatie: 'x', opp: 300, omtrek: 70, units: 12, bagRaw: { footprintM2: 300 }, d3: null, d3raw: null });
  assert.strictEqual(geen.value, null);
  // een afgeronde d3.schuin = 0 (uit de oude '|| 0'-lookup) wordt bij een plan MET d3raw niet meer gebruikt
  var oudeD3 = gebouw({ b3_opp_dak_plat: 120 }); oudeD3.d3 = { plat: 120, schuin: 0, dak: 120 };
  assert.strictEqual(Q.autoFor('dakSchuinM2', oudeD3).value, null);
});

test('C. plat aanwezig, schuin ontbreekt -> dak totaal NIET plat + 0', function () {
  var a = Q.autoFor('dakM2', gebouw({ b3_opp_dak_plat: 120.5 }));
  assert.strictEqual(a.value, null);
  assert.strictEqual(a.source, 'NOT_AVAILABLE');
  assert.ok(/niet volledig beschikbaar/.test(a.basis) && /geen totaal/.test(a.basis));
  assert.deepStrictEqual(a.raw.missing, ['b3_opp_dak_schuin']);
  var b = Q.autoFor('dakM2', gebouw({ b3_opp_dak_schuin: 80 }));
  assert.strictEqual(b.value, null);
  assert.deepStrictEqual(b.raw.missing, ['b3_opp_dak_plat']);
});

test('D. plat = 0 aanwezig, schuin > 0 -> totaal = schuin', function () {
  var a = Q.autoFor('dakM2', gebouw({ b3_opp_dak_plat: 0, b3_opp_dak_schuin: 74.07 }));
  assert.strictEqual(a.value, 74.07);
  assert.strictEqual(a.source, 'GEOMETRY_DERIVED');
  assert.strictEqual(Q.autoFor('dakPlatM2', gebouw({ b3_opp_dak_plat: 0, b3_opp_dak_schuin: 74.07 })).value, 0);
});

test('E. schuin = 0 aanwezig, plat > 0 -> totaal = plat', function () {
  var a = Q.autoFor('dakM2', gebouw({ b3_opp_dak_plat: 875.63, b3_opp_dak_schuin: 0 }));
  assert.strictEqual(a.value, 875.63);
  assert.strictEqual(a.source, 'GEOMETRY_DERIVED');
});

test('F. beide dakvelden ontbreken -> geen fictief 3D BAG-totaal (alleen de expliciete grondvlak-schatting)', function () {
  var a = Q.autoFor('dakM2', gebouw({ b3_opp_buitenmuur: 500 }));
  assert.notStrictEqual(a.source, 'GEOMETRY_DERIVED');
  assert.notStrictEqual(a.source, '3D_BAG');
  assert.strictEqual(a.source, 'ESTIMATED');
  assert.strictEqual(a.value, 300.4);  // BAG-grondvlak, expliciet als schatting
  assert.ok(/ontbreken in het 3D BAG-model/.test(a.basis) && /schatting/.test(a.basis));
  assert.notStrictEqual(a.value, 0);
  assert.strictEqual(Q.autoFor('dakSchuinM2', gebouw({ b3_opp_buitenmuur: 500 })).value, null);
});

test('G. b3_opp_buitenmuur = 0 aanwezig -> geldige 0 uit 3D BAG (geen truthiness-terugval op schatting)', function () {
  var a = Q.autoFor('gevelM2', gebouw({ b3_opp_buitenmuur: 0 }));
  assert.strictEqual(a.value, 0);
  assert.strictEqual(a.source, '3D_BAG');
  var m = Q.autoFor('gevelM2', gebouw({ b3_opp_dak_plat: 10 }));  // ontbreekt -> bestaande expliciete schatting
  assert.strictEqual(m.source, 'ESTIMATED');
  assert.ok(/b3_opp_buitenmuur ontbreekt/.test(m.basis));
});

test('H. handmatige waarde blijft mogelijk bij een niet-beschikbare automatische hoeveelheid', function () {
  var q = Q.create(Q.autoFor('dakM2', gebouw({ b3_opp_dak_plat: 120 })), '2026-10-05T10:00:00Z');
  assert.strictEqual(q.status, 'NOT_AVAILABLE');
  Q.confirm(q);  // bevestigen van "niets" kan niet
  assert.strictEqual(q.status, 'NOT_AVAILABLE');
  assert.ok(!q.confirmed);
  Q.override(q, 210, '210');
  assert.strictEqual(q.value, 210);
  assert.strictEqual(q.status, 'USER_OVERRIDDEN');
  Q.resetToAuto(q);
  assert.strictEqual(q.value, null);
  assert.strictEqual(q.status, 'NOT_AVAILABLE');
});

test('legacy: plan zonder d3raw gebruikt de bestaande afgeronde d3-velden ongewijzigd', function () {
  var legacy = { identificatie: 'x', opp: 300, omtrek: 70, units: 12, d3: { plat: 120, schuin: 0, dak: 120, gevel: 900 } };
  assert.strictEqual(Q.autoFor('dakSchuinM2', legacy).value, 0);
  assert.strictEqual(Q.autoFor('dakM2', legacy).value, 120);
  assert.strictEqual(Q.autoFor('gevelM2', legacy).value, 900);
  // een al opgeslagen hoeveelheidsobject blijft zoals het is (fromLegacy/updateAuto overschrijven geen handmatige waarde)
  var q = Q.create(Q.autoQuantity(0, 'm2', 'ESTIMATED', 'oud', null));
  Q.override(q, 55, '55');
  Q.updateAuto(q, Q.unavailableQuantity('m2', 'nu onbekend', null));
  assert.strictEqual(q.value, 55);
});

if (fouten) { console.log('\n' + fouten + ' test(s) mislukt.'); process.exit(1); }
console.log('\nAlle quantity-unit-tests geslaagd.');
