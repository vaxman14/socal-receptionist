-- Migration 022: Expo push tokens for the mobile app.
-- Lets the dashboard app receive a push the moment a website visitor asks for a
-- human (live chat handoff). One row per device token; a token maps to the user.
--
-- Apply AFTER 021_live_chat.sql.

create table if not exists push_tokens (
  token       text primary key,                              -- Expo push token (ExponentPushToken[...])
  user_id     uuid not null references auth.users(id) on delete cascade,
  platform    text,                                          -- ios | android
  updated_at  timestamptz not null default now()
);

create index if not exists push_tokens_user_idx on push_tokens (user_id);

alter table push_tokens enable row level security;

do $$ begin
  create policy push_tokens_select on push_tokens for select using (user_id = auth.uid());
exception when duplicate_object then null; end $$;
do $$ begin
  create policy push_tokens_insert on push_tokens for insert with check (user_id = auth.uid());
exception when duplicate_object then null; end $$;
do $$ begin
  create policy push_tokens_delete on push_tokens for delete using (user_id = auth.uid());
exception when duplicate_object then null; end $$;
