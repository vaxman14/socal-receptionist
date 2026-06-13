-- 016_ai_extra_info.sql
-- Owner-supplied "additional marketing / sales information" for the AI.
--
-- A list of free-text lines (pricing, promos, sales talking points, policies)
-- that the business owner manages from the dashboard Settings page. Each line is
-- injected into the AI receptionist's system prompt as authoritative context the
-- AI MAY share with callers — including pricing, which the default prompt
-- otherwise withholds.

alter table tenants
  add column if not exists ai_extra_info text[] not null default '{}'::text[];

comment on column tenants.ai_extra_info is
  'Owner-managed extra info lines fed to the AI receptionist (pricing, sales, promos). Authoritative; the AI may share these with callers.';
