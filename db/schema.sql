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

-- ALL SIX TABLES BELOW ARE DEPRECATED (2026-07-27) — superseded by their identically-shaped
-- core.* counterparts in paidhq-core/db/schema.sql (core.workspace_config, core.spend_rows,
-- core.ai_chats, core.files, core.versions, core.alert_rules). Per Mo: not just connector
-- credentials, but ALL workspace data — uploads, screenshots, CSV/Excel data, budget data
-- (including tags/budgets/dimensions), spend data, attachments/resources, AI chats, context,
-- conversations — is universal across every module (BudgetHQ, VaultHQ, ReportingHQ, FocusHQ,
-- AuditHQ) and node (smaller point-solution tools), not siloed to whichever product built the
-- feature first. No BudgetHQ code writes to the budgethq.* tables below anymore as of this date —
-- every route now reads/writes core.* instead (see the 9 backend files updated alongside this
-- migration). Left in place below, not dropped, as a rollback safety net until the switch has run
-- in production for a while with no issues — same pattern already used for
-- budgethq.connector_credentials a little further down this file. Drop in a later cleanup pass.
--
-- Original doc comments on each table preserved below for history.

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

-- Saved Views (item 42, 2026-07-24) — array of {id,name,createdAt,viewMode,customDims,
-- segFilters,statusFilter,breakdownDim,trendFilterDim,trendFilterValue,trendSeriesDim,
-- trendMonthSpan} objects, built entirely client-side by PacingDashboard — see BudgetHQ.jsx's
-- currentViewConfig/applyViewConfig. Added via `alter table` (not folded into the `create table`
-- above) since that table already exists in production; this runs safely on every deploy either
-- way per this file's idempotent-migration convention (see db/migrate.js's doc comment).
alter table budgethq.workspace_config add column if not exists saved_views jsonb not null default '[]';

