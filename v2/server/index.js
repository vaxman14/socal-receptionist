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
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
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
const integrationsRouter = require('./integrations/router');
const supportChatRouter = require('./support-chat');
const publicApiRouter = require('./api/public');
const apiAccessRouter = require('./admin/api-access');
const outboundAssistRouter = require('./voice/outbound-assist');
const { router: reminderRouter, start: startReminderPoller } = require('./voice/reminder-poller');

const app = express();
expressWs(app); // enable app.ws() for WebSocket routes
app.set('trust proxy', 1); // one proxy layer: DigitalOcean LB / Cloudflare

// Security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://js.stripe.com', 'https://cdn.jsdelivr.net'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: [
        "'self'",
        process.env.SUPABASE_URL || '',
        'https://*.supabase.co',
        'https://api.stripe.com',
        'https://app.posthog.com',
        'https://*.sentry.io',
      ].filter(Boolean),
      frameSrc: ["'none'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
    },
  },
}));

// Restrict CORS to known origins (issue #7)
const ALLOWED_ORIGINS = [
  process.env.APP_BASE_URL,
  'http://localhost:3000',
  'http://localhost:5173',
  'http://localhost:8080',
].filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // server-to-server / curl
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));

// Rate limiting for admin and onboarding routes (issue #11).
// Stores are Redis-backed when REDIS_URL is set (multi-instance safe),
// in-memory otherwise — see lib/ratelimit.makeLimiterStore.
const { makeLimiterStore } = require('./lib/ratelimit');
const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  store: makeLimiterStore('admin'),
  message: { error: 'Too many requests, please try again later.' },
});
const strictLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  store: makeLimiterStore('strict'),
  message: { error: 'Too many requests, please try again later.' },
});

// Redirect naked domain → www
app.use((req, res, next) => {
  if (req.hostname === 'socalreceptionist.com') {
    return res.redirect(301, `https://www.socalreceptionist.com${req.originalUrl}`);
  }
  next();
});

// The Stripe webhook needs the raw request body for signature verification, so
// it is mounted BEFORE the JSON/urlencoded parsers. Its route applies its own
// express.raw; all other requests fall through to the parsers below.
app.use('/', billingWebhookRouter);

app.use(express.urlencoded({ extended: false, limit: '50kb' })); // Twilio posts form-encoded
app.use(express.json({ limit: '100kb' }));

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
      const tokenData = await tokenRes.json();
      if (!tokenData.access_token) {
        console.error(`[gmail-monitor] token exchange failed for ${account.name}: ${JSON.stringify(tokenData)}`);
        continue;
      }
      const access_token = tokenData.access_token;

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
  res.json({ ok: true, count: messages.length, messages, sinceMs, afterSec });
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
app.use('/onboarding', strictLimiter, onboardingRegisterRouter);
app.use('/onboarding', onboardingAgreementRouter);
app.use('/onboarding', onboardingNumbersRouter);
app.use('/onboarding', onboardingChatRouter);

// MFA API — trusted-device ("trust this device for 30 days") issue / verify /
// revoke. The TOTP + passkey factors themselves are handled by Supabase Auth
// directly from the browser; this only owns the app-side trust ledger.
app.use('/auth/mfa', strictLimiter, mfaRouter);

// Support chat — public (pre-auth visitors use it), so it gets the strict limiter.
app.use('/api/support-chat', strictLimiter, supportChatRouter);


// Public REST API v1 — API-key auth, tenant-scoped (db/012).
app.use('/api/v1', adminLimiter, publicApiRouter);

// Admin API. The owner router is mounted first so /admin/owner/* never falls
// into the client router's requireTenant middleware.
app.use('/admin/owner', adminLimiter, ownerAdminRouter);
app.use('/admin', adminLimiter, apiAccessRouter);
app.use('/admin', adminLimiter, clientAdminRouter);
app.use('/integrations', adminLimiter, integrationsRouter);

// Outbound Call Assist + Proactive Reminder webhooks (Twilio, rate-limited).
app.use(outboundAssistRouter);
app.use(reminderRouter);

