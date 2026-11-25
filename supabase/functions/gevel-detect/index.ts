// MJOP Live — gevelherkenning met meerdere modellen (Claude, Gemini, SAM 3) via de server.
//
// Waarom server-side: de AI-sleutels mogen niet in de browser of de app staan, en per scan wordt vastgelegd welk model,
// welke promptversie, welke foto (sha256), hoe lang en hoeveel tokens. Zo is elke uitkomst te herleiden en kan een model
// worden gewisseld zonder nieuwe app-versie. De eigenlijke logica staat in core.mjs (ook getest in Node).
//
// Alleen voor ingelogde gebruikers (Supabase-sessie in de Authorization-header). Er wordt niets opgeslagen: geen foto,
// geen uitkomst. Het logregeltje bevat alleen hash, aanbieders, modellen, tijden, tokens en aantallen.
//
// Benodigde secrets (alleen die van de aanbieders die je wilt gebruiken):
//   GEMINI_API_KEY, ROBOFLOW_API_KEY, ANTHROPIC_API_KEY
// Optioneel: GEMINI_MODEL, CLAUDE_MODEL (anders de standaard uit core.mjs) en prijzen per miljoen tokens in USD voor een
// kosteninschatting: GEMINI_PRICE_IN, GEMINI_PRICE_OUT, CLAUDE_PRICE_IN, CLAUDE_PRICE_OUT (zonder prijs: kosten = null).
// SUPABASE_URL en SUPABASE_ANON_KEY staan al automatisch klaar in elke Edge Function.

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { detect } from './core.mjs';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
};
const MAX_BASE64 = 10 * 1024 * 1024; // ongeveer 7,5 MB foto
const PROVIDERS = new Set(['claude', 'gemini', 'sam3', 'gemini+sam3', 'claude+sam3']);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, 'content-type': 'application/json' } });
}
function num(name: string) {
  const v = Number(Deno.env.get(name));
  return Deno.env.get(name) && Number.isFinite(v) ? v : null;
}
function price(prefix: string) {
  const i = num(`${prefix}_PRICE_IN`), o = num(`${prefix}_PRICE_OUT`);
  return i != null && o != null ? { input_per_mtok: i, output_per_mtok: o } : null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'Alleen POST.' }, 405);

  const auth = req.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return json({ error: 'Niet ingelogd.' }, 401);
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: auth } } });
  const { data: userData, error: userErr } = await sb.auth.getUser();
  if (userErr || !userData?.user) return json({ error: 'Niet ingelogd.' }, 401);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'Ongeldige JSON.' }, 400); }
  const img = body?.image;
  if (!img || typeof img.base64 !== 'string' || !/^image\/(jpeg|png)$/.test(img.media_type) || !(img.width > 0) || !(img.height > 0)) {
    return json({ error: 'Stuur image: {base64, media_type (image/jpeg of image/png), width, height}.' }, 400);
  }
  if (img.base64.length > MAX_BASE64) return json({ error: 'De foto is te groot; verklein hem eerst (lange zijde ongeveer 2000 pixels).' }, 413);
  const providers: string[] = Array.isArray(body.providers) ? body.providers.filter((p: string) => PROVIDERS.has(p)) : [];
  if (!providers.length) return json({ error: `Kies een of meer aanbieders: ${[...PROVIDERS].join(', ')}.` }, 400);

  const keys = { claude: Deno.env.get('ANTHROPIC_API_KEY'), gemini: Deno.env.get('GEMINI_API_KEY'), sam3: Deno.env.get('ROBOFLOW_API_KEY') };
  const models: Record<string, string> = {};
  if (Deno.env.get('GEMINI_MODEL')) models.gemini = Deno.env.get('GEMINI_MODEL')!;
  if (Deno.env.get('CLAUDE_MODEL')) models.claude = Deno.env.get('CLAUDE_MODEL')!;

  try {
    const res = await detect({
      image: { base64: img.base64, mediaType: img.media_type, width: img.width, height: img.height },
      providers, keys, models, prices: { gemini: price('GEMINI'), claude: price('CLAUDE') }, timeoutMs: 120000,
    });
    console.log(JSON.stringify({
      event: 'gevel-detect', user: userData.user.id, photo_sha256: res.photo_sha256, core: res.core_version,
      results: res.results.map((r: any) => ({ provider: r.provider, requested_model: r.requested_model, served_model: r.served_model ?? null,
        prompt_version: r.prompt_version, elapsed_ms: r.elapsed_ms, usage: r.usage ?? null, cost_usd: r.cost_usd ?? null,
        counts: r.counts, error: r.error ?? null })),
    }));
    return json(res);
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
