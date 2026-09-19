-- MJOP Live — profielgegevens per account
--
-- Eén rij per gebruiker (id = auth.users.id), aangemaakt/bijgewerkt door
-- de gebruiker zelf via de "Mijn profiel"/"Organisatie"/"Facturatie"-
-- secties op de Account-pagina (zie renderAcctProfiel() e.a. in
-- src/app.js). Alle velden zijn optioneel op rijniveau — de app
-- valideert zelf welke velden verplicht zijn (bv. het factuuradres pas
-- bij het afsluiten van een abonnement), de database dwingt dat niet af.
--
-- Bewust geen los "rol"-enum-type: een simpele check-constraint op tekst
-- is voldoende voor deze vier vaste keuzes en voorkomt een aparte
-- migratie als daar ooit een vijfde bijkomt.
create table profiles (
    id uuid primary key references auth.users(id) on delete cascade,
    voornaam text,
    achternaam text,
    telefoon text,
    rol text check (rol in ('bestuurslid', 'vve_beheerder', 'adviseur', 'anders')),
    org_naam text,
    kvk_nummer text,
    toon_organisatie_op_rapport boolean not null default false,
    factuur_straat text,
    factuur_huisnummer text,
    factuur_postcode text,
    factuur_plaats text,
    factuur_land text not null default 'Nederland',
    btw_nummer text,
    updated_at timestamptz not null default now()
);

alter table profiles enable row level security;

-- Alleen de eigen rij lezen/schrijven — net als bij saved_plans is dit
-- de echte grens, geen applicatie-filter (zie SPEC_ACCOUNTS_AND_SAVING.md
-- §4.3). Eén policy voor alle commando's, want lezen/schrijven/aanmaken
-- van de eigen rij is hier altijd toegestaan; er is geen apart "alleen
-- lezen"-scenario zoals bij subscriptions.
create policy "manage own profile"
    on profiles for all
    using (auth.uid() = id)
    with check (auth.uid() = id);

-- MJOP Live — adres per opgeslagen plan, los van de bewerkbare naam
--
-- "label" (zie saved_plans) is de door de gebruiker aanpasbare naam van
-- een plan en kan dus afwijken van het werkelijke adres zodra iemand 'm
-- hernoemt. Het adres zelf zat al in de opgeslagen state-blob, maar was
-- daar niet los uit op te vragen zonder de hele blob te downloaden (zie
-- loadSavedPlans() in src/app.js) — deze kolom maakt "Mijn gebouwen"
-- mogelijk zonder dat te hoeven doen. Wordt gevuld bij elke opslag,
-- samen met "label" (zie performSave()).
alter table saved_plans add column adres text;
