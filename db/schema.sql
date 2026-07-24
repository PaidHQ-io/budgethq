-- BudgetHQ product schema (Phase 1: backend + workspaces)
--
-- Workspaces, membership, and product entitlements are NOT owned here — they live in the shared
-- `core` schema (see the sibling paidhq-core repo's db/schema.sql), in this SAME Postgres
-- database. This schema only holds BudgetHQ's own product data, namespaced under `budgethq.*`,
-- foreign-keyed against core.workspaces(id). Run paidhq-core's migration FIRST — core.workspaces
-- has to exist before these foreign keys can be created.
--
-- Why one shared database with per-product schemas, not a separate database per product: BudgetHQ
-- is meant to be the first of a suite (VaultHQ, ReportingHQ, AuditHQ...) sold under one PaidHQ
-- account — one login, one billing relationship, one workspace concept across all of them. Giving
-- each product its own database would mean rebuilding auth/workspace/billing logic N times; giving
-- them their own schema in one database keeps everything cleanly separated (no product can
-- accidentally read another's tables) while still being one thing to operate as a solo builder.
--
-- Why tags/budgets/dimensions stay JSONB rather than fully normalized: these shapes are deeply
-- threaded through BudgetHQ's existing pacing/computation functions (computePacing,
-- computeCustomGrouping, etc.) — normalizing them into relational tables would mean rewriting
-- that already-verified logic. JSONB gets us server persistence and workspace isolation without
-- touching the math. Revisit if/when cross-workspace rollups are needed.
--
-- Why spend_rows is a real table, not JSONB: it's the one dataset that actually grows large and
-- benefits from indexed date-range queries — also the table an alert-checking cron job (Phase 3)
-- will query most.

create extension if not exists "pgcrypto";

create schema if not exists budgethq;

-- One row per workspace holding everything that isn't spend rows: tags, tag dimensions, budgets,
-- budget dimensions, and their associated metadata. Mirrors the shape already used client-side in
-- BudgetHQ.jsx (tags, tagDims, budgets, budgetDims, budgetRowMeta, budgetMetaDims,
-- budgetImportMeta) so migrating the data layer is a lift-and-shift, not a redesign.
create table if not exists budgethq.workspace_config (
  workspace_id uuid primary key references core.workspaces(id) on delete cascade,
  tags jsonb not null default '{}',
  tag_dims jsonb not null default '[]',
  budgets jsonb not null default '{}',
  budget_dims jsonb not null default '[]',
  budget_row_meta jsonb not null default '{}',
  budget_meta_dims jsonb not null default '[]',
  budget_import_meta jsonb not null default '{}',
  updated_at timestamptz not null default now()
);

create table if not exists budgethq.spend_rows (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references core.workspaces(id) on delete cascade,
  campaign_group_name text not null default '',
  campaign_name text not null default '',
  campaign_id text,
  platform text,
  campaign_type text,
  date date not null,
  as_of_date date,
  spend numeric not null default 0,
  impressions numeric not null default 0,
  clicks numeric not null default 0,
  source text, -- e.g. "csv:google-ads-export.csv" or "sync:linkedin" — for provenance/debugging
  created_at timestamptz not null default now()
);
create index if not exists idx_budgethq_spend_rows_workspace_date on budgethq.spend_rows(workspace_id, date);
create index if not exists idx_budgethq_spend_rows_workspace_platform on budgethq.spend_rows(workspace_id, platform);

-- Ask AI chat history — keyed by (workspace_id, user_id), NOT a single row per workspace like
-- workspace_config above. Chats are a personal scratchpad, not shared workspace data everyone on
-- the team should see merged together — each person's history stays their own, same as it was
-- when this lived in localStorage (per-browser, implicitly per-person), just now durable across
-- devices/logins and correctly scoped per workspace instead of leaking across every workspace in
-- one browser. Deliberately NOT gated by requireEditAccess in the API route — a "member" (view-
-- only) role restricts changes to real workspace data (budgets/tags/spend), not someone's own AI
-- conversation history, which can't damage anything shared.
create table if not exists budgethq.ai_chats (
  workspace_id uuid not null references core.workspaces(id) on delete cascade,
  user_id uuid not null,
  chats jsonb not null default '[]',
  updated_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create table if not exists budgethq.files (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references core.workspaces(id) on delete cascade,
  name text not null,
  category text not null default 'Manual upload',
  mime_type text,
  size_bytes integer not null default 0,
  data bytea not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_budgethq_files_workspace on budgethq.files(workspace_id, created_at desc);

create table if not exists budgethq.versions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references core.workspaces(id) on delete cascade,
  label text,
  trigger text,
  snapshot jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_budgethq_versions_workspace on budgethq.versions(workspace_id, created_at desc);

-- Per-workspace third-party connector credentials — e.g. a Funnel.io or Supermetrics API key the
-- workspace owner pastes in once, rather than the single shared process.env credential the
-- linkedin/bing/capterra/google/meta connectors use today (those pull from one account for the
-- whole app; this table is what lets each workspace connect its OWN account for connectors that
-- support that — Funnel.io, Supermetrics, Capterra (2026-07-22, API key), LinkedIn (2026-07-22,
-- full OAuth2 — credential holds {accessToken, refreshToken, expiresAt, accountId}) and Bing
-- (2026-07-22, full OAuth2 — credential holds {accessToken, refreshToken, expiresAt, accountId,
-- customerId, reconnectRequired}). `credential` is jsonb rather than a single text column because
-- different providers need different shapes — Funnel.io needs {apiToken, accountId, projectId},
-- Supermetrics needs {apiKey, dsId, dsAccounts}, Capterra needs {apiKeys} — and this way adding a
-- new per-workspace-auth provider later doesn't require another migration.
--
-- No encryption-at-rest beyond Postgres/Neon's own at-rest encryption — same trust model as every
-- other table in this schema (single database, only ever touched server-side via these API
-- routes). The API layer's job is to make sure `credential` is never echoed back to the client
-- once saved (see connections.js) — that's the actual boundary that matters, not column-level
-- encryption of a value nothing outside this database ever reads directly.
create table if not exists budgethq.connector_credentials (
  workspace_id uuid not null references core.workspaces(id) on delete cascade,
  provider text not null check (provider in ('funnel','supermetrics','capterra','linkedin','bing')),
  credential jsonb not null,
  connected_by uuid not null,
  connected_at timestamptz not null default now(),
  primary key (workspace_id, provider)
);

-- The check constraint above only takes effect on a fresh create. For a database where this table
-- already exists with an older, narrower constraint, drop + re-add it here — both statements are
-- safe to run every time migrate.js re-applies this file (DROP ... IF EXISTS no-ops once dropped,
-- then ADD CONSTRAINT re-adds the same definition instead of erroring).
alter table budgethq.connector_credentials drop constraint if exists connector_credentials_provider_check;
alter table budgethq.connector_credentials add constraint connector_credentials_provider_check
  check (provider in ('funnel','supermetrics','capterra','linkedin','bing'));

-- Recurring sync config (2026-07-23) — every connection defaults to 'manual' (today's only mode:
-- someone clicks Sync in the Reporting tab or the Connections settings row). Setting sync_mode to
-- 'rolling' opts a connection into api/cron/sync-connectors.js's daily heartbeat, which re-pulls
-- just the last `rolling_window_days` days for that connector on the cadence in `sync_frequency` —
-- see that file's doc comment for why a single daily heartbeat (not an hourly one) covers both
-- 'daily' and 'weekly' without hitting Vercel Hobby's "cron jobs can only run once a day" limit.
-- last_auto_sync_* columns exist so a failed unattended run (expired token, API error) is visible
-- in Settings' Connections table instead of silently never updating data again — nobody's watching
-- a cron job the way they'd notice a manual Sync button's error toast.
alter table budgethq.connector_credentials add column if not exists sync_mode text not null default 'manual';
alter table budgethq.connector_credentials drop constraint if exists connector_credentials_sync_mode_check;
alter table budgethq.connector_credentials add constraint connector_credentials_sync_mode_check
  check (sync_mode in ('manual','rolling'));
alter table budgethq.connector_credentials add column if not exists rolling_window_days integer;
alter table budgethq.connector_credentials add column if not exists sync_frequency text;
alter table budgethq.connector_credentials drop constraint if exists connector_credentials_sync_frequency_check;
alter table budgethq.connector_credentials add constraint connector_credentials_sync_frequency_check
  check (sync_frequency is null or sync_frequency in ('daily','weekly'));
alter table budgethq.connector_credentials add column if not exists last_auto_sync_at timestamptz;
alter table budgethq.connector_credentials add column if not exists last_auto_sync_status text;
alter table budgethq.connector_credentials add column if not exists last_auto_sync_error text;

-- Phase 3 (alerts) — table laid out now so the schema doesn't need another migration when that
-- phase starts, but nothing reads/writes this yet.
create table if not exists budgethq.alert_rules (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references core.workspaces(id) on delete cascade,
  type text not null, -- 'pacing_threshold' | 'sync_stale'
  scope jsonb not null default '{}', -- e.g. {"dims":{"Platform":"Google"}} to scope to a segment
  threshold_pct numeric, -- for pacing_threshold: e.g. 15 = alert at +/-15% off expected pace
  stale_days integer, -- for sync_stale: alert if no new spend row in N days
  channels jsonb not null default '["email"]', -- subset of ["email","slack"]
  enabled boolean not null default true,
  created_by uuid not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_budgethq_alert_rules_workspace on budgethq.alert_rules(workspace_id);
