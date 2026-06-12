-- Platform-level leads (prospects for SoCal Receptionist itself, not tenant
-- customers). First source: website support-chat callback requests, which were
-- previously email-only and never persisted.

create table if not exists platform_leads (
  id          uuid primary key default gen_random_uuid(),
  source      text not null default 'support_chat',  -- 'support_chat' | future: 'demo_form', ...
  name        text,
  phone       text,
  email       text,
  notes       text,
  status      text not null default 'new',           -- 'new' | 'contacted' | 'converted' | 'dead'
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists platform_leads_created_idx on platform_leads (created_at desc);

-- Service-role only: no client-facing access. RLS on with no policies means
-- anon/authenticated are denied; the backend uses the service key.
alter table platform_leads enable row level security;
