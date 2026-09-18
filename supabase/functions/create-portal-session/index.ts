// MJOP Live — opent Stripe's Customer Portal voor een ingelogde abonnee
// (opzeggen, betaalmethode wijzigen, facturen inzien). Zelfde opzet als
// create-checkout-session: geheime sleutel blijft server-side.
//
// Benodigde secret: STRIPE_SECRET_KEY (zelfde als bij create-checkout-session).
// Vereist daarnaast dat de Customer Portal eenmalig is geactiveerd in het
// Stripe Dashboard (Instellingen → Billing → Customer portal) — dat kan
// niet via de API, alleen via de Dashboard-knop.

import { createClient } from 'jsr:@supabase/supabase-js@2';

const STRIPE_SECRET_KEY = Deno.env.get('STRIPE_SECRET_KEY')!;
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

    const { returnUrl } = await req.json();
    if (!returnUrl) {
      return new Response(JSON.stringify({ error: 'returnUrl is verplicht' }), { status: 400, headers: CORS_HEADERS });
    }

    const { data: sub } = await supabase
      .from('subscriptions')
      .select('stripe_customer_id')
      .eq('user_id', user.id)
      .maybeSingle();

    if (!sub?.stripe_customer_id) {
      return new Response(JSON.stringify({ error: 'Nog geen Stripe-klant voor dit account' }), { status: 400, headers: CORS_HEADERS });
    }

    const params = new URLSearchParams({ customer: sub.stripe_customer_id, return_url: returnUrl });
    const res = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params,
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error?.message || 'Stripe-aanroep mislukt');

    return new Response(JSON.stringify({ url: json.url }), {
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500, headers: CORS_HEADERS });
  }
});
