-- MJOP Live 3 — nieuw datamodel voor projecten (gebouwen), los van het oude saved_plans-blok.
--
-- De native app (en straks de nieuwe website) slaan projecten hier op. De oude tabel saved_plans blijft staan
-- (er wordt niets weggegooid); de oude website gebruikt die gewoon verder.
--
-- Uitgangspunten (zie CLAUDE.md van mjop-learning): onbekend blijft null, niets wordt geschat zonder dat te markeren,
-- en de kerncijfers in deze tabel (posten_aantal, geraamd_totaal, ...) zijn een samenvatting van `model` die de app
-- bij elke opslag met vaste rekenregels opnieuw berekent. Het volledige plan staat in `model` (geversioneerd met schema_version).
--
-- Meerdere mensen per project: via project_members met een rol. De eigenaar wordt automatisch lid.

create table if not exists projects (
    id uuid primary key default gen_random_uuid(),
    owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
    naam text not null check (char_length(naam) between 1 and 200),
    adres text,
    postcode text,
    plaats text,
    bag_pand_id text,
    bag_verblijfsobject_id text,
    bouwjaar int check (bouwjaar between 1000 and 2100),
    aantal_appartementen int check (aantal_appartementen > 0),
    -- samenvatting van het plan, door de app berekend (null = nog niet berekend)
    posten_aantal int,
    posten_beoordeeld int,
    geraamd_totaal bigint,
    periode_van int,
    periode_tot int,
    foto_pad text,
    schema_version int not null default 1,
    model jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists project_members (
    project_id uuid not null references projects(id) on delete cascade,
    user_id uuid not null references auth.users(id) on delete cascade,
    rol text not null check (rol in ('eigenaar', 'bewerker', 'lezer')),
    created_at timestamptz not null default now(),
    primary key (project_id, user_id)
);

create index if not exists project_members_user_idx on project_members(user_id);

-- Lidmaatschap opvragen zonder dat de policies elkaar oneindig aanroepen (security definer, vaste search_path).
create or replace function is_project_member(p uuid, roles text[] default array['eigenaar', 'bewerker', 'lezer'])
returns boolean language sql stable security definer set search_path = public as $$
    select exists (select 1 from project_members m where m.project_id = p and m.user_id = auth.uid() and m.rol = any(roles));
$$;

-- De maker wordt automatisch eigenaar.
create or replace function add_project_owner() returns trigger language plpgsql security definer set search_path = public as $$
begin
    insert into project_members(project_id, user_id, rol) values (new.id, new.owner_id, 'eigenaar') on conflict do nothing;
    return new;
end $$;

drop trigger if exists projects_add_owner on projects;
create trigger projects_add_owner after insert on projects for each row execute function add_project_owner();

create or replace function touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

drop trigger if exists projects_touch on projects;
create trigger projects_touch before update on projects for each row execute function touch_updated_at();

alter table projects enable row level security;
alter table project_members enable row level security;

drop policy if exists "projects lezen als lid" on projects;
create policy "projects lezen als lid" on projects for select using (owner_id = auth.uid() or is_project_member(id));

drop policy if exists "projects aanmaken" on projects;
create policy "projects aanmaken" on projects for insert with check (owner_id = auth.uid());

drop policy if exists "projects wijzigen als eigenaar of bewerker" on projects;
create policy "projects wijzigen als eigenaar of bewerker" on projects for update
    using (owner_id = auth.uid() or is_project_member(id, array['eigenaar', 'bewerker']))
    with check (owner_id = auth.uid() or is_project_member(id, array['eigenaar', 'bewerker']));

drop policy if exists "projects verwijderen als eigenaar" on projects;
create policy "projects verwijderen als eigenaar" on projects for delete using (owner_id = auth.uid());

drop policy if exists "leden zien" on project_members;
create policy "leden zien" on project_members for select using (user_id = auth.uid() or is_project_member(project_id));

drop policy if exists "leden beheren als eigenaar" on project_members;
create policy "leden beheren als eigenaar" on project_members for all
    using (is_project_member(project_id, array['eigenaar']))
    with check (is_project_member(project_id, array['eigenaar']));
