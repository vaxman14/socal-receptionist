-- 008_voice_selection.sql — per-tenant receptionist voice
-- Run in Supabase SQL Editor.

alter table tenants
  add column if not exists voice_id text not null default 'Polly.Joanna-Neural';
