-- Migration 019: Per-tenant Asterisk connector endpoint
-- Each client running the on-prem concierge has their own connector (a DO
-- droplet, tunneled to their PBX). The reminder engine reaches it cloud-to-cloud
-- to ring an attorney's extension. These two fields are ops-provisioned per
-- client when their connector droplet is stood up; null = no connector.
--
-- Apply AFTER 018_reminder_recipients.sql.

alter table tenants
  add column if not exists asterisk_connector_url text,
  add column if not exists asterisk_connector_key text;
