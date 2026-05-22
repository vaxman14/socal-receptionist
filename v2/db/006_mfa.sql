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
