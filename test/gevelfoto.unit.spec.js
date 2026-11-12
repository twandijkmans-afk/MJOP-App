'use strict';
// Unittest src/gevelfoto.js (contract mjop_gevelfoto_v1): validatie, samenvoegen, som over gevels, bron voor de gevelposten, uitwisseling.
//   node test/gevelfoto.unit.spec.js
var GF = require('../src/gevelfoto.js');
var Q = require('../src/quantity.js');
var checks = [];
function check(n, ok, d) { checks.push([n, !!ok, d]); }
function clone(x) { return JSON.parse(JSON.stringify(x)); }
var PLAN = 'plan-0123456789abcdef01234567';
function res(patch) {
  var r = {
    contract: 'mjop_gevelfoto_v1', result_id: 'gf-0000000000000001', created_at: '2026-11-12T10:00:00.000Z', plan_ref: PLAN,
    building: { address: 'Teststraat 1, 1234AB Testdorp', bag_pand_id: '0000100000000001' },
    facade: { side_facing: 'zuid', side_length_m: 14, side_index: 0, sides_total: 4 },
    scale: { method: 'REFERENCE_LINE', source: 'BAG_FOOTPRINT_SIDE', placement: 'AUTO_WALL_WIDTH', perspective_corrected: false, check_deviation_pct: null },
    recognition: { provider: 'anthropic', model: 'claude-opus-5-5' }, capture: { level: true, pitch_deg: 1, roll_deg: 0 },
    quantities: { masonry_net_m2: { value: 103.14, unit: 'm2', elements: 1 }, masonry_gross_m2: { value: 119, unit: 'm2', elements: 1 }, frame_area_m2: { value: 15.86, unit: 'm2', elements: 6 },
      window_frames_st: { value: 5, unit: 'st', elements: 5 }, door_frames_st: { value: 1, unit: 'st', elements: 1 }, downpipe_m1: { value: 8.46, unit: 'm1', elements: 1 }, gutter_m1: { value: null, unit: 'm1', elements: 0 } },
    status: 'PROPOSED', validated: false, booking_allowed: false,
  };
  Object.keys(patch || {}).forEach(function (k) { r[k] = patch[k]; });
  return r;
}
function mut(f) { var r = res(); f(r); return GF.validate(r).ok; }

check('1. geldig voorbeeld wordt aangenomen', GF.validate(res()).ok, GF.validate(res()).errors.join('; '));
var rejected = [
  ['boeking toegestaan', function (r) { r.booking_allowed = true; }], ['gevalideerd geclaimd', function (r) { r.validated = true; }], ['andere status', function (r) { r.status = 'CONFIRMED'; }],
  ['andere contractversie', function (r) { r.contract = 'mjop_gevelfoto_v2'; }], ['extra veld (bijv. een prijs)', function (r) { r.price = 26; }], ['geen maat', function (r) { r.scale = null; }],
  ['netto groter dan bruto', function (r) { r.quantities.masonry_net_m2.value = 130; }], ['waarde zonder elementen', function (r) { r.quantities.gutter_m1.value = 0; }],
  ['elementen zonder waarde', function (r) { r.quantities.downpipe_m1.value = null; }], ['aantal wijkt af van de elementen', function (r) { r.quantities.window_frames_st.value = 6; }],
  ['negatieve hoeveelheid', function (r) { r.quantities.masonry_net_m2.value = -1; }], ['geen getal', function (r) { r.quantities.masonry_net_m2.value = '103'; }],
  ['pand-id geen 16 cijfers', function (r) { r.building.bag_pand_id = '123'; }], ['zijde buiten de omtrek', function (r) { r.facade.side_index = 4; }],
  ['BAG-maat zonder gevelzijde', function (r) { r.facade.side_facing = null; }], ['plaatsing bij eigen maat', function (r) { r.scale.source = 'USER_INPUT'; }],
  ['ontbrekende hoeveelheid', function (r) { delete r.quantities.gutter_m1; }], ['plan_ref met vreemde tekens', function (r) { r.plan_ref = 'plan <script>'; }],
];
var wrong = rejected.filter(function (x) { return mut(x[1]); }).map(function (x) { return x[0]; });
check('2. ' + rejected.length + ' ongeldige varianten worden geweigerd', wrong.length === 0, wrong.join(', '));

