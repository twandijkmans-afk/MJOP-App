#!/usr/bin/env node
// Scoort de uitkomsten van gevel-detect tegen een testset met bekende elementen (grondwaarheid). Vaste regels, geen AI.
//
//   node scripts/gevel-eval.mjs --truth testset/ --pred uitvoer/ [--split dev] [--min-recall 0.8] [--min-precision 0.8]
//
//   --truth  map met *.truth.json (formaat gevel_testset_v1, zie docs/gevel-modellen-vergelijken.md)
//   --pred   map met *.detect.json (uitvoer van scripts/gevel-detect-run.mjs of "Uitkomst bewaren" op gevelfoto/vergelijk.html)
//   --split  alleen foto's uit deze deelset: "dev" om aan te sleutelen, "holdout" alleen voor een eindmeting
//   --min-*  drempels per aanbieder over alle kozijnen; daaronder stopt het script met code 1 (bedoeld voor CI)
//
// Koppelen gaat via de sha256 van de foto: een uitkomst van een andere (bijv. verkleinde) foto telt niet mee.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const IOU_MATCH = 0.5;

function bbox(points) {
  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}
// Lijnen (hwa, goot) zijn dun: hun kader wordt verbreed tot minstens 2 % van de fotobreedte, anders is overlap toeval.
export function evalBox(el, W) {
  const b = bbox(el.points), pad = W * 0.02;
  if (el.kind === "line" || el.type === "hwa" || el.type === "dakgoot" || el.type === "boeiboord" || el.type === "waterslag" || el.type === "hekwerk") {
    if (b[2] - b[0] < pad) { const c = (b[0] + b[2]) / 2; b[0] = c - pad / 2; b[2] = c + pad / 2; }
    if (b[3] - b[1] < pad) { const c = (b[1] + b[3]) / 2; b[1] = c - pad / 2; b[3] = c + pad / 2; }
  }
  return b;
}
export function iou(a, b) {
  const iw = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])), ih = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const i = iw * ih, u = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - i;
  return u > 0 ? i / u : 0;
}

// Gretig koppelen per type: hoogste IoU eerst, elk element hooguit één keer. Geeft tp/fp/fn en de IoU van elke treffer.
export function matchType(truth, pred, W) {
  const pairs = [];
  truth.forEach((t, i) => pred.forEach((p, j) => { const v = iou(evalBox(t, W), evalBox(p, W)); if (v >= IOU_MATCH) pairs.push([v, i, j]); }));
  pairs.sort((a, b) => b[0] - a[0]);
  const ti = new Set(), pj = new Set(), ious = [];
  for (const [v, i, j] of pairs) { if (ti.has(i) || pj.has(j)) continue; ti.add(i); pj.add(j); ious.push(v); }
  return { tp: ious.length, fp: pred.length - ious.length, fn: truth.length - ious.length, ious };
}

export function scorePhoto(truthDoc, result) {
  const W = truthDoc.image.width, types = new Set([...truthDoc.elements.map((e) => e.type), ...(result.elements || []).map((e) => e.type)]);
  const out = {};
  for (const t of types) {
    const tr = truthDoc.elements.filter((e) => e.type === t), pr = (result.elements || []).filter((e) => e.type === t);
    out[t] = { ...matchType(tr, pr, W), truth_count: tr.length, pred_count: pr.length };
  }
  return out;
}

function add(acc, s) {
  for (const [t, v] of Object.entries(s)) {
    const a = acc[t] || (acc[t] = { tp: 0, fp: 0, fn: 0, ious: [], abs_count_error: 0, photos: 0, exact_count: 0 });
    a.tp += v.tp; a.fp += v.fp; a.fn += v.fn; a.ious.push(...v.ious);
    a.abs_count_error += Math.abs(v.pred_count - v.truth_count); a.photos++; if (v.pred_count === v.truth_count) a.exact_count++;
  }
}
export function finalize(a) {
  const p = a.tp + a.fp ? a.tp / (a.tp + a.fp) : null, r = a.tp + a.fn ? a.tp / (a.tp + a.fn) : null;
  return { tp: a.tp, fp: a.fp, fn: a.fn, precision: p, recall: r, mean_iou: a.ious.length ? a.ious.reduce((x, y) => x + y, 0) / a.ious.length : null,
           mean_abs_count_error: a.photos ? a.abs_count_error / a.photos : null, exact_count_share: a.photos ? a.exact_count / a.photos : null };
}

