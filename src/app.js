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
  function num(v) {
    var n = parseInt(String(v == null ? '' : v).replace(/[^0-9-]/g, ''), 10);
    return isNaN(n) ? 0 : n;
  }
  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
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
                units: units, d3: d3,
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
    { key: 'dak-plat', naam: 'Dakbedekking plat dak', categorie: 'Dak', sfb: '27.1', type: 'dak', cyclus: 25, kengetal: 165, bron: 'dakM2' },
    { key: 'dakgoten', naam: 'Dakgoten en hemelwaterafvoeren', categorie: 'Dak', sfb: '27.3', type: 'vast-variabel', cyclus: 20, basis: 300, perEenheid: 90, bron: 'units' },
    { key: 'dakinspectie', naam: 'Dakinspectie en klein onderhoud', categorie: 'Dak', sfb: '27', type: 'vast-variabel', cyclus: 2, basis: 420, perEenheid: 2, bron: 'dakM2' },
    { key: 'dak-hellend', naam: 'Dakbedekking hellend dak (pannen)', categorie: 'Dak', sfb: '27.2', type: 'dak', cyclus: 40, kengetal: 95, bron: 'dakM2', optioneel: true },
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
    { key: 'verlichting', naam: 'Verlichting gemeenschappelijke ruimten', categorie: 'Installaties', sfb: '64', type: 'per-unit', cyclus: 15, kengetal: 65, bron: 'units', optioneel: true },
    { key: 'waterleiding', naam: 'Waterleiding gemeenschappelijk', categorie: 'Installaties', sfb: '52', type: 'vast-variabel', cyclus: 30, basis: 600, perEenheid: 55, bron: 'units', optioneel: true },
    { key: 'brandveiligheid', naam: 'Brandveiligheid (blusmiddelen, vluchtwegverlichting)', categorie: 'Installaties', sfb: '67', type: 'per-unit', cyclus: 10, kengetal: 45, bron: 'units', optioneel: true },
    { key: 'lift', naam: 'Liftinstallatie — onderhoud en modernisering', categorie: 'Installaties', sfb: '59', type: 'vast-variabel', cyclus: 20, basis: 12000, perEenheid: 0, bron: 'none', optioneel: true },

    { key: 'trappenhuis', naam: 'Trappenhuis en entree', categorie: 'Binnen', sfb: '42/43', type: 'per-unit', cyclus: 8, kengetal: 480, bron: 'units' },
    { key: 'vloerafwerking', naam: 'Vloerafwerking gemeenschappelijke ruimten', categorie: 'Binnen', sfb: '43', type: 'per-unit', cyclus: 15, kengetal: 120, bron: 'units', optioneel: true },

    { key: 'bestrating', naam: 'Bestrating en terreininrichting', categorie: 'Terrein', sfb: '81/89', type: 'vast-variabel', cyclus: 20, basis: 500, perEenheid: 60, bron: 'units', optioneel: true },
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
      adres: 'Voorbeeldgebouw — portiekflat', bouwjaar: 1978, units: 8,
      dakM2: 140, gevelM2: 220, werkhoogte: 9, opp: 140, omtrek: 60,
      identificatie: '', gebruiksdoel: 'woonfunctie', d3: null, isVoorbeeld: true,
    };
  }

  // Bouwt een element-instantie uit een bibliotheek-definitie, geschaald
  // op de werkelijke (of voorbeeld-)gebouwgegevens.
  function instantiateLibraryEl(def, b) {
    var el = {
      id: def.key, naam: def.naam, categorie: def.categorie, sfb: def.sfb,
      type: def.type, cyclus: def.cyclus,
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

  function buildDefaultElements(b) {
    return ELEMENT_LIBRARY.filter(function (d) { return !d.optioneel; })
      .map(function (d) { return instantiateLibraryEl(d, b); });
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

  var INDEXATIE_PCT = 0.03; // 3% per jaar, standaard voor geïmporteerde MJOP-bedragen

  // Geïmporteerde posten zijn genoteerd op het prijspeil van het oude MJOP
  // (el.basisjaar). Kosten worden vanaf dat jaar met 3% per jaar
  // samengesteld doorgerekend naar het jaar waarin de post daadwerkelijk
  // wordt uitgevoerd.
  function indexeerBedrag(bedrag, basisjaar, uitvoeringsjaar) {
    if (basisjaar == null) return bedrag;
    return Math.round(bedrag * Math.pow(1 + INDEXATIE_PCT, uitvoeringsjaar - basisjaar));
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
      case 'per-unit': return el.hoeveelheid + ' units × ' + eur(el.kengetal);
      case 'vast-variabel': return eur(el.basis) + ' vast + ' + el.hoeveelheid + ' × ' + eur(el.perEenheid);
      case 'custom': return (el.metaTekst || 'eenmalige post') + (el.basisjaar != null ? ' · prijspeil ' + el.basisjaar + ', +3%/jaar' : '');
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

  function kasstroom(state) {
    var posten = fullPlan(state);
    var perJaar = {};
    posten.forEach(function (p) { perJaar[p.jaar] = (perJaar[p.jaar] || 0) + p.bedrag; });
    var units = Math.max(1, state.building.units);
    var inkomen = state.bijdrage * 12 * units;
    var saldo = state.fonds;
    var rows = [];
    for (var j = CURRENT_YEAR; j <= CURRENT_YEAR + HORIZON - 1; j++) {
      saldo = saldo + inkomen - (perJaar[j] || 0);
      rows.push({ jaar: j, kosten: perJaar[j] || 0, saldo: saldo });
    }
    return rows;
  }

  // ---------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------
  var state = {
    screen: 'onboarding',
    onboarding: { q: '', sug: [], bezig: false, bezigTekst: '', fout: '' },
    upload: null, // zie renderUploadWizard voor de vorm van dit object
    building: null,
    fonds: 0,
    bijdrage: 55,
    idxBalk: true,
    elements: [],
    tab: 'home',
    activeElementId: null,
    filter: 'Alles',
    offertes: {}, // elId -> [{id, naam, btw, regels:[{naam,bedrag}]}]
    bijvullen: {}, // elId -> bool
    addForm: null,
  };

  // Zet het gebouw vast. Als er nog geen elementen zijn (verse start) wordt
  // de standaardbibliotheek geïnstantieerd; zijn er al elementen (bv. uit
  // een MJOP-upload) dan worden alleen de bibliotheek-elementen herschaald
  // op de nieuwe m²/units — geïmporteerde/eigen posten blijven ongemoeid.
  function applyBuilding(building) {
    state.building = building;
    if (!state.elements.length) {
      state.fonds = building.units * 2500;
      state.elements = buildDefaultElements(building);
    } else {
      state.elements.forEach(function (el) {
        var def = libraryEntry(el.id);
        if (def && def.bron && def.bron !== 'none') el.hoeveelheid = bronWaarde(def.bron, building);
        if (el.type === 'steiger') el.werkhoogte = building.werkhoogte;
        if (el.type === 'kozijnen') {
          var counts = scaleKozCounts(building.units);
          el.koz.forEach(function (k, i) { if (KOZ_DEF[i]) k.aantal = counts[i]; });
        }
      });
    }
    state.screen = 'app';
    state.tab = 'home';
  }

  // ---------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------
  var root;

  function render() {
    var active = document.activeElement;
    var focusInfo = null;
    if (active && root.contains(active) && active.id) {
      focusInfo = { id: active.id, start: active.selectionStart, end: active.selectionEnd };
    }
    root.innerHTML = state.screen === 'onboarding' ? renderOnboarding() : renderApp();
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

  function renderOnboarding() {
    if (state.upload) return renderUploadWizard();
    var s = state.onboarding;
    var html = '';
    html += '<div class="app-shell">';
    html += '<div class="hero"><div class="eyebrow on-blue">MJOP Live · echte BAG-data</div>';
    html += '<h1>MJOP voor kleine VvE’s</h1>';
    html += '<p>Typ een adres. De app haalt bouwjaar en appartementen uit de BAG, en het echte dakoppervlak, muuroppervlak en de hoogte uit de 3D BAG.</p></div>';

    html += '<div class="shell-body">';
    html += '<div class="section">';
    html += '<div class="field"><div class="eyebrow">Adres</div>';
    html += '<input id="addr-search" data-bind="addr-q" value="' + esc(s.q) + '" placeholder="bv. Kastanjelaan 12 Amersfoort" autocomplete="off" /></div>';

    if (s.sug.length) {
      html += '<div class="suggest-list">';
      s.sug.forEach(function (sg) {
        html += '<div class="suggest-row" data-act="kies-adres" data-id="' + esc(sg.id) + '" data-naam="' + esc(sg.naam) + '">' + esc(sg.naam) + '</div>';
      });
      html += '</div>';
    }
    if (s.bezig) html += '<div class="notice">' + esc(s.bezigTekst) + '</div>';
    if (s.fout) html += '<div class="notice error">' + esc(s.fout) + '</div>';
    html += '</div>';

    html += '<div class="empty-block"><div class="empty-card">';
    html += '<div class="title">Probeer bijvoorbeeld</div>';
    html += '<div class="body">Je eigen adres, of een portiekflat die je kent. Hoe meer appartementen op één pand, hoe beter de app het als VvE herkent.</div>';
    html += '<div class="btn-row"><div class="ghost-btn" data-act="skip-onboarding">Begin met een voorbeeldgebouw →</div></div>';
    html += '</div></div>';

    html += '<div class="section"><div class="card pad">';
    html += '<div style="font:500 13.5px/1.35 DM Sans,sans-serif">Al een MJOP?</div>';
    html += '<div class="hint" style="margin-top:6px">Upload een bestaand plan (csv, Excel of pdf) — de app haalt de regels eruit, jij controleert ze, en het plan hoeft dan alleen nog geactualiseerd te worden.</div>';
    html += '<div class="btn-row"><label class="ghost-btn" for="mjop-file-input" style="cursor:pointer">Upload bestaand MJOP</label>';
    html += '<input id="mjop-file-input" type="file" accept=".csv,.xlsx,.xls,.pdf" style="display:none" /></div>';
    html += '</div></div>';

    html += '<div class="footer-note">Kengetallen zijn indicatieve richtprijzen inclusief btw, geen offerte. Bronnen: PDOK Locatieserver en BAG (Public Domain Mark 1.0) en 3D BAG van de TU Delft (CC BY 4.0).</div>';
    html += '</div>';
    html += '</div>';
    return html;
  }

  function renderUploadWizard() {
    var u = state.upload;
    var html = '<div class="app-shell">';
    html += '<div class="hero"><div class="eyebrow on-blue">Bestaand MJOP importeren</div>';
    html += '<h1>' + esc(u.bestandsnaam || 'Bestand') + '</h1>';
    html += '<p>Controleer wat de app herkend heeft — er gaat pas iets het plan in na jouw bevestiging.</p></div>';

    html += '<div class="shell-body">';
    if (u.stap === 'laden') {
      html += '<div class="section"><div class="notice">Bestand wordt gelezen…</div></div>';
    } else if (u.stap === 'fout') {
      html += '<div class="section"><div class="notice error">' + esc(u.foutTekst) + '</div>';
      html += '<div class="btn-row"><div class="ghost-btn" data-act="reset-upload">Terug</div></div></div>';
    } else if (u.stap === 'mapping') {
      html += renderUploadMapping(u);
    } else if (u.stap === 'regels') {
      html += renderUploadRegels(u);
    }
    html += '</div>';

    html += '</div>';
    return html;
  }

  function renderUploadMapping(u) {
    var velden = [
      ['naam', 'Omschrijving / element'], ['jaar', 'Jaar'], ['bedrag', 'Bedrag'],
      ['sfb', 'NL-SfB code (optioneel)'], ['conditie', 'Conditie (optioneel)'],
    ];
    var html = '<div class="section"><div class="section-title">Welke kolom is wat?</div>';
    html += '<div class="card pad" style="margin-top:11px">';
    velden.forEach(function (v) {
      html += '<div class="input-row" style="margin-top:11px"><div class="label">' + v[1] + '</div>';
      html += '<select data-change="upload-map" data-veld="' + v[0] + '" style="flex:none;width:150px;padding:8px;border-radius:10px;border:1px solid var(--ink-14);background:#fff">';
      html += '<option value="-1"' + (u.mapping[v[0]] === -1 ? ' selected' : '') + '>— geen —</option>';
      u.headerRij.forEach(function (h, i) {
        html += '<option value="' + i + '"' + (u.mapping[v[0]] === i ? ' selected' : '') + '>' + esc(String(h || 'kolom ' + (i + 1))) + '</option>';
      });
      html += '</select></div>';
    });
    html += '</div></div>';

    html += '<div class="section"><div class="section-title">Voorbeeld (eerste regels)</div>';
    html += '<div class="card" style="margin-top:11px;overflow-x:auto">';
    u.dataRijen.slice(0, 4).forEach(function (row, i) {
      html += '<div class="row"' + (i === 0 ? ' style="border-top:none"' : '') + '><div class="grow meta" style="font-size:11.5px;white-space:nowrap">' + row.map(esc).join(' · ') + '</div></div>';
    });
    html += '</div></div>';

    html += '<div class="section"><div class="btn-row">';
    html += '<div class="primary-btn" data-act="upload-confirm-mapping">Volgende</div>';
    html += '<div class="ghost-btn" data-act="reset-upload">Annuleer</div>';
    html += '</div></div>';
    return html;
  }

  function renderUploadRegels(u) {
    var basisjaar = num(u.basisjaar);
    var html = '<div class="section"><div class="card pad">';
    html += '<div style="font:500 13.5px/1.35 DM Sans,sans-serif">Prijspeil van dit MJOP</div>';
    html += '<div class="input-row" style="margin-top:11px"><div class="label">De bedragen hieronder zijn genoteerd op prijspeil</div><input data-bind="upload-basisjaar" value="' + esc(u.basisjaar) + '" /></div>';
    html += '<div class="hint">Bedragen worden automatisch met 3% per jaar geïndexeerd van dit jaar naar het jaar waarin de post daadwerkelijk gepland staat. Staat er al een actueel bedrag in het bestand? Zet het prijspeil dan gelijk aan het huidige jaar (' + CURRENT_YEAR + ') zodat er niet extra geïndexeerd wordt.</div>';
    html += '</div></div>';

    html += '<div class="section"><div class="section-title">' + u.regels.length + ' regels gevonden</div>';
    html += '<div class="card" style="margin-top:11px">';
    if (!u.regels.length) {
      html += '<div class="row" style="border-top:none"><div class="grow meta" style="font-size:12.5px">Geen regels herkend. Voeg ze hieronder handmatig toe, of gebruik de ruwe tekst hieronder om ze zelf over te nemen.</div></div>';
    }
    u.regels.forEach(function (r, i) {
      var geindexeerd = indexeerBedrag(num(r.bedrag), basisjaar, num(r.jaar));
      html += '<div style="padding:14px 16px' + (i === 0 ? ';border-top:none' : ';border-top:1px solid var(--ink-08)') + '">';
      html += '<div style="display:flex;align-items:center;gap:10px">';
      html += '<input type="checkbox" data-act="upload-toggle-regel" data-i="' + i + '"' + (r.include ? ' checked' : '') + ' />';
      html += '<input data-bind="upload-regel-naam" data-i="' + i + '" value="' + esc(r.naam) + '" placeholder="element" style="flex:1;min-width:0;border:1px solid var(--ink-14);border-radius:8px;padding:7px 9px;font:500 13.5px DM Sans,sans-serif" />';
      html += '<button data-act="upload-del-regel" data-i="' + i + '" style="border:none;background:none;color:var(--ink-45);cursor:pointer;flex:none;font-size:16px">×</button>';
      html += '</div>';
      html += '<div style="display:flex;align-items:center;gap:14px;margin-top:9px;padding-left:26px;flex-wrap:wrap">';
      html += '<div style="display:flex;align-items:center;gap:6px"><span class="eyebrow" style="font-size:9.5px">Jaar</span><input data-bind="upload-regel-jaar" data-i="' + i + '" value="' + esc(r.jaar) + '" style="width:52px;border:1px solid var(--ink-14);border-radius:7px;padding:5px 6px;text-align:center;font:500 12px DM Mono,monospace" /></div>';
      html += '<div style="display:flex;align-items:center;gap:6px"><span class="eyebrow" style="font-size:9.5px">Prijspeil ' + basisjaar + '</span><input data-bind="upload-regel-bedrag" data-i="' + i + '" value="' + esc(r.bedrag) + '" style="width:72px;border:1px solid var(--ink-14);border-radius:7px;padding:5px 6px;text-align:right;font:500 12px DM Mono,monospace" /></div>';
      html += '<div style="display:flex;align-items:center;gap:6px"><span class="eyebrow" style="font-size:9.5px">Cyclus (jaar, 0 = eenmalig)</span><input data-bind="upload-regel-cyclus" data-i="' + i + '" value="' + esc(r.cyclus || 0) + '" style="width:44px;border:1px solid var(--ink-14);border-radius:7px;padding:5px 6px;text-align:center;font:500 12px DM Mono,monospace" /></div>';
      html += '</div>';
      html += '<div style="margin-top:9px;padding-left:26px;font:500 15px/1 DM Mono,monospace;color:var(--blue)">→ ' + eur(geindexeerd) + ' <span style="font:400 11px/1 DM Sans,sans-serif;color:var(--ink-50)">in ' + esc(r.jaar) + '</span></div>';
      html += '</div>';
    });
    html += '<div class="row" style="cursor:pointer" data-act="upload-add-regel"><div class="grow" style="font:500 13px DM Sans,sans-serif;color:var(--blue)">+ Regel toevoegen</div></div>';
    html += '</div></div>';

    if (u.ruweTekst) {
      html += '<div class="section"><details><summary style="cursor:pointer;font:500 12.5px DM Sans,sans-serif;color:var(--blue)">Ruwe tekst uit de pdf bekijken</summary>';
      html += '<div class="card pad" style="margin-top:9px"><div class="hint" style="margin-bottom:8px">Heeft de app een regel gemist? Gebruik deze tekst om hem hierboven handmatig toe te voegen.</div>';
      html += '<pre style="white-space:pre-wrap;font:400 10.5px/1.5 DM Mono,monospace;color:var(--ink-60);max-height:220px;overflow:auto;margin:0">' + esc(u.ruweTekst) + '</pre></div></details></div>';
    }

    html += '<div class="section"><div class="hint">Elke regel wordt een post in het plan op het opgegeven jaar. Je kunt hierna nog het adres koppelen voor de echte gebouwgegevens — de geïmporteerde regels blijven dan staan.</div>';
    html += '<div class="btn-row">';
    html += '<div class="primary-btn" data-act="mjop-import-confirm">Importeren en doorgaan</div>';
    html += '<div class="ghost-btn" data-act="reset-upload">Annuleer</div>';
    html += '</div></div>';
    return html;
  }

  function renderApp() {
    var html = '<div class="app-shell">';
    if (state.tab === 'home') html += renderHome();
    else if (state.tab === 'gebouw') html += renderGebouw();
    else if (state.tab === 'planning') html += renderPlanning();
    else if (state.tab === 'rapport') html += renderRapport();
    html += renderTabBar();
    html += '</div>';
    return html;
  }

  function renderTabBar() {
    var tabs = [['home', 'Overzicht'], ['gebouw', 'Gebouw'], ['planning', 'Planning'], ['rapport', 'Rapport']];
    var html = '<div class="tab-bar">';
    html += '<div class="tab-brand">MJOP Live</div>';
    tabs.forEach(function (t) {
      var active = state.tab === t[0];
      html += '<button class="tab-item' + (active ? ' active' : '') + '" data-act="set-tab" data-tab="' + t[0] + '">';
      html += '<span class="tab-dot"></span><span>' + t[1] + '</span></button>';
    });
    html += '</div>';
    return html;
  }

  function projectionBars(rows) {
    var maxAbs = Math.max(1, Math.max.apply(null, rows.map(function (r) { return Math.abs(r.saldo); })));
    var html = '<div class="bars">';
    rows.forEach(function (r) {
      var posH = r.saldo > 0 ? Math.max(3, r.saldo / maxAbs * 40) : 0;
      var negH = r.saldo < 0 ? Math.max(3, -r.saldo / maxAbs * 40) : 0;
      html += '<div class="bar-col">';
      html += '<div class="bar-pos"><div style="height:' + posH + 'px"></div></div>';
      html += '<div class="bar-mid"></div>';
      html += '<div class="bar-neg"><div style="height:' + negH + 'px"></div></div>';
      html += '<div class="bar-label">' + String(r.jaar).slice(2) + '</div>';
      html += '</div>';
    });
    html += '</div>';
    return html;
  }

  function renderHome() {
    var b = state.building;
    var rows = kasstroom(state);
    var laagste = Math.min.apply(null, rows.map(function (r) { return r.saldo; }));
    var eerste = rows.filter(function (r) { return r.saldo < 0; })[0];
    var units = Math.max(1, b.units);
    var totaal = rows.reduce(function (a, r) { return a + r.kosten; }, 0);
    var nodig = Math.max(5, Math.ceil((totaal - state.fonds) / (10 * 12 * units) / 5) * 5);

    var html = '<div style="padding:24px 0 8px">';
    if (state.idxBalk) {
      html += '<div class="idx-bar" data-act="dismiss-idx">';
      html += '<span class="pill">' + CURRENT_YEAR + '</span>';
      html += '<span class="text">Bijgewerkt met de laatst opgehaalde gegevens — controleer de posten die aandacht vragen</span>';
      html += '<button class="close" data-act="dismiss-idx">×</button></div>';
    }
    html += '<div style="padding:0 22px">';
    html += '<div class="eyebrow">' + esc(b.adres) + ' <span class="linkish" data-act="wijzig-adres">wijzig</span></div>';
    html += '<div class="page-title" style="margin-top:9px">Sparen we genoeg?</div>';
    html += '</div>';

    html += '<div class="section"><div class="contrib-box">';
    html += '<div class="contrib-top"><div class="label">Bijdrage per appartement</div><div class="amount">' + eur(state.bijdrage) + '</div></div>';
    html += '<input type="range" min="10" max="400" step="5" value="' + state.bijdrage + '" data-change="bijdrage" />';
    html += projectionBars(rows);
    html += '<div class="advice">' + (eerste
      ? 'Bij ' + eur(state.bijdrage) + ' per maand is het fonds in ' + eerste.jaar + ' leeg. Er is ongeveer ' + eur(nodig) + ' per appartement per maand nodig om alle posten te dekken.'
      : 'Bij ' + eur(state.bijdrage) + ' per maand blijft het fonds ' + HORIZON + ' jaar positief, met ' + eur(laagste) + ' als laagste stand.') + '</div>';
    html += '<div class="advice-btn" data-act="zet-advies" data-nodig="' + nodig + '">Zet op het benodigde bedrag (' + eur(nodig) + ')</div>';
    html += '</div></div>';

    html += '<div class="stat-pair">';
    html += '<div class="stat-card"><div class="label">Reservefonds nu</div><div class="amount">' + eur(state.fonds) + '</div></div>';
    html += '<div class="stat-card"><div class="label">Kosten t/m ' + (CURRENT_YEAR + HORIZON - 1) + '</div><div class="amount">' + eur(totaal) + '</div></div>';
    html += '</div>';

    var aandacht = state.elements.filter(needsAssessment);
    var eerstvolgende = fullPlan(state).filter(function (p) { return p.jaar <= CURRENT_YEAR + 1; }).slice(0, 3);
    html += '<div class="section"><div class="section-title">Vraagt nu aandacht</div>';
    html += '<div class="card" style="margin-top:11px">';
    var rowsHtml = [];
    aandacht.forEach(function (el) {
      rowsHtml.push('<div class="attn-row" data-act="open-element" data-id="' + el.id + '">' +
        '<div class="attn-icon" style="background:#FBE9DF;color:#B4531F">?</div>' +
        '<div class="grow"><div class="title">' + esc(el.naam) + ' nog niet beoordeeld</div>' +
        '<div class="sub">Beoordeel de conditie — dit bepaalt het jaar van vervanging</div></div>' +
        '<div class="chev">›</div></div>');
    });
    eerstvolgende.forEach(function (p) {
      rowsHtml.push('<div class="attn-row" data-act="open-element" data-id="' + p.elId + '">' +
        '<div class="attn-icon" style="background:#F6E6C8;color:#8A6414">' + p.jaar + '</div>' +
        '<div class="grow"><div class="title">' + esc(p.naam) + '</div>' +
        '<div class="sub">Gepland in ' + p.jaar + ' · ' + eur(p.bedrag) + '</div></div>' +
        '<div class="chev">›</div></div>');
    });
    if (!rowsHtml.length) rowsHtml.push('<div class="attn-row"><div class="grow"><div class="title">Niets dat nu aandacht vraagt</div><div class="sub">Alle elementen zijn beoordeeld</div></div></div>');
    html += rowsHtml.join('');
    html += '</div></div>';

    html += '<div class="footer-note">Kengetallen zijn indicatieve richtprijzen inclusief btw, geen offerte. Cycli zijn gebaseerd op het bouwjaar uit de BAG; een echte conditiemeting kan posten naar voren of naar achteren schuiven.</div>';
    html += '</div>';
    return html;
  }

  function needsAssessment(el) { return el.type !== 'custom' && conditionScore(el) == null; }
  function isAssessed(el) { return el.type === 'custom' || conditionScore(el) != null; }

  function scoreColors(score) {
    if (score == null) return ['#EFE7DA', 'rgba(36,31,27,.45)'];
    if (score <= 2) return ['#E3EDE2', '#3F6B46'];
    if (score === 3) return ['#F6EFD9', '#7D6318'];
    return ['#FBE9DF', '#8A3D14'];
  }

  function renderGebouw() {
    if (state.activeElementId) return renderElementDetail(state.activeElementId);
    var b = state.building;
    var cats = ['Alles', 'Dak', 'Gevel', 'Installaties', 'Binnen', 'Terrein', 'Overig'];
    var els = state.elements.filter(function (el) { return state.filter === 'Alles' || el.categorie === state.filter; });

    var html = '<div style="padding:24px 0 8px">';
    html += '<div style="padding:0 22px">';
    html += '<div class="page-title">Gebouw</div>';
    html += '<div class="page-sub">' + esc(b.adres) + ' · bouwjaar ' + (b.bouwjaar || 'onbekend') + ' · ' + b.units + ' appartementen · ' + state.elements.length + ' elementen</div>';
    html += '</div>';

    html += '<div class="section"><div class="chip-row">';
    cats.forEach(function (c) {
      html += '<div class="chip' + (state.filter === c ? ' active' : '') + '" data-act="set-filter" data-filter="' + c + '">' + c + '</div>';
    });
    html += '</div></div>';

    html += '<div class="section"><div class="card">';
    els.forEach(function (el, i) {
      var bedrag = eur(elementCost(el, state));
      var score = conditionScore(el);
      var colors = scoreColors(score);
      html += '<div class="row" data-act="open-element" data-id="' + el.id + '" style="cursor:pointer' + (i === 0 ? ';border-top:none' : '') + '">';
      html += '<div class="el-badge" style="background:' + colors[0] + ';color:' + colors[1] + '">' + (score == null ? '?' : score) + '</div>';
      html += '<div class="grow"><div class="name">' + esc(el.naam) + (el.sfb ? ' <span class="sfb-tag">NL-SfB ' + esc(el.sfb) + '</span>' : '') + '</div><div class="meta">' + elementMeta(el) + '</div></div>';
      html += '<div class="value">' + bedrag + '</div></div>';
    });
    html += '</div>';
    html += '<div class="add-el" data-act="open-add-element"><div class="plus">+</div><div><div class="title">Element toevoegen</div><div class="sub">Bijv. balkons, hekwerk, liftinstallatie</div></div></div>';
    html += '</div>';

    if (state.addForm) html += renderAddElementForm();

    html += '</div>';
    return html;
  }

  function renderAddElementForm() {
    var f = state.addForm;
    var aanwezig = {};
    state.elements.forEach(function (el) { aanwezig[el.id] = true; });
    var beschikbaar = ELEMENT_LIBRARY.filter(function (d) { return d.optioneel && !aanwezig[d.key]; });

    var html = '<div class="section"><div class="section-title">Uit de elementenbibliotheek (NL-SfB)</div>';
    html += '<div class="card" style="margin-top:11px">';
    if (!beschikbaar.length) {
      html += '<div class="row" style="border-top:none"><div class="grow meta" style="font-size:12.5px">Alle bibliotheek-elementen staan al in het plan.</div></div>';
    }
    beschikbaar.forEach(function (d, i) {
      html += '<div class="row" data-act="add-from-library" data-key="' + d.key + '" style="cursor:pointer' + (i === 0 ? ';border-top:none' : '') + '">';
      html += '<div class="grow"><div class="name">' + esc(d.naam) + ' <span class="sfb-tag">NL-SfB ' + esc(d.sfb) + '</span></div><div class="meta">' + esc(d.categorie) + ' · cyclus ' + d.cyclus + ' jaar</div></div>';
      html += '<div class="chev" style="color:var(--blue)">+</div></div>';
    });
    html += '</div></div>';

    html += '<div class="section"><div class="card pad">';
    html += '<div style="font:500 13.5px/1.35 DM Sans,sans-serif">Of leg een eigen post vast</div>';
    html += '<div class="input-row" style="margin-top:11px"><div class="label">Naam</div><input id="add-el-naam" data-bind="add-el-naam" value="' + esc(f.naam) + '" style="width:170px;text-align:left" /></div>';
    html += '<div class="input-row"><div class="label">Jaar</div><input id="add-el-jaar" data-bind="add-el-jaar" value="' + f.jaar + '" /></div>';
    html += '<div class="input-row"><div class="label">Bedrag</div><input id="add-el-bedrag" data-bind="add-el-bedrag" value="' + f.bedrag + '" class="wide" /></div>';
    html += '<div class="input-row"><div class="label">Cyclus in jaren (optioneel, leeg = eenmalig)</div><input id="add-el-cyclus" data-bind="add-el-cyclus" value="' + (f.cyclus || '') + '" /></div>';
    html += '<div class="btn-row"><div class="primary-btn" data-act="save-add-element">Toevoegen</div><div class="ghost-btn" data-act="cancel-add-element">Annuleer</div></div>';
    html += '</div></div>';
    return html;
  }

  function renderElementDetail(id) {
    var el = state.elements.filter(function (e) { return e.id === id; })[0];
    if (!el) { state.activeElementId = null; return renderGebouw(); }
    var html = '<div style="padding:20px 0 8px">';
    html += '<div class="top-nav"><div class="back-link" data-act="close-element">‹ Gebouw</div></div>';
    html += '<div style="padding:0 22px">';
    html += '<div class="eyebrow">' + esc(el.categorie) + (el.sfb ? ' · NL-SfB ' + esc(el.sfb) : '') + ' · cyclus ' + el.cyclus + ' jaar</div>';
    html += '<div class="page-title" style="font-size:24px;margin-top:8px">' + esc(el.naam) + '</div>';
    html += '</div>';

    if (el.type === 'kozijnen') html += renderKozijnen(el);
    if (el.type === 'dak' || el.type === 'gevel' || el.type === 'per-unit') html += renderHoeveelheidKengetal(el);
    if (el.type === 'steiger') html += renderSteiger(el);
    if (el.type === 'custom') html += renderCustomBewerken(el);
    html += renderGebreken(el);

    var jaar = conditionYear(el);
    var bedrag = elementCost(el, state);
    html += '<div class="section"><div class="card pad">';
    html += '<div class="kv"><div class="label">Eerstvolgende beurt</div><div class="amount" style="font-size:19px">' + jaar + '</div></div>';
    html += '<div class="divider"></div>';
    html += '<div class="kv strong"><div class="label">Geraamde kosten</div><div class="amount">' + eur(bedrag) + '</div></div>';
    html += '</div></div>';

    html += renderOffertes(el);

    html += '</div>';
    return html;
  }

  function renderCustomBewerken(el) {
    var prijspeil = el.basisjaar != null ? el.basisjaar : CURRENT_YEAR;
    var html = '<div class="section"><div class="section-title">Post bewerken</div>';
    html += '<div class="card pad" style="margin-top:11px">';
    html += '<div class="input-row" style="margin-top:0"><div class="label">Jaar</div><input data-bind="el-jaar" data-id="' + el.id + '" value="' + el.jaar + '" /></div>';
    html += '<div class="input-row"><div class="label">Cyclus (jaar, 0 = eenmalig)</div><input data-bind="el-cyclus" data-id="' + el.id + '" value="' + (el.cyclus || 0) + '" /></div>';
    html += '<div class="input-row"><div class="label">Bedrag</div><input data-bind="el-bedrag" data-id="' + el.id + '" value="' + el.bedrag + '" /></div>';
    html += '<div class="input-row"><div class="label">Prijspeil van dit bedrag</div><input data-bind="el-basisjaar" data-id="' + el.id + '" value="' + prijspeil + '" /></div>';
    html += '<div class="hint">Heb je inmiddels een offerte met een actueel bedrag? Vul dat bedrag in en zet het prijspeil op ' + CURRENT_YEAR + ', dan wordt het niet meer extra geïndexeerd.</div>';
    html += '</div></div>';
    return html;
  }

  function renderGebreken(el) {
    var suggesties = GEBREK_SUGGESTIES[el.categorie] || GEBREK_SUGGESTIES.Overig;
    var score = conditionScore(el);
    var html = '<div class="section"><div class="section-title">Gebreken (NEN 2767-methodiek)</div>';
    html += '<div class="card" style="margin-top:11px">';
    if (!el.gebreken.length) {
      html += '<div class="row" style="border-top:none"><div class="grow meta" style="font-size:12.5px">Nog geen gebreken vastgelegd — het plan gaat uit van de standaardcyclus vanaf het bouwjaar.</div></div>';
    }
    el.gebreken.forEach(function (g, gi) {
      html += '<div class="row" style="align-items:flex-start' + (gi === 0 ? ';border-top:none' : '') + '">';
      html += '<div class="grow">';
      html += '<input id="gb-naam-' + el.id + '-' + gi + '" data-bind="gb-naam" data-id="' + el.id + '" data-gi="' + gi + '" value="' + esc(g.omschrijving) + '" list="gb-sug-' + el.id + '" style="width:100%;box-sizing:border-box;border:1px solid var(--ink-14);border-radius:8px;padding:6px 8px;font:500 12.5px DM Sans,sans-serif" placeholder="omschrijving gebrek" />';
      ['ernst', 'omvang', 'intensiteit'].forEach(function (dim) {
        html += '<div style="display:flex;align-items:center;gap:8px;margin-top:8px">';
        html += '<div style="width:64px;font:400 11px/1.3 DM Sans,sans-serif;color:var(--ink-50);text-transform:capitalize">' + dim + '</div>';
        html += '<div class="seg" style="margin-top:0;flex:1">';
        [1, 2, 3].forEach(function (v) {
          html += '<div class="seg-opt' + (g[dim] === v ? ' active' : '') + '" style="padding:7px 0" data-act="gb-set" data-id="' + el.id + '" data-gi="' + gi + '" data-dim="' + dim + '" data-val="' + v + '">' + v + '</div>';
        });
        html += '</div></div>';
      });
      html += '</div>';
      html += '<div class="linkish" style="margin-top:2px;font-size:11px" data-act="gb-del" data-id="' + el.id + '" data-gi="' + gi + '">verwijder</div>';
      html += '</div>';
    });
    html += '<datalist id="gb-sug-' + el.id + '">' + suggesties.map(function (s) { return '<option value="' + esc(s) + '">'; }).join('') + '</datalist>';
    html += '<div class="row" style="cursor:pointer" data-act="gb-add" data-id="' + el.id + '"><div class="grow" style="font:500 13px DM Sans,sans-serif;color:var(--blue)">+ Gebrek toevoegen</div></div>';
    html += '</div>';

    html += '<div class="result-box' + (score == null ? '' : (score >= 4 ? ' bad' : ' good')) + '">';
    html += '<div class="label">' + (score == null ? 'Nog niet beoordeeld' : 'Conditiescore volgens NEN 2767-methodiek') + '</div>';
    html += '<div class="head">' + (score == null ? 'Geen gebreken vastgelegd' : score + ' — ' + CONDITIE_LABELS[score]) + '</div>';
    html += '<div class="body">' + (score == null
      ? 'Leg een gebrek vast (ernst, omvang, intensiteit) om het jaar van vervanging op de werkelijke toestand te baseren.'
      : 'Het zwaarste vastgelegde gebrek bepaalt de score. Dit is een praktische toepassing van de NEN 2767-systematiek voor planningsdoeleinden, geen vervanging voor een inspectie door een gecertificeerd inspecteur.') + '</div>';
    html += '</div></div>';
    return html;
  }

  function renderHoeveelheidKengetal(el) {
    var label = el.type === 'per-unit' ? 'Aantal units' : 'Oppervlak in m²';
    var html = '<div class="section"><div class="card pad">';
    html += '<div class="input-row" style="margin-top:0"><div class="label">' + label + '</div><input id="hv-' + el.id + '" data-bind="el-hoeveelheid" data-id="' + el.id + '" value="' + el.hoeveelheid + '" /></div>';
    html += '<div class="input-row"><div class="label">Kengetal per eenheid</div><input id="kg-' + el.id + '" data-bind="el-kengetal" data-id="' + el.id + '" value="' + el.kengetal + '" /></div>';
    if (el.type === 'dak' && !state.building.isVoorbeeld) {
      html += '<div class="hint">Dakoppervlak komt uit de 3D BAG (echt dakvlak, plat + schuin). Pas het aan als een offerte of opname iets anders laat zien.</div>';
    }
    html += '</div></div>';
    return html;
  }

  function renderSteiger(el) {
    var html = '<div class="section"><div class="card pad">';
    html += '<div class="input-row" style="margin-top:0"><div class="label">Buitenmuur in m²</div><input id="hv-' + el.id + '" data-bind="el-hoeveelheid" data-id="' + el.id + '" value="' + el.hoeveelheid + '" /></div>';
    html += '<div class="input-row"><div class="label">Werkhoogte in m</div><input id="wh-' + el.id + '" data-bind="el-werkhoogte" data-id="' + el.id + '" value="' + el.werkhoogte + '" /></div>';
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
      html += '<div class="row" style="border-top:none"><div class="grow meta" style="font-size:12.5px">Nog geen offertes toegevoegd voor dit element.</div></div>';
    }
    offs.forEach(function (o, oi) {
      var totaal = o.regels.reduce(function (a, r) { return a + num(r.bedrag); }, 0);
      if (o.btw) totaal = totaal * 1.21;
      html += '<div class="row" style="align-items:flex-start' + (oi === 0 ? ';border-top:none' : '') + '">';
      html += '<div class="grow">';
      html += '<div class="name" style="font-weight:500">' + esc(o.naam) + '</div>';
      o.regels.forEach(function (r, ri) {
        html += '<div style="display:flex;gap:8px;margin-top:6px">';
        html += '<input id="of-' + o.id + '-naam-' + ri + '" data-bind="of-regel-naam" data-oid="' + o.id + '" data-ri="' + ri + '" value="' + esc(r.naam) + '" style="flex:1;border:1px solid var(--ink-14);border-radius:8px;padding:5px 7px;font:400 11.5px DM Sans,sans-serif" placeholder="regel" />';
        html += '<input id="of-' + o.id + '-bedrag-' + ri + '" data-bind="of-regel-bedrag" data-oid="' + o.id + '" data-ri="' + ri + '" value="' + esc(r.bedrag) + '" style="width:80px;border:1px solid var(--ink-14);border-radius:8px;padding:5px 7px;text-align:right;font:500 11.5px DM Mono,monospace" placeholder="€" />';
        html += '<button data-act="of-del-regel" data-oid="' + o.id + '" data-ri="' + ri + '" style="border:none;background:none;color:var(--ink-45);cursor:pointer">×</button>';
        html += '</div>';
      });
      html += '<div style="margin-top:8px" class="linkish" data-act="of-add-regel" data-oid="' + o.id + '">+ regel toevoegen</div>';
      html += '<div class="toggle-row" style="margin-top:9px" data-act="of-toggle-btw" data-oid="' + o.id + '">';
      html += '<div class="grow" style="font:400 11.5px DM Sans,sans-serif">' + (o.btw ? 'inclusief 21% btw' : 'exclusief btw') + '</div>';
      html += '<div class="toggle' + (o.btw ? ' on' : '') + '"><div class="knob"></div></div></div>';
      html += '</div>';
      html += '<div style="text-align:right"><div class="value" style="font-size:14px">' + eur(totaal) + '</div>';
      html += '<div class="linkish" style="margin-top:6px;font-size:11px" data-act="of-del" data-oid="' + o.id + '">verwijder</div></div>';
      html += '</div>';
    });
    html += '<div class="row" style="cursor:pointer" data-act="of-add">';
    html += '<div class="grow" style="font:500 13px DM Sans,sans-serif;color:var(--blue)">+ Offerte toevoegen</div></div>';
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
      html += '<div class="ct-head-col"><span class="ct-rang" style="background:' + (rang === 1 ? '#E7EFE6' : 'rgba(36,31,27,.06)') + ';color:' + (rang === 1 ? '#3F6B46' : 'rgba(36,31,27,.5)') + '">#' + rang + '</span><div class="ct-colname">' + esc(o.naam) + '</div></div>';
    });
    html += '</div>';
    regelNamen.forEach(function (naam) {
      html += '<div class="ct-row"><div class="c1">' + esc(naam) + '</div>';
      offs.forEach(function (o, oi) {
        var v = cellValue(o, naam);
        var missing = v == null;
        var shown = missing ? (bijvul ? fallbackFor(naam, oi) : null) : v;
        html += '<div class="ct-cell" style="background:' + (missing && bijvul ? '#F6EFD9' : 'transparent') + ';color:' + (missing ? '#8A6414' : 'rgba(36,31,27,.7)') + '">' + (shown == null ? '—' : shown.toLocaleString('nl-NL')) + '</div>';
      });
      html += '</div>';
    });
    html += '<div class="ct-total"><div class="c1">Totaal</div>';
    totals.forEach(function (t) { html += '<div class="amount">' + eur(t) + '</div>'; });
    html += '</div></div>';

    html += '<div class="toggle-row" style="margin-top:12px;background:#fff;border:1px solid var(--ink-10);border-radius:18px;padding:15px 16px" data-act="toggle-bijvullen" data-id="' + el.id + '">';
    html += '<div class="grow" style="font:400 12.5px/1.45 DM Sans,sans-serif">' + (bijvul ? 'Ontbrekende regels bijgevuld met het gemiddelde van de andere offertes' : 'Alleen wat de aannemers hebben opgeschreven') + '</div>';
    html += '<div class="toggle' + (bijvul ? ' on' : '') + '"><div class="knob"></div></div></div>';
    html += '</div>';
    return html;
  }

  function renderPlanning() {
    var rows = kasstroom(state);
    var plan = fullPlan(state);
    var totaal = rows.reduce(function (a, r) { return a + r.kosten; }, 0);
    var html = '<div style="padding:24px 0 8px">';
    html += '<div style="padding:0 22px"><div class="page-title">Planning</div>';
    html += '<div class="page-sub">' + CURRENT_YEAR + ' – ' + (CURRENT_YEAR + HORIZON - 1) + ' · ' + eur(totaal) + ' totaal</div></div>';
    html += '<div class="section timeline">';
    rows.forEach(function (r) {
      var posten = plan.filter(function (p) { return p.jaar === r.jaar; });
      html += '<div class="tl-row"><div class="tl-year" style="color:' + (r.saldo < 0 ? '#B4531F' : 'rgba(36,31,27,.55)') + '">' + r.jaar + '</div>';
      html += '<div class="tl-dot-col"><div class="tl-dot" style="background:' + (r.saldo < 0 ? '#E8845C' : (posten.length ? '#1F4E79' : 'rgba(36,31,27,.2)')) + '"></div><div class="tl-line"></div></div>';
      html += '<div class="tl-body">';
      if (!posten.length) html += '<div class="tl-empty">niets gepland</div>';
      posten.forEach(function (p) {
        html += '<div class="tl-post" data-act="open-element" data-id="' + p.elId + '" style="cursor:pointer"><div class="grow"><div class="name">' + esc(p.naam) + '</div><div class="meta">' + esc(p.meta) + '</div></div><div class="amount">' + eur(p.bedrag) + '</div></div>';
      });
      html += '</div>';
      html += '<div class="tl-saldo" style="color:' + (r.saldo < 0 ? '#B4531F' : 'rgba(36,31,27,.38)') + '">' + (r.saldo < 0 ? '−' : '') + '€ ' + Math.round(Math.abs(r.saldo) / 1000) + 'k</div>';
      html += '</div>';
    });
    html += '</div></div>';
    return html;
  }

  function renderRapport() {
    var b = state.building;
    var rows = kasstroom(state);
    var totaal = rows.reduce(function (a, r) { return a + r.kosten; }, 0);
    var beoordeeld = state.elements.filter(isAssessed).length;
    var laagste = Math.min.apply(null, rows.map(function (r) { return r.saldo; }));
    var eerste = rows.filter(function (r) { return r.saldo < 0; })[0];
    var nodig = Math.max(5, Math.ceil((totaal - state.fonds) / (10 * 12 * Math.max(1, b.units)) / 5) * 5);

    var html = '<div style="padding:24px 0 8px">';
    html += '<div style="padding:0 22px"><div class="page-title">Rapport</div>';
    html += '<div class="page-sub">' + esc(b.adres) + ' · ' + beoordeeld + ' van ' + state.elements.length + ' elementen beoordeeld</div></div>';

    html += '<div class="section"><div class="card pad">';
    html += '<div style="font:500 14.5px/1.3 DM Sans,sans-serif">MJOP ' + CURRENT_YEAR + '–' + (CURRENT_YEAR + HORIZON - 1) + '</div>';
    html += '<div class="hint" style="margin-top:5px">Conditie per element, kostenopbouw en het voorstel voor de maandbijdrage.</div>';
    html += '<div class="btn-row"><div class="primary-btn" data-act="print-rapport">Afdrukken / PDF</div><div class="ghost-btn" data-act="export-csv">Exporteer CSV</div></div>';
    html += '</div></div>';

    html += '<div class="section"><div class="card pad">';
    html += '<div style="font:500 13.5px/1.3 DM Sans,sans-serif">Voorstel voor de vergadering</div>';
    html += '<div style="display:flex;align-items:baseline;gap:9px;margin-top:10px">';
    html += '<div style="font:500 26px/1 DM Mono,monospace;color:var(--blue)">' + eur(eerste ? nodig : state.bijdrage) + '</div>';
    html += '<div style="font:400 12px/1.3 DM Sans,sans-serif;color:var(--ink-60)">per appartement per maand</div></div>';
    html += '<div class="hint">' + (eerste
      ? 'Bij de huidige bijdrage van ' + eur(state.bijdrage) + ' raakt het fonds in ' + eerste.jaar + ' leeg.'
      : 'Bij ' + eur(state.bijdrage) + ' per maand blijft het fonds ' + HORIZON + ' jaar positief, met ' + eur(laagste) + ' als laagste stand.') + '</div>';
    html += '</div></div>';

    html += '<div class="section"><div class="section-title">Elementen</div><div class="card" style="margin-top:11px">';
    state.elements.forEach(function (el, i) {
      var score = conditionScore(el);
      var colors = scoreColors(score);
      html += '<div class="row"' + (i === 0 ? ' style="border-top:none"' : '') + '>';
      html += '<div class="el-badge" style="background:' + colors[0] + ';color:' + colors[1] + '">' + (score == null ? '?' : score) + '</div>';
      html += '<div class="grow"><div class="name">' + esc(el.naam) + (el.sfb ? ' <span class="sfb-tag">NL-SfB ' + esc(el.sfb) + '</span>' : '') + '</div><div class="meta">volgende beurt ' + conditionYear(el) + '</div></div>';
      html += '<div class="value">' + eur(elementCost(el, state)) + '</div></div>';
    });
    html += '</div></div>';

    html += '<div class="footer-note">Bronnen: PDOK Locatieserver en BAG (Public Domain Mark 1.0), 3D BAG van de TU Delft (CC BY 4.0). Kengetallen zijn indicatieve richtprijzen, geen offerte.</div>';
    html += '</div>';
    return html;
  }

  // ---------------------------------------------------------------------
  // Actions (click) and Binds (input/change)
  // ---------------------------------------------------------------------
  var searchTimer = null;

  var ACTIONS = {
    'skip-onboarding': function () { applyBuilding(defaultBuilding()); render(); },
    'wijzig-adres': function () { state.screen = 'onboarding'; state.onboarding = { q: '', sug: [], bezig: false, bezigTekst: '', fout: '' }; render(); },
    'kies-adres': function (d) {
      var s = state.onboarding;
      s.sug = []; s.q = d.naam; s.bezig = true; s.bezigTekst = 'Adres opzoeken in de BAG…'; s.fout = '';
      render();
      lookupBuilding(d.id, d.naam).then(function (building) {
        s.bezig = false;
        applyBuilding(building);
        render();
      }).catch(function (err) {
        s.bezig = false;
        s.fout = 'Dit adres lukt niet: ' + (err && err.message ? err.message : 'onbekende fout') + '. Probeer een ander huisnummer, of begin met een voorbeeldgebouw.';
        render();
      });
    },
    'dismiss-idx': function () { state.idxBalk = false; render(); },
    'set-tab': function (d) { state.tab = d.tab; state.activeElementId = null; render(); },
    'set-filter': function (d) { state.filter = d.filter; render(); },
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
    'zet-advies': function (d) { state.bijdrage = clamp(+d.nodig, 10, 400); render(); },
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
    'print-rapport': function () { window.print(); },
    'export-csv': function () { exportCsv(); },
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
      if (!state.fonds) state.fonds = defaultBuilding().units * 2500;
      state.upload = null;
      applyBuilding(state.building || defaultBuilding());
      render();
    },
  };

  var BINDS = {
    'addr-q': function (t) {
      var s = state.onboarding;
      s.q = t.value; s.fout = '';
      clearTimeout(searchTimer);
      if (t.value.trim().length < 4) { s.sug = []; return; }
      searchTimer = setTimeout(function () {
        suggestAddress(t.value).then(function (sug) { s.sug = sug; render(); })
          .catch(function () { s.fout = 'Kon de adressenservice niet bereiken.'; render(); });
      }, 280);
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
  };

  var CHANGES = {
    'bijdrage': function (t) { state.bijdrage = +t.value; render(); },
    'koz-materiaal': function (t, d) { var el = findEl(d.id); if (el) el.koz[+d.i].materiaal = t.value; render(); },
    'upload-map': function (t, d) { state.upload.mapping[d.veld] = +t.value; render(); },
  };

  function uploadError(err) {
    state.upload = { stap: 'fout', bestandsnaam: state.upload && state.upload.bestandsnaam, foutTekst: (err && err.message) || 'Onbekende fout bij het lezen van dit bestand.' };
    render();
  }

  function handleUploadFile(file) {
    var ext = (file.name.split('.').pop() || '').toLowerCase();
    state.upload = { stap: 'laden', bestandsnaam: file.name };
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
      return r.map(function (v) { return '"' + String(v).replace(/"/g, '""') + '"'; }).join(',');
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
    root.addEventListener('click', function (e) {
      var t = e.target.closest('[data-act]');
      if (!t) return;
      var handler = ACTIONS[t.dataset.act];
      if (handler) { e.preventDefault(); handler(t.dataset, e); }
    });
    root.addEventListener('input', function (e) {
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
