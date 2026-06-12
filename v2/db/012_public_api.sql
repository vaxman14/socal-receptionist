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