export function evaluate(truthDocs, detectDocs, { split = null } = {}) {
  const bySha = new Map(detectDocs.map((d) => [d.photo_sha256, d]));
  const acc = {}, frames = {}, missing = [], used = [];
  for (const t of truthDocs) {
    if (split && t.split !== split) continue;
    const d = bySha.get(t.photo_sha256);
    if (!d) { missing.push(t.photo); continue; }
    used.push(t.photo);
    for (const r of d.results) {
      if (r.error) continue;
      const key = r.provider;
      add(acc[key] || (acc[key] = {}), scorePhoto(t, r));
      // Raam of deur verwisseld is minder erg dan gemist: daarom ook een score over alle kozijnen samen.
      const asFrame = (els) => els.filter((e) => e.type === "kozijn_raam" || e.type === "kozijn_deur").map((e) => ({ ...e, type: "kozijn" }));
      add(frames[key] || (frames[key] = {}), scorePhoto({ image: t.image, elements: asFrame(t.elements) }, { elements: asFrame(r.elements || []) }));
    }
  }
  const providers = {};
  for (const [p, types] of Object.entries(acc)) {
    providers[p] = { per_type: Object.fromEntries(Object.entries(types).map(([t, a]) => [t, finalize(a)])), frames: frames[p] && frames[p].kozijn ? finalize(frames[p].kozijn) : null };
  }
  return { photos_scored: used, photos_without_prediction: missing, providers };
}

function readDir(dir, suffix) { return readdirSync(dir).filter((f) => f.endsWith(suffix)).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8"))); }
function pct(v) { return v == null ? "–" : (v * 100).toFixed(0) + " %"; }
function dec(v, d = 2) { return v == null ? "–" : v.toFixed(d); }

function main() {
  const a = process.argv.slice(2), opt = {};
  for (let i = 0; i < a.length; i += 2) opt[a[i].replace(/^--/, "")] = a[i + 1];
  if (!opt.truth || !opt.pred) { console.error("Gebruik: node scripts/gevel-eval.mjs --truth map --pred map [--split dev|holdout] [--min-recall 0.8] [--min-precision 0.8]"); process.exit(2); }
  const truth = readDir(opt.truth, ".truth.json").filter((t) => t.contract === "gevel_testset_v1");
  const res = evaluate(truth, readDir(opt.pred, ".detect.json"), { split: opt.split || null });
  console.log(`## Gevelherkenning: score op ${res.photos_scored.length} foto's${opt.split ? ` (deelset ${opt.split})` : ""}\n`);
  if (res.photos_without_prediction.length) console.log(`Zonder uitkomst (andere hash of niet gedraaid): ${res.photos_without_prediction.join(", ")}\n`);
  console.log("Kozijnen (raam en deur samen), koppeling bij IoU ≥ 0,5:\n");
  console.log("| Aanbieder | Precisie | Recall | Gem. IoU | Gem. telfout per foto | Aantal exact goed |");
  console.log("|---|---|---|---|---|---|");
  for (const [p, v] of Object.entries(res.providers)) { const f = v.frames; if (f) console.log(`| ${p} | ${pct(f.precision)} | ${pct(f.recall)} | ${dec(f.mean_iou)} | ${dec(f.mean_abs_count_error, 1)} | ${pct(f.exact_count_share)} |`); }
  console.log("\nPer elementtype:\n\n| Aanbieder | Type | TP | FP | FN | Precisie | Recall |\n|---|---|---|---|---|---|---|");
  for (const [p, v] of Object.entries(res.providers)) for (const [t, s] of Object.entries(v.per_type)) console.log(`| ${p} | ${t} | ${s.tp} | ${s.fp} | ${s.fn} | ${pct(s.precision)} | ${pct(s.recall)} |`);
  let fail = false;
  const minR = opt["min-recall"] != null ? Number(opt["min-recall"]) : null, minP = opt["min-precision"] != null ? Number(opt["min-precision"]) : null;
  for (const [p, v] of Object.entries(res.providers)) {
    const f = v.frames; if (!f) continue;
    if (minR != null && (f.recall == null || f.recall < minR)) { console.log(`\nFOUT ${p}: recall ${pct(f.recall)} onder de drempel ${pct(minR)}`); fail = true; }
    if (minP != null && (f.precision == null || f.precision < minP)) { console.log(`\nFOUT ${p}: precisie ${pct(f.precision)} onder de drempel ${pct(minP)}`); fail = true; }
  }
  if (!res.photos_scored.length) { console.log("\nFOUT: geen enkele foto gescoord."); fail = true; }
  process.exit(fail ? 1 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main();
