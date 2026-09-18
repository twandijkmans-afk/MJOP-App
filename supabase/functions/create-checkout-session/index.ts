// MJOP Live — start een Stripe Checkout-sessie voor het maandabonnement.
//
// Draait server-side (Supabase Edge Function, Deno) omdat de Stripe
// secret key hier nooit in frontend-code mag staan (zie
// SPEC_ACCOUNTS_AND_SAVING.md §5). De frontend roept deze functie aan
// met de eigen sessie-token van de ingelogde gebruiker, en krijgt terug een
// url waar hij naartoe moet redirecten (Stripe-hosted Checkout).
//
// Benodigde secrets (supabase secrets set ...):
//   STRIPE_SECRET_KEY   — de Stripe test-secret-key (sk_test_...)
//   STRIPE_PRICE_ID     — price_1UGvtH3Icj8X3hwRGoPW5e5d (€19/mnd, testmodus)
// SUPABASE_URL en SUPABASE_SERVICE_ROLE_KEY staan al automatisch klaar
// in elke Edge Function, hoeven niet apart gezet te worden.

import { createClient } from 'jsr:@supabase/supabase-js@2';

const STRIPE_SECRET_KEY = Deno.env.get('STRIPE_SECRET_KEY')!;
const STRIPE_PRICE_ID = Deno.env.get('STRIPE_PRICE_ID')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
};

async function stripeRequest(path: string, body: Record<string, string>) {
  const params = new URLSearchParams(body);
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error?.message || 'Stripe-aanroep mislukt');
  return json;
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

    const { successUrl, cancelUrl } = await req.json();
    if (!successUrl || !cancelUrl) {
      return new Response(JSON.stringify({ error: 'successUrl en cancelUrl zijn verplicht' }), { status: 400, headers: CORS_HEADERS });
    }

    // Bestaande Stripe-klant hergebruiken als die er al is (bv. iemand
    // die eerder is uitgeschreven en nu opnieuw wil abonneren), anders
    // een nieuwe aanmaken.
    const { data: existing } = await supabase
      .from('subscriptions')
      .select('stripe_customer_id')
      .eq('user_id', user.id)
      .maybeSingle();

    let customerId = existing?.stripe_customer_id as string | undefined;
    if (!customerId) {
      const customer = await stripeRequest('customers', {
        email: user.email || '',
        'metadata[supabase_user_id]': user.id,
      });
      customerId = customer.id;
      await supabase.from('subscriptions').upsert({
        user_id: user.id,
        stripe_customer_id: customerId,
        status: 'none',
      });
    }

    const session = await stripeRequest('checkout/sessions', {
      mode: 'subscription',
      customer: customerId!,
      'line_items[0][price]': STRIPE_PRICE_ID,
      'line_items[0][quantity]': '1',
      success_url: successUrl,
      cancel_url: cancelUrl,
      client_reference_id: user.id,
    });

    return new Response(JSON.stringify({ url: session.url }), {
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500, headers: CORS_HEADERS });
  }
});
