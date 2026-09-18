-- MJOP Live — abonnementen (Stripe-koppeling)
--
-- Eén rij per gebruiker die ooit een Stripe-klant is geworden. Wordt
-- uitsluitend geschreven door de stripe-webhook Edge Function (met de
-- service-role-sleutel, die nooit in frontend-code voorkomt) — de
-- frontend leest deze tabel alleen, nooit schrijven vanuit de client.
--
-- status volgt de Stripe Subscription-status 1-op-1 door ("active",
-- "trialing", "past_due", "canceled", "unpaid", enz.) — geen eigen
-- vertaling, zodat de webhook-code niet hoeft te interpreteren wat
-- Stripe al vertelt.
create table subscriptions (
    user_id uuid primary key references auth.users(id) on delete cascade,
    stripe_customer_id text not null unique,
    stripe_subscription_id text,
    status text not null default 'none',
    current_period_end timestamptz,
    updated_at timestamptz not null default now()
);

alter table subscriptions enable row level security;

-- Alleen lezen van je eigen rij — schrijven gebeurt uitsluitend door de
-- webhook met de service-role-sleutel, die row-level security toch al
-- omzeilt, dus er is bewust geen insert/update/delete-policy voor de
-- ingelogde gebruiker zelf.
create policy "select own subscription"
    on subscriptions for select
    using (auth.uid() = user_id);

-- Snelle opzoeking vanuit de webhook (Stripe stuurt het Stripe-
-- customer-id mee, niet het Supabase-user-id).
create index subscriptions_stripe_customer_id_idx on subscriptions (stripe_customer_id);
