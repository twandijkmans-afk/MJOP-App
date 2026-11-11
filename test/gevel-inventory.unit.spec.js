'use strict';
// Unit-tests voor src/gevel-inventory.js (contract mjop_gevel_inventory_v1 van Gevelscanner 2.0) tegen src/quantity.js.   node test/gevel-inventory.unit.spec.js
// De fixture is het voorbeeld dat de iPhone-app zelf produceert (mjop-learning: ios/Tests/GevelscanTests/Fixtures).
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var GI = require('../src/gevel-inventory.js');
var PR = require('../src/photo-round.js');
var Q = require('../src/quantity.js');

var fouten = 0;
function test(naam, fn) { try { fn(); console.log('OK   - ' + naam); } catch (e) { fouten++; console.log('FOUT - ' + naam + '\n       ' + e.message); } }
function clone(x) { return JSON.parse(JSON.stringify(x)); }
var EX = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'gevel-inventory', 'gevel_inventory_v1_example.json'), 'utf8'));
var REF = EX.project.plan_ref;
function kozEl() {
  return { id: 'kozijnen-onderhoud', naam: 'Onderhoud buitenkozijnen', type: 'kozijnen', koz: [['Draaiend raam', 174], ['Vast glas', 96], ['Deur', 240], ['Dakkapel', 320]].map(function (d) {
    return { naam: d[0], tarief: d[1], quantity: Q.create({ value: 10, unit: 'st', source: Q.SOURCES.ESTIMATED, basis: 'schatting' }), eigenTarief: null, materiaal: 'hout' };
  }) };
}
function ok(d) { return GI.validate(d).ok; }

