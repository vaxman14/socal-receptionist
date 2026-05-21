// Twilio inbound voice webhook (multi-tenant IVR).
//
// Flow: validate signature -> resolve tenant by the inbound `To` number ->
// greet + offer an IVR menu:
//
//   Press 1  -> the AI receptionist handles the call (booking / questions),
//               driven by speech recognition, reusing the same conversation
//               thread the customer's SMS uses.
//   Press 2  -> bridge the call to the tenant's staff_phone. If staff do not
//               answer (or no staff number is configured) the caller is sent
//               to voicemail instead of dead air.
//
// Key routing rule: we NEVER dial the tenant's own published number — that
// would loop the call back into this receptionist. "Press 2" always targets a
// separate staff_phone collected at onboarding.

const express = require('express');
const twilio = require('twilio');
const { isValidTwilioRequest } = require('../lib/twilio');
const { resolveTenantByNumber } = require('../lib/tenants');
const { getOrCreateConversation } = require('../lib/conversations');
const { handleMessage } = require('../lib/ai');
const { recordCallStart, updateCall, getCallBySid } = require('../lib/calls');
const logger = require('../lib/logger');

const router = express.Router();

const VoiceResponse = twilio.twiml.VoiceResponse;
// Amazon Polly neural voice — far less robotic than Twilio's default.
const VOICE = { voice: 'Polly.Joanna-Neural' };
// How long to ring the staff line before giving up to voicemail.
const STAFF_DIAL_TIMEOUT = 20;

// Reply with TwiML. Centralised so the content type is never forgotten.
function sendTwiml(res, vr) {
  res.type('text/xml').send(vr.toString());
}

// A bare TwiML response that just says something and hangs up — used for
// unknown numbers, disabled voice, and hard errors.
function sayAndHangup(res, message) {
  const vr = new VoiceResponse();
  vr.say(VOICE, message);
  vr.hangup();
  return sendTwiml(res, vr);
}

// Build the IVR greeting + digit menu. Reused for the initial prompt and the
// single re-prompt when the caller does not press anything.
function menuGather(vr, tenant) {
  const gather = vr.gather({
    numDigits: 1,
    action: '/voice/menu',
    method: 'POST',
    timeout: 6,
  });
  const greeting =
    tenant.voice_greeting ||
    `Thank you for calling ${tenant.business_name}.`;
  gather.say(
    VOICE,
    `${greeting} To book or ask about an appointment, press 1. ` +
      `To speak with our staff, press 2.`
  );
}

// --- Entry: a call arrives --------------------------------------------------

router.post('/voice', async (req, res) => {
  if (!isValidTwilioRequest(req)) {
    return res.status(403).send('Invalid Twilio signature');
  }

  const from = req.body.From;
  const to = req.body.To;
  const callSid = req.body.CallSid;

  let tenant;
  try {
    tenant = await resolveTenantByNumber(to);
  } catch (err) {
    logger.error('voice.tenant_lookup_failed', { error: err.message });
    return sayAndHangup(res, 'We are unable to take your call right now. Please try again later.');
  }

  if (!tenant) {
    logger.warn('voice.unknown_number', { to });
    return sayAndHangup(res, 'This number is not in service. Goodbye.');
  }

  if (tenant.voice_enabled === false) {
    return sayAndHangup(
      res,
      `Thank you for calling ${tenant.business_name}. Please send us a text message and we will get right back to you.`
    );
  }

  try {
    await recordCallStart({ tenantId: tenant.id, callSid, from, to });
  } catch (err) {
    logger.error('voice.record_call_failed', { error: err.message });
  }

  const vr = new VoiceResponse();
  menuGather(vr, tenant);
  // Fallback if the caller pressed nothing: one re-prompt, then voicemail.
  vr.redirect({ method: 'POST' }, '/voice/menu?reprompt=1');
  sendTwiml(res, vr);
});

// --- IVR menu: the caller pressed a key (or timed out) ----------------------