-- Global default forecast model (item 45, 2026-07-25) — workspace-wide fallback for
-- computePacing's per-segment forecastModel, used whenever a budget row has no explicit
-- budget_row_meta[segKey]._forecastModel override. Plain text, not jsonb, since it's always one
-- of FORECAST_MODELS' string values (see lib/core.js) — 'full-period' matched computePacing's
-- pre-existing implicit default at the time, so an unconfigured workspace's pacing math was
-- unchanged when this column was first added.
alter table budgethq.workspace_config add column if not exists default_forecast_model text not null default 'full-period';
-- Auto/Manual/Committed redesign (2026-07-25, see lib/core.js's FORECAST_MODELS doc comment) —
-- 'auto' is the new adaptive default, replacing the old always-cumulative 'full-period'. A plain
-- `alter column set default` (unlike `add column if not exists` above) re-runs safely on every
-- deploy per this file's idempotent-migration convention, and actually takes effect on a column
-- that already exists from before this change — needed since only NEW rows pick up a column
-- default; this doesn't touch any workspace_config row that's already set the old default.
alter table budgethq.workspace_config alter column default_forecast_model set default 'auto';

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

-- DEPRECATED (2026-07-27) — superseded by core.connector_credentials, see the migration note a
-- little further down this file and paidhq-core's db/schema.sql. No BudgetHQ code writes to this
-- table anymore as of that date; kept only as an unused rollback safety net, not touched by the
-- app. Original doc comment preserved below for history.
--
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
  provider text not null check (provider in ('funnel','supermetrics','capterra','linkedin','bing','meta','google')),
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
  check (provider in ('funnel','supermetrics','capterra','linkedin','bing','meta','google'));

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

-- Pause / exclude (2026-07-24) — two independent, reversible controls surfaced in the Data
-- Sources tab's connector table (Funnel.io-style), neither of which touches the stored credential
-- or deletes anything:
--   paused: stops this connection from syncing at all — api/cron/sync-connectors.js skips it
--     outright, and the frontend disables its manual Sync button too. Distinct from sync_mode
--     ('manual' vs 'rolling') which controls WHETHER cron ever looks at it; paused overrides both
--     and blocks manual syncs as well, which sync_mode alone can't do.
--   excluded_from_data: the connection can keep syncing (unless also paused), but every row this
--     provider has ever contributed is filtered out of BudgetHQ's calculations/views client-side
--     (see BudgetHQ.jsx's visibleNormRows) — the underlying spend rows are never deleted, so
--     un-excluding brings everything back immediately with no re-sync needed.
alter table budgethq.connector_credentials add column if not exists paused boolean not null default false;
alter table budgethq.connector_credentials add column if not exists excluded_from_data boolean not null default false;

-- MOVED TO core.connector_credentials (2026-07-27, per Mo — building ReportingHQ on the same
-- Google/Meta/LinkedIn/Bing connections BudgetHQ already has, without a second OAuth flow). Every
-- BudgetHQ route now reads/writes core.connector_credentials instead of the table above — see
-- paidhq-core's db/schema.sql for the (identical-shape) table definition and its own doc comment
-- for the reasoning. This one-time copy carries over whatever's already connected in production so
-- existing users don't have to reconnect anything; safe to re-run on every deploy (ON CONFLICT DO
-- NOTHING — a workspace+provider pair core already has is left untouched, never overwritten by a
-- possibly-stale copy from this old table).
--
-- IMPORTANT: this INSERT will silently do nothing until paidhq-core has been deployed with its own
-- schema.sql change FIRST (core.connector_credentials has to exist before this can insert into
-- it) — same "core migrates first" ordering this file's own header comment already documents for
-- core.workspaces.
--
-- budgethq.connector_credentials itself is deliberately left in place below, not dropped — a
-- rollback safety net until the switch to core.connector_credentials has run in production for a
-- while with no issues. Drop it in a later cleanup pass once that's confirmed, not in this change.
insert into core.connector_credentials
  (workspace_id, provider, credential, connected_by, connected_at, sync_mode, rolling_window_days,
   sync_frequency, last_auto_sync_at, last_auto_sync_status, last_auto_sync_error, paused, excluded_from_data)
select
  workspace_id, provider, credential, connected_by, connected_at, sync_mode, rolling_window_days,
  sync_frequency, last_auto_sync_at, last_auto_sync_status, last_auto_sync_error, paused, excluded_from_data
from budgethq.connector_credentials
on conflict (workspace_id, provider) do nothing;

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

-- MOVED TO core.* (2026-07-27, per Mo — see the deprecation banner right after `create schema
-- budgethq` above for the full reasoning). One-time copy of whatever's already in production for
-- each table, same ON CONFLICT DO NOTHING safety as the connector_credentials copy above: a row
-- core already has is left untouched, never overwritten by a possibly-stale copy from here. Safe
-- to re-run on every deploy. Requires paidhq-core to have deployed its own schema.sql change FIRST
-- (the core.* tables have to exist before these can insert into them).
insert into core.workspace_config
  (workspace_id, tags, tag_dims, budgets, budget_dims, budget_row_meta, budget_meta_dims,
   budget_import_meta, saved_views, default_forecast_model, updated_at)
select
  workspace_id, tags, tag_dims, budgets, budget_dims, budget_row_meta, budget_meta_dims,
  budget_import_meta, saved_views, default_forecast_model, updated_at
from budgethq.workspace_config
on conflict (workspace_id) do nothing;

insert into core.spend_rows
  (id, workspace_id, campaign_group_name, campaign_name, campaign_id, platform, campaign_type,
   date, as_of_date, spend, impressions, clicks, source, created_at)
select
  id, workspace_id, campaign_group_name, campaign_name, campaign_id, platform, campaign_type,
  date, as_of_date, spend, impressions, clicks, source, created_at
from budgethq.spend_rows
on conflict (id) do nothing;

insert into core.ai_chats (workspace_id, user_id, chats, updated_at)
select workspace_id, user_id, chats, updated_at
from budgethq.ai_chats
on conflict (workspace_id, user_id) do nothing;

insert into core.files (id, workspace_id, name, category, mime_type, size_bytes, data, created_at)
select id, workspace_id, name, category, mime_type, size_bytes, data, created_at
from budgethq.files
on conflict (id) do nothing;

insert into core.versions (id, workspace_id, label, trigger, snapshot, created_at)
select id, workspace_id, label, trigger, snapshot, created_at
from budgethq.versions
on conflict (id) do nothing;

insert into core.alert_rules
  (id, workspace_id, type, scope, threshold_pct, stale_days, channels, enabled, created_by, created_at)
select
  id, workspace_id, type, scope, threshold_pct, stale_days, channels, enabled, created_by, created_at
from budgethq.alert_rules
on conflict (id) do nothing;

-- core.entitlements.product has a CHECK CONSTRAINT (defined in the sibling paidhq-core repo's
-- own db/schema.sql, since core.entitlements is a shared table this schema doesn't own) that
-- didn't originally allow 'paidhq' as a value — the UPDATE just below failed against production
-- with "violates check constraint entitlements_product_check" the first time this ran, because
-- that constraint still only allowed the old 5 product slugs including 'budgethq'. Carrying an
-- identical copy of paidhq-core's own idempotent fix here too so this deploy doesn't depend on
-- paidhq-core deploying first — whichever of the two projects deploys first actually changes the
-- constraint on the shared database, the other's copy of this same ALTER is just a no-op re-run.
--
-- 'budgethq' is deliberately kept IN the allow-list alongside 'paidhq', not replaced by it —
-- second production failure, same deploy: Postgres validates a freshly-added CHECK CONSTRAINT
-- against every EXISTING row immediately, so excluding 'budgethq' here made the ALTER itself fail
-- ("violated by some row") against every un-migrated 'budgethq' row still in the table at the
-- moment this ran — which is all of them, since the UPDATE below hasn't executed yet at this
-- point in the script. Keeping both values accepted makes this ALTER succeed regardless of
-- ordering; nothing writes 'budgethq' anymore so it's a permanently-harmless extra allowed value,
-- not an ongoing state to worry about.
alter table core.entitlements drop constraint if exists entitlements_product_check;
alter table core.entitlements add constraint entitlements_product_check
  check (product in ('paidhq','budgethq','vaulthq','reportinghq','focushq','audithq'));

-- One-time data migration (2026-07-31): the product was renamed from BudgetHQ to PaidHQ.
-- Existing entitlement rows in core.entitlements still say product = 'budgethq' from before the
-- rename; update them to 'paidhq' so requireEntitlement's check (api/lib/auth.js, which now
-- checks for 'paidhq') keeps matching active/trialing subscribers instead of locking them out on
-- deploy. Safe to run repeatedly — once no rows match 'budgethq' this becomes a no-op, same as
-- every other statement in this file.
update core.entitlements set product = 'paidhq' where product = 'budgethq';
