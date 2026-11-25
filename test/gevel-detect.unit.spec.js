'use strict';
// Unittest supabase/functions/gevel-detect/core.mjs: omzetten van modelantwoorden (Claude, Gemini, SAM 3) naar één
// elementlijst, de combinatie taalmodel + SAM 3 en detect() met een nep-netwerk (geen echte aanroepen, geen sleutels).
//   node test/gevel-detect.unit.spec.js
var checks = [];
function check(n, ok, d) { checks.push([n, !!ok, d]); }

(async function () {
  var C = await import('../supabase/functions/gevel-detect/core.mjs');
  var IMG = { base64: Buffer.from('nep-foto').toString('base64'), mediaType: 'image/jpeg', width: 2000, height: 1000 };

  // 1. Genormaliseerde coördinaten (0-1000, y eerst) worden pixels; onbekend type en onbruikbare geometrie worden overgeslagen.
  var n = C.normalizeLlmElements({ elements: [
    { type: 'kozijn_raam', box_2d: [100, 200, 300, 400], material: 'hout', confidence: 'high', note: '' },
    { type: 'hwa', points: [[0, 500], [1000, 500]], confidence: 'medium' },
    { type: 'hwa', box_2d: [100, 900, 900, 910], confidence: 'low' },
    { type: 'metselwerk', points: [[0, 0], [0, 1000], [1000, 1000]] },
    { type: 'schoorsteen', box_2d: [0, 0, 10, 10] },
    { type: 'kozijn_raam', box_2d: [300, 400, 100, 200] },
    { type: 'kozijn_deur', box_2d: [1, 2, 'x', 4] },
  ] }, 2000, 1000);
  check('1a. raamkozijn naar pixels (x = 200/1000 × 2000)', JSON.stringify(n.elements[0].points) === JSON.stringify([[400, 100], [800, 300]]), JSON.stringify(n.elements[0].points));
  check('1b. zekerheid wordt een getal, label blijft bewaard', n.elements[0].confidence === 0.9 && n.elements[0].confidence_label === 'high');
  check('1c. lijnelement als lijst punten', n.elements[1].kind === 'line' && n.elements[1].points.length === 2);
  check('1d. lijnelement dat als kader terugkomt wordt de middellijn', n.elements[2].points[0][1] === 100 && n.elements[2].points[1][1] === 900, JSON.stringify(n.elements[2].points));
  check('1e. drie overgeslagen (onbekend type, omgekeerd kader, ongeldig getal)', n.skipped === 3 && n.elements.length === 4, 'skipped=' + n.skipped);
  var threw = false; try { C.normalizeLlmElements({ foo: 1 }, 10, 10); } catch (e) { threw = true; }
  check('1f. antwoord zonder elementenlijst is een fout, geen lege uitkomst', threw);

  // 2. JSON uit een antwoord met codeblok en tekst eromheen.
  check('2. JSON uit ```json-blok', C.extractJson('Hier:\n```json\n{"elements": []}\n```\nKlaar.').elements.length === 0);

  // 3. SAM 3: masker → omsluitend kader (kozijn) of middellijn (hwa); masker gaat mee als bewijs.
  var s = C.parseSam3Response({ resolved_model: { model_id: 'sam3/sam3_final' }, prompt_results: [
    { prompt_index: 0, predictions: [{ confidence: 0.91, masks: [[[410, 110], [790, 110], [790, 290], [410, 290]]] }, { confidence: 0.5, masks: [[[1, 1]]] }] },
    { prompt_index: 1, predictions: [{ confidence: 0.7, masks: [[[995, 50], [1005, 50], [1005, 950], [995, 950]]] }] },
  ] }, IMG, ['kozijn_raam', 'hwa']);
  check('3a. kader van het masker', JSON.stringify(s.elements[0].points) === JSON.stringify([[410, 110], [790, 290]]), JSON.stringify(s.elements[0].points));
  check('3b. masker bewaard, herkomst SAM3_MASK', s.elements[0].polygon.length === 4 && s.elements[0].geometry_origin === 'SAM3_MASK');
  check('3c. hwa wordt verticale middellijn', s.elements[1].points[0][0] === 1000 && s.elements[1].points[0][1] === 50 && s.elements[1].points[1][1] === 950, JSON.stringify(s.elements[1].points));
  check('3d. masker met te weinig punten overgeslagen', s.skipped === 1 && s.served_model === 'sam3/sam3_final');

  // 4. Combinatie: twee SAM-maskers (twee ramen) binnen één kozijn van het taalmodel → één kozijn, strakker kader.
  var llm = { skipped: 0, elements: [
    { type: 'kozijn_raam', kind: 'quad', points: [[390, 95], [820, 310]], geometry_origin: 'LLM_BOX' },
    { type: 'kozijn_raam', kind: 'quad', points: [[1500, 500], [1600, 600]], geometry_origin: 'LLM_BOX' },
    { type: 'metselwerk', kind: 'poly', points: [[0, 0], [10, 0], [10, 10]], geometry_origin: 'LLM_BOX' },
  ] };
  var sam = { elements: [
    { type: 'kozijn_raam', kind: 'quad', points: [[400, 100], [590, 300]], confidence: 0.9 },
    { type: 'kozijn_raam', kind: 'quad', points: [[600, 100], [800, 300]], confidence: 0.9 },
    { type: 'kozijn_raam', kind: 'quad', points: [[1800, 100], [1900, 200]], confidence: 0.8 },
  ] };
  var c = C.combine(llm, sam);
  check('4a. kozijn blijft één element (aantal van het taalmodel)', c.elements.length === 3);
  check('4b. kader wordt omsluitend kader van beide maskers', JSON.stringify(c.elements[0].points) === JSON.stringify([[400, 100], [800, 300]]) && c.elements[0].refined_by.masks === 2, JSON.stringify(c.elements[0]));
  check('4c. oorspronkelijk kader blijft bewaard', JSON.stringify(c.elements[0].refined_by.llm_box) === JSON.stringify([[390, 95], [820, 310]]));
  check('4d. zonder passend masker blijft het kader van het taalmodel', c.elements[1].geometry_origin === 'LLM_BOX' && c.elements[1].refined_by === null);
  check('4e. los masker wordt gemeld, niet toegevoegd', c.unmatched_segments.length === 1 && c.unmatched_segments[0].points[0][0] === 1800);
  check('4f. muurvlak ongemoeid', c.elements[2].geometry_origin === 'LLM_BOX' && !('refined_by' in c.elements[2]));

  // 4g-4i. Veiligheden uit de eerste echte test: een "window"-masker verfijnt geen deur, en een te klein masker geen kozijn.
  var c2 = C.combine({ skipped: 0, elements: [
    { type: 'garagedeur', kind: 'quad', points: [[186, 1160], [321, 1280]], geometry_origin: 'LLM_BOX' },
    { type: 'kozijn_raam', kind: 'quad', points: [[186, 970], [321, 1160]], geometry_origin: 'LLM_BOX' },
    { type: 'kozijn_raam', kind: 'quad', points: [[400, 970], [500, 1160]], geometry_origin: 'LLM_BOX' },
  ] }, { elements: [
    { type: 'kozijn_raam', kind: 'quad', points: [[189, 1171], [321, 1193]], confidence: 0.5 },
    { type: 'kozijn_raam', kind: 'quad', points: [[188, 978], [321, 1107]], confidence: 0.8 },
    { type: 'kozijn_raam', kind: 'quad', points: [[440, 1000], [470, 1030]], confidence: 0.6 },
  ] });
  check('4g. raammasker verfijnt de garagedeur niet', c2.elements[0].geometry_origin === 'LLM_BOX' && JSON.stringify(c2.elements[0].points) === JSON.stringify([[186, 1160], [321, 1280]]), JSON.stringify(c2.elements[0]));
  check('4h. raam wordt wel verfijnd met het raammasker', c2.elements[1].geometry_origin === 'LLM_BOX_REFINED_BY_SAM3' && c2.elements[1].points[1][1] === 1107, JSON.stringify(c2.elements[1]));
  check('4i. te klein masker: kader blijft, met reden', c2.elements[2].geometry_origin === 'LLM_BOX' && c2.elements[2].refine_rejected.reason === 'SAM3_KADER_TE_KLEIN', JSON.stringify(c2.elements[2]));
  check('4j. glasstrook boven de garagedeur blijft gemeld als los masker', c2.unmatched_segments.some(function (u) { return u.points[0][1] === 1171; }));

  // 4k-4n. Hoeveelheden met een schaal van 100 px per meter.
  var qv = C.quantities([
    { type: 'metselwerk', kind: 'poly', points: [[0, 0], [1000, 0], [1000, 500], [0, 500]] },
    { type: 'kozijn_raam', kind: 'quad', points: [[100, 100], [300, 250]] },
    { type: 'kozijn_deur', kind: 'quad', points: [[400, 250], [500, 480]] },
    { type: 'garagedeur', kind: 'quad', points: [[1100, 100], [1300, 300]] },
    { type: 'hwa', kind: 'line', points: [[950, 0], [950, 300], [950, 500]] },
    { type: 'balkon', kind: 'quad', points: [[0, 0], [10, 10]] },
  ], 100);
  check('4k. ramen: 1 stuk, 2 × 1,5 = 3 m²', qv.ramen_st === 1 && qv.ramen_m2 === 3, JSON.stringify(qv));
  check('4l. deur 1 × 2,3 = 2,3 m²; garagedeur buiten het muurvlak telt wel als garagedeur', qv.deuren_m2 === 2.3 && qv.garagedeuren_st === 1 && qv.garagedeuren_m2 === 4);
  check('4m. metselwerk bruto 50 m², netto min raam en deur = 44,7 m² (garagedeur ligt erbuiten)', qv.metselwerk_bruto_m2 === 50 && qv.metselwerk_netto_m2 === 44.7, qv.metselwerk_netto_m2);
  check('4n. hwa 5 m1, ontbrekende goot null (niet 0), zonder schaal geen hoeveelheden', qv.hwa_m1 === 5 && qv.dakgoot_m1 === null && C.quantities([], 0) === null);

  // 5. Kosten alleen met ingestelde prijs.
  check('5a. geen prijs → geen kosten', C.estimateCost({ input_tokens: 1000, output_tokens: 100 }, null) === null);
  check('5b. met prijs → kosten', C.estimateCost({ input_tokens: 1e6, output_tokens: 1e6 }, { input_per_mtok: 1, output_per_mtok: 2 }) === 3);

  // 6. detect() met nep-netwerk: juiste ingang en sleutelheader per aanbieder, combinatie, fout bij één aanbieder stopt de rest niet.
  var calls = [];
  async function fakeFetch(url, init) {
    calls.push({ url: url, headers: init.headers, body: JSON.parse(init.body) });
    var body;
    if (url.indexOf('generativelanguage') >= 0) body = { model: 'gemini-test', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      choices: [{ finish_reason: 'stop', message: { content: '{"elements":[{"type":"kozijn_raam","box_2d":[95,195,310,410],"confidence":"high","material":"","note":""}]}' } }] };
    else if (url.indexOf('roboflow') >= 0) body = { resolved_model: { model_id: 'sam3/sam3_final' }, prompt_results: [{ prompt_index: 0, predictions: [{ confidence: 0.9, masks: [[[400, 100], [800, 100], [800, 300], [400, 300]]] }] }, { prompt_index: 1, predictions: [] }] };
    else return { ok: false, status: 401, text: async function () { return '{"error":"unauthorized"}'; } };
    return { ok: true, status: 200, text: async function () { return JSON.stringify(body); } };
  }
  var t = 0;
  var r = await C.detect({ image: IMG, providers: ['gemini', 'sam3', 'gemini+sam3', 'claude'], keys: { gemini: 'G', sam3: 'R', claude: 'A' }, fetch: fakeFetch, now: function () { return (t += 10); } });
  var by = {}; r.results.forEach(function (x) { by[x.provider] = x; });
  var gCall = calls.find(function (x) { return x.url.indexOf('generativelanguage') >= 0; });
  var sCall = calls.find(function (x) { return x.url.indexOf('roboflow') >= 0; });
  var aCall = calls.find(function (x) { return x.url.indexOf('anthropic') >= 0; });
  check('6a. Gemini: sleutel als Bearer, niet in de body', gCall.headers.authorization === 'Bearer G' && JSON.stringify(gCall.body).indexOf('"G"') < 0);
  check('6b. SAM 3: sleutel als Bearer, begrippen window en drainpipe', sCall.headers.authorization === 'Bearer R' && sCall.body.prompts.map(function (p) { return p.text; }).join(',') === 'window,drainpipe');
  check('6c. Claude: sleutel in x-api-key', aCall.headers['x-api-key'] === 'A');
  check('6d. elke aanbieder één keer aangeroepen (combinatie hergebruikt)', calls.length === 3, calls.length);
  check('6e. Gemini-uitkomst met model, promptversie en tokens', by.gemini.served_model === 'gemini-test' && by.gemini.prompt_version === C.PROMPT_VERSION && by.gemini.usage.total_tokens === 15 && by.gemini.counts.kozijn_raam === 1);
  check('6f. combinatie verfijnt het kozijn', by['gemini+sam3'].elements[0].geometry_origin === 'LLM_BOX_REFINED_BY_SAM3' && JSON.stringify(by['gemini+sam3'].elements[0].points) === JSON.stringify([[400, 100], [800, 300]]), JSON.stringify(by['gemini+sam3'].elements[0]));
  check('6g. fout bij Claude wordt gemeld, de rest werkt', /HTTP 401/.test(by.claude.error) && !by.gemini.error && !by.sam3.error);
  check('6h. hash van de foto vastgelegd', /^[0-9a-f]{64}$/.test(r.photo_sha256));
  var r2 = await C.detect({ image: IMG, providers: ['gemini'], keys: {}, fetch: fakeFetch });
  check('6i. zonder sleutel geen aanroep, wel een duidelijke fout', /Geen sleutel/.test(r2.results[0].error) && calls.length === 3);

  // 7. Scorescript: koppelen op foto-hash, IoU ≥ 0,5, raam/deur-verwisseling telt mee bij "kozijnen samen".
  var E = await import('../scripts/gevel-eval.mjs');
  var truth = { contract: 'gevel_testset_v1', photo: 'a.jpg', photo_sha256: 'aa', split: 'dev', image: { width: 1000, height: 800 }, elements: [
    { type: 'kozijn_raam', points: [[100, 100], [200, 200]] }, { type: 'kozijn_raam', points: [[300, 100], [400, 200]] },
    { type: 'kozijn_deur', points: [[500, 400], [580, 700]] }, { type: 'hwa', points: [[700, 50], [700, 750]] } ] };
  var det = { photo_sha256: 'aa', results: [{ provider: 'x', elements: [
    { type: 'kozijn_raam', kind: 'quad', points: [[105, 105], [205, 205]] },
    { type: 'kozijn_raam', kind: 'quad', points: [[800, 100], [900, 200]] },
    { type: 'kozijn_raam', kind: 'quad', points: [[500, 400], [580, 700]] },
    { type: 'hwa', kind: 'line', points: [[703, 60], [703, 740]] } ] }, { provider: 'kapot', error: 'HTTP 500', elements: [] }] };
  var ev = E.evaluate([truth, Object.assign({}, truth, { photo: 'b.jpg', photo_sha256: 'bb', split: 'holdout' })], [det], { split: 'dev' });
  var px = ev.providers.x;
  check('7a. raamkozijnen: 1 treffer, 2 vals (waarvan 1 eigenlijk een deur), 1 gemist', px.per_type.kozijn_raam.tp === 1 && px.per_type.kozijn_raam.fp === 2 && px.per_type.kozijn_raam.fn === 1, JSON.stringify(px.per_type.kozijn_raam));
  check('7b. kozijnen samen: deur als raam telt als treffer', px.frames.tp === 2 && px.frames.fp === 1 && px.frames.fn === 1, JSON.stringify(px.frames));
  check('7c. dunne hwa koppelt dankzij verbreding', px.per_type.hwa.tp === 1);
  check('7d. holdout overgeslagen bij split=dev, aanbieder met fout niet gescoord', ev.photos_scored.join() === 'a.jpg' && !ev.providers.kapot && ev.photos_without_prediction.length === 0);
  var ev2 = E.evaluate([truth], [Object.assign({}, det, { photo_sha256: 'andere' })]);
  check('7e. andere foto-hash telt niet mee', ev2.photos_scored.length === 0 && ev2.photos_without_prediction[0] === 'a.jpg');

  // 8. BAG: zijden van een omtrek, pand kiezen met nep-netwerk, schaalpunten uit het muurvlak.
  var B = await import('../src/bag-gevel.mjs');
  var ring = [[0, 0], [20, 0], [20, 10], [10, 10.05], [0, 10], [0, 0]];  // tussenpunt bijna op de rechte bovenzijde
  var sides = B.footprintSides(ring);
  check('8a. rechthoek van 20 × 10 m: vier zijden, bijna rechte stukken samengevoegd', sides.length === 4 && sides.map(function (s) { return Math.round(s.length); }).sort().join() === '10,10,20,20', JSON.stringify(sides.map(function (s) { return [s.length, s.facing]; })));
  check('8b. zuidzijde (y = 0) heeft richting zuid', sides.some(function (s) { return s.facing === 'zuid' && Math.round(s.length) === 20; }));
  var bagCalls = [];
  async function bagFetch(url) {
    bagCalls.push(url);
    var body = url.indexOf('locatieserver') >= 0 ? { response: { docs: [{ weergavenaam: 'Teststraat 1, Testdorp', centroide_rd: 'POINT(105 5)' }] } }
      : { features: [
        { properties: { identificatie: '0000100000000001', bouwjaar: 2020 }, geometry: { type: 'Polygon', coordinates: [[[100, 0], [120, 0], [120, 10], [100, 10], [100, 0]]] } },
        { properties: { identificatie: '0000100000000002' }, geometry: { type: 'Polygon', coordinates: [[[130, 0], [140, 0], [140, 10], [130, 10], [130, 0]]] } }] };
    return { ok: true, json: async function () { return body; } };
  }
  var docs = await B.searchAddress('Teststraat 1', bagFetch);
  var pand = await B.loadPand(docs[0], bagFetch);
  check('8c. adres → punt in RD, pand waar het punt in ligt, buurpand apart', docs[0].pt[0] === 105 && pand.pand.id === '0000100000000001' && pand.neighbours.length === 1 && pand.sides.length === 4);
  check('8d. adres wordt gecodeerd in de zoek-URL', bagCalls[0].indexOf('Teststraat%201') > 0);
  var ends = B.wallEndpoints([{ type: 'kozijn_raam', kind: 'quad', points: [[0, 0], [1, 1]] }, { type: 'metselwerk', kind: 'poly', points: [[123, 924], [1312, 924], [1312, 1280], [123, 1280]] }]);
  check('8e. schaalpunten op linker- en rechterrand van het muurvlak, op de onderrand', JSON.stringify(ends) === JSON.stringify([[123, 1280], [1312, 1280]]), JSON.stringify(ends));
  check('8f. zonder muurvlak geen voorstel', B.wallEndpoints([]) === null);

  var fails = 0;
  checks.forEach(function (c) { if (!c[1]) fails++; console.log((c[1] ? 'OK   ' : 'FOUT ') + c[0] + (c[1] || !c[2] ? '' : '  — ' + c[2])); });
  console.log('\n' + (checks.length - fails) + '/' + checks.length + ' geslaagd');
  process.exit(fails ? 1 : 0);
})().catch(function (e) { console.log('FOUT onverwacht: ' + (e && e.stack || e)); process.exit(1); });
