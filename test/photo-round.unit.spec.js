'use strict';
// Unit-tests voor src/photo-round.js (contract mjop_scan_proposal_v2, samenvoegen, bronnen) tegen src/quantity.js.   node test/photo-round.unit.spec.js
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var PR = require('../src/photo-round.js');
var Q = require('../src/quantity.js');

var fouten = 0;
function test(naam, fn) { try { fn(); console.log('OK   - ' + naam); } catch (e) { fouten++; console.log('FOUT - ' + naam + '\n       ' + e.message); } }
function load(n) { return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'photo-round', n), 'utf8')); }
function clone(x) { return JSON.parse(JSON.stringify(x)); }
var COUNT = load('count_building_v2.json'), AREA = load('area_building_incomplete_v2.json');
var REF = COUNT.project.plan_ref;

test('fixtures voldoen aan het contract', function () {
  assert.deepStrictEqual(PR.validateProposal(COUNT), { ok: true, errors: [] });
  assert.deepStrictEqual(PR.validateProposal(AREA), { ok: true, errors: [] });
});
test('streng: andere versie, onbekend veld, boeking toegestaan, bevestigd-vanuit-scanner worden geweigerd', function () {
  var a = clone(COUNT); a.contract = 'mjop_scan_proposal_v1'; assert.strictEqual(PR.validateProposal(a).ok, false);
  a = clone(COUNT); a.extra = 1; assert.strictEqual(PR.validateProposal(a).ok, false);
  a = clone(COUNT); a.booking_allowed = true; assert.strictEqual(PR.validateProposal(a).ok, false);
  a = clone(COUNT); a.confirmation.status = 'CONFIRMED_BY_USER'; assert.strictEqual(PR.validateProposal(a).ok, false);
  a = clone(COUNT); a.confirmation.uncertainty_acknowledged = true; assert.strictEqual(PR.validateProposal(a).ok, false);
  assert.strictEqual(PR.validateProposal(null).ok, false);
  assert.strictEqual(PR.validateProposal('x').ok, false);
});
test('inhoudelijke regels: oppervlak met onbemeten kozijnen mag geen waarde hebben; eenheid hoort bij soort', function () {
  var a = clone(AREA); a.value = 17.4; assert.strictEqual(PR.validateProposal(a).ok, false);
  a = clone(COUNT); a.target.unit = 'm2'; assert.strictEqual(PR.validateProposal(a).ok, false);
  a = clone(COUNT); a.value = null; a.reliability.level = 'CHECK_REQUIRED'; assert.strictEqual(PR.validateProposal(a).ok, false);
  a = clone(COUNT); a.basis.objects_measured = 3; assert.strictEqual(PR.validateProposal(a).ok, false);
  a = clone(COUNT); a.reliability.reasons = ['CROSS_SESSION_UNCHECKED']; assert.strictEqual(PR.validateProposal(a).ok, false);   // onzekerheid moet benoemd zijn
  a = clone(COUNT); a.target.scope = { type: 'FACADE', facade_id: null, orientation: null }; assert.strictEqual(PR.validateProposal(a).ok, false);
  a = clone(COUNT); a.value = -1; assert.strictEqual(PR.validateProposal(a).ok, false);
});
test('merge: voorstellen komen erin; opnieuw aanbieden is idempotent en laat beslissingen staan', function () {
  var pr = PR.newState(REF);
  var r1 = PR.merge(pr, [COUNT, AREA], REF);
  assert.strictEqual(r1.added.length, 2); assert.strictEqual(pr.proposals.length, 2);
  pr.proposals[0].ui.status = 'REJECTED';
  var r2 = PR.merge(pr, [COUNT, AREA], REF);
  assert.strictEqual(r2.added.length, 0); assert.strictEqual(r2.duplicates, 2);
  assert.strictEqual(pr.proposals[0].ui.status, 'REJECTED');
});
test('merge: verkeerde projectkoppeling wordt niet toegepast', function () {
  var pr = PR.newState('plan-andere-xxxxxxx');
  var r = PR.merge(pr, [COUNT], 'plan-andere-xxxxxxx');
  assert.strictEqual(r.foreign, 1); assert.strictEqual(pr.proposals.length, 0);
  var r2 = PR.merge(PR.newState(REF), [COUNT], 'plan-andere-xxxxxxx');   // staat en context verschillen
  assert.strictEqual(r2.added.length, 0);
});
test('merge: ongeldige voorstellen worden gemeld en niet opgeslagen', function () {
  var bad = clone(COUNT); bad.proposal_id = 'ander-id-1234'; bad.booking_allowed = true;
  var pr = PR.newState(REF);
  var r = PR.merge(pr, [bad], REF);
  assert.strictEqual(r.invalid.length, 1); assert.strictEqual(pr.proposals.length, 0);
});
test('merge: nieuwere revisie vervangt een onbeslist voorstel (SUPERSEDED) maar nooit een beslist voorstel', function () {
  var pr = PR.newState(REF);
  PR.merge(pr, [COUNT], REF);
  var v2 = clone(COUNT); v2.proposal_id = 'r1a2b3c4-count-bld-r2'; v2.revision = 2; v2.value = 13; v2.basis.objects_total = 13; v2.basis.objects_measured = 11;
  var r = PR.merge(pr, [v2], REF);
  assert.strictEqual(r.superseded, 1); assert.strictEqual(pr.proposals[0].ui.status, 'SUPERSEDED'); assert.strictEqual(pr.proposals[1].ui.status, 'PROPOSED');
  var pr2 = PR.newState(REF); PR.merge(pr2, [COUNT], REF); pr2.proposals[0].ui.status = 'IN_USE';
  PR.merge(pr2, [v2], REF);
  assert.strictEqual(pr2.proposals[0].ui.status, 'IN_USE');
});
test('bron: toevoegen verandert de effectieve hoeveelheid NIET; handmatige waarde blijft', function () {
  var q = Q.create(Q.autoQuantity(8, 'st', Q.SOURCES.ESTIMATED, 'schatting'));
  Q.override(q, 9, '9');
  var entry = { p: COUNT, ui: { status: 'PROPOSED', corrected: null } };
  var ev = PR.evidenceFor(entry, Q);
  assert.strictEqual(ev.source, 'PHOTO_WALK_SCAN'); assert.strictEqual(ev.uncertain, true); assert.strictEqual(ev.unit, 'st');
  assert.strictEqual(Q.addEvidence(q, ev), true);
  assert.strictEqual(q.value, 9); assert.strictEqual(q.source, Q.SOURCES.MANUAL); assert.strictEqual(q.status, Q.STATUS.USER_OVERRIDDEN);
  assert.strictEqual(Q.addEvidence(q, ev), false, 'tweede keer: al aanwezig, niet overschreven');
});
test('bron kiezen: zonder bevestiging van de onzekerheid niet; met bevestiging wel, handmatige waarde blijft als bron bewaard', function () {
  var q = Q.create(Q.autoQuantity(8, 'st', Q.SOURCES.ESTIMATED, 'schatting'));
  Q.override(q, 9, '9');
  var ev = PR.evidenceFor({ p: COUNT, ui: { status: 'PROPOSED', corrected: null } }, Q);
  Q.addEvidence(q, ev);
  assert.deepStrictEqual(Q.selectEvidence(q, ev.id), { ok: false, error: 'onzekerheid_niet_bevestigd' });
  assert.deepStrictEqual(Q.selectEvidence(q, ev.id, undefined, { acknowledgeUncertainty: false }), { ok: false, error: 'onzekerheid_niet_bevestigd' });
  assert.strictEqual(q.value, 9);
  assert.deepStrictEqual(Q.selectEvidence(q, ev.id, undefined, { acknowledgeUncertainty: true }), { ok: true });
  assert.strictEqual(q.value, 12); assert.strictEqual(q.source, 'PHOTO_WALK_SCAN'); assert.strictEqual(q.status, Q.STATUS.CONFIRMED);
  assert.ok(Q.findEvidence(q, 'manual-1'), 'de eerdere handmatige waarde blijft als bron bestaan');
  assert.ok(q.history.some(function (h) { return h.event === 'SOURCE_SELECTED' && h.source === 'PHOTO_WALK_SCAN'; }));
});
test('andere eenheid: m2-voorstel kan niet op een stuks-hoeveelheid gekozen worden', function () {
  var q = Q.create(Q.autoQuantity(8, 'st', Q.SOURCES.ESTIMATED, 'schatting'));
  var a = clone(AREA); a.value = 17.4; a.basis.objects_unmeasured = 0; a.basis.objects_measured = 12; a.reliability = { level: 'CHECK_REQUIRED', reasons: ['UNVALIDATED_LIDAR'] };
  assert.strictEqual(PR.validateProposal(a).ok, true);
  var ev = PR.evidenceFor({ p: a, ui: { corrected: null } }, Q);
  Q.addEvidence(q, ev);
  assert.deepStrictEqual(Q.selectEvidence(q, ev.id, undefined, { acknowledgeUncertainty: true }), { ok: false, error: 'andere_eenheid' });
});
test('correctie door de gebruiker wordt vastgelegd naast de oorspronkelijke waarde', function () {
  var ev = PR.evidenceFor({ p: COUNT, ui: { corrected: 11 } }, Q);
  assert.strictEqual(ev.value, 11); assert.strictEqual(ev.source_ref.original_value, 12); assert.strictEqual(ev.source_ref.corrected_by_user, true);
  assert.ok(/gecorrigeerd/.test(ev.basis));
});
test('onbekende waarde (null) wordt nooit een bron met waarde 0 en is niet te kiezen', function () {
  var c = clone(COUNT); c.value = null; c.basis = { objects_total: 0, objects_measured: 0, objects_unmeasured: 0, photos: 1, duplicates_unresolved: 0, cross_session_unchecked: false, excluded_objects: 0 };
  c.reliability = { level: 'INCOMPLETE', reasons: ['NO_OBJECTS', 'UNVALIDATED_LIDAR'] };
  assert.strictEqual(PR.validateProposal(c).ok, true);
  var ev = PR.evidenceFor({ p: c, ui: { corrected: null } }, Q);
  assert.strictEqual(ev.value, null);
  var q = Q.create(Q.autoQuantity(8, 'st', Q.SOURCES.ESTIMATED, 'x'));
  Q.addEvidence(q, ev);
  assert.deepStrictEqual(Q.selectEvidence(q, ev.id, undefined, { acknowledgeUncertainty: true }), { ok: false, error: 'geen_waarde' });
  assert.strictEqual(q.value, 8);
});
test('doelposten: alleen kozijnrijen van het gevraagde element; m2 heeft geen kiesbare doelpost', function () {
  var els = [{ id: 'kozijnen-onderhoud', naam: 'Onderhoud buitenkozijnen', type: 'kozijnen', koz: [{ naam: 'Draaiend raam', quantity: {} }, { naam: 'Deur', quantity: {} }] },
    { id: 'dak-plat', naam: 'Dak', type: 'dak', quantity: {} }];
  var t = PR.targetsFor(COUNT, els);
  assert.deepStrictEqual(t.map(function (x) { return x.id; }), ['kozijnen-onderhoud:0', 'kozijnen-onderhoud:1']);
  assert.strictEqual(PR.targetsFor(AREA, els).length, 0);
  var other = clone(COUNT); other.target.element_key = 'iets-anders';
  assert.strictEqual(PR.targetsFor(other, els).length, 0);
});
test('brug: receive accepteert alleen bekende berichttypen en versie', function () {
  var got = []; PR.onMessage(function (m) { got.push(m); });
  assert.strictEqual(PR.receive({ v: 1, type: 'proposals', proposals: [] }), true);
  assert.strictEqual(PR.receive({ v: 2, type: 'proposals' }), false);
  assert.strictEqual(PR.receive({ v: 1, type: 'evil' }), false);
  assert.strictEqual(PR.receive('x'), false);
  assert.strictEqual(got.length, 1);
});
test('brug: send zonder native handler geeft null (gewone website)', function () {
  assert.strictEqual(PR.available({}), false);
  assert.strictEqual(PR.send('listProposals', {}, {}), null);
  var posted = [];
  var win = { webkit: { messageHandlers: { mjopNative: { postMessage: function (m) { posted.push(m); } } } } };
  assert.strictEqual(PR.available(win), true);
  var id = PR.send('listProposals', { planRef: REF }, win);
  assert.ok(id); assert.strictEqual(posted[0].v, 1); assert.strictEqual(posted[0].action, 'listProposals'); assert.strictEqual(posted[0].requestId, id);
});

if (fouten) { console.log(fouten + ' test(s) mislukt.'); process.exitCode = 1; } else console.log('Alle photo-round-unit-tests geslaagd.');
