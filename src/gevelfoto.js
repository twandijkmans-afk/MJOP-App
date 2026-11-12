// Gevelfoto (proefpagina gevelfoto/ -> MJOP): contract `mjop_gevelfoto_v1`, validatie, samenvoegen en de koppeling aan de BESTAANDE
// gevelposten (metselwerk, voegwerk) en hun kengetallen.
//
// Principes (gelijk aan photo-round.js en gevel-inventory.js):
// - Een gevelfoto levert een VOORSTEL. Er wordt niets automatisch een hoeveelheid: de som van de gefotografeerde gevels wordt eerst een bron
//   naast de bestaande hoeveelheid (Q.addEvidence) en pas na uitdrukkelijke keuze + bevestiging van de onzekerheid de effectieve hoeveelheid.
// - Dit bestand bevat GEEN prijzen en rekent GEEN kosten uit; na overname rekent de bestaande post met zijn eigen kengetal.
// - De gevelposten gelden voor het HELE gebouw, een gevelfoto voor ÉÉN gevel. Aangeboden wordt daarom de som van alle actuele gevelfoto's, met
//   erbij hoeveel gevelzijden gefotografeerd zijn. Ontbrekende gevels tellen niet mee en worden niet geschat.
// - Onbekend = null (nooit 0). De herkenning (AI) en de maatvoering (BAG-breedte of eigen maat) zijn niet gevalideerd: altijd "onzeker".
// - De uitwisseling loopt via de browseropslag van dit domein (de proefpagina staat op hetzelfde domein). Wat daar staat wordt behandeld als
//   onbetrouwbare invoer en streng gecontroleerd; alles wat niet klopt wordt geweigerd.
// Zonder DOM/netwerk testbaar in Node (test/gevelfoto.unit.spec.js).
(function (root) {
  'use strict';

  var CONTRACT = 'mjop_gevelfoto_v1';
  var REQUEST_KEY = 'mjop-gevelfoto-request';      // MJOP -> proefpagina: voor welk plan en adres
  var OUTBOX_KEY = 'mjop-gevelfoto-outbox';        // proefpagina -> MJOP: lijst met resultaten
  var FACINGS = ['noord', 'noordoost', 'oost', 'zuidoost', 'zuid', 'zuidwest', 'west', 'noordwest'];
  var KINDS = {
    masonry_net_m2: { unit: 'm2', label: 'Metselwerk netto (bruto min kozijnen en deuren)' },
    masonry_gross_m2: { unit: 'm2', label: 'Metselwerk bruto' },
    frame_area_m2: { unit: 'm2', label: 'Kozijnoppervlak (ramen en deuren)' },
    window_frames_st: { unit: 'st', label: 'Raamkozijnen' },
    door_frames_st: { unit: 'st', label: 'Deurkozijnen' },
    downpipe_m1: { unit: 'm1', label: 'Hemelwaterafvoer' },
    gutter_m1: { unit: 'm1', label: 'Dakgoot' },
  };
  var KIND_KEYS = Object.keys(KINDS);
  // Bestaande posten (sleutels uit ELEMENT_LIBRARY in app.js) waar een hoeveelheid bij hoort. Alleen wat qua eenheid en definitie past:
  // beide posten rekenen per m2 gevel. De overige hoeveelheden worden getoond ter referentie; daar wordt niets uit afgeleid.
  var TARGETS = { masonry_net_m2: ['gevel-metselwerk', 'voegwerk'] };
  var SCALE_METHODS = ['REFERENCE_LINE', 'REFERENCE_RECTANGLE'];
  var SCALE_SOURCES = ['BAG_FOOTPRINT_SIDE', 'USER_INPUT'];
  var PLACEMENTS = ['AUTO_WALL_WIDTH', 'USER_ADJUSTED', 'USER_POINTS'];

  function isObj(x) { return x !== null && typeof x === 'object' && !Array.isArray(x); }
  function isStr(x, min, max) { return typeof x === 'string' && x.length >= (min || 0) && x.length <= (max || 500); }
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function isInt(x) { return isNum(x) && Math.floor(x) === x; }
  function sameKeys(o, keys) { var k = Object.keys(o); return k.length === keys.length && keys.every(function (x) { return Object.prototype.hasOwnProperty.call(o, x); }); }
  function numOrNull(x, lo, hi) { return x === null || (isNum(x) && x >= lo && x <= hi); }
  function round2(v) { return Math.round(v * 100) / 100; }

  // -------------------------------------------------------------------
  // Validatie (streng; alles wat niet klopt wordt geweigerd)
  // -------------------------------------------------------------------
  function validate(d) {
    var e = [];
    if (!isObj(d)) return { ok: false, errors: ['geen object'] };
    if (!sameKeys(d, ['contract', 'result_id', 'created_at', 'plan_ref', 'building', 'facade', 'scale', 'recognition', 'capture', 'quantities', 'status', 'validated', 'booking_allowed'])) e.push('onbekende of ontbrekende velden');
    if (d.contract !== CONTRACT) e.push('contract/versie');
    if (!(isStr(d.result_id, 8, 80) && /^[A-Za-z0-9_.-]+$/.test(d.result_id))) e.push('result_id');
    if (!(isStr(d.created_at, 10, 40) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(d.created_at))) e.push('created_at');
    if (!(isStr(d.plan_ref, 8, 80) && /^[A-Za-z0-9_-]+$/.test(d.plan_ref))) e.push('plan_ref');
    if (d.status !== 'PROPOSED') e.push('status (altijd PROPOSED)');
    if (d.validated !== false) e.push('validated moet false zijn');
    if (d.booking_allowed !== false) e.push('booking_allowed moet false zijn');
    var b = d.building;
    if (!(isObj(b) && sameKeys(b, ['address', 'bag_pand_id']) && (b.address === null || isStr(b.address, 1, 200)) && (b.bag_pand_id === null || (typeof b.bag_pand_id === 'string' && /^\d{16}$/.test(b.bag_pand_id))))) e.push('building');
    var f = d.facade;
    var fOk = isObj(f) && sameKeys(f, ['side_facing', 'side_length_m', 'side_index', 'sides_total']) && (f.side_facing === null || FACINGS.indexOf(f.side_facing) >= 0) && numOrNull(f.side_length_m, 0.5, 1000) &&
      (f.side_index === null || (isInt(f.side_index) && f.side_index >= 0 && f.side_index < 200)) && (f.sides_total === null || (isInt(f.sides_total) && f.sides_total >= 3 && f.sides_total <= 200));
    if (!fOk) e.push('facade');
    else if (f.side_index !== null && f.sides_total !== null && f.side_index >= f.sides_total) e.push('facade: zijde buiten de omtrek');
    var s = d.scale;
    var sOk = isObj(s) && sameKeys(s, ['method', 'source', 'placement', 'perspective_corrected', 'check_deviation_pct']) && SCALE_METHODS.indexOf(s.method) >= 0 && SCALE_SOURCES.indexOf(s.source) >= 0 &&
      (s.placement === null || PLACEMENTS.indexOf(s.placement) >= 0) && typeof s.perspective_corrected === 'boolean' && numOrNull(s.check_deviation_pct, -1000, 100000);
    if (!sOk) e.push('scale (een resultaat zonder maat wordt niet aangenomen)');
    else if ((s.source === 'BAG_FOOTPRINT_SIDE') !== (s.placement !== null)) e.push('scale: plaatsing hoort bij een BAG-maat');
    else if (s.source === 'BAG_FOOTPRINT_SIDE' && fOk && (f.side_length_m === null || f.side_facing === null)) e.push('scale: BAG-maat zonder gevelzijde');
    var r = d.recognition;
    if (!(isObj(r) && sameKeys(r, ['provider', 'model']) && isStr(r.provider, 1, 60) && (r.model === null || isStr(r.model, 1, 80)))) e.push('recognition');
    var c = d.capture;
    if (!(c === null || (isObj(c) && sameKeys(c, ['level', 'pitch_deg', 'roll_deg']) && (c.level === null || typeof c.level === 'boolean') && numOrNull(c.pitch_deg, -90, 90) && numOrNull(c.roll_deg, -90, 90)))) e.push('capture');
    var q = d.quantities;
    if (!(isObj(q) && sameKeys(q, KIND_KEYS))) { e.push('quantities'); return { ok: false, errors: e }; }
    KIND_KEYS.forEach(function (k) {
      var x = q[k], unit = KINDS[k].unit;
      if (!(isObj(x) && sameKeys(x, ['value', 'unit', 'elements']) && x.unit === unit && isInt(x.elements) && x.elements >= 0 && x.elements <= 500 && numOrNull(x.value, 0, 100000))) { e.push('quantities.' + k); return; }
      if (unit === 'st' && x.value !== null && (!isInt(x.value) || x.value !== x.elements)) e.push('quantities.' + k + ': aantal klopt niet met de elementen');
      if (x.elements === 0 && x.value !== null && unit !== 'st') e.push('quantities.' + k + ': waarde zonder elementen (onbekend is null, niet 0)');
      if (x.elements > 0 && x.value === null) e.push('quantities.' + k + ': elementen zonder waarde');
    });
    if (!e.length && q.masonry_net_m2.value !== null && q.masonry_gross_m2.value !== null && q.masonry_net_m2.value > q.masonry_gross_m2.value + 0.01) e.push('quantities: netto groter dan bruto');
    if (!e.length && (q.masonry_net_m2.value === null) !== (q.masonry_gross_m2.value === null)) e.push('quantities: netto en bruto horen bij elkaar');
    return { ok: e.length === 0, errors: e };
  }

  // -------------------------------------------------------------------
  // Samenvoegen in het plan (photoRound.gevelfotos = [{ res, ui }])
  // -------------------------------------------------------------------
  function entries(photoRound) { return (photoRound && Array.isArray(photoRound.gevelfotos)) ? photoRound.gevelfotos : []; }
  function current(photoRound) { return entries(photoRound).filter(function (x) { return x.ui.status === 'CURRENT'; }); }
  function facadeKey(res) { return res.building.bag_pand_id !== null && res.facade.side_index !== null ? res.building.bag_pand_id + ':' + res.facade.side_index : null; }

  // Voegt resultaten toe die bij dit plan horen. Idempotent (zelfde result_id telt één keer). Een nieuwere foto van dezelfde gevelzijde vervangt
  // de oudere. Geeft { added, invalid, foreign, replaced }.
  function merge(photoRound, list, planRef) {
    var rep = { added: [], invalid: [], foreign: 0, replaced: 0 };
    if (!Array.isArray(photoRound.gevelfotos)) photoRound.gevelfotos = [];
    (Array.isArray(list) ? list : []).slice(0, 50).forEach(function (res) {
      var v = validate(res);
      if (!v.ok) { rep.invalid.push(v.errors[0]); return; }
      if (res.plan_ref !== planRef) { rep.foreign++; return; }
      if (photoRound.gevelfotos.some(function (x) { return x.res.result_id === res.result_id; })) return;
      var key = facadeKey(res);
      if (key) photoRound.gevelfotos.forEach(function (x) {
        if (x.ui.status === 'CURRENT' && facadeKey(x.res) === key && x.res.created_at <= res.created_at) { x.ui.status = 'REPLACED'; rep.replaced++; }
      });
      var newer = key && photoRound.gevelfotos.some(function (x) { return x.ui.status === 'CURRENT' && facadeKey(x.res) === key; });
      photoRound.gevelfotos.push({ res: JSON.parse(JSON.stringify(res)), ui: { status: newer ? 'REPLACED' : 'CURRENT' } });
      rep.added.push(res.result_id);
    });
    prune(photoRound);
    return rep;
  }
  function remove(photoRound, resultId) {
    var x = entries(photoRound).filter(function (y) { return y.res.result_id === resultId; })[0];
    if (!x || x.ui.status !== 'CURRENT') return false;
    x.ui.status = 'REMOVED'; prune(photoRound); return true;
  }
  // Vervangen of verwijderde foto's blijven alleen bewaard zolang een toegevoegde bron ernaar verwijst (herkomst moet herleidbaar blijven).
  function prune(photoRound) {
    var used = {};
    Object.keys(photoRound.gevelfotoSources || {}).forEach(function (k) { (photoRound.gevelfotoSources[k].resultIds || []).forEach(function (id) { used[id] = true; }); });
    photoRound.gevelfotos = entries(photoRound).filter(function (x) { return x.ui.status === 'CURRENT' || used[x.res.result_id]; }).slice(-60);
  }

  // -------------------------------------------------------------------
  // Som over de actuele gevelfoto's
  // -------------------------------------------------------------------
  // Dekking: alleen te bepalen als alle foto's van één pand zijn en elk een gevelzijde uit de BAG-omtrek draagt.
  function coverage(list) {
    if (!list.length) return null;
    var pand = list[0].res.building.bag_pand_id, total = list[0].res.facade.sides_total, seen = {};
    if (pand === null || total === null) return null;
    for (var i = 0; i < list.length; i++) {
      var r = list[i].res;
      if (r.building.bag_pand_id !== pand || r.facade.sides_total !== total || r.facade.side_index === null) return null;
      seen[r.facade.side_index] = true;
    }
    return { covered: Object.keys(seen).length, total: total };
  }

  // { kind, unit, value (null = onbekend), facades (aantal gevelfoto's dat meetelt), without (foto's zonder deze hoeveelheid), resultIds, coverage }
  function total(photoRound, kind) {
    var list = current(photoRound), sum = 0, n = 0, without = 0, ids = [];
    list.forEach(function (x) {
      var q = x.res.quantities[kind];
      if (q.value === null) { without++; return; }
      sum += q.value; n++; ids.push(x.res.result_id);
    });
    return { kind: kind, unit: KINDS[kind].unit, label: KINDS[kind].label, value: n ? round2(sum) : null, facades: n, without: without, resultIds: ids.sort(), coverage: coverage(list) };
  }

  // Waarschuwingen per gevelfoto, in gewone taal.
  function warnings(res) {
    var w = [];
    if (res.capture && res.capture.level === false) w.push('de foto is niet recht genomen');
    if (res.scale.method === 'REFERENCE_LINE' && !res.scale.perspective_corrected && !(res.capture && res.capture.level === true)) w.push('niet gecontroleerd of de foto recht van voren is genomen');
    if (res.scale.placement === 'AUTO_WALL_WIDTH') w.push('maat automatisch gezet: breedte van het herkende gevelvlak = BAG-gevelbreedte');
    if (res.scale.check_deviation_pct !== null && Math.abs(res.scale.check_deviation_pct) > 5) w.push('de controlemaat week ' + Math.round(Math.abs(res.scale.check_deviation_pct)) + '% af');
    if (res.scale.source === 'USER_INPUT') w.push('maat zelf opgegeven; niet aan een gevelzijde uit de BAG gekoppeld');
    return w;
  }

  function evidenceId(kind, resultIds) { return 'gevelfoto:' + kind + ':' + resultIds.join('+').slice(0, 400); }

  // Bron (evidence) voor het hoeveelhedenobject van een gevelpost. Nooit effectief bij toevoegen. null als er niets aan te bieden is.
  function evidenceFor(photoRound, kind, Q) {
    if (!TARGETS[kind]) return null;
    var t = total(photoRound, kind);
    if (t.value === null) return null;
    var c = t.coverage;
    var dekking = c ? c.covered + ' van de ' + c.total + ' gevelzijden van het pand gefotografeerd' + (c.covered < c.total ? '; de overige zijden tellen niet mee' : '')
      : 'onbekend welk deel van het gebouw is gefotografeerd';
    return {
      id: evidenceId(kind, t.resultIds),
      source: Q.SOURCES.PHOTO_WALK_SCAN,
      method_class: 'GEVELFOTO_PROVISIONAL',
      value: t.value, unit: t.unit,
      basis: KINDS[kind].label + ' uit ' + t.facades + ' ' + (t.facades === 1 ? 'gevelfoto' : 'gevelfoto\'s') + ': ' + Q.formatNumber(t.value) + ' ' + Q.unitLabel(t.unit) + ' (' + dekking +
        '). Elementen herkend door AI en door jou gecontroleerd; maat uit een referentie op de foto. Niet gevalideerd.',
      uncertain: true,
      source_ref: { contract: CONTRACT, quantity_kind: kind, result_ids: t.resultIds.slice(0, 60), facades: t.facades, coverage: c, complete: !!(c && c.covered >= c.total) },
      origin: 'GEVELFOTO',
    };
  }

  // -------------------------------------------------------------------
  // Uitwisseling via de browseropslag
  // -------------------------------------------------------------------
  function writeRequest(storage, planRef, address, bagPandId, returnUrl) {
    try { storage.setItem(REQUEST_KEY, JSON.stringify({ planRef: planRef, address: address || null, bagPandId: bagPandId || null, returnUrl: returnUrl, at: new Date().toISOString() })); return true; }
    catch (e) { return false; }
  }
  // Leest de resultaten uit de opslag en haalt eruit wat bij dit plan hoort (ook ongeldige met deze plan_ref, zodat ze niet blijven terugkomen).
  // Resultaten van andere plannen blijven staan voor het plan waar ze bij horen, tot ze een week oud zijn.
  function takeOutbox(storage, planRef, now) {
    var list;
    try { list = JSON.parse(storage.getItem(OUTBOX_KEY) || '[]'); } catch (e) { list = null; }
    if (!Array.isArray(list)) { try { storage.removeItem(OUTBOX_KEY); } catch (e2) { /* opslag niet beschikbaar */ } return []; }
    var mine = [], rest = [], limit = new Date((now || Date.now()) - 7 * 86400000).toISOString();
    list.slice(-50).forEach(function (r) {
      if (isObj(r) && r.plan_ref === planRef) mine.push(r);
      else if (isObj(r) && typeof r.created_at === 'string' && r.created_at > limit) rest.push(r);
    });
    try { if (rest.length) storage.setItem(OUTBOX_KEY, JSON.stringify(rest)); else storage.removeItem(OUTBOX_KEY); } catch (e3) { /* opslag niet beschikbaar */ }
    return mine;
  }

  var api = {
    CONTRACT: CONTRACT, REQUEST_KEY: REQUEST_KEY, OUTBOX_KEY: OUTBOX_KEY, KINDS: KINDS, KIND_KEYS: KIND_KEYS, TARGETS: TARGETS, FACINGS: FACINGS,
    validate: validate, merge: merge, remove: remove, prune: prune, entries: entries, current: current, coverage: coverage, total: total, warnings: warnings,
    evidenceId: evidenceId, evidenceFor: evidenceFor, writeRequest: writeRequest, takeOutbox: takeOutbox,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MJOPGevelfoto = api;
})(typeof window !== 'undefined' ? window : this);