// Legal pages
function legalPage(title, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} — SoCal Receptionist</title>
  <style>
    *{box-sizing:border-box}
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;max-width:720px;margin:0 auto;padding:40px 24px;color:#1a1a2e;line-height:1.7;background:#fff}
    a{color:#4f46e5}
    h1{font-size:1.6rem;font-weight:700;margin-bottom:.25rem}
    h2{font-size:1.1rem;font-weight:600;margin-top:2.5rem;margin-bottom:.5rem;color:#4f46e5}
    h3{font-size:1rem;font-weight:600;margin-top:1.5rem;margin-bottom:.4rem}
    p,li{font-size:.95rem;color:#374151}
    ul{padding-left:1.4rem}
    nav{margin-bottom:2rem;font-size:.85rem}
    nav a{margin-right:1rem;color:#6b7280;text-decoration:none}
    nav a:hover{color:#4f46e5}
    .meta{margin-top:3rem;padding-top:1rem;border-top:1px solid #e5e7eb;font-size:.8rem;color:#9ca3af}
  </style>
</head>
<body>
  <nav>
    <a href="/">← Home</a>
    <a href="/privacy">Privacy Policy</a>
    <a href="/terms">Terms of Use</a>
    <a href="/sms-terms">SMS Terms</a>
    <a href="/cookies">Cookie Policy</a>
    <a href="/accessibility">Accessibility</a>
  </nav>
  ${bodyHtml}
  <div class="meta">SoCal Receptionist &nbsp;·&nbsp; Murrieta, CA &nbsp;·&nbsp; <a href="mailto:info@socalreceptionist.com">Contact</a></div>
</body>
</html>`;
}

app.get('/privacy', (req, res) => {
  res.type('text/html').send(legalPage('Privacy Policy', `
  <h1>Privacy Policy</h1>
  <p>Last updated: June 2026</p>
  <p><strong>SoCal Receptionist</strong> ("we," "us," or "our") operates an AI-powered virtual receptionist service delivered via SMS text messaging to small businesses in Southern California. This Privacy Policy describes how we collect, use, disclose, and protect information when you interact with our SMS service or visit our website at <a href="https://www.socalreceptionist.com">www.socalreceptionist.com</a>.</p>

  <h2>SMS Text Messaging Program</h2>
  <p>SoCal Receptionist operates an SMS text messaging program that allows customers to communicate with participating businesses via automated AI-generated text messages. By texting a participating business's dedicated phone number, you agree to receive automated text messages in response.</p>

  <h3>How You Opt In</h3>
  <p>You opt in to our SMS program by texting a participating business's SoCal Receptionist number. Your first inbound text message to that number constitutes your explicit opt-in consent to receive AI-generated SMS replies. No unsolicited outbound messages are ever sent — this is a 100% inbound, consumer-initiated service.</p>

  <h3>Message Frequency</h3>
  <p>Message frequency varies based on your inquiries. Typically 1–5 messages per conversation session. Recurring messages may apply while your inquiry is active.</p>

  <h3>Message &amp; Data Rates</h3>
  <p><strong>Msg &amp; Data Rates May Apply.</strong> Standard message and data rates may apply depending on your mobile carrier and plan. Contact your carrier for details.</p>

  <h3>How to Opt Out (STOP)</h3>
  <p>You may opt out of receiving SMS messages from us at any time by replying <strong>STOP</strong>, <strong>CANCEL</strong>, <strong>END</strong>, <strong>QUIT</strong>, or <strong>UNSUBSCRIBE</strong> to any message. You will receive a single confirmation message and no further messages will be sent to your number.</p>

  <h3>How to Get Help (HELP)</h3>
  <p>Reply <strong>HELP</strong> to any message to receive support information. You may also contact us at <a href="mailto:info@socalreceptionist.com">info@socalreceptionist.com</a> or visit <a href="https://www.socalreceptionist.com/sms-terms">www.socalreceptionist.com/sms-terms</a> for full SMS Terms &amp; Conditions.</p>

  <h3>Supported Carriers</h3>
  <p>Supported carriers include AT&amp;T, T-Mobile, Verizon, and most major U.S. carriers. Carrier support for text programs is not guaranteed.</p>

  <h2>Information We Collect</h2>
  <ul>
    <li><strong>Phone number</strong> — collected when you initiate a text conversation with a business using our service.</li>
    <li><strong>Message content</strong> — the text messages you send are processed to generate a response. Message content is not stored permanently after the session ends.</li>
    <li><strong>Consent status</strong> — we record your opt-in and opt-out status to maintain compliance with applicable regulations.</li>
    <li><strong>Website usage data</strong> — if you visit our website, we may collect standard web log data such as IP address and browser type.</li>
  </ul>

  <h2>How We Use Your Information</h2>
  <ul>
    <li>To respond to your SMS inquiries and connect you with the participating business</li>
    <li>To maintain opt-in and opt-out compliance records</li>
    <li>To improve service quality</li>
    <li>To comply with legal obligations</li>
  </ul>
  <p>We do <strong>not</strong> sell, rent, or share your personal information or phone number with third parties for marketing purposes. <strong>Mobile information and messaging opt-in data and consent are not shared with any third parties or affiliates for marketing or promotional purposes.</strong> Your phone number will not be shared with any third party for their own marketing use.</p>

  <h2>Data Retention</h2>
  <p>Opt-in and opt-out consent records are retained for compliance purposes as required by law. Conversation content is processed in real time and is not stored permanently after the session concludes.</p>

  <h2>Third-Party Services</h2>
  <p>We use Twilio for SMS delivery and OpenAI for AI-generated responses. Both services process message content under their own privacy policies:</p>
  <ul>
    <li>Twilio: <a href="https://www.twilio.com/legal/privacy" target="_blank" rel="noopener">twilio.com/legal/privacy</a></li>
    <li>OpenAI: <a href="https://openai.com/policies/privacy-policy" target="_blank" rel="noopener">openai.com/policies/privacy-policy</a></li>
  </ul>

  <h2>Children's Privacy</h2>
  <p>Our service is not directed to children under 13. We do not knowingly collect personal information from children under 13.</p>

  <h2>California Privacy Rights (CCPA)</h2>
  <p>California residents have the right to request disclosure of personal information we collect, request deletion of their data, and opt out of the sale of personal information. We do not sell personal information. To exercise your rights, contact us at <a href="mailto:info@socalreceptionist.com">info@socalreceptionist.com</a> or visit <a href="https://www.socalreceptionist.com/data-deletion">www.socalreceptionist.com/data-deletion</a>.</p>

  <h2>Changes to This Policy</h2>
  <p>We may update this policy periodically. The "Last updated" date above reflects the most recent revision. Continued use of the service after changes constitutes acceptance of the updated policy.</p>

  <h2>Contact</h2>
  <p>Questions about this Privacy Policy or our SMS program? Contact us:</p>
  <p>
    <strong>SoCal Receptionist (SOCAL RECEPTIONIST LLC)</strong><br>
    Email: <a href="mailto:info@socalreceptionist.com">info@socalreceptionist.com</a><br>
    Website: <a href="https://www.socalreceptionist.com">www.socalreceptionist.com</a>
  </p>
  `));
});

app.get('/terms', (req, res) => {
  res.type('text/html').send(legalPage('Terms of Use', `
  <h1>Terms of Use</h1>
  <p>Last updated: May 2026</p>
  <p>By using the SMS service provided by <strong>SoCal Receptionist</strong>, you agree to these Terms of Use. If you do not agree, do not use the service.</p>

  <h2>The Service</h2>
  <p>SoCal Receptionist provides an AI-powered virtual receptionist delivered via SMS. The service answers general inquiries, provides business information, and facilitates appointment scheduling on behalf of participating businesses.</p>

  <h2>Acceptable Use</h2>
  <p>You agree not to:</p>
  <ul>
    <li>Use the service for any unlawful purpose</li>
    <li>Send abusive, harassing, or threatening messages</li>
    <li>Attempt to manipulate, reverse-engineer, or disrupt the AI system</li>
    <li>Use the service to transmit spam or unsolicited commercial messages</li>
  </ul>

  <h2>AI-Generated Responses</h2>
  <p>Responses are generated by an AI system and may not always be accurate, complete, or up to date. The AI is not a licensed professional in any field. Do not rely solely on AI responses for legal, medical, financial, or safety decisions. Always confirm important details directly with the business.</p>

  <h2>Opt-In Requirement</h2>
  <p>You must reply <strong>YES</strong> to the consent prompt before receiving AI messages. By doing so, you agree to receive automated text messages from the service. Reply <strong>STOP</strong> at any time to opt out.</p>

  <h2>No Warranties</h2>
  <p>The service is provided "as is" without warranty of any kind. We do not guarantee uninterrupted service, accuracy of AI responses, or that the service will meet your specific needs.</p>

  <h2>Limitation of Liability</h2>
  <p>To the fullest extent permitted by applicable law, SoCal Receptionist shall not be liable for any indirect, incidental, or consequential damages arising from your use of the service.</p>

  <h2>Governing Law</h2>
  <p>These terms are governed by the laws of the State of California. Any disputes shall be resolved in the courts of Riverside County, California.</p>

  <h2>Changes to These Terms</h2>
  <p>We may update these terms at any time. Continued use of the service constitutes acceptance of the updated terms.</p>

  <h2>Contact</h2>
  <p>Questions? Email us at <a href="mailto:info@socalreceptionist.com">info@socalreceptionist.com</a>.</p>
  `));
});

app.get('/sms-terms', (req, res) => {
  res.type('text/html').send(legalPage('SMS Terms & Conditions', `
  <h1>SMS Terms &amp; Conditions</h1>
  <p>Last updated: June 2026</p>

  <h2>Program Description</h2>
  <p><strong>SoCal Receptionist</strong> provides an AI-powered virtual receptionist service that communicates with customers via SMS on behalf of small businesses in Southern California. Messages may include appointment scheduling, business inquiries, and follow-ups.</p>

  <h2>How to Opt In</h2>
  <p>You opt in to receive SMS messages by texting a business phone number powered by SoCal Receptionist. Your first inbound message constitutes your explicit opt-in consent to receive AI-generated SMS replies. No automated messages are sent until you initiate the conversation.</p>

  <h2>Message Frequency</h2>
  <p>Message frequency varies based on your interactions. Typically 1–5 messages per conversation. You will not receive unsolicited marketing messages.</p>

  <h2>Message &amp; Data Rates</h2>
  <p><strong>Msg &amp; Data Rates May Apply.</strong> Standard message and data rates may apply depending on your mobile carrier plan. SoCal Receptionist does not charge for SMS messages.</p>

  <h2>How to Opt Out</h2>
  <p>Reply <strong>STOP</strong>, <strong>CANCEL</strong>, <strong>END</strong>, <strong>QUIT</strong>, or <strong>UNSUBSCRIBE</strong> at any time to immediately stop all SMS messages. You will receive one final confirmation message and no further messages will be sent.</p>

  <h2>How to Get Help</h2>
  <p>Reply <strong>HELP</strong> for assistance, or contact us directly:</p>
  <ul>
    <li><strong>Email:</strong> <a href="mailto:info@socalreceptionist.com">info@socalreceptionist.com</a></li>
    <li><strong>Website:</strong> <a href="https://www.socalreceptionist.com/support">socalreceptionist.com/support</a></li>
  </ul>

  <h2>Supported Carriers</h2>
  <p>Major US carriers including AT&amp;T, Verizon, T-Mobile, and others. Carrier support may vary.</p>

  <h2>Privacy</h2>
  <p>Your phone number and message content are used solely to provide the virtual receptionist service. We do not sell or share your phone number for marketing purposes. See our full <a href="/privacy">Privacy Policy</a>.</p>

  <h2>Contact</h2>
  <p>Questions? Email <a href="mailto:info@socalreceptionist.com">info@socalreceptionist.com</a>.</p>
  `));
});

app.get('/cookies', (req, res) => {
  res.type('text/html').send(legalPage('Cookie Policy', `
  <h1>Cookie Policy</h1>
  <p>Last updated: May 2026</p>
  <p>This Cookie Policy explains how <strong>SoCal Receptionist</strong> uses cookies on our website (<a href="https://www.socalreceptionist.com">socalreceptionist.com</a>).</p>

  <h2>What Cookies We Use</h2>
  <p>Our website uses only <strong>essential cookies</strong> necessary for basic functionality:</p>
  <ul>
    <li><strong>Session cookies</strong> — temporary cookies that expire when you close your browser.</li>
  </ul>
  <p>We do <strong>not</strong> use advertising, tracking, or third-party analytics cookies.</p>

  <h2>Managing Cookies</h2>
  <p>You can control cookies through your browser settings. Disabling essential cookies may affect site functionality.</p>

  <h2>Contact</h2>
  <p>Questions? Email us at <a href="mailto:info@socalreceptionist.com">info@socalreceptionist.com</a>.</p>
  `));
});

app.get('/accessibility', (req, res) => {
  res.type('text/html').send(legalPage('Accessibility Statement', `
  <h1>Accessibility Statement</h1>
  <p>Last updated: May 2026</p>
  <p><strong>SoCal Receptionist</strong> is committed to ensuring digital accessibility for people with disabilities. We aim to conform to <strong>WCAG 2.1 Level AA</strong>.</p>

  <h2>Feedback &amp; Contact</h2>
  <p>If you experience any accessibility barriers, contact us at <a href="mailto:info@socalreceptionist.com">info@socalreceptionist.com</a>. We aim to respond within 2 business days.</p>
  `));
});

app.get('/data-deletion', (req, res) => {
  res.type('text/html').send(legalPage('Data Deletion', `
  <h1>Data Deletion Request</h1>
  <p>Last updated: June 2026</p>
  <p>To request deletion of your data held by SoCal Receptionist, email <a href="mailto:info@socalreceptionist.com">info@socalreceptionist.com</a> with the subject line "Data Deletion Request" and include your phone number. We will process your request within 30 days as required by California law (CCPA).</p>

  <h2>What We Delete</h2>
  <ul>
    <li>Your phone number from our records</li>
    <li>Any stored opt-in/opt-out consent status</li>
    <li>Any conversation data associated with your number</li>
  </ul>

  <h2>Contact</h2>
  <p>Email: <a href="mailto:info@socalreceptionist.com">info@socalreceptionist.com</a></p>
  `));
});

// Serve the landing page (public/) and the React SPA (web/dist/).
// API routes above take priority; everything else falls through to the SPA.
const publicDir = path.join(__dirname, '../../public');
const spaDir = path.join(__dirname, '../web/dist');

app.use(express.static(publicDir, { extensions: ['html'] }));
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
  // Start proactive reminder poller — runs every 60s, pings tenants before calendar events.
  startReminderPoller();
});

if (process.env.RUN_WORKER === 'true') {
  require('./provisioning/run-worker');
}
