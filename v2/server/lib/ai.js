// Multi-tenant AI receptionist — v3 routing:
//   SMS / text channels  → Groq (llama-3.3-70b-versatile, near-zero cost)
//   Voice calls          → OpenAI gpt-4o (lower latency for speech turn-around)

const OpenAI = require('openai');
const Groq = require('groq-sdk');
const { supabase } = require('./supabase');
const { loadTranscript, appendMessage } = require('./conversations');
const { recordUsage, estimateOpenaiCostCents } = require('./usage');

// Lazy singletons — SDKs throw if the key is missing at import time.
let _openai;
let _groq;

function openaiClient() {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}

function groqClient() {
  if (!_groq) _groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  return _groq;
}

const MAX_TOOL_ROUNDS = 3;

// Default models per channel. Override per-tenant via ai_model column.
const DEFAULT_VOICE_MODEL = 'gpt-4o';
const DEFAULT_SMS_MODEL = 'llama-3.3-70b-versatile';

function buildSystemPrompt(tenant) {
  if (tenant.ai_system_prompt) return tenant.ai_system_prompt;
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
    const notes = [args.contact ? `Contact: ${args.contact}` : null, args.notes]
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

// channel: 'sms' (default) → Groq | 'voice' → OpenAI
function completion(model, messages, channel) {
  if (channel === 'voice') {
    return openaiClient().chat.completions.create({
      model,
      messages,
      tools,
      temperature: 0.5,
      max_tokens: 300,
    });
  }
  // Groq — OpenAI-compatible SDK so response shape is identical
  return groqClient().chat.completions.create({
    model,
    messages,
    tools,
    temperature: 0.5,
    max_tokens: 300,
  });
}

// Handle one inbound message (SMS or voice turn).
// channel: 'sms' | 'voice'
async function handleMessage(tenant, conversation, customerPhone, userText, channel = 'sms') {
  const history = await loadTranscript(conversation.id);
  const messages = [
    { role: 'system', content: buildSystemPrompt(tenant) },
    ...history,
    { role: 'user', content: userText },
  ];

  const defaultModel = channel === 'voice' ? DEFAULT_VOICE_MODEL : DEFAULT_SMS_MODEL;
  const model = tenant.ai_model || defaultModel;

  let promptTokens = 0;
  let completionTokens = 0;
  const tally = (r) => {
    if (!r.usage) return;
    promptTokens += r.usage.prompt_tokens || 0;
    completionTokens += r.usage.completion_tokens || 0;
  };

  let response = await completion(model, messages, channel);
  tally(response);
  let message = response.choices[0].message;

  let rounds = 0;
  while (message.tool_calls && message.tool_calls.length && rounds < MAX_TOOL_ROUNDS) {
    messages.push(message);
    for (const call of message.tool_calls) {
      const result = await runTool(call, tenant, conversation, customerPhone);
      messages.push({ role: 'tool', tool_call_id: call.id, content: result });
    }
    response = await completion(model, messages, channel);
    tally(response);
    message = response.choices[0].message;
    rounds += 1;
  }

  const reply =
    (message.content && message.content.trim()) ||
    `Thanks for contacting ${tenant.business_name}! I'll have someone follow up with you shortly.`;

  const costCents = channel === 'voice' ? estimateOpenaiCostCents(promptTokens, completionTokens) : 0;

  await appendMessage(conversation, { direction: 'inbound', role: 'user', body: userText });
  await appendMessage(conversation, {
    direction: 'outbound',
    role: 'assistant',
    body: reply,
    tokens: promptTokens + completionTokens,
    costCents,
  });

  try {
    await recordUsage(tenant.id, { openaiCostCents: costCents });
  } catch (err) {
    console.error('[ai] recordUsage failed:', err.message);
  }

  return reply;
}

module.exports = { handleMessage, buildSystemPrompt };
