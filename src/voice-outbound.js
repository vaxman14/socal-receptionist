// Outbound AI sales call: we dial the prospect, AI speaks first.
//
// Flow:
//   POST /voice/outbound/call   — initiates call via Twilio REST API
//   POST /voice/outbound/start  — Twilio webhook when prospect answers → returns TwiML stream
//   WS   /voice/outbound/stream — Realtime API bridge (AI greets immediately)

const WebSocket = require('ws');
const twilio = require('twilio');
const config = require('./config');
const { notifySalesLead, sendCalendarInvite } = require('./email');
const { sendTelegram } = require('./telegram');
const { verifyStreamToken } = require('./stream-auth');
const { getAvailableTimes } = require('./calendly');
const { createDemoEvent } = require('./gcal');

const REALTIME_URL = 'wss://api.openai.com/v1/realtime?model=gpt-realtime-2';

// Keyed by callSid: context injected at initiation, consumed when stream starts.
const pendingCalls = new Map();

function buildSystemPrompt({ name, businessType, reason }) {
  const who = name || 'there';
  const biz = businessType ? ` who runs a ${businessType}` : '';
  const ctx = reason ? `\n\nWhy you're calling: ${reason}` : '';

  return `You are Josi, the AI outbound agent for SoCal Receptionist — an AI-powered 24/7 receptionist for small businesses in Southern California (Murrieta, Temecula, Riverside County).

YOU PLACED THIS CALL to ${who}${biz}. You initiated it — own it confidently.

Opening line: "Hi, is this ${who}? This is Josi calling from SoCal Receptionist — we build AI receptionists for businesses in the Murrieta and Temecula area. Do you have just a quick minute?"${ctx}

Your job:
1. Confirm you reached the right person. If wrong number or voicemail, leave a brief message: "Hi this is Josi from SoCal Receptionist — we help businesses in SoCal never miss a call. Give us a ring back at your convenience." Then end.
2. Quick pitch: "We handle your inbound calls, book appointments, and qualify leads 24/7 — so you never miss a customer again."
3. Qualify with ONE question at a time:
   - Is handling calls a challenge right now, or are you pretty covered?
   - What kind of business do you run?
   - How many calls do you miss per week, or what's the biggest pain?
   - Best email or callback number for our founder Roman to send pricing details?
4. Once you have name + business + contact, call the capture_lead tool.
5. After capture_lead returns available times, read them off one by one and ask which works. Once they pick a slot, ask for their email to send the calendar invite, then call schedule_meeting.
6. If they ask about pricing, say: "We have two options — Essentials is five hundred a month with no setup fee, and Concierge is also five hundred a month with a fifteen hundred dollar one-time setup for full white-glove onboarding. We also offer annual at forty-eight hundred a year. I can have a team member send you the full breakdown."
7. If it's a bad time: "Totally understand — what's the best number and time for us to call back?"
8. If they're not interested: thank them genuinely and hang up gracefully. No pushback.

Voice rules (THIS IS A PHONE CALL):
- Conversational, warm, confident. 1-2 sentences max per turn.
- No bullet points, lists, or markdown — this gets spoken aloud.
- You called them — be confident, not apologetic.
- If you don't understand, say "Sorry, could you repeat that?"
- Never mention you're reading from a script or that this is automated.`;
}

const CAPTURE_LEAD_TOOL = {
  type: 'function',
  name: 'capture_lead',
  description: 'Record the prospect once you have name + business + a contact method. Notifies Roman.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: "Prospect's name" },
      business: { type: 'string', description: 'Business name + what they do' },
      contact: { type: 'string', description: 'Email or callback phone number' },
      pain_point: { type: 'string', description: 'Main pain point or challenge' },
      notes: { type: 'string', description: 'Interest level, objections, anything else' },
    },
    required: ['name', 'business', 'contact'],
  },
};

const SCHEDULE_MEETING_TOOL = {
  type: 'function',
  name: 'schedule_meeting',
  description: "Book a 30-minute demo call on Roman's calendar.",
  parameters: {
    type: 'object',
    properties: {
      slot_index: { type: 'number', description: 'Index (0, 1, 2) of the time slot they chose' },
      caller_email: { type: 'string', description: "Prospect's email for the calendar invite" },
      caller_name: { type: 'string', description: "Prospect's full name" },
    },
    required: ['slot_index', 'caller_email', 'caller_name'],
  },
};