var pr = { planRef: PLAN };
var rep = GF.merge(pr, [res(), res(), res({ plan_ref: 'plan-ander-project-xxxxxxxxx' }), res({ result_id: 'gf-kapot00000000001', booking_allowed: true })], PLAN);
check('3. samenvoegen: zelfde resultaat telt één keer, ander project en ongeldig worden niet toegepast', rep.added.length === 1 && rep.foreign === 1 && rep.invalid.length === 1 && GF.current(pr).length === 1, JSON.stringify(rep));

var t = GF.total(pr, 'masonry_net_m2');
check('4. som bij één gevel + dekking 1 van de 4 zijden', t.value === 103.14 && t.facades === 1 && t.coverage.covered === 1 && t.coverage.total === 4, JSON.stringify(t));

GF.merge(pr, [res({ result_id: 'gf-0000000000000002', created_at: '2026-11-12T11:00:00.000Z', facade: { side_facing: 'noord', side_length_m: 14, side_index: 2, sides_total: 4 },
  quantities: Object.assign(clone(res().quantities), { masonry_net_m2: { value: 96.86, unit: 'm2', elements: 1 }, masonry_gross_m2: { value: 110, unit: 'm2', elements: 1 } }) })], PLAN);
t = GF.total(pr, 'masonry_net_m2');
check('5. tweede gevel: som 200 m2, 2 van de 4 zijden', t.value === 200 && t.facades === 2 && t.coverage.covered === 2, JSON.stringify(t));

var rep2 = GF.merge(pr, [res({ result_id: 'gf-0000000000000003', created_at: '2026-11-12T12:00:00.000Z',
  quantities: Object.assign(clone(res().quantities), { masonry_net_m2: { value: 100, unit: 'm2', elements: 1 } }) })], PLAN);
t = GF.total(pr, 'masonry_net_m2');
check('6. nieuwere foto van dezelfde gevelzijde vervangt de oudere (geen dubbeltelling)', rep2.replaced === 1 && GF.current(pr).length === 2 && t.value === 196.86, JSON.stringify([rep2, t]));

var noWall = Object.assign(clone(res().quantities), { masonry_net_m2: { value: null, unit: 'm2', elements: 0 }, masonry_gross_m2: { value: null, unit: 'm2', elements: 0 } });
var pr2 = { planRef: PLAN }; GF.merge(pr2, [res({ quantities: noWall })], PLAN);
check('7. onbekend blijft onbekend: geen metselwerk aangevinkt -> geen som en geen bron', GF.total(pr2, 'masonry_net_m2').value === null && GF.total(pr2, 'masonry_net_m2').without === 1 && GF.evidenceFor(pr2, 'masonry_net_m2', Q) === null);

var ev = GF.evidenceFor(pr, 'masonry_net_m2', Q);
check('8. bron: voorstel-bron, onzeker, met herkomst en dekking; geen prijs', ev && ev.source === Q.SOURCES.PHOTO_WALK_SCAN && ev.uncertain === true && ev.unit === 'm2' && ev.value === 196.86 && ev.source_ref.complete === false &&
  ev.source_ref.result_ids.length === 2 && /2 van de 4 gevelzijden/.test(ev.basis) && !/€|kengetal|prijs/i.test(JSON.stringify(ev)), JSON.stringify(ev));
check('9. alleen metselwerk hoort bij een post; kozijnen en afvoeren niet', GF.evidenceFor(pr, 'window_frames_st', Q) === null && GF.evidenceFor(pr, 'downpipe_m1', Q) === null && JSON.stringify(GF.TARGETS) === JSON.stringify({ masonry_net_m2: ['gevel-metselwerk', 'voegwerk'] }));

