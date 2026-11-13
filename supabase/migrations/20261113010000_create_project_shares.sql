-- MJOP Live 3 — bekijklinks voor het VvE-bestuur.
--
-- Een link bevat een lang, willekeurig token. Wie de link heeft, ziet een momentopname van het plan (gemaakt door de app op het moment
-- van delen), zonder account en zonder iets te kunnen aanpassen. De eigenaar of een bewerker kan de link intrekken; na de vervaldatum
-- werkt hij niet meer. Het plan zelf (projects.model) wordt nooit via de link gelezen: alleen de momentopname.

create table if not exists project_shares (
    token text primary key check (char_length(token) >= 32),
    project_id uuid not null references projects(id) on delete cascade,
    created_by uuid not null default auth.uid() references auth.users(id) on delete cascade,
    snapshot jsonb not null,
    show_amounts boolean not null default true,
    expires_at timestamptz not null default (now() + interval '30 days'),
    revoked boolean not null default false,
    views int not null default 0,
    last_viewed_at timestamptz,
    created_at timestamptz not null default now()
);

create index if not exists project_shares_project_idx on project_shares(project_id);

alter table project_shares enable row level security;

drop policy if exists "deellinks beheren" on project_shares;
create policy "deellinks beheren" on project_shares for all
    using (is_project_member(project_id, array['eigenaar', 'bewerker']))
    with check (is_project_member(project_id, array['eigenaar', 'bewerker']) and created_by = auth.uid());

-- Openen via de link (ook zonder account): alleen een geldige, niet ingetrokken en niet verlopen link; telt het bekijken.
create or replace function get_project_share(t text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r project_shares;
begin
    select * into r from project_shares where token = t and not revoked and expires_at > now();
    if not found then return null; end if;
    update project_shares set views = views + 1, last_viewed_at = now() where token = t;
    return jsonb_build_object('snapshot', r.snapshot, 'show_amounts', r.show_amounts, 'expires_at', r.expires_at, 'created_at', r.created_at);
end $$;

revoke all on function get_project_share(text) from public;
grant execute on function get_project_share(text) to anon, authenticated;
