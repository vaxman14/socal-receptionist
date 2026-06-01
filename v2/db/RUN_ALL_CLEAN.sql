-- =============================================================================
-- SoCal Receptionist V2 — FULL SCHEMA BUNDLE (idempotent / re-runnable)
-- Drops everything first, then recreates clean. Safe on a fresh project.
-- =============================================================================

-- --- Teardown (safe because no real data exists yet) -------------------------

drop table if exists trusted_devices         cascade;
drop table if exists calls                   cascade;
drop table if exists contract_versions       cascade;
drop table if exists legal_documents         cascade;
drop table if exists service_agreements      cascade;
drop table if exists provisioning_jobs       cascade;
drop table if exists processed_events        cascade;
drop table if exists audit_log               cascade;
drop table if exists platform_admins         cascade;
drop table if exists message_status          cascade;
drop table if exists consent                 cascade;
drop table if exists leads                   cascade;
drop table if exists messages                cascade;
drop table if exists conversations           cascade;
drop table if exists phone_numbers           cascade;
drop table if exists subscriptions           cascade;
drop table if exists tenants                 cascade;

drop type if exists call_outcome             cascade;
drop type if exists provisioning_job_status  cascade;
drop type if exists delivery_status          cascade;
drop type if exists lead_status              cascade;
drop type if exists consent_status           cascade;
drop type if exists message_role             cascade;
drop type if exists message_direction        cascade;
drop type if exists conversation_status      cascade;
drop type if exists phone_number_status      cascade;
drop type if exists phone_number_type        cascade;
drop type if exists subscription_status      cascade;
drop type if exists tenant_status            cascade;

drop function if exists set_updated_at()       cascade;
drop function if exists record_tenant_usage(uuid,integer,integer,integer) cascade;
drop function if exists is_platform_admin()    cascade;
drop function if exists owns_tenant(uuid)      cascade;

-- =============================================================================
-- >>>>> 001_init.sql >>>>>
-- =============================================================================

create extension if not exists pgcrypto;

create type tenant_status as enum (
  'onboarding',
  'sms_pending_compliance',
  'active',
  'suspended_billing',
  'suspended_compliance',
  'failed_provisioning'
);

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

create type delivery_status as enum (
  'queued', 'sending', 'sent', 'delivered', 'undelivered', 'failed', 'received'
);

create type provisioning_job_status as enum (
  'pending', 'running', 'succeeded', 'failed', 'needs_review'
);

