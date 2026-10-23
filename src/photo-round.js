// Fotoronde (iPhone-scanner -> MJOP): contract `mjop_scan_proposal_v2`, validatie, samenvoegen en de brug naar de native app.
//
// Principes (zie ook mjop-learning photo_walk/docs/mjop_integration.md):
// - Een scan levert VOORSTELLEN, nooit een boeking. Een voorstel wordt pas een bron naast de bestaande hoeveelheid (Q.addEvidence) en pas daarna,
//   na uitdrukkelijke keuze + bevestiging van de onzekerheid, de effectieve hoeveelheid (Q.selectEvidence). Een handmatige waarde wordt nooit overschreven.
// - Onderscheid: detectie (kader op foto) -> meting (maat) -> voorstel (dit contract) -> menselijke bevestiging -> effectieve MJOP-hoeveelheid.
// - Elk bericht van de app wordt gecontroleerd op contract, versie en projectcontext (plan_ref) vóór het in het plan komt.
// Zonder DOM/netwerk testbaar in Node (test/photo-round.unit.spec.js).
(function (root) {
  'use strict';

  var CONTRACT = 'mjop_scan_proposal_v2';
  var BRIDGE_VERSION = 1;
  var KINDS = { FRAME_COUNT: 'st', FRAME_AREA_GROSS: 'm2' };
  var STATUSES = ['MEASURED', 'DERIVED', 'ESTIMATED', 'UNKNOWN'];
  var METHODS = ['LIDAR_DEPTH_PLANE', 'LIDAR_DEPTH_MULTI_FRAME', 'AR_TRIANGULATION_VIO', 'REFERENCE_DISTANCE', 'MANUAL_CORNERS', 'NONE'];
  var ORIENTATIONS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  var REASON_LABELS = {
    UNMEASURED_OBJECTS: 'Bij een deel van de kozijnen kon geen maat bepaald worden',
    DUPLICATES_UNRESOLVED: 'Mogelijk dubbel getelde kozijnen (zelfde kozijn op meerdere foto\'s) zijn niet beoordeeld',
    CROSS_SESSION_UNCHECKED: 'Foto\'s van verschillende scanmomenten worden niet automatisch aan elkaar gekoppeld: controleer overlap',
    UNVALIDATED_LIDAR: 'LiDAR-onzekerheid is nog niet gevalideerd op echte gebouwen',
    NO_OBJECTS: 'Geen kozijnen gevonden',
    AUTO_DETECTED: 'Kozijnen zijn automatisch herkend en nog niet allemaal door een persoon bevestigd',
  };
  var KIND_LABELS = { FRAME_COUNT: 'Aantal kozijnen', FRAME_AREA_GROSS: 'Bruto kozijnoppervlak' };
  var ORIENT_LABELS = { N: 'noord', NE: 'noordoost', E: 'oost', SE: 'zuidoost', S: 'zuid', SW: 'zuidwest', W: 'west', NW: 'noordwest' };

  function isObj(x) { return x !== null && typeof x === 'object' && !Array.isArray(x); }
  function isStr(x, min, max) { return typeof x === 'string' && x.length >= (min || 0) && x.length <= (max || 500); }
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function isInt(x) { return isNum(x) && Math.floor(x) === x && x >= 0; }
  function isNullOr(x, f) { return x === null || f(x); }
  function hasOnly(o, keys) { return Object.keys(o).every(function (k) { return keys.indexOf(k) >= 0; }); }
  function arr(x, f, max) { return Array.isArray(x) && x.length <= (max || 500) && x.every(f); }

  // -------------------------------------------------------------------
  // Validatie van een voorstel (streng, gesloten schema: onbekende velden = fout)
  // -------------------------------------------------------------------
  function validateProposal(p) {
    var e = [];
    function req(c, m) { if (!c) e.push(m); }
    if (!isObj(p)) return { ok: false, errors: ['geen object'] };
    req(hasOnly(p, ['contract', 'proposal_id', 'round_id', 'revision', 'created_at', 'project', 'target', 'value', 'partial_value', 'basis', 'measurement', 'evidence', 'reliability', 'confirmation', 'booking_allowed']), 'onbekende velden');
    req(p.contract === CONTRACT, 'contract/versie');
    req(isStr(p.proposal_id, 8, 80) && /^[A-Za-z0-9_.-]+$/.test(p.proposal_id), 'proposal_id');
    req(isStr(p.round_id, 8, 80) && /^[A-Za-z0-9_.-]+$/.test(p.round_id), 'round_id');
    req(isInt(p.revision) && p.revision >= 1, 'revision');
    req(isStr(p.created_at, 10, 40), 'created_at');
    var pr = p.project;
    req(isObj(pr) && isStr(pr.plan_ref, 8, 80) && isNullOr(pr.mjop_plan_id, function (x) { return isStr(x, 1, 80); }) && isStr(pr.building_id, 1, 200) && isNullOr(pr.bag_pand_id, function (x) { return /^\d{16}$/.test(x); }), 'project');
    var t = p.target;
    req(isObj(t) && Object.prototype.hasOwnProperty.call(KINDS, t.quantity_kind) && t.unit === KINDS[t.quantity_kind] && isNullOr(t.element_key, function (x) { return isStr(x, 1, 80); }) &&
      isObj(t.scope) && (t.scope.type === 'BUILDING' || t.scope.type === 'FACADE') && isNullOr(t.scope.facade_id, function (x) { return isStr(x, 1, 120); }) &&
      isNullOr(t.scope.orientation, function (x) { return ORIENTATIONS.indexOf(x) >= 0; }) && (t.scope.type === 'BUILDING' || t.scope.facade_id !== null), 'target');
    req(isNullOr(p.value, function (x) { return isNum(x) && x >= 0; }), 'value');
    req(isNullOr(p.partial_value, function (x) { return isNum(x) && x >= 0; }), 'partial_value');
    var b = p.basis;
    req(isObj(b) && isInt(b.objects_total) && isInt(b.objects_measured) && isInt(b.objects_unmeasured) && isInt(b.photos) && isInt(b.duplicates_unresolved) &&
      typeof b.cross_session_unchecked === 'boolean' && isInt(b.excluded_objects) && b.objects_measured + b.objects_unmeasured === b.objects_total, 'basis');
    var m = p.measurement;
    req(isObj(m) && arr(m.methods, function (x) { return METHODS.indexOf(x) >= 0; }, 20) && STATUSES.indexOf(m.dimension_status) >= 0 && isObj(m.uncertainty) &&
      typeof m.uncertainty.validated === 'boolean' && isNullOr(m.uncertainty.area_sigma_m2, isNum) && isStr(m.uncertainty.note, 0, 300), 'measurement');
    var ev = p.evidence;
    req(isObj(ev) && arr(ev.photo_ids, function (x) { return isStr(x, 1, 80); }) && arr(ev.object_ids, function (x) { return isStr(x, 1, 80); }) &&
      arr(ev.quality_flags, function (x) { return isStr(x, 1, 80); }) && isObj(ev.detection) && isInt(ev.detection.auto_detected) && isInt(ev.detection.user_corrected) && isInt(ev.detection.manual), 'evidence');
    var r = p.reliability;
    req(isObj(r) && (r.level === 'CHECK_REQUIRED' || r.level === 'INCOMPLETE') && arr(r.reasons, function (x) { return isStr(x, 1, 60); }, 20), 'reliability');
    var c = p.confirmation;
    req(isObj(c) && c.status === 'PROPOSED' && c.uncertainty_acknowledged === false && c.confirmed_at === null, 'confirmation (een voorstel uit de scanner is altijd PROPOSED)');
    req(p.booking_allowed === false, 'booking_allowed moet false zijn');
    // inhoudelijke regels
    if (e.length === 0) {
      if (p.value === null && r.level !== 'INCOMPLETE') e.push('waarde ontbreekt maar voorstel is niet INCOMPLETE');
      if (p.value !== null && b.objects_total === 0) e.push('waarde zonder kozijnen');
      if (t.quantity_kind === 'FRAME_AREA_GROSS' && p.value !== null && b.objects_unmeasured > 0) e.push('oppervlak mag niet gepubliceerd worden als een deel onbemeten is');
      if (t.quantity_kind === 'FRAME_AREA_GROSS' && p.value !== null && m.dimension_status === 'UNKNOWN') e.push('oppervlak zonder maatstatus');
      if (!m.uncertainty.validated && r.reasons.indexOf('UNVALIDATED_LIDAR') < 0) e.push('niet-gevalideerde onzekerheid moet als reden vermeld zijn');
    }
    return { ok: e.length === 0, errors: e };
  }

  function scopeKey(p) {
    var t = p.target;
    return [p.round_id, t.quantity_kind, t.scope.type, t.scope.facade_id || '-'].join('|');
  }

  // -------------------------------------------------------------------
  // Samenvoegen in het plan: idempotent, projectcontext afgedwongen, niets overschreven
  // -------------------------------------------------------------------
  // photoRound = { planRef, proposals: [ { p, ui } ], ... }.  ui.status: PROPOSED | SOURCE_ADDED | IN_USE | REJECTED | SUPERSEDED
  function newState(planRef) { return { planRef: planRef, proposals: [], rounds: [], planned: [] }; }

  function merge(photoRound, incoming, planRef) {
    var rep = { added: [], duplicates: 0, foreign: 0, invalid: [], superseded: 0 };
    if (!photoRound || !planRef || photoRound.planRef !== planRef) { rep.invalid.push('geen projectcontext'); return rep; }
    (incoming || []).forEach(function (p) {
      var v = validateProposal(p);
      if (!v.ok) { rep.invalid.push((p && p.proposal_id) || '?'); return; }
      if (p.project.plan_ref !== planRef) { rep.foreign++; return; }          // verkeerde projectkoppeling: nooit toepassen
      var exists = photoRound.proposals.some(function (x) { return x.p.proposal_id === p.proposal_id; });
      if (exists) { rep.duplicates++; return; }                                // idempotent; beslissingen van de gebruiker blijven staan
      var k = scopeKey(p);
      photoRound.proposals.forEach(function (x) {
        if (scopeKey(x.p) === k && x.p.revision < p.revision && x.ui.status === 'PROPOSED') { x.ui.status = 'SUPERSEDED'; rep.superseded++; }
      });
      photoRound.proposals.push({ p: p, ui: { status: 'PROPOSED', targetId: null, corrected: null, decidedAt: null } });
      rep.added.push(p.proposal_id);
    });
    return rep;
  }

  // Waarde die de gebruiker na controle wil gebruiken (gecorrigeerd of voorgesteld). null = niets bruikbaars.
  function effectiveValue(entry) {
    if (entry.ui.corrected != null && isNum(entry.ui.corrected)) return entry.ui.corrected;
    return entry.p.value;
  }

  // Bron (evidence) voor het hoeveelhedenobject. Nooit effectief bij toevoegen (Q.addEvidence verandert de effectieve waarde niet).
  function evidenceFor(entry, Q) {
    var p = entry.p, val = effectiveValue(entry);
    var corrected = entry.ui.corrected != null && val !== p.value;
    var kind = KIND_LABELS[p.target.quantity_kind];
    var basis = kind + ' uit fotoronde: ' + Q.formatNumber(val) + ' ' + Q.unitLabel(p.target.unit) + ' (' + p.basis.objects_total + ' kozijnen op ' + p.basis.photos + ' foto\'s' +
      (p.target.scope.type === 'FACADE' ? ', gevel ' + p.target.scope.facade_id : ', hele gebouw') + '). Voorlopig, niet gevalideerd' + (corrected ? '; door jou gecorrigeerd (voorstel was ' + Q.formatNumber(p.value) + ')' : '') + '.';
    return {
      id: 'photowalk:' + p.proposal_id,
      source: Q.SOURCES.PHOTO_WALK_SCAN,
      method_class: 'PHOTO_WALK_PROVISIONAL',
      value: val, unit: p.target.unit, basis: basis,
      uncertain: true,
      source_ref: { proposal_id: p.proposal_id, round_id: p.round_id, revision: p.revision, object_ids: p.evidence.object_ids, photo_ids: p.evidence.photo_ids,
        measurement_methods: p.measurement.methods, dimension_status: p.measurement.dimension_status, original_value: p.value, corrected_by_user: corrected },
      origin: 'PHOTO_WALK',
    };
  }

  // Doelposten waar een voorstel als bron kan worden toegevoegd. st -> rijen van kozijn-elementen; m2 -> geen kiesbare post (alleen referentie).
  function targetsFor(p, elements) {
    var out = [];
    if (p.target.unit !== 'st' || p.target.quantity_kind !== 'FRAME_COUNT') return out;
    (elements || []).forEach(function (el) {
      if (el.type !== 'kozijnen' || !el.koz) return;
      if (p.target.element_key && el.id !== p.target.element_key) return;
      el.koz.forEach(function (k, i) { if (k.quantity) out.push({ id: el.id + ':' + i, elementId: el.id, row: i, label: el.naam + ' — ' + k.naam }); });
    });
    return out;
  }

  function describeReasons(p) { return p.reliability.reasons.map(function (r) { return REASON_LABELS[r] || r; }); }
  function scopeLabel(p) {
    var s = p.target.scope;
    return s.type === 'BUILDING' ? 'Hele gebouw' : 'Gevel ' + s.facade_id + (s.orientation ? ' (' + ORIENT_LABELS[s.orientation] + ')' : '');
  }

  // -------------------------------------------------------------------
  // Brug naar de native app (WKWebView). Alleen aanwezig in MJOP Live; elders is available() false.
  // -------------------------------------------------------------------
  var listener = null, seq = 0;
  function handler(win) {
    try { return win && win.webkit && win.webkit.messageHandlers && win.webkit.messageHandlers.mjopNative || null; } catch (e) { return null; }
  }
  function available(win) { return !!handler(win || (typeof window !== 'undefined' ? window : null)); }
  function send(action, payload, win) {
    var h = handler(win || (typeof window !== 'undefined' ? window : null));
    if (!h) return null;
    var id = 'w' + (++seq) + '-' + Date.now().toString(36);
    h.postMessage({ v: BRIDGE_VERSION, action: action, requestId: id, payload: payload || {} });
    return id;
  }
  // Antwoorden van de app. Alleen bekende types; verder wordt alles door validateProposal/merge gecontroleerd.
  function receive(msg) {
    if (!isObj(msg) || msg.v !== BRIDGE_VERSION || typeof msg.type !== 'string') return false;
    if (['proposals', 'capabilities', 'round-status', 'error'].indexOf(msg.type) < 0) return false;
    if (listener) listener(msg);
    return true;
  }
  function onMessage(fn) { listener = fn; }

  var api = {
    CONTRACT: CONTRACT, BRIDGE_VERSION: BRIDGE_VERSION, KINDS: KINDS, KIND_LABELS: KIND_LABELS, REASON_LABELS: REASON_LABELS, ORIENT_LABELS: ORIENT_LABELS, ORIENTATIONS: ORIENTATIONS,
    validateProposal: validateProposal, newState: newState, merge: merge, scopeKey: scopeKey, effectiveValue: effectiveValue, evidenceFor: evidenceFor,
    targetsFor: targetsFor, describeReasons: describeReasons, scopeLabel: scopeLabel,
    available: available, send: send, receive: receive, onMessage: onMessage,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else {
    root.MJOPPhotoRound = api;
    // De app roept deze functie aan met het antwoord (evaluateJavaScript); zie PhotoRoundBridge in de iPhone-app.
    root.MJOPNativeBridge = { receive: receive };
  }
})(typeof window !== 'undefined' ? window : this);
