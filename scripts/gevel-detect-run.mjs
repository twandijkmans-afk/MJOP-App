#!/usr/bin/env node
// Draait de gevelherkenning (supabase/functions/gevel-detect/core.mjs) op een of meer foto's, buiten Supabase om.
// Bedoeld voor het vergelijken van modellen op de testset; schrijft één JSON-bestand per foto met alle uitkomsten.
//
//   GEMINI_API_KEY=… ROBOFLOW_API_KEY=… ANTHROPIC_API_KEY=… \
//   node scripts/gevel-detect-run.mjs --providers gemini,sam3,gemini+sam3 --out uitvoer/ foto1.jpg foto2.jpg
//
// Alleen JPEG en PNG. De foto wordt ongewijzigd verstuurd; verklein en anonimiseer (gezichten, kentekens) vooraf.
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { detect } from "../supabase/functions/gevel-detect/core.mjs";

function imageSize(buf) {
  if (buf[0] === 0x89 && buf.toString("ascii", 1, 4) === "PNG") return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), mediaType: "image/png" };
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const m = buf[i + 1], len = buf.readUInt16BE(i + 2);
      if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7), mediaType: "image/jpeg" };
      i += 2 + len;
    }
  }
  throw new Error("Alleen JPEG of PNG wordt ondersteund.");
}

const args = process.argv.slice(2);
let providers = ["gemini", "sam3", "gemini+sam3"], out = ".";
const files = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--providers") providers = args[++i].split(",");
  else if (args[i] === "--out") out = args[++i];
  else files.push(args[i]);
}
if (!files.length) { console.error("Gebruik: node scripts/gevel-detect-run.mjs [--providers a,b] [--out map] foto.jpg …"); process.exit(2); }
mkdirSync(out, { recursive: true });

const keys = { claude: process.env.ANTHROPIC_API_KEY, gemini: process.env.GEMINI_API_KEY, sam3: process.env.ROBOFLOW_API_KEY };
const models = { claude: process.env.CLAUDE_MODEL, gemini: process.env.GEMINI_MODEL };
Object.keys(models).forEach((k) => { if (!models[k]) delete models[k]; });

for (const f of files) {
  const buf = readFileSync(f), size = imageSize(buf);
  const res = await detect({ image: { base64: buf.toString("base64"), ...size }, providers, keys, models });
  res.photo = basename(f);
  const target = join(out, basename(f).replace(/\.[^.]+$/, "") + ".detect.json");
  writeFileSync(target, JSON.stringify(res, null, 1));
  console.log(`${basename(f)} (${size.width}×${size.height}, sha256 ${res.photo_sha256.slice(0, 12)}…) → ${target}`);
  for (const r of res.results) console.log(`  ${r.provider.padEnd(12)} ${r.error ? "FOUT: " + r.error : `${String(r.elapsed_ms).padStart(6)} ms  ${JSON.stringify(r.counts)}${r.skipped ? `  (${r.skipped} overgeslagen)` : ""}`}`);
}
