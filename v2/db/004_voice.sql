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
