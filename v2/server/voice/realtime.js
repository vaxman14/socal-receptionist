// OpenAI Realtime API voice handler for SoCal Receptionist V2.
//
// Architecture:
//   Caller → Twilio Media Stream (WebSocket) → this handler → OpenAI Realtime (WebSocket)
//   No round-trip TTS/STT loop — audio streams bidirectionally in real time.
//
// Twilio sends G.711 μ-law (mulaw/pcmu) audio; OpenAI Realtime accepts audio/pcmu natively.
// No audio format conversion needed.

const WebSocket = require('ws');
const twilio = require('twilio');
const { supabase } = require('../lib/supabase');
const { buildSystemPrompt } = require('../lib/ai');
const { getOrCreateConversation } = require('../lib/conversations');
const { recordCallStart, updateCall } = require('../lib/calls');
const { recordUsage, estimateRealtimeCostCents } = require('../lib/usage');
const { sendEmail, brandedEmail, tenantBrand } = require('../lib/email');
const { fireWebhooks } = require('../lib/public-api');
const { computeSlots, resolveDayPreference } = require('../lib/booking');
const googleCalendar = require('../integrations/google-calendar');
const microsoftCalendar = require('../integrations/microsoft-calendar');
const {
  blockVoiceCaller,
  isGoogleVoiceSearchSpam,
} = require('../lib/voice-spam');
const logger = require('../lib/logger');
const OpenAI = require('openai');

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// Pretty-print a phone number for notifications: +19515149294 -> (951) 514-9294.
// Falls back to the raw value for anything that isn't a US +1 E.164 number.
function formatPhone(num) {
  if (!num) return 'unknown';
  const m = String(num).match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : num;
}

// Lazily-built client for the post-call lead-rescue extraction.
let _oai;
function oaiClient() {
  if (!_oai) _oai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _oai;
}

// The realtime model sometimes narrates capturing a lead ("we have your number
// and the service") without actually invoking the capture_lead tool, so the
// lead is lost and the call gets mislabeled as aborted. As a safety net we
// re-read the transcript at hang-up and pull any usable info the caller gave.
async function extractLeadFromTranscript(convoText) {
  const r = await oaiClient().chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          'You read a phone-call transcript between a Receptionist and a Caller and extract the caller\'s lead info. ' +
          'Return ONLY JSON: {"name": string|null, "contact": string|null, "service": string|null, "notes": string|null}. ' +
          'contact = a specific callback phone or email the caller gave; use null if they only confirmed the number they are already calling from. ' +
          'Use null for anything not clearly stated. Never invent values.',
      },
      { role: 'user', content: convoText },
    ],
  });
  try { return JSON.parse(r.choices[0].message.content); } catch { return null; }
}

const RECORDING_TENANT_IDS = new Set(
  (process.env.RECORDING_TENANT_IDS || '').split(',').filter(Boolean)
);

// Polly voice ID → OpenAI Realtime voice (best quality matches)
const POLLY_TO_REALTIME = {
  'Polly.Joanna-Neural':  'marin',
  'Polly.Matthew-Neural': 'cedar',
  'Polly.Salli-Neural':   'shimmer',
  'Polly.Joey-Neural':    'echo',
  'Polly.Amy-Neural':     'coral',
  'Polly.Brian-Neural':   'verse',
};

const REALTIME_MODEL = 'gpt-realtime-2025-08-28';
const OPENAI_WS_URL = `wss://api.openai.com/v1/realtime?model=${REALTIME_MODEL}`;

async function calendarForTenant(tenantId) {
  const { data, error } = await supabase
    .from('tenant_integrations')
    .select('provider')
    .eq('tenant_id', tenantId)
    .eq('enabled', true)
    .in('provider', ['google_calendar', 'microsoft_calendar']);
  if (error) throw error;
  const connected = new Set((data || []).map((row) => row.provider));
  if (connected.has('google_calendar')) return googleCalendar;
  if (connected.has('microsoft_calendar')) return microsoftCalendar;
  throw new Error('No calendar connected');
}

// We request PCM16 (24kHz) from OpenAI and transcode to G.711 mu-law (8kHz)
// ourselves, then feed Twilio. Asking OpenAI for audio/pcmu directly produced
// garbled "wind/roar" audio (PCM bytes played as mu-law). This is bulletproof.
function linearToMulaw(sample) {
  const BIAS = 0x84;
  const CLIP = 32635;
  let sign = (sample >> 8) & 0x80;
  if (sign) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;
  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {}
  const mantissa = (sample >> (exponent + 3)) & 0x0F;
  return (~(sign | (exponent << 4) | mantissa)) & 0xFF;
}

// Hard per-call duration ceiling. A real receptionist call wraps inside 10
// minutes; anything longer is either a stuck stream or someone freeloading.
const MAX_CALL_MS = 10 * 60 * 1000;

