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
const { sendEmail } = require('../lib/email');
const logger = require('../lib/logger');

const router = express.Router();

const VoiceResponse = twilio.twiml.VoiceResponse;
// Amazon Polly neural voices available for tenant selection.
const DEFAULT_VOICE_ID = 'Polly.Joanna-Neural';
// How long to ring the staff line before giving up to voicemail.
const STAFF_DIAL_TIMEOUT = 20;

function voice(tenant) {
  return { voice: (tenant && tenant.voice_id) || DEFAULT_VOICE_ID };
}

// Reply with TwiML. Centralised so the content type is never forgotten.
function sendTwiml(res, vr) {
  res.type('text/xml').send(vr.toString());
}

// A bare TwiML response that just says something and hangs up — used for
// unknown numbers, disabled voice, and hard errors.
function sayAndHangup(res, message, tenant) {
  const vr = new VoiceResponse();
  vr.say(voice(tenant), message);
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
    timeout: 2,
  });
  const greeting =
    tenant.voice_greeting ||
    `Thank you for calling ${tenant.business_name}.`;
  // SSML: slight slow-down + natural pauses between sentences so it doesn't
  // sound rushed. Polly Neural supports SSML natively via Twilio.
  const ssml =
    `<speak><prosody rate="95%">` +
    `${greeting}` +
    `<break time="700ms"/>` +
    `To reach our staff directly, press 2.` +
    `<break time="400ms"/>` +
    `Otherwise, stay on the line and I'll be happy to help you.` +
    `</prosody></speak>`;
  gather.say(voice(tenant), ssml);
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
    return sayAndHangup(res, 'We are unable to take your call right now. Please try again later.', null);
  }

  if (!tenant) {
    logger.warn('voice.unknown_number', { to });
    return sayAndHangup(res, 'This number is not in service. Goodbye.', null);
  }

  if (tenant.voice_enabled === false) {
    return sayAndHangup(
      res,
      `Thank you for calling ${tenant.business_name}. Please send us a text message and we will get right back to you.`,
      tenant
    );
  }

  try {
    await recordCallStart({ tenantId: tenant.id, callSid, from, to });
  } catch (err) {
    logger.error('voice.record_call_failed', { error: err.message });
  }

  const vr = new VoiceResponse();
  menuGather(vr, tenant);
  // Caller stayed on the line (no digit) -> send them straight to the AI.
  vr.redirect({ method: 'POST' }, '/voice/converse');
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
    return sayAndHangup(res, 'We are unable to take your call right now. Please try again later.', null);
  }
  if (!tenant) return sayAndHangup(res, 'This number is not in service. Goodbye.', null);

  const vr = new VoiceResponse();

  // Press 1 — hand the call to the AI receptionist.
  if (digits === '1') {
    const gather = vr.gather({
      input: 'speech',
      action: '/voice/converse',
      method: 'POST',
      speechTimeout: '1',
    });
    gather.say(voice(tenant), 'Great. How can I help you today?');
    // No speech captured -> retry the AI turn rather than dropping the call.
    vr.redirect({ method: 'POST' }, '/voice/converse');
    return sendTwiml(res, vr);
  }

  // Press 2 — transfer to staff.
  if (digits === '2') {
    if (!tenant.staff_phone) {
      vr.say(voice(tenant), 'I am sorry, no one is available to take your call right now. Please leave a message after the tone.');
      vr.redirect({ method: 'POST' }, '/voice/voicemail-prompt');
      return sendTwiml(res, vr);
    }
    vr.say(voice(tenant), 'One moment while I connect you with our staff.');
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

  // No digit / timeout / invalid -> send to AI receptionist.
  vr.redirect({ method: 'POST' }, '/voice/converse');
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
    return sayAndHangup(res, 'We are having a brief technical issue. Please call back shortly.', null);
  }
  if (!tenant) return sayAndHangup(res, 'This number is not in service. Goodbye.', null);

  const vr = new VoiceResponse();

  // Caller said nothing.
  if (!speech) {
    if (emptyTurns >= 2) {
      vr.say(voice(tenant), 'I am having trouble hearing you. Let me take a message instead.');
      vr.redirect({ method: 'POST' }, '/voice/voicemail-prompt');
      return sendTwiml(res, vr);
    }
    const spoke = req.query.spoke === '1';
    const spokeParam = spoke ? '&spoke=1' : '';
    const gather = vr.gather({
      input: 'speech',
      action: `/voice/converse?empty=${emptyTurns + 1}${spokeParam}`,
      method: 'POST',
      speechTimeout: '1',
    });
    const prompt = spoke
      ? 'Is there anything else I can help you with today?'
      : emptyTurns === 0
        ? 'How can I help you today?'
        : 'Sorry, I did not catch that. Could you say that again?';
    gather.say(voice(tenant), prompt);
    vr.redirect({ method: 'POST' }, `/voice/converse?empty=${emptyTurns + 1}${spokeParam}`);
    return sendTwiml(res, vr);
  }

  // The caller asked for a human mid-conversation.
  if (/\b(human|person|representative|agent|someone|staff|real)\b/i.test(speech) &&
      /\b(speak|talk|reach|connect|transfer|get)\b/i.test(speech)) {
    if (tenant.staff_phone) {
      vr.say(voice(tenant), 'Of course. Connecting you with our staff now.');
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
    reply = await handleMessage(tenant, conversation, from, speech, { model: 'gpt-4o-mini', channel: 'voice' });
  } catch (err) {
    logger.error('voice.ai_failed', { tenant_id: tenant.id, error: err.message });
    reply = 'I am sorry, I ran into a problem. Let me take a message so someone can call you back.';
    vr.say(voice(tenant), reply);
    vr.redirect({ method: 'POST' }, '/voice/voicemail-prompt');
    return sendTwiml(res, vr);
  }

  // Speak the reply, then listen for the caller's next turn.
  // spoke=1 tells the empty-turn handler the AI has already exchanged with the caller.
  const gather = vr.gather({
    input: 'speech',
    action: '/voice/converse?spoke=1',
    method: 'POST',
    speechTimeout: '1',
  });
  gather.say(voice(tenant), reply);
  vr.say(voice(tenant), 'Thank you for calling. Goodbye.');
  vr.hangup();
  sendTwiml(res, vr);
});

