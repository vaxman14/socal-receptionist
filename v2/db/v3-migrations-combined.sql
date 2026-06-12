-- ============================================================
-- Migration: 001_init.sql
-- ============================================================

-- =============================================================================
-- SoCal Receptionist V2 — multi-tenant data model
-- Migration 001: initial schema
--
-- Target: Supabase Postgres. Apply via the Supabase SQL editor or `supabase db
-- push`. Tenant isolation is enforced with Row Level Security (RLS):
--   * the backend SMS + provisioning service uses the service role key and
--     bypasses RLS entirely;
--   * the client admin and owner admin apps use the anon/auth key and are
--     constrained by the policies at the bottom of this file.
--
-- Build context: this is step 2 of the V2 build order (provisioning state
-- machine) — the data model every later step depends on. See
-- memory/socal-receptionist-v2-plan.md.
-- =============================================================================

create extension if not exists pgcrypto;   -- gen_random_uuid()

-- --- Enum types --------------------------------------------------------------

-- Tenant lifecycle. Codex review: provisioning must be an explicit state
-- machine, not an inline Stripe-webhook side effect.
create type tenant_status as enum (
  'onboarding',              -- account created, business config in progress
  'sms_pending_compliance',  -- configured; awaiting A2P 10DLC carrier review
  'active',                  -- fully live
  'suspended_billing',       -- payment failed / subscription lapsed
  'suspended_compliance',    -- carrier / opt-out / abuse hold
  'failed_provisioning'      -- unrecoverable setup failure -> manual review
);

-- Mirrors Stripe subscription statuses. Stripe drives entitlements; the app
-- decides service access from this mirrored record, not from Stripe live.
create type subscription_status as enum (
  'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'incomplete'
);

create type phone_number_type   as enum ('toll_free', 'local_10dlc');
create type phone_number_status as enum ('pending', 'active', 'released');

create type conversation_status as enum ('open', 'closed');
create type message_direction   as enum ('inbound', 'outbound');
create type message_role        as enum ('user', 'assistant', 'system', 'tool');

create type consent_status as enum ('unknown', 'pending', 'opted_in', 'opted_out');

create type lead_status as enum ('new', 'qualified', 'contacted', 'won', 'lost');

-- Twilio message lifecycle (status callbacks).
create type delivery_status as enum (
  'queued', 'sending', 'sent', 'delivered', 'undelivered', 'failed', 'received'
);

create type provisioning_job_status as enum (
  'pending', 'running', 'succeeded', 'failed', 'needs_review'
);

-- --- updated_at helper -------------------------------------------------------

create or replace function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- =============================================================================
-- Core tables
-- =============================================================================

