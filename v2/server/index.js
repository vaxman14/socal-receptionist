// SoCal Receptionist V2 — backend web service entry point.
//
// Hosts the Twilio SMS webhook. Kept as a dedicated Node service (not Netlify
// Functions) so the latency-sensitive /sms path has no cold starts — Codex
// review #3. The provisioning worker can run in-process (RUN_WORKER=true) for
// single-dyno deployments, or as its own process via run-worker.js.

require('dotenv').config();

// Sentry must init before any other requires so it can instrument them
if (process.env.SENTRY_DSN) {
  const Sentry = require('@sentry/node');
  Sentry.init({ dsn: process.env.SENTRY_DSN });
}

if (process.env.NODE_ENV === 'production') {
  const required = [
    'SUPABASE_URL', 'SUPABASE_SERVICE_KEY',
    'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN',
    'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET',
    'APP_BASE_URL',
  ];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) throw new Error(`Missing required env vars: ${missing.join(', ')}`);
}

const path = require('path');
const express = require('express');
const cors = require('cors');
const smsRouter = require('./sms/webhook');
const voiceRouter = require('./voice/webhook');
const billingWebhookRouter = require('./billing/webhook');
const clientAdminRouter = require('./admin/client');
const ownerAdminRouter = require('./admin/owner');
const voicePreviewRouter = require('./admin/voice-preview');
const onboardingAgreementRouter = require('./onboarding/agreement');
const onboardingRegisterRouter = require('./onboarding/register');
const mfaRouter = require('./auth/mfa');

const app = express();
app.set('trust proxy', true); // behind the DigitalOcean / Cloudflare proxy

// Redirect naked domain → www
app.use((req, res, next) => {
  if (req.hostname === 'socalreceptionist.com') {
    return res.redirect(301, `https://www.socalreceptionist.com${req.originalUrl}`);
  }
  next();
});

// The browser SPA (admin + onboarding wizard) is served from a separate origin
// (Netlify / app.socalreceptionist.com), so its API calls are cross-origin and
// need CORS. Auth is bearer-token (Supabase access_token), not cookies, so
// reflecting any origin is safe — tighten to APP_BASE_URL post-launch if wanted.
app.use(cors());

// The Stripe webhook needs the raw request body for signature verification, so
// it is mounted BEFORE the JSON/urlencoded parsers. Its route applies its own
// express.raw; all other requests fall through to the parsers below.
app.use('/', billingWebhookRouter);

app.use(express.urlencoded({ extended: false })); // Twilio posts form-encoded
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'socal-receptionist-v2', ts: new Date().toISOString() });
});

app.use('/', smsRouter);
app.use('/', voiceRouter);

// Onboarding API — business registration, then service-agreement e-signature
// (which gates provisioning). Register is mounted first; both share /onboarding.
app.use('/onboarding', onboardingRegisterRouter);
app.use('/onboarding', onboardingAgreementRouter);

// MFA API — trusted-device ("trust this device for 30 days") issue / verify /
// revoke. The TOTP + passkey factors themselves are handled by Supabase Auth
// directly from the browser; this only owns the app-side trust ledger.
app.use('/auth/mfa', mfaRouter);

// Admin API. The owner router is mounted first so /admin/owner/* never falls
// into the client router's requireTenant middleware.
app.use('/admin/owner', ownerAdminRouter);
app.use('/admin', voicePreviewRouter);
app.use('/admin', clientAdminRouter);

// Legal pages (privacy, terms, etc.)
app.use('/', require('./legal'));

// Support chat widget (used by marketing site)
const SUPPORT_SYSTEM_PROMPT = `You are a friendly and helpful support agent for SoCal Receptionist — an AI-powered virtual receptionist service for small businesses in Southern California (Temecula Valley area).

Your job is to answer questions from website visitors about the product, pricing, and how it works, and to help existing clients with support issues.

Key facts:
- SoCal Receptionist handles incoming calls and SMS for small businesses 24/7
- The AI qualifies leads, answers FAQs, and books appointments automatically
- Powered by advanced AI (OpenAI + Twilio)
- Serves businesses in Temecula, Murrieta, Menifee, and surrounding SoCal areas

Pricing:
- Essentials Plan: $500/month (no setup fee) — AI answers calls/SMS, qualifies leads, books appointments
- Concierge Plan: $500/month + $1,500 one-time setup fee — full white-glove setup and customization
- Annual pricing: $4,800/year (saves ~2 months vs monthly)
- +$99 per 50 extra calls beyond your plan's included volume

Getting started:
- Sign up at app.socalreceptionist.com or call (951) 395-8776 to talk to the AI live
- Setup takes minutes for self-serve, or a few days for Concierge with full customization

For support issues (existing clients):
- Collect their business name and issue description
- If you cannot resolve it, tell them to email support@socalreceptionist.com and that one of our team members will get back to them within 24 hours
- For urgent issues, they can call (951) 395-8776

IMPORTANT: Never use personal names (like "Roman") in your responses. Always refer to the team generically — "a team member", "our team", "someone from our team". Do not mention texting or SMS as a contact option — phone calls only.

Be concise (2-4 sentences per reply), warm, and direct. Don't use bullet lists unless explaining pricing. If someone asks something you don't know, offer to connect them with support@socalreceptionist.com. Never make up facts about the product.`;

app.post('/api/support/chat', express.json(), async (req, res) => {
  const { message, history = [] } = req.body;
  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'Message required' });
  }
  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) {
    return res.json({ reply: "Hi! I'm the SoCal Receptionist support bot. Our team is setting up the AI chat — in the meantime, email us at support@socalreceptionist.com or call (951) 395-8776!" });
  }
  const safeHistory = Array.isArray(history)
    ? history.slice(-10).map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content).slice(0, 2000) }))
    : [];
  const messages = [...safeHistory, { role: 'user', content: message.trim().slice(0, 2000) }];
  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${groqKey}` },
      body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: [{ role: 'system', content: SUPPORT_SYSTEM_PROMPT }, ...messages], max_tokens: 400, temperature: 0.65 }),
    });
    if (!response.ok) throw new Error(`Groq ${response.status}`);
    const data = await response.json();
    res.json({ reply: data.choices[0].message.content.trim() });
  } catch (err) {
    console.error('Support chat error:', err.message);
    res.status(500).json({ error: 'Something went wrong. Please email support@socalreceptionist.com.' });
  }
});

app.post('/api/support/end', express.json(), (req, res) => res.json({ ok: true }));

// Serve the landing page (public/) and the React SPA (web/dist/).
// API routes above take priority; everything else falls through to the SPA.
const publicDir = path.join(__dirname, '../../public');
const spaDir = path.join(__dirname, '../web/dist');

app.use(express.static(publicDir));
app.use(express.static(spaDir));

// SPA fallback for /login, /signup, /dashboard, /app/* etc.
const spaIndex = path.join(spaDir, 'index.html');
const fs = require('fs');
app.get(/^\/(login|signup|dashboard|app|settings|clients|onboarding-wizard)/, (req, res) => {
  if (fs.existsSync(spaIndex)) {
    res.sendFile(spaIndex);
  } else {
    res.status(503).send('App not built yet');
  }
});

// Sentry error handler — must come after all routes, before other error handlers
if (process.env.SENTRY_DSN) {
  const Sentry = require('@sentry/node');
  Sentry.setupExpressErrorHandler(app);
}

const port = Number(process.env.PORT) || 8080;
app.listen(port, () => {
  console.log(`[v2] SMS service listening on :${port}`);
});

if (process.env.RUN_WORKER === 'true') {
  require('./provisioning/run-worker');
}
