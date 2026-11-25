// Gevelherkenning met meerdere modellen — gedeelde kern (puur JavaScript, geen afhankelijkheden).
//
// Draait in de Supabase Edge Function (Deno, zie index.ts), in Node (scripts/gevel-detect-run.mjs en de unittest)
// en verandert niets aan de Gevelfoto-pagina zelf. Netwerk gaat uitsluitend via de meegegeven `fetch`.
//
// Rolverdeling (zie de review "MJOP Live: AI, architectuur en business"):
//   herkennen    – een taalmodel met beeld (Claude of Gemini) zegt WAT er is: type, materiaal, zekerheid;
//   lokaliseren  – SAM 3 (segmentatie) zegt WAAR de randen precies liggen;
//   rekenen      – blijft in de Gevelfoto-pagina (vaste regels, homografie); deze kern rekent geen maten of kosten.
//
// Elke uitkomst is herleidbaar: provider, gevraagd en geleverd model, promptversie, sha256 van de foto, tijd en tokens.
// Ongeldige elementen worden overgeslagen en geteld, nooit "gerepareerd" door te gokken.

export const CORE_VERSION = "gevel-detect-core-0.1.0";
export const PROMPT_VERSION = "gevel_detect_v0.2";   // v0.2: ook pandgrenzen (building_boundaries) en doorlopen voorbij de fotorand

// Zelfde typen en geometrie als de Gevelfoto-pagina (gevelfoto/index.html, TYPES).
export const TYPES = {
  kozijn_raam:    { kind: "quad", opening: true },
  kozijn_deur:    { kind: "quad", opening: true },
  garagedeur:     { kind: "quad", opening: true },
  metselwerk:     { kind: "poly" },
  stucwerk:       { kind: "poly" },
  gevelbekleding: { kind: "poly" },
  hwa:            { kind: "line" },
  dakgoot:        { kind: "line" },
  boeiboord:      { kind: "line" },
  waterslag:      { kind: "line" },
  hekwerk:        { kind: "line" },
  balkon:         { kind: "quad" },
  luifel:         { kind: "quad" },
  rooster:        { kind: "quad" },
  overig:         { kind: "quad" },
};

// SAM 3 zoekt op een Engels begrip. Getest op een Nederlandse rijtjesgevel (25-11-2026): "window" en "drainpipe" geven
// maskers; "door", "front door" en "gutter" gaven daar niets. Daarom vraagt de standaardinstelling alleen deze twee.
export const SAM3_CONCEPTS = { kozijn_raam: "window", hwa: "drainpipe" };

export const DEFAULT_MODELS = { claude: "claude-opus-5-5", gemini: "gemini-3.5-flash", sam3: "sam3" };
export const ENDPOINTS = {
  claude: "https://api.anthropic.com/v1/messages",
  // OpenAI-compatibele ingang van Gemini: de sleutel gaat als "Authorization: Bearer".
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
  sam3: "https://serverless.roboflow.com/sam3/concept_segment",
};

const CONFIDENCE = { low: 0.33, medium: 0.66, high: 0.9 };

