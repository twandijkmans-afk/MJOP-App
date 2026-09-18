// MJOP Live — verwerkt Stripe-webhooks en houdt de "subscriptions"-tabel
// (zie supabase/migrations/20260918000000_create_subscriptions.sql) in
// sync met de echte abonnementsstatus in Stripe. Dit is de ENIGE plek
// die naar die tabel schrijft.
//
// Benodigde secrets:
//   STRIPE_SECRET_KEY      — zelfde als bij de andere twee functies
//   STRIPE_WEBHOOK_SECRET  — whsec_..., te vinden bij het aanmaken van
//                            het webhook-endpoint in het Stripe Dashboard
//                            (of via de API, zie de begeleidende uitleg).
//
// Stripe-signatuurverificatie moet met de RUWE request-body (vóór JSON-
// parsing) — vandaar req.text() i.p.v. req.json() hieronder.

import Stripe from 'https://esm.sh/stripe@17.5.0?target=deno';
import { createClient } from 'jsr:@supabase/supabase-js@2';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
  apiVersion: '2024-06-20',
  httpClient: Stripe.createFetchHttpClient(),
});
const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET')!;
const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

async function syncSubscription(subscriptionId: string, customerId: string) {
  const sub = await stripe.subscriptions.retrieve(subscriptionId);
  await supabase.from('subscriptions').upsert({
    stripe_customer_id: customerId,
    stripe_subscription_id: sub.id,
    status: sub.status,
    current_period_end: new Date(sub.current_period_end * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  }, { onConflict: 'stripe_customer_id' });
}

Deno.serve(async (req) => {
  const signature = req.headers.get('Stripe-Signature');
  const body = await req.text();

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      body,
      signature!,
      webhookSecret,
      undefined,
      Stripe.createSubtleCryptoProvider()
    );
  } catch (err) {
    // Nooit blindelings vertrouwen: een niet-geverifieerd verzoek wordt
    // afgewezen i.p.v. verwerkt, ook al "ziet het er geldig uit".
    //
    // TIJDELIJKE DEBUG-INFO (verwijderen zodra de oorzaak gevonden is):
    // een hash van de secret (nooit de secret zelf) zodat we kunnen
    // vergelijken of de functie de verwachte secret gebruikt, zonder ook
    // maar één teken van de echte waarde prijs te geven.
    const secretHashBuf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(webhookSecret));
    const secretHash = Array.from(new Uint8Array(secretHashBuf)).map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 12);
    const debug = `DEBUG: body-lengte=${body.length}, signature-header-aanwezig=${!!signature}, ` +
      `secret-lengte=${webhookSecret.length}, secret-hash=${secretHash}`;
    return new Response(`Webhook-signatuur ongeldig: ${(err as Error).message}\n\n${debug}`, { status: 400 });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.subscription && session.customer) {
          await syncSubscription(session.subscription as string, session.customer as string);
        }
        break;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription;
        await syncSubscription(sub.id, sub.customer as string);
        break;
      }
      default:
        // Overige events negeren we bewust — alleen abonnementsstatus is
        // relevant voor deze tabel.
        break;
    }
  } catch (err) {
    // Stripe herhaalt de aanroep automatisch bij een 5xx-antwoord, dus
    // een verwerkingsfout hier laten terugkomen i.p.v. stil te falen.
    return new Response(`Verwerking mislukt: ${(err as Error).message}`, { status: 500 });
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
