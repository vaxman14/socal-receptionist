// Outbound leads CRUD + call initiation helpers.
// All queries are tenant-scoped; the service-role supabase client bypasses RLS.

const { supabase } = require('./supabase');

const VALID_STATUSES = ['pending', 'calling', 'answered', 'voicemail', 'no_answer', 'lead_captured', 'not_interested', 'dnc'];

async function listLeads(tenantId, { status, limit = 200 } = {}) {
  let q = supabase
    .from('outbound_leads')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (status) q = q.eq('status', status);
  const { data, error } = await q;
  if (error) throw error;
  return data;
}

async function createLead(tenantId, { name, phone, businessType, reason }) {
  if (!phone) throw new Error('phone is required');
  const { data, error } = await supabase
    .from('outbound_leads')
    .insert({ tenant_id: tenantId, name, phone, business_type: businessType, reason })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function bulkCreateLeads(tenantId, rows) {
  const insert = rows.map(r => ({
    tenant_id: tenantId,
    name: r.name || null,
    phone: r.phone,
    business_type: r.businessType || r.business_type || null,
    reason: r.reason || null,
  }));
  const { data, error } = await supabase
    .from('outbound_leads')
    .insert(insert)
    .select();
  if (error) throw error;
  return data;
}

async function updateLead(tenantId, leadId, patch) {
  const allowed = ['name', 'phone', 'business_type', 'reason', 'status', 'notes', 'call_sid', 'call_attempts', 'last_called_at'];
  const clean = {};
  for (const k of allowed) {
    if (patch[k] !== undefined) clean[k] = patch[k];
  }
  if (!Object.keys(clean).length) throw new Error('no valid fields to update');
  if (clean.status && !VALID_STATUSES.includes(clean.status)) throw new Error(`invalid status: ${clean.status}`);

  const { data, error } = await supabase
    .from('outbound_leads')
    .update(clean)
    .eq('id', leadId)
    .eq('tenant_id', tenantId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function deleteLead(tenantId, leadId) {
  const { error } = await supabase
    .from('outbound_leads')
    .delete()
    .eq('id', leadId)
    .eq('tenant_id', tenantId);
  if (error) throw error;
}

// Mark a call as started. Called right before the Twilio REST call is initiated.
async function markCalling(tenantId, leadId, callSid) {
  return updateLead(tenantId, leadId, {
    status: 'calling',
    call_sid: callSid,
    last_called_at: new Date().toISOString(),
    call_attempts: undefined, // incremented below via raw SQL
  });
}

// Called by the outbound voice webhook status callback when the call ends.
// Maps Twilio CallStatus values to our lead status.
async function handleCallStatus(callSid, twilioStatus) {
  const { data: lead, error: findErr } = await supabase
    .from('outbound_leads')
    .select('id, tenant_id, call_attempts')
    .eq('call_sid', callSid)
    .maybeSingle();
  if (findErr || !lead) return null;

  const statusMap = {
    completed: 'answered',
    'no-answer': 'no_answer',
    busy: 'no_answer',
    failed: 'no_answer',
    canceled: 'pending', // put back in queue
  };
  const newStatus = statusMap[twilioStatus] || 'answered';

  const { data } = await supabase
    .from('outbound_leads')
    .update({ status: newStatus, call_attempts: (lead.call_attempts || 0) + 1 })
    .eq('id', lead.id)
    .select()
    .single();
  return data;
}

// After the AI captures a lead, mark as lead_captured and store notes.
async function markLeadCaptured(callSid, notes) {
  const { data: lead, error } = await supabase
    .from('outbound_leads')
    .select('id, tenant_id')
    .eq('call_sid', callSid)
    .maybeSingle();
  if (error || !lead) return null;

  const { data } = await supabase
    .from('outbound_leads')
    .update({ status: 'lead_captured', notes })
    .eq('id', lead.id)
    .select()
    .single();
  return data;
}

module.exports = { listLeads, createLead, bulkCreateLeads, updateLead, deleteLead, markCalling, handleCallStatus, markLeadCaptured };