// Eén prompt voor Claude én Gemini, zodat een vergelijking eerlijk is. Coördinaten genormaliseerd op 0–1000
// (y eerst, zoals Gemini getraind is); de kern rekent ze terug naar pixels van de foto.
export function buildPrompt() {
  const list = Object.entries(TYPES).map(([k, t]) => `- ${k}: ${t.kind === "quad"
    ? '"box_2d": [ymin, xmin, ymax, xmax]'
    : t.kind === "line" ? '"points": [[y, x], [y, x], ...] along the centre line, 2 or more points'
    : '"points": [[y, x], ...] polygon around the surface, 3 or more points in order'}`).join("\n");
  return `This is one photo of a building facade in the Netherlands, taken for a multi-year maintenance plan (MJOP).

Find the building elements that are clearly visible on the facade of the main building in the foreground and report where they are.
All coordinates are normalized to 0-1000 over the image: y first, then x; origin top-left.

Element types and the geometry to return for each:
${list}

Guidelines:
- One physical frame (kozijn) is one element, even when it holds several panes or opening sashes. Box the outer edge of the frame, not the glass. Roof windows and dormer windows are kozijn_raam.
- For a wall surface return one polygon per continuous surface of one material, including the openings that lie in it.
- Report only what you can actually see. Leave out elements that are hidden, that belong to a neighbouring building, or that you would have to guess.
- "material": one short Dutch word when clearly recognisable (hout, kunststof, aluminium, staal, baksteen, zink, pvc, beton), otherwise "".
- "confidence": low, medium or high: how sure you are that the element exists and is of this type.
- "note": at most a few words in Dutch when something limits the result (for example "deels achter boom"), otherwise "".

Building boundaries: several separate buildings (panden) may stand side by side in one continuous street wall. Report the vertical lines where one building ends and the next begins (party walls), as "x" (0-1000 over the image width, at street level). Use visible cues: a change in brick colour or bond, in window rhythm or style, a step in the roof line, cornice or gutter, a vertical joint, a downpipe at a joint. A symmetry axis inside one building is not a boundary. Also say whether the facade continues beyond the left and right edge of the photo. Return an empty list when you see no boundary; do not guess.

Do not estimate sizes in metres, condition, defects or costs.

Return only a JSON object of this shape, with no other text:
{"elements": [{"type": "<type key>", "box_2d": [0, 0, 0, 0], "points": [], "material": "", "confidence": "low|medium|high", "note": ""}],
 "building_boundaries": [{"x": 0, "confidence": "low|medium|high", "reason": "few Dutch words"}], "continues_left": false, "continues_right": false}`;
}

// ------------------------------------------------------------------------------------------------ hulpfuncties

export async function sha256Hex(bytes) {
  const d = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

function finite(n) { return typeof n === "number" && Number.isFinite(n); }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function round1(v) { return Math.round(v * 10) / 10; }

export function bbox(points) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of points) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return [x0, y0, x1, y1];
}
function boxArea(b) { return Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]); }
function boxInter(a, b) { return boxArea([Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])]); }
export function iou(a, b) { const i = boxInter(a, b), u = boxArea(a) + boxArea(b) - i; return u > 0 ? i / u : 0; }

