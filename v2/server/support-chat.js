// Support chat endpoint — powers the floating chat widget on the web app.
// Uses Groq (OpenAI-compatible, free) for AI responses.
// Emails full conversation transcripts to support@ via Resend when session ends.

const express = require('express');
const router = express.Router();

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const SUPPORT_EMAIL = 'support@socalreceptionist.com';

const SYSTEM_PROMPT = `You are a friendly, helpful support agent for SoCal Receptionist — an AI-powered virtual receptionist service for small businesses in Southern California.

Your job is to help clients and prospective customers with questions. Be warm, concise, and professional. Don't be overly formal.

About SoCal Receptionist:
- We provide an AI-powered phone receptionist that answers calls 24/7 for small businesses
- The AI greets callers, answers common questions, qualifies leads, and books appointments
- We serve businesses in Southern California: dental offices, law firms, med spas, home services, and more

Pricing:
- Essentials Plan: $500/month — AI phone answering, lead capture, FAQ handling, appointment scheduling. No setup fee.
- Concierge Plan: $1,500 setup fee (one-time, non-refundable) + $500/month — everything in Essentials plus white-glove onboarding, custom call scripts, dedicated support
- Annual option: $4,800/year (save $1,200 — 2 months free)
- Additional calls: +$99 per 50 calls/month

How to get started:
- Sign up at app.socalreceptionist.com — takes about 5 minutes

CALLBACK REQUESTS — VERY IMPORTANT:
When someone asks to be called back, speak to someone, or requests human contact:
1. Ask for their name
2. Ask for their phone number
3. Once you have both, confirm: "Got it! I'll have Roman reach out to you shortly."
4. End your reply with this exact tag on its own line: [CALLBACK_LEAD: name="<their name>" phone="<their phone>"]
Do NOT tell them to email support. Collect the info yourself right here in chat.

If you can't answer something confidently, say so honestly and offer to have someone call them back (then collect name + phone as above). Never make up pricing, features, or timelines.

Keep responses short and helpful — this is a chat widget, not an essay. 2-4 sentences max unless the user clearly wants more detail.`;

async function getAIResponse(messages) {
  if (!GROQ_API_KEY) {
    return "Hi! Our support chat is setting up. In the meantime, email us at support@socalreceptionist.com and we'll get back to you shortly.";
  }

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GROQ_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages],
      max_tokens: 300,
      temperature: 0.6,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error('[support-chat] Groq error:', err);
    throw new Error('AI unavailable');
  }

  const data = await res.json();
  return data.choices[0].message.content.trim();
}

async function emailTranscript(sessionId, visitorInfo, messages) {
  if (!RESEND_API_KEY || messages.length < 2) return;

  const lines = messages
    .map(m => `${m.role === 'user' ? 'Visitor' : 'Support Bot'}: ${m.content}`)
    .join('\n\n');

  const body = `New support chat transcript\n\nSession: ${sessionId}\nVisitor: ${visitorInfo || 'Anonymous'}\nTime: ${new Date().toISOString()}\n\n---\n\n${lines}`;

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'SoCal Receptionist Support <onboarding@resend.dev>',
        to: [SUPPORT_EMAIL],
        subject: `Support chat transcript — ${new Date().toLocaleDateString()}`,
        text: body,
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error('[support-chat] Resend error:', err);
    }
  } catch (e) {
    console.error('[support-chat] Email failed:', e.message);
  }
}

async function emailCallbackLead(name, phone) {
  if (!RESEND_API_KEY) return;
  const body = `New callback request from website chat\n\nName: ${name}\nPhone: ${phone}\nTime: ${new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })} PT`;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'SoCal Receptionist <hello@noreply.socalreceptionist.com>',
      to: ['roman@socalreceptionist.com'],
      subject: `📞 Callback request — ${name}`,
      text: body,
    }),
  });
  if (!res.ok) console.error('[support-chat] callback email error:', await res.text());
  else console.log(`[support-chat] callback lead emailed: ${name} ${phone}`);
}

// POST /api/support-chat/message
// Body: { sessionId, message, history: [{role, content}] }
router.post('/message', async (req, res) => {
  const { sessionId, message, history = [], visitorInfo } = req.body;

  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'message required' });
  }

  const messages = [
    ...history.slice(-10), // cap context at 10 prior messages
    { role: 'user', content: message.slice(0, 2000) },
  ];

  try {
    const reply = await getAIResponse(messages);

    // Detect callback lead tag and fire email immediately
    const callbackMatch = reply.match(/\[CALLBACK_LEAD:\s*name="([^"]+)"\s*phone="([^"]+)"\]/);
    if (callbackMatch) {
      const [, name, phone] = callbackMatch;
      emailCallbackLead(name, phone).catch(e => console.error('[support-chat] callback email failed:', e.message));
    }

    // Strip the tag from the reply shown to the user
    const cleanReply = reply.replace(/\[CALLBACK_LEAD:[^\]]+\]/g, '').trim();
    return res.json({ reply: cleanReply });
  } catch (e) {
    console.error('[support-chat] Error:', e.message);
    return res.json({ reply: "Sorry, I'm having trouble right now. Try again in a moment!" });
  }
});

// POST /api/support-chat/end
// Called when the user closes the chat — sends email transcript.
// Body: { sessionId, history: [{role, content}], visitorInfo }
router.post('/end', async (req, res) => {
  const { sessionId, history = [], visitorInfo } = req.body;
  await emailTranscript(sessionId, visitorInfo, history);
  return res.json({ ok: true });
});

module.exports = router;
