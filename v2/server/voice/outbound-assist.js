// Outbound Call Assist — voice-commanded outbound dialer.
//
// The tenant (professional at their desk) calls a dedicated Twilio number.
// Josi answers, hears "Get Robert on the phone", resolves Robert via the
// contact resolver, confirms the match, dials out, and bridges both legs
// into a conference room. Josi drops out once both are connected.
//
// Flow:
//   POST /voice/assist             — call arrives, resolve tenant by caller-id
//   POST /voice/assist/listen      — gather speech after greeting
//   POST /voice/assist/resolve     — contact resolution + confirm
//   POST /voice/assist/dial        — dial contact, create conference
//   POST /voice/assist/bridge      — contact answered, merge into conf
//   POST /voice/assist/conf-status — conference event callback
//
// Tenant identification: we look up the calling number (req.body.From) against
// tenants.outbound_caller_id. The professional must register their caller-ID
// (the number they call FROM) in their settings.

const express  = require('express');
const twilio   = require('twilio');
const { isValidTwilioRequest } = require('../lib/twilio');
const { supabase }             = require('../lib/supabase');
const { resolve: resolveContact } = require('../lib/contact-resolver');
const logger   = require('../lib/logger');

const router = express.Router();
const VoiceResponse = twilio.twiml.VoiceResponse;
const VOICE  = { voice: 'Polly.Joanna-Neural' };