// --- Whisper played to staff before the call bridges ------------------------

router.post('/voice/whisper', (req, res) => {
  if (!isValidTwilioRequest(req)) {
    return res.status(403).send('Invalid Twilio signature');
  }
  const vr = new VoiceResponse();
  vr.say(voice(tenant), 'Call forwarded from your virtual receptionist. Connecting now.');
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
  vr.say(voice(tenant), 'Sorry, our staff are not available right now.');
  vr.redirect({ method: 'POST' }, '/voice/voicemail-prompt');
  sendTwiml(res, vr);
});

// --- Voicemail --------------------------------------------------------------

router.post('/voice/voicemail-prompt', (req, res) => {
  if (!isValidTwilioRequest(req)) {
    return res.status(403).send('Invalid Twilio signature');
  }
  const vr = new VoiceResponse();
  vr.say(voice(tenant), 'Please leave your name, number, and a short message after the tone. Press any key when you are finished.');
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
  vr.say(voice(tenant), 'We did not receive a message. Goodbye.');
  vr.hangup();
  sendTwiml(res, vr);
});

router.post('/voice/voicemail', async (req, res) => {
  if (!isValidTwilioRequest(req)) {
    return res.status(403).send('Invalid Twilio signature');
  }
  const callSid = req.body.CallSid;
  const from = req.body.From;
  const to = req.body.To;
  const recordingUrl = req.body.RecordingUrl || null;

  await updateCall(callSid, {
    outcome: 'voicemail',
    recording_url: recordingUrl,
    recording_sid: req.body.RecordingSid || null,
  });

  // Notify the tenant owner about the voicemail.
  try {
    const tenant = await resolveTenantByNumber(to);
    if (tenant) {
      const notifyTo = tenant.voicemail_email || tenant.owner_email;
      if (notifyTo) {
        await sendEmail({
          to: notifyTo,
          subject: `Voicemail from ${from} — ${tenant.business_name}`,
          html: `<p>You have a new voicemail from <strong>${from}</strong>.</p>${recordingUrl ? `<p><a href="${recordingUrl}">Listen to recording</a></p>` : ''}`,
          text: `New voicemail from ${from} for ${tenant.business_name}.${recordingUrl ? `\nRecording: ${recordingUrl}` : ''}`,
        });
      }
    }
  } catch (err) {
    logger.error('voice.voicemail_notify_failed', { error: err.message });
  }

  const vr = new VoiceResponse();
  const tenant = await resolveTenantByNumber(to).catch(() => null);
  vr.say(voice(tenant), 'Thank you. We have your message and will get back to you soon. Goodbye.');
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
