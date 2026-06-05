// SoCal Receptionist V2 — backend web service entry point.
//
// Hosts the Twilio SMS webhook. Kept as a dedicated Node service (not Netlify
// Functions) so the latency-sensitive /sms path has no cold starts — Codex
// review #3. The provisioning worker can run in-process (RUN_WORKER=true) for
// single-dyno deployments, or as its own process via run-worker.js.

require('dotenv').config();

// Sentry must init before anything else so it can instrument all requires.
const Sentry = require('@sentry/node');
if (process.env.SENTRY_DSN) {
  Sentry.init({ dsn: process.env.SENTRY_DSN, tracesSampleRate: 0.1 });
}

const path = require('path');
const express = require('express');
const expressWs = require('express-ws');
const cors = require('cors');
const smsRouter = require('./sms/webhook');
const voiceRouter = require('./voice/webhook');
const billingWebhookRouter = require('./billing/webhook');
const clientAdminRouter = require('./admin/client');
const ownerAdminRouter = require('./admin/owner');
const onboardingAgreementRouter = require('./onboarding/agreement');
const onboardingRegisterRouter = require('./onboarding/register');
const onboardingNumbersRouter = require('./onboarding/numbers');
const onboardingChatRouter = require('./onboarding/chat');
const mfaRouter = require('./auth/mfa');

const app = express();
expressWs(app); // enable app.ws() for WebSocket routes
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

// Internal: poll Gmail inboxes for new messages since ?since=<epochMs>
// Used by Josi's gmail-monitor cron to alert Roman of new emails.
app.get('/internal/gmail-check', async (req, res) => {
  const secret = process.env.INTERNAL_SECRET;
  if (!secret || req.query.token !== secret) return res.status(401).json({ error: 'unauthorized' });

  const sinceMs = parseInt(req.query.since || '0', 10) || (Date.now() - 6 * 60 * 1000);
  const afterSec = Math.floor(sinceMs / 1000);

  const ACCOUNTS = [
    { name: 'info',    email: 'info@socalreceptionist.com',    refreshToken: process.env.GOOGLE_REFRESH_TOKEN_INFO },
    { name: 'support', email: 'support@socalreceptionist.com', refreshToken: process.env.GOOGLE_REFRESH_TOKEN_SUPPORT },
  ];

  const messages = [];
  for (const account of ACCOUNTS) {
    if (!account.refreshToken) continue;
    try {
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: process.env.GOOGLE_CLIENT_ID,
          client_secret: process.env.GOOGLE_CLIENT_SECRET,
          refresh_token: account.refreshToken,
          grant_type: 'refresh_token',
        }),
      });
      const { access_token } = await tokenRes.json();
      if (!access_token) continue;

      const listRes = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=-in:trash+after:${afterSec}&maxResults=20`,
        { headers: { Authorization: `Bearer ${access_token}` } }
      );
      const listData = await listRes.json();
      for (const { id } of (listData.messages || [])) {
        const msgRes = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
          { headers: { Authorization: `Bearer ${access_token}` } }
        );
        const msg = await msgRes.json();
        const headers = {};
        for (const h of (msg.payload?.headers || [])) headers[h.name] = h.value;
        messages.push({
          id: msg.id,
          account: account.name,
          from: headers['From'] || '',
          subject: headers['Subject'] || '(no subject)',
          date: headers['Date'] || '',
          internalDate: parseInt(msg.internalDate || '0'),
        });
      }
    } catch (err) {
      console.error(`[gmail-monitor] error reading ${account.name}: ${err.message}`);
    }
  }

  messages.sort((a, b) => a.internalDate - b.internalDate);
  res.json({ ok: true, count: messages.length, messages });
});

// Public voice preview — no auth required (sample phrase only, cached per process).
const OpenAI = require('openai');
const POLLY_TO_OPENAI_PUBLIC = {
  'Polly.Joanna-Neural': 'nova',
  'Polly.Salli-Neural':  'nova',
  'Polly.Matthew-Neural': 'echo',
  'Polly.Joey-Neural':   'echo',
  'Polly.Amy-Neural':    'shimmer',
  'Polly.Brian-Neural':  'onyx',
};
const _voicePreviewCache = new Map();
app.get('/voice/preview', async (req, res) => {
  const voiceId = req.query.voice || 'Polly.Joanna-Neural';
  // Reject voices not in the allowlist — unknown IDs map to the same cached value
  // anyway, but rejecting them prevents probing and makes intent explicit.
  if (!Object.prototype.hasOwnProperty.call(POLLY_TO_OPENAI_PUBLIC, voiceId)) {
    return res.status(400).json({ error: 'unknown voice' });
  }
  const oaiVoice = POLLY_TO_OPENAI_PUBLIC[voiceId];
  if (_voicePreviewCache.has(oaiVoice)) {
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.send(_voicePreviewCache.get(oaiVoice));
  }
  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const mp3 = await openai.audio.speech.create({
      model: 'tts-1',
      input: 'Thank you for calling. How can I help you today?',
      voice: oaiVoice,
      speed: 0.95,
    });
    const buf = Buffer.from(await mp3.arrayBuffer());
    _voicePreviewCache.set(oaiVoice, buf);
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(buf);
  } catch (err) {
    // Do not leak upstream error details (quota info, key validity, etc.)
    console.error('[voice/preview]', err.message);
    res.status(500).json({ error: 'voice preview unavailable' });
  }
});

app.use('/', smsRouter);
app.use('/', voiceRouter);

// OpenAI Realtime WebSocket endpoint — Twilio Media Stream connects here.
const { handleMediaStream } = require('./voice/realtime');
app.ws('/voice/stream', handleMediaStream);

// Onboarding API — business registration, then service-agreement e-signature
// (which gates provisioning). Register is mounted first; both share /onboarding.
app.use('/onboarding', onboardingRegisterRouter);
app.use('/onboarding', onboardingAgreementRouter);
app.use('/onboarding', onboardingNumbersRouter);
app.use('/onboarding', onboardingChatRouter);

// MFA API — trusted-device ("trust this device for 30 days") issue / verify /
// revoke. The TOTP + passkey factors themselves are handled by Supabase Auth
// directly from the browser; this only owns the app-side trust ledger.
app.use('/auth/mfa', mfaRouter);

// Admin API. The owner router is mounted first so /admin/owner/* never falls
// into the client router's requireTenant middleware.
app.use('/admin/owner', ownerAdminRouter);
app.use('/admin', clientAdminRouter);

// Serve the landing page (public/) and the React SPA (web/dist/).
// API routes above take priority; everything else falls through to the SPA.
const publicDir = path.join(__dirname, '../../public');
const spaDir = path.join(__dirname, '../web/dist');

app.use(express.static(publicDir));
app.use(express.static(spaDir));

// SPA fallback for /login, /signup, /dashboard, /app/*, /register, /welcome etc.
const spaIndex = path.join(spaDir, 'index.html');
const fs = require('fs');
app.get(/^\/(login|signup|dashboard|app|settings|clients|onboarding-wizard|register|welcome)/, (req, res) => {
  if (fs.existsSync(spaIndex)) {
    res.sendFile(spaIndex);
  } else {
    res.status(503).send('App not built yet');
  }
});

// Sentry error handler — must come after all routes, before other error handlers.
if (process.env.SENTRY_DSN) {
  Sentry.setupExpressErrorHandler(app);
}

const port = Number(process.env.PORT) || 8080;
app.listen(port, () => {
  console.log(`[v2] SMS service listening on :${port}`);
});

if (process.env.RUN_WORKER === 'true') {
  require('./provisioning/run-worker');
}
