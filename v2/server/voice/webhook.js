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
// How long to ring the staff line before giving up to voicemail.
const STAFF_DIAL_TIMEOUT = 20;
const DEFAULT_VOICE_ID = 'Polly.Joanna-Neural';
const HEBREW_VOICE_ID = 'Polly.Carmit-Neural';

// Detect language from the dialed number's country code.
// Hebrew mode disabled until ענה launch — flip +972 back to 'he' when ready.
function langFor(phoneNumber) {
  return 'en';
}

// Build the Twilio voice param from the tenant's chosen voice.
function voiceFor(tenant, lang) {
  if (lang === 'he') return { voice: HEBREW_VOICE_ID };
  return { voice: tenant.voice_id || DEFAULT_VOICE_ID };
}

// IVR strings by language.
const STRINGS = {
  en: {
    greeting: (name) => `Thank you for calling ${name}.`,
    menu: 'To book or ask about an appointment, press 1. To speak with our staff, press 2.',
    aiOpen: 'Great. How can I help you today?',
    connectStaff: 'One moment while I connect you with our staff.',
    noStaff: 'I am sorry, no one is available to take your call right now. Please leave a message after the tone.',
    whisper: 'Call forwarded from your virtual receptionist. Connecting now.',
    notAvailable: 'We are unable to take your call right now. Please try again later.',
    notInService: 'This number is not in service. Goodbye.',
    textInstead: (name) => `Thank you for calling ${name}. Please send us a text message and we will get right back to you.`,
    retry: 'Sorry, I did not catch that. Could you say that again?',
    toohardHearing: 'I am having trouble hearing you. Let me take a message instead.',
    humanTransfer: 'Of course. Connecting you with our staff now.',
    staffUnavailable: 'Sorry, our staff are not available right now.',
    voicemailPrompt: 'Please leave your name, number, and a short message after the tone. Press any key when you are finished.',
    voicemailEmpty: 'We did not receive a message. Goodbye.',
    voicemailThank: 'Thank you. We have your message and will get back to you soon. Goodbye.',
    goodbye: 'Thank you for calling. Goodbye.',
    didNotGet: 'I did not get that.',
    aiError: 'I am sorry, I ran into a problem. Let me take a message so someone can call you back.',
  },
  he: {
    greeting: (name) => `תודה שהתקשרת ל-${name}.`,
    menu: 'לתיאום פגישה או לשאלות, לחצ/י 1. לדבר עם נציג, לחצ/י 2.',
    aiOpen: 'מעולה. איך אוכל לעזור לך היום?',
    connectStaff: 'רגע אחד, אני מעביר/ה אותך לנציג.',
    noStaff: 'מצטערים, אין נציג פנוי כרגע. אנא השאר/י הודעה אחרי הצפצוף.',
    whisper: 'שיחה מועברת מהמזכירה הווירטואלית שלך. מתחבר/ת עכשיו.',
    notAvailable: 'אנחנו לא יכולים לקבל את שיחתך כרגע. אנא נסה/י שוב מאוחר יותר.',
    notInService: 'המספר הזה אינו בשירות. שלום.',
    textInstead: (name) => `תודה שהתקשרת ל-${name}. אנא שלח/י לנו הודעת טקסט ונחזור אליך בהקדם.`,
    retry: 'סליחה, לא הצלחתי לשמוע. אפשר לחזור על זה?',
    toohardHearing: 'אני מתקשה לשמוע אותך. אני אקח הודעה במקום.',
    humanTransfer: 'בוודאי. מעביר/ה אותך לנציג עכשיו.',
    staffUnavailable: 'מצטערים, הנציגים שלנו לא זמינים כרגע.',
    voicemailPrompt: 'אנא השאר/י את שמך, מספרך, והודעה קצרה אחרי הצפצוף. לחצ/י על כל מקש כשסיימת.',
    voicemailEmpty: 'לא קיבלנו הודעה. שלום.',
    voicemailThank: 'תודה. קיבלנו את ההודעה שלך ונחזור אליך בהקדם. שלום.',
    goodbye: 'תודה שהתקשרת. שלום.',
    didNotGet: 'לא הבנתי.',
    aiError: 'מצטערים, נתקלתי בבעיה. אני אקח הודעה כדי שמישהו יחזור אליך.',
  },
};

