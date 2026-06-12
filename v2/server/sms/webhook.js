// Twilio inbound SMS webhook (multi-tenant).
//
// Flow: validate signature -> resolve tenant by the inbound `To` number ->
// handle STOP/START/HELP + consent -> if opted in and tenant active, hand to
// the AI. The webhook stays lean; anything slow belongs in a provisioning job.

const express = require('express');
const twilio = require('twilio');
const { isValidTwilioRequest } = require('../lib/twilio');
const { resolveTenantByNumber } = require('../lib/tenants');
const consent = require('../lib/consent');
const { getOrCreateConversation } = require('../lib/conversations');
const { handleMessage } = require('../lib/ai');
const { supabase } = require('../lib/supabase');
const { checkInbound } = require('../lib/ratelimit');
const { withinCaps, recordUsage, notifyCapBreach } = require('../lib/usage');
const logger = require('../lib/logger');

const router = express.Router();

// Carrier-standard keywords (case-insensitive).
const STOP_WORDS = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT']);
const START_WORDS = new Set(['START', 'YES', 'Y', 'UNSTOP']);
const HELP_WORDS = new Set(['HELP', 'INFO']);

// Voice-first launch gate. The SMS channel stays dark until A2P 10DLC carrier
// review clears — until then SMS_ENABLED is false (the default) and the webhook
// only sends a "call us instead" auto-reply. Voice is unaffected.
const SMS_ENABLED = process.env.SMS_ENABLED === 'true';

router.post('/sms', async (req, res) => {
  if (!isValidTwilioRequest(req)) {
    console.warn('[sms] rejected: invalid Twilio signature');
    return res.status(403).send('Invalid Twilio signature');
  }

  // SMS disabled platform-wide (pre-A2P launch). Still 200 to Twilio so it does
  // not retry, but skip all processing and point the customer at the phone.
  if (!SMS_ENABLED) {
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message("SMS isn't available yet — please call us instead.");
    return res.type('text/xml').send(twiml.toString());
  }

  const from = req.body.From;
  const to = req.body.To;
  const body = (req.body.Body || '').trim();
  const twiml = new twilio.twiml.MessagingResponse();
  res.type('text/xml');

  if (!from || !to || !body) {
    twiml.message("Sorry, I didn't catch that. Could you resend your message?");
    return res.send(twiml.toString());
  }

  let tenant;
  try {
    tenant = await resolveTenantByNumber(to);
  } catch (err) {
    console.error('[sms] tenant lookup failed:', err.message);
    return res.send(twiml.toString()); // empty TwiML
  }
  if (!tenant) {
    console.warn(`[sms] no tenant registered for number ${to}`);
    return res.send(twiml.toString()); // unknown number — drop silently
  }

  const word = body.toUpperCase();
  try {
    // Opt-out is honored in any tenant/consent state. Twilio sends its own
    // STOP confirmation, so we reply with empty TwiML.
    if (STOP_WORDS.has(word)) {
      await consent.setStatus(tenant.id, from, 'opted_out');
      return res.send(twiml.toString());
    }

    const status = await consent.getStatus(tenant.id, from);

    if (HELP_WORDS.has(word)) {
      twiml.message(
        `${tenant.business_name}: automated virtual receptionist. Reply STOP to opt out. Msg & data rates may apply.`
      );
      return res.send(twiml.toString());
    }

    if (status === 'opted_out') {
      if (START_WORDS.has(word)) {
        await consent.setStatus(tenant.id, from, 'opted_in');
        twiml.message("You're opted back in. How can I help you today?");
      }
      return res.send(twiml.toString());
    }

    if (status === 'unknown') {
      await consent.setStatus(tenant.id, from, 'pending');
      twiml.message(
        `Hi! You've reached ${tenant.business_name}. Reply YES to chat with our virtual receptionist, or STOP to opt out. Msg & data rates may apply.`
      );
      return res.send(twiml.toString());
    }

    if (status === 'pending') {
      if (START_WORDS.has(word)) {
        await consent.setStatus(tenant.id, from, 'opted_in');
        twiml.message("You're all set! How can I help you today?");
      } else {
        twiml.message('Reply YES to continue or STOP to opt out.');
      }
      return res.send(twiml.toString());
    }

    // status === 'opted_in' — gate on the tenant being live, then hand to AI.
    if (tenant.status !== 'active') {
      twiml.message(
        `Thanks for reaching ${tenant.business_name}! Our virtual receptionist isn't live yet — please try again soon.`
      );
      return res.send(twiml.toString());
    }

    // Rate limiting + abuse detection (per tenant and per customer).
    const rate = await checkInbound(tenant.id, from);
    if (!rate.allowed) {
      logger.warn('sms.rate_limited', { tenant_id: tenant.id, from, reason: rate.reason });
      if (rate.abuse) {
        await supabase.from('audit_log').insert({
          tenant_id: tenant.id,
          actor_type: 'system',
          action: 'abuse.blocked',
          target_type: 'phone',
          target_id: from,
          metadata: { reason: rate.reason },
        });
      }
      return res.send(twiml.toString()); // drop silently
    }

    // Per-tenant spend caps — stop serving once a monthly cap is hit.
    const caps = withinCaps(tenant);
    if (!caps.ok) {
      logger.warn('sms.spend_cap', { tenant_id: tenant.id, reason: caps.reason });
      notifyCapBreach(tenant, caps.reason);
      twiml.message(
        `Thanks for contacting ${tenant.business_name}! We're unavailable right now — please try again later.`
      );
      return res.send(twiml.toString());
    }

    const conversation = await getOrCreateConversation(tenant.id, from);
    const reply = await handleMessage(tenant, conversation, from, body);
    // Count the inbound + outbound message pair against the tenant's usage.
    recordUsage(tenant.id, { smsCount: 2 }).catch((err) =>
      logger.error('sms.record_usage_failed', { tenant_id: tenant.id, error: err.message })
    );
    twiml.message(reply);
    return res.send(twiml.toString());
  } catch (err) {
    console.error('[sms] handler error:', err);
    twiml.message(
      `Thanks for contacting ${tenant.business_name}! We're having a brief technical hiccup — someone will follow up shortly.`
    );
    return res.send(twiml.toString());
  }
});

// Twilio delivery status callback -> message_status. Tenant is resolved from
// the sending number (`From`). Always 204s fast so Twilio never retries.
router.post('/sms/status', async (req, res) => {
  if (!isValidTwilioRequest(req)) return res.status(403).send('Invalid Twilio signature');
  res.sendStatus(204);

  const sid = req.body.MessageSid;
  const status = req.body.MessageStatus;
  if (!sid || !status) return;

  try {
    const tenant = await resolveTenantByNumber(req.body.From);
    if (!tenant) return;
    const { data: msg } = await supabase
      .from('messages')
      .select('id')
      .eq('twilio_sid', sid)
      .maybeSingle();
    await supabase.from('message_status').insert({
      message_id: msg ? msg.id : null,
      tenant_id: tenant.id,
      twilio_sid: sid,
      status,
      error_code: req.body.ErrorCode || null,
      raw: req.body,
    });
  } catch (err) {
    console.error('[sms/status] failed:', err.message);
  }
});

module.exports = router;