// de bron gedraagt zich in het hoeveelheidsobject als elk ander voorstel: toevoegen verandert niets, kiezen vraagt bevestiging
var q = Q.fromLegacy(420, { value: 420, unit: 'm2', source: Q.SOURCES.ESTIMATED });
var before = Q.effectiveValue ? Q.effectiveValue(q) : q.value;
Q.addEvidence(q, ev);
var afterAdd = Q.effectiveValue ? Q.effectiveValue(q) : q.value;
var noAck = Q.selectEvidence(q, ev.id), withAck = Q.selectEvidence(q, ev.id, undefined, { acknowledgeUncertainty: true });
var afterUse = Q.effectiveValue ? Q.effectiveValue(q) : q.value;
check('10. toevoegen verandert de hoeveelheid niet; kiezen kan alleen met bevestiging van de onzekerheid', before === 420 && afterAdd === 420 && !noAck.ok && withAck.ok && afterUse === 196.86, JSON.stringify([before, afterAdd, noAck, withAck, afterUse]));

pr.gevelfotoSources = { 'gevel-metselwerk': { evidenceId: ev.id, resultIds: ev.source_ref.result_ids, status: 'IN_USE' } };
var usedId = ev.source_ref.result_ids[0];
GF.remove(pr, usedId);
check('11. een verwijderde foto waar een bron naar verwijst blijft bewaard (herkomst herleidbaar), maar telt niet meer mee', GF.entries(pr).some(function (x) { return x.res.result_id === usedId && x.ui.status === 'REMOVED'; }) && GF.current(pr).length === 1);

var w = GF.warnings(res({ capture: { level: false, pitch_deg: 12, roll_deg: 0 }, scale: { method: 'REFERENCE_LINE', source: 'BAG_FOOTPRINT_SIDE', placement: 'AUTO_WALL_WIDTH', perspective_corrected: false, check_deviation_pct: 24 } }));
check('12. waarschuwingen: scheve foto, automatische maat, afwijkende controlemaat', w.length === 4 && /niet recht/.test(w[0]) && /24%/.test(w.join(' ')), w.join(' | '));

function store(init) { var m = init || {}; return { getItem: function (k) { return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null; }, setItem: function (k, v) { m[k] = String(v); }, removeItem: function (k) { delete m[k]; }, _m: m }; }
var st = store(); var box = {}; box[GF.OUTBOX_KEY] = JSON.stringify([res(), res({ plan_ref: 'plan-ander-project-xxxxxxxxx', created_at: new Date().toISOString() }), 'rommel', res({ plan_ref: 'plan-oud-project-xxxxxxxxxxx', created_at: '2020-01-01T00:00:00.000Z' })]);
st = store(box);
var mine = GF.takeOutbox(st, PLAN);
var left = JSON.parse(st.getItem(GF.OUTBOX_KEY));
check('13. opslag: alleen de resultaten van dit plan worden opgehaald; die van een ander plan blijven staan, oude en rommel vervallen', mine.length === 1 && left.length === 1 && left[0].plan_ref === 'plan-ander-project-xxxxxxxxx', JSON.stringify([mine.length, left.length]));
var st2 = store((function () { var o = {}; o[GF.OUTBOX_KEY] = '{geen json'; return o; })());
check('14. kapotte opslag geeft niets en wordt opgeruimd', GF.takeOutbox(st2, PLAN).length === 0 && st2.getItem(GF.OUTBOX_KEY) === null);
check('15. verzoek schrijven', GF.writeRequest(st2, PLAN, 'Teststraat 1', '0000100000000001', 'http://localhost/x') && JSON.parse(st2.getItem(GF.REQUEST_KEY)).planRef === PLAN);

var failed = checks.filter(function (c) { return !c[1]; });
checks.forEach(function (c) { console.log((c[1] ? 'OK   - ' : 'FAIL - ') + c[0] + (c[1] ? '' : ' [' + c[2] + ']')); });
console.log(failed.length ? failed.length + ' controle(s) mislukt.' : 'Alle controles geslaagd.');
process.exit(failed.length ? 1 : 0);
