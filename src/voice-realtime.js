const WebSocket = require('ws');
const config = require('./config');
const { notifySalesLead } = require('./email');
const { sendTelegram } = require('./telegram');

const REALTIME_URL = 'wss://api.openai.com/v1/realtime?model=gpt-realtime-2';

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

const CAPTURE_LEAD_TOOL = {
  type: 'function',
  name: 'capture_lead',
  description: 'Record the prospect once you have name + business + a contact method (email or callback number). This emails Roman and pings him on Telegram.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: "Caller's name" },
      business: { type: 'string', description: 'Business name + what they do' },
      contact: { type: 'string', description: 'Email or callback phone number' },
      pain_point: { type: 'string', description: 'What problem they want solved (missed calls, after-hours, etc.)' },
      notes: { type: 'string', description: 'Anything else relevant — interest level, urgency, objections' },
    },
    required: ['name', 'business', 'contact'],
  },
};

function escapeMd(str) {
  return (str || '-').replace(/[_*`[]/g, '\\$&');
}

function formatTelegramLead({ name, business, contact, pain_point, notes, fromNumber, callSid }) {
  return [
    '🔥 *New sales lead from the test-me-now call!*',
    '',
    `*Name:* ${escapeMd(name)}`,
    `*Business:* ${escapeMd(business)}`,
    `*Contact:* ${escapeMd(contact)}`,
    `*Pain point:* ${escapeMd(pain_point)}`,
    `*Notes:* ${escapeMd(notes)}`,
    `*Called from:* ${escapeMd(fromNumber)}`,
    `*CallSid:* \`${callSid}\``,
  ].join('\n');
}

function handleRealtimeCall(twilioWs, callSidHint, fromNumberHint) {
  let callSid = callSidHint || 'unknown';
  let fromNumber = fromNumberHint || '';

  let streamSid = null;
  let leadCaptured = false;
  let callEnded = false;
  let oaiWs = null;
  const audioBuffer = []; // buffer audio arriving between 'start' and OpenAI open
  const transcript = [];

  // Opened only after Twilio 'start' — avoids burning OpenAI if stream never starts
  function connectOpenAI() {
    oaiWs = new WebSocket(REALTIME_URL, {
      headers: {
        'Authorization': `Bearer ${config.openai.apiKey}`,
      },
    });

    oaiWs.on('open', () => {
      console.log(`[voice-realtime] OpenAI WS open callSid=${callSid}`);
      oaiWs.send(JSON.stringify({
        type: 'session.update',
        session: {
          type: 'realtime',
          output_modalities: ['audio'],
          audio: {
            input: {
              format: { type: 'audio/pcmu' },
              turn_detection: { type: 'semantic_vad' },
            },
            output: {
              format: { type: 'audio/pcmu' },
              voice: 'marin',
            },
          },
          instructions: SYSTEM_PROMPT,
          tools: [CAPTURE_LEAD_TOOL],
          tool_choice: 'auto',
        },
      }));
      // Flush audio buffered before OpenAI was ready
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
          if (msg.name === 'capture_lead') {
            handleCaptureLead(msg.call_id, msg.arguments);
          }
          break;

        case 'session.updated':
          // twilioStarted is guaranteed — we only call connectOpenAI() from 'start' handler
          oaiWs.send(JSON.stringify({ type: 'response.create' }));
          break;

        case 'error':
          console.error('[voice-realtime] OpenAI error:', JSON.stringify(msg.error));
          break;
      }
    });

    oaiWs.on('close', () => cleanup('oai-close'));
    oaiWs.on('error', (err) => {
      console.error('[voice-realtime] OpenAI WS error:', err.message);
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
      fromNumber,
      callSid,
    };

    notifySalesLead(payload).catch(err => console.error('Sales lead email failed:', err.message));
    sendTelegram(formatTelegramLead(payload)).catch(err => console.error('Sales lead Telegram failed:', err.message));

    if (oaiWs && oaiWs.readyState === WebSocket.OPEN) {
      oaiWs.send(JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: callId,
          output: 'Lead captured and Roman has been notified by email + Telegram. Close warmly and ask if there is anything else before they hang up.',
        },
      }));
      oaiWs.send(JSON.stringify({ type: 'response.create' }));
    }
  }

  twilioWs.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.event) {
      case 'start':
        streamSid = (msg.start && msg.start.streamSid) || msg.streamSid;
        if (msg.start && msg.start.callSid) callSid = msg.start.callSid;
        if (msg.start && msg.start.customParameters && msg.start.customParameters.from) {
          fromNumber = msg.start.customParameters.from;
        }
        console.log(`[voice-realtime] stream started callSid=${callSid} from=${fromNumber} streamSid=${streamSid}`);
        connectOpenAI(); // only now — after we have callSid/from and stream is confirmed
        break;

      case 'media':
        if (oaiWs && oaiWs.readyState === WebSocket.OPEN) {
          oaiWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: msg.media.payload }));
        } else if (audioBuffer.length < 150) {
          // Buffer up to ~3s of audio (50 frames/s × 3s) before OpenAI connects
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
    console.error('[voice-realtime] Twilio WS error:', err.message);
    cleanup('twilio-error');
  });

  function cleanup(reason) {
    if (callEnded) return;
    callEnded = true;
    console.log(`[voice-realtime] cleanup reason=${reason} callSid=${callSid} leadCaptured=${leadCaptured}`);

    try { if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close(); } catch {}
    try { if (oaiWs && oaiWs.readyState === WebSocket.OPEN) oaiWs.close(); } catch {}

    if (!leadCaptured) {
      const transcriptText = transcript
        .map(t => `${t.role === 'user' ? 'CALLER' : 'AI'}: ${t.text}`)
        .join('\n') || '(no transcript)';

      notifySalesLead({
        name: '(call ended before capture)',
        business: '-',
        contact: fromNumber || '-',
        pain_point: '-',
        notes: `Caller hung up without a captured lead.\n\n${transcriptText}`,
        fromNumber,
        callSid,
        partial: true,
      }).catch(err => console.error('Partial lead email failed:', err.message));

      sendTelegram([
        '⚠️ *Sales call ended without lead capture*',
        '',
        `*From:* ${escapeMd(fromNumber || '-')}`,
        `*CallSid:* \`${callSid}\``,
        '',
        '*Transcript:*',
        '```',
        transcriptText.slice(0, 1500),
        '```',
      ].join('\n')).catch(err => console.error('Partial lead Telegram failed:', err.message));
    }
  }
}

module.exports = { handleRealtimeCall };