// Reply with TwiML. Centralised so the content type is never forgotten.
function sendTwiml(res, vr) {
  res.type('text/xml').send(vr.toString());
}

// A bare TwiML response that just says something and hangs up — used for
// unknown numbers, disabled voice, and hard errors.
function sayAndHangup(res, message, voice = { voice: DEFAULT_VOICE_ID }) {
  const vr = new VoiceResponse();
  vr.say(voice, message);
  vr.hangup();
  return sendTwiml(res, vr);
}

// Build the IVR greeting + digit menu. Reused for the initial prompt and the
// single re-prompt when the caller does not press anything.
function menuGather(vr, tenant, lang) {
  const voice = voiceFor(tenant, lang);
  const s = STRINGS[lang];
  const gather = vr.gather({
    numDigits: 1,
    action: '/voice/menu',
    method: 'POST',
    timeout: 6,
  });
  const greeting = tenant.voice_greeting || s.greeting(tenant.business_name);
  gather.say(voice, `${greeting} ${s.menu}`);
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
    const l = langFor(to);
    return sayAndHangup(res, STRINGS[l].notAvailable, { voice: l === 'he' ? HEBREW_VOICE_ID : DEFAULT_VOICE_ID });
  }

  if (!tenant) {
    logger.warn('voice.unknown_number', { to });
    const l = langFor(to);
    return sayAndHangup(res, STRINGS[l].notInService, { voice: l === 'he' ? HEBREW_VOICE_ID : DEFAULT_VOICE_ID });
  }

  const lang = langFor(to);
  const s = STRINGS[lang];

  if (tenant.voice_enabled === false) {
    return sayAndHangup(res, s.textInstead(tenant.business_name), voiceFor(tenant, lang));
  }

  try {
    await recordCallStart({ tenantId: tenant.id, callSid, from, to });
  } catch (err) {
    logger.error('voice.record_call_failed', { error: err.message });
  }

  // Fire-and-forget call notification to the tenant's voicemail email.
  if (tenant.voicemail_email) {
    sendEmail({
      to: tenant.voicemail_email,
      subject: `📞 Incoming call to ${tenant.business_name} from ${from}`,
      html: `<p>Someone just called <strong>${tenant.business_name}</strong>.</p>
<p><strong>From:</strong> ${from}<br/>
<strong>To:</strong> ${to}<br/>
<strong>Time:</strong> ${new Date().toLocaleString('en-US', { timeZone: tenant.timezone || 'America/Los_Angeles', dateStyle: 'medium', timeStyle: 'short' })}</p>
<p>Log in to your dashboard to see the full call log.</p>`,
    }).catch(() => {});
  }

  const vr = new VoiceResponse();
  menuGather(vr, tenant, lang);
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
    const l = langFor(to);
    return sayAndHangup(res, STRINGS[l].notAvailable, { voice: l === 'he' ? HEBREW_VOICE_ID : DEFAULT_VOICE_ID });
  }
  if (!tenant) {
    const l = langFor(to);
    return sayAndHangup(res, STRINGS[l].notInService, { voice: l === 'he' ? HEBREW_VOICE_ID : DEFAULT_VOICE_ID });
  }

  const lang = langFor(to);
  const s = STRINGS[lang];
  const vr = new VoiceResponse();
  const voice = voiceFor(tenant, lang);

  // Press 1 — hand the call to the AI receptionist.
  if (digits === '1') {
    const gather = vr.gather({
      input: 'speech',
      action: '/voice/converse',
      method: 'POST',
      speechTimeout: 'auto',
      language: lang === 'he' ? 'he-IL' : 'en-US',
    });
    gather.say(voice, s.aiOpen);
    // No speech captured -> retry the AI turn rather than dropping the call.
    vr.redirect({ method: 'POST' }, '/voice/converse');
    return sendTwiml(res, vr);
  }

  // Press 2 — transfer to staff.
  if (digits === '2') {
    if (!tenant.staff_phone) {
      vr.say(voice, s.noStaff);
      vr.redirect({ method: 'POST' }, '/voice/voicemail-prompt');
      return sendTwiml(res, vr);
    }
    vr.say(voice, s.connectStaff);
    const dial = vr.dial({
      action: '/voice/dial-status',
      method: 'POST',
      timeout: STAFF_DIAL_TIMEOUT,
      callerId: to,
    });
    dial.number({ url: '/voice/whisper', method: 'POST' }, tenant.staff_phone);
    return sendTwiml(res, vr);
  }

  // No / invalid digit. Re-prompt once, then fall through to voicemail.
  if (req.query.reprompt) {
    vr.say(voice, s.didNotGet);
    vr.redirect({ method: 'POST' }, '/voice/voicemail-prompt');
    return sendTwiml(res, vr);
  }
  menuGather(vr, tenant, lang);
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
    const l = langFor(to);
    return sayAndHangup(res, STRINGS[l].notAvailable, { voice: l === 'he' ? HEBREW_VOICE_ID : DEFAULT_VOICE_ID });
  }
  if (!tenant) {
    const l = langFor(to);
    return sayAndHangup(res, STRINGS[l].notInService, { voice: l === 'he' ? HEBREW_VOICE_ID : DEFAULT_VOICE_ID });
  }

  const lang = langFor(to);
  const s = STRINGS[lang];
  const vr = new VoiceResponse();
  const voice = voiceFor(tenant, lang);
  const speechLang = lang === 'he' ? 'he-IL' : 'en-US';

  // Caller said nothing. Re-prompt twice, then take a message.
  if (!speech) {
    if (emptyTurns >= 2) {
      vr.say(voice, s.toohardHearing);
      vr.redirect({ method: 'POST' }, '/voice/voicemail-prompt');
      return sendTwiml(res, vr);
    }
    const gather = vr.gather({
      input: 'speech',
      action: `/voice/converse?empty=${emptyTurns + 1}`,
      method: 'POST',
      speechTimeout: 'auto',
      language: speechLang,
    });
    gather.say(voice, s.retry);
    vr.redirect({ method: 'POST' }, `/voice/converse?empty=${emptyTurns + 1}`);
    return sendTwiml(res, vr);
  }

  // The caller asked for a human mid-conversation.
  const humanPattern = lang === 'he'
    ? /נציג|אדם|אנושי|מישהו|עובד/
    : /\b(human|person|representative|agent|someone|staff|real)\b/i;
  if (humanPattern.test(speech) && tenant.staff_phone) {
    vr.say(voice, s.humanTransfer);
    const dial = vr.dial({
      action: '/voice/dial-status',
      method: 'POST',
      timeout: STAFF_DIAL_TIMEOUT,
      callerId: to,
    });
    dial.number({ url: '/voice/whisper', method: 'POST' }, tenant.staff_phone);
    return sendTwiml(res, vr);
  }

  let reply;
  try {
    const conversation = await getOrCreateConversation(tenant.id, from);
    if (callSid) await updateCall(callSid, { conversation_id: conversation.id, outcome: 'ai_handled' });
    reply = await handleMessage(tenant, conversation, from, speech);
  } catch (err) {
    logger.error('voice.ai_failed', { tenant_id: tenant.id, error: err.message });
    vr.say(voice, s.aiError);
    vr.redirect({ method: 'POST' }, '/voice/voicemail-prompt');
    return sendTwiml(res, vr);
  }

  // Speak the reply, then listen for the caller's next turn.
  const gather = vr.gather({
    input: 'speech',
    action: '/voice/converse',
    method: 'POST',
    speechTimeout: 'auto',
    language: speechLang,
  });
  gather.say(voice, reply);
  vr.say(voice, s.goodbye);
  vr.hangup();
  sendTwiml(res, vr);
});

