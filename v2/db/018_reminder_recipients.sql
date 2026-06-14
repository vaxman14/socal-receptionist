-- Migration 018: Per-user reminder recipients
-- A firm can have many people (attorneys, agents) who each want their own
-- proactive reminders for the events they own. Each recipient maps a calendar
-- identity (organizer email) to up to three reminder channels — phone call,
-- PBX extension, and email — each independently toggled on/off.
--
-- Apply AFTER 017_social_handles.sql.

-- A reminder can now be delivered with no phone call (email-only). Add a
-- terminal status for that case. (ADD VALUE is idempotent via IF NOT EXISTS.)
alter type reminder_status add value if not exists 'notified';

create table if not exists reminder_recipients (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  name           text not null,
  -- Calendar identity used to match events to this person (event organizer email).
  match_email    text,
  source         text not null default 'manual', -- manual | clio | google | microsoft
  external_id    text,
  -- Channel 1: phone call to a cell or landline.
  call_enabled   boolean not null default false,
  call_phone     text,
  -- Channel 2: PBX/Asterisk extension (requires a connected phone system).
  ext_enabled    boolean not null default false,
  ext_value      text,
  -- Channel 3: email reminder.
  email_enabled  boolean not null default false,
  email_address  text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  -- One row per calendar identity. NULLs are distinct, so manual rows without an
  -- email don't collide.
  unique (tenant_id, match_email)
);

create index if not exists reminder_recipients_tenant_idx on reminder_recipients (tenant_id);

create trigger trg_reminder_recipients_updated before update on reminder_recipients
  for each row execute function set_updated_at();

alter table reminder_recipients enable row level security;

create policy reminder_recipients_select on reminder_recipients for select
  using (owns_tenant(tenant_id) or is_platform_admin());
create policy reminder_recipients_insert on reminder_recipients for insert
  with check (owns_tenant(tenant_id) or is_platform_admin());
create policy reminder_recipients_update on reminder_recipients for update
  using (owns_tenant(tenant_id) or is_platform_admin());
create policy reminder_recipients_delete on reminder_recipients for delete
  using (owns_tenant(tenant_id) or is_platform_admin());