// Haalt het eerste JSON-object of -array uit een modelantwoord (modellen zetten er soms ```json omheen).
export function extractJson(text) {
  if (typeof text !== "string") return null;
  const s = text.replace(/```(?:json)?/g, "");
  const start = s.search(/[[{]/);
  if (start < 0) return null;
  for (let end = s.length; end > start; end--) {
    const ch = s[end - 1];
    if (ch !== "}" && ch !== "]") continue;
    try { return JSON.parse(s.slice(start, end)); } catch (_) { /* korter proberen */ }
  }
  return null;
}

// Zet de elementen van een taalmodel (genormaliseerd 0–1000, y eerst) om naar pixels van de foto (W × H).
// Geeft { elements, skipped }; een element met een onbekend type of onbruikbare geometrie wordt overgeslagen.
export function normalizeLlmElements(obj, W, H) {
  const raw = Array.isArray(obj) ? obj : obj && Array.isArray(obj.elements) ? obj.elements : null;
  if (!raw) throw new Error("Het antwoord van het model bevat geen elementenlijst.");
  const toPx = (y, x) => [round1(clamp(x, 0, 1000) / 1000 * W), round1(clamp(y, 0, 1000) / 1000 * H)];
  const elements = []; let skipped = 0;
  for (const e of raw) {
    const t = e && TYPES[e.type];
    if (!t) { skipped++; continue; }
    let points = null;
    if (t.kind === "quad") {
      const b = Array.isArray(e.box_2d) ? e.box_2d.map(Number) : null;
      if (b && b.length === 4 && b.every(finite) && b[2] > b[0] && b[3] > b[1]) points = [toPx(b[0], b[1]), toPx(b[2], b[3])];
    } else {
      const pts = Array.isArray(e.points) ? e.points.filter((p) => Array.isArray(p) && p.length === 2 && finite(Number(p[0])) && finite(Number(p[1])))
        .map((p) => toPx(Number(p[0]), Number(p[1]))) : [];
      if (pts.length >= (t.kind === "line" ? 2 : 3)) points = pts;
      // Een lijnelement dat toch als kader terugkomt: middellijn langs de lange zijde.
      else if (t.kind === "line" && Array.isArray(e.box_2d) && e.box_2d.length === 4 && e.box_2d.every((v) => finite(Number(v)))) points = boxToLine(e.box_2d.map(Number), toPx);
    }
    if (!points) { skipped++; continue; }
    if (t.kind === "quad" && (points[1][0] - points[0][0] < 2 || points[1][1] - points[0][1] < 2)) { skipped++; continue; }
    elements.push({
      type: e.type, kind: t.kind, points,
      material: typeof e.material === "string" ? e.material.slice(0, 40) : "",
      confidence: CONFIDENCE[e.confidence] ?? null, confidence_label: CONFIDENCE[e.confidence] ? e.confidence : null,
      note: typeof e.note === "string" ? e.note.slice(0, 120) : "",
      geometry_origin: "LLM_BOX",
    });
  }
  return { elements, skipped, facade: normalizeFacade(obj, W) };
}

// Pandgrenzen van het taalmodel → pixels. Alleen een voorstel: de gebruiker bevestigt of verplaatst ze.
// Ontbreekt het veld, dan is het null (onbekend), niet "geen grenzen".
export function normalizeFacade(obj, W) {
  if (!obj || Array.isArray(obj) || !("building_boundaries" in obj || "continues_left" in obj || "continues_right" in obj)) return null;
  const list = Array.isArray(obj.building_boundaries) ? obj.building_boundaries : [];
  const boundaries = list.filter((b) => b && finite(Number(b.x)) && Number(b.x) > 5 && Number(b.x) < 995)
    .map((b) => ({ x: round1(clamp(Number(b.x), 0, 1000) / 1000 * W), confidence: CONFIDENCE[b.confidence] ?? null,
                   confidence_label: CONFIDENCE[b.confidence] ? b.confidence : null, reason: typeof b.reason === "string" ? b.reason.slice(0, 120) : "" }))
    .sort((a, b) => a.x - b.x);
  const bool = (v) => (v === true || v === false ? v : null);
  return { boundaries, continues_left: bool(obj.continues_left), continues_right: bool(obj.continues_right), origin: "LLM_PROPOSAL" };
}

function boxToLine(b, toPx) {
  const [y0, x0, y1, x1] = b;
  return (y1 - y0) >= (x1 - x0) ? [toPx(y0, (x0 + x1) / 2), toPx(y1, (x0 + x1) / 2)] : [toPx((y0 + y1) / 2, x0), toPx((y0 + y1) / 2, x1)];
}

// ------------------------------------------------------------------------------------------------ aanbieders

function imageDataUrl(img) { return `data:${img.mediaType};base64,${img.base64}`; }

export function buildClaudeRequest(img, model) {
  return {
    url: ENDPOINTS.claude,
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
    body: { model, max_tokens: 16000, messages: [{ role: "user", content: [
      { type: "image", source: { type: "base64", media_type: img.mediaType, data: img.base64 } },
      { type: "text", text: buildPrompt() },
    ] }] },
  };
}
export function parseClaudeResponse(data, img) {
  if (!data || data.stop_reason === "refusal") throw new Error("Claude heeft deze foto geweigerd.");
  if (data.stop_reason === "max_tokens") throw new Error("Het antwoord van Claude is afgekapt.");
  const text = (data.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
  const obj = extractJson(text);
  if (!obj) throw new Error("Het antwoord van Claude was niet leesbaar.");
  return { ...normalizeLlmElements(obj, img.width, img.height), served_model: data.model || null,
           usage: data.usage ? { input_tokens: data.usage.input_tokens ?? null, output_tokens: data.usage.output_tokens ?? null } : null };
}

export function buildGeminiRequest(img, model) {
  return {
    url: ENDPOINTS.gemini,
    headers: { "content-type": "application/json" },
    body: { model, response_format: { type: "json_object" }, messages: [{ role: "user", content: [
      { type: "text", text: buildPrompt() },
      { type: "image_url", image_url: { url: imageDataUrl(img) } },
    ] }] },
  };
}
export function parseGeminiResponse(data, img) {
  const choice = data && Array.isArray(data.choices) ? data.choices[0] : null;
  if (!choice) throw new Error("Gemini gaf geen antwoord.");
  if (choice.finish_reason === "length") throw new Error("Het antwoord van Gemini is afgekapt.");
  const obj = extractJson(choice.message && choice.message.content);
  if (!obj) throw new Error("Het antwoord van Gemini was niet leesbaar.");
  const u = data.usage || null;
  return { ...normalizeLlmElements(obj, img.width, img.height), served_model: data.model || null,
           usage: u ? { input_tokens: u.prompt_tokens ?? null, output_tokens: u.completion_tokens ?? null, total_tokens: u.total_tokens ?? null } : null };
}

export function buildSam3Request(img, concepts = SAM3_CONCEPTS) {
  const keys = Object.keys(concepts);
  return {
    url: ENDPOINTS.sam3, keys,
    headers: { "content-type": "application/json" },
    body: { format: "polygon", image: { type: "base64", value: img.base64 }, prompts: keys.map((k) => ({ type: "text", text: concepts[k] })) },
  };
}
// Maskers (polygonen in pixels) → elementen. Een kozijn wordt het omsluitende kader van het masker, een lijnelement
// de middellijn langs de lange zijde. Het masker zelf gaat mee als `polygon` (bewijs, en later nauwkeuriger rekenen).
export function parseSam3Response(data, img, keys) {
  if (!data || !Array.isArray(data.prompt_results)) throw new Error("Het antwoord van SAM 3 was niet leesbaar.");
  const elements = []; let skipped = 0;
  for (const pr of data.prompt_results) {
    const type = keys[pr.prompt_index];
    const t = TYPES[type];
    if (!t) continue;
    for (const p of pr.predictions || []) {
      const polys = (p.masks || []).filter((m) => Array.isArray(m) && m.length >= 3);
      if (!polys.length) { skipped++; continue; }
      // Grootste polygoon is het object; kleine losse stukjes (bijv. door een boom heen) tellen mee in het kader.
      const all = polys.flat().map(([x, y]) => [clamp(Number(x), 0, img.width), clamp(Number(y), 0, img.height)]);
      const b = bbox(all);
      if (b[2] - b[0] < 2 || b[3] - b[1] < 2) { skipped++; continue; }
      const points = t.kind === "quad" ? [[b[0], b[1]], [b[2], b[3]]]
        : (b[3] - b[1]) >= (b[2] - b[0]) ? [[(b[0] + b[2]) / 2, b[1]], [(b[0] + b[2]) / 2, b[3]]] : [[b[0], (b[1] + b[3]) / 2], [b[2], (b[1] + b[3]) / 2]];
      const main = polys.reduce((a, m) => (m.length > a.length ? m : a));
      elements.push({ type, kind: t.kind, points: points.map(([x, y]) => [round1(x), round1(y)]), polygon: main.map(([x, y]) => [Number(x), Number(y)]),
                      material: "", confidence: finite(p.confidence) ? Math.round(p.confidence * 100) / 100 : null, confidence_label: null, note: "",
                      geometry_origin: "SAM3_MASK" });
    }
  }
  const rm = data.resolved_model || {};
  return { elements, skipped, served_model: rm.model_id || null, usage: null };
}

// ------------------------------------------------------------------------------------------------ combinatie

// Herkennen door het taalmodel, lokaliseren door SAM 3. Voor elk kozijn van het taalmodel worden de SAM 3-maskers gezocht
// die grotendeels (≥ 60 %) binnen het (iets ruimere) kader liggen. Zijn die er, dan wordt het kader het omsluitende
// kader van die maskers: SAM 3 splitst een kozijn vaak per raam of draaiend deel, het taalmodel houdt het kozijn bij elkaar.
// Maskers die bij geen enkel kozijn horen worden NIET als element toegevoegd (vaak een buurpand), alleen gemeld.
//
// Twee veiligheden (gevonden op een echte gevel, 25-11-2026): alleen maskers van hetzelfde type verfijnen een element
// (een "window"-masker van het glasstrookje boven een garagedeur maakte die deur anders tot een smalle strook), en het
// verfijnde kader moet minstens `minKeep` van het oorspronkelijke oppervlak houden. Anders blijft het kader van het
// taalmodel staan en meldt `refine_rejected` waarom.
export function combine(llm, sam, { margin = 0.08, minInside = 0.6, minKeep = 0.4 } = {}) {
  const samQuads = sam.elements.filter((e) => e.kind === "quad").map((e) => ({ e, b: bbox(e.points), used: false }));
  const elements = llm.elements.map((el) => {
    if (el.kind !== "quad" || !TYPES[el.type].opening) return { ...el };
    const b = bbox(el.points), mx = (b[2] - b[0]) * margin, my = (b[3] - b[1]) * margin;
    const wide = [b[0] - mx, b[1] - my, b[2] + mx, b[3] + my];
    const hits = samQuads.filter((s) => s.e.type === el.type && boxArea(s.b) > 0 && boxInter(s.b, wide) / boxArea(s.b) >= minInside);
    if (!hits.length) return { ...el, geometry_origin: "LLM_BOX", refined_by: null };
    // Het verfijnde kader blijft binnen de marge rond het kader van het taalmodel: een masker dat ook het glas boven een
    // deur bevat, mag een raam niet naar beneden laten doorgroeien (gezien op een echte gevel, 25-11-2026).
    const raw = bbox(hits.flatMap((h) => h.e.points));
    const u = [Math.max(raw[0], wide[0]), Math.max(raw[1], wide[1]), Math.min(raw[2], wide[2]), Math.min(raw[3], wide[3])];
    const keep = boxArea(b) > 0 ? boxArea(u) / boxArea(b) : 0;
    if (keep < minKeep) {
      return { ...el, geometry_origin: "LLM_BOX", refined_by: null,
               refine_rejected: { reason: "SAM3_KADER_TE_KLEIN", masks: hits.length, area_share: Math.round(keep * 100) / 100 } };
    }
    hits.forEach((h) => { h.used = true; });
    return { ...el, points: [[u[0], u[1]], [u[2], u[3]]], geometry_origin: "LLM_BOX_REFINED_BY_SAM3",
             refined_by: { masks: hits.length, llm_box: el.points, iou_with_llm_box: Math.round(iou(b, u) * 100) / 100 } };
  });
  const unmatched = samQuads.filter((s) => !s.used).map((s) => ({ type: s.e.type, points: s.e.points, confidence: s.e.confidence }));
  return { elements, skipped: llm.skipped, unmatched_segments: unmatched, facade: llm.facade ?? null };
}

// ------------------------------------------------------------------------------------------------ uitsnede

// Rekent een uitkomst op een uitsnede terug naar de pixels van de hele foto: x' = x0 + x · scaleX, y' = y0 + y · scaleY.
// Alles met coördinaten gaat mee: elementen, maskers, het oorspronkelijke kader bij een verfijning, losse maskers en
// pandgrenzen. De uitkomst zelf wordt niet veranderd (er komt een kopie terug).
export function fromCrop(res, { x0 = 0, y0 = 0, scaleX = 1, scaleY = 1 } = {}) {
  const P = ([x, y]) => [round1(x0 + x * scaleX), round1(y0 + y * scaleY)];
  const out = JSON.parse(JSON.stringify(res));
  for (const e of out.elements || []) {
    e.points = (e.points || []).map(P);
    if (e.polygon) e.polygon = e.polygon.map(P);
    if (e.refined_by && e.refined_by.llm_box) e.refined_by.llm_box = e.refined_by.llm_box.map(P);
  }
  for (const u of out.unmatched_segments || []) u.points = u.points.map(P);
  if (out.facade && Array.isArray(out.facade.boundaries)) for (const b of out.facade.boundaries) b.x = round1(x0 + b.x * scaleX);
  return out;
}

// ------------------------------------------------------------------------------------------------ hoeveelheden

// Vaste rekenregels, geen AI. `pxPerM` = pixels per meter op de gevel, in de pixels van de foto waar de elementen in staan.
// Aanname: foto recht van voren, de hele gevel in één vlak, schaal gemeten op dat vlak. Er is GEEN perspectiefcorrectie:
// bij een schuine foto of een gevel met erkers zijn de uitkomsten systematisch fout. Daarom gaat `assumptions` mee.
// Netto metselwerk = bruto min de openingen (raam, deur, garagedeur) waarvan het middelpunt in het muurvlak ligt.
// Losse SAM 3-maskers (`unmatched_segments`) tellen niet mee.
function polyArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) { const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length]; a += x1 * y2 - x2 * y1; }
  return Math.abs(a) / 2;
}
function polyLength(pts) {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return l;
}
function inside(pt, poly) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}
const r2 = (v) => (v == null ? null : Math.round(v * 100) / 100);

export const QUANTITY_KEYS = ["ramen_st", "ramen_m2", "deuren_st", "deuren_m2", "garagedeuren_st", "garagedeuren_m2",
  "metselwerk_bruto_m2", "metselwerk_netto_m2", "hwa_m1", "dakgoot_m1", "boeiboord_m1", "waterslag_m1"];

// Snijdt een polygoon af op de verticale strook x0 ≤ x ≤ x1 (Sutherland–Hodgman, twee randen).
export function clipToBand(pts, x0, x1) {
  const clip = (poly, keep, cross) => {
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length], ia = keep(a), ib = keep(b);
      if (ia) out.push(a);
      if (ia !== ib) out.push(cross(a, b));
    }
    return out;
  };
  const at = (x) => (a, b) => [x, a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0])];
  let p = clip(pts, (q) => q[0] >= x0, at(x0));
  if (p.length) p = clip(p, (q) => q[0] <= x1, at(x1));
  return p.length >= 3 ? p : [];
}

// Snijdt een lijn (goot, boeiboord) af op de strook x0 ≤ x ≤ x1; geeft de losse stukken binnen de strook.
export function clipLineToBand(pts, x0, x1) {
  const parts = [];
  for (let i = 1; i < pts.length; i++) {
    let [a, b] = [pts[i - 1], pts[i]];
    if (a[0] > b[0]) [a, b] = [b, a];
    if (b[0] < x0 || a[0] > x1) continue;
    const at = (x) => (b[0] === a[0] ? a[1] : a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0]));
    const s = a[0] < x0 ? [x0, at(x0)] : a, e = b[0] > x1 ? [x1, at(x1)] : b;
    parts.push([s, e]);
  }
  return parts;
}

// opts.xRange = [x0, x1]: alleen het pand tussen die twee verticale grenzen telt (in dezelfde pixels als de elementen).
// Een kozijn telt mee als zijn middelpunt binnen de strook ligt; muurvlakken en lijnen worden op de grenzen afgesneden.
// `outside` telt wat daardoor buiten de hoeveelheden bleef.
export function quantities(elements, pxPerM, opts = {}) {
  if (!finite(pxPerM) || pxPerM <= 0) return null;
  const s = pxPerM, q = Object.fromEntries(QUANTITY_KEYS.map((k) => [k, k.endsWith("_st") ? 0 : null]));
  const addM = (k, v) => { q[k] = (q[k] || 0) + v; };
  const band = Array.isArray(opts.xRange) && opts.xRange.length === 2 && opts.xRange.every(finite) && opts.xRange[1] > opts.xRange[0] ? opts.xRange : null;
  let outside = 0;
  const inBand = (e) => {
    if (!band || e.kind === "poly" || e.kind === "line") return true;
    const xs = e.points.map((p) => p[0]), cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const ok = cx >= band[0] && cx <= band[1]; if (!ok) outside++; return ok;
  };
  elements = (elements || []).filter(inBand).flatMap((e) => {
    if (!band || e.kind === "quad") return [e];
    if (e.kind === "line") {                                // lijn: alleen de stukken binnen de grenzen
      const parts = clipLineToBand(e.points, band[0], band[1]);
      if (!parts.length) outside++;
      return parts.map((pts) => ({ ...e, points: pts }));
    }
    const pts = clipToBand(e.points, band[0], band[1]);   // muurvlak: afgesneden op de grenzen
    return pts.length ? [{ ...e, points: pts }] : [];
  });
  const openings = [];
  for (const e of elements) {
    if (e.kind === "quad") {
      const [[x0, y0], [x1, y1]] = e.points, m2 = ((x1 - x0) / s) * ((y1 - y0) / s);
      const key = e.type === "kozijn_raam" ? "ramen" : e.type === "kozijn_deur" ? "deuren" : e.type === "garagedeur" ? "garagedeuren" : null;
      if (key) { q[key + "_st"]++; addM(key + "_m2", m2); openings.push({ c: [(x0 + x1) / 2, (y0 + y1) / 2], m2 }); }
    } else if (e.kind === "line" && q[e.type + "_m1"] !== undefined) addM(e.type + "_m1", polyLength(e.points) / s);
  }
  for (const e of elements) {
    if (e.kind !== "poly" || e.type !== "metselwerk") continue;
    const bruto = polyArea(e.points) / (s * s);
    const open = openings.filter((o) => inside(o.c, e.points)).reduce((a, o) => a + o.m2, 0);
    addM("metselwerk_bruto_m2", bruto); addM("metselwerk_netto_m2", Math.max(0, bruto - open));
  }
  for (const k of QUANTITY_KEYS) if (!k.endsWith("_st")) q[k] = r2(q[k]);
  return { ...q, px_per_m: Math.round(s * 1000) / 1000, x_range_px: band ? band.map(round1) : null, outside_building: band ? outside : null,
           assumptions: ["FOTO_RECHT_VAN_VOREN", "EEN_VLAK", "GEEN_PERSPECTIEFCORRECTIE", "LOSSE_MASKERS_NIET_GETELD"].concat(band ? ["ALLEEN_BINNEN_PANDGRENZEN"] : []) };
}

// ------------------------------------------------------------------------------------------------ uitvoeren

export function summarize(elements) {
  const counts = {};
  for (const e of elements) counts[e.type] = (counts[e.type] || 0) + 1;
  return counts;
}

// Kosten alleen als de beheerder een prijs per miljoen tokens heeft ingesteld; anders null (niet gokken).
export function estimateCost(usage, price) {
  if (!usage || !price || !finite(price.input_per_mtok) || !finite(price.output_per_mtok)) return null;
  if (!finite(usage.input_tokens) || !finite(usage.output_tokens)) return null;
  return Math.round((usage.input_tokens * price.input_per_mtok + usage.output_tokens * price.output_per_mtok) / 1e6 * 10000) / 10000;
}

async function postJson(fetchFn, req, apiKeyHeaders, timeoutMs) {
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchFn(req.url, { method: "POST", headers: { ...req.headers, ...apiKeyHeaders }, body: JSON.stringify(req.body), signal: ctl.signal });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text);
  } finally { clearTimeout(timer); }
}

// detect({ image: {base64, mediaType, width, height}, providers: ["claude","gemini","sam3","gemini+sam3","claude+sam3"],
//          keys: {claude, gemini, sam3}, models, prices, fetch, timeoutMs, now })
// Geeft per gevraagde aanbieder een resultaat; een fout bij één aanbieder stopt de andere niet.
export async function detect(opts) {
  const { image, keys = {}, fetch: fetchFn = globalThis.fetch, timeoutMs = 180000, prices = {} } = opts;
  const now = opts.now || (() => Date.now());
  const models = { ...DEFAULT_MODELS, ...(opts.models || {}) };
  const requested = Array.from(new Set(opts.providers || []));
  if (!image || !image.base64 || !finite(image.width) || !finite(image.height)) throw new Error("Geen geldige foto meegegeven.");
  const bytes = Uint8Array.from(atob(image.base64), (c) => c.charCodeAt(0));
  const photoSha = await sha256Hex(bytes);

  const base = new Set(requested.flatMap((p) => p.split("+")));
  const runs = {};
  const run = async (name) => {
    const t0 = now();
    const out = { provider: name, requested_model: models[name], prompt_version: name === "sam3" ? `sam3_concepts:${Object.values(SAM3_CONCEPTS).join(",")}` : PROMPT_VERSION };
    try {
      if (!keys[name]) throw new Error(`Geen sleutel ingesteld voor ${name}.`);
      let r;
      if (name === "claude") { const q = buildClaudeRequest(image, models.claude); r = parseClaudeResponse(await postJson(fetchFn, q, { "x-api-key": keys.claude }, timeoutMs), image); }
      else if (name === "gemini") { const q = buildGeminiRequest(image, models.gemini); r = parseGeminiResponse(await postJson(fetchFn, q, { authorization: `Bearer ${keys.gemini}` }, timeoutMs), image); }
      else if (name === "sam3") { const q = buildSam3Request(image); r = parseSam3Response(await postJson(fetchFn, q, { authorization: `Bearer ${keys.sam3}` }, timeoutMs), image, q.keys); }
      else throw new Error(`Onbekende aanbieder ${name}.`);
      Object.assign(out, r, { cost_usd: estimateCost(r.usage, prices[name]) });
    } catch (e) { out.error = String(e && e.message || e); out.elements = []; out.skipped = 0; }
    out.elapsed_ms = Math.round(now() - t0);
    return out;
  };
  await Promise.all(Array.from(base).map(async (n) => { runs[n] = await run(n); }));

  const results = requested.map((p) => {
    if (!p.includes("+")) return runs[p];
    const [llmName, samName] = p.split("+"), llm = runs[llmName], sam = runs[samName];
    const out = { provider: p, requested_model: `${llm.requested_model}+${sam.requested_model}`, prompt_version: `${llm.prompt_version}+${sam.prompt_version}`,
                  served_model: llm.served_model && sam.served_model ? `${llm.served_model}+${sam.served_model}` : null,
                  usage: llm.usage, cost_usd: llm.cost_usd, elapsed_ms: Math.max(llm.elapsed_ms, sam.elapsed_ms) };
    if (llm.error || sam.error) return { ...out, error: llm.error || sam.error, elements: [], skipped: 0 };
    return { ...out, ...combine(llm, sam) };
  });
  for (const r of results) r.counts = summarize(r.elements || []);
  return { core_version: CORE_VERSION, photo_sha256: photoSha, image: { width: image.width, height: image.height, media_type: image.mediaType },
           created_at: new Date().toISOString(), results };
}
