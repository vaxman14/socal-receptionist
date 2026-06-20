-- Migration 021: Live chat — conversational web-chat widget + human takeover.
--
-- The embeddable widget (GET /widget/chat.js) lets a site visitor talk to the
-- tenant's AI. At any point they (or the AI) can request a human; the tenant
-- owner sees the conversation in the dashboard "Live Chat" page and takes over
-- in real time. If no human claims a waiting conversation within the grace
-- window, a sweep hands it back to the AI, which apologises and captures the
-- lead — the visitor is never left on a dead chat.
--
-- Transcripts are kept FOREVER (no retention sweep touches these tables).
--
-- Apply AFTER 020_booking_config.sql.

-- Conversation lifecycle:
--   ai      — AI is answering (default)
--   waiting — a human was requested; grace timer running, unclaimed
--   live    — a human (tenant owner/agent) has taken over
--   closed  — ended
do $$ begin
  create type chat_conv_status as enum ('ai', 'waiting', 'live', 'closed');
exception when duplicate_object then null; end $$;

-- Who authored a message.
do $$ begin
  create type chat_msg_role as enum ('visitor', 'ai', 'agent', 'system');
exception when duplicate_object then null; end $$;

create table if not exists chat_conversations (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid references tenants(id) on delete cascade,
  visitor_id         text not null,                       -- client-generated, stored in the visitor's localStorage
  status             chat_conv_status not null default 'ai',
  channel            text not null default 'web',
  -- Snapshot of the embedding context so the AI + dashboard have business info
  -- even when no tenant_id is resolved (standalone embeds).
  business_name      text,
  about              text,
  source_url         text,
  visitor_name       text,                                -- captured during the chat, if offered
  visitor_contact    text,                                -- phone or email, if offered
  waiting_since      timestamptz,                         -- set when status -> waiting; basis for the fallback sweep
  claimed_by         uuid references auth.users(id) on delete set null,
  claimed_at         timestamptz,
  last_message_at    timestamptz not null default now(),
  agent_seen_at      timestamptz,                         -- last time an agent viewed it (unread math)
  created_at         timestamptz not null default now()
);

create index if not exists chat_conversations_tenant_idx
  on chat_conversations (tenant_id, last_message_at desc);
create index if not exists chat_conversations_status_idx
  on chat_conversations (status, waiting_since);
create index if not exists chat_conversations_visitor_idx
  on chat_conversations (visitor_id);

create table if not exists chat_messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references chat_conversations(id) on delete cascade,
  tenant_id       uuid references tenants(id) on delete cascade,
  role            chat_msg_role not null,
  body            text not null,
  created_at      timestamptz not null default now()
);

create index if not exists chat_messages_conversation_idx
  on chat_messages (conversation_id, created_at);
create index if not exists chat_messages_tenant_idx
  on chat_messages (tenant_id, created_at desc);

-- RLS. The backend uses the service-role key (bypasses RLS) and scopes every
-- query to req.tenant.id, so these policies are defence-in-depth + future
-- direct-from-browser reads. owns_tenant()/is_platform_admin() are defined in
-- earlier migrations (010_rls_complete.sql).
alter table chat_conversations enable row level security;
alter table chat_messages      enable row level security;

do $$ begin
  create policy chat_conversations_select on chat_conversations for select
    using (owns_tenant(tenant_id) or is_platform_admin());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy chat_messages_select on chat_messages for select
    using (owns_tenant(tenant_id) or is_platform_admin());
exception when duplicate_object then null; end $$;