router.post('/voice/menu', async (req, res) => {
  if (!isValidTwilioRequest(req)) {
    return res.status(403).send('Invalid Twilio signature');
  }

  const to = req.body.To;
  const digits = req.body.Digits;
  let tenant;
  try {
    tenant = await resolveTenantByNumber(to);
  } catch (err) {
    return sayAndHangup(res, 'We are unable to take your call right now. Please try again later.');
  }
  if (!tenant) return sayAndHangup(res, 'This number is not in service. Goodbye.');

  const vr = new VoiceResponse();

  // Press 1 — hand the call to the AI receptionist.
  if (digits === '1') {
    const gather = vr.gather({
      input: 'speech',
      action: '/voice/converse',
      method: 'POST',
      speechTimeout: 'auto',
    });
    gather.say(VOICE, 'Great. How can I help you today?');
    // No speech captured -> retry the AI turn rather than dropping the call.
    vr.redirect({ method: 'POST' }, '/voice/converse');
    return sendTwiml(res, vr);
  }

  // Press 2 — transfer to staff.
  if (digits === '2') {
    if (!tenant.staff_phone) {
      vr.say(VOICE, 'I am sorry, no one is available to take your call right now. Please leave a message after the tone.');
      vr.redirect({ method: 'POST' }, '/voice/voicemail-prompt');
      return sendTwiml(res, vr);
    }
    vr.say(VOICE, 'One moment while I connect you with our staff.');
    const dial = vr.dial({
      action: '/voice/dial-status',
      method: 'POST',
      timeout: STAFF_DIAL_TIMEOUT,
      callerId: to, // staff see the business line, not the raw caller
    });
    // The whisper tells whoever picks up that this came via the receptionist.
    dial.number({ url: '/voice/whisper', method: 'POST' }, tenant.staff_phone);
    return sendTwiml(res, vr);
  }

  // No / invalid digit. Re-prompt once, then fall through to voicemail.
  if (req.query.reprompt) {
    vr.say(VOICE, 'I did not get that.');
    vr.redirect({ method: 'POST' }, '/voice/voicemail-prompt');
    return sendTwiml(res, vr);
  }
  menuGather(vr, tenant);
  vr.redirect({ method: 'POST' }, '/voice/menu?reprompt=1');
  sendTwiml(res, vr);
});

// --- AI receptionist: speech-driven conversation loop -----------------------

router.post('/voice/converse', async (req, res) => {
  if (!isValidTwilioRequest(req)) {
    return res.status(403).send('Invalid Twilio signature');
  }

  const from = req.body.From;
  const to = req.body.To;
  const callSid = req.body.CallSid;
  const speech = (req.body.SpeechResult || '').trim();
  const emptyTurns = Number(req.query.empty) || 0;

  let tenant;
  try {
    tenant = await resolveTenantByNumber(to);
  } catch (err) {
    return sayAndHangup(res, 'We are having a brief technical issue. Please call back shortly.');
  }
  if (!tenant) return sayAndHangup(res, 'This number is not in service. Goodbye.');

  const vr = new VoiceResponse();

  // Caller said nothing. Re-prompt twice, then take a message.
  if (!speech) {
    if (emptyTurns >= 2) {
      vr.say(VOICE, 'I am having trouble hearing you. Let me take a message instead.');
      vr.redirect({ method: 'POST' }, '/voice/voicemail-prompt');
      return sendTwiml(res, vr);
    }
    const gather = vr.gather({
      input: 'speech',
      action: `/voice/converse?empty=${emptyTurns + 1}`,
      method: 'POST',
      speechTimeout: 'auto',
    });
    gather.say(VOICE, 'Sorry, I did not catch that. Could you say that again?');
    vr.redirect({ method: 'POST' }, `/voice/converse?empty=${emptyTurns + 1}`);
    return sendTwiml(res, vr);
  }

  // The caller asked for a human mid-conversation.
  if (/\b(human|person|representative|agent|someone|staff|real)\b/i.test(speech) &&
      /\b(speak|talk|reach|connect|transfer|get)\b/i.test(speech)) {
    if (tenant.staff_phone) {
      vr.say(VOICE, 'Of course. Connecting you with our staff now.');
      const dial = vr.dial({
        action: '/voice/dial-status',
        method: 'POST',
        timeout: STAFF_DIAL_TIMEOUT,
        callerId: to,
      });
      dial.number({ url: '/voice/whisper', method: 'POST' }, tenant.staff_phone);
      return sendTwiml(res, vr);
    }
  }

  let reply;
  try {
    const conversation = await getOrCreateConversation(tenant.id, from);
    if (callSid) await updateCall(callSid, { conversation_id: conversation.id, outcome: 'ai_handled' });
    reply = await handleMessage(tenant, conversation, from, speech);
  } catch (err) {
    logger.error('voice.ai_failed', { tenant_id: tenant.id, error: err.message });
    reply = 'I am sorry, I ran into a problem. Let me take a message so someone can call you back.';
    vr.say(VOICE, reply);
    vr.redirect({ method: 'POST' }, '/voice/voicemail-prompt');
    return sendTwiml(res, vr);
  }

  // Speak the reply, then listen for the caller's next turn.
  const gather = vr.gather({
    input: 'speech',
    action: '/voice/converse',
    method: 'POST',
    speechTimeout: 'auto',
  });
  gather.say(VOICE, reply);
  // If they go quiet after a reply, say goodbye gracefully.
  vr.say(VOICE, 'Thank you for calling. Goodbye.');
  vr.hangup();
  sendTwiml(res, vr);
});

