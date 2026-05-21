// Call records.
//
// One `calls` row per inbound phone call. The voice webhook creates the row on
// the first /voice hit and patches it as the call moves through the IVR
// (AI-handled, transferred to staff, voicemail, missed, abandoned).

const { supabase } = require('./supabase');

// Create the call row when a call first arrives. Idempotent on twilio_call_sid
// so a Twilio retry of the entry webhook does not duplicate the record.
async function recordCallStart({ tenantId, callSid, from, to }) {
  const { data, error } = await supabase
    .from('calls')
    .upsert(
      { tenant_id: tenantId, twilio_call_sid: callSid, from_number: from, to_number: to },
      { onConflict: 'twilio_call_sid' }
    )
    .select()
    .single();
  if (error) throw error;
  return data;
}

// Patch a call row by its Twilio CallSid. Never throws — call logging must not
// break the live call; failures are logged and swallowed.
async function updateCall(callSid, patch) {
  if (!callSid) return;
  const { error } = await supabase
    .from('calls')
    .update(patch)
    .eq('twilio_call_sid', callSid);
  if (error) console.error('[calls] update failed:', error.message);
}

async function getCallBySid(callSid) {
  const { data, error } = await supabase
    .from('calls')
    .select('*')
    .eq('twilio_call_sid', callSid)
    .maybeSingle();
  if (error) throw error;
  return data;
}

module.exports = { recordCallStart, updateCall, getCallBySid };
