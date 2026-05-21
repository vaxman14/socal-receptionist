// SMS consent tracking, scoped per tenant.
//
// States: 'unknown' | 'pending' | 'opted_in' | 'opted_out' (consent_status
// enum, db/001_init.sql). Twilio also enforces STOP at the carrier level; we
// track here so opted-out numbers are never fed to the AI.

const { supabase } = require('./supabase');

async function getStatus(tenantId, phone) {
  const { data, error } = await supabase
    .from('consent')
    .select('status')
    .eq('tenant_id', tenantId)
    .eq('phone', phone)
    .maybeSingle();
  if (error) throw error;
  return (data && data.status) || 'unknown';
}

async function setStatus(tenantId, phone, status) {
  const { error } = await supabase
    .from('consent')
    .upsert(
      { tenant_id: tenantId, phone, status, updated_at: new Date().toISOString() },
      { onConflict: 'tenant_id,phone' }
    );
  if (error) throw error;
}

module.exports = { getStatus, setStatus };