// --- Whisper played to staff before the call bridges ------------------------

router.post('/voice/whisper', async (req, res) => {
  if (!isValidTwilioRequest(req)) {
    return res.status(403).send('Invalid Twilio signature');
  }
  const vr = new VoiceResponse();
  const tenant = await resolveTenantByNumber(req.body.To).catch(() => null);
  const lang = langFor(req.body.To);
  const voice = tenant ? voiceFor(tenant, lang) : { voice: DEFAULT_VOICE_ID };
  vr.say(voice, STRINGS[lang].whisper);
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
  const lang2 = langFor(req.body.To);
  vr.say({ voice: lang2 === 'he' ? HEBREW_VOICE_ID : DEFAULT_VOICE_ID }, STRINGS[lang2].staffUnavailable);
  vr.redirect({ method: 'POST' }, '/voice/voicemail-prompt');
  sendTwiml(res, vr);
});

// --- Voicemail --------------------------------------------------------------

router.post('/voice/voicemail-prompt', async (req, res) => {
  if (!isValidTwilioRequest(req)) {
    return res.status(403).send('Invalid Twilio signature');
  }
  const vr = new VoiceResponse();
  const tenant = await resolveTenantByNumber(req.body.To).catch(() => null);
  const lang = langFor(req.body.To);
  const voice = tenant ? voiceFor(tenant, lang) : { voice: lang === 'he' ? HEBREW_VOICE_ID : DEFAULT_VOICE_ID };
  const s = STRINGS[lang];
  vr.say(voice, s.voicemailPrompt);
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
  vr.say(voice, s.voicemailEmpty);
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
  const tenant = await resolveTenantByNumber(req.body.To).catch(() => null);
  const lang = langFor(req.body.To);
  const voice = tenant ? voiceFor(tenant, lang) : { voice: lang === 'he' ? HEBREW_VOICE_ID : DEFAULT_VOICE_ID };
  vr.say(voice, STRINGS[lang].voicemailThank);
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
  const from = req.body.From || req.body.Called || 'unknown';
  const to = req.body.To || req.body.Called || 'unknown';
  const durationRaw = req.body.CallDuration ? Number(req.body.CallDuration) : null;
  if (!callSid) return;

  let finalOutcome = null;
  try {
    const patch = {};
    if (durationRaw != null) patch.duration_seconds = durationRaw;

    const call = await getCallBySid(callSid);
    if (call && call.outcome === 'in_progress') {
      patch.outcome = callStatus === 'completed' ? 'abandoned' : 'missed';
    }
    if (Object.keys(patch).length) await updateCall(callSid, patch);

    finalOutcome = (call && call.outcome !== 'in_progress') ? call.outcome : patch.outcome || 'completed';

    // Send outcome email to the tenant's voicemail address.
    const tenant = await resolveTenantByNumber(to).catch(() => null);
    if (tenant && tenant.voicemail_email) {
      const dur = durationRaw != null ? `${durationRaw}s` : 'unknown';
      const outcomeLabel = {
        ai_handled: 'Handled by AI',
        transferred: 'Transferred to staff',
        voicemail: 'Left voicemail',
        abandoned: 'Caller hung up early',
        missed: 'Missed / no answer',
        completed: 'Completed',
      }[finalOutcome] || finalOutcome || callStatus;
      sendEmail({
        to: tenant.voicemail_email,
        subject: `📋 Call complete — ${outcomeLabel} (${dur}) from ${from}`,
        html: `<p><strong>Caller:</strong> ${from}<br/>
<strong>Line:</strong> ${to}<br/>
<strong>Duration:</strong> ${dur}<br/>
<strong>Outcome:</strong> ${outcomeLabel}</p>
<p><a href="https://app.socalreceptionist.com">View in dashboard →</a></p>`,
      }).catch(() => {});
    }
  } catch (err) {
    logger.error('voice.status_failed', { error: err.message });
  }
});

module.exports = router;