create or replace function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table tenants (
  id                uuid primary key default gen_random_uuid(),
  slug              text unique not null,
  owner_user_id     uuid references auth.users(id) on delete set null,
  status            tenant_status not null default 'onboarding',
  business_name     text not null,
  business_hours    text,
  business_services text,
  calendly_link     text,
  owner_email       text not null,
  timezone          text not null default 'America/Los_Angeles',
  ai_model          text not null default 'gpt-4o',
  ai_system_prompt  text,
  sms_spend_cap_cents        integer,
  openai_spend_cap_cents     integer,
  monthly_sms_count          integer not null default 0,
  monthly_sms_spend_cents    integer not null default 0,
  monthly_openai_spend_cents integer not null default 0,
  usage_period_start         date    not null default current_date,
  voice_enabled   boolean not null default true,
  staff_phone     text,
  voice_greeting  text,
  voicemail_email text,
  activated_at      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

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
  setup_payment_intent   text,
  setup_paid_at          timestamptz,
  setup_refunded_at      timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
create unique index subscriptions_one_per_tenant on subscriptions (tenant_id);

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
  is_byo                boolean not null default false,
  purchased_at          timestamptz,
  released_at           timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index phone_numbers_tenant_idx on phone_numbers (tenant_id);

create table conversations (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  customer_phone  text not null,
  status          conversation_status not null default 'open',
  last_message_at timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create unique index conversations_one_open
  on conversations (tenant_id, customer_phone) where status = 'open';
create index conversations_recent_idx
  on conversations (tenant_id, last_message_at desc);

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

create table consent (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  phone       text not null,
  status      consent_status not null default 'unknown',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (tenant_id, phone)
);

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

create table provisioning_jobs (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  job_type      text not null,
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

create table processed_events (
  id           text primary key,
  source       text not null,
  processed_at timestamptz not null default now()
);

create table audit_log (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid references tenants(id) on delete set null,
  actor_type    text not null,
  actor_user_id uuid references auth.users(id) on delete set null,
  action        text not null,
  target_type   text,
  target_id     text,
  metadata      jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);
create index audit_log_tenant_idx on audit_log (tenant_id, created_at desc);

create table platform_admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

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
alter table processed_events  enable row level security;

create policy tenants_select on tenants for select
  using (owner_user_id = auth.uid() or is_platform_admin());
create policy tenants_update on tenants for update
  using (owner_user_id = auth.uid() or is_platform_admin());

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

create policy leads_select on leads for select
  using (owns_tenant(tenant_id) or is_platform_admin());
create policy leads_update on leads for update
  using (owns_tenant(tenant_id) or is_platform_admin());

create policy provisioning_jobs_select on provisioning_jobs for select
  using (is_platform_admin());

create policy audit_log_select on audit_log for select
  using ((tenant_id is not null and owns_tenant(tenant_id)) or is_platform_admin());

create policy platform_admins_select on platform_admins for select
  using (is_platform_admin());

-- =============================================================================
-- >>>>> 002_agreements.sql >>>>>
-- =============================================================================

create table service_agreements (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id) on delete cascade,
  contract_version  text not null,
  contract_hash     text not null,
  signer_name       text not null,
  signer_email      text not null,
  signer_title      text,
  signer_ip         text,
  signer_user_agent text,
  consent_text      text not null,
  signer_user_id    uuid references auth.users(id) on delete set null,
  signed_at         timestamptz not null default now(),
  revoked_at        timestamptz,
  created_at        timestamptz not null default now()
);

create index service_agreements_tenant_idx
  on service_agreements (tenant_id, signed_at desc);

create unique index service_agreements_one_active
  on service_agreements (tenant_id, contract_version)
  where revoked_at is null;

alter table service_agreements enable row level security;

create policy service_agreements_select on service_agreements for select
  using (owns_tenant(tenant_id) or is_platform_admin());

-- =============================================================================
-- >>>>> 003_documents.sql >>>>>
-- =============================================================================

create table legal_documents (
  id          uuid primary key default gen_random_uuid(),
  slug        text unique not null,
  title       text not null,
  body        text not null,
  updated_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create trigger trg_legal_documents_updated before update on legal_documents
  for each row execute function set_updated_at();

create table contract_versions (
  id            uuid primary key default gen_random_uuid(),
  version       text unique not null,
  title         text not null,
  body          text not null,
  content_hash  text not null,
  is_current    boolean not null default false,
  created_by    uuid references auth.users(id) on delete set null,
  published_at  timestamptz,
  created_at    timestamptz not null default now()
);

create unique index contract_versions_single_current
  on contract_versions (is_current) where is_current = true;

alter table legal_documents   enable row level security;
alter table contract_versions enable row level security;

create policy legal_documents_select on legal_documents for select
  using (true);

create policy contract_versions_select on contract_versions for select
  using (is_platform_admin());

-- =============================================================================
-- >>>>> 004_voice.sql >>>>>
-- =============================================================================

create type call_outcome as enum (
  'in_progress',
  'ai_handled',
  'transferred',
  'voicemail',
  'missed',
  'abandoned'
);

create table calls (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  conversation_id uuid references conversations(id) on delete set null,
  twilio_call_sid text unique,
  from_number     text not null,
  to_number       text not null,
  outcome         call_outcome not null default 'in_progress',
  duration_seconds integer,
  recording_url   text,
  recording_sid   text,
  transcript      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index calls_tenant_idx on calls (tenant_id, created_at desc);

create trigger trg_calls_updated before update on calls
  for each row execute function set_updated_at();

alter table calls enable row level security;

create policy calls_select on calls for select
  using (owns_tenant(tenant_id) or is_platform_admin());

-- =============================================================================
-- >>>>> 006_mfa.sql >>>>>
-- =============================================================================

create table trusted_devices (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  token_hash    text not null unique,
  label         text,
  user_agent    text,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  expires_at    timestamptz not null
);

create index trusted_devices_user_idx on trusted_devices (user_id, created_at desc);

alter table trusted_devices enable row level security;

-- =============================================================================
-- PLATFORM_ADMIN — run AFTER Roman signs up through the web app once.
-- Find the user id in Supabase Auth > Users, then:
--   insert into platform_admins (user_id) values ('<roman-auth-user-uuid>');
-- =============================================================================
