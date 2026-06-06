// Chat-based onboarding wizard backend.
//
// Drives a conversational setup flow: the client sends the message history,
// Claude replies with the next question AND silently extracts structured fields.
// When all required data is collected, Claude returns done:true + a profile
// object the frontend uses to confirm before calling POST /onboarding/business.
//
//   POST /onboarding/chat   { messages: [{role, content}] }
//     -> { message: string, done: false }          — next question
//     -> { message: string, done: true, profile }  — ready to confirm

const express = require('express');
const OpenAI = require('openai');
const { requireAuth } = require('../lib/auth');
const logger = require('../lib/logger');

const router = express.Router();
router.use(requireAuth);

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SYSTEM = `You are a friendly AI assistant helping a new business owner set up their AI receptionist on SoCal Receptionist.

Your job: have a natural, conversational back-and-forth to collect the following information:
1. business_name (required) — the business's full name
2. business_type — what kind of business (dental office, plumbing, salon, law firm, etc.)
3. business_hours — days and hours they're open, including any lunch breaks
4. business_services — what services they offer (brief list)
5. calendly_link — their Calendly or booking link (optional, skip if they don't have one)
6. staff_phone — the phone number to transfer callers to when they want a human (required)
7. voicemail_email — email address for missed call/voicemail alerts (optional)
8. timezone — their timezone (default America/Los_Angeles if they're in SoCal; only ask if unclear)

Rules:
- Ask ONE question at a time. Keep it short and warm.
- Parse natural answers — "Mon to Fri 9 to 5" is valid hours, don't ask for a specific format.
- When you have enough information for all required fields (business_name and staff_phone at minimum), output your response in this EXACT JSON format on its own line at the end of your message:

PROFILE_JSON:{"done":true,"message":"<your final friendly message confirming you have everything>","profile":{"business_name":"...","business_hours":"Monday: 9:00 AM – 5:00 PM\nTuesday: 9:00 AM – 5:00 PM\n...","business_services":"...","business_type":"...","calendly_link":"...","staff_phone":"...","voicemail_email":"...","timezone":"America/Los_Angeles"}}

- For business_hours in the profile, format it as one day per line: "Monday: 9:00 AM – 5:00 PM" or "Saturday: Closed".
- If an optional field wasn't provided, use null for its value.
- Until you have all required info, just respond conversationally — no JSON.
- Start by greeting them and asking for their business name.`;

// Limits that prevent cost-amplification attacks on the AI endpoint.
const MAX_CHAT_MESSAGES = 40;        // conversation history depth cap
const MAX_MESSAGE_CHARS  = 2000;     // per-message content length cap

router.post('/chat', async (req, res) => {
  const { messages } = req.body;
  if (!Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array required' });
  }
  if (messages.length > MAX_CHAT_MESSAGES) {
    return res.status(400).json({ error: `too many messages (max ${MAX_CHAT_MESSAGES})` });
  }

  // Validate and sanitize each message — only known roles, string content, length cap.
  const ALLOWED_ROLES = new Set(['user', 'assistant']);
  const sanitized = [];
  for (const m of messages) {
    if (!ALLOWED_ROLES.has(m.role)) {
      return res.status(400).json({ error: `invalid message role: ${m.role}` });
    }
    if (typeof m.content !== 'string') {
      return res.status(400).json({ error: 'message content must be a string' });
    }
    if (m.content.length > MAX_MESSAGE_CHARS) {
      return res.status(400).json({ error: `message content exceeds ${MAX_MESSAGE_CHARS} characters` });
    }
    sanitized.push({ role: m.role, content: m.content });
  }

  try {
    const response = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 1024,
      messages: [{ role: 'system', content: SYSTEM }, ...sanitized],
    });

    const text = response.choices[0]?.message?.content || '';

    // Check if the model included the profile JSON marker.
    const markerIdx = text.indexOf('PROFILE_JSON:');
    if (markerIdx !== -1) {
      try {
        const jsonStr = text.slice(markerIdx + 'PROFILE_JSON:'.length).trim();
        const parsed = JSON.parse(jsonStr);
        return res.json({ message: parsed.message, done: true, profile: parsed.profile });
      } catch (e) {
        logger.warn('chat.parse_profile_failed', { error: e.message });
      }
    }

    res.json({ message: text, done: false });
  } catch (err) {
    logger.error('chat.openai_error', { error: err.message });
    res.status(500).json({ error: 'Could not reach AI. Please try again.' });
  }
});

module.exports = router;