// Twilio REST client for initiating outbound legs.
function twilioClient() {
  return twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

function sendTwiml(res, vr) {
  res.type('text/xml').send(vr.toString());
}

// Look up tenant by the professional's registered caller-ID.
async function resolveTenantByCaller(fromNumber) {
  const { data } = await supabase
    .from('tenants')
    .select('id, business_name, outbound_enabled, outbound_caller_id')
    .eq('outbound_caller_id', fromNumber)
    .eq('outbound_enabled', true)
    .maybeSingle();
  return data || null;
}

// ── Entry: professional calls the outbound assist number ─────────────────────

router.post('/voice/assist', async (req, res) => {
  if (!isValidTwilioRequest(req)) return res.status(403).send('Forbidden');

  const from = req.body.From;
  const callSid = req.body.CallSid;

  const tenant = await resolveTenantByCaller(from);
  if (!tenant) {
    const vr = new VoiceResponse();
    vr.say(VOICE, 'This feature is not enabled for your account. Please contact support.');
    vr.hangup();
    return sendTwiml(res, vr);
  }

  logger.info('outbound-assist.entry', { tenantId: tenant.id, callSid });

  const vr = new VoiceResponse();
  const gather = vr.gather({
    input:       'speech',
    action:      `/voice/assist/resolve?tid=${tenant.id}&sid=${callSid}`,
    method:      'POST',
    speechTimeout: 'auto',
    timeout:     8,
  });
  gather.say(VOICE, `Hi. Who would you like me to call?`);
  vr.redirect({ method: 'POST' }, `/voice/assist/resolve?tid=${tenant.id}&sid=${callSid}&empty=1`);
  sendTwiml(res, vr);
});

// ── Contact resolution ────────────────────────────────────────────────────────

router.post('/voice/assist/resolve', async (req, res) => {
  if (!isValidTwilioRequest(req)) return res.status(403).send('Forbidden');

  const tenantId = req.query.tid;
  const callSid  = req.query.sid;
  const speech   = (req.body.SpeechResult || '').trim();
  const empty    = req.query.empty === '1';
  const vr       = new VoiceResponse();

  if (!speech || empty) {
    if (req.query.retry) {
      vr.say(VOICE, 'I did not catch that. Goodbye.');
      vr.hangup();
      return sendTwiml(res, vr);
    }
    const gather = vr.gather({
      input:         'speech',
      action:        `/voice/assist/resolve?tid=${tenantId}&sid=${callSid}&retry=1`,
      method:        'POST',
      speechTimeout: 'auto',
      timeout:       8,
    });
    gather.say(VOICE, 'Sorry, I did not catch that. Who should I call?');
    vr.redirect({ method: 'POST' }, `/voice/assist/resolve?tid=${tenantId}&sid=${callSid}&retry=1&empty=1`);
    return sendTwiml(res, vr);
  }

  logger.info('outbound-assist.resolve', { tenantId, speech });

  let contact;
  try {
    contact = await resolveContact(tenantId, speech);
  } catch (err) {
    logger.error('outbound-assist.resolve_failed', { tenantId, error: err.message });
    vr.say(VOICE, 'I had trouble looking that up. Please try again.');
    vr.hangup();
    return sendTwiml(res, vr);
  }

  if (!contact) {
    const gather = vr.gather({
      input:         'speech',
      action:        `/voice/assist/resolve?tid=${tenantId}&sid=${callSid}`,
      method:        'POST',
      speechTimeout: 'auto',
      timeout:       8,
    });
    gather.say(VOICE, `I could not find anyone named ${speech} in your contacts. Try a different name.`);
    vr.redirect({ method: 'POST' }, `/voice/assist/resolve?tid=${tenantId}&sid=${callSid}&empty=1`);
    return sendTwiml(res, vr);
  }

  // Disambiguation — multiple strong matches
  if (contact.ambiguous) {
    const names = contact.candidates.map(c => c.name).join(', or ');
    const first = contact.candidates[0];
    // Store candidates in query param (first match) and ask to confirm
    const gather = vr.gather({
      input:         'speech',
      action:        `/voice/assist/confirm?tid=${tenantId}&sid=${callSid}&name=${encodeURIComponent(first.name)}&phone=${encodeURIComponent(first.phone || '')}&retry=disambiguation`,
      method:        'POST',
      speechTimeout: 'auto',
      timeout:       8,
    });
    gather.say(VOICE, `I found a few people. Did you mean ${names}?`);
    vr.redirect({ method: 'POST' }, `/voice/assist/resolve?tid=${tenantId}&sid=${callSid}&empty=1`);
    return sendTwiml(res, vr);
  }

  // No phone number found
  if (!contact.phone) {
    vr.say(VOICE, `I found ${contact.name} but do not have a phone number for them. Add their number to your contacts and try again.`);
    vr.hangup();
    return sendTwiml(res, vr);
  }

  // Confirm before dialing
  const gather = vr.gather({
    input:       'dtmf speech',
    action:      `/voice/assist/dial?tid=${tenantId}&sid=${callSid}&name=${encodeURIComponent(contact.name)}&phone=${encodeURIComponent(contact.phone)}`,
    method:      'POST',
    numDigits:   1,
    timeout:     8,
    speechTimeout: 'auto',
  });
  gather.say(VOICE, `Calling ${contact.name}. Press 1 or say yes to connect, or press 2 to cancel.`);
  vr.redirect({ method: 'POST' }, `/voice/assist/resolve?tid=${tenantId}&sid=${callSid}&empty=1`);
  sendTwiml(res, vr);
});

// ── Dial out and bridge ───────────────────────────────────────────────────────

router.post('/voice/assist/dial', async (req, res) => {
  if (!isValidTwilioRequest(req)) return res.status(403).send('Forbidden');

  const tenantId   = req.query.tid;
  const callSid    = req.query.sid; // the professional's leg CallSid
  const contactName  = decodeURIComponent(req.query.name || '');
  const contactPhone = decodeURIComponent(req.query.phone || '');
  const digits     = (req.body.Digits || '').trim();
  const speech     = (req.body.SpeechResult || '').toLowerCase();
  const vr         = new VoiceResponse();

  const cancelled = digits === '2' || /\b(no|cancel|never mind|nope)\b/.test(speech);
  if (cancelled) {
    vr.say(VOICE, 'Cancelled. Goodbye.');
    vr.hangup();
    return sendTwiml(res, vr);
  }

  const confirmed = digits === '1' || /\b(yes|yeah|yep|sure|ok|go ahead|connect)\b/.test(speech);
  if (!confirmed && (digits || speech)) {
    // Re-ask
    const gather = vr.gather({
      input:     'dtmf speech',
      action:    `/voice/assist/dial?tid=${tenantId}&sid=${callSid}&name=${encodeURIComponent(contactName)}&phone=${encodeURIComponent(contactPhone)}`,
      method:    'POST',
      numDigits: 1,
      timeout:   8,
      speechTimeout: 'auto',
    });
    gather.say(VOICE, `Press 1 to call ${contactName}, or 2 to cancel.`);
    vr.hangup();
    return sendTwiml(res, vr);
  }

  // Create a named conference room keyed to the professional's CallSid
  const confName = `assist-${callSid}`;

  logger.info('outbound-assist.dialing', { tenantId, contactName, contactPhone, confName });

  // Put the professional into the conference room now
  vr.say(VOICE, `Connecting you with ${contactName}. One moment.`);
  const dial = vr.dial();
  dial.conference(confName, {
    startConferenceOnEnter:  true,
    endConferenceOnExit:     true,
    waitUrl: 'https://twilio.com/labs/said/hold-music',
    beep:    false,
  });
  sendTwiml(res, vr);

  // Fire the outbound leg to the contact in the background
  const apiBase = (process.env.API_PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  try {
    await twilioClient().calls.create({
      to:   contactPhone,
      from: process.env.TWILIO_PHONE_NUMBER,
      url:  `${apiBase}/voice/assist/bridge?conf=${encodeURIComponent(confName)}&name=${encodeURIComponent(contactName)}`,
      statusCallback: `${apiBase}/voice/assist/outbound-status`,
      statusCallbackMethod: 'POST',
    });
  } catch (err) {
    logger.error('outbound-assist.dial_failed', { tenantId, contactPhone, error: err.message });
    // Professional is already in conf waiting — can't undo easily, just log it
  }
});

// ── Outbound leg: contact answered — join conference ─────────────────────────

router.post('/voice/assist/bridge', (req, res) => {
  if (!isValidTwilioRequest(req)) return res.status(403).send('Forbidden');

  const confName    = decodeURIComponent(req.query.conf || '');
  const contactName = decodeURIComponent(req.query.name || 'your caller');
  const vr = new VoiceResponse();

  vr.say(VOICE, `Connecting you now.`);
  const dial = vr.dial();
  dial.conference(confName, {
    startConferenceOnEnter: true,
    endConferenceOnExit:    false,
    beep:                   false,
  });
  sendTwiml(res, vr);
});

// ── Outbound status callback (logging only) ───────────────────────────────────

router.post('/voice/assist/outbound-status', (req, res) => {
  if (!isValidTwilioRequest(req)) return res.status(403).send('Forbidden');
  res.sendStatus(204);
  const { CallSid, CallStatus, To } = req.body;
  if (CallStatus === 'no-answer' || CallStatus === 'busy' || CallStatus === 'failed') {
    logger.warn('outbound-assist.contact_unreachable', { callSid: CallSid, to: To, status: CallStatus });
  }
});

module.exports = router;
