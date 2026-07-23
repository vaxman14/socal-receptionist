create table if not exists public.voice_blocked_callers (
  number text primary key,
  reason text not null,
  source text not null default 'manual',
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  hit_count integer not null default 1 check (hit_count > 0)
);

alter table public.voice_blocked_callers enable row level security;

comment on table public.voice_blocked_callers is
  'Server-only caller blocklist populated by confirmed voice-spam fingerprints.';

alter type public.call_outcome add value if not exists 'spam_blocked';