function escapeMd(str) {
  return (str || '-').replace(/[_*`[]/g, '\\$&');
}

// Initiate an outbound call. baseUrl is the full origin (e.g. https://sea-lion-app-34cxl.ondigitalocean.app).
async function initiateCall(to, leadContext = {}, baseUrl) {
  const client = twilio(config.twilio.accountSid, config.twilio.authToken);
  const from = config.twilio.salesNumber || config.twilio.phoneNumber;

  const call = await client.calls.create({
    to,
    from,
    url: `${baseUrl}/voice/outbound/start`,
    statusCallback: `${baseUrl}/voice/outbound/status`,
    statusCallbackMethod: 'POST',
    method: 'POST',
    record: false,
  });

  pendingCalls.set(call.sid, {
    to,
    name: leadContext.name || '',
    businessType: leadContext.businessType || '',
    reason: leadContext.reason || '',
    initiatedAt: Date.now(),
  });

  // Auto-clean after 10 min (call will have ended or errored by then)
  setTimeout(() => pendingCalls.delete(call.sid), 10 * 60 * 1000);

  console.log(`[voice-outbound] initiated callSid=${call.sid} to=${to}`);
  return call.sid;
}

function handleOutboundStream(twilioWs) {
  let callSid = 'unknown';
  let toNumber = '';
  let leadContext = {};

  let streamSid = null;
  let leadCaptured = false;
  let callEnded = false;
  let oaiWs = null;
  let availableSlots = [];
  const audioBuffer = [];
  const transcript = [];

  function connectOpenAI() {
    const systemPrompt = buildSystemPrompt(leadContext);

    oaiWs = new WebSocket(REALTIME_URL, {
      headers: { 'Authorization': `Bearer ${config.openai.apiKey}` },
    });

    oaiWs.on('open', () => {
      console.log(`[voice-outbound] OpenAI WS open callSid=${callSid}`);
      oaiWs.send(JSON.stringify({
        type: 'session.update',
        session: {
          type: 'realtime',
          output_modalities: ['audio'],
          audio: {
            input: {
              format: { type: 'audio/pcmu' },
              turn_detection: {
                type: 'server_vad',
                threshold: 0.5,
                prefix_padding_ms: 300,
                silence_duration_ms: 500,
              },
            },
            output: {
              format: { type: 'audio/pcmu' },
              voice: 'marin',
            },
          },
          instructions: systemPrompt,
          tools: [CAPTURE_LEAD_TOOL, SCHEDULE_MEETING_TOOL],
          tool_choice: 'auto',
        },
      }));

      for (const payload of audioBuffer) {
        oaiWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: payload }));
      }
      audioBuffer.length = 0;
    });

    oaiWs.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      switch (msg.type) {
        case 'response.output_audio.delta':
          if (streamSid && msg.delta) {
            try {
              twilioWs.send(JSON.stringify({
                event: 'media',
                streamSid,
                media: { payload: msg.delta },
              }));
            } catch {}
          }
          break;

        case 'response.output_audio_transcript.delta':
          if (msg.delta) transcript.push({ role: 'assistant', text: msg.delta });
          break;

        case 'conversation.item.input_audio_transcription.completed':
          if (msg.transcript) transcript.push({ role: 'user', text: msg.transcript });
          break;

        case 'response.function_call_arguments.done':
          if (msg.name === 'capture_lead') handleCaptureLead(msg.call_id, msg.arguments);
          else if (msg.name === 'schedule_meeting') handleScheduleMeeting(msg.call_id, msg.arguments);
          break;

        case 'session.updated':
          // Outbound: AI speaks first — fire greeting immediately after session is ready
          oaiWs.send(JSON.stringify({ type: 'response.create' }));
          break;

        case 'error':
          console.error('[voice-outbound] OpenAI error:', JSON.stringify(msg.error));
          break;
      }
    });

    oaiWs.on('close', () => cleanup('oai-close'));
    oaiWs.on('error', (err) => {
      console.error('[voice-outbound] OpenAI WS error:', err.message);
      cleanup('oai-error');
    });
  }

  async function handleCaptureLead(callId, rawArgs) {
    if (leadCaptured) return;
    let args = {};
    try { args = JSON.parse(rawArgs || '{}'); } catch {}
    leadCaptured = true;

    const payload = {
      name: args.name,
      business: args.business,
      contact: args.contact,
      pain_point: args.pain_point,
      notes: args.notes,
      fromNumber: toNumber,
      callSid,
    };

    [availableSlots] = await Promise.all([
      getAvailableTimes(3).catch(() => []),
      notifySalesLead(payload).catch(err => console.error('[voice-outbound] lead email failed:', err.message)),
      sendTelegram([
        '📞 *Outbound call — lead captured!*',
        '',
        `*Name:* ${escapeMd(args.name)}`,
        `*Business:* ${escapeMd(args.business)}`,
        `*Contact:* ${escapeMd(args.contact)}`,
        `*Pain point:* ${escapeMd(args.pain_point)}`,
        `*Notes:* ${escapeMd(args.notes)}`,
        `*Called:* ${escapeMd(toNumber)}`,
        `*CallSid:* \`${callSid}\``,
      ].join('\n')).catch(err => console.error('[voice-outbound] Telegram failed:', err.message)),
    ]);

    if (oaiWs && oaiWs.readyState === WebSocket.OPEN) {
      const slotText = availableSlots.length > 0
        ? `Here are Roman's next available times:\n${availableSlots.map((s, i) => `${i + 1}. ${s.label}`).join('\n')}\n\nAsk which slot works, get their email, then call schedule_meeting.`
        : 'No open slots on Calendly right now. Tell them a team member will reach out within 24 hours to schedule.';

      oaiWs.send(JSON.stringify({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: callId, output: `Lead captured. Roman notified. ${slotText}` },
      }));
      oaiWs.send(JSON.stringify({ type: 'response.create' }));
    }
  }

  async function handleScheduleMeeting(callId, rawArgs) {
    let args = {};
    try { args = JSON.parse(rawArgs || '{}'); } catch {}

    const { slot_index = 0, caller_email, caller_name } = args;
    const slot = availableSlots[slot_index];

    let output;
    if (!slot || !caller_email) {
      output = 'Missing slot or email — tell them a team member will follow up within 24 hours to confirm the time.';
    } else {
      const useGcal = config.gcal.clientId && config.gcal.refreshToken;
      try {
        if (useGcal) {
          await createDemoEvent({ callerName: caller_name || caller_email, callerEmail: caller_email, startIso: slot.start });
        } else {
          await sendCalendarInvite({ callerName: caller_name || 'there', callerEmail: caller_email, startIso: slot.start, hostEmail: 'vaxman14@gmail.com', hostName: 'Roman Vaxman' });
        }
        output = `Meeting booked for ${slot.label}. Invite sent to ${caller_email}. Confirm warmly and close the call.`;
      } catch (err) {
        console.error('[voice-outbound] booking failed:', err.message);
        output = `Booking failed. Tell them a team member will personally confirm the ${slot.label} time — they'll reach out within the hour.`;
      }
    }

    if (oaiWs && oaiWs.readyState === WebSocket.OPEN) {
      oaiWs.send(JSON.stringify({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: callId, output },
      }));
      oaiWs.send(JSON.stringify({ type: 'response.create' }));
    }
  }

  twilioWs.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.event) {
      case 'start': {
        const params = (msg.start && msg.start.customParameters) || {};
        const authToken = params.auth;
        const meta = verifyStreamToken(authToken);
        if (!meta) {
          console.warn('[voice-outbound] rejected stream: invalid auth token');
          cleanup('invalid-auth');
          return;
        }
        streamSid = (msg.start && msg.start.streamSid) || msg.streamSid;
        if (msg.start && msg.start.callSid) callSid = msg.start.callSid;
        if (params.to) toNumber = params.to;

        leadContext = pendingCalls.get(callSid) || {};
        pendingCalls.delete(callSid);

        console.log(`[voice-outbound] stream started callSid=${callSid} to=${toNumber} name=${leadContext.name || '(unknown)'}`);

        // Pre-fetch calendar availability so it's ready when lead is captured
        getAvailableTimes(3).then(slots => { availableSlots = slots; }).catch(() => {});

        connectOpenAI();
        break;
      }

      case 'media':
        if (oaiWs && oaiWs.readyState === WebSocket.OPEN) {
          oaiWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: msg.media.payload }));
        } else if (audioBuffer.length < 150) {
          audioBuffer.push(msg.media.payload);
        }
        break;

      case 'stop':
        cleanup('twilio-stop');
        break;
    }
  });

  twilioWs.on('close', () => cleanup('twilio-close'));
  twilioWs.on('error', (err) => {
    console.error('[voice-outbound] Twilio WS error:', err.message);
    cleanup('twilio-error');
  });

  function cleanup(reason) {
    if (callEnded) return;
    callEnded = true;
    console.log(`[voice-outbound] cleanup reason=${reason} callSid=${callSid} leadCaptured=${leadCaptured}`);

    try { if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close(); } catch {}
    try { if (oaiWs && oaiWs.readyState === WebSocket.OPEN) oaiWs.close(); } catch {}

    if (!leadCaptured) {
      const transcriptText = transcript
        .map(t => `${t.role === 'user' ? 'PROSPECT' : 'AI'}: ${t.text}`)
        .join('\n') || '(no transcript)';

      sendTelegram([
        '📵 *Outbound call ended — no lead captured*',
        '',
        `*Called:* ${escapeMd(toNumber)}`,
        `*Name:* ${escapeMd(leadContext.name)}`,
        `*CallSid:* \`${callSid}\``,
        '',
        '*Transcript:*',
        '```',
        transcriptText.slice(0, 1500),
        '```',
      ].join('\n')).catch(() => {});
    }
  }
}

module.exports = { initiateCall, handleOutboundStream, pendingCalls };
