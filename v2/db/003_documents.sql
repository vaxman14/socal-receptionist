-- =============================================================================
-- SoCal Receptionist V2 — Migration 003: editable documents
--
-- Moves two things out of hardcoded code and into the database so the platform
-- owner can manage them from the admin UI without a deploy:
--
--   * legal_documents   — privacy / terms / cookies / accessibility / faq /
--                         support page content (editable in place).
--   * contract_versions — the e-sign Service Agreement. Uploading a new version
--                         creates a row; publishing it makes it the one new
--                         clients sign. Old versions are kept (signed records
--                         in service_agreements reference them by version+hash).
--
-- Apply AFTER 002_agreements.sql. Seed content: scripts/seed-documents.js
-- (the contract also auto-seeds from server/contracts/ on first read).
-- =============================================================================

-- --- Editable policy / info pages -------------------------------------------

create table legal_documents (
  id          uuid primary key default gen_random_uuid(),
  slug        text unique not null,        -- privacy|terms|cookies|accessibility|faq|support
  title       text not null,
  body        text not null,               -- markdown
  updated_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create trigger trg_legal_documents_updated before update on legal_documents
  for each row execute function set_updated_at();

-- --- Versioned e-sign contracts ---------------------------------------------

create table contract_versions (
  id            uuid primary key default gen_random_uuid(),
  version       text unique not null,      -- 'v1', 'v2', ... — what service_agreements references
  title         text not null,
  body          text not null,             -- markdown — the exact text clients sign
  content_hash  text not null,             -- sha256(body) — frozen into each signature
  is_current    boolean not null default false,
  created_by    uuid references auth.users(id) on delete set null,
  published_at  timestamptz,
  created_at    timestamptz not null default now()
);

-- At most one current contract. Publishing a version unsets the others first.
create unique index contract_versions_single_current
  on contract_versions (is_current) where is_current = true;

-- --- Row Level Security ------------------------------------------------------

alter table legal_documents   enable row level security;
alter table contract_versions enable row level security;

-- legal_documents: public-facing page content — anyone may read; writes are
-- service-role only (the owner admin API).
create policy legal_documents_select on legal_documents for select
  using (true);

-- contract_versions: not public. Platform-admin read; writes service-role only.
create policy contract_versions_select on contract_versions for select
  using (is_platform_admin());
