// Quantity Foundation v1 — één consistent hoeveelheidsobject per post.
//
// Zie mjop-learning/docs/quantity_engine_feasibility_v1.md (§4, §11, §13).
// Dit bestand is bewust los van app.js en zonder DOM: puur rekenwerk en
// statusovergangen, zodat het in Node getest kan worden
// (test/quantity.unit.spec.js) en app.js het alleen hoeft aan te roepen.
//
// Kernregels:
// - Een hoeveelheid heeft altijd een herkomst (source) en een status.
// - De automatisch bepaalde waarde (auto) en een handmatige waarde (manual)
//   worden los bewaard. Een nieuwe automatische waarde overschrijft NOOIT
//   een handmatige waarde; alleen een expliciete "terug naar automatisch"
//   (resetToAuto) haalt de handmatige waarde weg.
// - De ruwe bronwaarde (bijv. 3D BAG b3_opp_dak_plat = 312.64) blijft
//   bewaard naast de gebruikte waarde.
// - Invoer met een onduidelijk decimaalteken wordt geweigerd, nooit geraden:
//   "312,6" is 312,6 — nooit 3126.
(function (root) {
  'use strict';

  var SOURCES = {
    BAG: 'BAG',
    THREE_D_BAG: '3D_BAG',
    GEOMETRY_DERIVED: 'GEOMETRY_DERIVED',
    ESTIMATED: 'ESTIMATED',
    IMPORTED_MJOP: 'IMPORTED_MJOP',
    MANUAL: 'MANUAL',
  };

  var STATUS = {
    PROPOSED: 'PROPOSED',
    CONFIRMED: 'CONFIRMED',
    USER_OVERRIDDEN: 'USER_OVERRIDDEN',
  };

  var SOURCE_LABELS = {
    BAG: 'BAG',
    '3D_BAG': '3D BAG',
    GEOMETRY_DERIVED: 'Berekend uit 3D BAG',
    ESTIMATED: 'Schatting',
    IMPORTED_MJOP: 'Uit oud MJOP',
    MANUAL: 'Door jou ingevuld',
  };

  var STATUS_LABELS = {
    PROPOSED: 'Voorstel',
    CONFIRMED: 'Bevestigd',
    USER_OVERRIDDEN: 'Aangepast door jou',
  };

  var UNIT_LABELS = { m2: 'm²', m1: 'm1', m3: 'm³', st: 'st.', app: 'app.', post: 'post', kg: 'kg', ton: 'ton', uur: 'uur' };

  // -------------------------------------------------------------------
  // Getallen lezen
  // -------------------------------------------------------------------

  // Strikte NL-hoeveelheidsparser. Geeft {ok, value} of {ok:false, error}.
  //   "312,6"      -> 312.6
  //   "312.6"      -> 312.6   (één punt, niet precies 3 cijfers erna: decimaal)
  //   "1.250,5"    -> 1250.5  (punt = duizendtal, komma = decimaal)
  //   "1.250.000"  -> 1250000 (meerdere punt-groepen: duizendtallen)
  //   "1,250.5"    -> 1250.5  (Engelse notatie, beide tekens aanwezig)
  //   "1.250"      -> fout: 1250 of 1,25? Niet raden.
  function parseQuantity(text) {
    var s = String(text == null ? '' : text).replace(/ /g, ' ').trim();
    s = s.replace(/\s+/g, '');
    if (!s) return { ok: false, error: 'leeg' };
    if (/^-/.test(s)) return { ok: false, error: 'negatief' };
    var v = null;
    if (/^\d+$/.test(s)) v = Number(s);
    else if (/^\d+,\d+$/.test(s)) v = Number(s.replace(',', '.'));
    else if (/^\d+\.\d+$/.test(s)) {
      if (/^\d{1,3}\.\d{3}$/.test(s)) return { ok: false, error: 'onduidelijk_decimaalteken' };
      v = Number(s);
    } else if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) v = Number(s.replace(/\./g, '').replace(',', '.'));
    else if (/^\d{1,3}(,\d{3})+\.\d+$/.test(s)) v = Number(s.replace(/,/g, ''));
    else return { ok: false, error: 'geen_getal' };
    if (!isFinite(v)) return { ok: false, error: 'geen_getal' };
    return { ok: true, value: v };
  }

  // Bedrag per eenheid (kengetal/tarief) in NL-notatie: een punt met
  // precies drie cijfers erna is hier wél een duizendtal ("1.250" = 1250),
  // zoals bij geldbedragen gebruikelijk. "22,50" -> 22.5; "22.5" -> 22.5.
  function parseAmount(text) {
    var s = String(text == null ? '' : text).replace(/ /g, ' ').replace(/€/g, '').replace(/\s+/g, '');
    if (/^\d{1,3}(\.\d{3})+$/.test(s)) return { ok: true, value: Number(s.replace(/\./g, '')) };
    return parseQuantity(s);
  }

  function parseErrorText(error) {
    if (error === 'onduidelijk_decimaalteken') return 'Onduidelijk: gebruik een komma voor decimalen (bijv. 312,6) of laat de punt weg.';
    if (error === 'negatief') return 'Een hoeveelheid kan niet negatief zijn.';
    if (error === 'leeg') return 'Vul een getal in.';
    return 'Dit is geen geldig getal.';
  }

  // Weergave: max. 2 decimalen, NL-notatie, zonder onnodige nullen.
  function formatNumber(v) {
    if (v == null || !isFinite(v)) return '–';
    return Number(v).toLocaleString('nl-NL', { maximumFractionDigits: 2 });
  }

  function normalizeUnit(text) {
    var s = String(text == null ? '' : text).toLowerCase().replace(/[.\s]/g, '').replace('²', '2').replace('³', '3');
    if (s === 'm2' || s === 'm²') return 'm2';
    if (s === 'm1' || s === 'm' || s === 'mtr') return 'm1';
    if (s === 'm3') return 'm3';
    if (s === 'st' || s === 'stk' || s === 'stuk' || s === 'stuks') return 'st';
    if (s === 'pst' || s === 'post') return 'post';
    if (s === 'kg') return 'kg';
    if (s === 'ton') return 'ton';
    if (s === 'u' || s === 'uur') return 'uur';
    return null;
  }

  function unitLabel(unit) { return UNIT_LABELS[unit] || (unit || ''); }

  // -------------------------------------------------------------------
  // Het hoeveelheidsobject
  // -------------------------------------------------------------------
  //
  // {
  //   value, unit, source, status,         <- afgeleid, altijd in sync (refresh)
  //   auto:   { value, unit, source, basis, raw:{...} } | null,
  //   manual: { value, unit, text, at } | null,
  //   confirmed: { value, at } | null,
  //   evidence: [ { id, source, method_class, value, unit, basis, source_ref, origin, added_at } ]
  //             alle andere bronnen (bijv. historisch MJOP, 3D BAG via mjop-learning, eerdere
  //             handmatige waarden). Wordt nooit overschreven of verwijderd; alleen aangevuld.
  //   selected: { evidenceId, at } | null   de door de gebruiker gekozen bron (v2)
  //   history: [ { at, event, value, source, note? } ]   (append-only)
  // }
  //
  // Effectieve waarde: handmatig > gekozen bron > automatisch. Er wordt nooit gemiddeld.

  function nowIso(at) { return at || new Date().toISOString(); }

  function findEvidence(q, id) {
    var list = (q && q.evidence) || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function selectedEvidence(q) {
    return (q.selected && q.selected.evidenceId) ? findEvidence(q, q.selected.evidenceId) : null;
  }

  function refresh(q) {
    var sel = q.manual ? null : selectedEvidence(q);
    var eff = q.manual || sel || q.auto || { value: null, unit: null, source: null };
    q.value = eff.value;
    q.unit = eff.unit || (q.auto && q.auto.unit) || null;
    q.source = q.manual ? SOURCES.MANUAL : (sel ? sel.source : (q.auto ? q.auto.source : null));
    q.selectedEvidenceId = sel ? sel.id : null;
    if (q.manual) q.status = STATUS.USER_OVERRIDDEN;
    else if (sel) q.status = STATUS.CONFIRMED;
    else if (q.confirmed && q.auto && q.confirmed.value === q.auto.value) q.status = STATUS.CONFIRMED;
    else q.status = STATUS.PROPOSED;
    return q;
  }

  function autoQuantity(value, unit, source, basis, raw) {
    return { value: value, unit: unit, source: source, basis: basis || '', raw: raw || null };
  }

  function create(auto, at) {
    var q = { auto: auto || null, manual: null, confirmed: null, history: [] };
    q.history.push({ at: nowIso(at), event: 'PROPOSED', value: auto ? auto.value : null, source: auto ? auto.source : null });
    return refresh(q);
  }

  function sameAuto(a, b) {
    if (!a || !b) return a === b;
    return a.value === b.value && a.unit === b.unit && a.source === b.source;
  }

  // Nieuwe automatische waarde (nieuw adres, meer/minder appartementen, …).
  // Een handmatige waarde blijft ALTIJD staan; een bevestiging vervalt
  // alleen als de automatische waarde echt verandert.
  function updateAuto(q, auto, at) {
    if (sameAuto(q.auto, auto)) {
      q.auto = auto; // basis/raw kunnen verfijnd zijn; waarde gelijk
      return refresh(q);
    }
    var event = q.manual ? 'AUTO_CHANGED_MANUAL_KEPT' : (q.confirmed ? 'AUTO_CHANGED_CONFIRMATION_CLEARED' : 'AUTO_CHANGED');
    q.history.push({ at: nowIso(at), event: event, value: auto ? auto.value : null, source: auto ? auto.source : null, previous: q.auto ? q.auto.value : null });
    q.auto = auto;
    if (q.confirmed && (!auto || q.confirmed.value !== auto.value)) q.confirmed = null;
    return refresh(q);
  }

  function confirm(q, at) {
    if (!q.auto || q.manual) return refresh(q);
    var t = nowIso(at);
    q.confirmed = { value: q.auto.value, at: t };
    q.history.push({ at: t, event: 'CONFIRMED', value: q.auto.value, source: q.auto.source });
    return refresh(q);
  }

  function override(q, value, text, at) {
    var t = nowIso(at);
    var unit = (q.manual && q.manual.unit) || q.unit || (q.auto && q.auto.unit) || null;
    var previous = q.value;
    q.manual = { value: value, unit: unit, text: text == null ? String(value) : String(text), at: t };
    // De handmatige waarde blijft ook als bron bewaard, zodat hij na het kiezen
    // van een andere bron niet verloren gaat.
    q.evidence = q.evidence || [];
    var n = q.evidence.filter(function (e) { return e.source === SOURCES.MANUAL; }).length + 1;
    q.evidence.push({ id: 'manual-' + n, source: SOURCES.MANUAL, method_class: 'MANUAL', value: value, unit: unit,
      basis: 'Door jou ingevuld (' + q.manual.text + ').', source_ref: { entered_text: q.manual.text }, origin: 'MANUAL', added_at: t });
    q.selected = null;
    q.history.push({ at: t, event: 'USER_OVERRIDDEN', value: value, source: SOURCES.MANUAL, previous: previous });
    return refresh(q);
  }

  // Voegt een bron toe (bijv. uit een mjop-learning-bundel). Een bestaande bron
  // (zelfde id) wordt nooit overschreven. Geeft true als er iets is toegevoegd.
  function addEvidence(q, ev, at) {
    q.evidence = q.evidence || [];
    if (findEvidence(q, ev.id)) return false;
    var t = nowIso(at);
    var copy = JSON.parse(JSON.stringify(ev));
    copy.added_at = copy.added_at || t;
    q.evidence.push(copy);
    q.history.push({ at: t, event: 'EVIDENCE_ADDED', value: ev.value, source: ev.source, evidence_id: ev.id });
    refresh(q);
    return true;
  }

  // "Gebruik deze bron": de gekozen bron wordt de effectieve hoeveelheid
  // (status CONFIRMED). Een handmatige waarde vervalt als keuze maar blijft als
  // bron in de lijst staan. Een bron met een andere eenheid kan niet gekozen worden.
  function selectEvidence(q, evidenceId, at) {
    var ev = findEvidence(q, evidenceId);
    if (!ev) return { ok: false, error: 'onbekende_bron' };
    var unit = (q.auto && q.auto.unit) || q.unit;
    if (unit && ev.unit && ev.unit !== unit) return { ok: false, error: 'andere_eenheid' };
    if (ev.value == null || !isFinite(ev.value)) return { ok: false, error: 'geen_waarde' };
    var t = nowIso(at);
    q.manual = null;
    q.selected = { evidenceId: evidenceId, at: t };
    q.history.push({ at: t, event: 'SOURCE_SELECTED', value: ev.value, source: ev.source, evidence_id: evidenceId });
    refresh(q);
    return { ok: true };
  }

  // Feitelijk verschil van een bron t.o.v. de effectieve hoeveelheid. Geen score.
  function difference(q, value) {
    if (value == null || q.value == null || !isFinite(value) || !isFinite(q.value)) return null;
    var abs = Math.round((value - q.value) * 100) / 100;
    return { absolute: abs, percentage: q.value !== 0 ? Math.round((value - q.value) / q.value * 1000) / 10 : null };
  }

  function resetToAuto(q, at) {
    if (!q.manual && !q.selected) return refresh(q);
    var t = nowIso(at);
    q.history.push({ at: t, event: 'RESET_TO_AUTO', value: q.auto ? q.auto.value : null, source: q.auto ? q.auto.source : null, previous: q.value });
    q.manual = null;
    q.selected = null;
    q.confirmed = null;
    return refresh(q);
  }

  // Plannen van vóór v1 hebben alleen een kaal getal (el.hoeveelheid /
  // koz.aantal). Wijkt dat af van wat de app nu automatisch zou voorstellen,
  // dan was het een handmatige aanpassing: die blijft staan als MANUAL.
  // Er wordt niets "gerepareerd" (een oude 3126 die 312,6 had moeten zijn is
  // niet te herkennen) — de gebruiker ziet de waarde als "aangepast".
  function fromLegacy(legacyValue, auto, at) {
    var q = create(auto, at);
    if (legacyValue == null || !isFinite(legacyValue)) return q;
    if (auto && legacyValue === auto.value) return q;
    var t = nowIso(at);
    q.manual = { value: legacyValue, unit: auto ? auto.unit : null, text: String(legacyValue), at: t, migrated: true };
    q.history.push({ at: t, event: 'MIGRATED_LEGACY_MANUAL', value: legacyValue, source: SOURCES.MANUAL, previous: auto ? auto.value : null });
    return refresh(q);
  }

  function isValid(q) {
    return !!q && typeof q === 'object' && Array.isArray(q.history) && ('auto' in q) && ('manual' in q);
  }

  // -------------------------------------------------------------------
  // Automatische hoeveelheden uit gebouwgegevens (BAG / 3D BAG)
  // -------------------------------------------------------------------
  //
  // building.d3raw (nieuw, v1) bevat de ongeronde 3D BAG-attributen;
  // oudere plannen hebben alleen de afgeronde building.d3. building.bagRaw
  // bevat de ongeronde footprint/omtrek.

  function d3Attr(b, rawField, roundedField) {
    if (b.d3raw && b.d3raw.attributes && b.d3raw.attributes[rawField] != null) {
      return { value: b.d3raw.attributes[rawField], rounded: false };
    }
    if (b.d3 && b.d3[roundedField] != null) return { value: b.d3[roundedField], rounded: true };
    return null;
  }

  function d3RawMeta(b, field, value, rounded) {
    return {
      field: field,
      value: value,
      rounded_in_legacy_plan: !!rounded,
      pand_id: (b.d3raw && b.d3raw.pandId) || (b.identificatie ? 'NL.IMBAG.Pand.' + b.identificatie : null),
      fetched_at: (b.d3raw && b.d3raw.fetchedAt) || null,
      source_name: '3D BAG (TU Delft), api.3dbag.nl',
    };
  }

  function round2(v) { return Math.round(v * 100) / 100; }

  function footprint(b) {
    if (b.bagRaw && b.bagRaw.footprintM2 != null) return b.bagRaw.footprintM2;
    return b.opp;
  }

  // bron: de bestaande `bron`-sleutels van de elementenbibliotheek.
  // opts.benadering: de hoeveelheid is een proxy voor iets anders (bijv. de
  // hele buitenmuur als schilderwerkoppervlak) -> altijd ESTIMATED, ook als
  // het getal zelf uit 3D BAG komt.
  function autoFor(bron, b, opts) {
    opts = opts || {};
    if (!b || !bron || bron === 'none') return null;
    if (b.isVoorbeeld) {
      return autoQuantity(voorbeeldWaarde(bron, b), bron === 'units' ? 'app' : 'm2', SOURCES.ESTIMATED,
        'Voorbeeldgebouw: fictieve waarde, geen gemeten gegevens.', null);
    }
    var a;
    if (bron === 'dakPlatM2') {
      a = d3Attr(b, 'b3_opp_dak_plat', 'plat');
      if (a) return autoQuantity(round2(a.value), 'm2', SOURCES.THREE_D_BAG, 'Plat dakoppervlak uit het 3D BAG-model (b3_opp_dak_plat).', d3RawMeta(b, 'b3_opp_dak_plat', a.value, a.rounded));
      return autoQuantity(round2(footprint(b)), 'm2', SOURCES.ESTIMATED,
        'Geen 3D BAG-gegevens: het grondvlak van het BAG-pand is als benadering van het platte dak gebruikt.',
        { field: 'BAG pandgeometrie (grondvlak)', value: footprint(b), source_name: 'BAG (PDOK)' });
    }
    if (bron === 'dakSchuinM2') {
      a = d3Attr(b, 'b3_opp_dak_schuin', 'schuin');
      if (a) return autoQuantity(round2(a.value), 'm2', SOURCES.THREE_D_BAG, 'Hellend dakoppervlak uit het 3D BAG-model (b3_opp_dak_schuin).', d3RawMeta(b, 'b3_opp_dak_schuin', a.value, a.rounded));
      return autoQuantity(0, 'm2', SOURCES.ESTIMATED, 'Geen 3D BAG-gegevens: hellend dakoppervlak onbekend, 0 aangenomen.', null);
    }
    if (bron === 'dakM2') {
      var p = d3Attr(b, 'b3_opp_dak_plat', 'plat'), s = d3Attr(b, 'b3_opp_dak_schuin', 'schuin');
      // Plan van vóór v1 (geen ruwe waarden): het oude totaal was
      // round(plat + schuin) over de ongeronde waarden — dat getal
      // hergebruiken i.p.v. twee afgeronde waarden op te tellen, anders
      // lijkt een oude, ongewijzigde hoeveelheid ineens "aangepast".
      if (!b.d3raw && b.d3 && b.d3.dak != null) {
        return autoQuantity(b.d3.dak, 'm2', SOURCES.GEOMETRY_DERIVED,
          'Som van plat en hellend dakoppervlak uit 3D BAG (b3_opp_dak_plat + b3_opp_dak_schuin).',
          { formula: 'round(b3_opp_dak_plat + b3_opp_dak_schuin)', value: b.d3.dak, rounded_in_legacy_plan: true });
      }
      if (p || s) {
        var pv = p ? p.value : 0, sv = s ? s.value : 0;
        return autoQuantity(round2(pv + sv), 'm2', SOURCES.GEOMETRY_DERIVED,
          'Som van plat en hellend dakoppervlak uit 3D BAG (b3_opp_dak_plat + b3_opp_dak_schuin).',
          { formula: 'b3_opp_dak_plat + b3_opp_dak_schuin', inputs: [d3RawMeta(b, 'b3_opp_dak_plat', pv, p && p.rounded), d3RawMeta(b, 'b3_opp_dak_schuin', sv, s && s.rounded)] });
      }
      return autoQuantity(round2(footprint(b)), 'm2', SOURCES.ESTIMATED,
        'Geen 3D BAG-gegevens: het grondvlak van het BAG-pand is als benadering van het dakoppervlak gebruikt.',
        { field: 'BAG pandgeometrie (grondvlak)', value: footprint(b), source_name: 'BAG (PDOK)' });
    }
    if (bron === 'gevelM2') {
      a = d3Attr(b, 'b3_opp_buitenmuur', 'gevel');
      if (a && a.value) {
        var raw = d3RawMeta(b, 'b3_opp_buitenmuur', a.value, a.rounded);
        if (opts.benadering) {
          return autoQuantity(round2(a.value), 'm2', SOURCES.ESTIMATED,
            'Benadering: het hele buitenmuuroppervlak uit 3D BAG (bruto, incl. ramen) is als oppervlak voor deze post gebruikt.', raw);
        }
        return autoQuantity(round2(a.value), 'm2', SOURCES.THREE_D_BAG, 'Buitenmuuroppervlak uit het 3D BAG-model (b3_opp_buitenmuur, bruto: ramen en deuren niet afgetrokken).', raw);
      }
      var omtrek = (b.bagRaw && b.bagRaw.omtrekM != null) ? b.bagRaw.omtrekM : b.omtrek;
      // Plan van vóór v1: het oude getal (round(ongeronde omtrek × 9)) staat
      // al in gevelM2 en is niet uit de afgeronde omtrek te reconstrueren.
      var gevelSchatting = (!b.bagRaw && b.gevelM2 != null) ? b.gevelM2 : round2(omtrek * 3 * 3);
      return autoQuantity(gevelSchatting, 'm2', SOURCES.ESTIMATED,
        'Geen 3D BAG-gegevens: omtrek van het BAG-pand × 3 bouwlagen × 3 m aangenomen.',
        { formula: 'omtrek × 3 × 3', inputs: [{ field: 'BAG pandgeometrie (omtrek)', value: omtrek, source_name: 'BAG (PDOK)' }] });
    }
    if (bron === 'units') {
      var bag = b.unitsBron != null && b.units === b.unitsBron;
      return autoQuantity(b.units, 'app', bag ? SOURCES.BAG : SOURCES.MANUAL,
        bag ? 'Aantal verblijfsobjecten in de BAG; de post wordt per appartement begroot.' : 'Aantal appartementen zoals door jou ingevuld op het Gebouw-scherm; de post wordt per appartement begroot.',
        { field: 'aantal_verblijfsobjecten', value: b.unitsBron, source_name: 'BAG (PDOK)' });
    }
    return null;
  }

  function voorbeeldWaarde(bron, b) {
    if (bron === 'dakPlatM2') return (b.d3 && b.d3.plat != null) ? b.d3.plat : b.dakM2;
    if (bron === 'dakSchuinM2') return (b.d3 && b.d3.schuin) || 0;
    if (bron === 'dakM2') return b.dakM2;
    if (bron === 'gevelM2') return b.gevelM2;
    if (bron === 'units') return b.units;
    return 0;
  }

  // Kozijnaantallen: altijd een schatting (appartementen × vaste factor).
  var KOZ_FACTOREN = [1, 0.25, 0.125, 0.125];
  var KOZ_MINIMA = [1, 0, 1, 0];
  function autoKozijn(i, b) {
    var f = KOZ_FACTOREN[i];
    if (f == null || !b) return null;
    var v = Math.max(KOZ_MINIMA[i], Math.round(b.units * f));
    return autoQuantity(v, 'st', SOURCES.ESTIMATED,
      'Schatting: ' + formatNumber(b.units) + ' appartementen × ' + formatNumber(f) + ' (vaste factor, niet geteld).',
      { formula: 'max(' + KOZ_MINIMA[i] + ', round(appartementen × ' + f + '))', inputs: [{ field: 'appartementen', value: b.units }] });
  }

  // -------------------------------------------------------------------
  // Offertebedragen (zelfde regels als mjop-learning scripts/nl_values.py)
  // -------------------------------------------------------------------
  //
  // Generiek: "1250" en "1.250,50" en "1250,50" zijn eenduidig. "1250.50" en
  // "1,250.50" zijn ook eenduidig (punt met 1-2 decimalen kan geen duizendtal
  // zijn). "1.250" is dubbelzinnig (1250 of 1,25) en wordt alleen als 1250
  // gelezen onder de expliciete profielregel "hele euro's": binnen dezelfde
  // offerte staat geen enkel bedrag met decimalen. Anders: niet geraden.
  var RE_INT = /^\d+$/, RE_NL_GROUPED = /^\d{1,3}(\.\d{3})+$/, RE_NL_DEC = /^(\d{1,3}(\.\d{3})+|\d+),(\d+)$/;
  var RE_DOT_DEC = /^\d+\.\d{1,2}$/, RE_EN_GROUPED = /^\d{1,3}(,\d{3})+\.\d{1,2}$/;

  function cleanAmount(text) {
    return String(text == null ? '' : text).replace(/\u00a0/g, ' ').replace(/€/g, '').replace(/\s+/g, '');
  }

  function parseAmountGeneric(text) {
    var t = cleanAmount(text);
    if (!t) return { ok: true, value: 0, empty: true, profile: null };
    if (RE_INT.test(t)) return { ok: true, value: Number(t), profile: 'generic' };
    if (RE_NL_GROUPED.test(t)) return { ok: false, error: 'ambiguous_thousands_or_decimal' };
    var m = RE_NL_DEC.exec(t);
    if (m) return { ok: true, value: Number(m[1].replace(/\./g, '') + '.' + m[3]), profile: 'generic', hasDecimals: true };
    if (RE_DOT_DEC.test(t)) return { ok: true, value: Number(t), profile: 'dot_decimal', hasDecimals: true };
    if (RE_EN_GROUPED.test(t)) return { ok: true, value: Number(t.replace(/,/g, '')), profile: 'en_grouped', hasDecimals: true };
    return { ok: false, error: 'not_a_number' };
  }

  // Leest alle regels van één offerte samen (de profielregel heeft het bewijs
  // van de hele offerte nodig). Resultaat per regel: {ok, value, error, profile}.
  function parseOfferteAmounts(texts) {
    var parsed = texts.map(parseAmountGeneric);
    var grouped = texts.filter(function (t) { return RE_NL_GROUPED.test(cleanAmount(t)); }).length;
    var withDecimals = parsed.filter(function (p) { return p.ok && p.hasDecimals; }).length;
    var other = parsed.filter(function (p) { return !p.ok && p.error === 'not_a_number'; }).length;
    var wholeEuro = grouped > 0 && withDecimals === 0 && other === 0;
    return parsed.map(function (p, i) {
      if (p.ok || p.error !== 'ambiguous_thousands_or_decimal') return p;
      if (wholeEuro) return { ok: true, value: Number(cleanAmount(texts[i]).replace(/\./g, '')), profile: 'whole_euro_dot_thousands' };
      return p;
    });
  }

  function amountErrorText(error) {
    if (error === 'ambiguous_thousands_or_decimal') return 'Onduidelijk bedrag: 1.250 kan 1250 of 1,25 zijn. Schrijf 1250 of 1250,00.';
    return 'Geen geldig bedrag.';
  }

  // -------------------------------------------------------------------
  // Bundel met bronnen uit mjop-learning (scripts/export_app_quantity_bundle.py)
  // -------------------------------------------------------------------
  //
  // Twee versies (backwards-compatible):
  //   v1  precies één BAG-pand; dat pand moet het pand van het plan zijn (ongewijzigd).
  //   v2  een VvE-/gebouwscope met meerdere panden (building_scope). Het pand van
  //       het plan moet één van de panden van de scope zijn. Bronnen staan op
  //       complexniveau (scope_level COMPLEX): het 3D BAG-totaal is een som van de
  //       panden (components), de historische waarde gaat over de hele scope.
  //       Niets wordt over panden verdeeld; pandwaarden zijn geen losse bronnen.
  // Geeft {ok, errors, scope, entries:[{app_element_key, evidence}]}. Er wordt
  // nooit een bron gekozen of gemiddeld; dat doet de gebruiker.
  var BUNDLE_V1 = 'mjop_app_quantity_bundle_v1', BUNDLE_V2 = 'mjop_app_quantity_bundle_v2';

  function bundleEntries(bundle, building) {
    var errors = [];
    var version = bundle && bundle.bundle_version;
    if (version !== BUNDLE_V1 && version !== BUNDLE_V2) errors.push('Dit is geen hoeveelhedenbundel uit mjop-learning (bundle_version).');
    var pand = building && building.identificatie ? String(building.identificatie) : '';
    var ids = (bundle && bundle.bag_pand_ids) || [];
    var scope = null;
    if (!errors.length && version === BUNDLE_V1) {
      if (ids.length !== 1) errors.push('De bundel gaat over ' + ids.length + ' panden; een v1-bundel hoort bij één pand.');
      else if (!pand || ids[0] !== pand) errors.push('De bundel hoort bij pand ' + (ids[0] || '?') + ', dit plan bij pand ' + (pand || 'onbekend') + '.');
    }
    if (!errors.length && version === BUNDLE_V2) {
      var bs = bundle.building_scope || {};
      var sids = (bs.bag_pand_ids || []).map(String);
      if (!sids.length || sids.join('+') !== ids.map(String).join('+') || bs.building_id !== bundle.building_id) {
        errors.push('De gebouwscope van de bundel is niet consistent (building_scope).');
      } else if (!pand || sids.indexOf(pand) === -1) {
        errors.push('De bundel hoort bij ' + sids.length + ' panden (' + sids.join(', ') + '); dit plan hoort bij pand ' + (pand || 'onbekend') + '.');
      } else {
        scope = { building_id: bs.building_id, bag_pand_ids: sids, pand_count: sids.length, plan_pand_id: pand };
      }
    }
    if (errors.length) return { ok: false, errors: errors, entries: [], scope: null };
    var entries = (bundle.entries || []).map(function (e) {
      var ev = e.evidence || {};
      var src = ev.source_type === '3D_BAG' ? SOURCES.THREE_D_BAG : (ev.source_type === 'MJOP_ELEMENT_OVERVIEW' ? SOURCES.IMPORTED_MJOP : null);
      var comps = scope ? (ev.components || []).map(function (c) {
        return { bag_pand_id: String(c.bag_pand_id), value: c.value == null ? null : Number(c.value), value_text: c.value,
          unit: normalizeUnit(c.unit) || c.unit, evidence_id: c.evidence_id, method_class: c.method_class, rule_id: c.rule_id,
          snapshot_id: c.snapshot_id, fetched_at: c.fetched_at };
      }) : [];
      var basis;
      if (src === SOURCES.IMPORTED_MJOP) {
        basis = 'Historisch MJOP (' + (ev.source_ref && ev.source_ref.document_id) + '), zoals vermeld in het elementenoverzicht' +
          (scope ? ', op complexniveau (hele VvE-scope van ' + scope.pand_count + ' panden; niet over panden verdeeld).' : '.');
      } else if (scope && comps.length) {
        basis = '3D BAG via mjop-learning: som van ' + comps.length + ' panden (' + (ev.formula || 'SUM') + ').';
      } else {
        basis = '3D BAG via mjop-learning (' + ((ev.source_ref && ev.source_ref.rule_id) || '') + ').';
      }
      var out = {
        id: 'bundle:' + ev.evidence_id, source: src, method_class: ev.method_class,
        value: ev.value == null ? null : Number(ev.value), value_text: ev.value, unit: normalizeUnit(ev.unit) || ev.unit,
        basis: basis,
        source_ref: ev.source_ref || {}, source_cluster: ev.source_cluster || null,
        same_object_document_ids: ev.same_object_document_ids || [], review_reasons: ev.review_reasons || [],
        crosswalk_mapping_id: e.crosswalk_mapping_id, origin: 'MJOP_LEARNING_BUNDLE', evidence_status: ev.status,
      };
      if (scope) {
        out.scope_level = 'COMPLEX';
        out.scope = { building_id: scope.building_id, bag_pand_ids: scope.bag_pand_ids.slice(), pand_count: scope.pand_count };
        out.aggregation = ev.aggregation || null;
        out.formula = ev.formula || null;
        out.components = comps;
      }
      return { app_element_key: e.app_element_key, evidence: out };
    }).filter(function (x) { return x.evidence.source && x.evidence.value != null; });
    return { ok: true, errors: [], entries: entries, scope: scope };
  }

  // Op welk niveau een bron/hoeveelheid geldt: 'COMPLEX' (VvE-scope met meerdere
  // panden) of 'PAND' (de automatische 3D BAG-waarde van het plan, v1-bronnen,
  // handmatige waarden). Een verschil tussen twee niveaus is niet zinvol en wordt
  // niet getoond.
  function scopeLevel(ev) { return (ev && ev.scope_level) || 'PAND'; }

  function effectiveScopeLevel(q) {
    if (q.manual) return 'PAND';
    var sel = selectedEvidence(q);
    return sel ? scopeLevel(sel) : 'PAND';
  }

  var api = {
    SOURCES: SOURCES, STATUS: STATUS, SOURCE_LABELS: SOURCE_LABELS, STATUS_LABELS: STATUS_LABELS,
    parseQuantity: parseQuantity, parseAmount: parseAmount, parseErrorText: parseErrorText,
    formatNumber: formatNumber, normalizeUnit: normalizeUnit, unitLabel: unitLabel,
    autoQuantity: autoQuantity, create: create, refresh: refresh, updateAuto: updateAuto,
    confirm: confirm, override: override, resetToAuto: resetToAuto, fromLegacy: fromLegacy, isValid: isValid,
    addEvidence: addEvidence, selectEvidence: selectEvidence, findEvidence: findEvidence, difference: difference,
    parseOfferteAmounts: parseOfferteAmounts, amountErrorText: amountErrorText, bundleEntries: bundleEntries,
    scopeLevel: scopeLevel, effectiveScopeLevel: effectiveScopeLevel,
    autoFor: autoFor, autoKozijn: autoKozijn, KOZ_FACTOREN: KOZ_FACTOREN,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MJOPQuantity = api;
})(typeof window !== 'undefined' ? window : this);
