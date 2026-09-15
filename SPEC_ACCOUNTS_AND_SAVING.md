# MJOP Live — Accounts & Saving

Version: 1.0
Status: Draft, ready for implementation
Target: Claude Code, working in the existing `twandijkmans-afk/MJOP-App` repository
Relationship to other documents: this is a small, standalone slice pulled out of `TECHNICAL_SPEC.docx` (the full AI-MJOP Platform spec). It intentionally does not implement most of that document. See section 3 (Non-Goals).

## 1. Why this and why now

MJOP Live currently has no persistence. Every page load starts from the example building or a fresh address lookup; nothing a user enters survives a reload. That is the single biggest blocker to anyone actually using this as a tool rather than a one-time demo: a VvE board cannot come back to their own plan, compare it next year, or have two board members look at the same numbers.

This spec adds exactly one capability — an account and the ability to save and reopen a plan — and nothing else. Everything that already works (BAG/3D BAG lookups, the cost engine, condition scoring, CSV/PDF import of existing MJOPs, CSV export, the printable report) stays exactly as it is, client-side, untouched.

## 2. Scope

In scope:
- Email-based login (magic link or OTP — no passwords to manage).
- A "my buildings" list per logged-in user.
- Saving the current plan (the existing in-memory `state` object) to a database row, and loading it back.
- Basic ownership: a user can only ever see and modify their own saved plans.

Explicitly out of scope for this piece of work (see section 3): organizations, teams, roles, sharing a plan with another board member, AI of any kind, photo upload, document RAG, audit logs, billing.

## 3. Non-Goals

Do NOT build in this pass:
- Organizations / multi-tenant teams / roles (owner, admin, inspector, viewer).
- Any AI feature (photo analysis, document extraction via AI — the existing client-side CSV/PDF parser is not touched or replaced).
- Audit logs / change history.
- Sharing a plan by link or inviting collaborators.
- A separate backend server (FastAPI, or anything else). This stays a static frontend talking directly to a managed backend-as-a-service.
- Payments/billing.

If any of these turns out to be needed, that is a separate, later spec. Resist folding them in here — that is exactly the scope creep this document exists to avoid.

## 4. Design Principles

4.1 Don't touch what works. The calculation engine (`elementCost`, `kasstroom`, `conditionScore`, the CSV/PDF import parser, the CSV/print export) is not part of this change. If a bug fix to that logic happens to land around the same time, it is a separate commit with its own rationale — not bundled into this feature silently.

4.2 The database row is the whole `state` object. Do not redesign the data model into normalized tables (buildings, elements, observations, etc. — as in the full platform spec) for this pass. Serialize the existing `state` object (building, elements, offertes, fonds, bijdrage, upload history if relevant) as a single JSONB column. Normalizing can happen later, once there is a real reason to query inside it (e.g. cross-building reporting) — there isn't one yet.

4.3 Row-level security is the real boundary, not application code. Never trust a client-supplied user id when reading or writing a plan. Every query must be constrained by the database's own row-level security using the authenticated session, not by an `if` statement in JavaScript that happens to filter by a `user_id` field the client sent.

4.4 Anonymous use stays anonymous. Do not force login before someone has seen value. The address lookup, the example building, and playing with the numbers must keep working exactly as now, without an account. Login is only required at the point someone wants to save.

4.5 Small, verifiable steps. Same discipline as the parent spec: implement one phase, run it, check it against the acceptance criteria for that phase, then continue. Do not implement all of section 8 in one pass.

## 5. Technology Choice

Use Supabase for this: Postgres + Auth + a JS client library, as one managed service, called directly from the existing static frontend. No new backend server.

Reasoning: the app is currently a single static HTML/JS bundle hosted on GitHub Pages with zero operating cost. Introducing a separate API server (as the full platform spec proposes) is a much bigger lift than this feature needs. Supabase's client SDK can run auth and CRUD directly from the browser, with Postgres row-level security doing the access control that would otherwise live in a backend. GitHub Pages hosting does not need to change.

The Supabase "anon" public key is safe to embed in the frontend bundle — that is how the SDK is designed to be used. It grants no access on its own; row-level security policies decide what an authenticated (or anonymous) request may actually read or write. Never embed the Supabase *service role* key in frontend code, ever, under any circumstance — that key bypasses row-level security entirely.

## 6. Data Model

```sql
create table saved_plans (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    label text not null,               -- e.g. the address, user-editable
    state jsonb not null,              -- the full serialized app state
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

alter table saved_plans enable row level security;

create policy "select own plans"
    on saved_plans for select
    using (auth.uid() = user_id);

create policy "insert own plans"
    on saved_plans for insert
    with check (auth.uid() = user_id);

create policy "update own plans"
    on saved_plans for update
    using (auth.uid() = user_id);

create policy "delete own plans"
    on saved_plans for delete
    using (auth.uid() = user_id);
```

No other tables. No `organizations`, no `buildings`, no `mjop_items` — the full relational model from the platform spec is deliberately not built here.

Before writing this migration, inspect the current `state` object shape in `app.js` (what `state.building`, `state.elements`, `state.offertes`, `state.fonds`, `state.bijdrage`, `state.upload` actually contain today) so the JSONB blob matches reality rather than an assumed shape.

## 7. Auth Flow