test('het voorbeeld uit de app voldoet aan het contract', function () {
  assert.deepStrictEqual(GI.validate(EX), { ok: true, errors: [] });
});
test('streng: andere versie, onbekend veld, boeking, bevestigd, automatische verwerking worden geweigerd', function () {
  var a = clone(EX); a.contract = 'mjop_scan_proposal_v2'; assert.strictEqual(ok(a), false);
  a = clone(EX); a.extra = 1; assert.strictEqual(ok(a), false);
  a = clone(EX); a.booking_allowed = true; assert.strictEqual(ok(a), false);
  a = clone(EX); a.confirmation.status = 'CONFIRMED_BY_USER'; assert.strictEqual(ok(a), false);
  a = clone(EX); a.validation.auto_processing_allowed = true; assert.strictEqual(ok(a), false);
  assert.strictEqual(ok(null), false); assert.strictEqual(ok('x'), false);
});
test('inhoudelijke regels: niets betrouwbaar zonder validatie, geen NEN-score, glas is geen LiDAR-meting en niet groter dan het kozijn', function () {
  var a = clone(EX); a.facades[0].objects[0].outcome = 'BETROUWBAAR_VASTGESTELD'; assert.strictEqual(ok(a), false);
  a = clone(EX); a.facades[0].objects[0].width.outcome = 'BETROUWBAAR_VASTGESTELD'; assert.strictEqual(ok(a), false);
  a = clone(EX); a.facades[0].completeness = 'BETROUWBAAR_VASTGESTELD'; assert.strictEqual(ok(a), false);
  a = clone(EX); a.facades[0].objects[0].nen2767_condition_score = 2; assert.strictEqual(ok(a), false);
  a = clone(EX); a.facades[0].objects[0].glass_area.origin = 'LIDAR_PLANE_MEASUREMENT'; assert.strictEqual(ok(a), false);
  a = clone(EX); a.facades[0].objects[0].glass_area.value = 50; assert.strictEqual(ok(a), false);
  a = clone(EX); a.facades[0].objects[0].count = 3; assert.strictEqual(ok(a), false);
});
test('onbekend is null met NIET_VAST_TE_STELLEN; een aantal is een geheel getal; geen waarde bij mogelijke dubbeltelling', function () {
  var a = clone(EX); a.facades[0].totals.frame_count.value = null; assert.strictEqual(ok(a), false);
  a = clone(EX); a.facades[0].totals.frame_count.value = 2.5; assert.strictEqual(ok(a), false);
  a = clone(EX); a.facades[0].totals.glass_area.unit = 'st'; assert.strictEqual(ok(a), false);
  a = clone(EX); a.facades[0].objects[0].identity = 'UNCERTAIN'; assert.strictEqual(ok(a), false);
  a = clone(EX); a.facades[0].objects[0].area.value = null; a.facades[0].objects[0].area.outcome = 'NIET_VAST_TE_STELLEN'; assert.strictEqual(ok(a), false);   // totaaloppervlak met een onbemeten kozijn
});
test('door de gebruiker ingevoerde aantallen: per kozijn betrouwbaar (USER_INPUT), het totaal nooit zekerder dan de telling van de kozijnen', function () {
  var withParts = EX.facades[0].objects.filter(function (o) { return o.operable_parts.value !== null; })[0];
  assert.strictEqual(withParts.operable_parts.origin, 'USER_INPUT'); assert.strictEqual(withParts.operable_parts.outcome, 'BETROUWBAAR_VASTGESTELD');
  assert.strictEqual(EX.facades[0].totals.operable_parts.origin, 'USER_INPUT');
  assert.strictEqual(EX.facades[0].totals.operable_parts.outcome, 'VOORLOPIG_VASTGESTELD');
  var a = clone(EX); a.facades[0].objects.filter(function (o) { return o.operable_parts.value !== null; })[0].operable_parts.origin = 'MODEL_CLASSIFICATION';
  assert.strictEqual(ok(a), false);                                                            // betrouwbaar zonder validatie en zonder gebruikersinvoer
});
test('vragen om extra foto\'s en objectklasse worden per element gecontroleerd', function () {
  var a = clone(EX); a.facades[0].capture_requests = [{ kind: 'ANDERE_HOEK', object_id: null, photo_id: null, reason: 'X', text_nl: null }]; assert.strictEqual(ok(a), false);
  a = clone(EX); a.facades[0].capture_requests = [null]; assert.strictEqual(ok(a), false);
  a = clone(EX); a.facades[0].objects[0].element_class = 'GARAGE'; assert.strictEqual(ok(a), false);
});
test('gebouwbrede post: bij meerdere gevels alleen het gebouwtotaal aanbieden; sleutels met | in de gevelnaam', function () {
  assert.ok(EX.facades.length > 1);
  assert.strictEqual(GI.offerScope(EX, null), true); assert.strictEqual(GI.offerScope(EX, EX.facades[0].facade_id), false);
  var one = clone(EX); one.facades = [one.facades[0]];
  assert.strictEqual(GI.offerScope(one, one.facades[0].facade_id), true); assert.strictEqual(GI.offerScope(one, null), false);
  assert.deepStrictEqual(GI.parseScopeKey(GI.scopeKey('Voor|gevel', 'operable_parts')), { facadeId: 'Voor|gevel', kind: 'operable_parts' });
  assert.deepStrictEqual(GI.parseScopeKey('*|door_count'), { facadeId: null, kind: 'door_count' });
  assert.strictEqual(GI.parseScopeKey('x|onbekend'), null); assert.strictEqual(GI.parseScopeKey('zonder'), null);
});
test('samenvoegen: idempotent, ander project nooit, nieuwe revisie vervangt de oude, ongeldig genegeerd', function () {
  var pr = PR.newState(REF);
  var r = GI.merge(pr, [EX], REF);
  assert.deepStrictEqual(r.added, [EX.inventory_id]); assert.strictEqual(GI.current(pr).length, 1);
  r = GI.merge(pr, [EX], REF); assert.strictEqual(r.duplicates, 1); assert.strictEqual(pr.inventories.length, 1);
  var other = clone(EX); other.project.plan_ref = 'plan-anderproject1'; other.inventory_id = 'ander-inventaris-1';
  r = GI.merge(pr, [other], REF); assert.strictEqual(r.foreign, 1); assert.strictEqual(pr.inventories.length, 1);
  var bad = clone(EX); bad.inventory_id = 'kapot-inventaris-1'; bad.booking_allowed = true;
  r = GI.merge(pr, [bad], REF); assert.deepStrictEqual(r.invalid, ['kapot-inventaris-1']);
  var rev2 = clone(EX); rev2.revision = 2; rev2.inventory_id = EX.inventory_id.replace(/r1$/, 'r2');
  r = GI.merge(pr, [rev2], REF); assert.strictEqual(r.superseded, 1);
  assert.deepStrictEqual(GI.current(pr).map(function (x) { return x.inv.revision; }), [2]);
  assert.strictEqual(pr.inventories.length, 1);                                              // de vervangen revisie (niets in gebruik) is opgeruimd
  // ... maar een vervangen revisie waarvan iets in gebruik is blijft bewaard en wordt gemeld
  var pr2 = PR.newState(REF); GI.merge(pr2, [EX], REF);
  pr2.inventories[0].ui.sources['*|operable_parts'] = { evidenceId: 'x', rowId: 'kozijnen-onderhoud:0', status: 'IN_USE' };
  GI.merge(pr2, [rev2], REF);
  assert.strictEqual(pr2.inventories.length, 2); assert.strictEqual(GI.supersededInUse(pr2).length, 1);
  assert.strictEqual(GI.merge(pr, [EX], 'plan-anderproject1').invalid.length, 1);            // verkeerde projectcontext: niets
  assert.strictEqual(GI.merge(null, [EX], REF).invalid.length, 1);
});
test('koppeling aan de bestaande kengetallen: alleen rijen die in de bibliotheek bestaan; anders GEEN_KENGETAL', function () {
  var map = GI.mappingFor(EX.facades[0].totals, kozEl());
  var by = {}; map.forEach(function (m) { by[m.kind] = m; });
  assert.strictEqual(by.operable_parts.rowLabel, 'Onderhoud buitenkozijnen — Draaiend raam'); assert.strictEqual(by.operable_parts.kengetal, 'EIGEN_BIBLIOTHEEK'); assert.strictEqual(by.operable_parts.usable, true);
  assert.strictEqual(by.fixed_parts.rowLabel, 'Onderhoud buitenkozijnen — Vast glas');
  assert.strictEqual(by.door_count.row, 2); assert.strictEqual(by.door_count.usable, false);        // deuren onbekend: niets te gebruiken
  ['frame_count', 'frame_area_gross', 'glass_area'].forEach(function (k) { assert.strictEqual(by[k].kengetal, 'GEEN_KENGETAL'); assert.strictEqual(by[k].rowId, null); assert.ok(by[k].note); });
  // zonder kozijnen-element in het plan is er nergens een kengetal
  assert.ok(GI.mappingFor(EX.facades[0].totals, null).every(function (m) { return m.kengetal === 'GEEN_KENGETAL' && !m.usable; }));
});
test('de module bevat geen prijzen en rekent geen kosten', function () {
  var src = fs.readFileSync(path.join(__dirname, '..', 'src', 'gevel-inventory.js'), 'utf8');
  assert.ok(!/tarief\s*[:=*]|€|\beur\(|kozTarief|\* *\d{2,}/.test(src));
  assert.ok(!/"(prijs|price|kengetal|kosten|tarief)/i.test(JSON.stringify(EX)));
});
test('een hoeveelheid wordt eerst een BRON en pas na bevestiging van de onzekerheid de effectieve hoeveelheid', function () {
  var el = kozEl(), q = el.koz[0].quantity;
  var ev = GI.evidenceFor(EX, EX.facades[0].facade_id, 'operable_parts', Q);
  assert.strictEqual(ev.value, EX.facades[0].totals.operable_parts.value); assert.strictEqual(ev.unit, 'st'); assert.strictEqual(ev.source, Q.SOURCES.PHOTO_WALK_SCAN);
  assert.strictEqual(ev.source_ref.inventory_id, EX.inventory_id); assert.ok(ev.source_ref.object_ids.length >= 1 && ev.source_ref.photo_ids.length >= 1);
  var before = q.value;
  assert.strictEqual(Q.addEvidence(q, ev), true);
  assert.strictEqual(q.value, before);                                                        // toevoegen verandert niets
  assert.strictEqual(Q.addEvidence(q, ev), false);                                            // idempotent
  assert.strictEqual(Q.selectEvidence(q, ev.id).ok, false);                                   // niet zonder bevestiging van de onzekerheid
  assert.strictEqual(Q.selectEvidence(q, ev.id, undefined, { acknowledgeUncertainty: true }).ok, true);
  assert.strictEqual(q.value, ev.value);
});
test('geen bron voor hoeveelheden zonder kengetal of zonder waarde', function () {
  assert.strictEqual(GI.evidenceFor(EX, null, 'glass_area', Q), null);
  assert.strictEqual(GI.evidenceFor(EX, null, 'frame_area_gross', Q), null);
  assert.strictEqual(GI.evidenceFor(EX, EX.facades[0].facade_id, 'door_count', Q), null);     // onbekend: geen bron, geen 0
  assert.strictEqual(GI.evidenceFor(EX, 'bestaat-niet', 'operable_parts', Q), null);
});
test('redenen en vragen om extra foto\'s in gewone taal', function () {
  assert.deepStrictEqual(GI.describeReasons(['GEOMETRIE_NIET_IN_HET_VELD_GEVALIDEERD', 'ONBEKENDE_CODE']), ['de meetmethode is nog niet getoetst aan handmetingen', 'ONBEKENDE_CODE']);
  var a = clone(EX); a.facades[0].capture_requests = [{ kind: 'ANDERE_HOEK', object_id: 'GO-1', photo_id: null, reason: 'ENKEL_STANDPUNT', text_nl: 'Maak nog een foto.' }, { kind: 'ANDERE_HOEK', object_id: 'GO-2', photo_id: null, reason: 'ENKEL_STANDPUNT', text_nl: 'Maak nog een foto.' }];
  assert.deepStrictEqual(GI.requests(a), ['Gevel ' + a.facades[0].facade_id + ': Maak nog een foto.']);
});
test('de bestaande brug laat het nieuwe berichttype door en blijft oude types weigeren', function () {
  var got = null; PR.onMessage(function (m) { got = m; });
  assert.strictEqual(PR.receive({ v: 1, type: 'facade-inventory', planRef: REF, inventories: [] }), true); assert.strictEqual(got.type, 'facade-inventory');
  assert.strictEqual(PR.receive({ v: 1, type: 'iets-anders' }), false);
  assert.strictEqual(PR.receive({ v: 2, type: 'facade-inventory' }), false);
});

if (fouten) { console.log(fouten + ' test(s) mislukt'); process.exit(1); }
console.log('Alle tests geslaagd');
