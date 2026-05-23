// OpenAI Realtime API + Twilio Media Streams bridge.
// Replaces the old Record→Whisper→GPT-4o→Polly loop with true bidirectional
// streaming audio — no round-trip latency between turns.
//
// How it works:
//   1. Twilio calls POST /voice/sales → TwiML <Connect><Stream> → opens WS to us
//   2. We open a second WS to OpenAI Realtime API in parallel
//   3. Twilio sends mulaw audio chunks → we forward to OpenAI
//   4. OpenAI sends audio response chunks → we forward back to Twilio
//   5. OpenAI fires tool call events → we handle capture_lead

const WebSocket = require('ws');
const config = require('./config');
const { notifySalesLead } = require('./email');
const { sendTelegram } = require('./telegram');

const REALTIME_URL =
  'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01';

const SYSTEM_PROMPT = `You are Josi, the AI sales agent for SoCal Receptionist — an AI-powered 24/7 receptionist for small businesses in Southern California (Murrieta, Temecula, Riverside County area).

The caller is a prospective customer who dialed the number from our "test me now" CTA on socalreceptionist.com. They want to experience the product before buying. THIS CALL IS THE DEMO. You ARE the product they would be buying for their business.

Your job:
1. Greet warmly, acknowledge that yes — this is an AI, and they're talking to exactly what would answer their business calls.
2. Briefly pitch (one sentence): "SoCal Receptionist answers calls, books appointments, and qualifies leads for you 24/7 — never miss another customer."
3. Qualify the lead by asking ONE question at a time, in order:
   - What's your name?
   - What's your business name and what do you do?
   - How many calls do you miss per week, or what's the biggest pain point?
   - Best email or callback number for Roman to send pricing to?
4. Once you have name + business + contact (email or phone), call the capture_lead tool.
5. After capture_lead returns, close warmly: "Perfect — Roman, our founder, will reach out within 24 hours with pricing and setup. Anything else before you go?"
6. If they ask about pricing, say: "$1,500 setup, $500/month — Roman can walk you through it. I'll have him follow up."
7. If they push for human now, call capture_lead with what you have and tell them Roman will call back today.

Voice rules (THIS IS A PHONE CALL, NOT TEXT):
- Conversational, warm, confident. Short replies — 1-2 sentences max per turn.
- No bullet points, no lists, no markdown — this gets spoken aloud.
- Sound human-ish. Use natural fillers sparingly ("Great", "Got it", "Awesome").
- Don't say "I'm an AI receptionist" more than once — pitch by example, not by listing features.
- If you don't understand a caller, say "Sorry, could you repeat that?" — never invent answers.
- Never quote prices except the $1,500 setup / $500/month numbers above.
- If asked who built you, say: "I was built by Roman in Murrieta. He's the founder."

Stay focused: this is a 2-3 minute discovery call, not a chat session.`;

const TOOLS = [
  {
    type: 'function',
    name: 'capture_lead',
    description:
      'Record the prospect once you have name + business + a contact method (email or callback number). This emails Roman and pings him on Telegram.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: "Caller's name" },
        business: { type: 'string', description: 'Business name + what they do' },
        contact: { type: 'string', description: 'Email or callback phone number' },
        pain_point: {
          type: 'string',
          description: 'What problem they want solved (missed calls, after-hours, etc.)',
        },
        notes: {
          type: 'string',
          description: 'Anything else relevant — interest level, urgency, objections',
        },
      },
      required: ['name', 'business', 'contact'],
    },
  },
];

function formatTelegramLead({ name, business, contact, pain_point, notes, fromNumber, callSid }) {
  return [
    '🔥 *New sales lead from the test-me-now call!*',
    '',
    `*Name:* ${name || '-'}`,
    `*Business:* ${business || '-'}`,
    `*Contact:* ${contact || '-'}`,
    `*Pain point:* ${pain_point || '-'}`,
    `*Notes:* ${notes || '-'}`,
    `*Called from:* ${fromNumber || '-'}`,
    `*CallSid:* \`${callSid}\``,
  ].join('\n');
}

function fireLead(args, fromNumber, callSid) {
  const payload = {
    name: args.name,
    business: args.business,
    contact: args.contact,
    pain_point: args.pain_point,
    notes: args.notes,
    fromNumber,
    callSid,
  };
  notifySalesLead(payload).catch(err =>
    console.error('[realtime] Lead email failed:', err.message)
  );
  sendTelegram(formatTelegramLead(payload)).catch(err =>
    console.error('[realtime] Lead Telegram failed:', err.message)
  );
}

function firePartialLead(fromNumber, callSid, transcript) {
  notifySalesLead({
    name: '(call ended before capture)',
    business: '-',
    contact: fromNumber || '-',
    pain_point: '-',
    notes: `Caller hung up without a captured lead.\n\n${transcript || '(no transcript)'}`,
    fromNumber,
    callSid,
    partial: true,
  }).catch(err => console.error('[realtime] Partial lead email failed:', err.message));

  sendTelegram(
    [
      '⚠️ *Sales call ended without lead capture*',
      '',
      `*From:* ${fromNumber || '-'}`,
      `*CallSid:* \`${callSid}\``,
      '',
      transcript
        ? `*Transcript:*\n\`\`\`\n${transcript.slice(0, 1500)}\n\`\`\``
        : '(no transcript)',
    ].join('\n')
  ).catch(err => console.error('[realtime] Partial lead Telegram failed:', err.message));
}

