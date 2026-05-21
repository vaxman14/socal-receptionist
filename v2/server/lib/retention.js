// Transcript retention + data export/delete (Codex hardening).
//
// Supports CCPA/GDPR-style obligations: a tenant can export everything held
// about them, transcripts can be purged on a retention schedule, and a tenant
// can be fully erased (child rows cascade from the tenants FK).

const { supabase } = require('./supabase');

const TENANT_TABLES = [
  'subscriptions',
  'phone_numbers',
  'conversations',
  'messages',
  'leads',
  'consent',
  'audit_log',
];

// Export everything held for a tenant as a JSON-serializable object.
async function exportTenant(tenantId) {
  const out = {};

  const { data: tenant, error } = await supabase
    .from('tenants')
    .select('*')
    .eq('id', tenantId)
    .maybeSingle();
  if (error) throw error;
  out.tenant = tenant;

  for (const table of TENANT_TABLES) {
    const { data, error: tErr } = await supabase
      .from(table)
      .select('*')
      .eq('tenant_id', tenantId);
    if (tErr) throw tErr;
    out[table] = data;
  }

  return { exported_at: new Date().toISOString(), tenant_id: tenantId, data: out };
}

// Purge transcript messages older than `retainDays` for one tenant. Returns
// the number of messages removed.
async function purgeOldMessages(tenantId, retainDays) {
  const cutoff = new Date(Date.now() - retainDays * 86400000).toISOString();
  const { data, error } = await supabase
    .from('messages')
    .delete()
    .eq('tenant_id', tenantId)
    .lt('created_at', cutoff)
    .select('id');
  if (error) throw error;
  return data ? data.length : 0;
}

// Hard-delete a tenant and every child row (FKs cascade from tenants.id).
async function deleteTenant(tenantId) {
  const { error } = await supabase.from('tenants').delete().eq('id', tenantId);
  if (error) throw error;
}

module.exports = { exportTenant, purgeOldMessages, deleteTenant };