- Supabase Auth, email magic link (or OTP code) — no password field, nothing to hash or reset.
- New UI: a small "inloggen" affordance (e.g. top-right), a login screen (email field → "check your inbox"), and a session-aware state (`state.session`, `state.user`).
- On login, fetch the user's `saved_plans` and show them as a new "mijn gebouwen" list, entry point alongside (not replacing) the existing "typ een adres" / "voorbeeldgebouw" / "upload bestaand MJOP" flows on the home screen.
- Logout clears the session and returns to the anonymous flow (the current plan in memory stays until the user navigates away — don't silently discard someone's unsaved work just because they logged out).

## 8. Changes to `app.js`

New `state` fields:
- `state.session` — the current Supabase session, or `null`.
- `state.savedPlans` — the list of the logged-in user's saved plans (id, label, updated_at — not the full state, to keep the list fast).
- `state.currentPlanId` — the id of the plan currently open, or `null` for an unsaved/example plan.

New `ACTIONS`:
- `login-request` — submit email, trigger magic link.
- `logout`.
- `save-plan` — insert or update (based on `state.currentPlanId`) a row with the current `state` serialized; on success, set `state.currentPlanId` and refresh `state.savedPlans`.
- `open-plan` — load a row's `state` blob by id and replace the current in-memory state with it (same place `applyBuilding()` already resets state for the example building — reuse that entry point).
- `new-plan` — clear `state.currentPlanId`, return to the address/example flow, keep everything else the app already does.
- `delete-plan` — with a confirmation step, since this is destructive.

New render function: a "mijn gebouwen" screen, reachable from the home screen when logged in, listing saved plans with label, last-updated, "openen" and "verwijderen".

A "opslaan" action should appear in the top-level navigation (alongside Overzicht/Gebouw/Planning/Rapport) whenever `state.session` is set, showing "opgeslagen" / "niet opgeslagen" status so it's clear whether changes are persisted.

Do not implement autosave-on-every-keystroke in this pass — explicit "opslaan" is simpler to reason about and avoids surprising writes. A `localStorage` draft-safety-net (so a crashed tab doesn't lose unsaved work) is a reasonable addition but is optional, not required for acceptance.

## 9. What Does Not Change

- BAG/3D BAG address lookup and building data fetch.
- The full cost/condition-score/reserve-fund calculation engine.
- CSV/Excel/PDF upload and parsing of an existing MJOP.
- CSV export and the printable PDF report.
- The example building flow (still works fully anonymously).

None of these files or functions should be touched as part of this change, beyond wiring their existing state in and out of `save-plan` / `open-plan`.

## 10. Security Checklist

- Row-level security policies (section 6) are the actual access boundary — verify with a real test: log in as user A, save a plan, log in as user B, confirm B cannot list, read, or write A's plan, including by guessing/constructing A's plan id directly.
- The anon key is public by design; do not treat exposing it as a leak, but do treat exposing the service role key as a critical incident.
- No plan should ever be readable via a public/unauthenticated URL. There is no "share this plan" feature in this pass — do not add a shortcut for it.

## 11. Acceptance Criteria

- A user can request a magic link, click it, and land back in the app logged in.
- A logged-in user can save the plan they're currently looking at, see it appear in "mijn gebouwen", close the tab, come back, log in, and reopen the exact same plan (all elements, condition scores, offertes, fonds and bijdrage intact).
- A second, different logged-in user cannot see or open the first user's saved plans.
- Logging out returns to the anonymous flow without errors; the anonymous flow (address lookup, example building, upload) works exactly as it does today, with no login required.
- Deleting a saved plan asks for confirmation and actually removes it (verify the other user still can't see it either, before and after).

## 12. Development Order

Phase 1 — Supabase project + auth only:
1. Create the Supabase project, get the anon key into the frontend config.
2. Wire up login/logout and the session state. No saving yet — just prove login works end to end.

Phase 2 — Data model + save/load:
1. Create the `saved_plans` table and RLS policies exactly as in section 6.
2. Implement `save-plan` and `open-plan`.
3. Manually verify the RLS boundary with two test accounts before moving on — this is the part that must not be wrong.

Phase 3 — "Mijn gebouwen" UI:
1. The list screen, delete, the "opgeslagen/niet opgeslagen" indicator in navigation.
2. Polish: label editing, empty states (no saved plans yet), error states (save failed — don't lose the user's in-memory state if a save request fails).

Do not start Phase 2 until Phase 1's login flow actually works in the browser, not just in theory. Do not start Phase 3 until the RLS test in Phase 2 has been done by hand.

## 13. Critical Rule for Claude Code

Same discipline as the parent spec, scoped to this smaller piece of work:
1. Inspect the current repository and the actual shape of `state` before writing the migration.
2. Implement one phase at a time (section 12).
3. After each phase, manually verify it in the browser — this app has no test suite; don't invent one for this feature alone, but do exercise the acceptance criteria in section 11 by hand as you go.
4. Do not modify the calculation engine, the BAG lookups, or the upload parser as part of this work, even if you notice something else that looks fixable along the way — note it separately instead.
5. Stop and ask before choosing between magic link and OTP, and before picking where the login affordance goes in the UI, if it's not obvious from the existing layout — those are the two points in this spec that were deliberately left for implementation-time judgment.
