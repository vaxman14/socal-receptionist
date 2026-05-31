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
