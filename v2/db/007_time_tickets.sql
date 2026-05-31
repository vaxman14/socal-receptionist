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
