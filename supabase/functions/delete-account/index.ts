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
// Zegt eerst een eventueel actief Stripe-abonnement op (echt opzeggen,
// niet alleen de lokale rij verwijderen) — anders zou iemand na het
// verwijderen van zijn account gewoon door blijven betalen zonder nog een
// manier te hebben om dat zelf stop te zetten. Lukt die Stripe-aanroep
// niet (en is het geen "bestaat al niet/al opgezegd"-geval), dan stopt
// deze functie vóórdat er iets verwijderd is — beter een mislukte poging
// die de gebruiker opnieuw kan proberen, dan een verwijderd account met
// een abonnement dat stilletjes door blijft lopen.
//
// Verwijdert daarna expliciet profiles/saved_plans/subscriptions vóór de
// auth-gebruiker zelf — niet omdat de foreign keys geen ON DELETE CASCADE
// zouden hebben (die hebben ze wel, zie de migraties), maar zodat deze
// functie ook correct werkt als een toekomstige migratie dat ooit anders
// regelt, en zodat een falende auth-delete nooit losse databaserijen
// achterlaat vóór de gebruiker zelf weg is.
//
// Benodigd secret: STRIPE_SECRET_KEY (zelfde als bij create-checkout-
// session/create-portal-session). SUPABASE_URL en
// SUPABASE_SERVICE_ROLE_KEY staan al automatisch klaar in elke Edge
// Function, hoeven niet apart gezet te worden.

import { createClient } from 'jsr:@supabase/supabase-js@2';

const STRIPE_SECRET_KEY = Deno.env.get('STRIPE_SECRET_KEY')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
};

// Stripe's eigen foutcode wanneer het abonnement al niet meer bestaat
// (bv. al eerder opgezegd via de Customer Portal) — dat mag de
// verwijdering niet blokkeren, in tegenstelling tot een echte fout
// (netwerkprobleem, verlopen sleutel, Stripe-storing).
async function cancelStripeSubscription(subscriptionId: string) {
  const res = await fetch(`https://api.stripe.com/v1/subscriptions/${subscriptionId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${STRIPE_SECRET_KEY}` },
  });
  if (res.ok) return;
  const json = await res.json().catch(() => ({}));
  if (json.error?.code === 'resource_missing') return;
  throw new Error(json.error?.message || 'Kon het abonnement niet opzeggen bij Stripe');
}

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

    const { data: sub } = await supabase
      .from('subscriptions')
      .select('stripe_subscription_id')
      .eq('user_id', user.id)
      .maybeSingle();
    if (sub?.stripe_subscription_id) {
      await cancelStripeSubscription(sub.stripe_subscription_id);
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