// --- Whisper played to staff before the call bridges ------------------------

router.post('/voice/whisper', (req, res) => {
  if (!isValidTwilioRequest(req)) {
    return res.status(403).send('Invalid Twilio signature');
  }
  const vr = new VoiceResponse();
  vr.say(VOICE, 'Call forwarded from your virtual receptionist. Connecting now.');
  sendTwiml(res, vr);
});

// --- After <Dial>: did staff answer? ----------------------------------------

router.post('/voice/dial-status', async (req, res) => {
  if (!isValidTwilioRequest(req)) {
    return res.status(403).send('Invalid Twilio signature');
  }
  const callSid = req.body.CallSid;
  const status = req.body.DialCallStatus; // completed | no-answer | busy | failed | canceled

  const vr = new VoiceResponse();
  if (status === 'completed') {
    // Staff answered and the bridged call has ended — nothing more to do.
    await updateCall(callSid, { outcome: 'transferred' });
    vr.hangup();
    return sendTwiml(res, vr);
  }

  // Staff did not pick up — take a message instead of dropping the caller.
  vr.say(VOICE, 'Sorry, our staff are not available right now.');
  vr.redirect({ method: 'POST' }, '/voice/voicemail-prompt');
  sendTwiml(res, vr);
});

// --- Voicemail --------------------------------------------------------------

router.post('/voice/voicemail-prompt', (req, res) => {
  if (!isValidTwilioRequest(req)) {
    return res.status(403).send('Invalid Twilio signature');
  }
  const vr = new VoiceResponse();
  vr.say(VOICE, 'Please leave your name, number, and a short message after the tone. Press any key when you are finished.');
  vr.record({
    action: '/voice/voicemail',
    method: 'POST',
    maxLength: 120,
    playBeep: true,
    finishOnKey: '#*0123456789',
    transcribe: true,
    transcribeCallback: '/voice/voicemail-transcription',
  });
  // Reached only if the caller leaves nothing.
  vr.say(VOICE, 'We did not receive a message. Goodbye.');
  vr.hangup();
  sendTwiml(res, vr);
});

router.post('/voice/voicemail', async (req, res) => {
  if (!isValidTwilioRequest(req)) {
    return res.status(403).send('Invalid Twilio signature');
  }
  const callSid = req.body.CallSid;
  await updateCall(callSid, {
    outcome: 'voicemail',
    recording_url: req.body.RecordingUrl || null,
    recording_sid: req.body.RecordingSid || null,
  });
  const vr = new VoiceResponse();
  vr.say(VOICE, 'Thank you. We have your message and will get back to you soon. Goodbye.');
  vr.hangup();
  sendTwiml(res, vr);
});

// Async voicemail transcription callback. Fast 204 — Twilio must not retry.
router.post('/voice/voicemail-transcription', async (req, res) => {
  if (!isValidTwilioRequest(req)) return res.status(403).send('Invalid Twilio signature');
  res.sendStatus(204);
  const callSid = req.body.CallSid;
  const text = req.body.TranscriptionText;
  if (callSid && text) await updateCall(callSid, { transcript: text });
});

// --- Call status callback (final disposition) -------------------------------

router.post('/voice/status', async (req, res) => {
  if (!isValidTwilioRequest(req)) return res.status(403).send('Invalid Twilio signature');
  res.sendStatus(204);

  const callSid = req.body.CallSid;
  const callStatus = req.body.CallStatus; // completed | no-answer | busy | failed | canceled
  if (!callSid) return;

  try {
    const duration = req.body.CallDuration ? Number(req.body.CallDuration) : null;
    const patch = {};
    if (duration != null) patch.duration_seconds = duration;

    // If the call ended while still 'in_progress', the caller hung up before
    // reaching any resolution — mark it abandoned.
    const call = await getCallBySid(callSid);
    if (call && call.outcome === 'in_progress') {
      patch.outcome = callStatus === 'completed' ? 'abandoned' : 'missed';
    }
    if (Object.keys(patch).length) await updateCall(callSid, patch);
  } catch (err) {
    logger.error('voice.status_failed', { error: err.message });
  }
});

module.exports = router;
