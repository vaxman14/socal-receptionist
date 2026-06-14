// App-side outbound transactional SMS via Twilio.
//
// A thin wrapper for SMS the *backend* initiates (e.g. review requests). Inbound
// SMS replies are handled with TwiML in server/sms/webhook.js — this is the
// outbound, message-create path.
//
// Graceful degradation: if Twilio creds are missing, sendSms() logs and no-ops
// rather than throwing, so callers can treat SMS as best-effort.

const twilio = require('twilio');
const { supabase } = require('./supabase');
const logger = require('./logger');

let _client;
function client() {
  if (_client) return _client;
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) return null;
  _client = twilio(sid, token);
  return _client;
}

// Pick the best "from" for a tenant: their own active receptionist number if
// they have one (so the customer recognises the business), otherwise the
// platform A2P Messaging Service. Returns a spec to spread into messages.create,
// or null if neither is available.
async function resolveFrom(tenantId) {
  const { data } = await supabase
    .from('phone_numbers')
    .select('phone_e164')
    .eq('tenant_id', tenantId)
    .eq('status', 'active')
    .limit(1);
  const tenantNumber = data && data[0] && data[0].phone_e164;
  if (tenantNumber) return { from: tenantNumber };
  if (process.env.TWILIO_MESSAGING_SERVICE_SID) {
    return { messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID };
  }
  return null;
}

// Send one SMS. Returns { ok, sid?, error?, skipped? }. Never throws.
//
//   sendSms({ tenantId, to, body }) -> { ok, sid? } | { ok: false, error }
//
async function sendSms({ tenantId, to, body } = {}) {
  if (!to || !body) return { ok: false, error: 'to and body are required' };
  const c = client();
  if (!c) {
    logger.warn('sms.send_skipped_no_twilio', { to });
    return { ok: false, skipped: true, error: 'SMS is not configured.' };
  }
  const fromSpec = await resolveFrom(tenantId);
  if (!fromSpec) {
    return { ok: false, error: 'No sending number available. Provision a receptionist number first.' };
  }
  try {
    const msg = await c.messages.create({ to, body, ...fromSpec });
    logger.info('sms.sent', { to, sid: msg.sid });
    return { ok: true, sid: msg.sid };
  } catch (err) {
    logger.error('sms.send_failed', { to, error: err.message, code: err.code });
    return { ok: false, error: err.message || 'Failed to send SMS.' };
  }
}

module.exports = { sendSms };
