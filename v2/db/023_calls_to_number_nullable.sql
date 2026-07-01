-- 023_calls_to_number_nullable.sql
-- Fix: the `calls` table was NEVER populated for ANY tenant because
-- recordCallStart() (v2/server/voice/realtime.js) inserts the row with
-- to_number = null, but calls.to_number was NOT NULL. Every insert failed the
-- not-null constraint and was silently swallowed by the .catch(() => {}) around
-- the call. Result: no call history / recordings / transcripts logged in-DB.
--
-- The tenant is already identified by tenant_id, so to_number is optional.
-- Making it nullable unblocks call logging with no code change / no deploy.
-- Applied live to V3 (xcngpfeuvvcsxgwyukch) 2026-07-01.

alter table public.calls alter column to_number drop not null;
