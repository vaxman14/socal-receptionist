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
