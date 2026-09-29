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
  //   history: [ { at, event, value, source, note? } ]   (append-only)
  // }

  function nowIso(at) { return at || new Date().toISOString(); }

  function refresh(q) {
    var eff = q.manual || q.auto || { value: null, unit: null, source: null };
    q.value = eff.value;
    q.unit = eff.unit || (q.auto && q.auto.unit) || null;
    q.source = q.manual ? SOURCES.MANUAL : (q.auto ? q.auto.source : null);
    if (q.manual) q.status = STATUS.USER_OVERRIDDEN;
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
    var unit = (q.manual && q.manual.unit) || (q.auto && q.auto.unit) || null;
    q.manual = { value: value, unit: unit, text: text == null ? String(value) : String(text), at: t };
    q.history.push({ at: t, event: 'USER_OVERRIDDEN', value: value, source: SOURCES.MANUAL, previous: q.auto ? q.auto.value : null });
    return refresh(q);
  }

  function resetToAuto(q, at) {
    if (!q.manual) return refresh(q);
    var t = nowIso(at);
    q.history.push({ at: t, event: 'RESET_TO_AUTO', value: q.auto ? q.auto.value : null, source: q.auto ? q.auto.source : null, previous: q.manual.value });
    q.manual = null;
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

  var api = {
    SOURCES: SOURCES, STATUS: STATUS, SOURCE_LABELS: SOURCE_LABELS, STATUS_LABELS: STATUS_LABELS,
    parseQuantity: parseQuantity, parseAmount: parseAmount, parseErrorText: parseErrorText,
    formatNumber: formatNumber, normalizeUnit: normalizeUnit, unitLabel: unitLabel,
    autoQuantity: autoQuantity, create: create, refresh: refresh, updateAuto: updateAuto,
    confirm: confirm, override: override, resetToAuto: resetToAuto, fromLegacy: fromLegacy, isValid: isValid,
    autoFor: autoFor, autoKozijn: autoKozijn, KOZ_FACTOREN: KOZ_FACTOREN,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MJOPQuantity = api;
})(typeof window !== 'undefined' ? window : this);