// Tools available to the AI receptionist during a call.
function buildTools(tenant) {
  const tools = [
    {
      type: 'function',
      name: 'capture_lead',
      description: "Record a qualified lead once you have the caller's name, a callback number, and the service they need.",
      parameters: {
        type: 'object',
        properties: {
          name:    { type: 'string', description: "Caller's name" },
          contact: { type: 'string', description: 'Callback phone number' },
          service: { type: 'string', description: 'Service or help the caller needs' },
          notes:   { type: 'string', description: 'Any other relevant detail' },
        },
        required: ['name', 'contact', 'service'],
      },
    },
    {
      type: 'function',
      name: 'transfer_to_staff',
      description: 'Transfer the caller to a human staff member.',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Why the caller needs a human' },
        },
        required: [],
      },
    },
  ];

  // Appointment booking — only offered when the tenant enabled it.
  if (tenant && tenant.booking_enabled) {
    tools.push({
      type: 'function',
      name: 'check_availability',
      description: 'Get available appointment times across the next several days. Call this when the caller wants to book or asks what times are open. If the caller asks for a particular day or a date further out (e.g. "Wednesday", "next week", "the 25th"), pass it as preferred_day. Returns a numbered list of slots; read them to the caller and ask which one they want.',
      parameters: { type: 'object', properties: {
        preferred_day: { type: 'string', description: 'Optional. The specific day the caller asked for, e.g. "Wednesday", "next Monday", "tomorrow", or "2026-06-25". Omit to get the soonest openings across the next several days.' },
      }, required: [] },
    });
    tools.push({
      type: 'function',
      name: 'book_appointment',
      description: "Book an appointment after the caller picks a time from check_availability. First collect BOTH the caller's name and their email — the email is where the calendar invite and confirmation are sent, so always ask for it before booking. Pass the slot number, the name, and the email.",
      parameters: {
        type: 'object',
        properties: {
          slot_index: { type: 'number', description: 'The slot number the caller chose (1, 2, 3...) from check_availability' },
          name:       { type: 'string', description: "Caller's name" },
          email:      { type: 'string', description: "Caller's email for the calendar invite (optional)" },
        },
        required: ['slot_index', 'name'],
      },
    });
  }
  return tools;
}

