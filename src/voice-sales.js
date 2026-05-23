// AI sales-call agent. Used on the "test me now" sales line — a prospect
// dials the published 951 number, our AI answers, pitches the product
// (by demonstrating it), and collects pre-signup info before hanging up.
//
// State flow per call:
//   1. Twilio dials POST /voice/sales -> greeting + <Gather>
//   2. Each turn POSTs to /voice/sales/turn with SpeechResult
//   3. AI replies; loops until lead captured or caller hangs up
//   4. On capture_lead -> email Roman + Telegram-ping Josi/Roman
//
// Conversation history is keyed by CallSid (not phone number) so two
// prospects calling at the same time stay isolated.

const OpenAI = require('openai');
const config = require('./config');
const { notifySalesLead } = require('./email');
const { sendTelegram } = require('./telegram');

const openai = config.groq.apiKey
  ? new OpenAI({ apiKey: config.groq.apiKey, baseURL: config.groq.baseURL })
  : new OpenAI({ apiKey: config.openai.apiKey });

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

const tools = [
  {
    type: 'function',
    function: {
      name: 'capture_lead',
      description:
        'Record the prospect once you have name + business + a contact method (email or callback number). This emails Roman and pings him on Telegram.',
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
    },
  },
];

// In-memory per-call conversation. Keyed by CallSid.
// CALL_TTL is short — Twilio call timeouts are ~5 min anyway.
const CALL_TTL_MS = 15 * 60 * 1000;
const calls = new Map();

function getCall(callSid) {
  const entry = calls.get(callSid);
  if (entry && Date.now() - entry.updatedAt < CALL_TTL_MS) return entry;
  calls.delete(callSid);
  return null;
}

function setCall(callSid, data) {
  calls.set(callSid, { ...data, updatedAt: Date.now() });
}

setInterval(() => {
  const now = Date.now();
  for (const [sid, entry] of calls) {
    if (now - entry.updatedAt > CALL_TTL_MS) calls.delete(sid);
  }
}, 5 * 60 * 1000).unref();

async function complete(messages) {
  const response = await openai.chat.completions.create({
    model: config.groq.apiKey ? config.groq.model : config.openai.model,
    messages,
    tools,
    temperature: 0.6,
    max_tokens: 180,
  });
  return response.choices[0].message;
}

async function runTool(call, callSid, fromNumber) {
  let args = {};
  try { args = JSON.parse(call.function.arguments || '{}'); }
  catch (err) { console.error('Sales tool args parse failed:', err.message); }

  if (call.function.name === 'capture_lead') {
    const entry = getCall(callSid) || { messages: [] };
    entry.leadCaptured = true;
    entry.lead = args;
    setCall(callSid, entry);

    const payload = {
      name: args.name,
      business: args.business,
      contact: args.contact,
      pain_point: args.pain_point,
      notes: args.notes,
      fromNumber,
      callSid,
    };

    // Fire-and-forget so we don't block the voice response.
    notifySalesLead(payload).catch(err => console.error('Sales lead email failed:', err.message));
    sendTelegram(formatTelegramLead(payload)).catch(err => console.error('Sales lead Telegram failed:', err.message));

    return 'Lead captured and Roman has been notified by email + Telegram. Close warmly and ask if there is anything else before they hang up.';
  }
  return 'Unknown tool.';
}

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

// Run the OpenAI loop, processing any tool calls. Returns the final
// assistant text to be spoken to the caller.
async function turn(callSid, fromNumber, userText) {
  let entry = getCall(callSid);
  if (!entry) entry = { messages: [], leadCaptured: false };

  if (userText) entry.messages.push({ role: 'user', content: userText });

  const messages = [{ role: 'system', content: SYSTEM_PROMPT }, ...entry.messages];

  let response = await complete(messages);
  let rounds = 0;

  while (response.tool_calls && response.tool_calls.length && rounds < 3) {
    messages.push(response);
    entry.messages.push(response);

    for (const call of response.tool_calls) {
      const result = await runTool(call, callSid, fromNumber);
      const toolMsg = { role: 'tool', tool_call_id: call.id, content: result };
      messages.push(toolMsg);
      entry.messages.push(toolMsg);
    }

    response = await complete(messages);
    rounds += 1;
  }

  const reply =
    (response.content && response.content.trim()) ||
    "Thanks for calling SoCal Receptionist! Roman will follow up with you shortly.";

  entry.messages.push({ role: 'assistant', content: reply });
  setCall(callSid, entry);

  return { reply, leadCaptured: !!entry.leadCaptured };
}

// Called when Twilio reports the call ended (status callback).
// If the caller hung up before a lead was captured, fire a partial notification.
async function onCallEnded(callSid, fromNumber, callDurationSec) {
  const entry = getCall(callSid);
  if (!entry || entry.leadCaptured) {
    calls.delete(callSid);
    return;
  }

  // Pull whatever text we got from the caller for a "partial" alert.
  const transcript = entry.messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .filter(m => typeof m.content === 'string')
    .map(m => `${m.role === 'user' ? 'CALLER' : 'AI'}: ${m.content}`)
    .join('\n');

  const payload = {
    fromNumber,
    callSid,
    durationSec: callDurationSec,
    transcript: transcript || '(no usable transcript)',
  };

  notifySalesLead({
    name: '(call ended before capture)',
    business: '-',
    contact: fromNumber || '-',
    pain_point: '-',
    notes: `Caller hung up after ${callDurationSec || '?'}s without a captured lead. Transcript below.\n\n${payload.transcript}`,
    fromNumber,
    callSid,
    partial: true,
  }).catch(err => console.error('Partial sales lead email failed:', err.message));

  sendTelegram(
    [
      '⚠️ *Sales call ended without lead capture*',
      '',
      `*From:* ${fromNumber || '-'}`,
      `*Duration:* ${callDurationSec || '?'}s`,
      `*CallSid:* \`${callSid}\``,
      '',
      '*Transcript:*',
      '```',
      transcript.slice(0, 1500) || '(no transcript)',
      '```',
    ].join('\n')
  ).catch(err => console.error('Partial sales lead Telegram failed:', err.message));

  calls.delete(callSid);
}

module.exports = { turn, onCallEnded };
