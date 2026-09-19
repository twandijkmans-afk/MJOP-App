// MJOP Live — een account (en alle bijbehorende data) definitief verwijderen.
//
// Draait server-side (Supabase Edge Function, Deno) omdat het verwijderen
// van een auth-gebruiker de "service role"-sleutel vereist (de admin-API
// van supabase-js is er niet met de publieke anon-sleutel) — die sleutel
// mag nooit in frontend-code staan, vandaar deze functie. De frontend
// roept 'm aan met de eigen sessie-token van de ingelogde gebruiker (zie
// ACTIONS['submit-account-verwijderen'] in src/app.js) en heeft zelf al
// bevestigd dat de gebruiker zijn eigen e-mailadres heeft ingetypt.
//
// Verwijdert expliciet profiles/saved_plans/subscriptions vóór de
// auth-gebruiker zelf — niet omdat de foreign keys geen ON DELETE CASCADE
// zouden hebben (die hebben ze wel, zie de migraties), maar zodat deze
// functie ook correct werkt als een toekomstige migratie dat ooit anders
// regelt, en zodat een falende auth-delete nooit losse databaserijen
// achterlaat vóór de gebruiker zelf weg is.
//
// SUPABASE_URL en SUPABASE_SERVICE_ROLE_KEY staan al automatisch klaar in
// elke Edge Function, hoeven niet apart gezet te worden.

import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });

  try {
    const authHeader = req.headers.get('Authorization') || '';
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: { user }, error: authError } = await supabase.auth.getUser(
      authHeader.replace('Bearer ', '')
    );
    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Niet ingelogd' }), { status: 401, headers: CORS_HEADERS });
    }

    await supabase.from('saved_plans').delete().eq('user_id', user.id);
    await supabase.from('subscriptions').delete().eq('user_id', user.id);
    await supabase.from('profiles').delete().eq('id', user.id);

    const { error: deleteError } = await supabase.auth.admin.deleteUser(user.id);
    if (deleteError) throw deleteError;

    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500, headers: CORS_HEADERS });
  }
});
