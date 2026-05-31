-- 010_rls_complete.sql
-- Add missing write policies for tables that frontend clients need to modify.

-- trusted_devices: per-user (not per-tenant); users manage their own devices
create policy trusted_devices_select on trusted_devices for select
  using (user_id = auth.uid());
create policy trusted_devices_insert on trusted_devices for insert
  with check (user_id = auth.uid());
create policy trusted_devices_delete on trusted_devices for delete
  using (user_id = auth.uid());

-- time_tickets: tenant users create, edit, and delete their own tickets
create policy time_tickets_insert on time_tickets for insert
  with check (owns_tenant(tenant_id) or is_platform_admin());
create policy time_tickets_update on time_tickets for update
  using (owns_tenant(tenant_id) or is_platform_admin());
create policy time_tickets_delete on time_tickets for delete
  using (owns_tenant(tenant_id) or is_platform_admin());

-- matters: tenant users create and manage their matters
create policy matters_insert on matters for insert
  with check (owns_tenant(tenant_id) or is_platform_admin());
create policy matters_update on matters for update
  using (owns_tenant(tenant_id) or is_platform_admin());
create policy matters_delete on matters for delete
  using (owns_tenant(tenant_id) or is_platform_admin());

-- outbound_leads: tenant users add and remove leads
create policy outbound_leads_insert on outbound_leads for insert
  with check (owns_tenant(tenant_id) or is_platform_admin());
create policy outbound_leads_delete on outbound_leads for delete
  using (owns_tenant(tenant_id) or is_platform_admin());

-- tenant_integrations: tenant can connect/disconnect their integrations
create policy tenant_integrations_insert on tenant_integrations for insert
  with check (owns_tenant(tenant_id) or is_platform_admin());
create policy tenant_integrations_delete on tenant_integrations for delete
  using (owns_tenant(tenant_id) or is_platform_admin());
