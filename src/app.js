(function () {
  'use strict';

  var CURRENT_YEAR = new Date().getFullYear();
  var HORIZON = 10; // years shown in projections (current year + 9)

  // ---------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------
  function eur(n) {
    if (!isFinite(n)) n = 0;
    return '€ ' + Math.round(n).toLocaleString('nl-NL');
  }
  // Consistente notatie voor een negatief bedrag: het minteken vóór het
  // eurotekens ("-€ 2.652") i.p.v. eur()'s "€ -2.652" (toLocaleString
  // zet het minteken vóór het getal, ná het al geplaatste eurotekens).
  function eurSigned(n) {
    if (!isFinite(n)) n = 0;
    return (n < 0 ? '-' : '') + eur(Math.abs(n));
  }
  function num(v) {
    var n = parseInt(String(v == null ? '' : v).replace(/[^0-9-]/g, ''), 10);
    return isNaN(n) ? 0 : n;
  }
  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
  function meervoud(n, enkelvoud, meervoudVorm) { return n === 1 ? enkelvoud : meervoudVorm; }
  // Voor in het gebruikersblok onderin de zijbalk — een naam leest
  // prettiger dan een (vaak afgekapt) e-mailadres. We houden geen apart
  // naamveld bij, dus dit is een simpele afleiding uit het lokale deel
  // van het e-mailadres ("jan.devries@x.nl" -> "Jan Devries").
  function displayName(email) {
    var local = String(email || '').split('@')[0];
    var naam = local.replace(/[._-]+/g, ' ').trim();
    if (!naam) return email || '';
    return naam.replace(/\w\S*/g, function (w) { return w.charAt(0).toUpperCase() + w.slice(1); });
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function uid(prefix) { return prefix + '-' + Math.random().toString(36).slice(2, 9); }

  // ---------------------------------------------------------------------
  // Upload van een bestaand MJOP (csv/xlsx/pdf) — best-effort extractie,
  // altijd gevolgd door een controleerbare/aanpasbare regel-lijst voordat
  // er iets het plan in gaat.
  // ---------------------------------------------------------------------
  function parseCsv(text) {
    var firstLine = (text.split(/\r?\n/)[0] || '');
    var delim = firstLine.split(';').length > firstLine.split(',').length ? ';' : ',';
    var lines = text.split(/\r?\n/).filter(function (l) { return l.trim().length; });
    return lines.map(function (line) {
      var cells = [], cur = '', inQ = false;
      for (var i = 0; i < line.length; i++) {
        var c = line[i];
        if (c === '"') {
          if (inQ && line[i + 1] === '"') { cur += '"'; i++; } else inQ = !inQ;
        } else if (c === delim && !inQ) { cells.push(cur); cur = ''; }
        else cur += c;
      }
      cells.push(cur);
      return cells.map(function (c) { return c.trim(); });
    });
  }

  // Wijst kolommen toe zonder eenzelfde kolom aan twee velden te geven —
  // anders leest bv. een header "Jaarbedrag" (bevat zowel "jaar" als
  // "bedrag" als deelstring) voor beide velden dezelfde cel uit, en komt
  // het jaartal als kostenbedrag het plan in.
  function guessMapping(header) {
    var used = {};
    function pick(keywords) {
      var idx = -1;
      header.forEach(function (h, i) {
        if (idx === -1 && !used[i] && keywords.some(function (k) { return String(h).toLowerCase().indexOf(k) > -1; })) idx = i;
      });
      if (idx > -1) used[idx] = true;
      return idx;
    }
    return {
      naam: pick(['element', 'omschrijving', 'post', 'onderdeel', 'naam']),
      jaar: pick(['jaar']),
      bedrag: pick(['bedrag', 'kosten', 'prijs', 'investering']),
      sfb: pick(['sfb', 'code']),
      conditie: pick(['conditie', 'score']),
    };
  }

  function isPdfNoiseLine(line) {
    if (/^\d{1,4}$/.test(line)) return true; // los paginanummer
    if (/^(pagina|blz\.?|page)\b/i.test(line)) return true;
    if (/^\d{1,2}[-\/]\d{1,2}[-\/]\d{2,4}$/.test(line)) return true; // datum
    // herhaalde tabelkop, bv. "Code/Element/Handeling ... Hvh Ehd Stj Cy 2023 2024 ...":
    // komt op elke pagina terug en heeft zelf geen hoeveelheid/bedrag.
    var kopwoorden = ['element', 'handeling', 'hoeveelheid', 'ehd', 'stj', 'cy', 'totaal', 'hoofdgroep'];
    var treffers = kopwoorden.reduce(function (n, w) { return n + (line.toLowerCase().indexOf(w) > -1 ? 1 : 0); }, 0);
    if (treffers >= 2) return true;
    return false;
  }

  // Onvoorziene kosten/reserveringspost is een percentage- of vaste
  // opslag op het totaal, geen onderhoudselement — die hoort niet als
  // losse post in het plan (en al helemaal niet aan een gebouwdeel of
  // categorie gekoppeld).
  function isOnvoorzienPost(naam) {
    return /onvoorzien/i.test(naam || '');
  }

  function isVervolgregel(line) {
    // een omschrijving die wrapt naar haar eigen regel (geen cijfers, geen
    // nieuwe NL-SfB-code aan het begin, kort genoeg om een los woord/zin te zijn).
    if (!line || line.length >= 40 || /[0-9]/.test(line)) return false;
    if (/^\d{2,4}\s/.test(line)) return false; // nieuwe elementregel met eigen code
    return /[a-zA-Z]/.test(line);
  }

  // Probeert het prijspeil-jaar van het MJOP zelf te herkennen (professionele
  // MJOP-software vermeldt dit meestal expliciet), zodat de indexering vanaf
  // het juiste jaar begint in plaats van een gok.
  function detectPrijspeilJaar(fullText) {
    // "Prijspeil" wordt meestal gevolgd door een datum (bv. "1-4-2023"); zoek
    // de eerste aaneengesloten reeks van 4 cijfers erna, ongeacht het
    // precieze datumformaat.
    var m = /prijspeil[^\n]{0,40}?(\d{4})(?!\d)/i.exec(fullText);
    return m ? +m[1] : null;
  }

  var PDF_EENHEID = 'm1|m2|m3|st|pst|ver\\.?|stuks?|kg|ton|u|uur';
  // Kenmerkend voor professionele MJOP-tabellen (NEN-2767-achtige software):
  // hoeveelheid + eenheid, gevolgd door het startjaar en desgewenst de cyclus
  // in jaren, vóór de kostenkolommen. Herkent dit patroon ongeacht waar het
  // in de regel staat, zodat het niet aan één specifieke opmaak vastzit.
  var STJ_CY_RE = new RegExp('([0-9]+(?:[.,][0-9]+)?)\\s*(?:' + PDF_EENHEID + ')\\.?\\s+(20[0-6][0-9])(?:\\s+([0-9]{1,3})\\b)?', 'i');

  function eersteBedragNa(tekst) {
    var amountRe = /[0-9]{1,3}(?:[.,][0-9]{3})+(?:[.,][0-9]{2})?|[0-9]+(?:[.,][0-9]{2})|[0-9]{3,}/g;
    var m;
    while ((m = amountRe.exec(tekst))) {
      if (/^20[0-9]{2}$/.test(m[0])) continue; // sluit een ander kaal jaartal uit (bv. "MJOP 2019-2029")
      var bedrag = num(m[0]);
      if (bedrag >= 100) return bedrag;
    }
    return 0;
  }

  // Zoekt regels met een hoeveelheid+eenheid+jaar (het patroon van
  // professionele MJOP-tabellen, zie STJ_CY_RE) en valt terug op "een
  // jaartal met een bedrag erop" voor eenvoudiger exports. Nooit perfect
  // voor elke lay-out, daarom altijd gevolgd door de controleerbare
  // regel-lijst — en de ruwe tekst blijft zichtbaar voor wat de
  // automatische herkenning gemist heeft.
  function extractPdfRegels(fullText) {
    var rawLines = fullText.split('\n').map(function (l) { return l.trim(); });
    var out = [];
    for (var i = 0; i < rawLines.length; i++) {
      var line = rawLines[i];
      if (!line || isPdfNoiseLine(line)) continue;

      var stj = STJ_CY_RE.exec(line);
      var naam, jaar, cyclus, bedrag;
      if (stj) {
        naam = line.slice(0, stj.index).replace(/[€\-–.:]+$/, '').trim();
        jaar = +stj[2];
        cyclus = stj[3] ? +stj[3] : 0;
        bedrag = eersteBedragNa(line.slice(stj.index + stj[0].length));
      } else {
        var ym = /\b(20[2-6][0-9])\b/.exec(line);
        if (!ym) continue;
        var zonderJaar = line.slice(0, ym.index) + ' ' + line.slice(ym.index + ym[0].length);
        bedrag = eersteBedragNa(zonderJaar);
        if (!bedrag) continue;
        naam = zonderJaar.slice(0, zonderJaar.search(/[0-9]/)).replace(/[€\-–.:]+$/, '').trim() || zonderJaar.replace(/[0-9.,€\s]+/g, ' ').trim();
        jaar = +ym[1];
        cyclus = 0;
      }
      // omschrijving die op haar eigen regel wrapt (komt vaak voor in
      // pdf-tabellen) hoort bij de net gevonden regel.
      if (isVervolgregel(rawLines[i + 1])) { naam = (naam + ' ' + rawLines[i + 1]).trim(); i++; }
      if (naam && naam.length >= 3 && bedrag >= 100 && !isOnvoorzienPost(naam)) {
        out.push({ naam: naam, jaar: jaar, bedrag: bedrag, cyclus: cyclus, sfb: '', conditie: '', include: true });
      }
    }
    return out;
  }

  function readFileAsText(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(r.result); };
      r.onerror = function () { reject(new Error('bestand kon niet gelezen worden')); };
      r.readAsText(file);
    });
  }
  function readFileAsArrayBuffer(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(r.result); };
      r.onerror = function () { reject(new Error('bestand kon niet gelezen worden')); };
      r.readAsArrayBuffer(file);
    });
  }

  function extractPdfText(arrayBuffer) {
    if (!window.pdfjsLib) return Promise.reject(new Error('PDF-ondersteuning kon niet geladen worden (geen internetverbinding?)'));
    return pdfjsLib.getDocument({ data: arrayBuffer }).promise.then(function (doc) {
      var pageNums = [];
      for (var i = 1; i <= doc.numPages; i++) pageNums.push(i);
      return pageNums.reduce(function (chain, n) {
        return chain.then(function (acc) {
          return doc.getPage(n).then(function (page) { return page.getTextContent(); }).then(function (tc) {
            var lastY = null, bucket = [];
            var lines = [];
            function flush() {
              if (!bucket.length) return;
              // pdf.js levert tekstfragmenten in tekenvolgorde van het
              // PDF-bestand, niet per se van links naar rechts — vooral in
              // tabellen die kolom voor kolom getekend zijn kan dat de
              // volgorde door elkaar husselen. Op x-positie sorteren
              // herstelt de leesvolgorde binnen elke regel.
              bucket.sort(function (a, b) { return a.x - b.x; });
              lines.push(bucket.map(function (b) { return b.str; }).join(' '));
              bucket = [];
            }
            tc.items.forEach(function (it) {
              var y = it.transform[5], x = it.transform[4];
              if (lastY != null && Math.abs(y - lastY) > 2) flush();
              if (it.str.trim()) bucket.push({ x: x, str: it.str });
              lastY = y;
            });
            flush();
            return acc + lines.join('\n') + '\n';
          });
        });
      }, Promise.resolve(''));
    });
  }

  // ---------------------------------------------------------------------
  // Geometry helpers (BAG polygon area / perimeter), ported from the
  // MJOP Live prototype's real-data lookup logic.
  // ---------------------------------------------------------------------
  function ringArea(ring) {
    var lat0 = ring[0][1] * Math.PI / 180;
    var kx = 111320 * Math.cos(lat0), ky = 110540;
    var a = 0;
    for (var i = 0; i < ring.length - 1; i++) {
      var x1 = ring[i][0] * kx, y1 = ring[i][1] * ky;
      var x2 = ring[i + 1][0] * kx, y2 = ring[i + 1][1] * ky;
      a += x1 * y2 - x2 * y1;
    }
    return Math.abs(a / 2);
  }
  function ringOmtrek(ring) {
    var lat0 = ring[0][1] * Math.PI / 180;
    var kx = 111320 * Math.cos(lat0), ky = 110540;
    var p = 0;
    for (var i = 0; i < ring.length - 1; i++) {
      var dx = (ring[i + 1][0] - ring[i][0]) * kx;
      var dy = (ring[i + 1][1] - ring[i][1]) * ky;
      p += Math.sqrt(dx * dx + dy * dy);
    }
    return p;
  }
  function pointInRing(ring, x, y) {
    var c = false;
    for (var i = 0, j = ring.length - 2; i < ring.length - 1; j = i++) {
      var xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) c = !c;
    }
    return c;
  }

  // ---------------------------------------------------------------------
  // PDOK / BAG / 3D BAG lookups (public, unauthenticated APIs)
  // ---------------------------------------------------------------------
  function suggestAddress(q) {
    var url = 'https://api.pdok.nl/bzk/locatieserver/search/v3_1/suggest?q='
      + encodeURIComponent(q) + '&fq=type:adres&rows=6';
    return fetch(url).then(function (r) { return r.json(); }).then(function (j) {
      var docs = (j.response && j.response.docs) || [];
      return docs.map(function (d) { return { id: d.id, naam: d.weergavenaam }; });
    });
  }

  function lookupBuilding(id, naam) {
    return fetch('https://api.pdok.nl/bzk/locatieserver/search/v3_1/lookup?id='
      + encodeURIComponent(id) + '&fl=weergavenaam,centroide_ll,postcode,woonplaatsnaam')
      .then(function (r) { return r.json(); })
      .then(function (lj) {
        var doc = lj.response.docs[0];
        var m = /POINT\(([-0-9.]+) ([-0-9.]+)\)/.exec(doc.centroide_ll);
        if (!m) throw new Error('geen coordinaat gevonden voor dit adres');
        var lon = parseFloat(m[1]), lat = parseFloat(m[2]);
        var d = 0.00018;
        var bbox = [lon - d, lat - d, lon + d, lat + d].join(',');
        return fetch('https://api.pdok.nl/kadaster/bag/ogc/v2/collections/pand/items?f=json&limit=20&bbox=' + bbox)
          .then(function (r) { return r.json(); })
          .then(function (pj) {
            var feats = (pj.features || []).filter(function (f) { return f.geometry; });
            if (!feats.length) throw new Error('geen pand gevonden op dit adres');
            var scored = feats.map(function (f) {
              var ring = f.geometry.type === 'Polygon' ? f.geometry.coordinates[0] : f.geometry.coordinates[0][0];
              var opp = ringArea(ring);
              var c = ring.reduce(function (a, p) { return [a[0] + p[0] / ring.length, a[1] + p[1] / ring.length]; }, [0, 0]);
              var dist = Math.hypot(c[0] - lon, c[1] - lat);
              return { f: f, ring: ring, opp: opp, omtrek: ringOmtrek(ring), dist: dist, raak: pointInRing(ring, lon, lat) };
            }).sort(function (a, b) { return (b.raak - a.raak) || (a.dist - b.dist); });
            var best = scored[0];
            var p = best.f.properties || {};
            var units = p.aantal_verblijfsobjecten || (p.verblijfsobject ? p.verblijfsobject.length : 0) || 1;

            var afterD3 = Promise.resolve(null);
            if (p.identificatie) {
              afterD3 = fetch('https://api.3dbag.nl/collections/pand/items/NL.IMBAG.Pand.' + p.identificatie)
                .then(function (tr) { return tr.ok ? tr.json() : null; })
                .then(function (tj) {
                  if (!tj) return null;
                  var co = tj.feature.CityObjects['NL.IMBAG.Pand.' + p.identificatie];
                  var a = co && co.attributes;
                  if (!a) return null;
                  var plat = a.b3_opp_dak_plat || 0, schuin = a.b3_opp_dak_schuin || 0;
                  return {
                    dak: Math.round(plat + schuin), plat: Math.round(plat), schuin: Math.round(schuin),
                    gevel: Math.round(a.b3_opp_buitenmuur || 0), grond: Math.round(a.b3_opp_grond || 0),
                    lagen: a.b3_bouwlagen || null, daktype: a.b3_dak_type || '',
                    hoogte: (a.b3_h_dak_max != null && a.b3_h_maaiveld != null)
                      ? Math.round((a.b3_h_dak_max - a.b3_h_maaiveld) * 10) / 10 : null,
                  };
                }).catch(function () { return null; });
            }

            return afterD3.then(function (d3) {
              var dak = d3 && d3.dak ? d3.dak : Math.round(best.opp);
              var gevel = d3 && d3.gevel ? d3.gevel : Math.round(best.omtrek * 3 * 3);
              return {
                adres: doc.weergavenaam,
                bouwjaar: p.bouwjaar || null,
                gebruiksdoel: p.gebruiksdoel || '',
                identificatie: p.identificatie || '',
                opp: Math.round(best.opp),
                omtrek: Math.round(best.omtrek),
                units: units, unitsBron: units, d3: d3,
                dakM2: dak, gevelM2: gevel,
                werkhoogte: d3 && d3.hoogte ? Math.round(d3.hoogte) : 9,
              };
            });
          });
      });
  }

  // ---------------------------------------------------------------------
  // Element model — NL-SfB gecodeerde elementenbibliotheek
  //
  // NL-SfB is de Nederlandse coderingssystematiek voor bouwdelen
  // (Stichting Bouwresearch / elementenmethode), veelgebruikt in MJOP's.
  // De codes hieronder volgen de standaard hoofdgroepen (2x constructie,
  // 3x inbouw, 4x afwerking, 5x werktuigbouw, 6x elektrotechniek,
  // 8x/9x terrein) — de bijbehorende omschrijvingen en kengetallen zijn
  // van deze implementatie, niet uit het (auteursrechtelijk beschermde)
  // NEN/SBR-defectenboek overgenomen.
  // ---------------------------------------------------------------------
  var KOZ_DEF = [['Draaiend raam', 174], ['Vast glas', 96], ['Deur', 240], ['Dakkapel', 320]];

  // Onderhoudsprofiel per kozijnmateriaal: eigen cyclus (jaar) en een
  // factor op het houten-kozijn-tarief (aluminium/kunststof hebben geen
  // periodiek schilderwerk nodig, alleen reiniging/afstellen; staal zit
  // ertussenin met roestbehandeling).
  var KOZ_MATERIAAL = {
    hout: { label: 'Hout', cyclus: 6, factor: 1 },
    aluminium: { label: 'Aluminium', cyclus: 15, factor: 0.35 },
    kunststof: { label: 'Kunststof (pvc)', cyclus: 20, factor: 0.2 },
    staal: { label: 'Staal', cyclus: 8, factor: 1.1 },
  };

  // key, naam, categorie, sfb-code, type, cyclus, plus type-specifieke velden.
  // optioneel:true → niet standaard in het plan, wel te kiezen via
  // "Element toevoegen → uit bibliotheek".
  var ELEMENT_LIBRARY = [
    { key: 'dak-plat', naam: 'Dakbedekking plat dak', categorie: 'Dak', sfb: '27.1', type: 'dak', cyclus: 25, kengetal: 165, bron: 'dakPlatM2', optioneel: true },
    { key: 'dakgoten', naam: 'Dakgoten en hemelwaterafvoeren', categorie: 'Dak', sfb: '27.3', type: 'vast-variabel', cyclus: 20, basis: 300, perEenheid: 90, bron: 'units' },
    { key: 'dakinspectie', naam: 'Dakinspectie en klein onderhoud', categorie: 'Dak', sfb: '27', type: 'vast-variabel', cyclus: 2, basis: 420, perEenheid: 2, bron: 'dakM2' },
    { key: 'dak-hellend', naam: 'Dakbedekking hellend dak (pannen)', categorie: 'Dak', sfb: '27.2', type: 'dak', cyclus: 40, kengetal: 95, bron: 'dakSchuinM2', optioneel: true },
    { key: 'dakisolatie', naam: 'Dakisolatie na-isoleren', categorie: 'Dak', sfb: '47.2', type: 'dak', cyclus: 30, kengetal: 60, bron: 'dakM2', optioneel: true },

    { key: 'gevel-metselwerk', naam: 'Gevelreiniging en metselwerkherstel', categorie: 'Gevel', sfb: '21.1', type: 'gevel', cyclus: 15, kengetal: 26, bron: 'gevelM2' },
    { key: 'schilderwerk-buiten', naam: 'Schilderwerk buitenkozijnen en gevelhoutwerk', categorie: 'Gevel', sfb: '31.2', type: 'gevel', cyclus: 6, kengetal: 22, bron: 'gevelM2' },
    { key: 'kozijnen-onderhoud', naam: 'Onderhoud buitenkozijnen', categorie: 'Gevel', sfb: '31.1', type: 'kozijnen', cyclus: 6 },
    { key: 'steiger', naam: 'Steiger of hoogwerker', categorie: 'Gevel', sfb: '21', type: 'steiger', cyclus: 6, bron: 'gevelM2' },
    { key: 'voegwerk', naam: 'Voegwerk buitengevel', categorie: 'Gevel', sfb: '21.1', type: 'gevel', cyclus: 30, kengetal: 45, bron: 'gevelM2', optioneel: true },
    { key: 'balkonhekken', naam: 'Balkonhekken en borstweringen', categorie: 'Gevel', sfb: '34.1', type: 'per-unit', cyclus: 20, kengetal: 210, bron: 'units', optioneel: true },

    { key: 'intercom', naam: 'Intercom en video-deuropener', categorie: 'Installaties', sfb: '66', type: 'per-unit', cyclus: 20, kengetal: 575, bron: 'units' },
    { key: 'riolering', naam: 'Riolering en hemelwaterafvoer (inpandig)', categorie: 'Installaties', sfb: '52', type: 'vast-variabel', cyclus: 10, basis: 1100, perEenheid: 120, bron: 'units' },
    { key: 'elektra', naam: 'Elektrische installatie gemeenschappelijk', categorie: 'Installaties', sfb: '62/63', type: 'vast-variabel', cyclus: 25, basis: 800, perEenheid: 90, bron: 'units', optioneel: true },
    { key: 'verlichting', naam: 'Verlichting gemeenschappelijke ruimten', categorie: 'Installaties', sfb: '64', type: 'per-unit', cyclus: 15, kengetal: 65, bron: 'units', optioneel: true, aanbevolen: true },
    { key: 'waterleiding', naam: 'Waterleiding gemeenschappelijk', categorie: 'Installaties', sfb: '52', type: 'vast-variabel', cyclus: 30, basis: 600, perEenheid: 55, bron: 'units', optioneel: true },
    { key: 'brandveiligheid', naam: 'Brandveiligheid (blusmiddelen, vluchtwegverlichting)', categorie: 'Installaties', sfb: '67', type: 'per-unit', cyclus: 10, kengetal: 45, bron: 'units', optioneel: true, aanbevolen: true },
    { key: 'cv-installatie', naam: 'Collectieve cv-installatie (ketel)', categorie: 'Installaties', sfb: '51', type: 'vast-variabel', cyclus: 18, basis: 3500, perEenheid: 350, bron: 'units', optioneel: true, aanbevolen: true },
    { key: 'ventilatie', naam: 'Mechanische ventilatie', categorie: 'Installaties', sfb: '57', type: 'per-unit', cyclus: 15, kengetal: 220, bron: 'units', optioneel: true, aanbevolen: true },
    { key: 'lift', naam: 'Liftinstallatie — onderhoud en modernisering', categorie: 'Installaties', sfb: '59', type: 'vast-variabel', cyclus: 20, basis: 12000, perEenheid: 0, bron: 'none', optioneel: true },

    { key: 'trappenhuis', naam: 'Trappenhuis en entree', categorie: 'Binnen', sfb: '42/43', type: 'per-unit', cyclus: 8, kengetal: 480, bron: 'units' },
    { key: 'vloerafwerking', naam: 'Vloerafwerking gemeenschappelijke ruimten', categorie: 'Binnen', sfb: '43', type: 'per-unit', cyclus: 15, kengetal: 120, bron: 'units', optioneel: true },

    { key: 'bestrating', naam: 'Bestrating en terreininrichting', categorie: 'Terrein', sfb: '81/89', type: 'vast-variabel', cyclus: 20, basis: 500, perEenheid: 60, bron: 'units', optioneel: true, aanbevolen: true },
    { key: 'fietsenstalling', naam: 'Fietsenstalling en bergingen', categorie: 'Terrein', sfb: '89', type: 'per-unit', cyclus: 25, kengetal: 150, bron: 'units', optioneel: true },
  ];

  function libraryEntry(key) {
    var found = null;
    ELEMENT_LIBRARY.forEach(function (d) { if (d.key === key) found = d; });
    return found;
  }

  // Categorie raden voor een geïmporteerde of handmatig toegevoegde post,
  // zodat niet alles in "Overig" belandt. Eerst op NL-SfB-hoofdgroep (uit
  // de bibliotheek zelf afgeleid), dan op trefwoorden in de naam — werkt
  // dus ook zonder SfB-code en met opmaak van andere MJOP-leveranciers.
  var SFB_HOOFDGROEP_CATEGORIE = {};
  ELEMENT_LIBRARY.forEach(function (d) {
    String(d.sfb).split('/').forEach(function (code) {
      var hoofd = code.split('.')[0].trim();
      if (hoofd && !SFB_HOOFDGROEP_CATEGORIE[hoofd]) SFB_HOOFDGROEP_CATEGORIE[hoofd] = d.categorie;
    });
  });

  var CATEGORIE_KEYWORDS = [
    ['Dak', ['dak', 'goot', 'hemelwaterafvoer', 'dakkapel', 'dakraam', 'dakisolatie', 'dakterras']],
    ['Gevel', ['gevel', 'kozijn', 'voeg', 'metselwerk', 'buitenschilder', 'schilderwerk buiten', 'balkon', 'hekwerk', 'borstwering', 'steiger', 'stucwerk', 'raam', 'buitendeur', 'pui']],
    ['Installaties', ['lift', 'cv-installatie', 'cv-ketel', 'ketel', 'elektra', 'elektrisch', 'verlichting', 'riool', 'riolering', 'waterleiding', 'intercom', 'brandveilig', 'blusmiddel', 'rookmelder', 'ventilatie', 'installatie', 'verwarming', 'gasleiding', 'zonnepaneel', 'noodverlichting', 'video-deuropener']],
    ['Binnen', ['trappenhuis', 'trapportaal', 'vloerafwerking', 'entree', 'plafond', 'binnenschilder', 'gemeenschappelijke ruimte', 'liftschacht']],
    ['Terrein', ['bestrating', 'terrein', 'tuin', 'erfafscheiding', 'fietsenstalling', 'berging', 'parkeer']],
  ];

  function guessCategorie(naam, sfb) {
    if (sfb) {
      var codes = String(sfb).split('/');
      for (var i = 0; i < codes.length; i++) {
        var hoofd = codes[i].split('.')[0].trim();
        if (SFB_HOOFDGROEP_CATEGORIE[hoofd]) return SFB_HOOFDGROEP_CATEGORIE[hoofd];
      }
    }
    var lower = (naam || '').toLowerCase();
    for (var c = 0; c < CATEGORIE_KEYWORDS.length; c++) {
      var woorden = CATEGORIE_KEYWORDS[c][1];
      for (var w = 0; w < woorden.length; w++) {
        if (lower.indexOf(woorden[w]) > -1) return CATEGORIE_KEYWORDS[c][0];
      }
    }
    return 'Overig';
  }

  function bronWaarde(bron, b) {
    if (bron === 'dakM2') return b.dakM2;
    // 3D BAG levert plat/schuin dakoppervlak apart (b3_opp_dak_plat/
    // -_schuin); zonder die data (geen 3D-match, of het voorbeeldgebouw)
    // valt dakPlatM2 terug op het hele dakoppervlak — het oude gedrag,
    // dat een plat dak aanneemt.
    if (bron === 'dakPlatM2') return (b.d3 && b.d3.plat != null) ? b.d3.plat : b.dakM2;
    if (bron === 'dakSchuinM2') return (b.d3 && b.d3.schuin) || 0;
    if (bron === 'gevelM2') return b.gevelM2;
    if (bron === 'units') return b.units;
    return 0;
  }

  function scaleKozCounts(units) {
    return [
      Math.max(1, Math.round(units * 1)),
      Math.max(0, Math.round(units * 0.25)),
      Math.max(1, Math.round(units * 0.125)),
      Math.max(0, Math.round(units * 0.125)),
    ];
  }

  function defaultBuilding() {
    return {
      adres: 'Voorbeeldgebouw — portiekflat', bouwjaar: 1978, units: 8, unitsBron: 8,
      dakM2: 140, gevelM2: 220, werkhoogte: 9, opp: 140, omtrek: 60,
      identificatie: '', gebruiksdoel: 'woonfunctie', d3: null, isVoorbeeld: true,
    };
  }

  // Bouwt een element-instantie uit een bibliotheek-definitie, geschaald
  // op de werkelijke (of voorbeeld-)gebouwgegevens.
  function instantiateLibraryEl(def, b) {
    var el = {
      id: def.key, naam: def.naam, categorie: def.categorie, sfb: def.sfb,
      type: def.type, cyclus: def.cyclus, bron: def.bron,
      laatsteBeurt: b.bouwjaar || (CURRENT_YEAR - def.cyclus), gebreken: [],
    };
    if (def.type === 'kozijnen') {
      var counts = scaleKozCounts(b.units);
      el.koz = KOZ_DEF.map(function (d, i) {
        return { naam: d[0], tarief: d[1], aantal: counts[i], eigenTarief: null, materiaal: 'hout' };
      });
    } else if (def.type === 'dak' || def.type === 'gevel') {
      el.hoeveelheid = bronWaarde(def.bron, b);
      el.kengetal = def.kengetal;
    } else if (def.type === 'steiger') {
      el.hoeveelheid = bronWaarde(def.bron, b);
      el.werkhoogte = b.werkhoogte;
    } else if (def.type === 'per-unit') {
      el.hoeveelheid = bronWaarde(def.bron, b);
      el.kengetal = def.kengetal;
    } else if (def.type === 'vast-variabel') {
      el.hoeveelheid = bronWaarde(def.bron, b);
      el.basis = def.basis;
      el.perEenheid = def.perEenheid;
    }
    return el;
  }

  // Plat en hellend dak worden allebei standaard aangeboden, maar alleen
  // als ze relevant zijn voor dít gebouw — op basis van de plat/schuin-
  // verdeling die de 3D BAG al aanlevert. Zonder 3D-data (bijv. het
  // voorbeeldgebouw) valt dit terug op "plat dak", het oude gedrag.
  function buildDefaultElements(b) {
    var schuin = bronWaarde('dakSchuinM2', b);
    var plat = bronWaarde('dakPlatM2', b);
    return ELEMENT_LIBRARY.filter(function (d) {
      if (d.key === 'dak-hellend') return schuin > 0;
      if (d.key === 'dak-plat') return !(schuin > 0 && plat === 0);
      return !d.optioneel;
    }).map(function (d) { return instantiateLibraryEl(d, b); });
  }

  // ---------------------------------------------------------------------
  // NEN 2767-methodiek (vereenvoudigd) — gebreken vastleggen i.p.v. een
  // losse conditie-schuif. Per gebrek wordt ernst, omvang en intensiteit
  // (elk 1-3) vastgelegd; de conditiescore (1-6, conform de NEN 2767-schaal
  // "uitstekend" t/m "zeer slecht") volgt uit het zwaarste gebrek. Dit is
  // een praktische toepassing van de systematiek voor planningsdoeleinden,
  // geen vervanging voor een inspectie door een gecertificeerd inspecteur.
  // ---------------------------------------------------------------------
  var CONDITIE_LABELS = {
    1: 'Uitstekend', 2: 'Goed', 3: 'Redelijk', 4: 'Matig', 5: 'Slecht', 6: 'Zeer slecht',
  };

  // Generieke, zelf geformuleerde gebrekomschrijvingen per categorie
  // (geen letterlijke NEN/SBR-defectcatalogus).
  var GEBREK_SUGGESTIES = {
    Dak: ['Scheurvorming in het dakvlak', 'Blaasvorming of loslating van de bedekking', 'Lekkage of vochtdoorslag', 'Verwering/UV-schade oppervlak', 'Vervuiling of mosgroei', 'Beschadigde randafwerking of loodwerk'],
    Gevel: ['Scheurvorming in het metselwerk', 'Loszittend of uitgesleten voegwerk', 'Vochtdoorslag of vochtplekken', 'Rot of scheurvorming in kozijnhout', 'Beschadigde of verweerde coating/verflaag', 'Corrosie aan hang- en sluitwerk'],
    Installaties: ['Storingen of uitval', 'Verouderde/niet meer leverbare onderdelen', 'Corrosie aan leidingwerk', 'Ontbrekende of verlopen keuringen', 'Slijtage aan bewegende delen'],
    Binnen: ['Slijtage van het oppervlak', 'Vochtplekken of schimmelvorming', 'Beschadigde afwerklaag', 'Loszittende onderdelen'],
    Terrein: ['Verzakking of scheefstand', 'Slijtage van het oppervlak', 'Onkruidgroei in voegen', 'Beschadigingen door gebruik'],
    Overig: ['Slijtage', 'Zichtbare schade', 'Einde technische levensduur'],
  };

  function gebrekScore(ernst, omvang, intensiteit) {
    var som = ernst + omvang + intensiteit; // 3..9
    if (som <= 4) return 1;
    if (som <= 5) return 2;
    if (som <= 6) return 3;
    if (som === 7) return 4;
    if (som === 8) return 5;
    return 6;
  }

  function conditionScore(el) {
    if (!el.gebreken || !el.gebreken.length) return null;
    var max = 0;
    el.gebreken.forEach(function (g) {
      var s = gebrekScore(g.ernst, g.omvang, g.intensiteit);
      if (s > max) max = s;
    });
    return max;
  }

  // ---------------------------------------------------------------------
  // Cost + scheduling
  // ---------------------------------------------------------------------
  function kozTarief(k) {
    var mat = KOZ_MATERIAAL[k.materiaal] || KOZ_MATERIAAL.hout;
    return k.eigenTarief != null ? k.eigenTarief : Math.round(k.tarief * mat.factor);
  }
  function kozCyclus(k) { return (KOZ_MATERIAAL[k.materiaal] || KOZ_MATERIAAL.hout).cyclus; }

  // Groepeert kozijnrijen op onderhoudscyclus (die volgt uit het materiaal):
  // verschillende materialen op hetzelfde element worden dus apart in de
  // tijd gezet in plaats van als één post.
  function kozGroepen(el) {
    var byCyclus = {};
    el.koz.forEach(function (k) {
      var c = kozCyclus(k);
      if (!byCyclus[c]) byCyclus[c] = [];
      byCyclus[c].push(k);
    });
    return Object.keys(byCyclus).map(function (c) {
      var rows = byCyclus[c];
      var bedrag = rows.reduce(function (a, k) { return a + k.aantal * kozTarief(k); }, 0);
      var aantal = rows.reduce(function (a, k) { return a + k.aantal; }, 0);
      var materialen = rows.map(function (k) { return (KOZ_MATERIAAL[k.materiaal] || KOZ_MATERIAAL.hout).label; })
        .filter(function (v, i, arr) { return arr.indexOf(v) === i; });
      return { cyclus: +c, bedrag: bedrag, aantal: aantal, materialen: materialen };
    });
  }

  var INDEXATIE_PCT = 0.03; // terugval-schatting (3%/jaar) als de CBS-aanroep hieronder niet lukt

  // cbsIndexatie wordt null totdat laadCbsIndexatie() succesvol is geweest
  // (of blijft null bij een mislukte poging) — indexeerBedrag() valt dan
  // terug op INDEXATIE_PCT. Nooit blokkerend voor de rest van de app, net
  // als de bestaande PDOK/BAG-aanroepen die ook wel eens niet lukken.
  var cbsIndexatie = null; // { pct, periode } — pct als heel percentage (3.2 = 3,2%), periode bv. "2025"
  var CBS_TABEL = '83547NED'; // "Productie gebouwen, prijsindex 2015=100" — controleer bij een opvolger-tabel
  var CBS_VELD = 'BestaandeWoningen_7'; // "Bestaande woningen": prijsindex voor uitbreiding/herstel/verbouw van bestaande woningen — de MJOP-situatie, geen nieuwbouw

  function laadCbsIndexatie() {
    try {
      var cached = JSON.parse(localStorage.getItem('mjop-cbs-indexatie') || 'null');
      if (cached && cached.fetchedAt && Date.now() - cached.fetchedAt < 24 * 60 * 60 * 1000) {
        cbsIndexatie = { pct: cached.pct, periode: cached.periode };
        return;
      }
    } catch (e) { /* localStorage niet beschikbaar (privénavigatie e.d.) — gewoon opnieuw ophalen */ }

    // Jaarcijfers (Perioden eindigt op "JJ00") i.p.v. één specifieke rij met
    // $orderby/$top opvragen — zo hoeft maar één, al bevestigde $filter-vorm
    // te kloppen; de twee meest recente jaren worden hierna zelf bepaald.
    var url = 'https://opendata.cbs.nl/ODataApi/odata/' + CBS_TABEL +
      "/TypedDataSet?$filter=substringof('JJ00',Perioden)&$select=Perioden," + CBS_VELD;
    fetch(url).then(function (r) { return r.json(); }).then(function (j) {
      var rows = ((j && j.value) || []).slice().sort(function (a, b) {
        return String(a.Perioden).localeCompare(String(b.Perioden));
      });
      if (rows.length < 2) throw new Error('te weinig CBS-jaarcijfers');
      var nieuw = rows[rows.length - 1], vorig = rows[rows.length - 2];
      var nieuwWaarde = nieuw[CBS_VELD], vorigWaarde = vorig[CBS_VELD];
      if (typeof nieuwWaarde !== 'number' || typeof vorigWaarde !== 'number' || !vorigWaarde) {
        throw new Error('CBS-veld ' + CBS_VELD + ' niet gevonden of geen getal');
      }
      var pct = Math.round((nieuwWaarde / vorigWaarde - 1) * 1000) / 10;
      var periode = String(nieuw.Perioden || '').slice(0, 4);
      cbsIndexatie = { pct: pct, periode: periode };
      try {
        localStorage.setItem('mjop-cbs-indexatie', JSON.stringify({ pct: pct, periode: periode, fetchedAt: Date.now() }));
      } catch (e) {}
      render();
    }).catch(function () {
      // Stil laten mislukken: cbsIndexatie blijft null, indexeerBedrag()/
      // elementMeta() vallen vanzelf terug op INDEXATIE_PCT hieronder.
    });
  }

  // Geïmporteerde posten zijn genoteerd op het prijspeil van het oude MJOP
  // (el.basisjaar). Kosten worden vanaf dat jaar samengesteld doorgerekend
  // naar het jaar waarin de post daadwerkelijk wordt uitgevoerd, met het
  // CBS-jaarpercentage zodra dat geladen is, anders de vaste schatting.
  function indexeerBedrag(bedrag, basisjaar, uitvoeringsjaar) {
    if (basisjaar == null) return bedrag;
    var pct = cbsIndexatie ? cbsIndexatie.pct / 100 : INDEXATIE_PCT;
    return Math.round(bedrag * Math.pow(1 + pct, uitvoeringsjaar - basisjaar));
  }

  function elementCost(el, state) {
    switch (el.type) {
      case 'dak': return el.hoeveelheid * el.kengetal;
      case 'kozijnen': return el.koz.reduce(function (a, k) { return a + k.aantal * kozTarief(k); }, 0);
      case 'gevel': return el.hoeveelheid * el.kengetal;
      case 'steiger': return Math.round(el.hoeveelheid * (el.werkhoogte > 8 ? 11 : 6));
      case 'per-unit': return el.hoeveelheid * el.kengetal;
      case 'vast-variabel': return el.basis + el.hoeveelheid * el.perEenheid;
      case 'custom': return indexeerBedrag(el.bedrag, el.basisjaar, el.jaar);
      default: return 0;
    }
  }

  function elementMeta(el) {
    switch (el.type) {
      case 'dak': return el.hoeveelheid + ' m² × ' + eur(el.kengetal);
      case 'kozijnen': return kozGroepen(el).map(function (g) {
        return g.aantal + ' × ' + g.materialen.join('/') + ' (' + g.cyclus + 'j)';
      }).join(', ');
      case 'gevel': return el.hoeveelheid + ' m² buitenmuur × ' + eur(el.kengetal);
      case 'steiger': return 'werkhoogte ' + el.werkhoogte + ' m';
      case 'per-unit': return el.hoeveelheid + ' ' + meervoud(el.hoeveelheid, 'unit', 'units') + ' × ' + eur(el.kengetal);
      case 'vast-variabel': return eur(el.basis) + ' vast + ' + el.hoeveelheid + ' × ' + eur(el.perEenheid);
      case 'custom':
        var indexPct = cbsIndexatie ? cbsIndexatie.pct : Math.round(INDEXATIE_PCT * 1000) / 10;
        var indexBron = (cbsIndexatie && state.settings.toonCbsBron) ? ' (CBS-bouwkostenindex ' + cbsIndexatie.periode + ')' : '';
        return (el.metaTekst || 'eenmalige post') + (el.basisjaar != null ? ' · prijspeil ' + el.basisjaar + ', +' + indexPct + '%/jaar' + indexBron : '');
      default: return '';
    }
  }

  // First occurrence at/after CURRENT_YEAR of a cycle anchored at `start`.
  function nextOccurrence(cyclus, start) {
    var j = start;
    while (j < CURRENT_YEAR) j += cyclus;
    return j;
  }

  // NEN 2767 conditiescore loopt 1 (uitstekend) t/m 6 (zeer slecht).
  // Onbeoordeeld (geen gebreken vastgelegd) volgt de standaardcyclus vanaf
  // de laatste beurt; een conditiescore schuift het jaar naar voren.
  function yearForCycle(cyclus, laatsteBeurt, score) {
    var baseline = nextOccurrence(cyclus, laatsteBeurt + cyclus);
    if (score == null) return baseline;
    var jarenResterend = Math.round(cyclus * (6 - score) / 5);
    return Math.max(CURRENT_YEAR, CURRENT_YEAR + jarenResterend);
  }

  function conditionYear(el) {
    if (el.type === 'custom') {
      // Een geïmporteerde/handmatige post heeft al een concreet jaar uit
      // het bronbestand; dat blijft leidend (gebreken erop vastleggen mag,
      // maar schuift dit jaar niet op — dat zou het brondocument tegenspreken).
      return el.cyclus ? nextOccurrence(el.cyclus, el.jaar) : el.jaar;
    }
    return yearForCycle(el.cyclus, el.laatsteBeurt, conditionScore(el));
  }

  // Returns [{jaar, bedrag, meta}] within the planning horizon.
  function scheduleFor(el, state) {
    var out = [];
    if (el.type === 'custom') {
      if (el.cyclus) {
        var j = nextOccurrence(el.cyclus, el.jaar);
        while (j <= CURRENT_YEAR + HORIZON - 1) {
          out.push({ jaar: j, bedrag: indexeerBedrag(el.bedrag, el.basisjaar, j), meta: elementMeta(el) });
          j += el.cyclus;
        }
      } else if (el.jaar >= CURRENT_YEAR && el.jaar <= CURRENT_YEAR + HORIZON - 1) {
        out.push({ jaar: el.jaar, bedrag: indexeerBedrag(el.bedrag, el.basisjaar, el.jaar), meta: elementMeta(el) });
      }
      return out;
    }
    if (el.type === 'kozijnen') {
      var score = conditionScore(el);
      kozGroepen(el).forEach(function (g) {
        var first = yearForCycle(g.cyclus, el.laatsteBeurt, score);
        var meta = g.aantal + ' × ' + g.materialen.join('/');
        var j3 = first;
        while (j3 <= CURRENT_YEAR + HORIZON - 1) { out.push({ jaar: j3, bedrag: g.bedrag, meta: meta }); j3 += g.cyclus; }
      });
      return out;
    }
    var first = conditionYear(el);
    var bedrag = elementCost(el, state);
    var meta = elementMeta(el);
    var j2 = first;
    while (j2 <= CURRENT_YEAR + HORIZON - 1) {
      out.push({ jaar: j2, bedrag: bedrag, meta: meta });
      j2 += el.cyclus;
    }
    return out;
  }

  function fullPlan(state) {
    var posten = [];
    state.elements.forEach(function (el) {
      scheduleFor(el, state).forEach(function (p) {
        posten.push({ elId: el.id, naam: el.naam, jaar: p.jaar, bedrag: p.bedrag, meta: p.meta });
      });
    });
    posten.sort(function (a, b) { return a.jaar - b.jaar || b.bedrag - a.bedrag; });
    return posten;
  }

  // Jaar -> totale kosten binnen de horizon, los van een bepaalde bijdrage —
  // gedeeld door kasstroom() en benodigdeBijdrage() hieronder, die daar elk
  // een andere bijdrage overheen leggen.
  function perJaarKosten(state) {
    var perJaar = {};
    fullPlan(state).forEach(function (p) { perJaar[p.jaar] = (perJaar[p.jaar] || 0) + p.bedrag; });
    return perJaar;
  }

  // Simuleert het fondssaldo jaar voor jaar bij een gegeven (hypothetische)
  // maandbijdrage per appartement, uitgaande van het ingevulde startsaldo.
  function simuleerSaldi(state, bijdrage, perJaar) {
    var units = Math.max(1, state.building.units);
    var inkomen = bijdrage * 12 * units;
    var saldo = state.fonds;
    var rows = [];
    for (var j = CURRENT_YEAR; j <= CURRENT_YEAR + HORIZON - 1; j++) {
      saldo = saldo + inkomen - (perJaar[j] || 0);
      rows.push({ jaar: j, kosten: perJaar[j] || 0, saldo: saldo });
    }
    return rows;
  }

  function kasstroom(state) {
    return simuleerSaldi(state, state.bijdrage, perJaarKosten(state));
  }

  // Laagste maandbijdrage per appartement (naar boven afgerond op 5 euro)
  // waarbij het fondssaldo aan het EIND VAN ELK JAAR in de planningshorizon
  // niet onder 0 komt — niet simpelweg totale kosten / aantal maanden. Dat
  // gemiddelde negeert wanneer de kosten vallen: bij veel kosten vroeg in
  // de horizon liet het fonds bij dat gemiddelde bedrag alsnog leeglopen in
  // een vroeg jaar, terwijl de app datzelfde bedrag als "voorstel" toonde.
  // Simuleert daarom oplopende bedragen in stappen van 5 euro (dezelfde
  // afronding als de UI altijd al toonde) tot het laagste jaareindsaldo
  // niet meer negatief is.
  function benodigdeBijdrage(state) {
    var perJaar = perJaarKosten(state);
    var bijdrage = 0;
    var guard = 0; // veiligheidsgrens tegen een oneindige lus bij onzinnige invoer
    while (guard < 10000) {
      var rows = simuleerSaldi(state, bijdrage, perJaar);
      var laagste = Math.min.apply(null, rows.map(function (r) { return r.saldo; }));
      if (laagste >= -0.005) break; // kleine marge tegen float-afrondingsfouten
      bijdrage += 5;
      guard++;
    }
    return Math.max(5, bijdrage);
  }

  // Jaar -> bedrag voor één element, voor de jarenplan-tabel van het
  // afdrukbare rapport (elke voorkomst binnen de horizon opgeteld per jaar).
  function elementYearMap(el, state) {
    var map = {};
    scheduleFor(el, state).forEach(function (p) { map[p.jaar] = (map[p.jaar] || 0) + p.bedrag; });
    return map;
  }

  function hoeveelheidLabel(el) {
    switch (el.type) {
      case 'dak': case 'gevel': return num(el.hoeveelheid).toLocaleString('nl-NL') + ' m²';
      case 'per-unit': return el.hoeveelheid + ' st';
      case 'steiger': return el.hoeveelheid + ' m²';
      case 'vast-variabel': return el.hoeveelheid + ' eenh.';
      case 'kozijnen': return el.koz.reduce(function (s, k) { return s + k.aantal; }, 0) + ' st';
      case 'custom': return '1 pst';
      default: return '';
    }
  }

  function stjCyFor(el, state) {
    var sched = scheduleFor(el, state);
    var stj = sched.length ? sched[0].jaar : conditionYear(el);
    var cy = el.type === 'kozijnen' ? 'diverse' : (el.cyclus || 'eenmalig');
    return { stj: stj, cy: cy };
  }

  // ---------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------
  var state = {
    // 'marketing' is de bedoelde standaard-landingsplek; currentScreen()
    // (zie hieronder bij Rendering) toont 'm alleen daadwerkelijk op
    // desktopbreedte zonder sessie — anders valt dat vanzelf terug op de
    // gewone onboarding-flow, ook op dit allereerste scherm.
    screen: 'marketing',
    // 'light'/'dark' — direct bij opstarten (zie DOMContentLoaded hieronder)
    // uit localStorage gelezen en als data-theme op <html> gezet, nog vóór
    // de eerste render(), zodat de pagina niet eerst licht opflitst.
    theme: 'light',
    settings: { toonCbsBron: true },
    onboarding: { q: '', sug: [], bezig: false, bezigTekst: '', fout: '', gezocht: false },
    upload: null, // zie renderUploadWizard voor de vorm van dit object
    building: null,
    fonds: 0,
    // Wat de gebruiker zelf heeft ingevuld: zolang het saldo van het reservefonds
    // onbekend is, zegt het verdict niets (een startsaldo van 0 zou anders een
    // schrikbeeld tonen), en de bijdrage van 55 is nog een startwaarde.
    invul: { fonds: false, bijdrage: false },
    bijdrage: 55,
    elements: [],
    tab: 'home',
    activeElementId: null,
    filter: 'Alles',
    gebrekenFilter: false, // "Met gebreken"-filter op het Gebouw-scherm, los van de categorie-chips
    offertes: {}, // elId -> [{id, naam, btw, regels:[{naam,bedrag}]}]
    bijvullen: {}, // elId -> bool
    addForm: null,
    accountMenuOpen: false, // mini-menu (Account/Uitloggen) onder het gebruikersblok in de zijbalk
    buildingSwitcherOpen: false, // dropdown van de gebouwkiezer boven in de zijbalk
    accountSubTab: 'profiel', // links sub-menu binnen de samengevoegde Account-pagina (zie renderAccount())
    // Login (fase 1 van SPEC_ACCOUNTS_AND_SAVING.md). session/user worden
    // uitsluitend gezet vanuit de sb.auth.onAuthStateChange-listener
    // (nooit los daarvan) zodat ze altijd de echte Supabase-sessie
    // weerspiegelen; `auth` is puur lokale UI-state voor het inlogformulier.
    session: null,
    user: null,
    auth: { email: '', stap: 'email', bezig: false, fout: '' },
    // Opslaan/heropenen (fase 2 van SPEC_ACCOUNTS_AND_SAVING.md). savedPlans
    // is alleen de lichte lijst (id/label/updated_at), niet de volledige
    // blobs — zie loadSavedPlans(). lastSavedSnapshot is een JSON-snapshot
    // van serializePlan() op het moment van de laatste save/load, om
    // "niet-opgeslagen wijzigingen" te kunnen tonen zonder een aparte
    // dirty-vlag door de hele app heen te moeten bijhouden.
    savedPlans: [],
    plansLoaded: false,
    plansUi: { bezig: false, fout: '' },
    currentPlanId: null,
    lastSavedSnapshot: null,
    confirmDeleteId: null, // id van het plan waarvoor net op "verwijderen" geklikt is, in afwachting van bevestiging
    // Abonnement (Stripe) — { status, current_period_end } uit de
    // "subscriptions"-tabel, of null zolang nog niet opgehaald/geen rij.
    // Alleen de stripe-webhook Edge Function schrijft die tabel; hier
    // wordt 'm alleen gelezen, zie loadSubscription().
    subscription: null,
    subscriptionLoaded: false,
    subscriptionUi: { bezig: false, fout: '' },
    // Profielgegevens (naam/telefoon/rol, organisatie, facturatie) — één
    // rij in de "profiles"-tabel (zie supabase/migrations), maar met drie
    // losse opslaan-knoppen op de Account-pagina (Mijn profiel/
    // Organisatie/Facturatie), dus ook drie losse snapshots/ui-objecten
    // voor "niet-opgeslagen wijzigingen" per sectie — net als
    // lastSavedSnapshot hierboven voor een heel plan.
    profile: null, // pas gevuld na loadProfile(); null = nog niet geladen
    profileLoaded: false,
    profielUi: { bezig: false, fout: '', opgeslagen: false },
    orgUi: { bezig: false, fout: '', opgeslagen: false },
    facturatieUi: { bezig: false, fout: '', opgeslagen: false },
    profielSnapshot: null,
    orgSnapshot: null,
    facturatieSnapshot: null,
    emailWijzigen: { actief: false, nieuw: '', bezig: false, fout: '', verstuurd: false },
    // Status van de automatische straat/plaats-opzoeking op postcode+
    // huisnummer bij Facturatie (zie factuurAutofill() en BINDS
    // 'fact-postcode'/'fact-huisnummer') — puur UI-feedback, geen eigen data.
    facturatieZoek: { bezig: false, fout: '' },
    privacyUi: { bezig: false, fout: '' },
    accountVerwijderen: { actief: false, typedEmail: '', bezig: false, fout: '' },
  };

  // Thema en instellingen zo vroeg mogelijk toepassen (nog vóór
  // DOMContentLoaded/de eerste render) om een korte lichte flits te
  // voorkomen als iemand donker thema aan heeft staan.
  try {
    var opgeslagenThema = localStorage.getItem('mjop-theme');
    if (opgeslagenThema === 'dark' || opgeslagenThema === 'light') state.theme = opgeslagenThema;
    var opgeslagenInstellingen = JSON.parse(localStorage.getItem('mjop-instellingen') || 'null');
    if (opgeslagenInstellingen && typeof opgeslagenInstellingen.toonCbsBron === 'boolean') {
      state.settings.toonCbsBron = opgeslagenInstellingen.toonCbsBron;
    }
  } catch (e) { /* localStorage niet beschikbaar (bv. privénavigatie) — gewoon bij de standaardwaarden blijven */ }
  document.documentElement.setAttribute('data-theme', state.theme);

  // Werksessie herstellen na een refresh (F5) binnen hetzelfde tabblad.
  // sessionStorage i.p.v. localStorage: een heel nieuw bezoek/tabblad
  // begint gewoon weer op de marketing-homepage/onboarding (bestaand,
  // bewust gedrag — zie currentScreen() hieronder), maar een refresh
  // stuurt je niet meer terug naar het beginscherm terwijl je middenin
  // een plan zat. Wordt weggeschreven in persistWorkSession() (zie
  // render()) en opgeruimd bij uitloggen.
  try {
    var opgeslagenWerk = JSON.parse(sessionStorage.getItem('mjop-worksessie') || 'null');
    if (opgeslagenWerk) {
      if (opgeslagenWerk.screen) state.screen = opgeslagenWerk.screen;
      if (opgeslagenWerk.tab) state.tab = opgeslagenWerk.tab;
      if (opgeslagenWerk.currentPlanId) state.currentPlanId = opgeslagenWerk.currentPlanId;
      if (opgeslagenWerk.lastSavedSnapshot) state.lastSavedSnapshot = opgeslagenWerk.lastSavedSnapshot;
      if (opgeslagenWerk.plan) applyPlanBlob(opgeslagenWerk.plan);
    }
  } catch (e) { /* sessionStorage niet beschikbaar (bv. privénavigatie) — gewoon bij de standaardwaarden blijven */ }

  // Herschaalt alle bibliotheek-elementen (niet geïmporteerde/eigen posten
  // — die hebben geen def, zie libraryEntry()) op de huidige gebouw-
  // gegevens. Gedeeld door applyBuilding() (nieuw adres) en het bewerkbare
  // "aantal appartementen"-veld op het Gebouw-scherm (zie BINDS['building-
  // units']): in beide gevallen moeten per-appartement-hoeveelheden (koz-
  // aantallen, intercom, riolering, enz.) meebewegen met het huidige
  // aantal appartementen.
  function rescaleElements(building) {
    state.elements.forEach(function (el) {
      var def = libraryEntry(el.id);
      if (!def) return; // geïmporteerde/eigen posten hebben geen def — die blijven ongemoeid
      // Zonder dit bleef laatsteBeurt vastzitten op het bouwjaar dat gold
      // op het moment dat dit element werd aangemaakt — als een latere
      // adreswijziging een ander (correcter) bouwjaar oplevert, schoof de
      // cyclus van elk element zonder gebrek daardoor niet mee, en bleef
      // "volgende beurt" op het oude, inmiddels foute jaar staan.
      el.laatsteBeurt = building.bouwjaar || (CURRENT_YEAR - def.cyclus);
      if (def.bron && def.bron !== 'none') el.hoeveelheid = bronWaarde(def.bron, building);
      if (el.type === 'steiger') el.werkhoogte = building.werkhoogte;
      if (el.type === 'kozijnen') {
        var counts = scaleKozCounts(building.units);
        el.koz.forEach(function (k, i) { if (KOZ_DEF[i]) k.aantal = counts[i]; });
      }
    });
  }

  // Zet het gebouw vast. Als er nog geen elementen zijn (verse start) wordt
  // de standaardbibliotheek geïnstantieerd; zijn er al elementen (bv. uit
  // een MJOP-upload) dan worden alleen de bibliotheek-elementen herschaald
  // op de nieuwe m²/units — geïmporteerde/eigen posten blijven ongemoeid.
  function applyBuilding(building) {
    state.building = building;
    if (!state.elements.length) {
      // Reservefonds start op 0 — de VvE vult het werkelijke saldo zelf in,
      // wij kunnen dat niet raden op basis van het aantal appartementen.
      state.elements = buildDefaultElements(building);
      state.invul = { fonds: false, bijdrage: false };
    } else {
      rescaleElements(building);
    }
    state.screen = 'app';
    state.tab = 'home';
  }

  // ---------------------------------------------------------------------
  // Opslaan/heropenen (fase 2 van SPEC_ACCOUNTS_AND_SAVING.md). De
  // opgeslagen blob is uitsluitend het plan zelf (building/elements/fonds/
  // bijdrage/offertes/bijvullen) — nooit navigatie- of sessie-state
  // (screen/tab/onboarding/upload/auth/session), die hoort niet in een
  // opgeslagen rij thuis en zou bij het heropenen alleen maar verwarren.
  // ---------------------------------------------------------------------
  function serializePlan() {
    return {
      building: state.building,
      elements: state.elements,
      fonds: state.fonds,
      bijdrage: state.bijdrage,
      invul: state.invul,
      offertes: state.offertes,
      bijvullen: state.bijvullen,
    };
  }

  function applyPlanBlob(blob) {
    state.building = blob.building || null;
    state.elements = blob.elements || [];
    state.fonds = blob.fonds || 0;
    state.bijdrage = blob.bijdrage || 55;
    // Plannen van vóór deze velden zijn al eens gebruikt: dan gelden beide als ingevuld.
    state.invul = blob.invul || { fonds: true, bijdrage: true };
    state.offertes = blob.offertes || {};
    state.bijvullen = blob.bijvullen || {};
  }

  // Zie de "werksessie herstellen"-restore hierboven bij het opzetten van
  // state — dit is de tegenhanger die na elke render() de actuele plek
  // (scherm, tab, geopend plan, plan-inhoud) wegschrijft.
  function persistWorkSession() {
    try {
      sessionStorage.setItem('mjop-worksessie', JSON.stringify({
        screen: state.screen,
        tab: state.tab,
        currentPlanId: state.currentPlanId,
        lastSavedSnapshot: state.lastSavedSnapshot,
        plan: serializePlan(),
      }));
    } catch (e) { /* sessionStorage niet beschikbaar (bv. privénavigatie) — niets te doen */ }
  }

  function isDirty() {
    return !state.currentPlanId || JSON.stringify(serializePlan()) !== state.lastSavedSnapshot;
  }

  // Daadwerkelijke opslaan-aanroep — gedeeld door de "Opslaan"-knop
  // (ACTIONS['save-plan']) en de automatische opslaan-timer hieronder,
  // zodat beide precies hetzelfde doen (zelfde insert/update-logica,
  // zelfde statusveld state.plansUi).
  function performSave() {
    if (!sb || !state.session || !state.building) return;
    var p = state.plansUi;
    p.bezig = true; p.fout = '';
    render();
    var blob = serializePlan();
    var label = state.building.adres || 'MJOP';
    var adres = state.building.adres || null;
    var query = state.currentPlanId
      ? sb.from('saved_plans').update({ label: label, adres: adres, state: blob, updated_at: new Date().toISOString() }).eq('id', state.currentPlanId).select().single()
      : sb.from('saved_plans').insert({ user_id: state.user.id, label: label, adres: adres, state: blob }).select().single();
    query.then(function (res) {
      p.bezig = false;
      if (res.error) { p.fout = res.error.message; render(); return; }
      state.currentPlanId = res.data.id;
      state.lastSavedSnapshot = JSON.stringify(blob);
      loadSavedPlans();
    }).catch(function () {
      p.bezig = false; p.fout = 'Kon geen verbinding maken. Probeer het opnieuw.'; render();
    });
  }

  // Automatisch opslaan: 2 seconden na de laatste wijziging, zodat een
  // reeks snelle aanpassingen (bv. een schuifje slepen) niet bij elke
  // tussenstap een eigen aanroep doet — elke render() hierna verzet de
  // timer opnieuw (zie de aanroep onderin render()). Alleen voor
  // abonnees met een gebouw; wie niet is ingelogd of geen abonnement
  // heeft, moet nog altijd bewust op "Opslaan" klikken (dat stuurt dan
  // naar Instellingen om te abonneren, zie ACTIONS['save-plan']).
  var autoSaveTimer = null;
  function scheduleAutoSave() {
    if (autoSaveTimer) { clearTimeout(autoSaveTimer); autoSaveTimer = null; }
    if (!sb || !state.session || !state.building || !isSubscribed()) return;
    if (state.plansUi.bezig || !isDirty()) return;
    autoSaveTimer = setTimeout(function () {
      autoSaveTimer = null;
      if (isDirty() && !state.plansUi.bezig) performSave();
    }, 2000);
  }

  // Alleen de lichte kolommen (geen state-blob) — de "mijn gebouwen"-lijst
  // hoeft niet elke opgeslagen plan-inhoud te downloaden om te tonen.
  // Geen eigen .eq('user_id', ...)-filter: de select-policy op saved_plans
  // laat sowieso alleen de eigen rijen van de ingelogde gebruiker door, en
  // dat or moet de echte grens zijn (zie SPEC_ACCOUNTS_AND_SAVING.md §4.3)
  // — een applicatie-filter zou alleen maar de indruk wekken dat de
  // beveiliging hier zit, terwijl die in de database hoort.
  function loadSavedPlans() {
    if (!sb || !state.session) return;
    state.plansUi.bezig = true; state.plansUi.fout = '';
    render();
    sb.from('saved_plans').select('id,label,adres,updated_at').order('updated_at', { ascending: false }).then(function (res) {
      state.plansUi.bezig = false;
      state.plansLoaded = true;
      if (res.error) { state.plansUi.fout = res.error.message; render(); return; }
      state.savedPlans = res.data || [];
      render();
    });
  }

  // Status van het Stripe-abonnement — bepaalt of "eigen gebouw opslaan"
  // (zie 'save-plan' hieronder) is toegestaan. Zonder rij (nog nooit
  // geabonneerd geweest) blijft state.subscription null, en telt dat als
  // niet-actief — isSubscribed() hoeft dan niet apart op null te checken.
  function loadSubscription() {
    if (!sb || !state.session) return;
    sb.from('subscriptions').select('status,current_period_end').maybeSingle().then(function (res) {
      state.subscriptionLoaded = true;
      if (!res.error) state.subscription = res.data || null;
      render();
    });
  }

  function isSubscribed() {
    return !!(state.subscription && (state.subscription.status === 'active' || state.subscription.status === 'trialing'));
  }

  // Downloaden van het rapport (afdrukken/pdf en csv) hoort bij het
  // abonnement, net als opslaan. Zonder abonnement gaat de bezoeker naar
  // Account: ingelogd naar Abonnement, anders naar de inlogkant van Mijn
  // profiel. (De eigen "Download mijn gegevens" onder Privacy blijft voor
  // iedereen, dat is een recht en geen functie.)
  function heeftAbonnementVoorDownload() {
    if (isSubscribed()) return true;
    state.tab = state.session ? 'instellingen' : 'account';
    state.accountSubTab = state.session ? 'abonnement' : 'profiel';
    render();
    return false;
  }

  // ---------------------------------------------------------------------
  // Profielgegevens — één rij in de "profiles"-tabel (zie
  // supabase/migrations/20260919000000_create_profiles.sql), met drie
  // losse secties op de Account-pagina (Mijn profiel/Organisatie/
  // Facturatie) die elk hun eigen opslaan-knop hebben. state.profile
  // bevat alle velden plat door elkaar; de *Snapshot-velden (JSON van
  // alleen de velden van die ene sectie) bepalen per sectie of er
  // niet-opgeslagen wijzigingen zijn — zelfde patroon als
  // lastSavedSnapshot/isDirty() voor een heel plan.
  // ---------------------------------------------------------------------
  function emptyProfile() {
    return {
      voornaam: '', achternaam: '', telefoon: '', rol: '',
      orgNaam: '', kvkNummer: '', toonOrgOpRapport: false,
      factuurStraat: '', factuurHuisnummer: '', factuurPostcode: '', factuurPlaats: '', factuurLand: 'Nederland', btwNummer: '',
    };
  }
  function profielVelden(p) { return { voornaam: p.voornaam, achternaam: p.achternaam, telefoon: p.telefoon, rol: p.rol }; }
  function orgVelden(p) { return { orgNaam: p.orgNaam, kvkNummer: p.kvkNummer, toonOrgOpRapport: p.toonOrgOpRapport }; }
  function facturatieVelden(p) {
    return {
      factuurStraat: p.factuurStraat, factuurHuisnummer: p.factuurHuisnummer, factuurPostcode: p.factuurPostcode,
      factuurPlaats: p.factuurPlaats, factuurLand: p.factuurLand, btwNummer: p.btwNummer,
    };
  }
  function rowToProfile(row) {
    var p = emptyProfile();
    if (!row) return p;
    return {
      voornaam: row.voornaam || '', achternaam: row.achternaam || '', telefoon: row.telefoon || '', rol: row.rol || '',
      orgNaam: row.org_naam || '', kvkNummer: row.kvk_nummer || '', toonOrgOpRapport: !!row.toon_organisatie_op_rapport,
      factuurStraat: row.factuur_straat || '', factuurHuisnummer: row.factuur_huisnummer || '', factuurPostcode: row.factuur_postcode || '',
      factuurPlaats: row.factuur_plaats || '', factuurLand: row.factuur_land || 'Nederland', btwNummer: row.btw_nummer || '',
    };
  }
  var ROL_LABELS = { bestuurslid: 'Bestuurslid', vve_beheerder: 'VvE-beheerder', adviseur: 'Adviseur', anders: 'Anders' };
  function displayNaam() {
    var p = state.profile;
    var volledig = p && (p.voornaam || p.achternaam) ? (p.voornaam + ' ' + p.achternaam).trim() : '';
    return volledig || displayName(state.user.email);
  }
  // Organisatienaam voor op het rapport (scherm + pdf) — alleen als de
  // gebruiker 'm heeft ingevuld én de schakelaar op de Organisatie-
  // sectie aan heeft staan (zie renderAcctOrganisatie()).
  function opstellerNaam() {
    var p = state.profile;
    return (p && p.toonOrgOpRapport && p.orgNaam) ? p.orgNaam : null;
  }
  // Ruime, weinig-strikte NL-telefoonvalidatie (vast + mobiel, met of
  // zonder spaties/koppeltekens, met of zonder +31/0031-notatie) — het
  // veld is optioneel, dus alleen valideren als er iets is ingevuld.
  function isValidPhone(v) {
    if (!v) return true;
    var digits = v.replace(/[\s-]/g, '');
    return /^(\+31|0031|0)[1-9][0-9]{7,9}$/.test(digits);
  }
  // Nederlandse postcode: 4 cijfers (niet startend met 0) + 2 letters,
  // met optioneel een spatie ertussen — bv. "1234AB" of "1234 AB".
  function isValidPostcode(v) { return /^[1-9][0-9]{3}\s?[A-Za-z]{2}$/.test(String(v || '').trim()); }
  function normalizePostcode(v) {
    var m = /^([1-9][0-9]{3})\s?([A-Za-z]{2})$/.exec(String(v || '').trim());
    return m ? m[1] + ' ' + m[2].toUpperCase() : v;
  }
  // Beide optioneel, dus alleen valideren als er iets is ingevuld.
  function isValidKvk(v) { return !v || /^[0-9]{8}$/.test(String(v).trim()); }
  // Alleen het NL-btw-nummerpatroon (deze app is NL-gericht) — bv.
  // "NL123456789B01", hoofdletterongevoelig.
  function isValidBtw(v) { return !v || /^NL[0-9]{9}B[0-9]{2}$/i.test(String(v).trim()); }

  function loadProfile() {
    if (!sb || !state.session) return;
    sb.from('profiles').select('*').eq('id', state.user.id).maybeSingle().then(function (res) {
      state.profileLoaded = true;
      state.profile = rowToProfile(res.error ? null : res.data);
      state.profielSnapshot = JSON.stringify(profielVelden(state.profile));
      state.orgSnapshot = JSON.stringify(orgVelden(state.profile));
      state.facturatieSnapshot = JSON.stringify(facturatieVelden(state.profile));
      render();
    });
  }

  // Slaat alleen de velden van één sectie op (upsert — de rij bestaat
  // misschien nog niet). ui/snapshotKey/velden bepalen welke sectie: dit
  // wordt gedeeld door de drie 'save-*'-acties hieronder.
  function saveProfileSection(ui, snapshotKey, veldenFn, rowFn) {
    if (!sb || !state.session || !state.profile) return;
    ui.bezig = true; ui.fout = ''; ui.opgeslagen = false;
    render();
    var row = rowFn(state.profile);
    row.id = state.user.id;
    row.updated_at = new Date().toISOString();
    sb.from('profiles').upsert(row).select().single().then(function (res) {
      ui.bezig = false;
      if (res.error) { ui.fout = 'Opslaan is niet gelukt. Probeer het opnieuw.'; render(); return; }
      ui.opgeslagen = true;
      state[snapshotKey] = JSON.stringify(veldenFn(state.profile));
      render();
    }).catch(function () {
      ui.bezig = false; ui.fout = 'Kon geen verbinding maken. Probeer het opnieuw.'; render();
    });
  }

  // Roept een van de Stripe-gerelateerde Edge Functions aan (zie
  // supabase/functions/) met de sessie van de ingelogde gebruiker als
  // bearer-token — nooit met een geheime sleutel vanuit de frontend zelf.
  function callSupabaseFunction(name, body) {
    var url = window.SUPABASE_CONFIG.url + '/functions/v1/' + name;
    return fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + state.session.access_token,
      },
      body: JSON.stringify(body),
    }).then(function (r) { return r.json(); });
  }

  // ---------------------------------------------------------------------
  // Supabase (inloggen — zie SPEC_ACCOUNTS_AND_SAVING.md, fase 1). Alleen
  // e-mail/otp-login en sessie-state in deze fase; opslaan/laden van een
  // plan komt in een latere fase. Zonder configuratie (src/config.js leeg
  // gelaten) blijft `sb` null en werkt de rest van de app gewoon anoniem
  // door — inloggen toont dan een duidelijke "nog niet geconfigureerd"
  // melding in plaats van te crashen.
  // ---------------------------------------------------------------------
  var sb = (window.supabase && window.SUPABASE_CONFIG && window.SUPABASE_CONFIG.url && window.SUPABASE_CONFIG.anonKey)
    ? window.supabase.createClient(window.SUPABASE_CONFIG.url, window.SUPABASE_CONFIG.anonKey)
    : null;

  // ---------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------
  var root;

  // Desktopbreedte-drempel: dezelfde 960px-grens als de bestaande
  // zijbalk-lay-out hierboven in style.css, zodat "desktop" overal in de
  // app hetzelfde betekent.
  function isDesktopWidth() {
    return typeof window.matchMedia === 'function' && window.matchMedia('(min-width: 960px)').matches;
  }

  // state.screen is de bedoelde navigatie ("waar wilde de gebruiker
  // heen"); currentScreen() is wat daadwerkelijk getoond wordt. De
  // marketing-homepage en het loginscherm zijn de vaste landingsplek bij
  // elke (her)load, desktop of ingelogd of niet — een sessie zorgt er dus
  // niet meer voor dat dit wordt overgeslagen; "Naar mijn plan" op de
  // homepage/header brengt een ingelogde bezoeker verder. Alleen op een
  // smallere viewport valt dit terug op de gewone (nooit-gated)
  // onboarding/app-flow, ook als state.screen nog op 'marketing'/'login'
  // staat, bv. na het smaller maken van het venster.
  function currentScreen() {
    if (state.screen === 'marketing' || state.screen === 'login') {
      if (!isDesktopWidth()) return 'onboarding';
      return state.screen;
    }
    return state.screen;
  }

  // De meeste "knoppen" door de hele app zijn <div data-act> i.p.v. een
  // echt <button>/<a href> (klikken lopen via delegation op root, zie
  // beneden) — zonder tabindex/role zijn ze met het toetsenbord niet te
  // bereiken en leest een screenreader ze niet als interactief voor. Een
  // <a> zonder href is net zo min natively interactief als een div.
  function isNativelyInteractive(el) {
    var tag = el.tagName;
    if (tag === 'BUTTON' || tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'LABEL') return true;
    if (tag === 'A') return el.hasAttribute('href');
    return false;
  }

  function render() {
    persistWorkSession();
    scheduleAutoSave();
    var active = document.activeElement;
    var focusInfo = null;
    if (active && root.contains(active) && active.id) {
      focusInfo = { id: active.id, start: active.selectionStart, end: active.selectionEnd };
    }
    var screen = currentScreen();
    var mainHtml;
    if (screen === 'marketing') mainHtml = renderMarketing();
    else if (screen === 'login') mainHtml = renderLoginScreen();
    else if (screen === 'onboarding') mainHtml = renderOnboarding();
    else mainHtml = renderApp();
    var printHtml = (screen === 'app' && state.building) ? renderPrintReport() : '';
    root.innerHTML = '<div class="screen-view">' + mainHtml + '</div>' + printHtml;
    // Na elke render() alsnog tabindex/role toevoegen aan wat dat nog mist,
    // i.p.v. elke afzonderlijke data-act-plek in de render*()-functies
    // hierboven aan te passen — dekt ook nieuwe data-act's vanzelf mee.
    root.querySelectorAll('[data-act]').forEach(function (el) {
      if (isNativelyInteractive(el)) return;
      if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
      if (!el.hasAttribute('role')) el.setAttribute('role', 'button');
    });
    if (screen === 'marketing') initMktHeroScroll();
    if (focusInfo) {
      var el = document.getElementById(focusInfo.id);
      if (el) {
        el.focus();
        if (typeof el.setSelectionRange === 'function' && focusInfo.start != null) {
          try { el.setSelectionRange(focusInfo.start, focusInfo.end); } catch (e) {}
        }
      }
    }
  }

  // ---------------------------------------------------------------------
  // Marketing-homepage + loginscherm — getoond aan niet-ingelogde
  // bezoekers op desktopbreedte i.p.v. het adres-opzoekscherm (zie
  // currentScreen()/isDesktopWidth() bij de boot-code onderaan). Mobiel/
  // tablet en ingelogde gebruikers slaan dit altijd over.
  // ---------------------------------------------------------------------
  var MKT_ICONS = {
    lock: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
    lockBig: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
    pin: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-7-6.5-7-11a7 7 0 0 1 14 0c0 4.5-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/></svg>',
    clipboard: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="12" height="17" rx="2"/><rect x="9" y="2" width="6" height="4" rx="1"/><path d="M9 12h6M9 16h6"/></svg>',
    trend: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/></svg>',
  };

  // Iconen voor de tabbalk/zijbalk-navigatie — zelfde stijl (24-viewBox,
  // stroke i.p.v. fill, currentColor) als MKT_ICONS hierboven, zodat het
  // ene ikonenpalet niet van het andere afwijkt.
  var NAV_ICONS = {
    overzicht: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="8" rx="1.5"/><rect x="3" y="13" width="8" height="8" rx="1.5"/><rect x="13" y="13" width="8" height="8" rx="1.5"/></svg>',
    gebouw: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="16" height="18" rx="1.5"/><path d="M9 8h.01M15 8h.01M9 12h.01M15 12h.01M9 16h.01M15 16h.01"/></svg>',
    planning: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/></svg>',
    rapport: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="10" width="4" height="10" rx="1"/><rect x="10" y="5" width="4" height="15" rx="1"/><rect x="16" y="13" width="4" height="7" rx="1"/></svg>',
    opslaan: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/></svg>',
    account: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 4-6 8-6s8 2 8 6"/></svg>',
    instellingen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.2"/><path d="M19.6 15a1.7 1.7 0 0 0 .35 1.9l.05.05a2 2 0 1 1-2.9 2.9l-.05-.05a1.7 1.7 0 0 0-1.9-.35 1.7 1.7 0 0 0-1.05 1.55V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1.05-1.55 1.7 1.7 0 0 0-1.9.35l-.05.05a2 2 0 1 1-2.9-2.9l.05-.05a1.7 1.7 0 0 0 .35-1.9A1.7 1.7 0 0 0 3 13.95H3a2 2 0 0 1 0-4h.05A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.35-1.9l-.05-.05a2 2 0 1 1 2.9-2.9l.05.05a1.7 1.7 0 0 0 1.9.35H9a1.7 1.7 0 0 0 1.05-1.55V3a2 2 0 0 1 4 0v.1A1.7 1.7 0 0 0 15.1 4.6a1.7 1.7 0 0 0 1.9-.35l.05-.05a2 2 0 1 1 2.9 2.9l-.05.05a1.7 1.7 0 0 0-.35 1.9V9a1.7 1.7 0 0 0 1.55 1.05H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.55 1.05z"/></svg>',
    zon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.6M12 18.9v2.6M4.9 4.9l1.85 1.85M17.25 17.25l1.85 1.85M2.5 12h2.6M18.9 12h2.6M6.75 17.25 4.9 19.1M19.1 4.9l-1.85 1.85"/></svg>',
    maan: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"/></svg>',
  };

  function mktLogo(wordmarkOnly) {
    return '<div class="mkt-logo" data-act="goto-marketing"><div class="mark"></div>' + (wordmarkOnly ? '' : '<div class="word">MJOP Live</div>') + '</div>';
  }

  // ---------------------------------------------------------------------
  // Logo van het adres- en loginscherm (zie .entry-* in style.css). Eigen,
  // kleiner logo-component
  // los van mktLogo()/.mkt-logo (die blijft ongewijzigd voor de
  // marketing-homepage, de tabbalk en deze functie zelf).
  // ---------------------------------------------------------------------
  var CHOICE_ICONS = {
    check: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
  };

  function choiceLogo() {
    return '<div class="entry-logo" data-act="goto-marketing"><div class="mark">M</div><div class="word">MJOP Live</div></div>';
  }

  // Het voorbeeldgebouw start met een richtsaldo (€ 2.500 per appartement,
  // zie README) i.p.v. € 0, zodat de homepage en het geopende voorbeeld
  // dezelfde, herkenbare cijfers tonen.
  var VOORBEELD_FONDS_PER_APP = 2500;
  // Bijdrage van de slider in de homepage-hero; het geopende voorbeeld
  // start met dezelfde waarde.
  var mktDemoBijdrage = 55;

  // Een losstaand plan van het voorbeeldgebouw, voor de weergave op de
  // homepage. Raakt `state` niet aan: overzichtModel() rekent op wat het
  // meekrijgt.
  function voorbeeldPlan() {
    var b = defaultBuilding();
    return {
      building: b, elements: buildDefaultElements(b), fonds: b.units * VOORBEELD_FONDS_PER_APP,
      bijdrage: mktDemoBijdrage, offertes: {}, bijvullen: {}, settings: state.settings
    };
  }

  // Wie al een eigen gebouw open heeft staan, krijgt geen "voorbeeldplan"-
  // link: die zou het geopende plan in het geheugen vervangen.
  function heeftEigenPlan() {
    return !!(state.building && !state.building.isVoorbeeld);
  }

  // ---------------------------------------------------------------------
  // Sfeerbeeld in de hero (marketing-homepage): geen <video>, maar een
  // reeks van 40 losse jpg-beeldjes (assets/hero-scroll/frame-01..40.jpg)
  // die op een <canvas> getekend worden, telkens één stap verder terwijl
  // de bezoeker door de hero scrollt. Alleen op desktopbreedte (zie
  // isDesktopWidth(), dezelfde grens als de marketing-gating) — op een
  // smallere weergave staat er gewoon een losse posterfoto (zie
  // renderMarketing()), geen canvas/JS-overhead.
  // ---------------------------------------------------------------------
  var HERO_FRAME_COUNT = 40;
  var heroFrames = null;

  function loadHeroFrames() {
    if (heroFrames) return;
    heroFrames = [];
    for (var i = 1; i <= HERO_FRAME_COUNT; i++) {
      var img = new Image();
      img.src = 'assets/hero-scroll/frame-' + (i < 10 ? '0' + i : i) + '.jpg';
      heroFrames.push(img);
    }
  }

  function drawHeroFrame(canvas, img) {
    if (!img || !img.complete || !img.naturalWidth) return;
    var dpr = window.devicePixelRatio || 1;
    var displayW = canvas.clientWidth, displayH = canvas.clientHeight;
    if (!displayW || !displayH) return;
    var targetW = Math.round(displayW * dpr), targetH = Math.round(displayH * dpr);
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }
    var ctx = canvas.getContext('2d');
    // "cover"-gedrag: uitvullen zonder de beeldverhouding te vervormen,
    // overschot valt buiten het canvas (zelfde als CSS object-fit:cover).
    var scale = Math.max(targetW / img.naturalWidth, targetH / img.naturalHeight);
    var drawW = img.naturalWidth * scale, drawH = img.naturalHeight * scale;
    var dx = (targetW - drawW) / 2, dy = (targetH - drawH) / 2;
    ctx.clearRect(0, 0, targetW, targetH);
    ctx.drawImage(img, dx, dy, drawW, drawH);
  }

  var heroScrollTicking = false;
  function updateHeroScrollFrame() {
    heroScrollTicking = false;
    var canvas = document.querySelector('.mkt-hero-canvas');
    // .mkt-hero-pin-wrap is hoger dan het scherm (200vh) en .mkt-hero
    // blijft daarbinnen "vastgeplakt" (position:sticky) — de voortgang
    // wordt dus afgemeten aan hoever de wrapper zelf al gescrold is
    // (i.p.v. aan .mkt-hero, die zolang 'ie vastzit altijd top:71px
    // blijft tonen en dus geen bruikbare voortgang zou geven).
    var wrap = document.querySelector('.mkt-hero-pin-wrap');
    if (!canvas || !wrap || !heroFrames) return;
    var rect = wrap.getBoundingClientRect();
    var scrollable = rect.height - window.innerHeight;
    var progress = scrollable > 0 ? clamp(-rect.top / scrollable, 0, 1) : 0;
    var idx = Math.min(HERO_FRAME_COUNT - 1, Math.floor(progress * HERO_FRAME_COUNT));
    drawHeroFrame(canvas, heroFrames[idx]);
  }

  function onHeroScroll() {
    if (heroScrollTicking) return;
    heroScrollTicking = true;
    requestAnimationFrame(updateHeroScrollFrame);
  }

  // Na elke render() opnieuw aanroepen (zie render()) — root.innerHTML
  // vervangt de hele DOM, dus het <canvas>-element van hiervoor bestaat
  // niet meer en moet z'n eerste frame opnieuw getekend krijgen. De
  // geladen Image()-objecten (heroFrames) blijven wel gewoon in het
  // geheugen staan tussen renders, dus geen dubbel laden.
  function initMktHeroScroll() {
    var canvas = document.querySelector('.mkt-hero-canvas');
    if (!canvas) return; // posterfoto i.p.v. canvas (smalle weergave)
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    loadHeroFrames();
    if (heroFrames[0].complete) updateHeroScrollFrame();
    else heroFrames[0].addEventListener('load', updateHeroScrollFrame, { once: true });
  }

  // De route door de app in vijf stappen: de homepage toont hem als preview,
  // het Overzicht als voortgang (zie stappenModel()).
  var ROUTE = [
    { titel: 'Zoek je adres', kort: 'Bouwjaar en maten komen uit de BAG.' },
    { titel: 'Vul het saldo in', kort: 'Wat staat er op de reservekas?' },
    { titel: 'Vul de bijdrage in', kort: 'Wat betaalt elk appartement nu?' },
    { titel: 'Beoordeel de staat', kort: 'Dak, gevel, kozijnen, installaties.' },
    { titel: 'Print je voorstel', kort: 'Klaar voor de vergadering.' },
  ];

  function renderMarketingHeader() {
    var html = '<div class="mkt-header">';
    html += mktLogo();
    html += '<div class="mkt-nav">';
    html += '<a href="#mkt-features">Functies</a>';
    html += '<a href="#mkt-stappen">Zo werkt het</a>';
    html += '<a href="#mkt-pricing">Prijzen</a>';
    if (!heeftEigenPlan()) html += '<a data-act="open-voorbeeld">Voorbeeldplan</a>';
    html += '<a href="mailto:info@mjoplive.nl">Contact</a>';
    html += '</div>';
    html += state.session
      ? '<div class="mkt-login-btn" data-act="goto-app">' + MKT_ICONS.lock + '<span>Naar mijn plan</span></div>'
      : '<div class="mkt-login-btn" data-act="goto-login">' + MKT_ICONS.lock + '<span>Inloggen</span></div>';
    html += '</div>';
    return html;
  }

  function renderMarketing() {
    var eigen = heeftEigenPlan();
    var html = '<div class="mkt">';
    html += renderMarketingHeader();

    var demo = overzichtModel(voorbeeldPlan());

    // Hero: de straat als achtergrond (frames wisselen mee met scrollen), de
    // vraag links en onderin de route in vijf stappen.
    html += '<div class="mkt-hero-pin-wrap"><div class="mkt-hero">';
    html += '<div class="mkt-hero-bg">' + (isDesktopWidth()
      ? '<canvas class="mkt-hero-canvas"></canvas>'
      : '<img src="assets/hero-scroll/poster-mobile.jpg" alt="" />') + '</div>';
    html += '<div class="mkt-hero-scrim"></div>';
    html += '<div class="mkt-hero-inner">';
    html += '<div class="mkt-hero-copy">';
    html += '<h1 class="mkt-h1">Spaart jullie VvE genoeg voor het onderhoud?</h1>';
    html += '<p class="mkt-sub">Geen rekenblad en geen adviseur nodig. In vijf stappen weet je wat er per maand nodig is, en heb je een voorstel voor de ledenvergadering.</p>';
    html += '<div class="mkt-cta-row">';
    html += state.session
      ? '<div class="mkt-cta-primary" data-act="goto-app">Naar mijn plan</div>'
      : '<div class="mkt-cta-primary" data-act="goto-onboarding">Begin met je adres</div>';
    if (!eigen) html += '<div class="mkt-cta-secondary" data-act="open-voorbeeld">Bekijk het voorbeeldplan</div>';
    html += '</div>';
    html += state.session ? '' : '<div class="mkt-fineprint">Gratis doorrekenen, zonder account. Een abonnement heb je nodig om op te slaan en te downloaden.</div>';
    html += '</div>';
    html += '<div class="mkt-route"><div class="mkt-route-head"><strong>Jouw plan in vijf stappen</strong><span>Begin met je adres</span></div><ol class="mkt-route-steps">';
    ROUTE.forEach(function (s, i) {
      html += '<li' + (i === 0 ? ' class="now"' : '') + '><span class="d">' + (i + 1) + '</span><b>' + s.titel + '</b><span class="k">' + s.kort + '</span></li>';
    });
    html += '</ol></div>';
    html += '</div></div></div>';

    // De route uitgelegd, elke stap met een stukje van het echte scherm.
    var stapUitleg = [
      ['Typ het adres en MJOP Live haalt bouwjaar, dakoppervlak en gevelmaten voor je op. Je hoeft niets op te meten.',
        '<span class="lab">Adres</span><b>Kastanjelaan 12, Amersfoort</b><span>Bouwjaar 1978 · 8 appartementen</span>'],
      ['Het saldo vind je in de administratie van de VvE, of bij de beheerder of de bank. Pas dan kan de app zeggen of jullie genoeg sparen.',
        '<span class="lab">Reservefonds nu</span><span class="eur">€ 20.000</span>'],
      ['Dat is de maandelijkse bijdrage aan het reservefonds. Je vindt hem in de begroting van de VvE.',
        '<span class="lab">Bijdrage per appartement per maand</span><span class="eur">€ 55</span>'],
      ['Loop dak, gevel, kozijnen en installaties na en noteer wat je ziet, zoals lekkage of houtrot. Dat mag je ook later doen.',
        '<span>Dakbedekking <span class="cond-pill" style="background:var(--bad-bg);color:var(--bad-fg)">Matig</span></span><span>Kozijnen <span class="cond-pill" style="background:var(--warn-bg);color:var(--warn-fg)">Redelijk</span></span><span>Trappenhuis <span class="cond-pill" style="background:var(--good-bg);color:var(--good-fg)">Goed</span></span>'],
      ['Je krijgt in gewone taal de bijdrage die nodig is en de kosten per jaar, klaar voor de ledenvergadering. Afdrukken zit in het abonnement.',
        '<span class="lab">Voorstel voor de vergadering</span><span class="eur">€ 70</span><span>per appartement per maand</span>'],
    ];
    html += '<div class="mkt-section" id="mkt-stappen"><div class="mkt-section-title">Van adres tot vergaderstuk</div>';
    html += '<div class="mkt-section-sub">Een meerjarenonderhoudsplan (MJOP) laat zien welk onderhoud je VvE de komende jaren verwacht en hoeveel je daarvoor moet sparen. Zo loop je er in vijf stappen doorheen.</div>';
    html += '<ol class="mkt-rijen">';
    ROUTE.forEach(function (s, i) {
      var titels = ['Zoek je adres', 'Vul in wat er op de reservekas staat', 'Vul in wat elk appartement nu betaalt', 'Beoordeel de staat van de posten', 'Print je voorstel voor de vergadering'];
      html += '<li class="mkt-rij"><span class="n">' + (i + 1) + '</span><div><h3>' + titels[i] + '</h3><p>' + stapUitleg[i][0] + '</p></div><div class="mkt-mini">' + stapUitleg[i][1] + '</div></li>';
    });
    html += '</ol></div>';

    // Het echte Overzicht van het voorbeeldplan (zelfde functies als de
    // app), met een slider die verdict en grafiek live bijwerkt (zie de
    // input-listener onderaan).
    html += '<div class="mkt-section shaded" id="mkt-try"><div class="mkt-section-inner"><div class="mkt-try">';
    html += '<div><h2 class="mkt-try-title">Probeer het met een voorbeeld</h2>';
    html += '<p class="mkt-try-text">Verschuif de bijdrage en zie meteen wat er met het reservefonds gebeurt. Dit is een portiekflat uit 1978 met 8 appartementen.</p>';
    if (!eigen) html += '<button type="button" class="ov-btn" data-act="open-voorbeeld">Open het voorbeeldplan</button>';
    html += '</div>';
    html += '<div class="ov-card mkt-hero-demo">';
    html += '<p class="ov-sub">Voorbeeld met ' + eur(demo.fonds) + ' in het reservefonds.</p>';
    html += '<div id="mkt-live-verdict">' + ovVerdictHtml(demo, true) + '</div>';
    html += '<div class="mkt-demo-slider"><label class="ov-row" for="mkt-slider"><span>Bijdrage per appartement per maand</span><output id="mkt-out" class="mkt-out">' + eur(demo.bijdrage) + '</output></label>';
    html += '<input id="mkt-slider" class="ov-slider" type="range" min="10" max="400" step="5" value="' + demo.bijdrage + '" />';
    html += '<div class="ov-range"><span>€ 10</span><span>€ 400</span></div></div>';
    html += '<div class="ov-chart" id="mkt-live-chart">' + ovChartHtml(demo) + '</div>';
    html += '</div>';
    html += '</div></div></div>';

    var voorbeeldB = defaultBuilding();
    html += '<div class="mkt-section" id="mkt-gebouw"><div class="mkt-section-title">Je gebouw, onderdeel voor onderdeel</div>';
    html += '<div class="mkt-section-sub">MJOP Live rekent per onderdeel wanneer onderhoud nodig is en wat het kost. Dat zijn de posten in je plan.</div>';
    html += '<div class="mkt-gebouw"><div class="ov-card mkt-gebouw-fig">' + gebouwSvg({ id: 'mkt', units: voorbeeldB.units, hoogte: voorbeeldB.werkhoogte }) + '</div>';
    html += '<dl class="mkt-onderdelen">';
    [
      ['Dak', 'Dakbedekking, dakgoten en de jaarlijkse dakinspectie.'],
      ['Gevel en kozijnen', 'Metselwerk en voegwerk, schilderwerk, kozijnen en de steiger die daarbij nodig is.'],
      ['Installaties', 'Cv-ketel, ventilatie, brandveiligheid, verlichting, riolering en lift.'],
      ['Binnen', 'Trappenhuis, entree en vloeren van de gemeenschappelijke ruimten.'],
      ['Terrein', 'Bestrating, fietsenstalling en bergingen.'],
    ].forEach(function (o) {
      html += '<div class="mkt-onderdeel"><dt>' + o[0] + '</dt><dd>' + o[1] + '</dd></div>';
    });
    html += '</dl></div></div>';

    html += '<div class="mkt-section shaded" id="mkt-features"><div class="mkt-section-inner">';
    html += '<div class="mkt-section-title">Alles wat een bestuur nodig heeft</div>';
    html += '<div class="mkt-section-sub">Geen los rekenblad meer: bouwdata, conditie en kosten staan bij elkaar.</div>';
    html += '<div class="mkt-feature-grid">';
    [
      [MKT_ICONS.pin, 'Echte bouwdata', 'Bouwjaar, dakoppervlak en gevelmaten komen uit de BAG en 3D BAG. Je hoeft niets op te meten.'],
      [MKT_ICONS.clipboard, 'Staat van onderhoud', 'Leg vast wat je ziet, bijvoorbeeld lekkage of houtrot. De app schat daarmee wanneer een post echt aan de beurt is, volgens de NEN 2767-methodiek.'],
      [MKT_ICONS.trend, 'Fondsadvies voor 10 jaar', 'De kasstroom laat zien of de huidige bijdrage genoeg is, en wat er nodig is als dat niet zo is.'],
    ].forEach(function (f) {
      html += '<div class="mkt-feature-card"><div class="mkt-feature-icon">' + f[0] + '</div>';
      html += '<div class="mkt-feature-title">' + f[1] + '</div><div class="mkt-feature-body">' + f[2] + '</div></div>';
    });
    html += '</div></div></div>';

    html += '<div class="mkt-section shaded" id="mkt-pricing"><div class="mkt-section-inner">';
    html += '<div class="mkt-section-title">Prijzen</div>';
    html += '<div class="mkt-section-sub">Uitproberen is gratis en kan zonder account. Een abonnement heb je nodig om je plan op te slaan en het rapport te downloaden.</div>';
    html += '<div class="mkt-pricing-grid">';

    html += '<div class="mkt-pricing-plan">';
    html += '<div class="mkt-pricing-name">Gratis</div>';
    html += '<div class="mkt-pricing-price">€ 0</div>';
    html += '<div class="mkt-pricing-list">';
    [
      'Je eigen adres opzoeken met BAG-gegevens',
      'Het plan doorrekenen en aanpassen',
      'Het voorbeeldgebouw volledig bekijken',
    ].forEach(function (t) {
      html += '<div class="mkt-pricing-item">' + CHOICE_ICONS.check + '<span>' + t + '</span></div>';
    });
    html += '</div>';
    html += '<div class="mkt-pricing-cta" data-act="goto-onboarding">Reken je gebouw door</div>';
    html += '</div>';

    html += '<div class="mkt-pricing-plan featured">';
    html += '<div class="mkt-pricing-badge">Voor je eigen gebouw</div>';
    html += '<div class="mkt-pricing-name">Abonnement</div>';
    html += '<div class="mkt-pricing-price">€ 19<span>/maand</span></div>';
    html += '<div class="mkt-pricing-list">';
    [
      'Alles uit Gratis',
      'Plannen opslaan en later verder werken',
      'Rapport printen en exporteren als csv',
      'Wijzigingen worden automatisch bewaard',
      'Maandelijks opzegbaar',
    ].forEach(function (t) {
      html += '<div class="mkt-pricing-item">' + CHOICE_ICONS.check + '<span>' + t + '</span></div>';
    });
    html += '</div>';
    html += state.session
      ? '<div class="mkt-pricing-cta" data-act="goto-app">Naar mijn plan</div>'
      : '<div class="mkt-pricing-cta" data-act="goto-login">Gratis account maken</div>';
    html += '</div>';

    html += '</div></div></div>';

    html += '<div class="mkt-footer"><div class="mkt-footer-inner">';
    html += mktLogo();
    html += '<div class="mkt-footer-links"><a href="#mkt-features">Functies</a><a data-act="goto-login">Inloggen</a><a href="mailto:info@mjoplive.nl">Contact</a><a href="privacy.html">Privacy</a></div>';
    html += '</div></div>';

    html += '</div>';
    return html;
  }

  // Adres- en loginscherm delen één opzet (zie .entry-* in style.css): links
  // de kop met uitleg, rechts een kaart met de eigenlijke handeling — net
  // als de hero van de homepage.
  function entryTop() {
    return '<div class="entry-top">' + choiceLogo() + '</div>';
  }

  function renderLoginScreen() {
    var a = state.auth;
    var html = '<div class="entry-screen">' + entryTop() + '<div class="entry">';
    html += '<div class="entry-copy">';
    html += '<h1 class="entry-h1">Log in met je e-mailadres</h1>';
    html += '<p class="entry-lede">Geen wachtwoord nodig. Je ontvangt een eenmalige inloglink per e-mail.</p>';
    html += '<p class="entry-note">Inloggen heb je nodig om plannen op te slaan. Doorrekenen kan ook zonder account.</p>';
    html += '</div>';

    html += '<div class="ov-card entry-card">';
    if (!sb) {
      html += '<div class="notice error" style="margin-top:0">Inloggen is nog niet geconfigureerd. Vul de Supabase-projectgegevens (URL en anon-sleutel) in <code>src/config.js</code> in.</div>';
    } else if (a.stap === 'sent') {
      html += '<h2 class="ov-h2">Inloglink verstuurd</h2>';
      html += '<p class="entry-sent">Naar <strong>' + esc(a.email) + '</strong>. Open de e-mail en klik op de link, dan kom je hier terug en ben je ingelogd. Geen mail ontvangen? Controleer de spamfolder.</p>';
      if (a.fout) html += '<div class="notice error" style="margin-top:12px">' + esc(a.fout) + '</div>';
      html += '<div class="entry-links"><span class="entry-link" data-act="login-change-email">Ander e-mailadres of opnieuw versturen</span></div>';
    } else {
      html += '<label class="entry-label" for="auth-email">E-mailadres</label>';
      // type="text" i.p.v. "email": een input[type=email] ondersteunt geen
      // selectionStart/setSelectionRange (HTML-spec), waardoor render()
      // hieronder de cursor na elke toetsaanslag niet kan terugzetten en
      // hij steeds naar positie 0 springt — inputmode="email" geeft
      // mobiel nog wel het juiste toetsenbord.
      html += '<input id="auth-email" class="entry-input" data-bind="auth-email" type="text" inputmode="email" value="' + esc(a.email) + '" placeholder="naam@voorbeeld.nl" autocomplete="email" />';
      if (a.fout) html += '<div class="notice error" style="margin-top:12px">' + esc(a.fout) + '</div>';
      html += '<button type="button" class="ov-btn entry-submit" data-act="login-request">' + (a.bezig ? 'Bezig…' : 'Verstuur inloglink') + '</button>';
    }
    html += '<div class="entry-links"><span class="entry-link" data-act="goto-marketing">Terug</span></div>';
    html += '</div>';

    html += '</div></div>';
    return html;
  }

  function renderOnboarding() {
    if (state.upload) return renderUploadWizard();
    var s = state.onboarding;
    var html = '<div class="entry-screen">';

    // Zonder dit belandt een terugkerende ingelogde gebruiker bij elke
    // nieuwe sessie/herlaad hier op het adresscherm, ook met een al
    // opgeslagen plan — dit is de kortste weg terug naar wat er al is.
    // savedPlans staat al op volgorde van bijgewerkt (zie loadSavedPlans),
    // dus [0] is het meest recente.
    if (state.session && state.savedPlans.length) {
      var meestRecent = state.savedPlans[0];
      html += '<div class="entry-status"><div class="entry-status-row">';
      html += '<div>Verdergaan met <strong>' + esc(meestRecent.label || 'je laatste plan') + '</strong></div>';
      html += '<div class="entry-status-links"><span data-act="open-plan" data-id="' + meestRecent.id + '">Openen</span>';
      if (state.savedPlans.length > 1) html += '<span data-act="goto-mijngebouwen">Mijn gebouwen</span>';
      html += '</div>';
      html += '</div></div>';
    }

    html += entryTop() + '<div class="entry">';
    html += '<div class="entry-copy">';
    html += '<h1 class="entry-h1">Zoek je gebouw op</h1>';
    html += '<p class="entry-lede">Typ het adres. MJOP Live haalt bouwjaar, dakoppervlak, gevelmaten en hoogte uit de BAG en 3D BAG.</p>';
    html += '<ul class="entry-list">';
    html += '<li>' + CHOICE_ICONS.check + '<span>Alleen publieke bronnen: BAG en 3D BAG van de TU Delft</span></li>';
    html += '<li>' + CHOICE_ICONS.check + '<span>Doorrekenen kan zonder account</span></li>';
    html += '</ul>';
    html += '</div>';

    html += '<div class="ov-card entry-card">';
    html += '<label class="entry-label" for="addr-search">Adres</label>';
    html += '<div class="entry-search">';
    html += '<input id="addr-search" class="entry-input" data-bind="addr-q" value="' + esc(s.q) + '" placeholder="bv. Kastanjelaan 12 Amersfoort" autocomplete="off" />';
    html += '<button type="button" class="ov-btn" data-act="zoek-adres">Zoek adres</button>';
    html += '</div>';

    if (s.sug.length) {
      html += '<div class="suggest-list">';
      s.sug.forEach(function (sg) {
        html += '<div class="suggest-row" data-act="kies-adres" data-id="' + esc(sg.id) + '" data-naam="' + esc(sg.naam) + '">' + esc(sg.naam) + '</div>';
      });
      html += '</div>';
    }
    if (s.gezocht && !s.sug.length && !s.bezig && !s.fout) {
      html += '<div class="notice">Geen adressen gevonden voor "' + esc(s.q) + '". Controleer de spelling, of bekijk eerst het voorbeeldgebouw.</div>';
    }
    if (s.bezig) html += '<div class="notice">' + esc(s.bezigTekst) + '</div>';
    if (s.fout) html += '<div class="notice error">' + esc(s.fout) + '</div>';

    html += '<div class="entry-alt">';
    html += '<div><div class="entry-alt-title">Heb je al een MJOP?</div>';
    html += '<div class="entry-alt-sub">Upload een csv-, Excel- of pdf-bestand. Jij controleert de regels voordat ze in het plan komen.</div></div>';
    html += '<label class="ov-btn secondary" for="mjop-file-input">Bestand kiezen</label>';
    html += '<input id="mjop-file-input" type="file" accept=".csv,.xlsx,.xls,.pdf" style="display:none" />';
    html += '</div>';
    html += '<div class="entry-links"><span class="entry-link" data-act="skip-onboarding">Bekijk eerst het voorbeeldgebouw</span></div>';
    html += '</div>';

    html += '</div>';
    html += '<div class="entry-foot">Kengetallen zijn indicatieve richtprijzen inclusief btw, geen offerte. Bronnen: PDOK Locatieserver en BAG (Public Domain Mark 1.0) en 3D BAG van de TU Delft (CC BY 4.0).</div>';
    html += '</div>';
    return html;
  }

  // Upload-wizard voor een bestaand MJOP: zelfde opzet als het adres- en
  // loginscherm (entry-screen), maar breder omdat er kolommen en regels
  // gecontroleerd worden. Stappen: laden -> (mapping bij csv/Excel) -> regels.
  function renderUploadWizard() {
    var u = state.upload;
    var titels = {
      laden: 'Bestand wordt gelezen',
      fout: 'Dit bestand kon niet worden gelezen',
      mapping: 'Welke kolom is wat?',
      regels: 'Controleer de regels',
    };
    var subs = {
      laden: '',
      fout: '',
      mapping: 'Kies bij elk gegeven de juiste kolom uit je bestand. Daarna controleer je de regels. Er gaat pas iets in het plan na jouw bevestiging.',
      regels: 'Dit heeft de app in je bestand gevonden. Pas aan wat niet klopt; alleen aangevinkte regels komen in het plan.',
    };
    var html = '<div class="entry-screen">' + entryTop();
    html += '<div class="ov wiz"><div class="pg-head"><h1 class="page-title">' + titels[u.stap] + '</h1>';
    if (subs[u.stap]) html += '<p class="page-sub">' + subs[u.stap] + '</p>';
    html += '<p class="wiz-bestand">Bestand: <strong>' + esc(u.bestandsnaam || 'onbekend') + '</strong></p></div>';

    if (u.stap === 'laden') {
      html += '<div class="section"><div class="notice">' + esc(u.bezigTekst || 'Bestand wordt gelezen…') + '</div></div>';
    } else if (u.stap === 'fout') {
      html += '<div class="section"><div class="notice error">' + esc(u.foutTekst) + '</div>';
      html += '<div class="wiz-actions"><div class="ghost-btn" data-act="reset-upload">Terug</div></div></div>';
    } else if (u.stap === 'mapping') {
      html += renderUploadMapping(u);
    } else if (u.stap === 'regels') {
      html += renderUploadRegels(u);
    }
    html += '</div></div>';
    return html;
  }

  function renderUploadMapping(u) {
    var velden = [
      ['naam', 'Omschrijving van de post'], ['jaar', 'Jaar'], ['bedrag', 'Bedrag'],
      ['sfb', 'NL-SfB-code (mag leeg)'], ['conditie', 'Staat (mag leeg)'],
    ];
    var html = '<div class="section"><div class="card pad">';
    velden.forEach(function (v, i) {
      html += '<div class="input-row"' + (i === 0 ? ' style="margin-top:0"' : '') + '><label class="label" for="upload-map-' + v[0] + '">' + v[1] + '</label>';
      html += '<select id="upload-map-' + v[0] + '" class="wiz-select" data-change="upload-map" data-veld="' + v[0] + '">';
      html += '<option value="-1"' + (u.mapping[v[0]] === -1 ? ' selected' : '') + '>Geen</option>';
      u.headerRij.forEach(function (h, hi) {
        html += '<option value="' + hi + '"' + (u.mapping[v[0]] === hi ? ' selected' : '') + '>' + esc(String(h || 'kolom ' + (hi + 1))) + '</option>';
      });
      html += '</select></div>';
    });
    html += '</div></div>';

    html += '<div class="section"><h2 class="section-title">Zo ziet je bestand eruit</h2>';
    html += '<div class="card wiz-scroll" style="margin-top:12px"><table class="wiz-table"><thead><tr>';
    u.headerRij.forEach(function (h, hi) { html += '<th>' + esc(String(h || 'kolom ' + (hi + 1))) + '</th>'; });
    html += '</tr></thead><tbody>';
    u.dataRijen.slice(0, 4).forEach(function (row) {
      html += '<tr>' + row.map(function (c) { return '<td>' + esc(c) + '</td>'; }).join('') + '</tr>';
    });
    html += '</tbody></table></div></div>';

    html += '<div class="wiz-actions">';
    html += '<div class="primary-btn" data-act="upload-confirm-mapping">Volgende</div>';
    html += '<div class="ghost-btn" data-act="reset-upload">Annuleer</div>';
    html += '</div>';
    return html;
  }

  function renderUploadRegels(u) {
    var basisjaar = num(u.basisjaar);
    var indexPct = (cbsIndexatie ? cbsIndexatie.pct : Math.round(INDEXATIE_PCT * 1000) / 10);
    var html = '<div class="section"><div class="card pad">';
    html += '<label class="ov-row" for="upload-basisjaar"><span>In welk jaar zijn de bedragen berekend?</span><span class="ov-eurinput"><input id="upload-basisjaar" data-bind="upload-basisjaar" inputmode="numeric" value="' + esc(u.basisjaar) + '" /></span></label>';
    html += '<p class="hint">De app rekent de bedragen om naar het jaar waarin de post gepland staat, met ' + indexPct + '% per jaar' + ((cbsIndexatie && state.settings.toonCbsBron) ? ' (CBS-bouwkostenindex ' + cbsIndexatie.periode + ')' : '') + '. Staat er in het bestand al een actueel bedrag? Vul dan ' + CURRENT_YEAR + ' in, dan wordt er niet extra opgeteld.</p>';
    html += '</div></div>';

    html += '<div class="section"><h2 class="section-title">' + u.regels.length + ' ' + meervoud(u.regels.length, 'regel', 'regels') + ' gevonden</h2>';
    html += '<div class="card" style="margin-top:12px">';
    if (!u.regels.length) {
      html += '<div class="row" style="border-top:none"><div class="grow meta">Geen regels herkend. Voeg ze hieronder zelf toe, of gebruik de ruwe tekst om ze over te nemen.</div></div>';
    }
    u.regels.forEach(function (r, i) {
      var geindexeerd = indexeerBedrag(num(r.bedrag), basisjaar, num(r.jaar));
      html += '<div class="wiz-regel">';
      html += '<div class="wiz-regel-kop">';
      html += '<input type="checkbox" data-act="upload-toggle-regel" data-i="' + i + '"' + (r.include ? ' checked' : '') + ' aria-label="Regel opnemen in het plan" />';
      html += '<input id="upload-regel-naam-' + i + '" class="wiz-naam" data-bind="upload-regel-naam" data-i="' + i + '" value="' + esc(r.naam) + '" placeholder="Naam van de post" aria-label="Naam van de post" />';
      html += '<button type="button" class="wiz-del" data-act="upload-del-regel" data-i="' + i + '" aria-label="Verwijder deze regel">×</button>';
      html += '</div>';
      html += '<div class="wiz-fields">';
      html += '<label class="wiz-field"><span>Jaar</span><input id="upload-regel-jaar-' + i + '" data-bind="upload-regel-jaar" data-i="' + i + '" inputmode="numeric" value="' + esc(r.jaar) + '" /></label>';
      html += '<label class="wiz-field"><span>Bedrag (prijspeil ' + basisjaar + ')</span><input id="upload-regel-bedrag-' + i + '" data-bind="upload-regel-bedrag" data-i="' + i + '" inputmode="numeric" value="' + esc(r.bedrag) + '" /></label>';
      html += '<label class="wiz-field"><span>Herhaling in jaren (0 = eenmalig)</span><input id="upload-regel-cyclus-' + i + '" data-bind="upload-regel-cyclus" data-i="' + i + '" inputmode="numeric" value="' + esc(r.cyclus || 0) + '" /></label>';
      html += '</div>';
      html += '<div class="wiz-result">In het plan: ' + eur(geindexeerd) + ' <span>in ' + esc(r.jaar) + '</span></div>';
      html += '</div>';
    });
    html += '<div class="row" style="cursor:pointer" data-act="upload-add-regel"><div class="grow" style="font:600 15px var(--sans);color:var(--blue)">+ Regel toevoegen</div></div>';
    html += '</div></div>';

    if (u.ruweTekst) {
      html += '<div class="section"><details class="ov-details"><summary>Ruwe tekst uit de pdf bekijken</summary>';
      html += '<div class="card pad" style="margin-top:10px"><div class="hint" style="margin:0 0 10px">Heeft de app een regel gemist? Neem hem met deze tekst zelf over hierboven.</div>';
      html += '<pre class="wiz-ruw">' + esc(u.ruweTekst) + '</pre></div></details></div>';
    }

    html += '<div class="section"><p class="hint" style="margin:0">Elke aangevinkte regel wordt een post in het plan, in het opgegeven jaar. Daarna kun je nog het adres koppelen voor de echte gebouwgegevens; de geïmporteerde regels blijven dan staan.</p>';
    html += '<div class="wiz-actions">';
    html += '<div class="primary-btn" data-act="mjop-import-confirm">Importeren en doorgaan</div>';
    html += '<div class="ghost-btn" data-act="reset-upload">Annuleer</div>';
    html += '</div></div>';
    return html;
  }

  // Gedeelde paginaopzet van de tabs (Gebouw, Planning, Rapport, elementdetail,
  // Mijn gebouwen, Account): dezelfde grijze pagina met kaarten als het
  // Overzicht (zie .ov-page/.ov in style.css). smal = leesbare kolombreedte
  // voor lijsten; Planning en Account gebruiken de volle breedte.
  function pgOpen(smal, metVoortgang) { return '<div class="ov-page"><div class="ov' + (smal ? ' ov-narrow' : '') + '">' + (metVoortgang ? voortgangsbalkHtml() : ''); }
  var PG_CLOSE = '</div></div>';

  function renderApp() {
    var html = '<div class="app-shell">';
    // Los van de tabbalk: op mobiel (waar de tabbalk onderin ongewijzigd
    // blijft staan) is dit de enige weg naar Instellingen. Vanaf 960px
    // schuift-ie via CSS vanzelf weg, want daar staat "Instellingen" al
    // linksonder in de zijbalk (zie renderTabBar()).
    html += '<button class="mobile-settings-btn" data-act="set-tab" data-tab="instellingen" aria-label="Account">' + NAV_ICONS.instellingen + '</button>';
    // Tegenhanger linksboven op mobiel/tablet — vanaf 960px zit dezelfde
    // functie al in het logo linksboven in de zijbalk (zie tab-brand
    // hierboven), dus dit icoontje verdwijnt daar via CSS (zie
    // .mobile-home-btn in style.css). Gaat naar de publieke marketing-
    // homepage, net als het logo elders — het Overzicht-tabblad is zelf
    // altijd al één tik verderop via de tabbalk onderin.
    html += '<button class="mobile-home-btn" data-act="goto-marketing" aria-label="Naar de homepage">M</button>';
    // Mobiele tegenhanger van de gebouwkiezer die op desktop onder het
    // logo in de zijbalk staat (zie tab-brand in renderTabBar()) — daar
    // is op mobiel geen ruimte voor (.tab-brand is er altijd verborgen),
    // dus komt 'm hier bovenaan de inhoud te staan. CSS verbergt deze
    // kopie weer vanaf 960px (zie .building-switcher-mobile).
    if (state.building) html += renderBuildingSwitcher('mobile');
    // De enige weg naar screen 'app' zonder building is de snelkoppeling
    // naar "Mijn gebouwen" vanaf het adresscherm (zie 'goto-mijngebouwen')
    // — home/gebouw/planning/rapport gaan er allemaal van uit dat
    // state.building bestaat en crashen anders. Zonder gebouw is Mijn
    // gebouwen het enige zinnige scherm, dus val daarop terug i.p.v. te
    // crashen als de tabbalk (die alle tabs toont, ook zonder gebouw) naar
    // zo'n tab probeert te schakelen.
    var needsBuilding = state.tab === 'home' || state.tab === 'gebouw' || state.tab === 'planning' || state.tab === 'rapport';
    if (needsBuilding && !state.building) state.tab = 'mijngebouwen';
    if (state.tab === 'home') html += renderHome();
    else if (state.tab === 'gebouw') html += renderGebouw();
    else if (state.tab === 'planning') html += renderPlanning();
    else if (state.tab === 'rapport') html += renderRapport();
    else if (state.tab === 'account' || state.tab === 'instellingen') html += renderAccount();
    else if (state.tab === 'mijngebouwen') html += renderMijnGebouwen();
    html += renderTabBar();
    html += '</div>';
    return html;
  }

  // Gebouwkiezer — vervangt de vroegere "wijzig"-link naast het adres op
  // Overzicht en de "Mijn gebouwen"-kaart. Twee plekken roepen dit aan met
  // een andere `variant`-klasse (zie renderTabBar()/renderApp()) zodat CSS
  // per viewport de juiste kopie toont; de inhoud/gedrag is verder gelijk.
  // Zonder sessie is er niets om tussen te wisselen (geen opgeslagen
  // plannen), dus dan alleen het adres met een link naar een nieuw adres.
  function renderBuildingSwitcher(variant) {
    var b = state.building;
    var html = '<div class="building-switcher building-switcher-' + variant + '">';
    if (!state.session) {
      html += '<div class="bswitch-current" data-act="wijzig-adres">';
      html += '<div class="grow"><div class="bswitch-adres">' + esc(b.adres) + '</div></div>';
      html += '<span class="bswitch-chev">›</span>';
      html += '</div></div>';
      return html;
    }
    var statusText = !state.currentPlanId ? 'Nog niet opgeslagen'
      : isDirty() ? 'Niet-opgeslagen wijzigingen' : 'Dit plan is opgeslagen';
    html += '<div class="bswitch-current" data-act="toggle-building-switcher">';
    html += '<div class="grow"><div class="bswitch-adres">' + esc(b.adres) + '</div>';
    html += '<div class="bswitch-status' + (statusText === 'Dit plan is opgeslagen' ? '' : ' dirty') + '">' + statusText + '</div></div>';
    html += '<span class="bswitch-chev">' + (state.buildingSwitcherOpen ? '︿' : '﹀') + '</span>';
    html += '</div>';
    if (state.buildingSwitcherOpen) {
      html += '<div class="bswitch-panel">';
      state.savedPlans.forEach(function (p) {
        var isCurrent = p.id === state.currentPlanId;
        html += '<div class="bswitch-item' + (isCurrent ? ' current' : '') + '" data-act="open-plan" data-id="' + p.id + '">' +
          '<span class="grow">' + esc(p.label || 'Naamloos gebouw') + '</span>' +
          (isCurrent ? '<span class="bswitch-current-tag">huidig</span>' : '') + '</div>';
      });
      html += '<div class="bswitch-item bswitch-add" data-act="wijzig-adres">+ Gebouw toevoegen</div>';
      html += '</div>';
    }
    html += '</div>';
    return html;
  }

  function renderTabBar() {
    var tabs = [
      ['home', 'Overzicht'],
      ['gebouw', 'Gebouw'],
      ['planning', 'Planning'],
      ['rapport', 'Rapport'],
    ];
    var html = '<div class="tab-bar">';
    html += '<div class="tab-brand">' + mktLogo() + (state.building ? renderBuildingSwitcher('sidebar') : '') + '</div>';
    html += '<div class="tab-main">';
    tabs.forEach(function (t) {
      var active = state.tab === t[0];
      html += '<button class="tab-item' + (active ? ' active' : '') + '" data-act="set-tab" data-tab="' + t[0] + '">';
      html += '<span class="tab-label">' + t[1] + '</span></button>';
    });
    // Geen "Opslaan"-knop meer in de zijbalk/tabbalk (huisstijl-README
    // §Zijbalk: "Geen opslaan-knop, nergens" — alles wordt automatisch
    // opgeslagen, de status staat in de voet hieronder). Voor een
    // ingelogde gebruiker zonder abonnement — voorheen de enige weg naar
    // "opslaan is een betaalde functie" (zie ACTIONS['save-plan']) — loopt
    // die ontdekking nu via het accountmenu in de voet i.p.v. een eigen
    // knop hier.
    // "Account" is vanaf 900px geen los menu-item meer — het klikbare
    // gebruikersblok onderin (.tab-account-row, zie .tab-bottom hieronder)
    // met zijn eigen mini-menu neemt die rol over (zie 'toggle-account-
    // menu'). Op mobiel bestaat dat blok niet (.tab-bottom is daar altijd
    // verborgen), dus blijft deze knop daar de enige weg naar inloggen/
    // account — vandaar alleen op desktop weg (zie .tab-item-account-
    // mobile in style.css).
    html += '<button class="tab-item tab-item-account-mobile' + (state.tab === 'account' ? ' active' : '') + '" data-act="set-tab" data-tab="account">';
    html += '<span class="tab-label">' + (state.session ? 'Account' : 'Inloggen') + '</span></button>';
    html += '</div>';
    // Alleen zichtbaar vanaf 900px (zie style.css) — op mobiel blijft de
    // tabbalk onderin exact zoals hij was, en gaat Instellingen via het
    // losse icoontje rechtsboven (zie renderApp()).
    html += '<div class="tab-bottom">';
    html += '<button class="tab-item' + (state.tab === 'instellingen' ? ' active' : '') + '" data-act="set-tab" data-tab="instellingen">';
    html += '<span class="tab-label">Account</span></button>';
    html += '<div class="tab-divider"></div>';
    // Opslaanstatus + mailadres, precies zoals in het referentieontwerp —
    // vervangt het vorige avatar+naam-blok. Blijft klikbaar voor het
    // account-mini-menu (Account/Uitloggen), dat bestond al.
    if (state.session) {
      var fout = state.plansUi.fout;
      var dirty = isDirty();
      var statusLabel = fout ? 'Opslaan mislukt'
        : !isSubscribed() ? 'Wijzigingen worden niet opgeslagen'
        : dirty ? 'Niet-opgeslagen wijzigingen'
        : 'Automatisch opgeslagen';
      var statusClass = fout ? 'bad' : (dirty || !isSubscribed()) ? 'dirty' : '';
      html += '<div class="tab-account-row" data-act="toggle-account-menu">';
      html += '<div class="grow">';
      html += '<div class="tab-save-status ' + statusClass + '"><span class="tab-status-dot"></span>' + esc(statusLabel) + '</div>';
      html += '<div class="tab-account-email">' + esc(state.user.email) + '</div>';
      html += '</div>';
      html += '<span class="account-menu-chev">' + (state.accountMenuOpen ? '︿' : '﹀') + '</span>';
      html += '</div>';
      if (state.accountMenuOpen) {
        html += '<div class="account-menu">';
        html += '<div class="account-menu-item" data-act="set-tab" data-tab="account">Account</div>';
        html += '<div class="account-menu-item" data-act="logout">Uitloggen</div>';
        html += '</div>';
      }
    } else {
      html += '<div class="tab-account-row" data-act="set-tab" data-tab="account">';
      html += '<div class="grow">';
      html += '<div class="tab-save-status dirty"><span class="tab-status-dot"></span>Demo, niet ingelogd</div>';
      html += '<div class="tab-account-email">Voorbeeldgebouw</div>';
      html += '</div>';
      html += '</div>';
    }
    html += '</div>';
    html += '</div>';
    return html;
  }

  // ---------------------------------------------------------------------
  // Account — samengevoegde profiel-/instellingenpagina, bereikbaar via
  // het accountmenu ("Account"/"Instellingen"), het tandwiel-icoon
  // (mobiel) of de onderste tabbalk. Beide oude ingangen komen hier
  // samen (zie ACTIONS['set-tab']), met een links sub-menu voor Profiel/
  // Weergave/Rapport/Abonnement — vergelijkbaar met een gangbaar
  // "Account settings"-scherm, maar zonder velden die MJOP Live niet
  // vastlegt (geen naam/telefoon/adres/team — dit is geen multi-user-tool).
  // ---------------------------------------------------------------------
  function renderAccount() {
    var html = pgOpen(false);
    html += '<div class="pg-head"><h1 class="page-title">Account</h1></div>';

    // Weergave/Rapport hebben geen Supabase nodig (lokale app-instellingen)
    // — alleen Profiel (inloggen) en Abonnement zijn daarvan afhankelijk,
    // dus de "niet geconfigureerd"-melding zit per sub-tab, niet hier
    // bovenaan de hele pagina (anders was Weergave ook onbereikbaar).
    var sub = state.accountSubTab;
    var items = [
      ['profiel', 'Mijn profiel'],
      ['organisatie', 'Organisatie'],
      ['weergave', 'Weergave'],
      ['rapport', 'Rapport'],
      ['abonnement', 'Abonnement'],
    ];

    html += '<div class="section"><div class="acct-layout">';
    html += '<div class="acct-nav">';
    items.forEach(function (it) {
      html += '<div class="acct-nav-item' + (sub === it[0] ? ' active' : '') + '" data-act="set-account-subtab" data-sub="' + it[0] + '">' + it[1] + '</div>';
    });
    html += '</div>';

    var titels = { profiel: 'Mijn profiel', organisatie: 'Organisatie', weergave: 'Weergave', rapport: 'Rapport', abonnement: 'Abonnement' };
    html += '<div class="acct-content"><div class="acct-content-title">' + titels[sub] + '</div>';
    if (sub === 'organisatie') html += renderAcctOrganisatie();
    else if (sub === 'weergave') html += renderAcctWeergave();
    else if (sub === 'rapport') html += renderAcctRapport();
    else if (sub === 'abonnement') html += renderAcctAbonnement();
    else html += renderAcctProfiel();
    html += '</div>';

    html += '</div></div>';
    html += PG_CLOSE;
    return html;
  }

  function renderAcctProfiel() {
    if (!sb) {
      return '<div class="notice error">Inloggen is nog niet geconfigureerd. Vul de Supabase-projectgegevens (URL en anon-sleutel) in <code>src/config.js</code> in.</div>';
    }
    var a = state.auth;
    if (!state.session) {
      var html = '<div class="card pad">';
      if (a.stap === 'sent') {
        html += '<div style="font:500 13.5px/1.35 var(--sans)">Inloglink verstuurd naar ' + esc(a.email) + '</div>';
        html += '<div class="hint" style="margin-top:6px">Open de e-mail en klik op de link — je komt dan hier terug, automatisch ingelogd. De link is eenmalig geldig; kom je op een foutmelding uit, vraag dan hieronder een nieuwe aan.</div>';
        if (a.fout) html += '<div class="notice error" style="margin-top:10px">' + esc(a.fout) + '</div>';
        html += '<div class="btn-row"><div class="ghost-btn" data-act="login-change-email">Andere e-mail / opnieuw versturen</div></div>';
      } else {
        html += '<div style="font:500 13.5px/1.35 var(--sans)">Inloggen met e-mail</div>';
        html += '<div class="hint" style="margin-top:6px">Je krijgt een eenmalige inloglink per e-mail toegestuurd.</div>';
        html += '<div class="input-row" style="margin-top:14px"><div class="label">E-mailadres</div><input id="auth-email" data-bind="auth-email" value="' + esc(a.email) + '" class="wide" placeholder="naam@voorbeeld.nl" style="width:200px;text-align:left" autocomplete="email" /></div>';
        if (a.fout) html += '<div class="notice error" style="margin-top:10px">' + esc(a.fout) + '</div>';
        html += '<div class="btn-row"><div class="primary-btn" data-act="login-request">' + (a.bezig ? 'Bezig…' : 'Stuur inloglink') + '</div></div>';
      }
      html += '</div>';
      return html;
    }

    if (!state.profileLoaded) {
      return '<div class="hint">Bezig met laden…</div>';
    }

    var initial = state.user.email.charAt(0).toUpperCase();
    var p = state.profile;
    var rolLabel = p.rol ? ROL_LABELS[p.rol] : (isSubscribed() ? 'Abonnee' : 'Ingelogd');
    var html = '<div class="card pad acct-profile-card">';
    html += '<div class="acct-avatar">' + esc(initial) + '</div>';
    html += '<div class="grow"><div class="acct-profile-name">' + esc(displayNaam()) + '</div>';
    html += '<div class="acct-profile-sub">' + esc(rolLabel) + ' · ' + esc(state.user.email) + '</div></div>';
    html += '<div class="ghost-btn" data-act="logout">Uitloggen</div>';
    html += '</div>';

    var ui = state.profielUi;
    var dirty = state.profielSnapshot !== JSON.stringify(profielVelden(p));
    html += '<div class="card pad" style="margin-top:14px">';
    html += '<div class="input-row" style="margin-top:0"><div class="label">Voornaam</div><input id="profiel-voornaam" data-bind="profiel-voornaam" value="' + esc(p.voornaam) + '" class="wide" style="width:180px;text-align:left" /></div>';
    html += '<div class="input-row"><div class="label">Achternaam</div><input id="profiel-achternaam" data-bind="profiel-achternaam" value="' + esc(p.achternaam) + '" class="wide" style="width:180px;text-align:left" /></div>';

    html += '<div class="input-row"><div class="label">E-mailadres</div>';
    if (state.emailWijzigen.actief) {
      html += '<input id="email-wijzigen-nieuw" data-bind="email-wijzigen-nieuw" value="' + esc(state.emailWijzigen.nieuw) + '" class="wide" placeholder="nieuw@voorbeeld.nl" style="width:180px;text-align:left" />';
    } else {
      html += '<div style="width:180px;font:400 13px/1.35 ' + 'var(--sans);color:var(--ink)">' + esc(state.user.email) + '</div>';
    }
    html += '</div>';
    if (state.emailWijzigen.actief) {
      if (state.emailWijzigen.verstuurd) {
        html += '<div class="hint">Bevestigingslink verstuurd naar ' + esc(state.emailWijzigen.nieuw) + ' — bevestig via de link(s) in je mailbox om het definitief te wijzigen.</div>';
      } else {
        if (state.emailWijzigen.fout) html += '<div class="notice error" style="margin-top:6px">' + esc(state.emailWijzigen.fout) + '</div>';
        html += '<div class="btn-row" style="margin-top:8px"><div class="primary-btn" data-act="submit-email-wijzigen">' + (state.emailWijzigen.bezig ? 'Bezig…' : 'Verstuur bevestigingslink') + '</div><div class="ghost-btn" data-act="cancel-email-wijzigen">Annuleer</div></div>';
      }
    } else {
      html += '<div class="linkish" data-act="start-email-wijzigen">Wijzigen</div>';
    }

    html += '<div class="input-row"><div class="label">Telefoonnummer</div><input id="profiel-telefoon" data-bind="profiel-telefoon" value="' + esc(p.telefoon) + '" class="wide" placeholder="06 12345678" style="width:180px;text-align:left" /></div>';
    html += '<div class="hint" style="margin-top:2px">Optioneel — alleen voor eventuele terugbelverzoeken over je account.</div>';

    html += '<div class="input-row"><div class="label">Rol</div><select class="acct-select" data-change="profiel-rol">';
    [['', 'Kies een rol…'], ['bestuurslid', 'Bestuurslid'], ['vve_beheerder', 'VvE-beheerder'], ['adviseur', 'Adviseur'], ['anders', 'Anders']].forEach(function (o) {
      html += '<option value="' + o[0] + '"' + (p.rol === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
    });
    html += '</select></div>';

    if (ui.fout) html += '<div class="notice error" style="margin-top:12px">' + esc(ui.fout) + '</div>';
    else if (dirty) html += '<div class="hint" style="margin-top:12px;color:var(--accent)">Niet-opgeslagen wijzigingen</div>';
    else if (ui.opgeslagen) html += '<div class="hint" style="margin-top:12px;color:var(--good-fg)">Opgeslagen</div>';
    html += '<div class="btn-row" style="margin-top:10px"><div class="primary-btn" data-act="save-profiel">' + (ui.bezig ? 'Bezig…' : 'Opslaan') + '</div></div>';
    html += '</div>';

    html += '<div class="card pad" style="margin-top:14px">';
    html += '<div style="font:500 13.5px/1.3 var(--sans)">Mijn gebouwen</div>';
    if (state.savedPlans.length === 0) {
      html += '<div class="hint" style="margin-top:6px">Nog geen opgeslagen plannen — sla het huidige plan op via "Opslaan" in de tabbalk, het verschijnt dan hier.</div>';
    } else {
      html += '<div class="card" style="margin-top:11px">';
      state.savedPlans.forEach(function (p) { html += renderPlanRow(p); });
      html += '</div>';
      html += '<div class="linkish" style="margin-top:10px;display:block" data-act="goto-mijngebouwen">Alle gebouwen beheren</div>';
    }
    html += '</div>';

    html += renderGegevensPrivacy();
    return html;
  }

  // Stond eerder als "Account verwijderen" los in het sub-menu, met alleen
  // een mailto-link naar support — nu écht zelf te doen (zie
  // supabase/functions/delete-account) en met een gegevens-download
  // ernaast, allebei op hun plek onderaan "Mijn profiel" i.p.v. in de
  // navigatie (het is geen bestemming om naartoe te navigeren, maar een
  // paar acties).
  function renderGegevensPrivacy() {
    var v = state.accountVerwijderen, pu = state.privacyUi;
    var html = '<div class="card pad" style="margin-top:14px">';
    html += '<div style="font:500 13.5px/1.3 var(--sans)">Gegevens en privacy</div>';

    html += '<div class="row" style="border-top:none;margin-top:11px;padding:0 0 11px">';
    html += '<div class="grow"><div class="name">Download mijn gegevens</div><div class="meta">Je profiel, organisatie- en factuurgegevens en al je opgeslagen plannen, als JSON-bestand</div></div>';
    html += '<div class="ghost-btn" data-act="download-mijn-gegevens">' + (pu.bezig ? 'Bezig…' : 'Downloaden') + '</div>';
    html += '</div>';
    if (pu.fout) html += '<div class="notice error" style="margin-top:4px">' + esc(pu.fout) + '</div>';

    html += '<div class="row" style="border-top:1px solid var(--ink-08);padding-top:11px">';
    html += '<div class="grow"><div class="name" style="color:var(--accent)">Account verwijderen</div><div class="meta">Verwijdert je account en alle opgeslagen plannen definitief en zegt een actief abonnement direct op — dit kan niet ongedaan worden gemaakt</div></div>';
    if (!v.actief) html += '<div class="ghost-btn" data-act="start-account-verwijderen">Verwijderen</div>';
    html += '</div>';
    if (v.actief) {
      html += '<div class="hint" style="margin-top:2px">Typ je e-mailadres (' + esc(state.user.email) + ') om te bevestigen.</div>';
      html += '<div class="input-row"><div class="label">E-mailadres</div><input id="verwijder-email-typed" data-bind="verwijder-email-typed" value="' + esc(v.typedEmail) + '" class="wide" style="width:200px;text-align:left" /></div>';
      if (v.fout) html += '<div class="notice error" style="margin-top:6px">' + esc(v.fout) + '</div>';
      html += '<div class="btn-row" style="margin-top:8px"><div class="primary-btn accent" data-act="submit-account-verwijderen">' + (v.bezig ? 'Bezig…' : 'Verwijder mijn account definitief') + '</div><div class="ghost-btn" data-act="cancel-account-verwijderen">Annuleer</div></div>';
    }
    html += '</div>';
    return html;
  }

  // Alles hier is optioneel — een particuliere eigenaar zonder VvE/bedrijf
  // laat dit gewoon leeg, en dan verschijnt er ook niets extra's op het
  // rapport (zie renderRapport()/renderPrintReport()).
  function renderAcctOrganisatie() {
    if (!sb) {
      return '<div class="notice error">Inloggen is nog niet geconfigureerd. Vul de Supabase-projectgegevens (URL en anon-sleutel) in <code>src/config.js</code> in.</div>';
    }
    if (!state.session) {
      return '<div class="hint" style="margin-top:0">Log eerst in om organisatiegegevens vast te leggen.</div>';
    }
    if (!state.profileLoaded) {
      return '<div class="hint">Bezig met laden…</div>';
    }
    var p = state.profile, ui = state.orgUi;
    var dirty = state.orgSnapshot !== JSON.stringify(orgVelden(p));
    var html = '<div class="card pad">';
    html += '<div class="input-row" style="margin-top:0"><div class="label">Naam VvE of bedrijf</div><input id="org-naam" data-bind="org-naam" value="' + esc(p.orgNaam) + '" class="wide" placeholder="VvE Voorbeeldstraat 1-12" style="width:220px;text-align:left" /></div>';
    html += '<div class="input-row"><div class="label">KvK-nummer</div><input id="org-kvk" data-bind="org-kvk" value="' + esc(p.kvkNummer) + '" class="wide" placeholder="12345678" style="width:120px;text-align:left" /></div>';
    html += '<div class="row" style="border-top:none;margin-top:11px;padding:0">';
    html += '<div class="grow"><div class="name">Tonen op het rapport</div><div class="meta">Voegt "Opgesteld door: ' + esc(p.orgNaam || '…') + '" toe aan het rapport (scherm en pdf)</div></div>';
    html += '<div class="toggle' + (p.toonOrgOpRapport ? ' on' : '') + '" data-act="toggle-org-op-rapport"><div class="knob"></div></div>';
    html += '</div>';
    if (ui.fout) html += '<div class="notice error" style="margin-top:12px">' + esc(ui.fout) + '</div>';
    else if (dirty) html += '<div class="hint" style="margin-top:12px;color:var(--accent)">Niet-opgeslagen wijzigingen</div>';
    else if (ui.opgeslagen) html += '<div class="hint" style="margin-top:12px;color:var(--good-fg)">Opgeslagen</div>';
    html += '<div class="btn-row" style="margin-top:10px"><div class="primary-btn" data-act="save-organisatie">' + (ui.bezig ? 'Bezig…' : 'Opslaan') + '</div></div>';
    html += '</div>';
    return html;
  }

  function renderAcctWeergave() {
    var html = '<div class="card">';
    html += '<div class="row" style="border-top:none">';
    html += '<span class="tab-icon" style="width:20px;height:20px;color:var(--ink-45)">' + (state.theme === 'dark' ? NAV_ICONS.maan : NAV_ICONS.zon) + '</span>';
    html += '<div class="grow"><div class="name">Donker thema</div><div class="meta">' + (state.theme === 'dark' ? 'Nu aan' : 'Nu uit') + '</div></div>';
    html += '<div class="toggle' + (state.theme === 'dark' ? ' on' : '') + '" data-act="toggle-theme"><div class="knob"></div></div>';
    html += '</div></div>';
    return html;
  }

  function renderAcctRapport() {
    var html = '<div class="card">';
    html += '<div class="row" style="border-top:none">';
    html += '<div class="grow"><div class="name">CBS-bouwkostenindex vermelden</div><div class="meta">Toont erbij welk indexatiepercentage gebruikt is, bijv. "(CBS-bouwkostenindex 2024)"</div></div>';
    html += '<div class="toggle' + (state.settings.toonCbsBron ? ' on' : '') + '" data-act="toggle-cbs-bron"><div class="knob"></div></div>';
    html += '</div></div>';
    return html;
  }

  var LANDEN = ['Nederland', 'België', 'Duitsland', 'Overig'];
  function renderAcctAbonnement() {
    var html = '<div class="card pad">';
    if (!state.session) {
      html += '<div class="hint" style="margin-top:0">Log eerst in om een abonnement af te sluiten.</div>';
    } else if (isSubscribed()) {
      var tot = state.subscription.current_period_end ? new Date(state.subscription.current_period_end).toLocaleDateString('nl-NL') : null;
      html += '<div class="kv"><div class="label">Status</div><div class="amount" style="font-size:15px;color:var(--good-fg)">Actief</div></div>';
      if (tot) html += '<div class="hint">Loopt door tot ' + tot + ', tenzij je opzegt.</div>';
      html += '<div class="btn-row"><div class="ghost-btn" data-act="manage-abonnement">' + (state.subscriptionUi.bezig ? 'Bezig…' : 'Beheer abonnement') + '</div></div>';
    } else {
      html += '<div class="kv"><div class="label">Status</div><div class="amount" style="font-size:15px">Geen abonnement</div></div>';
      html += '<div class="hint">Met een abonnement (€ 19 per maand) sla je plannen op en druk je het rapport af of exporteer je het als csv. Doorrekenen en aanpassen blijft gratis.</div>';
      html += '<div class="btn-row"><div class="primary-btn" data-act="upgrade-abonnement">' + (state.subscriptionUi.bezig ? 'Bezig…' : 'Abonneren — € 19/maand') + '</div></div>';
    }
    if (state.subscriptionUi.fout) html += '<div class="notice error" style="margin-top:12px">' + esc(state.subscriptionUi.fout) + '</div>';
    html += '</div>';

    if (state.session && state.profileLoaded) html += renderFacturatie();
    return html;
  }

  // Los van de abonnementsstatus hierboven getoond (en met een eigen
  // opslaan-knop), maar op hetzelfde tabblad: dit ís de "Facturatie"-sectie
  // uit de opdracht, bewust niet als los sub-menu-item, want het hoort
  // inhoudelijk bij "Abonnement" (waar ook de eis vandaan komt). Verplicht
  // wordt dit pas gecontroleerd bij het daadwerkelijk afsluiten van een
  // betaald abonnement (zie ACTIONS['upgrade-abonnement']) — niet hier.
  function renderFacturatie() {
    var p = state.profile, ui = state.facturatieUi, z = state.facturatieZoek;
    var dirty = state.facturatieSnapshot !== JSON.stringify(facturatieVelden(p));
    var html = '<div class="card pad" style="margin-top:14px">';
    html += '<div style="font:500 13.5px/1.3 var(--sans)">Factuurgegevens</div>';
    html += '<div class="hint" style="margin-top:4px">Alleen nodig zodra je een betaald abonnement afsluit — bij het aanmaken van je account hoeft dit nog niet.</div>';

    html += '<div class="input-row" style="margin-top:14px"><div class="label">Postcode</div><input id="fact-postcode" data-bind="fact-postcode" value="' + esc(p.factuurPostcode) + '" class="wide" placeholder="1234 AB" style="width:90px;text-align:left" /></div>';
    html += '<div class="input-row"><div class="label">Huisnummer</div><input id="fact-huisnummer" data-bind="fact-huisnummer" value="' + esc(p.factuurHuisnummer) + '" class="wide" placeholder="12" style="width:70px;text-align:left" /></div>';
    if (z.bezig) html += '<div class="hint" style="margin-top:2px">Straat en plaats opzoeken…</div>';
    else if (z.fout) html += '<div class="hint" style="margin-top:2px">' + esc(z.fout) + '</div>';
    html += '<div class="input-row"><div class="label">Straat</div><input id="fact-straat" data-bind="fact-straat" value="' + esc(p.factuurStraat) + '" class="wide" style="width:200px;text-align:left" /></div>';
    html += '<div class="input-row"><div class="label">Plaats</div><input id="fact-plaats" data-bind="fact-plaats" value="' + esc(p.factuurPlaats) + '" class="wide" style="width:200px;text-align:left" /></div>';
    html += '<div class="input-row"><div class="label">Land</div><select class="acct-select" data-change="fact-land">';
    LANDEN.forEach(function (l) { html += '<option value="' + l + '"' + (p.factuurLand === l ? ' selected' : '') + '>' + l + '</option>'; });
    html += '</select></div>';
    html += '<div class="input-row"><div class="label">BTW-nummer</div><input id="fact-btw" data-bind="fact-btw" value="' + esc(p.btwNummer) + '" class="wide" placeholder="NL123456789B01" style="width:160px;text-align:left" /></div>';
    html += '<div class="hint" style="margin-top:2px">Optioneel.</div>';

    if (ui.fout) html += '<div class="notice error" style="margin-top:12px">' + esc(ui.fout) + '</div>';
    else if (dirty) html += '<div class="hint" style="margin-top:12px;color:var(--accent)">Niet-opgeslagen wijzigingen</div>';
    else if (ui.opgeslagen) html += '<div class="hint" style="margin-top:12px;color:var(--good-fg)">Opgeslagen</div>';
    html += '<div class="btn-row" style="margin-top:10px"><div class="primary-btn" data-act="save-facturatie">' + (ui.bezig ? 'Bezig…' : 'Opslaan') + '</div></div>';
    html += '</div>';
    return html;
  }

  // Inloggen (fase 1 van SPEC_ACCOUNTS_AND_SAVING.md) — e-mail-magic-link,
  // geen wachtwoord. Was oorspronkelijk als code-per-e-mail (OTP) gebouwd,
  // maar Supabase's gratis standaard-mailversturing staat geen aangepast
  // sjabloon toe (dat vereist een eigen SMTP-provider) — het vaste
  // "Magic Link"-sjabloon met alleen een link werkt zonder verdere
  // configuratie, dus daar is op overgestapt. supabase-js detecteert de
  // sessie na een klik op de link automatisch uit de url
  // (detectSessionInUrl, standaard aan) en meldt dat via de
  // onAuthStateChange-listener, net als bij elke andere in-/uitlog-actie.
  function renderMijnGebouwen() {
    var html = pgOpen(true);
    html += '<div class="top-nav"><div class="back-link" data-act="set-tab" data-tab="home">‹ Overzicht</div></div>';
    html += '<div class="pg-head">';
    html += '<h1 class="page-title">Mijn gebouwen</h1>';
    html += '<div class="page-sub">Opgeslagen plannen — openen, hernoemen of verwijderen.</div>';
    html += '</div>';

    if (state.plansUi.fout) {
      html += '<div class="section"><div class="notice error">' + esc(state.plansUi.fout) + '</div></div>';
    }

    if (state.plansUi.bezig && !state.plansLoaded) {
      html += '<div class="section"><div class="hint">Bezig met laden…</div></div>';
    } else if (state.savedPlans.length === 0) {
      html += '<div class="empty-block"><div class="empty-card">';
      html += '<div class="title">Nog geen opgeslagen plannen</div>';
      html += '<div class="body">Sla het huidige plan op via "Opslaan" in de tabbalk hierboven — het verschijnt dan hier.</div>';
      html += '</div></div>';
    } else {
      html += '<div class="section"><div class="card">';
      state.savedPlans.forEach(function (p) { html += renderPlanRow(p); });
      html += '</div></div>';
    }

    html += PG_CLOSE;
    return html;
  }

  // Eén rij van de plannenlijst — gedeeld door de volledige "Mijn
  // gebouwen"-pagina hierboven en de lichte, ingebedde lijst op "Mijn
  // profiel" (zie renderAcctProfiel()), zodat hernoemen/verwijderen/
  // openen overal precies hetzelfde werken. "Hernoemen" is hier het
  // altijd-bewerkbare naam-veld (geen apart "hernoemen"-knopje nodig),
  // net als vóór deze samenvoeging.
  function renderPlanRow(p) {
    var confirming = state.confirmDeleteId === p.id;
    var isOpen = state.currentPlanId === p.id;
    var html = '<div class="row">';
    html += '<div class="grow">';
    html += '<input id="plan-label-' + p.id + '" data-bind="plan-label" data-change="plan-label" data-id="' + p.id + '" value="' + esc(p.label || '') + '" class="name" style="border:none;background:transparent;width:100%;padding:2px 0;font:400 13px/1.3 var(--sans);color:var(--ink)" />';
    html += '<div class="meta">' + (p.adres ? esc(p.adres) + ' · ' : '') + (isOpen ? 'Nu geopend · ' : '') + 'bijgewerkt ' + esc(new Date(p.updated_at).toLocaleDateString('nl-NL')) + '</div>';
    html += '</div>';
    if (confirming) {
      html += '<div class="linkish" data-act="delete-plan" data-id="' + p.id + '" style="color:var(--accent)">verwijder definitief</div>';
      html += '<div class="linkish" data-act="delete-plan-cancel">annuleer</div>';
    } else {
      html += '<div class="linkish" data-act="open-plan" data-id="' + p.id + '">openen</div>';
      html += '<div class="linkish" data-act="delete-plan-confirm" data-id="' + p.id + '">verwijder</div>';
    }
    html += '</div>';
    return html;
  }

  // ---------------------------------------------------------------------
  // Overzicht — beantwoordt "sparen we genoeg?" met één grote saldografiek.
  // Verdict, grafiek en laagste saldo zitten in #ov-verdict/#ov-chart/
  // #ov-low en worden tijdens het slepen van de bijdrage-slider los
  // vervangen (zie updateOverzichtLive()); de slider zelf blijft staan,
  // anders raakt de browser de sleepbeweging kwijt.
  // ---------------------------------------------------------------------
  function overzichtModel(st) {
    st = st || state;
    var rows = kasstroom(st);
    var eind = CURRENT_YEAR + HORIZON - 1;
    var laagsteRij = rows.reduce(function (min, r) { return r.saldo < min.saldo ? r : min; }, rows[0]);
    return {
      rows: rows,
      plan: fullPlan(st).filter(function (p) { return p.jaar >= CURRENT_YEAR && p.jaar <= eind; }),
      eerste: rows.filter(function (r) { return r.saldo < 0; })[0],
      laagste: laagsteRij,
      totaal: rows.reduce(function (a, r) { return a + r.kosten; }, 0),
      nodig: benodigdeBijdrage(st),
      bijdrage: st.bijdrage,
      units: Math.max(1, st.building.units),
      saldoBekend: st.invul ? st.invul.fonds : true,
      fonds: st.fonds,
      eind: eind
    };
  }

  // Ronde stap voor de eurogaas (1, 2, 5 × 10^n) zodat de as geen
  // rare tussenwaarden toont.
  function niceStep(range, targetTicks) {
    var raw = range / targetTicks;
    var mag = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10));
    var norm = raw / mag;
    return (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  }

  // De (max. 3) grootste uitgavenjaren, met de zwaarste post van dat jaar
  // als naam — die worden in de grafiek zelf benoemd, zodat te zien is
  // waaróm het saldo daar zakt.
  function overzichtCallouts(plan) {
    var perJaar = {};
    plan.forEach(function (p) {
      var g = perJaar[p.jaar];
      if (!g) g = perJaar[p.jaar] = { jaar: p.jaar, totaal: 0, aantal: 0, top: p };
      g.totaal += p.bedrag;
      g.aantal++;
      if (p.bedrag > g.top.bedrag) g.top = p;
    });
    var lijst = Object.keys(perJaar).map(function (k) { return perJaar[k]; })
      .sort(function (a, b) { return b.totaal - a.totaal; });
    if (!lijst.length) return [];
    var drempel = lijst[0].totaal * 0.25;
    return lijst.slice(0, 3).filter(function (g) { return g.totaal >= drempel; })
      .sort(function (a, b) { return a.jaar - b.jaar; });
  }

  function overzichtCalloutNaam(g) {
    return g.top.naam + (g.aantal > 1 ? ' + ' + (g.aantal - 1) + ' ' + meervoud(g.aantal - 1, 'post', 'posten') : '');
  }

  // zonderKnop = de homepage-weergave: geen actieknop, en de kop is een h2
  // omdat de hero zelf al een h1 heeft.
  function ovVerdictHtml(m, zonderKnop, kopNiveau) {
    var b = m.bijdrage;
    var kop = kopNiveau || (zonderKnop ? 'h2' : 'h1');
    if (!m.saldoBekend) {
      // De route hierboven vraagt al om het saldo; hier alleen wat er komt.
      return '<p class="ov-lede" style="margin-top:0">Zodra het saldo is ingevuld, zie je hier of jullie genoeg sparen.</p>';
    }
    var html = '<' + kop + ' class="ov-head">' + (m.eerste
      ? 'Bij ' + eur(b) + ' per maand is het fonds in ' + m.eerste.jaar + ' leeg.'
      : 'Bij ' + eur(b) + ' per maand blijft het fonds de komende ' + HORIZON + ' jaar op peil.') + '</' + kop + '>';
    html += '<p class="ov-lede">' + (m.eerste
      ? 'Je hebt ' + eur(m.nodig) + ' per appartement per maand nodig om alle posten tot en met ' + m.eind + ' te betalen (' + eur(m.nodig * m.units) + ' per maand voor het hele gebouw)' +
        (b < m.nodig ? ', ' + eur(m.nodig - b) + ' per appartement meer dan nu.' : '.')
      : 'Het laagste saldo in deze periode is ' + eurSigned(m.laagste.saldo) + ' (' + m.laagste.jaar + ').') + '</p>';
    if (m.eerste) {
      var tekort = Math.ceil(-m.laagste.saldo);
      html += '<p class="ov-alt">Of stort eenmalig ' + eur(tekort) + ' extra in het fonds (' + eur(Math.ceil(tekort / m.units)) + ' per appartement).</p>';
    }
    if (b < m.nodig && !zonderKnop) {
      html += '<button type="button" class="ov-btn" data-act="zet-advies" data-nodig="' + m.nodig + '">Zet bijdrage op ' + eur(m.nodig) + '</button>';
    }
    return html;
  }

  function ovLowHtml(m) {
    var neg = m.laagste.saldo < 0;
    if (!m.saldoBekend) return '<span>Laagste stand van het fonds</span><b>Nog onbekend</b>';
    return '<span>Laagste stand van het fonds (' + m.laagste.jaar + ')</span><b class="' + (neg ? 'ov-neg' : '') + '">' + eurSigned(m.laagste.saldo) + '</b>';
  }

  function ovChartHtml(m) {
    if (!m.saldoBekend) {
      return '<div class="ov-empty">Zodra je het saldo van het reservefonds hebt ingevuld, zie je hier per jaar hoeveel er in het fonds zit en wanneer er een tekort dreigt.</div>';
    }
    var rows = m.rows;
    var saldi = rows.map(function (r) { return r.saldo; });
    var hi = Math.max.apply(null, saldi.concat(0));
    var lo = Math.min.apply(null, saldi.concat(0));
    if (hi - lo < 1000) hi = lo + 1000;
    var stap = niceStep(hi - lo, 4);
    // Een derde stap marge voorbij de uitersten, voor het waardelabel bij
    // het laagste jaar.
    var top = hi > 0 ? Math.ceil((hi + stap / 3) / stap) * stap : 0;
    var bottom = lo < 0 ? Math.floor((lo - stap / 3) / stap) * stap : 0;
    var range = top - bottom;
    function pct(v) { return ((top - v) / range * 100).toFixed(2); }

    var callouts = overzichtCallouts(m.plan);
    // Elk benoemd jaar krijgt een eigen regel (vroegste bovenaan); de
    // verticale lijn naar de kolom loopt onder de tekst van lagere regels
    // door (die hebben een achtergrond), dus er kruist niets leesbaars.
    var band = '';
    callouts.forEach(function (g, row) {
      var idx = g.jaar - CURRENT_YEAR;
      var x = (idx + 0.5) / HORIZON * 100;
      var right = idx >= HORIZON - 3;
      band += '<div class="ov-call' + (right ? ' right' : '') + '" style="' + (right ? 'right:' + (100 - x).toFixed(2) : 'left:' + x.toFixed(2)) + '%;top:' + (row * 24) + 'px;z-index:' + (row + 1) + ';max-width:' + (right ? x : 100 - x).toFixed(2) + '%">' +
        '<span class="ov-call-t"><span class="ov-call-n">' + esc(overzichtCalloutNaam(g)) + '</span> <b>' + eur(g.totaal) + '</b></span></div>';
    });

    var grid = '';
    var n = Math.round(range / stap);
    for (var i = 0; i <= n; i++) {
      var v = bottom + i * stap;
      grid += '<div class="ov-grid' + (v === 0 ? ' zero' : '') + '" style="top:' + pct(v) + '%"><span class="ov-tick">' + eurSigned(v) + '</span></div>';
    }

    var minIdx = rows.indexOf(m.laagste);
    var cols = '';
    var years = '';
    rows.forEach(function (r, i) {
      var neg = r.saldo < 0;
      var t = neg ? pct(0) : pct(r.saldo);
      var h = (Math.abs(r.saldo) / range * 100).toFixed(2);
      cols += '<div class="ov-col" title="' + esc(r.jaar + ': ' + eurSigned(r.saldo)) + '">' +
        '<div class="ov-bar ' + (neg ? 'neg' : 'pos') + '" style="top:' + t + '%;height:' + h + '%"></div>' +
        (i === minIdx ? '<span class="ov-val ' + (neg ? 'below' : 'above') + '" style="top:' + pct(r.saldo) + '%">' + eurSigned(r.saldo) + '</span>' : '') +
        '</div>';
      years += '<span><i class="y-full">' + r.jaar + '</i><i class="y-short">’' + String(r.jaar).slice(2) + '</i></span>';
    });

    var html = '<div class="ov-band">' + band + '</div>';
    html += '<div class="ov-plot">' + grid + '<div class="ov-cols">' + cols + '</div></div>';
    html += '<div class="ov-years">' + years + '</div>';
    // Op een telefoon is er geen ruimte voor de benoemde jaren in de
    // grafiek zelf — daar staan ze als lijst eronder.
    if (callouts.length) {
      html += '<ul class="ov-bigs">' + callouts.map(function (g) {
        return '<li><span class="ov-bigs-y">' + g.jaar + '</span><span class="ov-bigs-n">' + esc(overzichtCalloutNaam(g)) + '</span><b>' + eur(g.totaal) + '</b></li>';
      }).join('') + '</ul>';
    }
    // Volledige waarden voor schermlezers; de grafiek zelf is een plaatje.
    html += '<div class="sr-only"><table><caption>Saldo van het reservefonds per jaar</caption><thead><tr><th>Jaar</th><th>Kosten</th><th>Saldo aan het einde van het jaar</th></tr></thead><tbody>' +
      rows.map(function (r) { return '<tr><td>' + r.jaar + '</td><td>' + eur(r.kosten) + '</td><td>' + eurSigned(r.saldo) + '</td></tr>'; }).join('') +
      '</tbody></table></div>';
    return html;
  }

  function updateOverzichtLive() {
    var verdict = document.getElementById('ov-verdict');
    var chart = document.getElementById('ov-chart');
    var low = document.getElementById('ov-low');
    if (!verdict || !chart || !low) return;
    var m = overzichtModel();
    verdict.innerHTML = ovVerdictHtml(m, false, 'h2');
    chart.innerHTML = ovChartHtml(m);
    low.innerHTML = ovLowHtml(m);
  }

  // De route in vijf stappen: gedeeld door de route-kaart op het Overzicht
  // en de voortgangsbalk op de andere tabs. Stap 5 (het voorstel) telt niet
  // als "klaar": die is het doel, en de deur van het gebouw gaat pas aan
  // als de eerste vier klaar zijn.
  var ROUTE_KORT = ['Adres', 'Saldo', 'Bijdrage', 'Staat van de posten', 'Voorstel'];

  function stappenModel() {
    var aandacht = state.elements.filter(needsAssessment);
    var totaal = state.elements.filter(function (el) { return el.type !== 'custom'; }).length;
    var stappen = [
      { klaar: true, vraag: 'Gebouw gevonden', tekst: state.building.adres },
      { klaar: state.invul.fonds, vraag: 'Wat staat er nu op de reservekas?', tekst: 'Je vindt het saldo in de administratie van de VvE, of bij de beheerder of de bank.', actie: ['focus-fonds', 'Saldo invullen'] },
      { klaar: state.invul.bijdrage, vraag: 'Wat betaalt elk appartement nu per maand?', tekst: 'Dit is de bijdrage aan het reservefonds. Je vindt hem in de begroting of op de maandelijkse nota van de VvE.', actie: ['focus-bijdrage', 'Bijdrage invullen'] },
      { klaar: !aandacht.length, vraag: 'Hoe staat het ervoor met het onderhoud?', tekst: (totaal - aandacht.length) + ' van ' + totaal + ' ' + meervoud(totaal, 'post', 'posten') + ' beoordeeld. Noteer wat je ziet, zoals lekkage of houtrot. Zonder beoordeling rekent de app met de gebruikelijke levensduur.', actie: aandacht.length ? ['open-element', 'Begin met beoordelen', aandacht[0].id] : null },
      { klaar: false, vraag: 'Je voorstel voor de vergadering', tekst: 'Bekijk en print het rapport met de bijdrage die nodig is.', actie: ['set-tab', 'Naar het rapport', 'rapport'] },
    ];
    var eersteOpen = 4;
    for (var i = 0; i < 4; i++) { if (!stappen[i].klaar) { eersteOpen = i; break; } }
    var klaarAantal = stappen.slice(0, 4).filter(function (s) { return s.klaar; }).length;
    return { stappen: stappen, eersteOpen: eersteOpen, klaarAantal: klaarAantal, resterend: 4 - klaarAantal };
  }

  function stappenKop(sm) {
    var woord = { 1: 'één', 2: 'twee', 3: 'drie' };
    if (sm.resterend === 0) return 'Je voorstel staat klaar';
    return 'Nog ' + woord[sm.resterend] + ' ' + meervoud(sm.resterend, 'stap', 'stappen') + ' tot je voorstel';
  }

  function actieAttrs(actie) {
    if (!actie[2]) return ' data-act="' + actie[0] + '"';
    return ' data-act="' + actie[0] + '"' + (actie[0] === 'set-tab' ? ' data-tab="' : ' data-id="') + actie[2] + '"';
  }

  // Het gebouw bij avond: elk raam brandt zodra de bijbehorende stap klaar is
  // (vier ramen voor stap 1 t/m 4) en de voordeur zodra het voorstel klaar is.
  function gebouwNachtSvg(sm) {
    var lit = [0, 1, 2, 3].map(function (i) { return sm.stappen[i].klaar; });
    var s = '<svg viewBox="0 0 300 250" width="300" height="250" focusable="false">';
    s += '<rect x="30" y="66" width="240" height="176" rx="2" fill="#0E2F57"/><rect x="24" y="52" width="252" height="16" rx="2" fill="#0A2444"/>';
    s += '<rect x="176" y="30" width="34" height="22" fill="#0A2444"/><rect x="184" y="14" width="7" height="18" fill="#0A2444"/>';
    var xs = [54, 210], ys = [84, 140], i = 0;
    ys.forEach(function (y) {
      xs.forEach(function (x) {
        var an = lit[i++];
        if (an) s += '<rect x="' + (x - 6) + '" y="' + (y - 6) + '" width="52" height="46" rx="5" fill="#F2B45A" opacity=".25"/>';
        s += '<rect x="' + x + '" y="' + y + '" width="40" height="34" rx="2" fill="' + (an ? '#F7CE8A' : '#1C4675') + '"/>';
        if (an) s += '<path d="M' + (x + 20) + ' ' + y + 'v34M' + x + ' ' + (y + 17) + 'h40" stroke="#B87A2B" stroke-width="1.6"/>';
      });
    });
    var deurAan = sm.resterend === 0;
    s += '<rect x="140" y="84" width="20" height="94" fill="#173E6C"/>';
    s += '<rect x="134" y="196" width="32" height="46" fill="' + (deurAan ? '#F2B45A' : '#1C4675') + '"/>';
    s += '<rect x="54" y="196" width="40" height="34" rx="2" fill="#1C4675"/><rect x="210" y="196" width="40" height="34" rx="2" fill="#1C4675"/><rect x="0" y="242" width="300" height="8" fill="#0A2444"/></svg>';
    return s;
  }

  // Slanke voortgangsbalk bovenaan de andere tabs: waar sta je in de route.
  function voortgangsbalkHtml() {
    var sm = stappenModel();
    var volgende = sm.stappen[sm.eersteOpen];
    var html = '<div class="ov-vg"><span class="ov-vg-dots" aria-hidden="true">';
    for (var i = 0; i < 5; i++) html += '<i class="' + (sm.stappen[i].klaar ? 'done' : (i === sm.eersteOpen ? 'now' : '')) + '"></i>';
    html += '</span><span class="ov-vg-tekst"><b>' + sm.klaarAantal + ' van 5 stappen klaar.</b> ';
    html += sm.resterend === 0 ? 'Je voorstel staat klaar.' : 'Volgende: ' + esc(ROUTE[sm.eersteOpen].titel.toLowerCase()) + '.';
    html += '</span>';
    html += sm.resterend === 0
      ? '<span class="linkish" data-act="set-tab" data-tab="rapport">Naar het rapport</span>'
      : '<span class="linkish" data-act="set-tab" data-tab="home">Naar het Overzicht</span>';
    return html + '</div>';
  }

  function renderHome() {
    var m = overzichtModel();
    var sm = stappenModel();
    var nu = sm.stappen[sm.eersteOpen];
    var volgende = m.plan.slice(0, 5);

    var html = '<div class="ov-page"><div class="ov">';

    // De route: het hoofdmoment van het Overzicht.
    html += '<h1 class="ov-route-kop">' + stappenKop(sm) + '</h1>';
    html += '<p class="ov-route-lede">' + (sm.resterend === 0
      ? 'Alles is ingevuld. Bekijk het voorstel en neem het mee naar de vergadering.'
      : 'Loop de stappen van links naar rechts. Wat klaar is blijft bewaard.') + '</p>';
    html += '<section class="ov-route" aria-label="Jouw route naar het voorstel"><div class="ov-route-main">';
    html += '<div class="ov-route-prog"><b>' + sm.klaarAantal + ' van 5</b><span>stappen klaar</span></div>';
    html += '<ol class="ov-track">';
    ROUTE_KORT.forEach(function (naam, i) {
      var st = sm.stappen[i];
      html += '<li class="' + (st.klaar ? 'done' : (i === sm.eersteOpen ? 'now' : '')) + '"><span class="d" aria-hidden="true">' + (st.klaar ? CHOICE_ICONS.check : (i + 1)) + '</span><span class="lbl">' + naam + (st.klaar ? '<span class="sr-only"> (klaar)</span>' : '') + '</span></li>';
    });
    html += '</ol>';
    html += '<div class="ov-now"><div><div class="ov-now-k">Nu aan de beurt</div><h2 class="ov-now-h">' + esc(nu.vraag) + '</h2><p class="ov-now-p">' + esc(nu.tekst) + '</p></div>';
    if (nu.actie) html += '<button type="button" class="ov-btn ov-now-btn"' + actieAttrs(nu.actie) + '>' + nu.actie[1] + '</button>';
    html += '</div></div>';
    html += '<div class="ov-route-art" aria-hidden="true">' + gebouwNachtSvg(sm) + '</div></section>';

    html += '<div class="ov-grid-main">';

    html += '<div class="ov-area-verdict" id="ov-verdict">' + ovVerdictHtml(m, false, 'h2') + '</div>';

    html += '<section class="ov-card ov-area-chart" aria-labelledby="ov-chart-title">';
    html += '<div class="ov-card-head"><div><h2 class="ov-h2" id="ov-chart-title">Saldo van het reservefonds</h2>';
    html += '<p class="ov-sub">Aan het einde van elk jaar, bij de ingestelde bijdrage</p></div>';
    if (m.saldoBekend) html += '<div class="ov-key"><span class="k-pos"></span>Saldo positief<span class="k-neg"></span>Fonds is leeg</div>';
    html += '</div>';
    html += '<div class="ov-chart" id="ov-chart">' + ovChartHtml(m) + '</div>';
    html += '</section>';

    html += '<section class="ov-card ov-area-controls" aria-label="Bijdrage en reservefonds">';
    html += '<label class="ov-row" for="bijdrage-num"><span>Bijdrage per appartement per maand</span>';
    html += '<span class="ov-eurinput">€<input id="bijdrage-num" type="text" inputmode="numeric" data-change="bijdrage-bedrag" value="' + state.bijdrage + '" /></span></label>';
    html += '<input id="bijdrage-slider" class="ov-slider" type="range" min="10" max="400" step="5" value="' + state.bijdrage + '" data-change="bijdrage" aria-label="Bijdrage per appartement per maand" />';
    html += '<div class="ov-range"><span>€ 10</span><span>€ 400</span></div>';
    if (!state.invul.bijdrage) html += '<p class="ov-hint">Dit is een startwaarde. Vul in wat de eigenaren nu per maand betalen.</p>';
    html += '<div class="ov-rule"></div>';
    html += '<label class="ov-row" for="fonds-bedrag"><span>Reservefonds nu</span>';
    html += '<span class="ov-eurinput">€<input id="fonds-bedrag" data-bind="fonds-bedrag" inputmode="numeric" placeholder="0" value="' + (state.invul.fonds ? state.fonds : '') + '" /></span></label>';
    html += '<p class="ov-hint">' + (!state.invul.fonds ? 'Nog niet ingevuld. Vul het saldo uit de VvE-administratie in.' : 'Saldo uit de VvE-administratie.') + '</p>';
    html += '<div class="ov-rule"></div>';
    html += '<div class="ov-kv"><span>Onderhoud de komende ' + HORIZON + ' jaar</span><b>' + eur(m.totaal) + '</b></div>';
    html += '<div class="ov-kv" id="ov-low">' + ovLowHtml(m) + '</div>';
    html += '</section>';

    html += '</div>';

    html += '<div class="ov-lower">';
    html += '<section class="ov-card"><h2 class="ov-h2">Eerstvolgende posten</h2>';
    if (volgende.length) {
      html += '<div class="ov-posts">' + volgende.map(function (p) {
        return '<div class="ov-post" data-act="open-element" data-id="' + p.elId + '"><span class="ov-post-y">' + p.jaar + '</span><span class="ov-post-n">' + esc(p.naam) + '</span><b>' + eur(p.bedrag) + '</b></div>';
      }).join('') + '</div>';
      html += '<p class="ov-more"><span class="linkish" data-act="set-tab" data-tab="planning">Alle jaren bekijken</span></p>';
    } else {
      html += '<p class="ov-hint">Er staan de komende ' + HORIZON + ' jaar geen posten gepland. Voeg een post toe via Gebouw.</p>';
    }
    html += '</section>';
    html += '</div>';

    html += '<p class="ov-foot">De bedragen zijn indicatieve richtprijzen (inclusief btw, prijspeil ' + CURRENT_YEAR + '), geen offerte. Hoe vaak onderhoud nodig is volgt uit het bouwjaar in de BAG. Beoordeel je de staat van een post, dan schuift het onderhoud naar voren of naar achteren. Kosten na ' + m.eind + ' tellen niet mee.</p>';
    html += '</div></div>';
    return html;
  }

  // Conditie als woord met kleur (i.p.v. een cijfer 1-6 waarbij hoog "slecht"
  // is): de tekst draagt de betekenis, de kleur is bijzaak.
  function conditiePill(score) {
    var c = scoreColors(score);
    return '<span class="cond-pill" style="background:' + c[0] + ';color:' + c[1] + '">' + (score == null ? 'Nog niet beoordeeld' : CONDITIE_LABELS[score]) + '</span>';
  }

  function needsAssessment(el) { return el.type !== 'custom' && conditionScore(el) == null; }
  function isAssessed(el) { return el.type === 'custom' || conditionScore(el) != null; }

  function scoreColors(score) {
    if (score == null) return ['var(--ink-08)', 'var(--ink-45)'];
    if (score <= 2) return ['var(--good-bg)', 'var(--good-fg)'];
    if (score === 3) return ['var(--warn-bg)', 'var(--warn-fg)'];
    return ['var(--bad-bg)', 'var(--bad-fg)'];
  }

  // Herkomst van een element, voor het "BAG"/"Standaardcyclus"/"Aangepast
  // door jou"-label (vertrouwen/leesbaarheid) — een gebrek of een
  // handmatig gewijzigde hoeveelheid telt als "aangepast", ook al komt de
  // hoeveelheid oorspronkelijk uit de BAG.
  function elementOrigin(el) {
    var b = state.building;
    if (el.type === 'custom') return { label: 'Aangepast door jou', cls: 'aangepast' };
    if (el.gebreken && el.gebreken.length) return { label: 'Aangepast door jou', cls: 'aangepast' };
    if (el.type === 'kozijnen') {
      if (el.koz.some(function (k) { return k.eigenTarief != null; })) return { label: 'Aangepast door jou', cls: 'aangepast' };
      return b.isVoorbeeld ? { label: 'Voorbeeld', cls: 'voorbeeld' } : { label: 'BAG', cls: 'bag' };
    }
    if (el.bron) {
      if (el.hoeveelheid !== bronWaarde(el.bron, b)) return { label: 'Aangepast door jou', cls: 'aangepast' };
      return b.isVoorbeeld ? { label: 'Voorbeeld', cls: 'voorbeeld' } : { label: 'BAG', cls: 'bag' };
    }
    return { label: 'Standaardcyclus', cls: 'standaard' };
  }

  // Zelfde idee als elementOrigin() maar dan voor het aantal-appartementen-
  // veld op Gebouw — unitsBron ontbreekt bij plannen die vóór deze functie
  // zijn opgeslagen of via CSV zijn geïmporteerd; dan geen claim doen.
  function unitsOrigin() {
    var b = state.building;
    if (b.unitsBron == null) return null;
    if (b.units !== b.unitsBron) return { label: 'Aangepast door jou', cls: 'aangepast' };
    return b.isVoorbeeld ? { label: 'Voorbeeld', cls: 'voorbeeld' } : { label: 'BAG', cls: 'bag' };
  }

  // ---------------------------------------------------------------------
  // Schematisch gebouw: een vooraanzicht op basis van de echte gegevens
  // (werkhoogte -> aantal verdiepingen, appartementen -> aantal ramen per
  // laag). Vijf aanklikbare onderdelen die overeenkomen met de categorieën
  // van de posten. opties: id (uniek per pagina), units, hoogte, status
  // (categorie -> conditiescore of null), actief (gekozen categorie),
  // aanwezig (categorie -> bool), klikbaar.
  // ---------------------------------------------------------------------
  function statusKlasse(score) {
    if (score == null) return '';
    return score <= 2 ? ' st-good' : score === 3 ? ' st-warn' : ' st-bad';
  }

  function gebouwSvg(o) {
    var verd = clamp(Math.round((o.hoogte || 9) / 3), 2, 5);
    var vh = verd <= 3 ? 58 : verd === 4 ? 48 : 40;
    var body = verd * vh;
    var roofTop = 268 - body - 16;
    var wallTop = roofTop + 16;
    var cx = 180;
    var kolommen = Math.max(1, o.units) / verd > 3 ? 5 : 3;
    var centers = kolommen === 5 ? [78, 129, 180, 231, 282] : [95, 180, 265];
    var ww = kolommen === 5 ? 28 : 34;
    var st = o.status || {};
    var aanw = o.aanwezig || {};
    function deel(cat, naam) {
      var leeg = o.aanwezig && !aanw[cat];
      return '<g class="gb-part gb-' + naam + statusKlasse(st[cat]) + (o.actief === cat ? ' actief' : '') + (leeg ? ' leeg' : '') + '"' +
        (o.klikbaar && !leeg ? ' data-gb-filter="' + cat + '"' : '') + '>';
    }
    var s = '<svg class="gb-svg' + (o.klikbaar ? ' klikbaar' : '') + (o.actief && o.actief !== 'Alles' ? ' heeft-actief' : '') + '" viewBox="0 0 360 300" role="img" aria-label="Schematische tekening van het gebouw met de onderdelen dak, gevel, installaties, binnen en terrein">';
    s += '<defs><pattern id="' + o.id + '-brick" width="18" height="10" patternUnits="userSpaceOnUse"><path d="M0 .5H18M0 5.5H18M9 .5V5.5M0 5.5V10.5" style="stroke:var(--copper);stroke-opacity:.3;fill:none;stroke-width:1"/></pattern></defs>';

    // Terrein
    s += deel('Terrein', 'terrein');
    s += '<rect class="gb-shape" x="0" y="268" width="360" height="32"/>';
    s += '<path class="gb-pad" d="M' + (cx - 12) + ' 268h24l12 32h-48z"/>';
    s += '<circle class="gb-groen" cx="22" cy="266" r="15"/><circle class="gb-groen" cx="340" cy="264" r="17"/>';
    s += '</g>';

    // Gevel: muur + ramen
    s += deel('Gevel', 'gevel');
    s += '<rect class="gb-shape gb-wall" x="50" y="' + wallTop + '" width="260" height="' + body + '"/>';
    s += '<rect x="50" y="' + wallTop + '" width="260" height="' + body + '" fill="url(#' + o.id + '-brick)" style="pointer-events:none"/>';
    for (var f = 0; f < verd; f++) {
      var wy = wallTop + f * vh + (vh - 28) / 2;
      centers.forEach(function (c, ci) {
        if (c === cx) return;
        s += '<rect class="gb-window" x="' + (c - ww / 2) + '" y="' + wy + '" width="' + ww + '" height="28" rx="1.5"/>';
        s += '<path class="gb-mullion" d="M' + c + ' ' + wy + 'v28M' + (c - ww / 2) + ' ' + (wy + 14) + 'h' + ww + '"/>';
      });
    }
    s += '</g>';

    // Binnen: entree en trappenhuis
    s += deel('Binnen', 'binnen');
    s += '<rect class="gb-shape gb-trap" x="' + (cx - 10) + '" y="' + (wallTop + 10) + '" width="20" height="' + Math.max(20, (verd - 1) * vh - 12) + '" rx="1.5"/>';
    for (var t = 1; t < verd - 1; t++) s += '<path class="gb-mullion" d="M' + (cx - 10) + ' ' + (wallTop + 10 + t * vh - 6) + 'h20"/>';
    s += '<rect class="gb-shape gb-deur" x="' + (cx - 16) + '" y="224" width="32" height="44" rx="1.5"/>';
    s += '<rect class="gb-luifel" x="' + (cx - 26) + '" y="216" width="52" height="5" rx="1"/>';
    s += '</g>';

    // Dak
    s += deel('Dak', 'dak');
    s += '<rect class="gb-shape gb-plaat" x="44" y="' + roofTop + '" width="272" height="16" rx="2"/>';
    s += '</g>';

    // Installaties op het dak
    s += deel('Installaties', 'inst');
    s += '<rect class="gb-shape" x="214" y="' + (roofTop - 24) + '" width="38" height="24" rx="2"/>';
    s += '<rect class="gb-shape" x="224" y="' + (roofTop - 42) + '" width="7" height="18"/>';
    s += '<rect class="gb-shape" x="266" y="' + (roofTop - 14) + '" width="24" height="14" rx="2"/>';
    s += '</g>';

    s += '</svg>';
    return s;
  }

  // Slechtste (hoogste) conditiescore per categorie; null zolang er in die
  // categorie niets beoordeeld is.
  function statusPerCategorie() {
    var st = {};
    state.elements.forEach(function (el) {
      var sc = conditionScore(el);
      if (sc == null) return;
      st[el.categorie] = Math.max(st[el.categorie] || 0, sc);
    });
    return st;
  }

  function renderGebouw() {
    if (state.activeElementId) return renderElementDetail(state.activeElementId);
    var b = state.building;
    // Alleen categorieën tonen die ook echt elementen bevatten — een lege
    // chip levert altijd een lege lijst op en voegt niets toe.
    var aanwezigeCats = {};
    state.elements.forEach(function (el) { aanwezigeCats[el.categorie] = true; });
    var cats = ['Alles'].concat(['Dak', 'Gevel', 'Installaties', 'Binnen', 'Terrein', 'Overig'].filter(function (c) { return aanwezigeCats[c]; }));
    var els = state.elements.filter(function (el) { return state.filter === 'Alles' || el.categorie === state.filter; });
    var metGebrekenCount = state.elements.filter(function (el) { return el.gebreken.length > 0; }).length;
    if (state.gebrekenFilter) els = els.filter(function (el) { return el.gebreken.length > 0; });

    var html = pgOpen(true, true);
    html += '<div class="pg-head">';
    html += '<h1 class="page-title">Gebouw</h1>';
    // Aantal appartementen komt uit de BAG maar klopt niet altijd (bv. bij
    // een pand dat als één verblijfsobject geregistreerd staat) — daarom
    // hier bewerkbaar, met dezelfde zichtbare invoerstijl als de velden
    // op de elementdetailpagina (zie .inline-num in style.css), i.p.v.
    // de eerdere gestippelde onderstreping die niet als invoerveld oogde.
    var uOrigin = unitsOrigin();
    html += '<div class="page-sub">' + esc(b.adres) + ' · bouwjaar ' + (b.bouwjaar || 'onbekend') + ' · ';
    html += '<input id="building-units" data-bind="building-units" type="number" min="1" inputmode="numeric" value="' + b.units + '" class="inline-num" /> ';
    html += meervoud(b.units, 'appartement', 'appartementen') + (uOrigin ? ' <span class="origin-tag origin-' + uOrigin.cls + '">' + uOrigin.label + '</span>' : '') + ' · ' + state.elements.length + ' posten</div>';
    html += '<p class="pg-intro">Dit zijn de onderdelen van het gebouw waar onderhoud voor nodig is. Open een post om de staat te beoordelen of de kosten aan te passen.</p>';
    html += '</div>';

    var tekening = gebouwSvg({
      id: 'gb', units: b.units, hoogte: b.werkhoogte, status: statusPerCategorie(), actief: state.filter,
      aanwezig: aanwezigeCats, klikbaar: true,
    });
    html += '<div class="gb-layout"><aside class="ov-card gb-aside" aria-label="Onderdelen van het gebouw">' + tekening;
    html += '<p class="gb-caption">Klik op een onderdeel om alleen die posten te zien. De kleur laat de staat zien: groen is goed, geel redelijk, rood matig of slecht. Onbeoordeelde onderdelen blijven neutraal.</p></aside><div class="gb-main">';
    html += '<div class="section"><div class="chip-row">';
    cats.forEach(function (c) {
      html += '<div class="chip' + (state.filter === c ? ' active' : '') + '" data-act="set-filter" data-filter="' + c + '">' + c + '</div>';
    });
    if (metGebrekenCount) {
      html += '<div class="chip chip-gebreken' + (state.gebrekenFilter ? ' active' : '') + '" data-act="toggle-gebreken-filter">Met gebreken (' + metGebrekenCount + ')</div>';
    }
    html += '</div></div>';

    html += '<div class="section"><div class="card">';
    if (!els.length) {
      html += '<div class="row" style="border-top:none"><div class="grow meta" style="font-size:12.5px">Geen posten in deze weergave.</div></div>';
    }
    els.forEach(function (el, i) {
      var bedrag = eur(elementCost(el, state));
      var score = conditionScore(el);
      html += '<div class="row" data-act="open-element" data-id="' + el.id + '" style="cursor:pointer' + (i === 0 ? ';border-top:none' : '') + '">';
      html += '<div class="grow"><div class="name">' + esc(el.naam) + '</div><div class="meta">' + conditiePill(score) + elementRowMeta(el) + '</div></div>';
      html += '<div class="value">' + bedrag + '<div class="value-sub">per keer</div></div>';
      html += '<div class="chev">›</div></div>';
    });
    html += '</div>';
    html += '<div class="add-el" data-act="open-add-element"><div class="plus">+</div><div><div class="title">Post toevoegen</div><div class="sub">Bijv. balkons, hekwerk, liftinstallatie</div></div></div>';
    html += '</div>';

    if (state.addForm) html += renderAddElementForm();

    html += '</div></div>';
    html += PG_CLOSE;
    return html;
  }

  // Regel-tekst in de Gebouw-lijst: het volgende jaar en de cyclus, i.p.v.
  // de rekenformule (die staat nu op de detailpagina, zie renderHoeveelheidKengetal()/renderSteiger()).
  function elementRowMeta(el) {
    if (el.type === 'custom') return elementMeta(el);
    if (el.type === 'kozijnen') {
      var score = conditionScore(el);
      var jaren = kozGroepen(el).map(function (g) { return yearForCycle(g.cyclus, el.laatsteBeurt, score); });
      return 'Volgt in ' + Math.min.apply(null, jaren);
    }
    return 'Volgt in ' + conditionYear(el) + ' · elke ' + el.cyclus + ' jaar';
  }

  function renderAddElementForm() {
    var f = state.addForm;
    var aanwezig = {};
    state.elements.forEach(function (el) { aanwezig[el.id] = true; });
    var beschikbaar = ELEMENT_LIBRARY.filter(function (d) { return d.optioneel && !aanwezig[d.key]; });
    var aanbevolen = beschikbaar.filter(function (d) { return d.aanbevolen; });
    var overig = beschikbaar.filter(function (d) { return !d.aanbevolen; });

    var libraryRow = function (d, i) {
      var row = '<div class="row" data-act="add-from-library" data-key="' + d.key + '" style="cursor:pointer' + (i === 0 ? ';border-top:none' : '') + '">';
      row += '<div class="grow"><div class="name">' + esc(d.naam) + '</div><div class="meta">' + esc(d.categorie) + ' · elke ' + d.cyclus + ' jaar</div></div>';
      row += '<div class="chev" style="color:var(--blue)">+</div></div>';
      return row;
    };

    var html = '';
    if (aanbevolen.length) {
      html += '<div class="section"><div class="section-title">Vaak vergeten in een onderhoudsplan</div>';
      html += '<div class="hint" style="padding:0 4px 9px">Deze posten komen bij de meeste VvE’s voor, maar staan niet standaard in het plan.</div>';
      html += '<div class="card">';
      aanbevolen.forEach(function (d, i) { html += libraryRow(d, i); });
      html += '</div></div>';
    }

    html += '<div class="section"><div class="section-title">Meer posten om toe te voegen</div>';
    html += '<div class="card" style="margin-top:11px">';
    if (!overig.length) {
      html += '<div class="row" style="border-top:none"><div class="grow meta" style="font-size:12.5px">Alle andere standaardposten staan al in het plan.</div></div>';
    }
    overig.forEach(function (d, i) { html += libraryRow(d, i); });
    html += '</div></div>';

    html += '<div class="section"><div class="card pad">';
    html += '<div style="font:500 13.5px/1.35 var(--sans)">Of leg een eigen post vast</div>';
    html += '<div class="input-row" style="margin-top:11px"><div class="label">Naam</div><input id="add-el-naam" data-bind="add-el-naam" value="' + esc(f.naam) + '" style="width:170px;text-align:left" /></div>';
    html += '<div class="input-row"><div class="label">Jaar</div><input id="add-el-jaar" data-bind="add-el-jaar" value="' + f.jaar + '" /></div>';
    html += '<div class="input-row"><div class="label">Bedrag</div><input id="add-el-bedrag" data-bind="add-el-bedrag" value="' + f.bedrag + '" class="wide" /></div>';
    html += '<div class="input-row"><div class="label">Herhaling in jaren (leeg laten = eenmalig)</div><input id="add-el-cyclus" data-bind="add-el-cyclus" value="' + (f.cyclus || '') + '" /></div>';
    html += '<div class="btn-row"><div class="primary-btn" data-act="save-add-element">Toevoegen</div><div class="ghost-btn" data-act="cancel-add-element">Annuleer</div></div>';
    html += '</div></div>';
    return html;
  }

  function renderElementDetail(id) {
    var el = state.elements.filter(function (e) { return e.id === id; })[0];
    if (!el) { state.activeElementId = null; return renderGebouw(); }
    var jaar = conditionYear(el);
    var bedrag = elementCost(el, state);
    var score = conditionScore(el);
    var colors = scoreColors(score);

    var html = pgOpen(true, true);
    html += '<div class="top-nav"><div class="back-link" data-act="close-element">‹ Gebouw</div></div>';
    html += '<div class="pg-head">';
    html += '<div class="eyebrow">' + esc(el.categorie) + (el.cyclus ? ' · elke ' + el.cyclus + ' jaar' : ' · eenmalig') + '</div>';
    html += '<h1 class="page-title">' + esc(el.naam) + '</h1>';
    html += '</div>';

    // Samenvatting bovenaan i.p.v. onderaan — dit is de eerste vraag die
    // iemand heeft bij het openen van een element (wanneer, hoeveel,
    // hoe erg), dus meteen zichtbaar zonder eerst de invoervelden en
    // gebreken-lijst te hoeven passeren.
    html += '<div class="section"><div class="card pad">';
    html += '<div class="kv"><div class="label">Volgend onderhoud</div><div class="amount" style="font-size:19px">' + jaar + '</div></div>';
    html += '<div class="divider"></div>';
    html += '<div class="kv strong"><div class="label">Verwachte kosten</div><div class="amount">' + eur(bedrag) + '</div></div>';
    html += '<div class="divider"></div>';
    html += '<div class="kv" style="align-items:center"><div class="label">Staat</div>' + conditiePill(score) + '</div>';
    html += '<div class="divider"></div>';
    var origin = elementOrigin(el);
    html += '<div class="kv" style="align-items:center"><div class="label">Bron van de cijfers</div><div class="origin-tag origin-' + origin.cls + '">' + origin.label + '</div></div>';
    if (el.sfb) html += '<details class="ov-details"><summary>Technische details</summary><p>NL-SfB-code ' + esc(el.sfb) + '. Dat is de Nederlandse indeling van bouwdelen; die code staat ook in de csv-export.</p></details>';
    html += '</div></div>';

    if (el.type === 'kozijnen') html += renderKozijnen(el);
    if (el.type === 'dak' || el.type === 'gevel' || el.type === 'per-unit') html += renderHoeveelheidKengetal(el);
    if (el.type === 'steiger') html += renderSteiger(el);
    if (el.type === 'custom') html += renderCustomBewerken(el);
    html += renderGebreken(el);
    html += renderOffertes(el);

    html += PG_CLOSE;
    return html;
  }

  function renderCustomBewerken(el) {
    var prijspeil = el.basisjaar != null ? el.basisjaar : CURRENT_YEAR;
    var html = '<div class="section"><div class="section-title">Post bewerken</div>';
    html += '<div class="card pad" style="margin-top:11px">';
    html += '<div class="input-row" style="margin-top:0"><div class="label">Jaar</div><input id="cb-jaar-' + el.id + '" data-bind="el-jaar" data-id="' + el.id + '" value="' + el.jaar + '" /></div>';
    html += '<div class="input-row"><div class="label">Cyclus (jaar, 0 = eenmalig)</div><input id="cb-cyclus-' + el.id + '" data-bind="el-cyclus" data-id="' + el.id + '" value="' + (el.cyclus || 0) + '" /></div>';
    html += '<div class="input-row"><div class="label">Bedrag</div><input id="cb-bedrag-' + el.id + '" data-bind="el-bedrag" data-id="' + el.id + '" value="' + el.bedrag + '" /></div>';
    html += '<div class="input-row"><div class="label">Prijspeil van dit bedrag</div><input id="cb-basisjaar-' + el.id + '" data-bind="el-basisjaar" data-id="' + el.id + '" value="' + prijspeil + '" /></div>';
    html += '<div class="hint">Heb je inmiddels een offerte met een actueel bedrag? Vul dat bedrag in en zet het prijspeil op ' + CURRENT_YEAR + ', dan wordt het niet meer extra geïndexeerd.</div>';
    html += '</div></div>';
    return html;
  }

  function renderGebreken(el) {
    var suggesties = GEBREK_SUGGESTIES[el.categorie] || GEBREK_SUGGESTIES.Overig;
    var score = conditionScore(el);
    var html = '<div class="section"><div class="section-title">Staat van onderhoud</div>';

    if (!el.gebreken.length) {
      // Eén samengevoegd beoordelingsblok i.p.v. twee losse "nog niets"-
      // meldingen (een lege rij in de lijst + een aparte result-box
      // eronder) — die zeiden allebei hetzelfde over dezelfde situatie.
      html += '<div class="card pad" style="margin-top:11px;text-align:center">';
      html += '<div style="font:700 15px/1.3 var(--heading)">Nog niet beoordeeld</div>';
      html += '<div class="hint" style="margin-top:7px">Noteer wat je ziet, bijvoorbeeld lekkage of houtrot. De app schat daarmee wanneer vervanging echt nodig is. Tot die tijd rekent het plan met de gebruikelijke levensduur vanaf het bouwjaar.</div>';
      html += '<div class="primary-btn" style="margin-top:14px" data-act="gb-add" data-id="' + el.id + '">Gebrek toevoegen</div>';
      html += '</div></div>';
      return html;
    }

    html += '<div class="card" style="margin-top:11px">';
    el.gebreken.forEach(function (g, gi) {
      html += '<div class="row" style="align-items:flex-start' + (gi === 0 ? ';border-top:none' : '') + '">';
      html += '<div class="grow">';
      html += '<input id="gb-naam-' + el.id + '-' + gi + '" data-bind="gb-naam" data-id="' + el.id + '" data-gi="' + gi + '" value="' + esc(g.omschrijving) + '" list="gb-sug-' + el.id + '" style="width:100%;box-sizing:border-box;border:1px solid var(--ink-14);border-radius:8px;padding:6px 8px;font:500 14px var(--sans)" placeholder="Beschrijf wat je ziet, bijv. lekkage" />';
      [['ernst', 'Ernst'], ['omvang', 'Omvang'], ['intensiteit', 'Intensiteit']].forEach(function (dd) {
        var dim = dd[0];
        html += '<div style="display:flex;align-items:center;gap:8px;margin-top:8px">';
        html += '<div style="width:88px;font:400 13px/1.3 var(--sans);color:var(--ink-60);">' + dd[1] + '</div>';
        html += '<div class="seg" style="margin-top:0;flex:1">';
        [1, 2, 3].forEach(function (v) {
          html += '<div class="seg-opt' + (g[dim] === v ? ' active' : '') + '" style="padding:7px 0" data-act="gb-set" data-id="' + el.id + '" data-gi="' + gi + '" data-dim="' + dim + '" data-val="' + v + '">' + v + '</div>';
        });
        html += '</div></div>';
      });
      html += '</div>';
      html += '<div class="linkish" style="margin-top:2px;font-size:13px" data-act="gb-del" data-id="' + el.id + '" data-gi="' + gi + '">verwijder</div>';
      html += '</div>';
    });
    html += '<div class="hint" style="padding:0 20px 14px">Geef elk onderdeel een cijfer: 1 = licht, 2 = matig, 3 = zwaar. Het zwaarste gebrek bepaalt de staat van de post.</div>';
    html += '<datalist id="gb-sug-' + el.id + '">' + suggesties.map(function (s) { return '<option value="' + esc(s) + '">'; }).join('') + '</datalist>';
    html += '<div class="row" style="cursor:pointer" data-act="gb-add" data-id="' + el.id + '"><div class="grow" style="font:500 13px var(--sans);color:var(--blue)">+ Gebrek toevoegen</div></div>';
    html += '</div>';

    html += '<div class="result-box' + (score >= 4 ? ' bad' : ' good') + '">';
    html += '<div class="label">Staat van deze post</div>';
    html += '<div class="head">' + CONDITIE_LABELS[score] + '</div>';
    html += '<div class="body">Het zwaarste gebrek bepaalt de staat. Dit is een hulpmiddel voor de planning (gebaseerd op de NEN 2767-methodiek) en geen vervanging van een inspectie door een gecertificeerd inspecteur.</div>';
    html += '</div></div>';
    return html;
  }

  function renderHoeveelheidKengetal(el) {
    var isPerUnit = el.type === 'per-unit';
    var label = isPerUnit ? 'Aantal units' : 'Oppervlak in m²';
    var eenheid = isPerUnit ? meervoud(el.hoeveelheid, 'unit', 'units') : 'm²';
    var html = '<div class="section"><div class="card pad">';
    html += '<div class="input-row" style="margin-top:0"><div class="label">' + label + '</div><input id="hv-' + el.id + '" data-bind="el-hoeveelheid" data-id="' + el.id + '" value="' + el.hoeveelheid + '" /></div>';
    html += '<div class="input-row"><div class="label">Prijs per ' + (isPerUnit ? 'unit' : 'm²') + '</div><input id="kg-' + el.id + '" data-bind="el-kengetal" data-id="' + el.id + '" value="' + el.kengetal + '" /></div>';
    // De rekenformule stond eerder in de Gebouw-lijst (bv. "11 m² × € 165")
    // — die is verplaatst naar hier, de detailpagina, samen met het resultaat.
    html += '<div class="formula">' + el.hoeveelheid + ' ' + eenheid + ' × ' + eur(el.kengetal) + ' = ' + eur(elementCost(el, state)) + ' per keer</div>';
    if (el.type === 'dak' && !state.building.isVoorbeeld) {
      html += '<div class="hint">Dakoppervlak komt uit de 3D BAG (echt dakvlak, plat + schuin). Pas het aan als een offerte of opname iets anders laat zien.</div>';
    }
    html += '</div></div>';
    return html;
  }

  function renderSteiger(el) {
    var rate = el.werkhoogte > 8 ? 11 : 6;
    var html = '<div class="section"><div class="card pad">';
    html += '<div class="input-row" style="margin-top:0"><div class="label">Buitenmuur in m²</div><input id="hv-' + el.id + '" data-bind="el-hoeveelheid" data-id="' + el.id + '" value="' + el.hoeveelheid + '" /></div>';
    html += '<div class="input-row"><div class="label">Werkhoogte in m</div><input id="wh-' + el.id + '" data-bind="el-werkhoogte" data-id="' + el.id + '" value="' + el.werkhoogte + '" /></div>';
    html += '<div class="formula">' + el.hoeveelheid + ' m² × ' + eur(rate) + ' = ' + eur(elementCost(el, state)) + ' per keer</div>';
    html += '<div class="hint">' + (el.werkhoogte > 8
      ? 'Boven 8 meter rekent de app met een hoogwerker of rolsteiger: € 11 per m² gevel.'
      : 'Tot 8 meter kan het met een lichte steiger: € 6 per m² gevel.') + '</div>';
    html += '</div></div>';
    return html;
  }

  function renderKozijnen(el) {
    var html = '<div class="section"><div class="koz-table">';
    html += '<div class="koz-head"><div class="c1">Type</div><div class="c1b">Materiaal</div><div class="c2">Aantal</div><div class="c3">Tarief</div><div class="c4">Bedrag</div></div>';
    el.koz.forEach(function (k, i) {
      var tarief = kozTarief(k);
      var mat = KOZ_MATERIAAL[k.materiaal] || KOZ_MATERIAAL.hout;
      html += '<div class="koz-row">';
      html += '<div class="c1">' + esc(k.naam) + '</div>';
      html += '<div class="c1b"><select data-change="koz-materiaal" data-id="' + el.id + '" data-i="' + i + '">';
      Object.keys(KOZ_MATERIAAL).forEach(function (mk) {
        html += '<option value="' + mk + '"' + (k.materiaal === mk ? ' selected' : '') + '>' + KOZ_MATERIAAL[mk].label + '</option>';
      });
      html += '</select></div>';
      html += '<div class="c2"><button data-act="koz-min" data-id="' + el.id + '" data-i="' + i + '">−</button><span class="val">' + k.aantal + '</span><button data-act="koz-plus" data-id="' + el.id + '" data-i="' + i + '">+</button></div>';
      html += '<div class="c3"><input id="koz-tarief-' + el.id + '-' + i + '" data-bind="koz-tarief" data-id="' + el.id + '" data-i="' + i + '" value="' + tarief + '" />';
      html += '<div class="hint">' + mat.label + ' · ' + mat.cyclus + 'j cyclus</div></div>';
      html += '<div class="c4">' + eur(k.aantal * tarief) + '</div>';
      html += '</div>';
    });
    var totaalAantal = el.koz.reduce(function (a, k) { return a + k.aantal; }, 0);
    html += '<div class="koz-total"><div class="label">Onderhoud kozijnen</div><div class="count">' + totaalAantal + ' kozijnen</div><div class="amount">' + eur(elementCost(el, state)) + '</div></div>';
    html += '</div>';
    html += '<div class="info-block">Het materiaal bepaalt de onderhoudscyclus: hout vraagt periodiek schilderwerk, aluminium en kunststof vooral reiniging en afstellen. Kozijnen met verschillend materiaal worden apart in de tijd gezet. Tarieven zijn direct aanpasbaar; een offerte overschrijft het tarief.</div>';
    html += '</div>';
    return html;
  }

  // --- Offertes (manual entry + compare) ---------------------------------
  function renderOffertes(el) {
    var offs = state.offertes[el.id] || [];
    var bijvul = !!state.bijvullen[el.id];
    var html = '<div class="section"><div class="section-title">Offertes</div>';
    html += '<div class="card" style="margin-top:11px">';
    if (!offs.length) {
      html += '<div class="row" style="border-top:none"><div class="grow meta" style="font-size:12.5px">Nog geen offertes toegevoegd voor deze post.</div></div>';
    }
    offs.forEach(function (o, oi) {
      var totaal = o.regels.reduce(function (a, r) { return a + num(r.bedrag); }, 0);
      if (o.btw) totaal = totaal * 1.21;
      html += '<div class="row" style="align-items:flex-start' + (oi === 0 ? ';border-top:none' : '') + '">';
      html += '<div class="grow">';
      html += '<div class="name" style="font-weight:500">' + esc(o.naam) + '</div>';
      o.regels.forEach(function (r, ri) {
        html += '<div style="display:flex;gap:8px;margin-top:6px">';
        html += '<input id="of-' + o.id + '-naam-' + ri + '" data-bind="of-regel-naam" data-oid="' + o.id + '" data-ri="' + ri + '" value="' + esc(r.naam) + '" style="flex:1;border:1px solid var(--ink-14);border-radius:8px;padding:5px 7px;font:400 13px var(--sans)" placeholder="regel" />';
        html += '<input id="of-' + o.id + '-bedrag-' + ri + '" data-bind="of-regel-bedrag" data-oid="' + o.id + '" data-ri="' + ri + '" value="' + esc(r.bedrag) + '" style="width:80px;border:1px solid var(--ink-14);border-radius:8px;padding:5px 7px;text-align:right;font:500 13px var(--sans)" placeholder="€" />';
        html += '<button data-act="of-del-regel" data-oid="' + o.id + '" data-ri="' + ri + '" style="border:none;background:none;color:var(--ink-45);cursor:pointer">×</button>';
        html += '</div>';
      });
      html += '<div style="margin-top:8px" class="linkish" data-act="of-add-regel" data-oid="' + o.id + '">+ regel toevoegen</div>';
      html += '<div class="toggle-row" style="margin-top:9px" data-act="of-toggle-btw" data-oid="' + o.id + '">';
      html += '<div class="grow" style="font:400 13px var(--sans)">' + (o.btw ? 'inclusief 21% btw' : 'exclusief btw') + '</div>';
      html += '<div class="toggle' + (o.btw ? ' on' : '') + '"><div class="knob"></div></div></div>';
      html += '</div>';
      html += '<div style="text-align:right"><div class="value" style="font-size:14px">' + eur(totaal) + '</div>';
      html += '<div class="linkish" style="margin-top:6px;font-size:13px" data-act="of-del" data-oid="' + o.id + '">verwijder</div></div>';
      html += '</div>';
    });
    html += '<div class="row" style="cursor:pointer" data-act="of-add">';
    html += '<div class="grow" style="font:500 13px var(--sans);color:var(--blue)">+ Offerte toevoegen</div></div>';
    html += '</div>';

    if (offs.length >= 2) html += renderOfferteVergelijk(el, offs, bijvul);

    html += '</div>';
    return html;
  }

  function offerteTotal(o) {
    var t = o.regels.reduce(function (a, r) { return a + num(r.bedrag); }, 0);
    return o.btw ? t * 1.21 : t;
  }

  function renderOfferteVergelijk(el, offs, bijvul) {
    var regelNamen = [];
    offs.forEach(function (o) { o.regels.forEach(function (r) { if (r.naam && regelNamen.indexOf(r.naam) < 0) regelNamen.push(r.naam); }); });

    function cellValue(o, naam) {
      var r = o.regels.filter(function (x) { return x.naam === naam; })[0];
      if (r) return num(r.bedrag);
      return null;
    }
    // "kengetal" fallback for a missing line = average of the other quotes' value for that line.
    function fallbackFor(naam, excludeIdx) {
      var vals = [];
      offs.forEach(function (o, i) { if (i !== excludeIdx) { var v = cellValue(o, naam); if (v != null) vals.push(v); } });
      if (!vals.length) return 0;
      return Math.round(vals.reduce(function (a, b) { return a + b; }, 0) / vals.length);
    }

    var totals = offs.map(function (o, oi) {
      var sub = regelNamen.reduce(function (a, naam) {
        var v = cellValue(o, naam);
        if (v == null) v = bijvul ? fallbackFor(naam, oi) : 0;
        return a + v;
      }, 0);
      return o.btw ? sub * 1.21 : sub;
    });
    var orde = totals.map(function (t, i) { return [t, i]; }).sort(function (a, b) { return a[0] - b[0]; }).map(function (x) { return x[1]; });

    var html = '<div class="section"><div class="section-title">Offertes vergelijken</div>';
    html += '<div class="compare-table" style="margin-top:11px">';
    html += '<div class="ct-head"><div class="c1">REGEL</div>';
    offs.forEach(function (o, oi) {
      var rang = orde.indexOf(oi) + 1;
      html += '<div class="ct-head-col"><span class="ct-rang" style="background:' + (rang === 1 ? 'var(--good-bg)' : 'rgba(27,36,48,.06)') + ';color:' + (rang === 1 ? 'var(--good-fg)' : 'var(--ink-50)') + '">#' + rang + '</span><div class="ct-colname">' + esc(o.naam) + '</div></div>';
    });
    html += '</div>';
    regelNamen.forEach(function (naam) {
      html += '<div class="ct-row"><div class="c1">' + esc(naam) + '</div>';
      offs.forEach(function (o, oi) {
        var v = cellValue(o, naam);
        var missing = v == null;
        var shown = missing ? (bijvul ? fallbackFor(naam, oi) : null) : v;
        html += '<div class="ct-cell" style="background:' + (missing && bijvul ? 'var(--warn-bg)' : 'transparent') + ';color:' + (missing ? 'var(--warn2-fg)' : 'rgba(27,36,48,.7)') + '">' + (shown == null ? '—' : shown.toLocaleString('nl-NL')) + '</div>';
      });
      html += '</div>';
    });
    html += '<div class="ct-total"><div class="c1">Totaal</div>';
    totals.forEach(function (t) { html += '<div class="amount">' + eur(t) + '</div>'; });
    html += '</div></div>';

    html += '<div class="toggle-row" style="margin-top:12px;background:#fff;border:1px solid var(--ink-10);border-radius:18px;padding:15px 16px" data-act="toggle-bijvullen" data-id="' + el.id + '">';
    html += '<div class="grow" style="font:400 12.5px/1.45 var(--sans)">' + (bijvul ? 'Ontbrekende regels bijgevuld met het gemiddelde van de andere offertes' : 'Alleen wat de aannemers hebben opgeschreven') + '</div>';
    html += '<div class="toggle' + (bijvul ? ' on' : '') + '"><div class="knob"></div></div></div>';
    html += '</div>';
    return html;
  }

  function renderPlanning() {
    var rows = kasstroom(state);
    var plan = fullPlan(state);
    var totaal = rows.reduce(function (a, r) { return a + r.kosten; }, 0);
    var laagste = Math.min.apply(null, rows.map(function (r) { return r.saldo; }));
    var eerste = rows.filter(function (r) { return r.saldo < 0; })[0];

    // Totaal per categorie binnen de horizon — geeft in één oogopslag
    // waar het geld naartoe gaat, naast de jaar-voor-jaar tijdlijn.
    var catTotalen = {};
    state.elements.forEach(function (el) {
      var som = 0;
      scheduleFor(el, state).forEach(function (p) { som += p.bedrag; });
      if (som > 0) catTotalen[el.categorie] = (catTotalen[el.categorie] || 0) + som;
    });
    var catRijen = Object.keys(catTotalen).map(function (c) { return { naam: c, bedrag: catTotalen[c] }; })
      .sort(function (a, b) { return b.bedrag - a.bedrag; });

    // Piekjaar: het jaar met de hoogste kosten binnen de horizon, apart
    // vermeld bij de categorieën zodat ook duidelijk is wannéér het grote
    // geld valt, niet alleen waaraan het wordt uitgegeven.
    var piekjaar = rows.reduce(function (best, r) { return (!best || r.kosten > best.kosten) ? r : best; }, null);
    var piekPosten = piekjaar ? plan.filter(function (p) { return p.jaar === piekjaar.jaar; }) : [];

    var html = pgOpen(false, true);
    html += '<div class="pg-head"><h1 class="page-title">Planning</h1>';
    html += '<div class="page-sub">' + CURRENT_YEAR + ' – ' + (CURRENT_YEAR + HORIZON - 1) + ' · ' + eur(totaal) + ' totaal</div></div>';

    html += '<div class="planning-layout">';

    html += '<div class="planning-side"><div class="section" style="padding-top:14px">';
    html += '<div class="card pad">';
    html += '<div class="kv"><div class="label">Totaal geraamd</div><div class="amount">' + eur(totaal) + '</div></div>';
    html += '<div class="divider"></div>';
    if (!state.invul.fonds) {
      html += '<div class="hint">Vul op het Overzicht het saldo van het reservefonds in om te zien of het fonds toereikend is.</div>';
    } else {
    html += '<div class="kv"><div class="label">Laagste fondsstand</div><div class="amount" style="' + (laagste < 0 ? 'color:var(--bad-fg)' : '') + '">' + (laagste < 0 ? eurSigned(laagste) : eur(laagste)) + '</div></div>';
    html += '<div class="hint"' + (eerste ? ' style="color:var(--bad-fg)"' : '') + '>' + (eerste
      ? 'Bij de huidige bijdrage raakt het fonds in ' + eerste.jaar + ' leeg.'
      : 'Bij de huidige bijdrage blijft het fonds ' + HORIZON + ' jaar positief.') + '</div>';
    }
    html += '</div>';
    if (catRijen.length) {
      html += '<div class="section-title" style="margin-top:16px">Kosten per onderdeel</div>';
      html += '<div class="card" style="margin-top:8px">';
      catRijen.forEach(function (c, i) {
        html += '<div class="row"' + (i === 0 ? ' style="border-top:none"' : '') + '><div class="grow name">' + esc(c.naam) + '</div><div class="value">' + eur(c.bedrag) + '</div></div>';
      });
      html += '</div>';
      if (piekjaar && piekPosten.length) {
        html += '<div class="hint" style="margin-top:8px">Piekjaar ' + piekjaar.jaar + ': ' + piekPosten.length + ' ' + meervoud(piekPosten.length, 'post', 'posten') + ' samen ' + eur(piekjaar.kosten) + '.</div>';
      }
    }
    html += '</div></div>';

    html += '<div class="planning-main"><div class="section timeline" style="padding-top:14px">';
    html += '<div class="timeline-head"><span>Saldo eind van het jaar</span></div>';
    rows.forEach(function (r) {
      var posten = plan.filter(function (p) { return p.jaar === r.jaar; });
      var saldoTxt = r.saldo < 0 ? eurSigned(r.saldo) : eur(r.saldo);
      var saldoStyle = 'color:' + (r.saldo < 0 ? 'var(--bad-fg)' : 'var(--ink-60)') + ';background:' + (r.saldo < 0 ? 'var(--bad-bg)' : 'var(--panel)');
      if (!posten.length) {
        // Lege jaren compacter tonen (dunnere rij) — een reeks rustige
        // jaren hoeft niet evenveel ruimte te vragen als een druk jaar.
        html += '<div class="tl-row tl-row-empty"><div class="tl-year" style="color:' + (r.saldo < 0 ? 'var(--bad-fg)' : 'var(--ink-50)') + '">' + r.jaar + '</div>';
        html += '<div class="tl-dot-col"><div class="tl-dot" style="background:' + (r.saldo < 0 ? 'var(--accent)' : 'var(--ink-14)') + '"></div><div class="tl-line"></div></div>';
        html += '<div class="tl-body"><div class="tl-empty">niets gepland</div></div>';
        html += '<div class="tl-saldo" style="' + saldoStyle + '">' + saldoTxt + '</div></div>';
        return;
      }
      html += '<div class="tl-row"><div class="tl-year" style="color:' + (r.saldo < 0 ? 'var(--bad-fg)' : 'var(--ink-50)') + '">' + r.jaar + '</div>';
      html += '<div class="tl-dot-col"><div class="tl-dot" style="background:' + (r.saldo < 0 ? 'var(--accent)' : 'var(--blue)') + '"></div><div class="tl-line"></div></div>';
      html += '<div class="tl-body">';
      posten.forEach(function (p) {
        html += '<div class="tl-post" data-act="open-element" data-id="' + p.elId + '" style="cursor:pointer"><div class="grow"><div class="name">' + esc(p.naam) + '</div><div class="meta">' + esc(p.meta) + '</div></div><div class="amount">' + eur(p.bedrag) + '</div></div>';
      });
      html += '</div>';
      html += '<div class="tl-saldo" style="' + saldoStyle + '">' + saldoTxt + '</div></div>';
    });
    html += '</div></div>';

    html += '</div>';
    html += '<div class="footer-note">Kosten na ' + (CURRENT_YEAR + HORIZON - 1) + ' vallen buiten deze toets — de simulatie kijkt alleen naar de getoonde ' + HORIZON + ' jaar.</div>';
    html += PG_CLOSE;
    return html;
  }

  function renderRapport() {
    var b = state.building;
    var rows = kasstroom(state);
    var totaal = rows.reduce(function (a, r) { return a + r.kosten; }, 0);
    var beoordeeld = state.elements.filter(isAssessed).length;
    var laagste = Math.min.apply(null, rows.map(function (r) { return r.saldo; }));
    var eerste = rows.filter(function (r) { return r.saldo < 0; })[0];
    var nodig = benodigdeBijdrage(state);

    var html = pgOpen(true, true);
    html += '<div class="pg-head"><h1 class="page-title">Rapport</h1>';
    html += '<div class="page-sub">' + esc(b.adres) + ' · ' + beoordeeld + ' van ' + state.elements.length + ' posten beoordeeld</div></div>';

    html += '<div class="section"><div class="card pad">';
    html += '<div style="font:500 14.5px/1.3 var(--sans)">MJOP ' + CURRENT_YEAR + '–' + (CURRENT_YEAR + HORIZON - 1) + '</div>';
    html += '<div class="hint" style="margin-top:5px">Staat per post, kostenopbouw en het voorstel voor de maandbijdrage.</div>';
    var opsteller = opstellerNaam();
    if (opsteller) html += '<div class="hint" style="margin-top:2px">Opgesteld door: ' + esc(opsteller) + '</div>';
    html += '<div class="btn-row"><div class="primary-btn" data-act="print-rapport">Afdrukken / PDF</div><div class="ghost-btn" data-act="export-csv">Exporteer CSV</div></div>';
    if (!isSubscribed()) {
      html += '<div class="hint">Afdrukken en exporteren zit in het abonnement (€ 19 per maand). <span class="linkish" data-act="naar-abonnement">' + (state.session ? 'Bekijk het abonnement' : 'Log in om te abonneren') + '</span></div>';
    }
    html += '</div></div>';

    if (beoordeeld < state.elements.length) {
      html += '<div class="section"><div class="notice">Indicatie op basis van de gebruikelijke levensduur; ' + beoordeeld + ' van ' + state.elements.length + ' posten beoordeeld.</div></div>';
    }

    if (!state.invul.fonds) {
      html += '<div class="section"><div class="notice">Het voorstel voor de vergadering hangt af van het saldo van het reservefonds. <span class="linkish" data-act="set-tab" data-tab="home">Vul het saldo in op het Overzicht</span>.</div></div>';
    } else {
    html += '<div class="section"><div class="card pad">';
    html += '<div style="font:500 13.5px/1.3 var(--sans)">Voorstel voor de vergadering</div>';
    html += '<div style="display:flex;align-items:baseline;gap:9px;margin-top:10px">';
    html += '<div style="font:500 26px/1 var(--sans);color:var(--blue)">' + eur(eerste ? nodig : state.bijdrage) + '</div>';
    html += '<div style="font:400 12px/1.3 var(--sans);color:var(--ink-60)">per appartement per maand</div></div>';
    html += '<div class="hint">' + (eerste
      ? 'Bij de huidige bijdrage van ' + eur(state.bijdrage) + ' raakt het fonds in ' + eerste.jaar + ' leeg.'
      : 'Bij ' + eur(state.bijdrage) + ' per maand blijft het fonds ' + HORIZON + ' jaar positief, met ' + eur(laagste) + ' als laagste stand.') + '</div>';
    html += '</div></div>';
    }

    html += '<div class="section"><div class="section-title">Alle posten</div><div class="card" style="margin-top:11px">';
    // Op volgende-beurt-jaar gesorteerd — zo staat wat het eerst aan de
    // beurt is bovenaan, i.p.v. de (willekeurige) volgorde waarin
    // elementen ooit zijn aangemaakt.
    var elementenOpJaar = state.elements.slice().sort(function (a, b) { return conditionYear(a) - conditionYear(b); });
    elementenOpJaar.forEach(function (el, i) {
      var score = conditionScore(el);
      html += '<div class="row"' + (i === 0 ? ' style="border-top:none"' : '') + '>';
      html += '<div class="grow"><div class="name">' + esc(el.naam) + '</div><div class="meta">' + conditiePill(score) + 'Volgt in ' + conditionYear(el) + '</div></div>';
      html += '<div class="value">' + eur(elementCost(el, state)) + '</div></div>';
    });
    html += '</div></div>';

    html += '<div class="footer-note">Bronnen: PDOK Locatieserver en BAG (Public Domain Mark 1.0), 3D BAG van de TU Delft (CC BY 4.0). Kengetallen zijn indicatieve richtprijzen, geen offerte.</div>';
    html += PG_CLOSE;
    return html;
  }

  var PRINT_CATS = ['Dak', 'Gevel', 'Installaties', 'Binnen', 'Terrein', 'Overig'];

  // Het afdrukbare/PDF-rapport: een jarenplan-tabel per hoofdgroep met een
  // kostenkolom per jaar, naar het model van een professioneel MJOP-rapport
  // (opbouw/kolommen — niet de huisstijl of tekst van een specifieke
  // aanbieder). Onzichtbaar op het scherm, alleen zichtbaar bij afdrukken/
  // opslaan als pdf (zie .print-report in style.css).
  function renderPrintReport() {
    var b = state.building;
    var jaren = [];
    for (var j = CURRENT_YEAR; j <= CURRENT_YEAR + HORIZON - 1; j++) jaren.push(j);
    var rows = kasstroom(state);
    var totaal = rows.reduce(function (a, r) { return a + r.kosten; }, 0);
    var laagste = Math.min.apply(null, rows.map(function (r) { return r.saldo; }));
    var eerste = rows.filter(function (r) { return r.saldo < 0; })[0];
    var nodig = benodigdeBijdrage(state);
    var vandaag = new Date().toLocaleDateString('nl-NL');
    var cats = PRINT_CATS.filter(function (c) { return state.elements.some(function (el) { return el.categorie === c; }); });

    var html = '<div class="print-report">';

    var opsteller = opstellerNaam();
    html += '<div class="pr-page pr-cover">';
    html += '<div class="pr-eyebrow">Meerjarenonderhoudsplan</div>';
    html += '<h1>' + esc(b.adres) + '</h1>';
    html += '<div class="pr-sub">MJOP ' + CURRENT_YEAR + '–' + (CURRENT_YEAR + HORIZON - 1) + ' · opgesteld met MJOP Live · ' + vandaag + '</div>';
    if (opsteller) html += '<div class="pr-sub">Opgesteld door: ' + esc(opsteller) + '</div>';
    html += '</div>';

    html += '<div class="pr-page">';
    html += '<div class="pr-section-title">Algemene objectgegevens</div>';
    html += '<table class="pr-kv">';
    [
      ['Adres', esc(b.adres)],
      ['Bouwjaar', b.bouwjaar || 'onbekend'],
      ['Aantal appartementen', b.units],
      ['Dakoppervlak', Math.round(b.dakM2 || 0) + ' m²'],
      ['Geveloppervlak', Math.round(b.gevelM2 || 0) + ' m²'],
      ['Werkhoogte', (b.werkhoogte || 0) + ' m'],
      ['Reservefonds nu', eur(state.fonds)],
      ['Bijdrage per appartement/mnd', eur(state.bijdrage)],
      ['Prijspeil', CURRENT_YEAR],
    ].forEach(function (row) {
      html += '<tr><td class="pr-kv-label">' + row[0] + '</td><td>' + row[1] + '</td></tr>';
    });
    html += '</table>';

    html += '<div class="pr-section-title">Conditiescore</div>';
    html += '<table class="pr-legend">';
    [1, 2, 3, 4, 5, 6].forEach(function (s) {
      var colors = scoreColors(s);
      html += '<tr><td><span class="pr-badge" style="background:' + colors[0] + ';color:' + colors[1] + '">' + s + '</span></td><td>' + CONDITIE_LABELS[s] + '</td></tr>';
    });
    html += '</table>';
    html += '<div class="pr-note">Vereenvoudigde, zelf geïmplementeerde toepassing van de NEN 2767-systematiek (ernst/omvang/intensiteit → conditiescore) voor planningsdoeleinden — geen vervanging voor een inspectie door een gecertificeerd inspecteur.</div>';
    var beoordeeldPr = state.elements.filter(isAssessed).length;
    if (beoordeeldPr < state.elements.length) {
      html += '<div class="pr-note">Indicatie op basis van standaardcycli; ' + beoordeeldPr + ' van ' + state.elements.length + ' beoordeeld.</div>';
    }
    html += '</div>';

    // Binnen een categorie op volgende-beurt-jaar gesorteerd, i.p.v. de
    // (willekeurige) aanmaakvolgorde — zowel hier als in het jarenplan
    // hieronder. De categorie-indeling zelf (het model van een
    // professioneel MJOP-rapport) blijft staan.
    function elsInCat(cat) {
      return state.elements.filter(function (el) { return el.categorie === cat; })
        .sort(function (a, b) { return conditionYear(a) - conditionYear(b); });
    }

    html += '<div class="pr-page">';
    html += '<div class="pr-section-title">Elementenoverzicht</div>';
    html += '<table class="pr-table"><thead><tr><th class="pr-c-code">NL-SfB</th><th>Element</th><th class="pr-c-hvh">Hvh/Ehd</th><th class="pr-c-cond">Conditie</th></tr></thead><tbody>';
    cats.forEach(function (cat) {
      html += '<tr class="pr-group"><td colspan="4">' + cat + '</td></tr>';
      elsInCat(cat).forEach(function (el) {
        var score = conditionScore(el);
        var colors = scoreColors(score);
        html += '<tr><td class="pr-c-code">' + (el.sfb ? esc(el.sfb) : '–') + '</td><td>' + esc(el.naam) + '</td>';
        html += '<td class="pr-c-hvh">' + hoeveelheidLabel(el) + '</td>';
        html += '<td class="pr-c-cond"><span class="pr-badge" style="background:' + colors[0] + ';color:' + colors[1] + '">' + (score == null ? '–' : score) + '</span></td></tr>';
      });
    });
    html += '</tbody></table>';
    html += '</div>';

    html += '<div class="pr-page pr-landscape">';
    html += '<div class="pr-section-title">Jarenplan ' + CURRENT_YEAR + '–' + (CURRENT_YEAR + HORIZON - 1) + '</div>';
    html += '<table class="pr-table pr-jaren"><thead><tr><th>Element</th><th class="pr-c-hvh">Hvh/Ehd</th><th class="pr-c-narrow">Stj</th><th class="pr-c-narrow">Cy</th>';
    jaren.forEach(function (y) { html += '<th class="pr-c-year">' + y + '</th>'; });
    html += '<th class="pr-c-year">Totaal</th></tr></thead><tbody>';

    var grandPerYear = {};
    cats.forEach(function (cat) {
      html += '<tr class="pr-group"><td colspan="' + (5 + jaren.length) + '">' + cat + '</td></tr>';
      var catPerYear = {};
      elsInCat(cat).forEach(function (el) {
        var ym = elementYearMap(el, state);
        var sc = stjCyFor(el, state);
        var elTotaal = 0;
        html += '<tr><td>' + esc(el.naam) + '</td><td class="pr-c-hvh">' + hoeveelheidLabel(el) + '</td>';
        html += '<td class="pr-c-narrow">' + sc.stj + '</td><td class="pr-c-narrow">' + sc.cy + '</td>';
        jaren.forEach(function (y) {
          var bedrag = ym[y] || 0;
          elTotaal += bedrag;
          catPerYear[y] = (catPerYear[y] || 0) + bedrag;
          grandPerYear[y] = (grandPerYear[y] || 0) + bedrag;
          html += '<td class="pr-c-year">' + (bedrag ? eur(bedrag) : '–') + '</td>';
        });
        html += '<td class="pr-c-year pr-strong">' + eur(elTotaal) + '</td></tr>';
      });
      var catTotaal = 0;
      html += '<tr class="pr-subtotal"><td colspan="4">Subtotaal ' + cat + '</td>';
      jaren.forEach(function (y) { catTotaal += (catPerYear[y] || 0); html += '<td class="pr-c-year">' + eur(catPerYear[y] || 0) + '</td>'; });
      html += '<td class="pr-c-year">' + eur(catTotaal) + '</td></tr>';
    });
    var grandTotaal = 0;
    html += '<tr class="pr-grandtotal"><td colspan="4">Totaal alle posten</td>';
    jaren.forEach(function (y) { grandTotaal += (grandPerYear[y] || 0); html += '<td class="pr-c-year">' + eur(grandPerYear[y] || 0) + '</td>'; });
    html += '<td class="pr-c-year">' + eur(grandTotaal) + '</td></tr>';
    html += '</tbody></table>';
    html += '</div>';

    html += '<div class="pr-page">';
    html += '<div class="pr-section-title">Voorstel voor de vergadering</div>';
    html += '<div class="pr-proposal">' + eur(eerste ? nodig : state.bijdrage) + ' <span>per appartement per maand</span></div>';
    if (!state.invul.fonds) html += '<div class="pr-note">Het saldo van het reservefonds is niet ingevuld; dit voorstel gaat uit van € 0.</div>';
    html += '<div class="pr-note">' + (eerste
      ? 'Bij de huidige bijdrage van ' + eur(state.bijdrage) + ' raakt het reservefonds in ' + eerste.jaar + ' leeg.'
      : 'Bij ' + eur(state.bijdrage) + ' per maand blijft het reservefonds ' + HORIZON + ' jaar positief, met ' + eur(laagste) + ' als laagste stand.') + '</div>';
    html += '<div class="pr-footer">Bronnen: PDOK Locatieserver en BAG (Public Domain Mark 1.0), 3D BAG van de TU Delft (CC BY 4.0). Kengetallen zijn indicatieve richtprijzen inclusief btw, geen offerte. Bedragen vanaf geïmporteerde posten zijn geïndexeerd met ' + (cbsIndexatie ? cbsIndexatie.pct : Math.round(INDEXATIE_PCT * 1000) / 10) + '% per jaar' + ((cbsIndexatie && state.settings.toonCbsBron) ? ' (CBS-bouwkostenindex ' + cbsIndexatie.periode + ')' : '') + ' vanaf het prijspeil van het brondocument. Afgedrukt op ' + vandaag + ' met MJOP Live.</div>';
    html += '</div>';

    html += '</div>';
    return html;
  }

  // ---------------------------------------------------------------------
  // Actions (click) and Binds (input/change)
  // ---------------------------------------------------------------------
  var searchTimer = null;
  var factuurZoekTimer = null;

  var ACTIONS = {
    // Opent het voorbeeldgebouw; vanuit de homepage en vanuit het adresscherm.
    'open-voorbeeld': function () {
      var vers = !state.elements.length;
      applyBuilding(defaultBuilding());
      if (vers && !state.fonds) state.fonds = state.building.units * VOORBEELD_FONDS_PER_APP;
      if (vers) state.bijdrage = mktDemoBijdrage;
      state.invul = { fonds: true, bijdrage: true };
      render();
    },
    'skip-onboarding': function () { ACTIONS['open-voorbeeld'](); },
    'wijzig-adres': function () {
      state.buildingSwitcherOpen = false;
      state.screen = 'onboarding'; state.onboarding = { q: '', sug: [], bezig: false, bezigTekst: '', fout: '', gezocht: false };
      // Zonder dit zou "opslaan" na het wijzigen van adres het oude
      // opgeslagen plan overschrijven met een hybride van het nieuwe adres
      // en de herschaalde oude elementen (applyBuilding hergebruikt
      // bestaande elementen zolang die er al zijn) — currentPlanId loskoppelen
      // zorgt dat een volgende save in plaats daarvan een nieuw plan aanmaakt.
      state.currentPlanId = null; state.lastSavedSnapshot = null;
      render();
    },
    'save-plan': function () {
      if (!sb || !state.session || !state.building) return;
      // Opslaan van een eigen gebouw is de betaalde functie (zie
      // Instellingen → Abonnement) — zonder actief abonnement sturen we
      // naar dat scherm i.p.v. de aanroep te doen, die RLS-technisch
      // toch zou lukken (opslaan zelf is niet abonnement-afhankelijk in
      // de database) maar product-matig niet de bedoeling is.
      if (!isSubscribed()) { state.tab = 'instellingen'; state.accountSubTab = 'abonnement'; render(); return; }
      performSave();
    },
    'open-plan': function (d) {
      if (!sb || !state.session) return;
      state.buildingSwitcherOpen = false;
      state.plansUi.bezig = true; state.plansUi.fout = '';
      render();
      sb.from('saved_plans').select('id,state').eq('id', d.id).single().then(function (res) {
        state.plansUi.bezig = false;
        if (res.error || !res.data) { state.plansUi.fout = 'Dit plan kon niet geopend worden.'; render(); return; }
        applyPlanBlob(res.data.state);
        state.currentPlanId = res.data.id;
        state.lastSavedSnapshot = JSON.stringify(res.data.state);
        state.screen = 'app'; state.tab = 'home';
        render();
      }).catch(function () {
        state.plansUi.bezig = false; state.plansUi.fout = 'Kon geen verbinding maken. Probeer het opnieuw.'; render();
      });
    },
    'delete-plan-confirm': function (d) { state.confirmDeleteId = d.id; render(); },
    'delete-plan-cancel': function () { state.confirmDeleteId = null; render(); },
    'delete-plan': function (d) {
      if (!sb || !state.session) return;
      state.plansUi.bezig = true; state.plansUi.fout = '';
      render();
      sb.from('saved_plans').delete().eq('id', d.id).then(function (res) {
        state.plansUi.bezig = false;
        state.confirmDeleteId = null;
        if (res.error) { state.plansUi.fout = 'Verwijderen is niet gelukt.'; render(); return; }
        state.savedPlans = state.savedPlans.filter(function (p) { return p.id !== d.id; });
        // Het huidige plan blijft gewoon open in het scherm (geen verlies
        // van in-memory werk) — alleen de koppeling met de zojuist
        // verwijderde rij vervalt, zodat een volgende "Opslaan" een nieuw
        // plan aanmaakt in plaats van de verwijderde rij te proberen bij
        // te werken.
        if (state.currentPlanId === d.id) { state.currentPlanId = null; state.lastSavedSnapshot = null; }
        render();
      }).catch(function () {
        state.plansUi.bezig = false; state.plansUi.fout = 'Kon geen verbinding maken. Probeer het opnieuw.'; render();
      });
    },
    'goto-marketing': function () { state.screen = 'marketing'; render(); },
    // Alleen zichtbaar op de homepage/loginscherm als er al een sessie is
    // — dan is "opnieuw inloggen" niet van toepassing, ga direct terug
    // naar het gebouw dat al in het geheugen staat, of anders (nog geen
    // gebouw gekozen deze sessie) naar het adresscherm.
    'goto-app': function () { state.screen = state.building ? 'app' : 'onboarding'; render(); },
    // renderMijnGebouwen() staat los van state.building, dus dit is veilig
    // vanaf het adresscherm te bereiken vóórdat er deze sessie al een
    // gebouw gekozen is.
    'goto-mijngebouwen': function () { state.screen = 'app'; state.tab = 'mijngebouwen'; render(); },
    'goto-login': function () { state.screen = 'login'; render(); },
    'goto-onboarding': function () { state.screen = 'onboarding'; render(); },
    // Het live-doorzoeken tijdens het typen (BINDS['addr-q']) blijft de
    // eigenlijke weg naartoe; dit is enkel de expliciete knop ernaast die
    // dezelfde zoekopdracht direct uitvoert i.p.v. na de debounce.
    'zoek-adres': function () {
      var s = state.onboarding;
      clearTimeout(searchTimer);
      if (s.q.trim().length < 4) return;
      s.fout = ''; s.gezocht = false;
      render();
      zoekAdres(s.q);
    },
    'kies-adres': function (d) {
      var s = state.onboarding;
      s.sug = []; s.q = d.naam; s.bezig = true; s.bezigTekst = 'Pand opzoeken in de BAG…'; s.fout = '';
      render();
      // Puur cosmetisch: dit tikt alleen de bezigTekst door terwijl
      // lookupBuilding() draait, los van de echte fetch-keten daarbinnen
      // (die blijft ongewijzigd) — het narrateert wat er onder water al
      // gebeurt (PDOK-adres -> BAG-pand -> 3D BAG), zodat het wachten op
      // echte bouwdata voelbaar is in plaats van één stille spinner.
      var stapTimers = [
        setTimeout(function () { if (state.onboarding === s && s.bezig) { s.bezigTekst = 'Bouwjaar en appartementen ophalen uit de BAG…'; render(); } }, 700),
        setTimeout(function () { if (state.onboarding === s && s.bezig) { s.bezigTekst = 'Dakoppervlak, gevels en hoogte berekenen uit de 3D BAG…'; render(); } }, 1800),
      ];
      lookupBuilding(d.id, d.naam).then(function (building) {
        stapTimers.forEach(clearTimeout);
        s.bezig = false;
        applyBuilding(building);
        render();
      }).catch(function (err) {
        stapTimers.forEach(clearTimeout);
        s.bezig = false;
        s.fout = 'Dit adres lukt niet: ' + (err && err.message ? err.message : 'onbekende fout') + '. Probeer een ander huisnummer, of begin met een voorbeeldgebouw.';
        render();
      });
    },
    'set-tab': function (d) {
      state.tab = d.tab; state.activeElementId = null; state.confirmDeleteId = null;
      state.accountMenuOpen = false; state.buildingSwitcherOpen = false;
      // Account en Instellingen zijn dezelfde pagina (zie renderAccount()),
      // alleen met een ander sub-menu-item vooraf geselecteerd, zodat beide
      // bestaande ingangen (accountmenu, tandwiel-icoon) blijven werken.
      if (d.tab === 'account') state.accountSubTab = 'profiel';
      if (d.tab === 'instellingen') state.accountSubTab = 'weergave';
      render();
    },
    'toggle-account-menu': function () { state.accountMenuOpen = !state.accountMenuOpen; render(); },
    'toggle-building-switcher': function () { state.buildingSwitcherOpen = !state.buildingSwitcherOpen; render(); },
    'set-account-subtab': function (d) { state.accountSubTab = d.sub; render(); },
    'set-filter': function (d) { state.filter = d.filter; render(); },
    'toggle-gebreken-filter': function () { state.gebrekenFilter = !state.gebrekenFilter; render(); },
    'open-element': function (d) { state.tab = 'gebouw'; state.activeElementId = d.id; render(); },
    'close-element': function () { state.activeElementId = null; render(); },
    'gb-add': function (d) {
      var el = findEl(d.id); if (!el) return;
      el.gebreken.push({ omschrijving: '', ernst: 1, omvang: 1, intensiteit: 1 });
      render();
    },
    'gb-del': function (d) {
      var el = findEl(d.id); if (!el) return;
      el.gebreken.splice(+d.gi, 1);
      render();
    },
    'gb-set': function (d) {
      var el = findEl(d.id); if (!el) return;
      var g = el.gebreken[+d.gi]; if (!g) return;
      g[d.dim] = +d.val;
      render();
    },
    'koz-min': function (d) { var el = findEl(d.id); if (!el) return; var k = el.koz[+d.i]; k.aantal = Math.max(0, k.aantal - 1); render(); },
    'koz-plus': function (d) { var el = findEl(d.id); if (!el) return; var k = el.koz[+d.i]; k.aantal = k.aantal + 1; render(); },
    'zet-advies': function (d) { state.bijdrage = clamp(+d.nodig, 10, 400); state.invul.bijdrage = true; render(); },
    'focus-bijdrage': function () {
      var f = document.getElementById('bijdrage-num');
      if (f) { f.scrollIntoView({ block: 'center' }); f.focus(); }
    },
    'focus-fonds': function () {
      var f = document.getElementById('fonds-bedrag');
      if (f) { f.scrollIntoView({ block: 'center' }); f.focus(); }
    },
    'open-add-element': function () { state.addForm = { naam: '', jaar: CURRENT_YEAR + 1, bedrag: 0, cyclus: '' }; render(); },
    'cancel-add-element': function () { state.addForm = null; render(); },
    'add-from-library': function (d) {
      var def = libraryEntry(d.key); if (!def) return;
      state.elements.push(instantiateLibraryEl(def, state.building));
      state.addForm = null;
      render();
    },
    'save-add-element': function () {
      var f = state.addForm;
      if (!f.naam) return;
      state.elements.push({
        id: uid('custom'), naam: f.naam, categorie: guessCategorie(f.naam), type: 'custom',
        cyclus: f.cyclus ? num(f.cyclus) : 0, jaar: num(f.jaar) || CURRENT_YEAR, bedrag: num(f.bedrag),
        gebreken: [], metaTekst: 'handmatig toegevoegd',
      });
      state.addForm = null;
      render();
    },
    'of-add': function (d) {
      var list = state.offertes[state.activeElementId] || (state.offertes[state.activeElementId] = []);
      list.push({ id: uid('of'), naam: 'Aannemer ' + (list.length + 1), btw: false, regels: [{ naam: '', bedrag: '' }] });
      render();
    },
    'of-del': function (d) {
      var list = state.offertes[state.activeElementId] || [];
      state.offertes[state.activeElementId] = list.filter(function (o) { return o.id !== d.oid; });
      render();
    },
    'of-add-regel': function (d) {
      var o = findOfferte(d.oid); if (!o) return;
      o.regels.push({ naam: '', bedrag: '' });
      render();
    },
    'of-del-regel': function (d) {
      var o = findOfferte(d.oid); if (!o) return;
      o.regels.splice(+d.ri, 1);
      render();
    },
    'of-toggle-btw': function (d) {
      var o = findOfferte(d.oid); if (!o) return;
      o.btw = !o.btw;
      render();
    },
    'toggle-bijvullen': function (d) { state.bijvullen[d.id] = !state.bijvullen[d.id]; render(); },
    'login-request': function () {
      var a = state.auth;
      if (!sb || !a.email.trim()) return;
      a.bezig = true; a.fout = '';
      render();
      // emailRedirectTo = de huidige pagina zonder query/hash, zodat dit
      // zowel lokaal (elke dev-poort) als op het echte GitHub Pages-adres
      // vanzelf naar de juiste plek terugstuurt. Moet wel voorkomen op de
      // "Redirect URLs"-lijst in Supabase (Authentication -> URL
      // Configuration), anders weigert Supabase de link.
      var redirectTo = window.location.origin + window.location.pathname;
      sb.auth.signInWithOtp({ email: a.email.trim(), options: { emailRedirectTo: redirectTo } }).then(function (res) {
        a.bezig = false;
        if (res.error) { a.fout = res.error.message; render(); return; }
        a.stap = 'sent';
        render();
      }).catch(function () {
        a.bezig = false; a.fout = 'Kon geen verbinding maken. Probeer het opnieuw.'; render();
      });
    },
    'login-change-email': function () {
      var a = state.auth;
      a.stap = 'email'; a.fout = '';
      render();
    },
    'logout': function () { state.accountMenuOpen = false; if (sb) sb.auth.signOut(); },
    'save-profiel': function () {
      var p = state.profile, ui = state.profielUi;
      if (!isValidPhone(p.telefoon)) { ui.fout = 'Dit telefoonnummer klopt niet — bijv. 06 12345678 of 010 1234567.'; render(); return; }
      saveProfileSection(ui, 'profielSnapshot', profielVelden, function (p) {
        return { voornaam: p.voornaam.trim(), achternaam: p.achternaam.trim(), telefoon: p.telefoon.trim(), rol: p.rol || null };
      });
    },
    'toggle-org-op-rapport': function () {
      if (state.profile) state.profile.toonOrgOpRapport = !state.profile.toonOrgOpRapport;
      render();
    },
    'save-organisatie': function () {
      var p = state.profile, ui = state.orgUi;
      if (!isValidKvk(p.kvkNummer)) {
        ui.fout = 'Dit KvK-nummer klopt niet — dat zijn 8 cijfers.';
        render();
        return;
      }
      saveProfileSection(ui, 'orgSnapshot', orgVelden, function (p) {
        return { org_naam: p.orgNaam.trim() || null, kvk_nummer: p.kvkNummer.trim() || null, toon_organisatie_op_rapport: p.toonOrgOpRapport };
      });
    },
    'save-facturatie': function () {
      var p = state.profile, ui = state.facturatieUi;
      if (p.factuurPostcode.trim() && !isValidPostcode(p.factuurPostcode)) {
        ui.fout = 'Deze postcode klopt niet — gebruik het formaat 1234 AB.';
        render();
        return;
      }
      if (!isValidBtw(p.btwNummer)) {
        ui.fout = 'Dit btw-nummer klopt niet — gebruik het formaat NL123456789B01.';
        render();
        return;
      }
      saveProfileSection(ui, 'facturatieSnapshot', facturatieVelden, function (p) {
        return {
          factuur_straat: p.factuurStraat.trim() || null,
          factuur_huisnummer: p.factuurHuisnummer.trim() || null,
          factuur_postcode: p.factuurPostcode.trim() ? normalizePostcode(p.factuurPostcode) : null,
          factuur_plaats: p.factuurPlaats.trim() || null,
          factuur_land: p.factuurLand || 'Nederland',
          btw_nummer: p.btwNummer.trim() ? p.btwNummer.trim().toUpperCase() : null,
        };
      });
    },
    'start-email-wijzigen': function () {
      state.emailWijzigen = { actief: true, nieuw: '', bezig: false, fout: '', verstuurd: false };
      render();
    },
    'cancel-email-wijzigen': function () {
      state.emailWijzigen = { actief: false, nieuw: '', bezig: false, fout: '', verstuurd: false };
      render();
    },
    'submit-email-wijzigen': function () {
      var e = state.emailWijzigen;
      var nieuw = e.nieuw.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(nieuw)) { e.fout = 'Vul een geldig e-mailadres in.'; render(); return; }
      e.bezig = true; e.fout = '';
      render();
      sb.auth.updateUser({ email: nieuw }).then(function (res) {
        e.bezig = false;
        if (res.error) { e.fout = res.error.message; render(); return; }
        e.verstuurd = true;
        render();
      }).catch(function () {
        e.bezig = false; e.fout = 'Kon geen verbinding maken. Probeer het opnieuw.'; render();
      });
    },
    'toggle-theme': function () {
      state.theme = state.theme === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', state.theme);
      try { localStorage.setItem('mjop-theme', state.theme); } catch (e) {}
      render();
    },
    'toggle-cbs-bron': function () {
      state.settings.toonCbsBron = !state.settings.toonCbsBron;
      try { localStorage.setItem('mjop-instellingen', JSON.stringify(state.settings)); } catch (e) {}
      render();
    },
    'download-mijn-gegevens': function () {
      if (!sb || !state.session) return;
      var pu = state.privacyUi;
      pu.bezig = true; pu.fout = '';
      render();
      sb.from('saved_plans').select('id,label,adres,state,updated_at').then(function (res) {
        pu.bezig = false;
        if (res.error) { pu.fout = 'Kon je gegevens niet ophalen. Probeer het opnieuw.'; render(); return; }
        var payload = {
          geexporteerd_op: new Date().toISOString(),
          account: { id: state.user.id, email: state.user.email },
          profiel: state.profile,
          abonnement: state.subscription,
          plannen: res.data,
        };
        var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'mjop-live-mijn-gegevens.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        render();
      }).catch(function () {
        pu.bezig = false; pu.fout = 'Kon geen verbinding maken. Probeer het opnieuw.'; render();
      });
    },
    'start-account-verwijderen': function () {
      state.accountVerwijderen = { actief: true, typedEmail: '', bezig: false, fout: '' };
      render();
    },
    'cancel-account-verwijderen': function () {
      state.accountVerwijderen = { actief: false, typedEmail: '', bezig: false, fout: '' };
      render();
    },
    'submit-account-verwijderen': function () {
      if (!sb || !state.session) return;
      var v = state.accountVerwijderen;
      if (v.typedEmail.trim().toLowerCase() !== state.user.email.toLowerCase()) {
        v.fout = 'Dit e-mailadres komt niet overeen met je account.';
        render();
        return;
      }
      v.bezig = true; v.fout = '';
      render();
      callSupabaseFunction('delete-account', {}).then(function (json) {
        if (json.error) { v.bezig = false; v.fout = json.error; render(); return; }
        if (sb) sb.auth.signOut();
        window.location.href = window.location.origin + window.location.pathname;
      }).catch(function (err) {
        v.bezig = false; v.fout = err.message; render();
      });
    },
    'upgrade-abonnement': function () {
      if (!sb || !state.session) return;
      // Factuuradres is niet verplicht bij het aanmaken van een account,
      // maar wel zodra iemand daadwerkelijk gaat betalen (zie de opdracht
      // bij Facturatie) — vandaar de check hier, niet bij het opslaan van
      // het profiel zelf.
      if (!factuuradresCompleet()) {
        state.subscriptionUi = { bezig: false, fout: 'Vul eerst je factuuradres in (straat, huisnummer, postcode en plaats) hieronder bij Facturatie.' };
        render();
        return;
      }
      state.subscriptionUi = { bezig: true, fout: '' };
      render();
      var here = window.location.origin + window.location.pathname;
      callSupabaseFunction('create-checkout-session', { successUrl: here, cancelUrl: here }).then(function (json) {
        if (json.url) { window.location.href = json.url; return; }
        state.subscriptionUi = { bezig: false, fout: json.error || 'Kon geen betaalpagina openen.' };
        render();
      }).catch(function (err) {
        state.subscriptionUi = { bezig: false, fout: err.message };
        render();
      });
    },
    'manage-abonnement': function () {
      if (!sb || !state.session) return;
      state.subscriptionUi = { bezig: true, fout: '' };
      render();
      var here = window.location.origin + window.location.pathname;
      callSupabaseFunction('create-portal-session', { returnUrl: here }).then(function (json) {
        if (json.url) { window.location.href = json.url; return; }
        state.subscriptionUi = { bezig: false, fout: json.error || 'Kon abonnementsbeheer niet openen.' };
        render();
      }).catch(function (err) {
        state.subscriptionUi = { bezig: false, fout: err.message };
        render();
      });
    },
    'print-rapport': function () { if (heeftAbonnementVoorDownload()) window.print(); },
    'export-csv': function () { if (heeftAbonnementVoorDownload()) exportCsv(); },
    'naar-abonnement': function () { heeftAbonnementVoorDownload(); },
    'reset-upload': function () { state.upload = null; render(); },
    'upload-confirm-mapping': function () {
      var u = state.upload, m = u.mapping;
      var regels = u.dataRijen.map(function (row) {
        var naam = m.naam > -1 ? String(row[m.naam] || '').trim() : '';
        var jaar = m.jaar > -1 ? num(row[m.jaar]) : 0;
        var bedrag = m.bedrag > -1 ? num(row[m.bedrag]) : 0;
        var sfb = m.sfb > -1 ? String(row[m.sfb] || '').trim() : '';
        var conditie = m.conditie > -1 ? String(row[m.conditie] || '').trim() : '';
        return { naam: naam, jaar: jaar || (CURRENT_YEAR + 1), bedrag: bedrag, sfb: sfb, conditie: conditie, include: !!(naam && bedrag) };
      }).filter(function (r) { return r.naam && !isOnvoorzienPost(r.naam); });
      state.upload = { stap: 'regels', bestandsnaam: u.bestandsnaam, regels: regels, basisjaar: String(CURRENT_YEAR - 1) };
      render();
    },
    'upload-toggle-regel': function (d) { state.upload.regels[+d.i].include = !state.upload.regels[+d.i].include; render(); },
    'upload-del-regel': function (d) { state.upload.regels.splice(+d.i, 1); render(); },
    'upload-add-regel': function () {
      state.upload.regels.push({ naam: '', jaar: CURRENT_YEAR + 1, bedrag: 0, cyclus: 0, sfb: '', conditie: '', include: true });
      render();
    },
    'mjop-import-confirm': function () {
      var bestandsnaam = state.upload.bestandsnaam;
      var basisjaar = num(state.upload.basisjaar) || CURRENT_YEAR;
      (state.upload.regels || []).filter(function (r) { return r.include && r.naam; }).forEach(function (r) {
        state.elements.push({
          id: uid('import'), naam: r.naam, categorie: guessCategorie(r.naam, r.sfb), type: 'custom',
          cyclus: num(r.cyclus) || 0, jaar: num(r.jaar) || (CURRENT_YEAR + 1), bedrag: num(r.bedrag), basisjaar: basisjaar,
          sfb: r.sfb || undefined, gebreken: [],
          metaTekst: 'geïmporteerd uit ' + (bestandsnaam || 'bestand'),
        });
      });
      state.upload = null;
      applyBuilding(state.building || defaultBuilding());
      render();
    },
  };

  // Los van BINDS/ACTIONS zodat zowel het live-doorzoeken tijdens het
  // typen (gedebouncet) als de expliciete "Zoeken"-knop (direct) dezelfde
  // afhandeling delen.
  function zoekAdres(q) {
    var s = state.onboarding;
    suggestAddress(q).then(function (sug) { s.sug = sug; s.gezocht = true; render(); })
      .catch(function () { s.fout = 'Kon de adressenservice niet bereiken.'; render(); });
  }

  // PDOK-weergavenaam ("Straatnaam 12, 1012AB Amsterdam") splitsen in
  // straat en plaats voor de factuuradres-autofill hieronder — dezelfde
  // notatie als suggestAddress() elders in de app al teruggeeft.
  function parseWeergavenaam(naam) {
    var m = /^(.*?)\s+[0-9].*,\s*[0-9]{4}\s?[A-Za-z]{2}\s+(.+)$/.exec(String(naam || ''));
    return m ? { straat: m[1].trim(), plaats: m[2].trim() } : null;
  }

  // Vult straat/plaats automatisch aan zodra postcode én huisnummer allebei
  // zijn ingevuld — zelfde PDOK-locatieserver (suggestAddress) als de
  // adreszoeker bij het aanmaken van een gebouw, alleen hier met
  // postcode+huisnummer als zoekterm i.p.v. een vrije tekst.
  function factuurAutofill() {
    var p = state.profile;
    if (!p || !isValidPostcode(p.factuurPostcode) || !p.factuurHuisnummer.trim()) return;
    var z = state.facturatieZoek;
    z.bezig = true; z.fout = '';
    render();
    suggestAddress(normalizePostcode(p.factuurPostcode) + ' ' + p.factuurHuisnummer.trim()).then(function (sug) {
      z.bezig = false;
      var eerste = sug[0] && parseWeergavenaam(sug[0].naam);
      if (eerste) { p.factuurStraat = eerste.straat; p.factuurPlaats = eerste.plaats; }
      else z.fout = 'Geen adres gevonden bij deze postcode/huisnummer — vul straat en plaats zelf in.';
      render();
    }).catch(function () {
      z.bezig = false; z.fout = 'Kon de adressenservice niet bereiken — vul straat en plaats zelf in.'; render();
    });
  }
  function factuuradresCompleet() {
    var p = state.profile;
    return !!(p && p.factuurStraat.trim() && p.factuurHuisnummer.trim() && isValidPostcode(p.factuurPostcode) && p.factuurPlaats.trim());
  }

  var BINDS = {
    'addr-q': function (t) {
      var s = state.onboarding;
      s.q = t.value; s.fout = ''; s.gezocht = false;
      clearTimeout(searchTimer);
      if (t.value.trim().length < 4) { s.sug = []; return; }
      searchTimer = setTimeout(function () { zoekAdres(t.value); }, 280);
    },
    // Herschaalt meteen alle per-appartement-hoeveelheden (koz-aantallen,
    // intercom, riolering, enz.) mee — zie rescaleElements().
    'building-units': function (t) {
      state.building.units = Math.max(1, num(t.value) || 1);
      rescaleElements(state.building);
    },
    'el-hoeveelheid': function (t, d) { var el = findEl(d.id); if (el) el.hoeveelheid = num(t.value); },
    'el-kengetal': function (t, d) { var el = findEl(d.id); if (el) el.kengetal = num(t.value); },
    'el-werkhoogte': function (t, d) { var el = findEl(d.id); if (el) el.werkhoogte = num(t.value); },
    'koz-tarief': function (t, d) { var el = findEl(d.id); if (el) el.koz[+d.i].eigenTarief = t.value === '' ? null : num(t.value); },
    'gb-naam': function (t, d) { var el = findEl(d.id); if (el && el.gebreken[+d.gi]) el.gebreken[+d.gi].omschrijving = t.value; },
    'el-jaar': function (t, d) { var el = findEl(d.id); if (el) el.jaar = num(t.value); },
    'el-cyclus': function (t, d) { var el = findEl(d.id); if (el) el.cyclus = num(t.value); },
    'el-bedrag': function (t, d) { var el = findEl(d.id); if (el) el.bedrag = num(t.value); },
    'el-basisjaar': function (t, d) { var el = findEl(d.id); if (el) el.basisjaar = num(t.value); },
    'fonds-bedrag': function (t) { state.fonds = num(t.value); state.invul.fonds = String(t.value).trim() !== ''; },
    'add-el-naam': function (t) { state.addForm.naam = t.value; },
    'add-el-jaar': function (t) { state.addForm.jaar = t.value; },
    'add-el-bedrag': function (t) { state.addForm.bedrag = t.value; },
    'add-el-cyclus': function (t) { state.addForm.cyclus = t.value; },
    'of-regel-naam': function (t, d) { var o = findOfferte(d.oid); if (o) o.regels[+d.ri].naam = t.value; },
    'of-regel-bedrag': function (t, d) { var o = findOfferte(d.oid); if (o) o.regels[+d.ri].bedrag = t.value; },
    'upload-regel-naam': function (t, d) { state.upload.regels[+d.i].naam = t.value; },
    'upload-regel-jaar': function (t, d) { state.upload.regels[+d.i].jaar = t.value; },
    'upload-regel-bedrag': function (t, d) { state.upload.regels[+d.i].bedrag = t.value; },
    'upload-regel-cyclus': function (t, d) { state.upload.regels[+d.i].cyclus = t.value; },
    'upload-basisjaar': function (t) { state.upload.basisjaar = t.value; },
    'auth-email': function (t) { state.auth.email = t.value; },
    'profiel-voornaam': function (t) { if (state.profile) state.profile.voornaam = t.value; },
    'profiel-achternaam': function (t) { if (state.profile) state.profile.achternaam = t.value; },
    'profiel-telefoon': function (t) { if (state.profile) state.profile.telefoon = t.value; },
    'org-naam': function (t) { if (state.profile) state.profile.orgNaam = t.value; },
    'org-kvk': function (t) { if (state.profile) state.profile.kvkNummer = t.value; },
    'fact-straat': function (t) { if (state.profile) state.profile.factuurStraat = t.value; },
    'fact-huisnummer': function (t) {
      if (!state.profile) return;
      state.profile.factuurHuisnummer = t.value;
      clearTimeout(factuurZoekTimer);
      factuurZoekTimer = setTimeout(factuurAutofill, 400);
    },
    'fact-postcode': function (t) {
      if (!state.profile) return;
      state.profile.factuurPostcode = t.value;
      clearTimeout(factuurZoekTimer);
      factuurZoekTimer = setTimeout(factuurAutofill, 400);
    },
    'fact-plaats': function (t) { if (state.profile) state.profile.factuurPlaats = t.value; },
    'fact-btw': function (t) { if (state.profile) state.profile.btwNummer = t.value; },
    'verwijder-email-typed': function (t) { state.accountVerwijderen.typedEmail = t.value; },
    'email-wijzigen-nieuw': function (t) { state.emailWijzigen.nieuw = t.value; },
    'plan-label': function (t, d) {
      var p = state.savedPlans.filter(function (x) { return x.id === d.id; })[0];
      if (p) p.label = t.value;
    },
  };

  var CHANGES = {
    'bijdrage': function (t) { state.bijdrage = +t.value; state.invul.bijdrage = true; render(); },
    'bijdrage-bedrag': function (t) { state.bijdrage = clamp(num(t.value), 10, 400); state.invul.bijdrage = true; render(); },
    'koz-materiaal': function (t, d) { var el = findEl(d.id); if (el) el.koz[+d.i].materiaal = t.value; render(); },
    'upload-map': function (t, d) { state.upload.mapping[d.veld] = +t.value; render(); },
    'profiel-rol': function (t) { if (state.profile) { state.profile.rol = t.value; render(); } },
    'fact-land': function (t) { if (state.profile) { state.profile.factuurLand = t.value; render(); } },
    'plan-label': function (t, d) {
      if (!sb || !state.session) return;
      var p = state.savedPlans.filter(function (x) { return x.id === d.id; })[0];
      if (!p) return;
      sb.from('saved_plans').update({ label: p.label, updated_at: new Date().toISOString() }).eq('id', d.id).select().single().then(function (res) {
        if (res.error) { state.plansUi.fout = 'Naam opslaan is niet gelukt.'; render(); }
      });
    },
  };

  function uploadError(err) {
    state.upload = { stap: 'fout', bestandsnaam: state.upload && state.upload.bestandsnaam, foutTekst: (err && err.message) || 'Onbekende fout bij het lezen van dit bestand.' };
    render();
  }

  function handleUploadFile(file) {
    var ext = (file.name.split('.').pop() || '').toLowerCase();
    var bezigTekst = ext === 'pdf' ? 'PDF wordt gelezen en posten worden herkend…' : 'Bestand wordt gelezen…';
    state.upload = { stap: 'laden', bestandsnaam: file.name, bezigTekst: bezigTekst };
    render();
    if (ext === 'csv') {
      readFileAsText(file).then(function (text) {
        var rows = parseCsv(text);
        if (rows.length < 2) throw new Error('Geen regels gevonden in dit csv-bestand.');
        var header = rows[0], data = rows.slice(1);
        state.upload = { stap: 'mapping', bestandsnaam: file.name, headerRij: header, dataRijen: data, mapping: guessMapping(header) };
        render();
      }).catch(uploadError);
    } else if (ext === 'xlsx' || ext === 'xls') {
      if (!window.XLSX) { uploadError(new Error('Excel-ondersteuning kon niet geladen worden (geen internetverbinding?).')); return; }
      readFileAsArrayBuffer(file).then(function (buf) {
        var wb = XLSX.read(buf, { type: 'array' });
        var sheet = wb.Sheets[wb.SheetNames[0]];
        var rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' })
          .filter(function (r) { return r.some(function (c) { return String(c).trim() !== ''; }); });
        if (rows.length < 2) throw new Error('Geen regels gevonden in dit Excel-bestand.');
        var header = rows[0], data = rows.slice(1);
        state.upload = { stap: 'mapping', bestandsnaam: file.name, headerRij: header, dataRijen: data, mapping: guessMapping(header) };
        render();
      }).catch(uploadError);
    } else if (ext === 'pdf') {
      readFileAsArrayBuffer(file).then(extractPdfText).then(function (text) {
        var prijspeil = detectPrijspeilJaar(text);
        state.upload = {
          stap: 'regels', bestandsnaam: file.name, regels: extractPdfRegels(text),
          basisjaar: String(prijspeil || (CURRENT_YEAR - 1)), ruweTekst: text,
        };
        render();
      }).catch(uploadError);
    } else {
      uploadError(new Error('Bestandstype niet ondersteund. Gebruik csv, xlsx of pdf.'));
    }
  }

  function findEl(id) { return state.elements.filter(function (e) { return e.id === id; })[0]; }
  function findOfferte(oid) {
    var list = state.offertes[state.activeElementId] || [];
    return list.filter(function (o) { return o.id === oid; })[0];
  }

  function exportCsv() {
    var rows = [['Element', 'NL-SfB', 'Categorie', 'Conditiescore (NEN 2767)', 'Cyclus (jaar)', 'Volgende beurt', 'Kosten']];
    state.elements.forEach(function (el) {
      var score = conditionScore(el);
      rows.push([el.naam, el.sfb || '', el.categorie, score == null ? 'onbekend' : score, el.cyclus || '', conditionYear(el), Math.round(elementCost(el, state))]);
    });
    var csv = rows.map(function (r) {
      return r.map(function (v) {
        var s = String(v);
        // CSV-/formule-injectie: Excel e.a. interpreteren een cel die begint
        // met =, +, -, @, tab of CR als formule zodra het bestand geopend
        // wordt. Elementnamen kunnen uit een geïmporteerd (dus onbetrouwbaar)
        // MJOP komen — een voorloop-apostrof dwingt platte tekst af.
        if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
        return '"' + s.replace(/"/g, '""') + '"';
      }).join(',');
    }).join('\r\n');
    var blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'mjop-' + (state.building.adres || 'export').replace(/[^a-z0-9]+/gi, '-').toLowerCase() + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ---------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------
  document.addEventListener('DOMContentLoaded', function () {
    root = document.getElementById('root');
    // Nooit blokkerend voor de rest van het opstarten — bij falen (geen
    // internet, CBS-tabel offline, veld niet gevonden) blijft cbsIndexatie
    // gewoon null en valt indexeerBedrag()/elementMeta() terug op de vaste
    // INDEXATIE_PCT-schatting.
    laadCbsIndexatie();
    // Eén keer geregistreerd, niet per render() — render() vervangt de hele
    // DOM, dus deze listener zoekt bij elke scroll opnieuw naar
    // .mkt-hero-canvas i.p.v. een vaste referentie vast te houden.
    window.addEventListener('scroll', onHeroScroll, { passive: true });
    // Enige plek die state.session/state.user zet: dit vuurt bij het
    // laden meteen met de bestaande sessie (of null), en daarna bij elke
    // in-/uitlog-actie — zo blijft een reload ingelogd (Supabase bewaart
    // de sessie zelf in localStorage) zonder dat wij dat apart hoeven te
    // regelen.
    if (sb) {
      sb.auth.onAuthStateChange(function (event, session) {
        state.session = session;
        state.user = session ? session.user : null;
        if (session) {
          if (!state.plansLoaded) loadSavedPlans();
          if (!state.subscriptionLoaded) loadSubscription();
          if (!state.profileLoaded) loadProfile();
        } else {
          // Opgeslagen-plannen-state hoort bij de sessie die 'm heeft
          // opgehaald; bij uitloggen (of op een gedeelde computer: bij het
          // wisselen naar een andere sessie) mag dat nooit blijven hangen
          // voor de volgende (mogelijk andere) gebruiker.
          state.savedPlans = []; state.plansLoaded = false;
          state.currentPlanId = null; state.lastSavedSnapshot = null;
          state.subscription = null; state.subscriptionLoaded = false;
          state.profile = null; state.profileLoaded = false;
          state.profielSnapshot = null; state.orgSnapshot = null; state.facturatieSnapshot = null;
          try { sessionStorage.removeItem('mjop-worksessie'); } catch (e) {}
        }
        render();
      });
      // Een verlopen/al-gebruikte inloglink komt terug als #error=...
      // i.p.v. sessie-tokens (die vangt supabase-js zelf al af via
      // detectSessionInUrl). Toon dat op het inlogscherm i.p.v. de
      // gebruiker gewoon uitgelogd op het beginscherm te laten belanden
      // zonder enige verklaring. Een mailclient opent de link vaak in een
      // nieuwe, verse tab (screen nog op 'onboarding') — daarom hier ook
      // meteen naar het voorbeeldgebouw, anders is er geen tabbalk om het
      // accountscherm mee te bereiken.
      if (window.location.hash.indexOf('error=') > -1) {
        var errParams = new URLSearchParams(window.location.hash.slice(1));
        state.auth.fout = errParams.get('error_description') || 'Inloggen via de link is niet gelukt. Vraag een nieuwe link aan.';
        if (state.screen !== 'app') applyBuilding(defaultBuilding());
        state.tab = 'account';
        history.replaceState(null, '', window.location.pathname + window.location.search);
      }
    }
    // currentScreen() re-evaluates isDesktopWidth() on every render, maar
    // resizen zelf triggert geen render — zonder deze listener zou de
    // marketing-gate pas verschijnen/verdwijnen bij de eerstvolgende klik.
    var resizeTimer;
    window.addEventListener('resize', function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(render, 150);
    });
    root.addEventListener('click', function (e) {
      var gp = e.target.closest('[data-gb-filter]');
      if (gp && !e.target.closest('[data-act]')) {
        state.filter = gp.dataset.gbFilter === state.filter ? 'Alles' : gp.dataset.gbFilter;
        render();
        return;
      }
      var t = e.target.closest('[data-act]');
      if (!t) return;
      var handler = ACTIONS[t.dataset.act];
      if (handler) { e.preventDefault(); handler(t.dataset, e); }
    });
    // Voor de data-act-elementen die render() net tabindex/role gaf omdat
    // ze geen echt <button>/<a href> zijn: die krijgen Enter/spatie niet
    // gratis van de browser. t.click() hergebruikt gewoon de click-
    // afhandeling hierboven i.p.v. die te dupliceren.
    root.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      var t = e.target.closest('[data-act]');
      if (!t || isNativelyInteractive(t)) return;
      e.preventDefault();
      t.click();
    });
    root.addEventListener('input', function (e) {
      // Slider op Overzicht: alleen verdict/grafiek vervangen, niet de hele
      // pagina — een volledige render() haalt de slider weg tijdens het slepen.
      if (e.target && e.target.id === 'bijdrage-slider') {
        state.bijdrage = clamp(+e.target.value, 10, 400);
        state.invul.bijdrage = true;
        var numEl = document.getElementById('bijdrage-num');
        if (numEl) numEl.value = state.bijdrage;
        updateOverzichtLive();
        return;
      }
      if (e.target && e.target.id === 'mkt-slider') {
        mktDemoBijdrage = clamp(+e.target.value, 10, 400);
        var dm = overzichtModel(voorbeeldPlan());
        document.getElementById('mkt-live-verdict').innerHTML = ovVerdictHtml(dm, true);
        document.getElementById('mkt-live-chart').innerHTML = ovChartHtml(dm);
        document.getElementById('mkt-out').textContent = eur(dm.bijdrage);
        return;
      }
      var t = e.target.closest('[data-bind]');
      if (!t) return;
      var handler = BINDS[t.dataset.bind];
      if (handler) { handler(t, t.dataset); render(); }
    });
    root.addEventListener('change', function (e) {
      if (e.target && e.target.id === 'mjop-file-input') {
        var file = e.target.files && e.target.files[0];
        if (file) handleUploadFile(file);
        return;
      }
      var t = e.target.closest('[data-change]');
      if (!t) return;
      var handler = CHANGES[t.dataset.change];
      if (handler) handler(t, t.dataset);
    });
    render();
  });
})();
