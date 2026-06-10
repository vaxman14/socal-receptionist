// Multi-tenant AI receptionist.
//
// Per-tenant: the system prompt is built from the tenant's business config (or
// a stored override), and conversation history comes from Postgres. Captured
// leads and human-handoff requests are written to the `leads` table.

const OpenAI = require('openai');
const { supabase } = require('./supabase');
const { loadTranscript, appendMessage } = require('./conversations');
const { recordUsage, estimateOpenaiCostCents } = require('./usage');
const { sendEmail } = require('./email');

// Lazily constructed: the OpenAI SDK throws if the API key is missing, so
// building the client at import time would crash the whole service whenever
// OPENAI_API_KEY is unset. Deferring it lets the billing / onboarding / admin
// routes boot fine; only the SMS path needs the key.
let _openai;
function openaiClient() {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}

const MAX_TOOL_ROUNDS = 3;

function buildSystemPrompt(tenant, opts = {}) {
  if (tenant.ai_system_prompt) return tenant.ai_system_prompt;

  const isVoice = opts.channel === 'voice';
  const callerPhone = opts.callerPhone || null;

  if (isVoice) {
    return `You are the virtual receptionist for ${tenant.business_name}, speaking with a caller on the phone.
Be warm, friendly, professional, and concise. Keep every reply to 1-2 short spoken sentences — no bullet points, no lists, no links.

Business details:
- Name: ${tenant.business_name}
- Hours: ${tenant.business_hours || 'Not specified'}
- Services: ${tenant.business_services || 'Not specified'}
- Booking link: ${tenant.calendly_link ? 'available (do not read aloud — offer to send via text instead)' : 'Not available'}

${callerPhone ? `The caller's phone number is already known: ${callerPhone}. Do NOT ask for their phone number. If they want a callback to a different number, ask for that number instead.` : ''}

Your responsibilities:
1. Answer questions about hours and services naturally, like a human receptionist.
2. Qualify the lead: collect the caller's name, confirm their callback number (or get a different one), and the service they need.
3. Once you have name + callback number + service, call the "capture_lead" tool with their phone as the contact. Then say "Great, someone from our team will be in touch soon. Is there anything else I can help you with?"
4. If the caller asks to speak to a person or staff member, let them know the team is not available right now but you can take their information so someone calls them back during business hours. Then collect their name and callback number.

Rules:
- ONE question at a time. Never stack multiple questions in one turn.
- Speak naturally — no markdown, no bullet points, no URLs.
- Never invent prices, availability, medical or professional advice, or policies.
- Stay on topic: you represent ${tenant.business_name} only.`;
  }

  return `You are the virtual receptionist for ${tenant.business_name}.
You speak with customers over SMS text message. Be warm, friendly, professional, and concise.

Business details:
- Name: ${tenant.business_name}
- Hours: ${tenant.business_hours || 'Not specified'}
- Services: ${tenant.business_services || 'Not specified'}
- Booking link: ${tenant.calendly_link || 'Not specified'}

Your responsibilities:
1. Greet customers warmly and answer common questions about hours and services.
2. Qualify the lead: collect the customer's name, a contact method (phone or email),
   and the service they need.
3. Once you have name + contact + service, call the "capture_lead" tool. After it
   succeeds, share the booking link so they can pick an appointment time.
4. If you cannot help, tell them "I'll have someone follow up with you shortly" and
   call the "request_human_followup" tool.

Rules:
- Keep replies short and text-message friendly: 1-3 short sentences.
- Ask for only one or two pieces of information at a time — do not interrogate.
- Never invent prices, availability, medical or professional advice, or policies.
- Stay on topic: you represent ${tenant.business_name} only.`;
}

const tools = [
  {
    type: 'function',
    function: {
      name: 'capture_lead',
      description:
        "Record a qualified lead once you have the customer's name, a contact method, and the service they need.",
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: "Customer's name" },
          contact: { type: 'string', description: 'Phone number or email address' },
          service: { type: 'string', description: 'Service or help the customer needs' },
          notes: { type: 'string', description: 'Any other relevant detail' },
        },
        required: ['name', 'contact', 'service'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'request_human_followup',
      description: 'Use when you cannot answer the customer or they need a human.',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Why a human is needed' },
          customer_question: { type: 'string', description: "The customer's question or request" },
        },
        required: ['reason'],
      },
    },
  },
];

async function runTool(call, tenant, conversation, customerPhone) {
  let args = {};
  try {
    args = JSON.parse(call.function.arguments || '{}');
  } catch (err) {
    console.error('[ai] failed to parse tool arguments:', err.message);
  }

  if (call.function.name === 'capture_lead') {
    const contact = args.contact || customerPhone || null;
    const notes = [contact ? `Contact: ${contact}` : null, args.notes]
      .filter(Boolean)
      .join(' — ');
    await supabase.from('leads').insert({
      tenant_id: tenant.id,
      conversation_id: conversation.id,
      customer_phone: customerPhone,
      customer_name: args.name || null,
      service_interest: args.service || null,
      notes: notes || null,
      status: 'qualified',
    });
    // Notify the tenant owner.
    const notifyTo = tenant.voicemail_email || tenant.owner_email;
    if (notifyTo) {
      await sendEmail({
        to: notifyTo,
        subject: `New lead — ${args.name || 'Unknown'} — ${tenant.business_name}`,
        html: `<p><strong>Name:</strong> ${args.name || '—'}</p>
<p><strong>Phone:</strong> ${customerPhone || '—'}</p>
<p><strong>Contact provided:</strong> ${contact || '—'}</p>
<p><strong>Service:</strong> ${args.service || '—'}</p>
<p><strong>Notes:</strong> ${args.notes || '—'}</p>`,
        text: `New lead for ${tenant.business_name}\nName: ${args.name || '—'}\nPhone: ${customerPhone || '—'}\nService: ${args.service || '—'}\nNotes: ${args.notes || '—'}`,
      });
    }
    return `Lead recorded. Now share the booking link with the customer: ${
      tenant.calendly_link || '(no booking link configured)'
    }`;
  }

  if (call.function.name === 'request_human_followup') {
    const notes = [args.reason, args.customer_question].filter(Boolean).join(' — ');
    await supabase.from('leads').insert({
      tenant_id: tenant.id,
      conversation_id: conversation.id,
      customer_phone: customerPhone,
      service_interest: 'Human follow-up requested',
      notes: notes || null,
      status: 'new',
    });
    return 'The owner has been notified and will follow up. Tell the customer someone will reach out shortly.';
  }

  return 'Unknown tool.';
}

function completion(model, messages) {
  return openaiClient().chat.completions.create({
    model,
    messages,
    tools,
    temperature: 0.5,
    max_tokens: 300,
  });
}

// Handle one inbound SMS for a tenant. Persists the inbound + outbound turns to
// the transcript and returns the reply text to send back to the customer.
async function handleMessage(tenant, conversation, customerPhone, userText, opts = {}) {
  const history = await loadTranscript(conversation.id);
  const messages = [
    { role: 'system', content: buildSystemPrompt(tenant, { channel: opts.channel, callerPhone: customerPhone }) },
    ...history,
    { role: 'user', content: userText },
  ];

  const model = opts.model || tenant.ai_model || 'gpt-4o';
  let promptTokens = 0;
  let completionTokens = 0;
  const tally = (r) => {
    if (!r.usage) return;
    promptTokens += r.usage.prompt_tokens || 0;
    completionTokens += r.usage.completion_tokens || 0;
  };

  let response = await completion(model, messages);
  tally(response);
  let message = response.choices[0].message;

  // Resolve tool calls, then let the model produce its final reply. Bounded so
  // a misbehaving model can never loop forever.
  let rounds = 0;
  while (message.tool_calls && message.tool_calls.length && rounds < MAX_TOOL_ROUNDS) {
    messages.push(message);
    for (const call of message.tool_calls) {
      const result = await runTool(call, tenant, conversation, customerPhone);
      messages.push({ role: 'tool', tool_call_id: call.id, content: result });
    }
    response = await completion(model, messages);
    tally(response);
    message = response.choices[0].message;
    rounds += 1;
  }

  const reply =
    (message.content && message.content.trim()) ||
    `Thanks for contacting ${tenant.business_name}! I'll have someone follow up with you shortly.`;

  const costCents = estimateOpenaiCostCents(promptTokens, completionTokens);

  await appendMessage(conversation, { direction: 'inbound', role: 'user', body: userText });
  await appendMessage(conversation, {
    direction: 'outbound',
    role: 'assistant',
    body: reply,
    tokens: promptTokens + completionTokens,
    costCents,
  });

  // Track AI spend against the tenant's monthly cap.
  try {
    await recordUsage(tenant.id, { openaiCostCents: costCents });
  } catch (err) {
    console.error('[ai] recordUsage failed:', err.message);
  }

  return reply;
}

module.exports = { handleMessage, buildSystemPrompt };
