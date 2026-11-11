// Gevelinventaris (Gevelscanner 2.0 in de iPhone-app -> MJOP): contract `mjop_gevel_inventory_v1`, validatie, samenvoegen en de koppeling
// aan de BESTAANDE kozijnrijen en hun kengetallen.
//
// Principes (zie ook mjop-learning photo_walk/docs/gevelscanner_2.md):
// - De inventaris is een VOORSTEL. Er wordt niets automatisch een hoeveelheid: een waarde wordt eerst een bron naast de bestaande hoeveelheid
//   (Q.addEvidence) en pas na uitdrukkelijke keuze + bevestiging van de onzekerheid de effectieve hoeveelheid (Q.selectEvidence).
// - Dit bestand bevat GEEN prijzen en rekent GEEN kosten uit. Het wijst alleen aan bij welke bestaande kozijnrij een hoeveelheid hoort; de
//   kosten volgen daarna uit de bestaande kengetallen en berekeningen in app.js. Is er geen passend kengetal, dan staat dat er (GEEN_KENGETAL).
// - Aantal kozijnen, kozijnoppervlak, draaiende delen, vaste delen, glasoppervlak en deuren blijven aparte hoeveelheden.
// - Onbekend = null (nooit 0). Zolang de pijplijn niet gevalideerd is, is niets "betrouwbaar vastgesteld" behalve wat de gebruiker zelf invoerde.
// Zonder DOM/netwerk testbaar in Node (test/gevel-inventory.unit.spec.js). Zelfde regels als GevelInventoryV1.validate (Swift) en het JSON-schema.
(function (root) {
  'use strict';

  var CONTRACT = 'mjop_gevel_inventory_v1';
  var OUTCOMES = ['BETROUWBAAR_VASTGESTELD', 'VOORLOPIG_VASTGESTELD', 'NIET_VAST_TE_STELLEN'];
  var ORIGINS = ['LIDAR_PLANE_MEASUREMENT', 'REFERENCE_DISTANCE', 'DERIVED_SEGMENTATION_ON_MEASURED_PLANE', 'DERIVED_CALCULATION', 'COUNTED_FROM_ASSOCIATION', 'MODEL_CLASSIFICATION', 'USER_INPUT', 'NONE'];
  var TOTAL_UNITS = { frame_count: 'st', frame_area_gross: 'm2', operable_parts: 'st', fixed_parts: 'st', glass_area: 'm2', door_count: 'st' };
  var TOTAL_KEYS = Object.keys(TOTAL_UNITS);
  var TOTAL_LABELS = {
    frame_count: 'Aantal kozijnen', frame_area_gross: 'Kozijnoppervlak (buitenmaat)', operable_parts: 'Draaiende delen', fixed_parts: 'Vaste delen',
    glass_area: 'Glasoppervlak', door_count: 'Deurkozijnen',
  };
  var OUTCOME_LABELS = { BETROUWBAAR_VASTGESTELD: 'Betrouwbaar vastgesteld', VOORLOPIG_VASTGESTELD: 'Voorlopig vastgesteld', NIET_VAST_TE_STELLEN: 'Niet vast te stellen' };
  var ORIGIN_LABELS = {
    LIDAR_PLANE_MEASUREMENT: 'gemeten met de dieptesensor (LiDAR)', REFERENCE_DISTANCE: 'berekend met een referentiemaat',
    DERIVED_SEGMENTATION_ON_MEASURED_PLANE: 'afgeleid uit de foto op het gemeten kozijnvlak (geen directe meting)', DERIVED_CALCULATION: 'berekend uit de gemeten maten',
    COUNTED_FROM_ASSOCIATION: 'geteld over alle foto\'s (zelfde kozijn telt één keer)', MODEL_CLASSIFICATION: 'herkend door een model (niet gevalideerd)',
    USER_INPUT: 'in de app ingevuld', NONE: 'onbekend',
  };
  var REASON_LABELS = {
    GEOMETRIE_NIET_IN_HET_VELD_GEVALIDEERD: 'de meetmethode is nog niet getoetst aan handmetingen',
    HERKENNING_NIET_GEVALIDEERD: 'de automatische herkenning is nog niet getoetst op echte gevels',
    ENKEL_STANDPUNT: 'maar één foto van een kozijn', BUITENCONTOUR_NIET_BEVESTIGD: 'niet zeker dat de buitenrand van het kozijn is gevonden',
    MOGELIJK_DUBBEL_GETELD: 'mogelijk is een kozijn dubbel geteld', DUBBELTELLING_NIET_UITGESLOTEN: 'dubbel tellen is niet uit te sluiten',
    GEVELS_ONDERLING_NIET_VERGELEKEN: 'gevels zijn onderling niet vergeleken', NIET_ALLE_OBJECTEN_BEPAALD: 'niet voor elk kozijn bekend',
    GEEN_MODEL_VOOR_DRAAIENDE_DELEN: 'de app kan draaiende delen nog niet zelf herkennen (in de app in te vullen)',
    GEEN_MODEL_VOOR_DEUR_OF_RAAM: 'de app kan raam en deur nog niet zelf onderscheiden', NIET_ALLE_KOZIJNEN_GECLASSIFICEERD: 'niet van elk kozijn is bekend of het een raam of deur is',
    GEEN_OBJECTEN: 'geen kozijnen herkend (geen bewijs dat er geen zijn)', GEEN_OBJECTEN_HERKEND: 'geen kozijnen herkend (geen bewijs dat er geen zijn)',
    GEEN_FOTOS: 'nog geen foto\'s van deze gevel', DEKKING_ONBEKEND: 'onbekend welk deel van de gevel is gefotografeerd', GATEN_IN_DEKKING: 'een deel van de gevel is nog niet gefotografeerd',
    OBJECTEN_NIET_BETROUWBAAR_VASTGESTELD: 'niet alle kozijnen zijn betrouwbaar vastgesteld', AANVULLENDE_OPNAMES_NODIG: 'er zijn nog extra foto\'s nodig',
    GEEN_MAAT: 'geen betrouwbare maat', NO_DEPTH: 'geen dieptegegevens (LiDAR)', SPIEGELING_IN_GLAS: 'het glas spiegelt', GLAS_OP_EEN_FOTO: 'glas maar op één foto gezien',
    GEEN_GLASVLAKKEN_HERKEND: 'geen glasvlakken herkend', KOZIJNMAAT_VOORLOPIG: 'de kozijnmaat is voorlopig',
  };

  // Koppeling van een hoeveelheid uit de inventaris aan de bestaande kozijnrijen (KOZ_DEF in app.js: Draaiend raam, Vast glas, Deur, Dakkapel).
  // `row` = index van de rij; null = er is in de kengetallenbibliotheek geen post met deze eenheid/definitie (dan GEEN prijs verzinnen).
  var ROW_MAPPING = {
    operable_parts: { row: 0, rowName: 'Draaiend raam' },
    fixed_parts: { row: 1, rowName: 'Vast glas' },
    door_count: { row: 2, rowName: 'Deur' },
    frame_count: { row: null, note: 'Het aantal kozijnen is geen eigen post: de kengetallen rekenen per draaiend raam, vast glas en deur. Ter controle bewaard.' },
    frame_area_gross: { row: null, note: 'Geen kengetal per m² kozijnoppervlak in de bibliotheek. Ter referentie bewaard; er worden geen kosten uit afgeleid.' },
    glass_area: { row: null, note: 'Geen kengetal per m² glas in de bibliotheek. Ter referentie bewaard; er worden geen kosten uit afgeleid.' },
  };

  function isObj(x) { return x !== null && typeof x === 'object' && !Array.isArray(x); }
  function isStr(x, min, max) { return typeof x === 'string' && x.length >= (min || 0) && x.length <= (max || 500); }
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function sameKeys(o, keys) { var k = Object.keys(o); return k.length === keys.length && keys.every(function (x) { return Object.prototype.hasOwnProperty.call(o, x); }); }
  function codes(a) { return Array.isArray(a) && a.length <= 40 && a.every(function (x) { return typeof x === 'string' && /^[A-Z0-9_]{1,60}$/.test(x); }); }

  function quantityErrors(q, path, unit) {
    var e = [];
    if (!isObj(q) || !sameKeys(q, ['value', 'unit', 'sigma', 'origin', 'outcome', 'missing', 'partial'])) return [path + ': geen hoeveelheid'];
    ['value', 'partial', 'sigma'].forEach(function (k) { if (q[k] !== null && !(isNum(q[k]) && q[k] >= 0)) e.push(path + '.' + k + ': geen getal >= 0'); });
    if (['st', 'm', 'm2'].indexOf(q.unit) < 0 || (unit && q.unit !== unit)) e.push(path + ': eenheid');
    if (ORIGINS.indexOf(q.origin) < 0) e.push(path + ': herkomst');
    if (OUTCOMES.indexOf(q.outcome) < 0) e.push(path + ': uitkomst');
    if (!codes(q.missing)) e.push(path + ': missing');
    if (q.value === null && q.outcome !== 'NIET_VAST_TE_STELLEN') e.push(path + ': onbekende waarde moet NIET_VAST_TE_STELLEN zijn');
    if (q.value !== null && q.outcome === 'NIET_VAST_TE_STELLEN') e.push(path + ': waarde bij NIET_VAST_TE_STELLEN');
    if (q.value !== null && q.partial !== null) e.push(path + ': deelwaarde alleen bij een onbekende waarde');
    if (q.value !== null && q.origin === 'NONE') e.push(path + ': waarde zonder herkomst');
    if (q.unit === 'st' && isNum(q.value) && Math.floor(q.value) !== q.value) e.push(path + ': aantal is geen geheel getal');
    return e;
  }

  function totalsErrors(t, path) {
    if (!isObj(t) || !sameKeys(t, TOTAL_KEYS)) return [path + ': totalen'];
    var e = [];
    TOTAL_KEYS.forEach(function (k) { e = e.concat(quantityErrors(t[k], path + '.' + k, TOTAL_UNITS[k])); });
    return e;
  }

  // -------------------------------------------------------------------
  // Validatie (streng; alles wat niet klopt wordt geweigerd)
  // -------------------------------------------------------------------
  function validate(d) {
    var e = [];
    if (!isObj(d)) return { ok: false, errors: ['geen object'] };
    if (!sameKeys(d, ['contract', 'inventory_id', 'round_id', 'revision', 'created_at', 'project', 'element_key', 'versions', 'recognition', 'validation', 'facades', 'building_totals', 'photos', 'confirmation', 'booking_allowed'])) e.push('onbekende of ontbrekende velden');
    if (d.contract !== CONTRACT) e.push('contract/versie');
    if (!(isStr(d.inventory_id, 8, 80) && /^[A-Za-z0-9_.-]+$/.test(d.inventory_id))) e.push('inventory_id');
    if (!(isStr(d.round_id, 8, 80) && /^[A-Za-z0-9_.-]+$/.test(d.round_id))) e.push('round_id');
    if (!(isNum(d.revision) && Math.floor(d.revision) === d.revision && d.revision >= 1)) e.push('revision');
    if (!(isStr(d.created_at, 10, 40) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(d.created_at))) e.push('created_at');
    var p = d.project;
    if (!(isObj(p) && isStr(p.plan_ref, 8, 80) && /^[A-Za-z0-9_-]+$/.test(p.plan_ref) && isStr(p.building_id, 1, 200) && (p.mjop_plan_id === null || isStr(p.mjop_plan_id, 1, 80)) &&
      (p.bag_pand_id === null || (typeof p.bag_pand_id === 'string' && /^\d{16}$/.test(p.bag_pand_id))))) e.push('project');
    if (!(d.element_key === null || (typeof d.element_key === 'string' && /^[a-z0-9-]{1,80}$/.test(d.element_key)))) e.push('element_key');
    if (d.booking_allowed !== false) e.push('booking_allowed moet false zijn');
    if (!(isObj(d.confirmation) && d.confirmation.status === 'PROPOSED')) e.push('confirmation (altijd PROPOSED)');
    if (!(isObj(d.versions) && isStr(d.versions.pipeline, 1, 80) && isStr(d.versions.thresholds_status, 1, 80))) e.push('versions');
    if (!(isObj(d.recognition) && Array.isArray(d.recognition.detectors) && Array.isArray(d.recognition.not_recognizable))) e.push('recognition');
    var v = d.validation;
    var vOk = isObj(v) && typeof v.geometry_field_validated === 'boolean' && typeof v.detector_validated === 'boolean' && typeof v.auto_processing_allowed === 'boolean' && Array.isArray(v.reasons);
    if (!vOk) e.push('validation');
    var validated = vOk && v.geometry_field_validated && v.detector_validated;
    if (vOk && v.auto_processing_allowed && !validated) e.push('automatische verwerking zonder gevalideerde pijplijn');
    if (!(Array.isArray(d.facades) && d.facades.length <= 40)) { e.push('facades'); return { ok: false, errors: e }; }
    if (!(Array.isArray(d.photos) && d.photos.length <= 2000)) { e.push('photos'); return { ok: false, errors: e }; }
    d.photos.forEach(function (ph, i) {
      if (!(isObj(ph) && isStr(ph.photo_id, 1, 80) && typeof ph.facade_id === 'string' && (ph.depth_source === 'LIDAR_SCENE_DEPTH' || ph.depth_source === 'NONE'))) e.push('photos[' + i + ']');
    });
    function reliableWithoutValidation(q) { return !validated && isObj(q) && q.outcome === 'BETROUWBAAR_VASTGESTELD' && q.origin !== 'USER_INPUT'; }
    e = e.concat(totalsErrors(d.building_totals, 'building_totals'));
    if (isObj(d.building_totals) && TOTAL_KEYS.some(function (k) { return reliableWithoutValidation(d.building_totals[k]); })) e.push('building_totals: betrouwbaar zonder validatie');
    var ids = {};
    d.facades.forEach(function (f, i) {
      var path = 'facades[' + i + ']';
      if (!isObj(f)) { e.push(path); return; }
      if (!isStr(f.facade_id, 1, 120)) e.push(path + '.facade_id');
      if (OUTCOMES.indexOf(f.completeness) < 0) e.push(path + '.completeness');
      if (!validated && f.completeness === 'BETROUWBAAR_VASTGESTELD') e.push(path + ': volledig zonder validatie');
      if (!(isObj(f.coverage) && typeof f.coverage.determinable === 'boolean' && Array.isArray(f.capture_requests) && Array.isArray(f.photo_ids))) e.push(path + ': dekking/verzoeken/foto\'s');
      else if (f.capture_requests.length > 500 || !f.capture_requests.every(function (r) {
        return isObj(r) && typeof r.kind === 'string' && /^[A-Z_]{1,40}$/.test(r.kind) && isStr(r.text_nl, 0, 300) && typeof r.reason === 'string' && /^[A-Z0-9_]{0,60}$/.test(r.reason);
      })) e.push(path + ': vraag om extra foto\'s');
      e = e.concat(totalsErrors(f.totals, path + '.totals'));
      var tOk = isObj(f.totals);
      if (tOk && TOTAL_KEYS.some(function (k) { return reliableWithoutValidation(f.totals[k]); })) e.push(path + '.totals: betrouwbaar zonder validatie');
      if (!(Array.isArray(f.objects) && f.objects.length <= 500)) { e.push(path + '.objects'); return; }
      var identityOpen = false, areaMissing = false;
      f.objects.forEach(function (o, k) {
        var op = path + '.objects[' + k + ']';
        if (!(isObj(o) && typeof o.object_id === 'string' && /^[A-Za-z0-9_.-]{4,80}$/.test(o.object_id))) { e.push(op + '.object_id'); return; }
        if (ids[o.object_id]) e.push(op + ': object_id komt vaker voor');
        ids[o.object_id] = true;
        if (OUTCOMES.indexOf(o.outcome) < 0) e.push(op + '.outcome');
        if (['KOZIJN', 'RAAM', 'DEUR'].indexOf(o.element_class) < 0) e.push(op + '.element_class');
        if (Array.isArray(o.panes) && o.panes.length > 60) e.push(op + '.panes');
        if (!validated && o.outcome === 'BETROUWBAAR_VASTGESTELD') e.push(op + ': betrouwbaar zonder validatie');
        if (['RESOLVED', 'RESOLVED_BY_USER', 'UNCERTAIN', 'UNCHECKED'].indexOf(o.identity) < 0) e.push(op + '.identity');
        if (o.identity === 'UNCERTAIN' || o.identity === 'UNCHECKED') identityOpen = true;
        if (['USER_CONFIRMED', 'AUTO_CORROBORATED', 'AUTO_UNCONFIRMED'].indexOf(o.contour_evidence) < 0) e.push(op + '.contour_evidence');
        if (o.count !== 1) e.push(op + '.count');
        [['width', 'm'], ['height', 'm'], ['area', 'm2'], ['glass_area', 'm2'], ['sections', 'st'], ['operable_parts', 'st'], ['fixed_parts', 'st']].forEach(function (kv) {
          e = e.concat(quantityErrors(o[kv[0]], op + '.' + kv[0], kv[1]));
          if (reliableWithoutValidation(o[kv[0]])) e.push(op + '.' + kv[0] + ': betrouwbaar zonder validatie');
        });
        var area = isObj(o.area) && isNum(o.area.value) ? o.area.value : null;
        if (area === null) areaMissing = true;
        if (area !== null && !(isObj(o.width) && isNum(o.width.value) && isObj(o.height) && isNum(o.height.value))) e.push(op + ': oppervlak zonder breedte en hoogte');
        if (isObj(o.glass_area) && isNum(o.glass_area.value)) {
          if (area !== null && o.glass_area.value > area + 1e-9) e.push(op + ': glas groter dan het kozijn');
          if (area === null) e.push(op + ': glasoppervlak zonder kozijnmaat');
          if (o.glass_area.origin === 'LIDAR_PLANE_MEASUREMENT' || o.glass_area.origin === 'REFERENCE_DISTANCE') e.push(op + ': glasoppervlak is geen directe meting');
        }
        if (o.nen2767_condition_score !== null) e.push(op + ': geen NEN 2767-score in dit contract');
        if (!(Array.isArray(o.condition) && Array.isArray(o.photo_ids) && Array.isArray(o.panes))) { e.push(op + ': conditie/foto\'s/glasvlakken'); return; }
        o.condition.forEach(function (c) {
          if (!isObj(c) || ['ZICHTBAAR_GEBREK', 'MOGELIJKE_INDICATIE', 'NIET_BEOORDEELBAAR'].indexOf(c.kind) < 0) { e.push(op + ': conditiesoort'); return; }
          if (c.kind !== 'NIET_BEOORDEELBAAR' && !(typeof c.photo_id === 'string' && Array.isArray(c.region_px) && typeof c.category === 'string')) e.push(op + ': gebrek zonder bronfoto, plek of categorie');
          if (c.kind === 'ZICHTBAAR_GEBREK' && !(isObj(c.detector) && c.detector.validated === true)) e.push(op + ': zichtbaar gebrek vraagt een gevalideerde herkenner');
        });
      });
      if (tOk && identityOpen) TOTAL_KEYS.forEach(function (k) { var q = f.totals[k]; if (isObj(q) && (q.value !== null || q.partial !== null)) e.push(path + '.totals.' + k + ': waarde ondanks mogelijke dubbeltelling'); });
      if (tOk && areaMissing && isObj(f.totals.frame_area_gross) && f.totals.frame_area_gross.value !== null) e.push(path + '.totals.frame_area_gross: oppervlak ondanks onbemeten kozijnen');
      if (tOk && !f.objects.length && isObj(f.totals.frame_count) && f.totals.frame_count.value !== null) e.push(path + '.totals.frame_count: aantal zonder objecten');
    });
    return { ok: e.length === 0, errors: e };
  }

  // -------------------------------------------------------------------
  // Samenvoegen in het plan: idempotent, projectcontext afgedwongen, beslissingen blijven staan
  // -------------------------------------------------------------------
  // photoRound.inventories = [ { inv, ui: { status: 'CURRENT'|'SUPERSEDED', sources: { '<scope>|<kind>': { evidenceId, rowId, status, at } } } } ]
  function merge(photoRound, incoming, planRef) {
    var rep = { added: [], duplicates: 0, foreign: 0, invalid: [], superseded: 0 };
    if (!photoRound || !planRef || photoRound.planRef !== planRef) { rep.invalid.push('geen projectcontext'); return rep; }
    if (!Array.isArray(photoRound.inventories)) photoRound.inventories = [];
    (incoming || []).slice(0, 50).forEach(function (inv) {
      var v = validate(inv);
      if (!v.ok) { rep.invalid.push((inv && inv.inventory_id) || '?'); return; }
      if (inv.project.plan_ref !== planRef) { rep.foreign++; return; }                 // ander project: nooit toepassen
      if (photoRound.inventories.some(function (x) { return x.inv.inventory_id === inv.inventory_id; })) { rep.duplicates++; return; }
      var newer = photoRound.inventories.some(function (x) { return x.inv.round_id === inv.round_id && x.inv.revision > inv.revision; });
      photoRound.inventories.forEach(function (x) {
        if (x.inv.round_id === inv.round_id && x.inv.revision < inv.revision && x.ui.status === 'CURRENT') { x.ui.status = 'SUPERSEDED'; rep.superseded++; }
      });
      photoRound.inventories.push({ inv: inv, ui: { status: newer ? 'SUPERSEDED' : 'CURRENT', sources: {} } });
      rep.added.push(inv.inventory_id);
    });
    // Vervangen revisies waar niets van in gebruik is hoeven niet in het plan te blijven staan (elk tot honderden foto-records).
    // Een vervangen revisie waarvan een hoeveelheid als bron is toegevoegd of in gebruik is, blijft bewaard: de herkomst van die bron moet herleidbaar blijven.
    photoRound.inventories = photoRound.inventories.filter(function (x) { return x.ui.status === 'CURRENT' || Object.keys(x.ui.sources || {}).length > 0; });
    return rep;
  }

  function current(photoRound) {
    return ((photoRound && photoRound.inventories) || []).filter(function (x) { return x.ui.status === 'CURRENT'; });
  }
  // Vervangen revisies waarvan nog een hoeveelheid in gebruik is: de gebruiker moet weten dat die bron uit een oudere ronde komt.
  function supersededInUse(photoRound) {
    return ((photoRound && photoRound.inventories) || []).filter(function (x) {
      return x.ui.status === 'SUPERSEDED' && Object.keys(x.ui.sources || {}).some(function (k) { return x.ui.sources[k].status === 'IN_USE'; });
    });
  }
  // De kozijnrijen gelden voor het HELE gebouw. Bij meerdere gevels mag daarom alleen het gebouwtotaal als hoeveelheid worden aangeboden;
  // een geveltotaal zou de post op het aantal van één gevel zetten. Bij één gevel is het geveltotaal het gebouwtotaal.
  function offerScope(inv, facadeId) { return inv.facades.length <= 1 ? facadeId != null : facadeId == null; }
  // "f:<gevel>|<soort>" of "*|<soort>" -> { facadeId, kind }; de gevelnaam mag zelf een | bevatten.
  function parseScopeKey(key) {
    var s = String(key), i = s.lastIndexOf('|');
    if (i < 1) return null;
    var head = s.slice(0, i), kind = s.slice(i + 1);
    if (TOTAL_KEYS.indexOf(kind) < 0) return null;
    if (head === '*') return { facadeId: null, kind: kind };
    return head.indexOf('f:') === 0 ? { facadeId: head.slice(2), kind: kind } : null;
  }

  // Alle hoeveelheden van één bereik (gevel of hele gebouw) met hun koppeling aan de kozijnrijen.
  // kozEl = het bestaande kozijnen-element van het plan (el.type === 'kozijnen', met el.koz[]), of null.
  function mappingFor(totals, kozEl) {
    return TOTAL_KEYS.map(function (kind) {
      var q = totals[kind], m = ROW_MAPPING[kind];
      var out = { kind: kind, label: TOTAL_LABELS[kind], quantity: q, row: null, rowId: null, rowLabel: null, kengetal: 'GEEN_KENGETAL', note: m.note || null, usable: false };
      if (m.row !== null) {
        var k = kozEl && kozEl.koz && kozEl.koz[m.row];
        if (k && k.naam === m.rowName && k.quantity) {
          out.row = m.row; out.rowId = kozEl.id + ':' + m.row; out.rowLabel = kozEl.naam + ' — ' + k.naam; out.kengetal = 'EIGEN_BIBLIOTHEEK'; out.note = null;
          out.usable = q.value !== null;
        } else {
          out.note = 'De post "' + m.rowName + '" staat niet (meer) in dit plan; er is dus geen kengetal om mee te rekenen.';
        }
      }
      return out;
    });
  }

  function scopeTotals(inv, facadeId) {
    if (facadeId == null) return inv.building_totals;
    var f = inv.facades.filter(function (x) { return x.facade_id === facadeId; })[0];
    return f ? f.totals : null;
  }
  function scopeKey(facadeId, kind) { return (facadeId == null ? '*' : 'f:' + facadeId) + '|' + kind; }

  // Bron (evidence) voor het hoeveelhedenobject van een kozijnrij. Nooit effectief bij toevoegen. Alleen voor hoeveelheden met een rij.
  function evidenceFor(inv, facadeId, kind, Q) {
    var t = scopeTotals(inv, facadeId), m = ROW_MAPPING[kind];
    if (!t || !m || m.row === null) return null;
    var q = t[kind];
    if (!q || q.value === null) return null;
    var objectIds = [], photoIds = [];
    inv.facades.forEach(function (f) {
      if (facadeId != null && f.facade_id !== facadeId) return;
      f.objects.forEach(function (o) { objectIds.push(o.object_id); });
      f.photo_ids.forEach(function (p) { if (photoIds.indexOf(p) < 0) photoIds.push(p); });
    });
    return {
      id: 'gevelscan:' + inv.inventory_id + ':' + scopeKey(facadeId, kind),
      source: Q.SOURCES.PHOTO_WALK_SCAN,
      method_class: 'GEVELSCAN_PROVISIONAL',
      value: q.value, unit: q.unit,
      basis: TOTAL_LABELS[kind] + ' uit de gevelinventaris: ' + Q.formatNumber(q.value) + ' ' + Q.unitLabel(q.unit) + ' (' + (facadeId == null ? 'hele gebouw' : 'gevel ' + facadeId) + ', ' + objectIds.length +
        ' kozijnen op ' + photoIds.length + ' foto\'s; ' + ORIGIN_LABELS[q.origin] + '). ' + OUTCOME_LABELS[q.outcome] + '.',
      // ook een door de gebruiker in de app ingevuld aantal blijft hier "onzeker": het is nog niet in het MJOP gecontroleerd
      uncertain: true,
      source_ref: { inventory_id: inv.inventory_id, round_id: inv.round_id, revision: inv.revision, scope: facadeId == null ? 'BUILDING' : 'FACADE', facade_id: facadeId == null ? null : facadeId,
        quantity_kind: kind, origin: q.origin, outcome: q.outcome, sigma: q.sigma, missing: q.missing, object_ids: objectIds.slice(0, 500), photo_ids: photoIds.slice(0, 500),
        pipeline: inv.versions.pipeline, thresholds_status: inv.versions.thresholds_status },
      origin: 'GEVELSCAN',
    };
  }

  function describeReasons(codesList) {
    var out = [];
    (codesList || []).forEach(function (c) { var t = REASON_LABELS[c] || c; if (out.indexOf(t) < 0) out.push(t); });
    return out;
  }
  // Gerichte vragen om extra foto's, ontdubbeld op tekst.
  function requests(inv) {
    var out = [];
    inv.facades.forEach(function (f) {
      f.capture_requests.forEach(function (r) { var t = 'Gevel ' + f.facade_id + ': ' + r.text_nl; if (typeof r.text_nl === 'string' && out.indexOf(t) < 0) out.push(t); });
    });
    return out;
  }

  var api = {
    CONTRACT: CONTRACT, FEATURE: 'gevelscan2', TOTAL_KEYS: TOTAL_KEYS, TOTAL_LABELS: TOTAL_LABELS, TOTAL_UNITS: TOTAL_UNITS, OUTCOME_LABELS: OUTCOME_LABELS, ORIGIN_LABELS: ORIGIN_LABELS,
    REASON_LABELS: REASON_LABELS, ROW_MAPPING: ROW_MAPPING,
    validate: validate, merge: merge, current: current, supersededInUse: supersededInUse, offerScope: offerScope, parseScopeKey: parseScopeKey, mappingFor: mappingFor, scopeTotals: scopeTotals, scopeKey: scopeKey, evidenceFor: evidenceFor,
    describeReasons: describeReasons, requests: requests,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MJOPGevelInventory = api;
})(typeof window !== 'undefined' ? window : this);
