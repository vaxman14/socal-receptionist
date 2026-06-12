-- Migration 013: per-tenant call recording flag.
-- Replaces the RECORDING_TENANT_IDS env var (which required a redeploy to
-- change). The AI discloses recording at call start when enabled.

alter table tenants add column recording_enabled boolean not null default false;