// Handle one Twilio Media Stream WebSocket connection.
function handleMediaStream(twilioWs, req) {
  let openaiWs = null;
  let callSid = null;
  let streamSid = null;
  let tenantId = null;
  let fromNumber = null;
  let tenant = null;
  let conversationId = null;
  let pendingFunctionCalls = new Map();
  let leadCaptured = false;
  let offeredSlots = []; // last slots read to the caller by check_availability
  let recordingEnabled = false;
  let isCallback = false;
  let leadName = null;
  let ourNumber = null;
  let transcript = []; // { role: 'caller'|'ai', text: string }
  let spamDetected = false;
  let realtimeCostCents = 0; // accumulated from response.done usage blocks
  let usageRecorded = false;
  let wrapUpTimer = null;
  let hardStopTimer = null;
  let incomingNotifyTimer = null;

  // --- Outbound audio pacing + barge-in (fixes garbled/overlapping playback) ---
  let playQueue = Buffer.alloc(0);
  let drainTimer = null;
  let currentResponseId = null;
  let assistantSpeaking = false;
  // Manual turn mode: when the tenant sets voice_settings.turn_detection
  // create_response=false, OpenAI's VAD no longer auto-replies on every detected
  // sound. We instead generate a reply only after a MEANINGFUL transcription
  // arrives — so dings/beeps/breaths (which transcribe to nothing) are ignored.
  let manualTurnMode = false;
  let pcmRemainder = Buffer.alloc(0); // leftover PCM16 bytes between deltas
  const FRAME_BYTES = 160; // 20ms of 8kHz G.711 mu-law

  // Decode base64 PCM16@24kHz from OpenAI → downsample to 8kHz (avg 3 samples)
  // → mu-law encode. We own the telephony audio format end to end.
  function pcmDeltaToMulaw(b64) {
    const buf = Buffer.concat([pcmRemainder, Buffer.from(b64, 'base64')]);
    const samples = Math.floor(buf.length / 2);
    const groups = Math.floor(samples / 3);
    const out = Buffer.alloc(groups);
    for (let g = 0; g < groups; g++) {
      const i = g * 6;
      const avg = ((buf.readInt16LE(i) + buf.readInt16LE(i + 2) + buf.readInt16LE(i + 4)) / 3) | 0;
      out[g] = linearToMulaw(avg);
    }
    pcmRemainder = buf.subarray(groups * 6);
    return out;
  }

  function startDrain() {
    if (drainTimer) return;
    // Wall-clock-corrected pacing: setInterval(20) never fires at exactly 20ms
    // (timer drift + event-loop load under the OpenAI WS), so a naive
    // one-frame-per-tick drain falls behind real time and starves → a periodic
    // stutter/gap. Instead, each tick we send as many 20ms frames as the real
    // elapsed time calls for, and reset the clock whenever the queue runs dry.
    let nextFrameAt = Date.now();
    drainTimer = setInterval(() => {
      if (!streamSid || playQueue.length === 0) { nextFrameAt = Date.now(); return; }
      const now = Date.now();
      while (playQueue.length > 0 && nextFrameAt <= now) {
        const frame = playQueue.subarray(0, FRAME_BYTES);
        playQueue = playQueue.subarray(frame.length);
        try {
          twilioWs.send(JSON.stringify({ event: 'media', streamSid, media: { payload: frame.toString('base64') } }));
        } catch {}
        nextFrameAt += 20;
      }
    }, 20);
  }

  function flushPlayback() {
    playQueue = Buffer.alloc(0);
    pcmRemainder = Buffer.alloc(0);
    if (streamSid) {
      try { twilioWs.send(JSON.stringify({ event: 'clear', streamSid })); } catch {}
    }
  }

  // Record accumulated OpenAI cost against the tenant exactly once per call,
  // whether the stream ends via Twilio 'stop' or an abrupt socket close.
  function flushUsage() {
    if (usageRecorded || !tenant || realtimeCostCents <= 0) return;
    usageRecorded = true;
    const cents = Math.ceil(realtimeCostCents);
    recordUsage(tenant.id, { openaiCostCents: cents }).catch((err) =>
      logger.error('voice.realtime.record_usage_failed', { tenant_id: tenant.id, error: err.message })
    );
  }

  logger.info('voice.realtime.stream_connected');

  // Open the OpenAI Realtime WebSocket immediately.
  openaiWs = new WebSocket(OPENAI_WS_URL, {
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
  });

  openaiWs.on('open', () => {
    logger.info('voice.realtime.openai_connected');
  });

  openaiWs.on('message', async (data) => {
    const event = JSON.parse(data);

    switch (event.type) {

      case 'session.created': {
        // Session is ready — configure it with our prompt + tools.
        if (tenant) configureSession();
        break;
      }

      // Forward AI audio deltas back to Twilio.
      case 'response.created': {
        currentResponseId = (event.response && event.response.id) || currentResponseId;
        assistantSpeaking = true;
        break;
      }

      // Queue AI audio, transcoded to mu-law and paced to Twilio in 20ms frames.
      case 'response.output_audio.delta': {
        if (event.delta) {
          try { playQueue = Buffer.concat([playQueue, Buffer.from(event.delta, 'base64')]); } catch {}
        }
        break;
      }

      // AI wants to call a function.
      case 'response.function_call_arguments.done': {
        const callId = event.call_id;
        const fnName = event.name;
        let args = {};
        try { args = JSON.parse(event.arguments || '{}'); } catch (e) {}
        await handleFunctionCall(callId, fnName, args);
        break;
      }

      // Caller speech transcription (requires input_audio_transcription in session).
      case 'conversation.item.input_audio_transcription.completed': {
        const t = (event.transcript || '').trim();
        if (t) transcript.push({ role: 'caller', text: t });
        if (!spamDetected && isGoogleVoiceSearchSpam(t)) {
          spamDetected = true;
          logger.warn('voice.realtime.spam_fingerprint_detected', {
            callSid,
            from: fromNumber,
          });
          blockVoiceCaller(fromNumber).catch((err) =>
            logger.error('voice.realtime.blocklist_persist_failed', {
              from: fromNumber,
              error: err.message,
            })
          );
          clearTimeout(wrapUpTimer);
          clearTimeout(hardStopTimer);
          clearTimeout(incomingNotifyTimer);
          incomingNotifyTimer = null;
          flushPlayback();
          if (drainTimer) {
            clearInterval(drainTimer);
            drainTimer = null;
          }
          const transcriptText = transcript
            .map((line) => `${line.role === 'ai' ? 'AI' : 'Caller'}: ${line.text}`)
            .join('\n');
          if (callSid) {
            await updateCall(callSid, {
              outcome: 'spam_blocked',
              transcript: transcriptText,
            }).catch(() => {});
            // Redirect the live call to TwiML that presses 9 (the robocall's
            // opt-out digit), lingers long enough for the DTMF to register,
            // then hangs up. "w" = 0.5s pause before the tone.
            twilioClient.calls(callSid).update({
              twiml: '<Response><Play digits="ww9"/><Pause length="3"/><Hangup/></Response>',
            })
              .catch((err) => logger.error('voice.realtime.spam_hangup_failed', {
                callSid,
                error: err.message,
              }));
          }
          try {
            if (openaiWs && openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
          } catch {}
          try {
            if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close();
          } catch {}
          break;
        }
        // Manual turn mode: generate a reply ONLY when real words came through.
        // A ding/beep/breath transcribes to '' or punctuation → no letters/digits
        // → we stay silent, killing the "it heard a noise and started talking"
        // problem. Real speech ("yes", "next Tuesday") always has alphanumerics.
        if (manualTurnMode) {
          const hasWords = /[a-z0-9]/i.test(t) && t.replace(/[^a-z0-9]/gi, '').length >= 2;
          if (hasWords) {
            if (assistantSpeaking) {
              // Genuine barge-in: caller spoke over the AI. Cancel + clear, then reply.
              try { openaiWs.send(JSON.stringify({ type: 'response.cancel' })); } catch {}
              flushPlayback();
            }
            try { openaiWs.send(JSON.stringify({ type: 'response.create' })); } catch {}
          }
        }
        break;
      }

      // AI speech transcription. GA event name (beta was response.audio_transcript.done).
      case 'response.output_audio_transcript.done': {
        if (event.transcript) transcript.push({ role: 'ai', text: event.transcript.trim() });
        break;
      }

      // Each completed response reports token usage — accumulate the cost.
      case 'response.done': {
        assistantSpeaking = false;
        realtimeCostCents += estimateRealtimeCostCents(event.response?.usage);
        break;
      }

      case 'error': {
        logger.error('voice.realtime.openai_error', { error: event.error });
        break;
      }
    }
  });

  openaiWs.on('close', () => logger.info('voice.realtime.openai_closed'));
  openaiWs.on('error', (err) => logger.error('voice.realtime.openai_ws_error', { error: err.message }));

  function configureSession() {
    if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN) return;
    // Live-tunable voice settings from the DB (tenants.voice_settings jsonb) — no redeploy.
    const vs = tenant.voice_settings || {};
    const realtimeVoice = vs.voice || POLLY_TO_REALTIME[tenant.voice_id] || 'coral';
    // Turn detection — ported from the Business Line known-good config: server_vad
    // at threshold 0.75 resists barge-in on echo / notification dings / breaths
    // far better than semantic_vad, which was cutting the AI off mid-greeting.
    // DB-tunable per tenant via voice_settings.turn_detection (no redeploy).
    const tdCfg = vs.turn_detection || {};
    const turnDetection = {
      type: tdCfg.type || 'server_vad',
      threshold: tdCfg.threshold != null ? tdCfg.threshold : 0.75,
      prefix_padding_ms: tdCfg.prefix_padding_ms != null ? tdCfg.prefix_padding_ms : 300,
      silence_duration_ms: tdCfg.silence_duration_ms != null ? tdCfg.silence_duration_ms : 700,
      create_response: tdCfg.create_response != null ? tdCfg.create_response : true,
    };
    // When auto-response is off, we drive replies manually off transcriptions.
    manualTurnMode = turnDetection.create_response === false;
    let instructions = buildSystemPrompt(tenant, { channel: 'voice', callerPhone: fromNumber });
    // Outbound callback: override the inbound "qualify + promise a callback" flow.
    // We already have the lead's name/phone/email from the website form, and THIS
    // call is the callback — so don't re-ask for their info and never promise to
    // call them back.
    if (isCallback) {
      instructions += `

OUTBOUND CALLBACK CONTEXT (overrides the inbound flow above):
- YOU are calling the person back because they just submitted a request on ${tenant.business_name}'s website. This call IS the callback. NEVER say "we'll call you back", "someone will be in touch", or "we'll reach you at..." — you are already reaching them, right now.
- We ALREADY have their name${leadName ? ` (${leadName})` : ''}, phone, and email from the form. Do NOT ask for their name or phone number. Greet them by name.
- Your job on this call: ask what they need help with, then offer to schedule a free consultation with an attorney. Do not attempt to answer legal questions (see guardrails). Keep it short and natural.`;
    }
    openaiWs.send(JSON.stringify({
      type: 'session.update',
      session: {
        type: 'realtime',
        output_modalities: ['audio'],
        audio: {
          input: {
            format: { type: 'audio/pcmu' },
            turn_detection: turnDetection,
            // Caller speech transcription. GA API: lives under input, not output —
            // output transcripts arrive automatically via response.output_audio_transcript.*
            transcription: { model: 'gpt-4o-transcribe', language: 'en' },
          },
          output: {
            // Mu-law 8kHz direct from OpenAI, forwarded straight to Twilio (no transcode).
            format: { type: 'audio/pcmu' },
            voice: realtimeVoice,
          },
        },
        instructions,
        tools: buildTools(tenant),
        tool_choice: 'auto',
      },
    }));

    // Outbound callback: the callee answers and usually says "hello" during the
    // ~2s session setup. With auto-response VAD that speech would trigger a
    // reactive reply and preempt our scripted greeting (caller heard a generic
    // "how may I help you"). Discard that buffered audio so the greeting leads.
    if (isCallback) {
      try { openaiWs.send(JSON.stringify({ type: 'input_audio_buffer.clear' })); } catch {}
    }

    // Trigger the AI to greet the caller.
    const disclosurePrefix = recordingEnabled
      ? 'First say: "This call may be recorded for quality and training purposes." Then, '
      : '';
    // Outbound: WE called THEM because they requested a callback on the website.
    // Greet by name (we have it from the form) and ask what they need — do NOT
    // ask their name and do NOT imply a future callback.
    const callbackGreeting = leadName
      ? `Hi ${leadName}, this is ${tenant.business_name} returning the request you just submitted on our website. What can we help you with today?`
      : `Hi, this is ${tenant.business_name} returning the request you just submitted on our website. What can we help you with today?`;
    logger.info('voice.realtime.greeting', { isCallback, hasLeadName: !!leadName });
    openaiWs.send(JSON.stringify({
      type: 'response.create',
      response: {
        instructions: isCallback
          ? `${disclosurePrefix}You are calling the person back. Say this greeting exactly, and do not wait for them to speak first: "${callbackGreeting}"`
          : tenant.voice_greeting
            ? `${disclosurePrefix}Say this greeting exactly: "${tenant.voice_greeting}"`
            : `${disclosurePrefix}greet the caller by saying "Thank you for calling ${tenant.business_name}," then ask how you can help. One sentence. Do not mention AI or virtual receptionist.`,
      },
    }));
  }

  async function handleFunctionCall(callId, fnName, args) {
    let result = 'ok';

    if (fnName === 'capture_lead') {
      try {
        const contact = args.contact || fromNumber;
        const notes = [contact ? `Contact: ${contact}` : null, args.notes].filter(Boolean).join(' — ');
        const { data: lead } = await supabase.from('leads').insert({
          tenant_id: tenantId,
          conversation_id: conversationId,
          customer_phone: fromNumber,
          customer_name: args.name || null,
          service_interest: args.service || null,
          notes: notes || null,
          status: 'qualified',
        }).select('id, customer_phone, customer_name, service_interest, status, notes, created_at').single();
        if (lead) fireWebhooks(tenantId, 'lead.created', lead);
        const notifyTo = tenant?.voicemail_email || tenant?.owner_email;
        if (notifyTo) {
          await sendEmail({
            to: notifyTo,
            subject: `New lead — ${args.name || 'Unknown'} — ${tenant.business_name}`,
            html: `<p><strong>Name:</strong> ${args.name || '—'}</p><p><strong>Phone:</strong> ${fromNumber || '—'}</p><p><strong>Callback:</strong> ${contact || '—'}</p><p><strong>Service:</strong> ${args.service || '—'}</p><p><strong>Notes:</strong> ${args.notes || '—'}</p>`,
            text: `New lead for ${tenant?.business_name}\nName: ${args.name || '—'}\nPhone: ${fromNumber || '—'}\nService: ${args.service || '—'}`,
          });
        }
        leadCaptured = true;
        result = 'Lead captured. Thank the caller and confirm someone will follow up.';
      } catch (err) {
        logger.error('voice.realtime.capture_lead_failed', { error: err.message });
        result = 'error: ' + err.message;
      }
    }

    if (fnName === 'transfer_to_staff') {
      const staffPhone = tenant?.staff_phone;
      if (staffPhone && callSid) {
        // Use Twilio REST to redirect the live call to staff.
        const baseUrl = (process.env.API_PUBLIC_BASE_URL || process.env.APP_BASE_URL || 'https://socal-receptionist-v2-spbrw.ondigitalocean.app').replace(/\/+$/, '');
        twilioClient.calls(callSid).update({
          twiml: `<Response><Say voice="${tenant.voice_id || 'Polly.Joanna-Neural'}">One moment while I connect you with our team.</Say><Dial timeout="20" action="${baseUrl}/voice/dial-status">${staffPhone}</Dial></Response>`,
        }).catch((err) => logger.error('voice.realtime.transfer_failed', { error: err.message }));
        result = 'Transfer initiated.';
      } else {
        result = 'No staff phone configured. Tell the caller someone will call them back shortly.';
      }
    }

    if (fnName === 'check_availability') {
      try {
        const now = new Date();
        const tz  = tenant.timezone || 'America/Los_Angeles';
        const calendar = await calendarForTenant(tenantId);
        const busy = await calendar.getFreeBusy(
          tenantId, now.toISOString(), new Date(now.getTime() + 14 * 86400000).toISOString()
        );
        const pref = args.preferred_day ? resolveDayPreference(args.preferred_day, tz, now) : null;
        let scope;
        if (pref) {
          offeredSlots = computeSlots(tenant, busy, { count: 4, perDayCap: 4, onlyDate: pref, now });
          if (offeredSlots.length === 0) {
            // Nothing that day — fall back to the soonest spread so we still offer something.
            offeredSlots = computeSlots(tenant, busy, { count: 6, perDayCap: 2, now });
            scope = 'Nothing is open on the day they asked for. The soonest available are';
          } else {
            scope = 'Available on the day they asked for';
          }
        } else {
          // Spread across days (max 2/day) so the caller hears multiple days, not just the first morning.
          offeredSlots = computeSlots(tenant, busy, { count: 6, perDayCap: 2, now });
          scope = 'Available times';
        }
        if (offeredSlots.length === 0) {
          result = 'No open appointment times in the next two weeks. Offer to take their info for a callback instead.';
        } else {
          const list = offeredSlots.map((s, i) => `${i + 1}. ${s.label}`).join('; ');
          result = `${scope}: ${list}. Read these options to the caller and ask which number they want. Before booking, collect their name AND their email, then call book_appointment with the slot number, name, and email. If they want a different day than these, call check_availability again with preferred_day set to the day they asked for.`;
        }
      } catch (err) {
        logger.error('voice.realtime.check_availability_failed', { error: err.message });
        result = 'Could not reach the calendar right now. Offer to take their info so the team can call back to schedule.';
      }
    }

    if (fnName === 'book_appointment') {
      try {
        const idx = (parseInt(args.slot_index, 10) || 1) - 1;
        const slot = offeredSlots[idx];
        if (!slot) {
          result = 'That slot is no longer on the list. Call check_availability again and re-offer the times.';
        } else {
          const calendar = await calendarForTenant(tenantId);
          await calendar.createEvent(tenantId, {
            title:        `Appointment — ${args.name || 'Caller'}${fromNumber ? ` (${fromNumber})` : ''}`,
            startIso:     slot.start,
            durationMins: tenant.slot_length_mins || 30,
            attendeeEmail: args.email || undefined,
            attendeeName:  args.name || undefined,
            timezone:     tenant.timezone || 'America/Los_Angeles',
          });
          leadCaptured = true; // a booking is a successful outcome
          result = `Booked for ${slot.label}. Confirm warmly to the caller${args.email ? ' and tell them a confirmation email is on the way' : ''}.`;
          const slotBox = `<p style="font-size:17px;font-weight:600;color:#1a1a2e;background:#fff7f0;border-left:4px solid #f47c20;padding:12px 16px;border-radius:6px;margin:18px 0;">${slot.label}</p>`;
          const notifyTo = tenant?.voicemail_email || tenant?.owner_email;
          if (notifyTo) {
            sendEmail({
              to: notifyTo,
              subject: `📅 New appointment — ${tenant.business_name}`,
              html: brandedEmail({
                heading: '📅 New appointment booked',
                preview: `${args.name || 'A caller'} booked ${slot.label}`,
                bodyHtml: `<p><strong>${args.name || 'Caller'}</strong> just booked an appointment.</p>${slotBox}<p style="margin:0;">Phone: <strong>${formatPhone(fromNumber)}</strong>${args.email ? `<br>Email: <strong>${args.email}</strong>` : ''}</p>`,
              }),
              text: `New appointment: ${args.name || 'Caller'} — ${slot.label} (${formatPhone(fromNumber)}${args.email ? `, ${args.email}` : ''})`,
            }).catch(() => {});
          }
          // Send the CALLER their own confirmation — reliable, unlike the Google
          // invite which depends on Workspace external-invite delivery (Roman's
          // booking showed "1 awaiting" but the invite email never arrived).
          if (args.email) {
            sendEmail({
              to: args.email,
              fromName: tenant.email_from_name || tenant.business_name || undefined,
              subject: `Appointment confirmed — ${tenant.business_name}`,
              html: brandedEmail({
                ...tenantBrand(tenant),
                heading: `You're all set! ✅`,
                preview: `Your appointment is confirmed for ${slot.label}`,
                bodyHtml: `<p>Hi ${args.name || 'there'},</p><p>Your appointment with <strong>${tenant.business_name}</strong> is confirmed for:</p>${slotBox}<p style="margin:0;">Need to reschedule? Just call us back${ourNumber ? ` at <strong>${formatPhone(ourNumber)}</strong>` : ''}.</p>`,
                footer: `<strong style="color:#6b7280;">${tenant.business_name}</strong>${ourNumber ? ` &nbsp;·&nbsp; ${formatPhone(ourNumber)}` : ''}`,
              }),
              text: `Your appointment with ${tenant.business_name} is confirmed for ${slot.label}.${ourNumber ? ` To reschedule, call ${formatPhone(ourNumber)}.` : ''}`,
            }).catch(() => {});
          }
        }
      } catch (err) {
        logger.error('voice.realtime.book_appointment_failed', { error: err.message });
        result = 'The booking did not go through. Apologize and offer to take their info for a callback.';
      }
    }

    // Send the function result back to OpenAI so it can respond.
    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.send(JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: callId,
          output: result,
        },
      }));
      openaiWs.send(JSON.stringify({ type: 'response.create' }));
    }
  }

  // Handle messages from Twilio.
  twilioWs.on('message', async (data) => {
    const msg = JSON.parse(data);

    switch (msg.event) {

      case 'start': {
        streamSid = msg.start.streamSid;
        startDrain(); // begin paced 20ms outbound audio frames
        callSid   = msg.start.callSid;
        // Custom parameters passed from the TwiML <Stream>.
        const params = msg.start.customParameters || {};
        tenantId   = params.tenant_id;
        fromNumber = params.from_number;
        isCallback = params.is_callback === 'true';
        leadName   = params.lead_name || null;
        ourNumber  = params.to_number || '+19514776060';

        // Load the tenant and set up the call record.
        if (tenantId) {
          const { data: t } = await supabase
            .from('tenants')
            .select('*')
            .eq('id', tenantId)
            .maybeSingle();
          tenant = t;

          // Decide recording (and therefore the consent disclosure) the moment we
          // know the tenant — BEFORE the greeting is generated — so a recorded call
          // is never missing the "this call may be recorded" disclosure.
          recordingEnabled = !!(tenant?.recording_enabled || RECORDING_TENANT_IDS.has(tenantId));

          if (tenant) {
            const conv = await getOrCreateConversation(tenant.id, fromNumber).catch(() => null);
            conversationId = conv?.id || null;
          }
        }

        if (callSid) {
          await recordCallStart({ tenantId, callSid, from: fromNumber, to: null }).catch(() => {});
        }

        // Start recording for enabled tenants (DB flag; env var is legacy override).
        if (callSid && (tenant?.recording_enabled || RECORDING_TENANT_IDS.has(tenantId))) {
          recordingEnabled = true;
          const baseUrl = (process.env.API_PUBLIC_BASE_URL || process.env.APP_BASE_URL || 'https://socal-receptionist-v2-spbrw.ondigitalocean.app').replace(/\/+$/, '');
          twilioClient.calls(callSid).recordings.create({
            recordingChannels: 'dual',
            recordingStatusCallback: `${baseUrl}/voice/recording-status`,
            recordingStatusCallbackMethod: 'POST',
            recordingStatusCallbackEvent: ['completed'],
          }).catch(err => logger.error('voice.recording.start_failed', { error: err.message }));
        }

        // Delay the inbound-call alert long enough for known robocall recordings
        // to be transcribed and fingerprinted. A matched spam call cancels this
        // timer, while legitimate callers still generate the normal alert.
        if (tenant) {
          const notifyTo = tenant.voicemail_email || tenant.owner_email;
          if (notifyTo) {
            incomingNotifyTimer = setTimeout(() => {
              incomingNotifyTimer = null;
              if (spamDetected) return;
              const ts = new Date().toLocaleString('en-US', {
                timeZone: tenant.timezone || 'America/Los_Angeles',
                dateStyle: 'medium',
                timeStyle: 'short',
              });
              sendEmail({
                to: notifyTo,
                fromName: tenant.email_from_name || tenant.business_name,
                subject: `📞 Incoming call — ${tenant.business_name}`,
                html: `<p>Someone just called <strong>${tenant.business_name}</strong>.</p><p><strong>From:</strong> ${formatPhone(fromNumber)}<br/><strong>Time:</strong> ${ts}</p>`,
                text: `Incoming call to ${tenant.business_name}\nFrom: ${formatPhone(fromNumber)}\nTime: ${ts}`,
              }).catch(() => {});
            }, 30_000);
          }
        }

        // If openaiWs is already open, configure now; otherwise the open handler will.
        if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
          configureSession();
        }

        // Hard duration cap — Realtime API + Twilio both bill per minute.
        // Warn the model to wrap up, then force-close the stream.
        wrapUpTimer = setTimeout(() => {
          if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN) return;
          logger.warn('voice.realtime.wrap_up_warning', { callSid });
          openaiWs.send(JSON.stringify({
            type: 'conversation.item.create',
            item: {
              type: 'message',
              role: 'system',
              content: [{ type: 'input_text', text: 'TIME LIMIT REACHED: end the call NOW in one short sentence. If you have their info, confirm someone will follow up. Say goodbye warmly.' }],
            },
          }));
          openaiWs.send(JSON.stringify({ type: 'response.create' }));
        }, MAX_CALL_MS - 45_000);
        hardStopTimer = setTimeout(() => {
          logger.warn('voice.realtime.max_duration', { callSid });
          try { if (openaiWs && openaiWs.readyState === WebSocket.OPEN) openaiWs.close(); } catch {}
          try { if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close(); } catch {}
          if (drainTimer) { clearInterval(drainTimer); drainTimer = null; }
        }, MAX_CALL_MS);
        break;
      }

      case 'media': {
        // Forward caller audio to OpenAI.
        if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
          openaiWs.send(JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: msg.media.payload,
          }));
        }
        break;
      }

      case 'stop': {
        logger.info('voice.realtime.stream_stopped', { callSid });
        clearTimeout(wrapUpTimer);
        clearTimeout(hardStopTimer);
        if (drainTimer) { clearInterval(drainTimer); drainTimer = null; }
        flushUsage();
        if (spamDetected) {
          if (callSid) {
            const transcriptText = transcript
              .map((line) => `${line.role === 'ai' ? 'AI' : 'Caller'}: ${line.text}`)
              .join('\n');
            await updateCall(callSid, {
              outcome: 'spam_blocked',
              transcript: transcriptText,
            }).catch(() => {});
          }
          if (openaiWs && openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
          break;
        }
        if (callSid) await updateCall(callSid, { outcome: 'ai_handled' }).catch(() => {});
        if (openaiWs && openaiWs.readyState === WebSocket.OPEN) openaiWs.close();

        // Safety net: if the model gathered the caller's info but never actually
        // called capture_lead, rescue the lead from the transcript so a real
        // lead is never lost (and the call is not mislabeled as aborted).
        if (!leadCaptured && fromNumber && fromNumber !== 'anonymous' && transcript.some(l => l.role === 'caller')) {
          try {
            const convoText = transcript.map(l => `${l.role === 'ai' ? 'Receptionist' : 'Caller'}: ${l.text}`).join('\n');
            const ex = await extractLeadFromTranscript(convoText);
            if (ex && (ex.name || ex.contact || ex.service)) {
              const contact = ex.contact || fromNumber;
              const notes = ['Auto-captured from transcript (capture_lead tool was not called).',
                contact ? `Contact: ${contact}` : null, ex.notes].filter(Boolean).join(' — ');
              const { data: lead } = await supabase.from('leads').insert({
                tenant_id: tenantId,
                conversation_id: conversationId,
                customer_phone: fromNumber,
                customer_name: ex.name || null,
                service_interest: ex.service || null,
                notes,
                status: 'qualified',
              }).select('id, customer_phone, customer_name, service_interest, status, notes, created_at').single();
              if (lead) {
                fireWebhooks(tenantId, 'lead.created', lead);
                leadCaptured = true;
                logger.info('voice.realtime.lead_rescued', { hasName: !!ex.name, hasContact: !!ex.contact, hasService: !!ex.service });
              }
            }
          } catch (err) {
            logger.error('voice.realtime.lead_rescue_failed', { error: err.message });
          }
        }

        // Notify tenant — distinguish completed (lead captured) vs aborted (hung up mid-call).
        if (tenant) {
          const notifyTo = tenant.voicemail_email || tenant.owner_email;
          if (notifyTo) {
            const ts = new Date().toLocaleString('en-US', {
              timeZone: tenant.timezone || 'America/Los_Angeles',
              dateStyle: 'medium',
              timeStyle: 'short',
            });
            const subject = leadCaptured
              ? `✅ Call completed — ${tenant.business_name}`
              : `⚠️ Call aborted — ${tenant.business_name}`;
            const transcriptHtml = transcript.length
              ? `<hr/><h3>Transcript</h3><pre style="font-family:monospace;font-size:13px;line-height:1.5">${transcript.map(l => `${l.role === 'ai' ? '🤖 AI' : '👤 Caller'}: ${l.text}`).join('\n')}</pre>`
              : '';
            const html = leadCaptured
              ? `<p>The caller from <strong>${formatPhone(fromNumber)}</strong> completed the conversation and their info was captured.</p><p><strong>Time:</strong> ${ts}</p>${transcriptHtml}`
              : `<p>The caller from <strong>${formatPhone(fromNumber)}</strong> hung up mid-conversation before leaving their info.</p><p><strong>Time:</strong> ${ts}</p>${transcriptHtml}`;
            sendEmail({ to: notifyTo, fromName: tenant.email_from_name || tenant.business_name, subject, html }).catch(() => {});

            // Save transcript to DB.
            if (callSid && transcript.length) {
              const transcriptText = transcript.map(l => `${l.role === 'ai' ? 'AI' : 'Caller'}: ${l.text}`).join('\n');
              updateCall(callSid, { transcript: transcriptText }).catch(() => {});
            }
          }

          // Telegram notification
          const tgToken = process.env.TELEGRAM_BOT_TOKEN;
          const tgChatId = process.env.TELEGRAM_CHAT_ID || '6335227029';
          logger.info('voice.telegram.attempt', { hasToken: !!tgToken, chatId: tgChatId });
          if (tgToken) {
            const header = leadCaptured ? '✅ Lead captured' : '⚠️ Call ended — no lead';
            const callType = isCallback ? ' (callback)' : '';
            const lines = [`📞 ${header}${callType}`, `From: ${formatPhone(fromNumber)}`, `Business: ${tenant.business_name}`];
            if (transcript.length) {
              lines.push('', 'Transcript:');
              lines.push(...transcript.map(l => `${l.role === 'ai' ? '🤖' : '👤'} ${l.text}`));
            }
            const tgText = lines.join('\n').slice(0, 4000);
            fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ chat_id: tgChatId, text: tgText }),
            }).then(r => r.json()).then(j => {
              if (!j.ok) logger.error('voice.telegram.api_error', { code: j.error_code, description: j.description });
              else logger.info('voice.telegram.sent', { messageId: j.result?.message_id });
            }).catch(err => logger.error('voice.telegram.failed', { error: err.message }));
          }

          // Schedule callback if no lead was captured and this was not already a callback.
          // Do-not-callback list (env CALLBACK_DNC, comma-separated; defaults to Roman's cell)
          // so test calls / specific numbers never get auto-called back.
          const callbackDnc = (process.env.CALLBACK_DNC || '+19515149294').split(',').map((s) => s.trim()).filter(Boolean);
          if (!leadCaptured && !isCallback && fromNumber && fromNumber !== 'anonymous' && !callbackDnc.includes(fromNumber)) {
            const baseUrl = (process.env.API_PUBLIC_BASE_URL || process.env.APP_BASE_URL || 'https://socal-receptionist-v2-spbrw.ondigitalocean.app').replace(/\/+$/, '');
            const callbackFrom = ourNumber || '+19514776060';
            setTimeout(() => {
              twilioClient.calls.create({
                to: fromNumber,
                from: callbackFrom,
                url: `${baseUrl}/voice/callback`,
              }).catch(err => logger.error('voice.callback.create_failed', { error: err.message }));
            }, 30000);
            logger.info('voice.callback.scheduled', { to: fromNumber, from: callbackFrom });
          }
        }
        break;
      }
    }
  });

  twilioWs.on('close', () => {
    logger.info('voice.realtime.twilio_closed');
    clearTimeout(wrapUpTimer);
    clearTimeout(hardStopTimer);
    if (drainTimer) { clearInterval(drainTimer); drainTimer = null; }
    flushUsage();
    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
  });

  twilioWs.on('error', (err) => {
    logger.error('voice.realtime.twilio_ws_error', { error: err.message });
  });
}

module.exports = { handleMediaStream };
