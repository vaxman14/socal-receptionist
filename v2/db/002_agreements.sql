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
