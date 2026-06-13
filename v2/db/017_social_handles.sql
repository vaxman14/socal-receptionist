-- 017_social_handles.sql
-- Client social media handles, managed from the new Marketing page.
--
-- Stored as a JSON object keyed by platform (facebook, instagram, linkedin,
-- twitter/x, tiktok, youtube, google_business) -> handle or profile URL. This
-- backs the Marketing page today and the upcoming "post directly to your
-- socials from the platform" flow.

alter table tenants
  add column if not exists social_handles jsonb not null default '{}'::jsonb;

comment on column tenants.social_handles is
  'Client social media handles/URLs keyed by platform. Set on the Marketing page; basis for direct social posting.';