-- A tenant = one customer business. Inbound SMS is routed to a tenant by the
-- Twilio `To` number (see phone_numbers).
create table tenants (
  id                uuid primary key default gen_random_uuid(),
  slug              text unique not null,
  owner_user_id     uuid references auth.users(id) on delete set null,
  status            tenant_status not null default 'onboarding',

  -- Business profile (the V1 per-client env vars, now per-row).
  business_name     text not null,
  business_hours    text,
  business_services text,
  calendly_link     text,
  owner_email       text not null,
  timezone          text not null default 'America/Los_Angeles',

  -- AI config, per tenant.
  ai_model          text not null default 'gpt-4o',
  ai_system_prompt  text,                       -- optional override of the default prompt

  -- Per-tenant spend caps + usage counters (Codex hardening). cents; null cap = uncapped.
  -- Counters reset monthly via record_tenant_usage().
  sms_spend_cap_cents        integer,
  openai_spend_cap_cents     integer,
  monthly_sms_count          integer not null default 0,
  monthly_sms_spend_cents    integer not null default 0,
  monthly_openai_spend_cents integer not null default 0,
  usage_period_start         date    not null default current_date,

  activated_at      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- Billing. One row per tenant; mirrors the Stripe subscription.
create table subscriptions (
  id                     uuid primary key default gen_random_uuid(),
  tenant_id              uuid not null references tenants(id) on delete cascade,
  stripe_customer_id     text,
  stripe_subscription_id text unique,
  plan                   text,
  status                 subscription_status not null default 'incomplete',
  trial_ends_at          timestamptz,
  current_period_end     timestamptz,
  cancel_at_period_end   boolean not null default false,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
create unique index subscriptions_one_per_tenant on subscriptions (tenant_id);

-- Twilio numbers. V2 uses Messaging Services, so a number carries its service
-- + A2P campaign SIDs.
create table phone_numbers (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references tenants(id) on delete cascade,
  phone_e164            text unique not null,
  number_type           phone_number_type   not null,
  status                phone_number_status not null default 'pending',
  twilio_sid            text,
  messaging_service_sid text,
  a2p_brand_sid         text,
  a2p_campaign_sid      text,
  purchased_at          timestamptz,
  released_at           timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index phone_numbers_tenant_idx on phone_numbers (tenant_id);

-- A conversation thread with one customer. Replaces V1's in-memory store.js.
create table conversations (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  customer_phone  text not null,
  status          conversation_status not null default 'open',
  last_message_at timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
-- At most one open thread per customer per tenant; new texts append to it.
create unique index conversations_one_open
  on conversations (tenant_id, customer_phone) where status = 'open';
create index conversations_recent_idx
  on conversations (tenant_id, last_message_at desc);

-- Full transcript. Every inbound + outbound message, including AI turns.
create table messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  tenant_id       uuid not null references tenants(id) on delete cascade,
  direction       message_direction not null,
  role            message_role not null,
  body            text not null,
  twilio_sid      text,
  openai_tokens   integer,
  cost_cents      integer,
  created_at      timestamptz not null default now()
);
create index messages_conversation_idx on messages (conversation_id, created_at);
create index messages_tenant_idx on messages (tenant_id, created_at desc);

-- Qualified leads captured by the AI receptionist.
create table leads (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id) on delete cascade,
  conversation_id  uuid references conversations(id) on delete set null,
  customer_phone   text not null,
  customer_name    text,
  service_interest text,
  status           lead_status not null default 'new',
  notes            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index leads_tenant_idx on leads (tenant_id, created_at desc);

-- SMS opt-in/opt-out consent. V1 tracked this globally; V2 scopes it per tenant.
create table consent (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  phone       text not null,
  status      consent_status not null default 'unknown',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (tenant_id, phone)
);

-- Twilio delivery receipts (status callbacks) per message.
create table message_status (
  id          uuid primary key default gen_random_uuid(),
  message_id  uuid references messages(id) on delete cascade,
  tenant_id   uuid not null references tenants(id) on delete cascade,
  twilio_sid  text,
  status      delivery_status not null,
  error_code  text,
  raw         jsonb,
  created_at  timestamptz not null default now()
);
create index message_status_sid_idx on message_status (twilio_sid);

-- Async provisioning queue — the engine behind the tenant state machine.
-- Jobs are picked up by a worker, retried with backoff, and escalated to
-- 'needs_review' for the manual queue on permanent failure.
create table provisioning_jobs (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  job_type      text not null,   -- purchase_number | register_a2p | attach_messaging_service | ...
  status        provisioning_job_status not null default 'pending',
  attempts      integer not null default 0,
  max_attempts  integer not null default 5,
  payload       jsonb   not null default '{}'::jsonb,
  last_error    text,
  run_after     timestamptz not null default now(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index provisioning_jobs_due_idx on provisioning_jobs (status, run_after);

-- Idempotency ledger. Stripe event ids, Twilio MessageSids, etc. — insert
-- before processing; a duplicate insert (pk conflict) means already handled.
create table processed_events (
  id           text primary key,   -- external event id
  source       text not null,      -- 'stripe' | 'twilio'
  processed_at timestamptz not null default now()
);

-- Super-admin audit trail. tenant_id null = platform-level event.
create table audit_log (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid references tenants(id) on delete set null,
  actor_type    text not null,     -- 'system' | 'owner' | 'client'
  actor_user_id uuid references auth.users(id) on delete set null,
  action        text not null,
  target_type   text,
  target_id     text,
  metadata      jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);
create index audit_log_tenant_idx on audit_log (tenant_id, created_at desc);

-- Platform admins (Roman). Drives the is_platform_admin() RLS check.
create table platform_admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

-- --- updated_at triggers -----------------------------------------------------

create trigger trg_tenants_updated     before update on tenants
  for each row execute function set_updated_at();
create trigger trg_subscriptions_updated before update on subscriptions
  for each row execute function set_updated_at();
create trigger trg_phone_numbers_updated before update on phone_numbers
  for each row execute function set_updated_at();
create trigger trg_conversations_updated before update on conversations
  for each row execute function set_updated_at();
create trigger trg_leads_updated       before update on leads
  for each row execute function set_updated_at();
create trigger trg_consent_updated     before update on consent
  for each row execute function set_updated_at();
create trigger trg_provisioning_jobs_updated before update on provisioning_jobs
  for each row execute function set_updated_at();

-- --- usage accounting --------------------------------------------------------
-- Atomically roll the monthly usage window (if the month changed) and add the
-- supplied usage. Called from the SMS path; keeps concurrent writes correct.
create or replace function record_tenant_usage(
  p_tenant uuid,
  p_sms integer,
  p_sms_cents integer,
  p_openai_cents integer
) returns void
language plpgsql security definer set search_path = public as $$
declare
  period date := date_trunc('month', now())::date;
begin
  update tenants set
    monthly_sms_count =
      (case when usage_period_start < period then 0 else monthly_sms_count end) + p_sms,
    monthly_sms_spend_cents =
      (case when usage_period_start < period then 0 else monthly_sms_spend_cents end) + p_sms_cents,
    monthly_openai_spend_cents =
      (case when usage_period_start < period then 0 else monthly_openai_spend_cents end) + p_openai_cents,
    usage_period_start = period
  where id = p_tenant;
end;
$$;

-- =============================================================================
-- Row Level Security
--
-- The service role bypasses every policy below; it is the only writer for the
-- SMS pipeline, billing webhooks, and provisioning jobs. Policies here govern
-- the auth-key apps: a tenant owner sees only their own tenant, a platform
-- admin sees everything. Column-level write restrictions (e.g. a client must
-- not edit `status` or spend caps) are enforced in the API layer.
-- =============================================================================

create or replace function is_platform_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from platform_admins where user_id = auth.uid());
$$;

create or replace function owns_tenant(t uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from tenants where id = t and owner_user_id = auth.uid()
  );
$$;

alter table tenants           enable row level security;
alter table subscriptions     enable row level security;
alter table phone_numbers     enable row level security;
alter table conversations     enable row level security;
alter table messages          enable row level security;
alter table leads             enable row level security;
alter table consent           enable row level security;
alter table message_status    enable row level security;
alter table provisioning_jobs enable row level security;
alter table audit_log         enable row level security;
alter table platform_admins   enable row level security;
alter table processed_events  enable row level security;  -- no policy = service-role only

-- tenants: owner reads + edits own row; admin sees all. Creation/deletion is
-- service-role only (onboarding pipeline).
create policy tenants_select on tenants for select
  using (owner_user_id = auth.uid() or is_platform_admin());
create policy tenants_update on tenants for update
  using (owner_user_id = auth.uid() or is_platform_admin());

-- Read-only-to-clients tables: owner + admin may select, no client writes.
create policy subscriptions_select on subscriptions for select
  using (owns_tenant(tenant_id) or is_platform_admin());
create policy phone_numbers_select on phone_numbers for select
  using (owns_tenant(tenant_id) or is_platform_admin());
create policy conversations_select on conversations for select
  using (owns_tenant(tenant_id) or is_platform_admin());
create policy messages_select on messages for select
  using (owns_tenant(tenant_id) or is_platform_admin());
create policy message_status_select on message_status for select
  using (owns_tenant(tenant_id) or is_platform_admin());
create policy consent_select on consent for select
  using (owns_tenant(tenant_id) or is_platform_admin());

-- leads: clients work their pipeline, so they may select + update own rows.
create policy leads_select on leads for select
  using (owns_tenant(tenant_id) or is_platform_admin());
create policy leads_update on leads for update
  using (owns_tenant(tenant_id) or is_platform_admin());

-- provisioning_jobs: internal; platform admin visibility only.
create policy provisioning_jobs_select on provisioning_jobs for select
  using (is_platform_admin());

-- audit_log: owner sees own tenant's entries; admin sees all (incl. platform).
create policy audit_log_select on audit_log for select
  using ((tenant_id is not null and owns_tenant(tenant_id)) or is_platform_admin());

-- platform_admins: admin-visible only.
create policy platform_admins_select on platform_admins for select
  using (is_platform_admin());



-- ============================================================
-- Migration: 002_agreements.sql
-- ============================================================

-- =============================================================================
-- SoCal Receptionist V2 — Migration 002: signed service agreements
--
-- A real, legally-binding e-signature record — not a "tap to accept terms" box.
-- Each row is one executed Service Agreement: who signed, which exact contract
-- version (+ SHA-256 hash of the signed text), and the ESIGN/UETA audit trail
-- (IP, user agent, timestamp, the consent language they agreed to).
--
-- Provisioning is gated on a valid row here — see provisioning/handlers.js.
-- Rows are immutable: corrections happen by signing a new version; an agreement
-- is ended by setting revoked_at, never by UPDATE/DELETE of the signed fields.
--
-- Apply AFTER 001_init.sql.
-- =============================================================================

create table service_agreements (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id) on delete cascade,

  -- Exactly what was signed.
  contract_version  text not null,                 -- e.g. 'v1'
  contract_hash     text not null,                 -- sha256(hex) of the signed contract text

  -- The signature itself. A typed full legal name is the signature under ESIGN.
  signer_name       text not null,
  signer_email      text not null,
  signer_title      text,

  -- ESIGN / UETA audit trail — establishes attribution + intent.
  signer_ip         text,
  signer_user_agent text,
  consent_text      text not null,                 -- the e-sign disclosure they agreed to, verbatim
  signer_user_id    uuid references auth.users(id) on delete set null,

  signed_at         timestamptz not null default now(),
  revoked_at        timestamptz,                   -- set to end an agreement; never delete
  created_at        timestamptz not null default now()
);

create index service_agreements_tenant_idx
  on service_agreements (tenant_id, signed_at desc);

-- At most one *active* (non-revoked) agreement per tenant per contract version.
create unique index service_agreements_one_active
  on service_agreements (tenant_id, contract_version)
  where revoked_at is null;

-- --- Row Level Security ------------------------------------------------------
-- Writes are service-role only (the onboarding API). Owners + platform admins
-- may read their own executed agreement; nobody edits a signed row.

alter table service_agreements enable row level security;

create policy service_agreements_select on service_agreements for select
  using (owns_tenant(tenant_id) or is_platform_admin());



-- ============================================================
-- Migration: 003_documents.sql
-- ============================================================

-- =============================================================================
-- SoCal Receptionist V2 — Migration 003: editable documents
--
-- Moves two things out of hardcoded code and into the database so the platform
-- owner can manage them from the admin UI without a deploy:
--
--   * legal_documents   — privacy / terms / cookies / accessibility / faq /
--                         support page content (editable in place).
--   * contract_versions — the e-sign Service Agreement. Uploading a new version
--                         creates a row; publishing it makes it the one new
--                         clients sign. Old versions are kept (signed records
--                         in service_agreements reference them by version+hash).
--
-- Apply AFTER 002_agreements.sql. Seed content: scripts/seed-documents.js
-- (the contract also auto-seeds from server/contracts/ on first read).
-- =============================================================================

-- --- Editable policy / info pages -------------------------------------------

create table legal_documents (
  id          uuid primary key default gen_random_uuid(),
  slug        text unique not null,        -- privacy|terms|cookies|accessibility|faq|support
  title       text not null,
  body        text not null,               -- markdown
  updated_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create trigger trg_legal_documents_updated before update on legal_documents
  for each row execute function set_updated_at();

-- --- Versioned e-sign contracts ---------------------------------------------

create table contract_versions (
  id            uuid primary key default gen_random_uuid(),
  version       text unique not null,      -- 'v1', 'v2', ... — what service_agreements references
  title         text not null,
  body          text not null,             -- markdown — the exact text clients sign
  content_hash  text not null,             -- sha256(body) — frozen into each signature
  is_current    boolean not null default false,
  created_by    uuid references auth.users(id) on delete set null,
  published_at  timestamptz,
  created_at    timestamptz not null default now()
);

-- At most one current contract. Publishing a version unsets the others first.
create unique index contract_versions_single_current
  on contract_versions (is_current) where is_current = true;

-- --- Row Level Security ------------------------------------------------------

alter table legal_documents   enable row level security;
alter table contract_versions enable row level security;

-- legal_documents: public-facing page content — anyone may read; writes are
-- service-role only (the owner admin API).
create policy legal_documents_select on legal_documents for select
  using (true);

-- contract_versions: not public. Platform-admin read; writes service-role only.
create policy contract_versions_select on contract_versions for select
  using (is_platform_admin());



-- ============================================================
-- Migration: 004_voice.sql
-- ============================================================

-- =============================================================================
-- SoCal Receptionist V2 — Migration 004: voice receptionist + call routing
--
-- V1/V2 so far only handled SMS. This adds the voice channel:
--
--   * tenants gains voice config — whether voice is on, the IVR greeting, the
--     "reach a human" staff number (press 2 transfer target), and a voicemail
--     notification email.
--   * phone_numbers gains is_byo — a client who already promotes their own
--     number keeps it ("bring your own number"); the call/SMS still routes to
--     the tenant by the inbound `To`, so the only thing that changes is the
--     number wasn't purchased by our provisioning pipeline.
--   * calls — one row per inbound phone call, with how it ended (AI booked it,
--     transferred to staff, went to voicemail, missed, abandoned).
--
-- Apply AFTER 003_documents.sql.
-- =============================================================================

-- --- Voice config on the tenant ---------------------------------------------

alter table tenants
  add column if not exists voice_enabled   boolean not null default true,
  -- The "press 2 / speak to staff" transfer target. A cell, a desk line — any
  -- reachable number that is NOT the tenant's own published number (that would
  -- loop the call straight back into the receptionist).
  add column if not exists staff_phone     text,
  -- Optional override of the spoken IVR greeting. Null = generated default.
  add column if not exists voice_greeting  text,
  -- Where voicemail / missed-call notifications are emailed. Null = owner_email.
  add column if not exists voicemail_email text;

-- --- Bring-your-own-number flag ---------------------------------------------

alter table phone_numbers
  add column if not exists is_byo boolean not null default false;

comment on column phone_numbers.is_byo is
  'true = client''s pre-existing number (forwarded to us or webhook-pointed); '
  'false = number purchased by our provisioning pipeline.';

-- --- Call records ------------------------------------------------------------

create type call_outcome as enum (
  'in_progress',  -- call still live
  'ai_handled',   -- caller stayed with the AI receptionist (press 1)
  'transferred',  -- bridged to staff (press 2, staff answered)
  'voicemail',    -- caller left a message
  'missed',       -- press 2 but staff did not answer and no voicemail left
  'abandoned'     -- caller hung up before any resolution
);

create table calls (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  -- An AI-handled call may spin up / reuse the same conversation thread the
  -- customer's SMS uses (keyed by phone number), so transcripts stay unified.
  conversation_id uuid references conversations(id) on delete set null,
  twilio_call_sid text unique,
  from_number     text not null,
  to_number       text not null,
  outcome         call_outcome not null default 'in_progress',
  duration_seconds integer,
  recording_url   text,            -- voicemail recording, if any
  recording_sid   text,
  transcript      text,            -- voicemail transcription, if any
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index calls_tenant_idx on calls (tenant_id, created_at desc);

create trigger trg_calls_updated before update on calls
  for each row execute function set_updated_at();

-- --- Row Level Security ------------------------------------------------------
-- Same shape as conversations/messages: owner reads own tenant's calls, the
-- platform admin reads all. Writes are service-role only (the voice webhook).

alter table calls enable row level security;

create policy calls_select on calls for select
  using (owns_tenant(tenant_id) or is_platform_admin());



-- ============================================================
-- Migration: 005_billing_refund.sql
-- ============================================================

-- =============================================================================
-- SoCal Receptionist V2 — Migration 005: setup fee + 14-day refund tracking
--
-- Pricing model (set 2026-05-21): a client pays a one-time $1,500 setup fee at
-- checkout — that fee includes the first month of service — then $500/mo
-- recurring once the prepaid first month ends (a 30-day Stripe trial defers the
-- monthly charge).
--
-- If a client cancels within 14 days of paying the setup fee, $1,000 of that
-- fee is refunded automatically. To do that the billing code has to know which
-- payment to refund and when the clock started, so subscriptions gains:
--
--   * setup_payment_intent — the Stripe PaymentIntent that collected the fee.
--   * setup_paid_at        — when it was paid; start of the 14-day window.
--   * setup_refunded_at    — stamped once the $1,000 refund is issued; also the
--                            idempotency guard so the refund fires exactly once.
--
-- Apply AFTER 004_voice.sql.
-- =============================================================================

alter table subscriptions
  add column if not exists setup_payment_intent text,
  add column if not exists setup_paid_at        timestamptz,
  add column if not exists setup_refunded_at    timestamptz;



-- ============================================================
-- Migration: 006_mfa.sql
-- ============================================================

-- =============================================================================
-- SoCal Receptionist V2 — Migration 006: MFA trusted devices
--
-- The authenticator-app (TOTP) and passkey factors themselves live in Supabase
-- Auth (auth.mfa_factors) and need no schema here — Supabase owns them. What the
-- app DOES own is the "trust this device for 30 days" feature: after a user
-- clears the MFA challenge they can mark the current browser as trusted, which
-- lets later sign-ins on that browser skip the second factor.
--
-- A trust grant is a signed HMAC token (see server/auth/mfa.js, signed with
-- MFA_TOKEN_SECRET) handed to the browser. This table is the server-side ledger
-- of the grants that are still alive — so they can be listed in Settings and
-- revoked from any device. Only the SHA-256 hash of the token is stored: the
-- raw token never touches the database, so a DB leak cannot mint trusted
-- sessions.
--
-- Apply AFTER 005_billing_refund.sql.
-- =============================================================================

create table trusted_devices (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,

  -- sha256(hex) of the signed device-trust token. The raw token lives only in
  -- the browser; we match by hashing what the browser presents.
  token_hash    text not null unique,

  -- Human-friendly label shown in the Settings device list (defaults to a
  -- best-effort browser/OS guess derived from the user agent).
  label         text,
  user_agent    text,

  created_at    timestamptz not null default now(),
  -- Bumped each time the device presents a still-valid token at sign-in, so the
  -- Settings list can show "last used".
  last_seen_at  timestamptz not null default now(),
  -- Hard expiry — 30 days out by default. An expired row is ignored by the
  -- verify path even before it is swept.
  expires_at    timestamptz not null
);

create index trusted_devices_user_idx on trusted_devices (user_id, created_at desc);

-- --- Row Level Security ------------------------------------------------------
-- Trusted-device rows are issued, verified, and revoked exclusively by the
-- backend (server/auth/mfa.js) using the service role, which bypasses RLS.
-- Enabling RLS with no policy keeps the table invisible to the anon/auth-key
-- apps — they go through the backend, never query this table directly.

alter table trusted_devices enable row level security;



-- ============================================================
-- Migration: 007_time_tickets.sql
-- ============================================================

-- =============================================================================
-- SoCal Receptionist V3 — Migration 007: billable time tickets
--
-- Adds the time-tracking layer: one row per billable event (call, voicemail,
-- SMS conversation, manual entry). AI drafts the ticket from the call/message
-- transcript; the attorney reviews and accepts/edits/rejects.
--
-- Apply AFTER 006_mfa.sql.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- matters — optional client/matter labels for organizing tickets
-- ---------------------------------------------------------------------------
create table matters (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  name        text not null,
  matter_code text,           -- optional internal code (e.g. "2024-0042")
  client_name text,           -- shorthand for the counterparty / client name
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);
create index matters_tenant_idx on matters (tenant_id, is_active, name);

alter table matters enable row level security;
create policy matters_select on matters for select
  using (owns_tenant(tenant_id) or is_platform_admin());

-- ---------------------------------------------------------------------------
-- time_tickets — one row per billable event
-- ---------------------------------------------------------------------------
create type ticket_source as enum (
  'call_inbound',   -- auto-drafted from inbound AI-handled call
  'call_voicemail', -- auto-drafted from voicemail transcript
  'sms',            -- auto-drafted from SMS conversation
  'manual'          -- attorney typed it in
);

create type ticket_status as enum (
  'draft',     -- AI drafted, pending attorney review
  'accepted',  -- attorney approved as-is or edited
  'rejected'   -- attorney discarded
);

create type activity_type as enum (
  'phone_call',
  'consultation',
  'follow_up',
  'voicemail_review',
  'correspondence',
  'other'
);

create table time_tickets (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  -- Source record links (nullable — manual entries have no source)
  call_id         uuid references calls(id) on delete set null,
  conversation_id uuid references conversations(id) on delete set null,
  matter_id       uuid references matters(id) on delete set null,

  source          ticket_source not null default 'manual',
  status          ticket_status not null default 'draft',
  activity        activity_type not null default 'phone_call',

  -- Attorney-editable fields
  matter_name     text,           -- free-text if no matter_id selected yet
  client_name     text,
  description     text not null default '',
  duration_sec    integer,        -- billable duration in seconds
  billable_mins   integer,        -- rounded up to nearest 0.1h (6 min) block
  hourly_rate     numeric(10,2),  -- optional; pulled from tenant default if set

  -- AI-generated raw summary before attorney edits (kept for audit)
  ai_summary      text,
  ai_confidence   smallint,       -- 0-100: how confident AI was in the draft

  reviewed_at     timestamptz,
  reviewed_by     uuid references auth.users(id) on delete set null,
  billed_at       timestamptz,    -- set when pushed to practice mgmt / invoiced

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index time_tickets_tenant_idx  on time_tickets (tenant_id, created_at desc);
create index time_tickets_status_idx  on time_tickets (tenant_id, status);
create index time_tickets_call_idx    on time_tickets (call_id) where call_id is not null;

create trigger trg_time_tickets_updated before update on time_tickets
  for each row execute function set_updated_at();

alter table time_tickets enable row level security;
create policy time_tickets_select on time_tickets for select
  using (owns_tenant(tenant_id) or is_platform_admin());

-- ---------------------------------------------------------------------------
-- Tenant default hourly rate (optional — pulled when drafting tickets)
-- ---------------------------------------------------------------------------
alter table tenants
  add column if not exists default_hourly_rate numeric(10,2),
  add column if not exists billing_increment_mins integer not null default 6;

comment on column tenants.billing_increment_mins is
  'Minimum billing block in minutes (default 6 = 0.1h). Tickets round up to nearest block.';



-- ============================================================
-- Migration: 007_voice_id.sql
-- ============================================================

-- =============================================================================
-- SoCal Receptionist V2 — Migration 007: per-tenant voice selection
--
-- Adds a `voice_id` column to tenants so each client can pick their AI
-- receptionist's voice from the Twilio Polly Neural roster.
--
-- Apply AFTER 006_mfa.sql.
-- =============================================================================

alter table tenants
  add column if not exists voice_id text default 'Polly.Joanna-Neural';

comment on column tenants.voice_id is
  'Twilio TTS voice used for this tenant''s IVR. Must be a valid Polly Neural '
  'voice name (e.g. Polly.Joanna-Neural). Null falls back to platform default.';



-- ============================================================
-- Migration: 009_outbound_leads_integrations.sql
-- ============================================================

-- Migration 009: outbound leads + practice management integrations
-- Outbound call campaign tracking and OAuth token storage for Clio/MyCase/etc.

-- ── Outbound leads ────────────────────────────────────────────────────────────

create type outbound_lead_status as enum (
  'pending',         -- waiting to be called
  'calling',         -- call in progress
  'answered',        -- prospect picked up (may or may not become a lead)
  'voicemail',       -- left a voicemail
  'no_answer',       -- rang out / busy
  'lead_captured',   -- AI got name + business + contact
  'not_interested',  -- explicitly declined
  'dnc'              -- do not call (opted out or manual flag)
);

create table outbound_leads (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  name           text,
  phone          text not null,
  business_type  text,
  reason         text,           -- context injected into AI prompt ("They filled out our form")
  status         outbound_lead_status not null default 'pending',
  call_sid       text,           -- Twilio CallSid of the most recent attempt
  call_attempts  integer not null default 0,
  last_called_at timestamptz,
  notes          text,           -- post-call notes (auto-populated from AI transcript)
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index outbound_leads_tenant_idx    on outbound_leads (tenant_id, created_at desc);
create index outbound_leads_status_idx    on outbound_leads (tenant_id, status);
create index outbound_leads_call_sid_idx  on outbound_leads (call_sid) where call_sid is not null;

create trigger trg_outbound_leads_updated before update on outbound_leads
  for each row execute function set_updated_at();

-- ── Practice management integrations ─────────────────────────────────────────
-- Stores OAuth tokens (and API keys) for connected practice management systems.
-- One row per tenant per provider. Tokens are encrypted at rest by Supabase
-- (enable vault in production) — for now stored as plaintext, rotate on breach.

create table tenant_integrations (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id) on delete cascade,
  provider         text not null,   -- 'clio' | 'mycase' | 'filevine' | 'smokeball'
  enabled          boolean not null default true,
  access_token     text,
  refresh_token    text,
  token_expires_at timestamptz,
  extra            jsonb not null default '{}'::jsonb,
  -- extra: provider-specific. e.g. clio: { firm_id, firm_name }
  --                                 mycase: { account_id }
  last_sync_at     timestamptz,
  last_error       text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (tenant_id, provider)
);

create index tenant_integrations_tenant_idx on tenant_integrations (tenant_id);

create trigger trg_tenant_integrations_updated before update on tenant_integrations
  for each row execute function set_updated_at();

-- ── RLS ───────────────────────────────────────────────────────────────────────

alter table outbound_leads       enable row level security;
alter table tenant_integrations  enable row level security;

create policy outbound_leads_select on outbound_leads for select
  using (owns_tenant(tenant_id) or is_platform_admin());
create policy outbound_leads_update on outbound_leads for update
  using (owns_tenant(tenant_id) or is_platform_admin());

-- Integrations: owner + platform admin read/write. Tokens visible to owner
-- so they can disconnect. Write-through goes via the backend service role.
create policy tenant_integrations_select on tenant_integrations for select
  using (owns_tenant(tenant_id) or is_platform_admin());
create policy tenant_integrations_update on tenant_integrations for update
  using (owns_tenant(tenant_id) or is_platform_admin());



-- ============================================================
-- Migration: 010_rls_complete.sql
-- ============================================================

-- 010_rls_complete.sql
-- Add missing write policies for tables that frontend clients need to modify.

-- trusted_devices: per-user (not per-tenant); users manage their own devices
create policy trusted_devices_select on trusted_devices for select
  using (user_id = auth.uid());
create policy trusted_devices_insert on trusted_devices for insert
  with check (user_id = auth.uid());
create policy trusted_devices_delete on trusted_devices for delete
  using (user_id = auth.uid());

-- time_tickets: tenant users create, edit, and delete their own tickets
create policy time_tickets_insert on time_tickets for insert
  with check (owns_tenant(tenant_id) or is_platform_admin());
create policy time_tickets_update on time_tickets for update
  using (owns_tenant(tenant_id) or is_platform_admin());
create policy time_tickets_delete on time_tickets for delete
  using (owns_tenant(tenant_id) or is_platform_admin());

-- matters: tenant users create and manage their matters
create policy matters_insert on matters for insert
  with check (owns_tenant(tenant_id) or is_platform_admin());
create policy matters_update on matters for update
  using (owns_tenant(tenant_id) or is_platform_admin());
create policy matters_delete on matters for delete
  using (owns_tenant(tenant_id) or is_platform_admin());

-- outbound_leads: tenant users add and remove leads
create policy outbound_leads_insert on outbound_leads for insert
  with check (owns_tenant(tenant_id) or is_platform_admin());
create policy outbound_leads_delete on outbound_leads for delete
  using (owns_tenant(tenant_id) or is_platform_admin());

-- tenant_integrations: tenant can connect/disconnect their integrations
create policy tenant_integrations_insert on tenant_integrations for insert
  with check (owns_tenant(tenant_id) or is_platform_admin());
create policy tenant_integrations_delete on tenant_integrations for delete
  using (owns_tenant(tenant_id) or is_platform_admin());



-- ============================================================
-- Migration: 011_outbound_assist.sql
-- ============================================================

-- Migration 011: Outbound Call Assist + Proactive Reminders
-- Adds tenant_contacts, call_reminders, and outbound settings on tenants.
-- Extends tenant_integrations provider list to include MS Calendar, HubSpot,
-- Salesforce, and SIP providers (RingCentral, Vonage, Telnyx).
--
-- Apply AFTER 010_rls_complete.sql.

-- ── Outbound settings on tenants ─────────────────────────────────────────────

alter table tenants
  add column if not exists outbound_enabled       boolean not null default false,
  -- Phone number we call for proactive reminders (professional's desk or cell).
  add column if not exists outbound_reminder_phone text,
  -- The number the professional calls FROM to reach outbound assist.
  -- We use this to identify which tenant is placing the outbound assist call.
  add column if not exists outbound_caller_id      text;

-- ── Tenant contacts ───────────────────────────────────────────────────────────
-- Unified contact list per tenant, populated from manual entry and integration
-- syncs (Google Calendar attendees, MS Calendar attendees, HubSpot, Clio, etc.)

create table tenant_contacts (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  name        text not null,
  phone       text,
  email       text,
  company     text,
  source      text not null default 'manual', -- manual | google_cal | ms_cal | hubspot | salesforce | clio | mycase
  external_id text,                           -- provider's own ID for dedup
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (tenant_id, source, external_id) deferrable initially deferred
);

create index tenant_contacts_tenant_idx  on tenant_contacts (tenant_id);
create index tenant_contacts_name_idx    on tenant_contacts using gin (to_tsvector('english', name));

create trigger trg_tenant_contacts_updated before update on tenant_contacts
  for each row execute function set_updated_at();

-- ── Call reminders ────────────────────────────────────────────────────────────
-- One row per proactive reminder call we have sent (or are about to send).
-- Deduped by (tenant_id, event_id, event_source) so we never double-call.

create type reminder_status as enum ('pending', 'calling', 'dismissed', 'bridged', 'failed');

create table call_reminders (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  event_id        text not null,          -- calendar event ID from the provider
  event_source    text not null,          -- 'google' | 'microsoft'
  attendee_name   text,
  attendee_phone  text,
  event_title     text,
  starts_at       timestamptz not null,
  status          reminder_status not null default 'pending',
  call_sid        text,                   -- Twilio CallSid of the reminder call
  created_at      timestamptz not null default now(),
  unique (tenant_id, event_id, event_source)
);

create index call_reminders_tenant_idx  on call_reminders (tenant_id, starts_at);
create index call_reminders_status_idx  on call_reminders (status) where status = 'pending';

-- ── RLS ───────────────────────────────────────────────────────────────────────

alter table tenant_contacts  enable row level security;
alter table call_reminders   enable row level security;

create policy tenant_contacts_select on tenant_contacts for select
  using (owns_tenant(tenant_id) or is_platform_admin());
create policy tenant_contacts_insert on tenant_contacts for insert
  with check (owns_tenant(tenant_id) or is_platform_admin());
create policy tenant_contacts_update on tenant_contacts for update
  using (owns_tenant(tenant_id) or is_platform_admin());
create policy tenant_contacts_delete on tenant_contacts for delete
  using (owns_tenant(tenant_id) or is_platform_admin());

create policy call_reminders_select on call_reminders for select
  using (owns_tenant(tenant_id) or is_platform_admin());



-- ============================================================
-- Migration: 012_public_api.sql
-- ============================================================

-- Migration 012: Public REST API — per-tenant API keys + outbound webhooks.
-- Keys are stored as SHA-256 hashes only; the plaintext key is shown once at
-- creation. Apply AFTER 011_outbound_assist.sql.

create table api_keys (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  key_hash     text not null unique,        -- sha256 hex of the full key
  key_prefix   text not null,               -- first 12 chars, for display ("sk_live_ab12…")
  label        text,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);

create index api_keys_tenant_idx on api_keys (tenant_id);

create table api_webhooks (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  url         text not null,
  events      text[] not null default '{lead.created,call.completed}',
  created_at  timestamptz not null default now(),
  last_status integer,                      -- HTTP status of most recent delivery
  last_fired_at timestamptz
);

create index api_webhooks_tenant_idx on api_webhooks (tenant_id);

alter table api_keys     enable row level security;
alter table api_webhooks enable row level security;

create policy api_keys_select on api_keys for select
  using (owns_tenant(tenant_id) or is_platform_admin());
create policy api_keys_delete on api_keys for delete
  using (owns_tenant(tenant_id) or is_platform_admin());

create policy api_webhooks_select on api_webhooks for select
  using (owns_tenant(tenant_id) or is_platform_admin());
create policy api_webhooks_insert on api_webhooks for insert
  with check (owns_tenant(tenant_id) or is_platform_admin());
create policy api_webhooks_delete on api_webhooks for delete
  using (owns_tenant(tenant_id) or is_platform_admin());



-- ============================================================
-- Migration: 013_recording_flag.sql
-- ============================================================

-- Migration 013: per-tenant call recording flag.
-- Replaces the RECORDING_TENANT_IDS env var (which required a redeploy to
-- change). The AI discloses recording at call start when enabled.

alter table tenants add column recording_enabled boolean not null default false;



-- ============================================================
-- Migration: 014_platform_leads.sql
-- ============================================================

-- Platform-level leads (prospects for SoCal Receptionist itself, not tenant
-- customers). First source: website support-chat callback requests, which were
-- previously email-only and never persisted.

create table if not exists platform_leads (
  id          uuid primary key default gen_random_uuid(),
  source      text not null default 'support_chat',  -- 'support_chat' | future: 'demo_form', ...
  name        text,
  phone       text,
  email       text,
  notes       text,
  status      text not null default 'new',           -- 'new' | 'contacted' | 'converted' | 'dead'
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists platform_leads_created_idx on platform_leads (created_at desc);

-- Service-role only: no client-facing access. RLS on with no policies means
-- anon/authenticated are denied; the backend uses the service key.
alter table platform_leads enable row level security;


