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
