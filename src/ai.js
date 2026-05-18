const OpenAI = require('openai');
const config = require('./config');
const store = require('./store');
const { notifyOwner } = require('./email');

const openai = new OpenAI({ apiKey: config.openai.apiKey });

const SYSTEM_PROMPT = `You are the virtual receptionist for ${config.business.name}.
You speak with customers over SMS text message. Be warm, friendly, professional, and concise.

Business details:
- Name: ${config.business.name}
- Hours: ${config.business.hours}
- Services: ${config.business.services}
- Booking link (Calendly): ${config.business.calendlyLink}

Your responsibilities:
1. Greet customers warmly and answer common questions about hours and services.
2. Qualify the lead: collect the customer's name, a contact method (phone or email),
   and the service they need.
3. Once you have name + contact + service, call the "capture_lead" tool. After it
   succeeds, share the Calendly booking link so they can pick an appointment time.
4. If you cannot answer a question, or the customer needs something beyond your
   scope, tell them "I'll have someone follow up with you shortly" and call the
   "request_human_followup" tool.

Rules:
- Keep replies short and text-message friendly: 1-3 short sentences.
- Ask for only one or two pieces of information at a time — do not interrogate.
- Never invent prices, availability, medical or professional advice, or policies.
- Always send the Calendly link via the tool flow, not from memory of past chats.
- Stay on topic: you represent ${config.business.name} only.`;

const tools = [
  {
    type: 'function',
    function: {
      name: 'capture_lead',
      description:
        'Record a qualified lead. Call this once you have collected the customer\'s name, a contact method (phone or email), and the service they need. This emails the business owner.',
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
      description:
        'Use when you cannot answer the customer or they need a human. This emails the business owner to follow up.',
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

async function runTool(call, fromNumber) {
  let args = {};
  try {
    args = JSON.parse(call.function.arguments || '{}');
  } catch (err) {
    console.error('Failed to parse tool arguments:', err.message);
  }

  if (call.function.name === 'capture_lead') {
    const body =
      `New lead captured by the ${config.business.name} AI receptionist.\n\n` +
      `Name:        ${args.name || '-'}\n` +
      `Contact:     ${args.contact || '-'}\n` +
      `SMS number:  ${fromNumber}\n` +
      `Service:     ${args.service || '-'}\n` +
      `Notes:       ${args.notes || '-'}\n\n` +
      `The customer was sent the Calendly booking link: ${config.business.calendlyLink}`;
    try {
      await notifyOwner(`New lead: ${args.name || 'Unknown'} — ${args.service || 'inquiry'}`, body);
    } catch (err) {
      console.error('Lead notification email failed:', err.message);
    }
    return `Lead recorded and the owner has been emailed. Now share the booking link with the customer: ${config.business.calendlyLink}`;
  }

  if (call.function.name === 'request_human_followup') {
    const body =
      `The AI receptionist for ${config.business.name} needs a human to follow up.\n\n` +
      `Customer SMS number: ${fromNumber}\n` +
      `Reason:              ${args.reason || '-'}\n` +
      `Customer question:   ${args.customer_question || '-'}`;
    try {
      await notifyOwner(`Follow-up needed — ${fromNumber}`, body);
    } catch (err) {
      console.error('Follow-up notification email failed:', err.message);
    }
    return 'The owner has been emailed and will follow up. Tell the customer someone will reach out to them shortly.';
  }

  return 'Unknown tool.';
}

async function complete(messages) {
  const response = await openai.chat.completions.create({
    model: config.openai.model,
    messages,
    tools,
    temperature: 0.5,
    max_tokens: 300,
  });
  return response.choices[0].message;
}

// Processes one inbound SMS and returns the text to send back to the customer.
async function handleMessage(fromNumber, userText) {
  const history = store.get(fromNumber);
  history.push({ role: 'user', content: userText });

  const messages = [{ role: 'system', content: SYSTEM_PROMPT }, ...history];

  let message = await complete(messages);

  // Resolve any tool calls (capture_lead / request_human_followup), then let
  // the model produce its final customer-facing reply. Cap the rounds so a
  // misbehaving model can never loop forever.
  let rounds = 0;
  while (message.tool_calls && message.tool_calls.length && rounds < 3) {
    messages.push(message);
    history.push(message);

    for (const call of message.tool_calls) {
      const result = await runTool(call, fromNumber);
      const toolMessage = { role: 'tool', tool_call_id: call.id, content: result };
      messages.push(toolMessage);
      history.push(toolMessage);
    }

    message = await complete(messages);
    rounds += 1;
  }

  const reply =
    (message.content && message.content.trim()) ||
    `Thanks for contacting ${config.business.name}! I'll have someone follow up with you shortly.`;

  history.push({ role: 'assistant', content: reply });
  store.set(fromNumber, history);

  return reply;
}

module.exports = { handleMessage };
