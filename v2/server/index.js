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
const onboardingChatRouter = require('./onboarding/chat');
const mfaRouter = require('./auth/mfa');
const integrationsRouter = require('./integrations/router');
const outboundAssistRouter = require('./voice/outbound-assist');
const { router: reminderRouter, start: startReminderPoller } = require('./voice/reminder-poller');

const app = express();
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

// Rate limiting for admin and onboarding routes (issue #11)
const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});
const strictLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
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

app.use('/', smsRouter);
app.use('/', voiceRouter);

// Onboarding API — business registration, then service-agreement e-signature
// (which gates provisioning). Register is mounted first; both share /onboarding.
app.use('/onboarding', strictLimiter, onboardingRegisterRouter);
app.use('/onboarding', onboardingAgreementRouter);
app.use('/onboarding', onboardingChatRouter);

// MFA API — trusted-device ("trust this device for 30 days") issue / verify /
// revoke. The TOTP + passkey factors themselves are handled by Supabase Auth
// directly from the browser; this only owns the app-side trust ledger.
app.use('/auth/mfa', strictLimiter, mfaRouter);

// Admin API. The owner router is mounted first so /admin/owner/* never falls
// into the client router's requireTenant middleware.
app.use('/admin/owner', adminLimiter, ownerAdminRouter);
app.use('/admin', adminLimiter, clientAdminRouter);
app.use('/integrations', adminLimiter, integrationsRouter);

// Outbound Call Assist + Proactive Reminder webhooks (Twilio, rate-limited).
app.use(outboundAssistRouter);
app.use(reminderRouter);

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
  // Start proactive reminder poller — runs every 60s, pings tenants before calendar events.
  startReminderPoller();
});

if (process.env.RUN_WORKER === 'true') {
  require('./provisioning/run-worker');
}
