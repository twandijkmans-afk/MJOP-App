// Building Element Inventory UI v1 — aanwezigheid van fysieke bouwdelen (PRESENT / ABSENT / UNKNOWN)
// en wat dat betekent voor onderhoudsposten.
//
// Bundel: mjop-learning scripts/export_app_component_inventory.py
// (mjop_app_component_inventory_bundle_v1). Bewust los van app.js en zonder DOM, zodat het in Node te testen is
// (test/inventory.unit.spec.js).
//
// Kernregels:
// - UNKNOWN != ABSENT. Alleen een expliciet ABSENT (menselijk besluit in de bundel, of keuze NEE van de
//   gebruiker) levert NOT_APPLICABLE op. Een onbekend bouwdeel laat een post nooit stil verdwijnen.
// - Een gebruikerskeuze (JA / NEE / ONBEKEND-LATER) is altijd bron USER_CONFIRMED_MANUAL en overschrijft de bundel
//   voor dat bouwdeel; de bundel zelf wordt niet gewijzigd.
// - Geen prijzen, kengetallen, hoeveelheden of cashflow: alleen toepasbaarheid en herkomst.
(function (root) {
  'use strict';

  var BUNDLE_VERSION = 'mjop_app_component_inventory_bundle_v1';
  var USER_SOURCE = 'USER_CONFIRMED_MANUAL';
  var ANSWERS = { JA: 'PRESENT', NEE: 'ABSENT', LATER: 'UNKNOWN' };
  var STATUS_LABELS = { PRESENT: 'Aanwezig', ABSENT: 'Niet aanwezig', UNKNOWN: 'Nog te bevestigen' };
  var STATUS_SYMBOLS = { PRESENT: '✓', ABSENT: '—', UNKNOWN: '?' };
  var RESULT_LABELS = {
    APPLICABLE: 'Voorgesteld', NOT_APPLICABLE: 'Niet van toepassing', NEEDS_CONFIRMATION: 'Nog te bevestigen',
    NEEDS_ATTRIBUTE_CONFIRMATION: 'Materiaal/afwerking nog te bevestigen', NOT_PRESENCE_DRIVEN: 'Niet afhankelijk van aanwezigheid',
    USER_SELECTED: 'Eigen keuze',
  };
  var BASIS_LABELS = {
    HUMAN_DECISION: 'Bevestigd besluit (mjop-learning)',
    SOURCE_EVIDENCE_NOT_CONFIRMED: 'Volgens bronnen, nog niet bevestigd',
    PROPOSED_ABSENT_NOT_DECIDED: 'Bronnen wijzen op afwezig, nog niet bevestigd',
    NO_EVIDENCE: 'Geen bewijs gevonden',
  };

  // Valideert en verkleint de bundel (zonder bronfragmenten) voor opslag in het plan.
  function loadBundle(bundle, building) {
    var errors = [];
    if (!bundle || bundle.bundle_version !== BUNDLE_VERSION) errors.push('Dit is geen component-inventarisbundel uit mjop-learning (bundle_version).');
    else {
      var b = bundle.building || {};
      var ids = (b.bag_pand_ids || []).map(String);
      var pand = building && building.identificatie ? String(building.identificatie) : '';
      if (!ids.length || !Array.isArray(bundle.components) || !Array.isArray(bundle.maintenance_requirements)) errors.push('De bundel is onvolledig.');
      else if (!pand || ids.indexOf(pand) === -1) errors.push('De bundel hoort bij ' + ids.length + ' ' + (ids.length === 1 ? 'pand' : 'panden') + ' (' + ids.join(', ') + '); dit plan hoort bij pand ' + (pand || 'onbekend') + '.');
    }
    if (errors.length) return { ok: false, errors: errors };
    return { ok: true, inventory: {
      bundle_version: bundle.bundle_version,
      building: { building_id: bundle.building.building_id, document_ids: bundle.building.document_ids, pand_count: bundle.building.pand_count },
      inventory_last_reviewed_at: bundle.inventory_last_reviewed_at || null,
      components: bundle.components.map(function (c) {
        return { component_type: c.component_type, label_nl: c.label_nl, status: c.status, presence_basis: c.presence_basis, decision_ref: c.decision_ref || null,
          evidence_refs: c.evidence_refs || [], material_as_reported: c.material_as_reported || null, material_basis: c.material_basis || null };
      }),
      maintenance_requirements: bundle.maintenance_requirements.map(function (r) {
        return { app_element_id: r.app_element_id, app_label: r.app_label, classification: r.classification, activation_mode: r.activation_mode,
          required_components: r.required_components || [], required_any_components: r.required_any_components || [] };
      }),
      frame_status: bundle.frame_status || null,
      answers: {},
      removed: {},
    } };
  }

  function component(inv, type) {
    var found = null;
    (inv.components || []).forEach(function (c) { if (c.component_type === type) found = c; });
    return found;
  }

  // Effectieve status van een bouwdeel: gebruikerskeuze > bundel.
  function effectiveStatus(inv, type) {
    var a = inv.answers && inv.answers[type];
    if (a) return { status: ANSWERS[a.answer], source: USER_SOURCE, user_confirmed: true, answer: a.answer, at: a.at };
    var c = component(inv, type);
    if (!c) return { status: 'UNKNOWN', source: 'NO_EVIDENCE', user_confirmed: false };
    return { status: c.status, source: c.presence_basis, user_confirmed: false, decision_ref: c.decision_ref };
  }

  // Zelfde regels als mjop-learning export_app_component_inventory.requirement_result.
  function resultFor(req, statusOf) {
    var mode = req.activation_mode;
    if (mode === 'NOT_PRESENCE_DRIVEN') return 'NOT_PRESENCE_DRIVEN';
    if (mode === 'USER_SELECTED') return 'USER_SELECTED';
    var needed = (req.required_components && req.required_components.length) ? req.required_components : (req.required_any_components || []);
    var st = needed.map(function (c) { return statusOf(c); });
    if (mode === 'PRESENCE_DRIVEN_ALL') {
      if (st.indexOf('ABSENT') !== -1) return 'NOT_APPLICABLE';
      return st.every(function (s) { return s === 'PRESENT'; }) ? 'APPLICABLE' : 'NEEDS_CONFIRMATION';
    }
    if (st.indexOf('PRESENT') === -1) {
      return st.every(function (s) { return s === 'ABSENT'; }) ? 'NOT_APPLICABLE' : 'NEEDS_CONFIRMATION';
    }
    if (mode === 'PRESENCE_DRIVEN_ANY') return 'APPLICABLE';
    return 'NEEDS_ATTRIBUTE_CONFIRMATION'; // PRESENCE_AND_ATTRIBUTE: materiaal/afwerking alleen uit de bron volstaat niet
  }

  function resolve(inv) {
    var statusOf = function (t) { return effectiveStatus(inv, t).status; };
    return {
      components: inv.components.map(function (c) {
        var e = effectiveStatus(inv, c.component_type);
        return { component_type: c.component_type, label_nl: c.label_nl, status: e.status, source: e.source, user_confirmed: e.user_confirmed,
          answer: e.answer || null, decision_ref: e.decision_ref || null, material_as_reported: c.material_as_reported, bundle_status: c.status };
      }),
      requirements: inv.maintenance_requirements.map(function (r) {
        return { app_element_id: r.app_element_id, app_label: r.app_label, classification: r.classification, result: resultFor(r, statusOf),
          components: (r.required_components.length ? r.required_components : r.required_any_components) };
      }),
    };
  }

  function requirementResult(inv, elementId) {
    var found = null;
    resolve(inv).requirements.forEach(function (r) { if (r.app_element_id === elementId) found = r; });
    return found ? found.result : null;
  }

  // Legt een gebruikerskeuze vast. answer: 'JA' | 'NEE' | 'LATER'.
  function setAnswer(inv, type, answer, nowIso) {
    if (!ANSWERS[answer] || !component(inv, type)) return false;
    inv.answers = inv.answers || {};
    inv.answers[type] = { answer: answer, source: USER_SOURCE, at: nowIso || new Date().toISOString() };
    return true;
  }

  // Past de inventaris toe op de planposten: alleen posten met resultaat NOT_APPLICABLE verdwijnen uit het plan
  // (en worden bewaard in inv.removed); een post wordt hersteld zodra hij niet meer NOT_APPLICABLE is.
  // UNKNOWN laat een post nooit verdwijnen. Geeft de nieuwe lijst + wat er veranderde terug.
  function applyToElements(inv, elements) {
    var res = resolve(inv);
    var notApplicable = {};
    res.requirements.forEach(function (r) { if (r.result === 'NOT_APPLICABLE') notApplicable[r.app_element_id] = true; });
    inv.removed = inv.removed || {};
    var removed = [], restored = [];
    var kept = elements.filter(function (el) {
      if (notApplicable[el.id] && el.type !== 'custom') { inv.removed[el.id] = el; removed.push(el.id); return false; }
      return true;
    });
    Object.keys(inv.removed).forEach(function (id) {
      if (!notApplicable[id]) {
        if (!kept.some(function (e) { return e.id === id; })) kept.push(inv.removed[id]);
        delete inv.removed[id];
        restored.push(id);
      }
    });
    return { elements: kept, removed: removed, restored: restored };
  }

  // Kozijnstatus voor de UX (geen berekening): alleen wat de bundel zegt.
  function frameSummary(inv) {
    var fs = inv.frame_status;
    if (!fs) return null;
    var pv = fs.photo_visible_evidence;
    return {
      presence: effectiveStatus(inv, 'EXTERIOR_FRAME'),
      material_as_reported: fs.material_as_reported, material_basis: fs.material_basis,
      photo_visible: pv ? { frames: pv.PHOTO_VISIBLE_FRAME_COUNT, windows: pv.PHOTO_VISIBLE_WINDOW_COUNT, doors: pv.PHOTO_VISIBLE_EXTERIOR_DOOR_COUNT, photo: pv.photo } : null,
      building_total_known: ['FRAME_COUNT', 'WINDOW_COUNT', 'EXTERIOR_DOOR_COUNT'].some(function (k) { return fs.building_totals && fs.building_totals[k] && fs.building_totals[k].value != null; }),
      legacy_label: fs.legacy_estimate_fallback ? fs.legacy_estimate_fallback.ui_label_nl : 'Schatting op basis van aantal appartementen',
    };
  }

  var api = {
    BUNDLE_VERSION: BUNDLE_VERSION, USER_SOURCE: USER_SOURCE, ANSWERS: ANSWERS, STATUS_LABELS: STATUS_LABELS, STATUS_SYMBOLS: STATUS_SYMBOLS,
    RESULT_LABELS: RESULT_LABELS, BASIS_LABELS: BASIS_LABELS,
    loadBundle: loadBundle, effectiveStatus: effectiveStatus, resultFor: resultFor, resolve: resolve, requirementResult: requirementResult,
    setAnswer: setAnswer, applyToElements: applyToElements, frameSummary: frameSummary,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MJOPInventory = api;
})(typeof window !== 'undefined' ? window : this);
