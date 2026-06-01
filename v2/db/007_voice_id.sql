-- =============================================================================
-- SoCal Receptionist V2 — Migration 007: per-tenant voice selection
--
-- Adds a `voice_id` column to tenants so each client can pick their AI
-- receptionist's voice from the Twilio Polly Neural roster.
--
-- Apply AFTER 006_mfa.sql.
-- =============================================================================

alter table tenants
  add column if not exists voice_id text default 'Polly.Joanna-Neural';

comment on column tenants.voice_id is
  'Twilio TTS voice used for this tenant''s IVR. Must be a valid Polly Neural '
  'voice name (e.g. Polly.Joanna-Neural). Null falls back to platform default.';