function handleRealtimeCall(twilioWs, callSid, fromNumber) {
  let streamSid = null;
  let leadCaptured = false;
  let partialFired = false;

  // Accumulate transcript for partial-lead notifications
  const transcriptLines = [];

  // Buffer incremental tool-call arguments across delta events
  let pendingCallId = null;
  let pendingCallName = null;
  let pendingArgs = '';

  function maybeFirePartial() {
    if (!leadCaptured && !partialFired) {
      partialFired = true;
      firePartialLead(fromNumber, callSid, transcriptLines.join('\n'));
    }
  }

  const openaiWs = new WebSocket(REALTIME_URL, {
    headers: {
      Authorization: `Bearer ${config.openai.apiKey}`,
      'OpenAI-Beta': 'realtime=v1',
    },
  });

  function sendToOpenAI(obj) {
    if (openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.send(JSON.stringify(obj));
    }
  }

  function sendToTwilio(obj) {
    if (twilioWs.readyState === WebSocket.OPEN) {
      twilioWs.send(JSON.stringify(obj));
    }
  }

  openaiWs.on('open', () => {
    console.log(`[realtime] OpenAI WS open CallSid=${callSid}`);
    sendToOpenAI({
      type: 'session.update',
      session: {
        modalities: ['audio', 'text'],
        voice: 'alloy',
        input_audio_format: 'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        input_audio_transcription: { model: 'whisper-1' },
        turn_detection: {
          type: 'server_vad',
          silence_duration_ms: 700,
          threshold: 0.5,
          prefix_padding_ms: 300,
          create_response: true,
        },
        tools: TOOLS,
        tool_choice: 'auto',
        instructions: SYSTEM_PROMPT,
      },
    });
  });

  openaiWs.on('message', (raw) => {
    let event;
    try { event = JSON.parse(raw); }
    catch { return; }

    switch (event.type) {
      case 'session.created':
      case 'session.updated':
        console.log(`[realtime] ${event.type} CallSid=${callSid}`);
        break;

      // Forward audio chunks to Twilio as they arrive (true streaming)
      case 'response.audio.delta':
        if (event.delta && streamSid) {
          sendToTwilio({ event: 'media', streamSid, media: { payload: event.delta } });
        }
        break;

      // Caller started speaking — clear queued AI audio so they can interrupt
      case 'input_audio_buffer.speech_started':
        if (streamSid) {
          sendToTwilio({ event: 'clear', streamSid });
        }
        break;

      // Accumulate caller transcript for partial-lead notes
      case 'conversation.item.input_audio_transcription.completed':
        if (event.transcript) {
          transcriptLines.push(`CALLER: ${event.transcript}`);
        }
        break;

      // Accumulate AI transcript for partial-lead notes
      case 'response.audio_transcript.done':
        if (event.transcript) {
          transcriptLines.push(`AI: ${event.transcript}`);
        }
        break;

      // Buffer incremental tool-call argument chunks
      case 'response.function_call_arguments.delta':
        pendingArgs += (event.delta || '');
        if (!pendingCallId) pendingCallId = event.call_id;
        if (!pendingCallName) pendingCallName = event.name;
        break;

      // Tool call complete — execute it and return result to OpenAI
      case 'response.function_call_arguments.done': {
        const callId = event.call_id || pendingCallId;
        const fnName = event.name || pendingCallName;
        const argsStr = event.arguments || pendingArgs;
        pendingCallId = null;
        pendingCallName = null;
        pendingArgs = '';

        let args = {};
        try { args = JSON.parse(argsStr); } catch { /* use empty args */ }

        let output = 'Unknown tool.';
        if (fnName === 'capture_lead') {
          leadCaptured = true;
          fireLead(args, fromNumber, callSid);
          output =
            'Lead captured and Roman has been notified by email + Telegram. Close warmly and ask if there is anything else before they hang up.';
        }

        sendToOpenAI({
          type: 'conversation.item.create',
          item: { type: 'function_call_output', call_id: callId, output },
        });
        sendToOpenAI({ type: 'response.create' });
        break;
      }

      case 'error':
        console.error('[realtime] OpenAI error:', JSON.stringify(event.error));
        break;
    }
  });

  openaiWs.on('close', () => {
    console.log(`[realtime] OpenAI WS closed CallSid=${callSid}`);
    if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close();
  });

  openaiWs.on('error', (err) => {
    console.error('[realtime] OpenAI WS error:', err.message);
    if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close();
  });

  // Inbound Twilio Media Streams events
  twilioWs.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); }
    catch { return; }

    switch (msg.event) {
      case 'connected':
        console.log(`[realtime] Twilio connected CallSid=${callSid}`);
        break;

      case 'start':
        streamSid = msg.start && msg.start.streamSid;
        console.log(`[realtime] Stream started streamSid=${streamSid} CallSid=${callSid}`);
        break;

      case 'media':
        sendToOpenAI({ type: 'input_audio_buffer.append', audio: msg.media.payload });
        break;

      case 'stop':
        console.log(`[realtime] Twilio stream stopped CallSid=${callSid}`);
        maybeFirePartial();
        if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
        break;
    }
  });

  twilioWs.on('close', () => {
    console.log(`[realtime] Twilio WS closed CallSid=${callSid}`);
    maybeFirePartial();
    if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
  });

  twilioWs.on('error', (err) => {
    console.error('[realtime] Twilio WS error:', err.message);
    maybeFirePartial();
    if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
  });
}

module.exports = { handleRealtimeCall };
