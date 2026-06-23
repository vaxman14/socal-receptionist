// Client admin API — a tenant owner managing their own business.
//
// Mounted at /admin. Every route runs requireAuth + requireTenant, and every
// query is explicitly scoped to req.tenant.id — the backend bypasses RLS, so
// this scoping IS the tenant-isolation boundary for the admin surface.

const express = require('express');
const { supabase } = require('../lib/supabase');
const { requireAuth, requireTenant, requireTenantOwner, requireAal2 } = require('../lib/auth');
const { createCheckoutSession, createPortalSession } = require('../lib/billing');
const { listTickets, updateTicket, bulkAccept, exportCsv } = require('../lib/time-tickets');
const { listLeads: listOutboundLeads, createLead, bulkCreateLeads, updateLead, deleteLead } = require('../lib/outbound-leads');
const { normalizePhone, isValidTimezone, isValidEmail } = require('../lib/validate');
const { sendEmail, brandedEmail, tenantBrand } = require('../lib/email');
const { sendSms } = require('../lib/sms');

// ---------------------------------------------------------------------------
// Server-side price ID allowlist (issue #3 — client-supplied price IDs)
// ---------------------------------------------------------------------------
// STRIPE_PLAN_MAP_JSON lets ops add SKUs without a code change:
//   {"growth_monthly":{"price":"price_x","setup":"price_y"}, ...}
// Named env vars below remain the canonical config for the core plans.
let EXTRA_PLANS = {};
try {
  EXTRA_PLANS = JSON.parse(process.env.STRIPE_PLAN_MAP_JSON || '{}');
} catch (e) {
  console.error('[billing] STRIPE_PLAN_MAP_JSON is invalid JSON — ignoring:', e.message);
}

const ALLOWED_PRICE_IDS = new Set([
  process.env.STRIPE_PRICE_ID_ESSENTIALS,
  process.env.STRIPE_PRICE_ID_ESSENTIALS_ANNUAL,
  process.env.STRIPE_PRICE_ID_CONCIERGE,
  process.env.STRIPE_PRICE_ID_CONCIERGE_ANNUAL,
  // Legacy single-price fallback
  process.env.STRIPE_PRICE_ID,
  // Comma-separated extras (one-off promos etc.)
  ...(process.env.STRIPE_EXTRA_PRICE_IDS || '').split(',').map((s) => s.trim()),
  ...Object.values(EXTRA_PLANS).map((p) => p && p.price),
].filter(Boolean));

const ALLOWED_SETUP_PRICE_IDS = new Set([
  process.env.STRIPE_SETUP_PRICE_ID_CONCIERGE,
  process.env.STRIPE_SETUP_PRICE_ID,
  ...Object.values(EXTRA_PLANS).map((p) => p && p.setup),
].filter(Boolean));

// Named plan keys — frontend sends a plan name, backend resolves price IDs.
const PLAN_PRICE_MAP = {
  essentials_monthly: process.env.STRIPE_PRICE_ID_ESSENTIALS,
  essentials_annual: process.env.STRIPE_PRICE_ID_ESSENTIALS_ANNUAL,
  concierge_monthly: process.env.STRIPE_PRICE_ID_CONCIERGE,
  concierge_annual: process.env.STRIPE_PRICE_ID_CONCIERGE_ANNUAL,
  ...Object.fromEntries(Object.entries(EXTRA_PLANS).map(([k, p]) => [k, p && p.price])),
};

const PLAN_SETUP_MAP = {
  concierge_monthly: process.env.STRIPE_SETUP_PRICE_ID_CONCIERGE,
  concierge_annual: process.env.STRIPE_SETUP_PRICE_ID_CONCIERGE,
  ...Object.fromEntries(
    Object.entries(EXTRA_PLANS).filter(([, p]) => p && p.setup).map(([k, p]) => [k, p.setup])
  ),
};

const router = express.Router();

// Fields a client may edit on their own tenant. status, spend caps, slug, and
// owner fields are deliberately excluded — those move only via the backend.
const EDITABLE_FIELDS = [
  'business_name',
  'business_hours',
  'business_services',
  'calendly_link',
  'timezone',
  'ai_system_prompt',
  'ai_extra_info',            // owner-managed extra info lines fed to the AI (text[])
  'social_handles',           // client social media handles by platform (jsonb)
  // Voice receptionist config.
  'voice_enabled',
  'recording_enabled',        // call recording (AI discloses at call start)
  'staff_phone',              // "press 2 / speak to staff" transfer target
  'voice_greeting',
  'voicemail_email',
  'voice_id',                 // Twilio Polly Neural voice selection
  // Outbound Call Assist config.
  'outbound_enabled',
  'outbound_reminder_phone',  // number Josi calls to give proactive reminders
  // Email branding (white-label the emails sent to the client's customers).
  'email_logo_url',           // hosted logo URL shown in the email header
  'email_brand_color',        // header background hex, e.g. #f47c20
  'email_from_name',          // optional display name for the From line
];

router.use(requireAuth, requireTenant);

// GET /admin/me — account, tenant, subscription, phone number.
router.get('/me', async (req, res) => {
  const [{ data: subscription }, { data: phoneNumbers }] = await Promise.all([
    supabase
      .from('subscriptions')
      .select('*')
      .eq('tenant_id', req.tenant.id)
      .maybeSingle(),
    supabase
      .from('phone_numbers')
      .select('phone_e164, status, is_byo')
      .eq('tenant_id', req.tenant.id)
      .eq('status', 'active')
      .limit(1),
  ]);
  res.json({
    user: { id: req.user.id, email: req.user.email },
    tenant: req.tenant,
    subscription: subscription || null,
    phoneNumber: phoneNumbers && phoneNumbers[0] ? phoneNumbers[0] : null,
  });
});

// GET /admin/voice/preview?voice=Polly.Joanna-Neural
// Streams an OpenAI TTS audio clip so the client can hear how each voice sounds.
const POLLY_TO_OPENAI = {
  'Polly.Joanna-Neural': 'nova',
  'Polly.Salli-Neural':  'nova',
  'Polly.Matthew-Neural': 'echo',
  'Polly.Joey-Neural':   'echo',
  'Polly.Amy-Neural':    'shimmer',
  'Polly.Brian-Neural':  'onyx',
};
const PREVIEW_TEXT = 'Thank you for calling. How can I help you today?';

router.get('/voice/preview', async (req, res) => {
  const voiceId = req.query.voice || 'Polly.Joanna-Neural';
  const oaiVoice = POLLY_TO_OPENAI[voiceId] || 'nova';
  try {
    const response = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'tts-1',
        input: PREVIEW_TEXT,
        voice: oaiVoice,
        speed: 0.95,
      }),
    });
    if (!response.ok) {
      // Do NOT forward the raw OpenAI error body — it may contain quota or key hints.
      console.error('[admin/voice/preview] TTS upstream error:', response.status, await response.text());
      return res.status(502).json({ error: 'TTS unavailable' });
    }
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    const buf = await response.arrayBuffer();
    res.send(Buffer.from(buf));
  } catch (err) {
    console.error('[admin/voice/preview] unexpected error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /admin/tenant — update business config (whitelisted fields only).
const PHONE_FIELDS = ['staff_phone', 'outbound_reminder_phone'];

router.patch('/tenant', requireAal2, async (req, res) => {
  const patch = {};
  for (const field of EDITABLE_FIELDS) {
    if (req.body[field] !== undefined) patch[field] = req.body[field];
  }
  if (!Object.keys(patch).length) {
    return res.status(400).json({ error: 'no editable fields supplied' });
  }

  // Semantic validation. Empty string means "clear the field" and is allowed.
  if (patch.timezone !== undefined && patch.timezone !== '' && !isValidTimezone(patch.timezone)) {
    return res.status(400).json({ error: 'timezone must be a valid IANA timezone (e.g. America/Los_Angeles)' });
  }
  for (const f of PHONE_FIELDS) {
    if (patch[f] === undefined || patch[f] === '' || patch[f] === null) continue;
    const normalized = normalizePhone(patch[f]);
    if (!normalized) {
      return res.status(400).json({ error: `${f} must be a valid phone number (e.g. +19515551234)` });
    }
    patch[f] = normalized;
  }
  if (patch.voicemail_email !== undefined && patch.voicemail_email !== '' && !isValidEmail(patch.voicemail_email)) {
    return res.status(400).json({ error: 'voicemail_email must be a valid email address' });
  }
  // ai_extra_info is a list of free-text lines. Coerce to a clean string[]:
  // drop non-strings/blank lines, trim, cap count + length so one tenant can't
  // bloat the AI system prompt.
  if (patch.ai_extra_info !== undefined) {
    if (!Array.isArray(patch.ai_extra_info)) {
      return res.status(400).json({ error: 'ai_extra_info must be a list of text lines' });
    }
    const cleaned = patch.ai_extra_info
      .filter((s) => typeof s === 'string')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 50)
      .map((s) => s.slice(0, 1000));
    patch.ai_extra_info = cleaned;
  }
  // social_handles is a { platform: handle } map. Only accept known platforms;
  // keep string values, trim, and cap length. Blank values drop the platform.
  if (patch.social_handles !== undefined) {
    if (typeof patch.social_handles !== 'object' || patch.social_handles === null || Array.isArray(patch.social_handles)) {
      return res.status(400).json({ error: 'social_handles must be an object of platform -> handle' });
    }
    const ALLOWED_PLATFORMS = ['facebook', 'instagram', 'linkedin', 'twitter', 'tiktok', 'youtube', 'google_business'];
    const cleaned = {};
    for (const platform of ALLOWED_PLATFORMS) {
      const v = patch.social_handles[platform];
      if (typeof v !== 'string') continue;
      const trimmed = v.trim().slice(0, 300);
      if (trimmed) cleaned[platform] = trimmed;
    }
    patch.social_handles = cleaned;
  }
  const { data, error } = await supabase
    .from('tenants')
    .update(patch)
    .eq('id', req.tenant.id)
    .select()
    .single();
  if (error) {
    console.error('[admin] update tenant failed:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
  res.json({ tenant: data });
});

// GET /admin/leads?page=1&limit=25 — this tenant's leads, newest first.
router.get('/leads', async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 100);
  const page = Math.max(Number(req.query.page) || 1, 1);
  const offset = (page - 1) * limit;

  const [{ count }, { data, error }] = await Promise.all([
    supabase
      .from('leads')
      .select('*', { count: 'exact', head: true })
      .eq('tenant_id', req.tenant.id),
    supabase
      .from('leads')
      .select('*')
      .eq('tenant_id', req.tenant.id)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1),
  ]);
  if (error) {
    console.error('[admin] list leads failed:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
  res.json({ leads: data, total: count ?? 0, page, limit });
});

// GET /admin/conversations — this tenant's conversation threads.
router.get('/conversations', async (req, res) => {
  const { data, error } = await supabase
    .from('conversations')
    .select('*')
    .eq('tenant_id', req.tenant.id)
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .limit(200);
  if (error) {
    console.error('[admin] list conversations failed:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
  res.json({ conversations: data });
});

// GET /admin/conversations/:id/messages — a transcript, scoped to the tenant.
router.get('/conversations/:id/messages', async (req, res) => {
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('conversation_id', req.params.id)
    .eq('tenant_id', req.tenant.id) // scope guard — can't read another tenant's thread
    .order('created_at', { ascending: true });
  if (error) {
    console.error('[admin] list messages failed:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
  res.json({ messages: data });
});

// GET /admin/calls?page=1&limit=25 — this tenant's inbound calls, newest first.
router.get('/calls', async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 100);
  const page = Math.max(Number(req.query.page) || 1, 1);
  const offset = (page - 1) * limit;

  const [{ count }, { data, error }] = await Promise.all([
    supabase
      .from('calls')
      .select('*', { count: 'exact', head: true })
      .eq('tenant_id', req.tenant.id),
    supabase
      .from('calls')
      .select('*')
      .eq('tenant_id', req.tenant.id)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1),
  ]);
  if (error) {
    console.error('[admin] list calls failed:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
  // Never expose raw Twilio media URLs to the browser — they are accessible
  // to anyone holding the link. The SPA streams audio via the proxy below.
  const calls = (data || []).map(({ recording_url, recording_sid, ...rest }) => ({
    ...rest,
    has_recording: Boolean(recording_url),
  }));
  res.json({ calls, total: count ?? 0, page, limit });
});

// GET /admin/calls/:id/recording — stream the Twilio recording through the
// backend so playback is tenant-scoped and authenticated, and keeps working
// if "Enforce HTTP Auth on media URLs" is enabled on the Twilio account.
router.get('/calls/:id/recording', async (req, res) => {
  try {
    const { data: call, error } = await supabase
      .from('calls')
      .select('id, recording_url')
      .eq('tenant_id', req.tenant.id)
      .eq('id', req.params.id)
      .single();
    if (error || !call?.recording_url) {
      return res.status(404).json({ error: 'Recording not found.' });
    }
    const mediaUrl = call.recording_url.endsWith('.mp3')
      ? call.recording_url
      : `${call.recording_url}.mp3`;
    const basic = Buffer.from(
      `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
    ).toString('base64');
    const upstream = await fetch(mediaUrl, { headers: { Authorization: `Basic ${basic}` } });
    if (!upstream.ok) {
      console.error('[admin] recording fetch failed:', upstream.status, call.id);
      return res.status(502).json({ error: 'Could not fetch the recording.' });
    }
    res.set('Content-Type', 'audio/mpeg');
    res.set('Cache-Control', 'private, max-age=300');
    res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    console.error('[admin] recording proxy failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /admin/billing/checkout — start a subscription. Billed as a one-time
// setup fee (includes month one) plus the recurring monthly price, which is
// deferred 30 days via a trial.
// SECURITY: priceId and setupPriceId are validated against a server-side
// allowlist — client-supplied IDs are never used directly (issue #3).
// successUrl and cancelUrl are always derived from APP_BASE_URL (issue #14).
router.post('/billing/checkout', requireAal2, requireTenantOwner, async (req, res) => {
  try {
    let priceId;
    let setupPriceId;

    const { planKey } = req.body;
    if (planKey) {
      // Named plan — resolve server-side, no client-supplied price IDs needed.
      if (!PLAN_PRICE_MAP[planKey] && !Object.keys(PLAN_PRICE_MAP).includes(planKey)) {
        return res.status(400).json({ error: 'unknown plan' });
      }
      priceId = PLAN_PRICE_MAP[planKey];
      setupPriceId = PLAN_SETUP_MAP[planKey] || null;
      if (!priceId) return res.status(400).json({ error: 'no plan price configured' });
    } else {
      // Legacy: explicit priceId/setupPriceId (validated against allowlist).
      const requestedPriceId = req.body.priceId;
      if (requestedPriceId) {
        if (!ALLOWED_PRICE_IDS.has(requestedPriceId)) {
          return res.status(400).json({ error: 'invalid price' });
        }
        priceId = requestedPriceId;
      } else {
        priceId = process.env.STRIPE_PRICE_ID;
      }
      if (!priceId) return res.status(400).json({ error: 'no plan price configured' });

      const requestedSetupPriceId = req.body.setupPriceId;
      if (requestedSetupPriceId) {
        if (!ALLOWED_SETUP_PRICE_IDS.has(requestedSetupPriceId)) {
          return res.status(400).json({ error: 'invalid setup price' });
        }
        setupPriceId = requestedSetupPriceId;
      } else {
        setupPriceId = process.env.STRIPE_SETUP_PRICE_ID;
      }
    }

    // Platform-admin price override: if this tenant's subscription has a
    // custom_price_cents set, bill that monthly amount instead of the plan price.
    let customPriceCents = null;
    {
      const { data: sub } = await supabase
        .from('subscriptions').select('custom_price_cents').eq('tenant_id', req.tenant.id).maybeSingle();
      if (sub && Number.isInteger(sub.custom_price_cents) && sub.custom_price_cents >= 0) {
        customPriceCents = sub.custom_price_cents;
      }
    }

    // Build redirect URLs server-side — never trust the client. Stripe should
    // send the user back to the SPA, so prefer WEB_BASE_URL.
    const base = (process.env.WEB_BASE_URL || process.env.APP_BASE_URL || '').replace(/\/+$/, '');
    const session = await createCheckoutSession({
      tenant: req.tenant,
      priceId,
      setupPriceId,
      customPriceCents,
      successUrl: `${base}/billing/success`,
      cancelUrl: `${base}/billing/cancel`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('[admin] checkout failed:', err);
    res.status(500).json({ error: 'checkout failed' });
  }
});

// POST /admin/billing/portal — open the Stripe Customer Portal.
// SECURITY: returnUrl is always derived from APP_BASE_URL (issue #14).
router.post('/billing/portal', requireAal2, requireTenantOwner, async (req, res) => {
  try {
    const { data: sub } = await supabase
      .from('subscriptions')
      .select('stripe_customer_id')
      .eq('tenant_id', req.tenant.id)
      .maybeSingle();
    if (!sub || !sub.stripe_customer_id) {
      return res.status(400).json({ error: 'no billing account yet' });
    }
    const base = (process.env.WEB_BASE_URL || process.env.APP_BASE_URL || '').replace(/\/+$/, '');
    const session = await createPortalSession({
      stripeCustomerId: sub.stripe_customer_id,
      returnUrl: `${base}/billing`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('[admin] portal failed:', err);
    res.status(500).json({ error: 'portal failed' });
  }
});

// ---------------------------------------------------------------------------
// Marketing — Google review requests
// ---------------------------------------------------------------------------

// POST /admin/marketing/review-request — text or email a customer the tenant's
// Google review link. The link is whatever the tenant saved as their Google
// Business Profile handle (social_handles.google_business).
router.post('/marketing/review-request', requireAal2, express.json(), async (req, res) => {
  const { channel, to } = req.body || {};
  if (!['sms', 'email'].includes(channel)) {
    return res.status(400).json({ error: 'channel must be "sms" or "email"' });
  }

  const reviewLink = req.tenant.social_handles && req.tenant.social_handles.google_business;
  if (!reviewLink) {
    return res.status(400).json({ error: 'Add your Google review link on the Marketing page first.' });
  }

  const businessName = req.tenant.business_name || 'our team';
  const message = `Hi! Thanks for choosing ${businessName}. We'd love your feedback — leave us a quick Google review here: ${reviewLink}`;

  if (channel === 'sms') {
    const normalized = normalizePhone(to);
    if (!normalized) return res.status(400).json({ error: 'Enter a valid phone number (e.g. +19515551234).' });
    const result = await sendSms({ tenantId: req.tenant.id, to: normalized, body: message });
    if (!result.ok) return res.status(502).json({ error: result.error || 'Could not send the text.' });
    return res.json({ ok: true });
  }

  // email
  if (!isValidEmail(to)) return res.status(400).json({ error: 'Enter a valid email address.' });
  const html = brandedEmail({
    ...tenantBrand(req.tenant),
    heading: 'How did we do?',
    preview: `We'd love your feedback on ${businessName}`,
    bodyHtml: `<p>Hi,</p><p>Thanks for choosing <strong>${businessName}</strong>. We'd love your feedback!</p>`
      + `<p style="margin:24px 0;"><a href="${reviewLink}" style="background:#f47c20;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;display:inline-block;">Leave a quick Google review</a></p><p style="margin:0;">Thank you,<br/>${businessName}</p>`,
    footer: `<strong style="color:#6b7280;">${businessName}</strong>`,
  });
  const result = await sendEmail({ to, subject: `How was your experience with ${businessName}?`, html, text: message });
  if (!result.ok) return res.status(502).json({ error: result.error || 'Could not send the email.' });
  return res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Reminder recipients — per-user proactive reminders
// ---------------------------------------------------------------------------

const REMINDER_COLS = 'id, name, match_email, source, external_id, call_enabled, call_phone, ext_enabled, ext_value, email_enabled, email_address';

// Coerce one client-supplied recipient into a clean, storable row. Returns
// { row } or { error }.
function sanitizeRecipient(r, tenantId) {
  if (!r || typeof r !== 'object') return { error: 'invalid recipient' };
  const name = typeof r.name === 'string' ? r.name.trim().slice(0, 200) : '';
  if (!name) return { error: 'each recipient needs a name' };

  const row = {
    tenant_id:     tenantId,
    name,
    match_email:   typeof r.match_email === 'string' && r.match_email.trim() ? r.match_email.trim().slice(0, 320) : null,
    source:        ['manual', 'clio', 'google', 'microsoft'].includes(r.source) ? r.source : 'manual',
    external_id:   typeof r.external_id === 'string' ? r.external_id.slice(0, 200) : null,
    call_enabled:  !!r.call_enabled,
    call_phone:    null,
    ext_enabled:   !!r.ext_enabled,
    ext_value:     typeof r.ext_value === 'string' ? r.ext_value.trim().slice(0, 32) : null,
    email_enabled: !!r.email_enabled,
    email_address: null,
  };

  if (row.match_email && !isValidEmail(row.match_email)) return { error: `"${row.match_email}" is not a valid email` };

  if (row.call_enabled) {
    const normalized = normalizePhone(r.call_phone);
    if (!normalized) return { error: `${name}: a valid call phone number is required when call reminders are on` };
    row.call_phone = normalized;
  } else if (r.call_phone) {
    row.call_phone = normalizePhone(r.call_phone) || null;
  }

  if (row.ext_enabled && !row.ext_value) return { error: `${name}: an extension is required when extension reminders are on` };

  if (row.email_enabled) {
    if (!isValidEmail(r.email_address)) return { error: `${name}: a valid email is required when email reminders are on` };
    row.email_address = r.email_address.trim();
  } else if (r.email_address && isValidEmail(r.email_address)) {
    row.email_address = r.email_address.trim();
  }

  return { row };
}

// GET /admin/reminders — list this tenant's reminder recipients.
router.get('/reminders', async (req, res) => {
  const { data, error } = await supabase
    .from('reminder_recipients')
    .select(REMINDER_COLS)
    .eq('tenant_id', req.tenant.id)
    .order('name', { ascending: true });
  if (error) {
    console.error('[admin] list reminders failed:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
  res.json({ recipients: data || [] });
});

// PUT /admin/reminders — replace the full recipient set for this tenant.
router.put('/reminders', requireAal2, express.json(), async (req, res) => {
  const incoming = req.body && req.body.recipients;
  if (!Array.isArray(incoming)) return res.status(400).json({ error: 'recipients array required' });
  if (incoming.length > 200) return res.status(400).json({ error: 'maximum 200 recipients' });

  const rows = [];
  for (const r of incoming) {
    const { row, error } = sanitizeRecipient(r, req.tenant.id);
    if (error) return res.status(400).json({ error });
    rows.push(row);
  }

  // Replace-all: simplest predictable semantics for a managed list.
  const { error: delErr } = await supabase.from('reminder_recipients').delete().eq('tenant_id', req.tenant.id);
  if (delErr) {
    console.error('[admin] reminders clear failed:', delErr);
    return res.status(500).json({ error: 'Internal server error' });
  }
  if (rows.length) {
    const { error: insErr } = await supabase.from('reminder_recipients').insert(rows);
    if (insErr) {
      console.error('[admin] reminders insert failed:', insErr);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
  const { data } = await supabase
    .from('reminder_recipients')
    .select(REMINDER_COLS)
    .eq('tenant_id', req.tenant.id)
    .order('name', { ascending: true });
  res.json({ recipients: data || [] });
});

// POST /admin/reminders/sync — pull users from connected calendar/practice
// integrations and add any not already present (channels start disabled).
router.post('/reminders/sync', requireAal2, async (req, res) => {
  const { data: ints } = await supabase
    .from('tenant_integrations')
    .select('provider, enabled')
    .eq('tenant_id', req.tenant.id)
    .eq('enabled', true);
  const connected = new Set((ints || []).map(i => i.provider));

  const found = [];
  const errors = [];
  const sources = [
    { provider: 'clio',            mod: '../integrations/clio' },
    { provider: 'google_calendar', mod: '../integrations/google-calendar' },
  ];
  for (const s of sources) {
    if (!connected.has(s.provider)) continue;
    try {
      const users = await require(s.mod).listUsers(req.tenant.id);
      found.push(...users);
    } catch (err) {
      console.error(`[admin] reminder sync ${s.provider} failed:`, err.message);
      errors.push(s.provider);
    }
  }

  if (!found.length) {
    const msg = connected.has('clio') || connected.has('google_calendar')
      ? 'Could not pull any users from your connected calendar. Add them manually below.'
      : 'Connect Clio or Google Calendar on the Integrations page first, then sync.';
    return res.status(errors.length ? 502 : 400).json({ error: msg });
  }

  // Existing match emails so we only add new people.
  const { data: existing } = await supabase
    .from('reminder_recipients')
    .select('match_email')
    .eq('tenant_id', req.tenant.id);
  const have = new Set((existing || []).map(e => (e.match_email || '').toLowerCase()).filter(Boolean));

  const toInsert = [];
  const seen = new Set();
  for (const u of found) {
    const email = (u.email || '').toLowerCase();
    if (!email || have.has(email) || seen.has(email)) continue;
    seen.add(email);
    toInsert.push({
      tenant_id:     req.tenant.id,
      name:          u.name || u.email,
      match_email:   u.email,
      source:        u.source || 'manual',
      external_id:   u.externalId || null,
      email_enabled: false,
      email_address: u.email,
    });
  }

  if (toInsert.length) {
    const { error: insErr } = await supabase.from('reminder_recipients').insert(toInsert);
    if (insErr) {
      console.error('[admin] reminder sync insert failed:', insErr);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  const { data } = await supabase
    .from('reminder_recipients')
    .select(REMINDER_COLS)
    .eq('tenant_id', req.tenant.id)
    .order('name', { ascending: true });
  res.json({ recipients: data || [], added: toInsert.length });
});

// ---------------------------------------------------------------------------
// Time tickets
// ---------------------------------------------------------------------------

// GET /admin/time-tickets?status=draft|accepted|rejected
router.get('/time-tickets', async (req, res) => {
  try {
    const tickets = await listTickets(req.tenant.id, { status: req.query.status });
    res.json({ tickets });
  } catch (err) {
    console.error('[admin] list tickets failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /admin/time-tickets/:id — accept/edit a ticket
router.patch('/time-tickets/:id', requireAal2, express.json(), async (req, res) => {
  try {
    const ticket = await updateTicket(req.params.id, req.tenant.id, req.body);
    res.json({ ticket });
  } catch (err) {
    console.error('[admin] update ticket failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /admin/time-tickets/:id — reject a ticket
router.delete('/time-tickets/:id', requireAal2, async (req, res) => {
  try {
    await updateTicket(req.params.id, req.tenant.id, { status: 'rejected' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[admin] reject ticket failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /admin/time-tickets/bulk-approve — accept all drafts
router.post('/time-tickets/bulk-approve', requireAal2, express.json(), async (req, res) => {
  try {
    const count = await bulkAccept(req.tenant.id);
    res.json({ accepted: count });
  } catch (err) {
    console.error('[admin] bulk-approve failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /admin/time-tickets/export.csv — CSV of accepted tickets
router.get('/time-tickets/export.csv', async (req, res) => {
  try {
    const csv = await exportCsv(req.tenant.id);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="time-tickets.csv"');
    res.send(csv);
  } catch (err) {
    console.error('[admin] export csv failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Outbound leads ──────────────────────────────────────────────────────────

// GET /admin/outbound-leads
router.get('/outbound-leads', async (req, res) => {
  try {
    const { status } = req.query;
    const leads = await listOutboundLeads(req.tenant.id, { status });
    res.json({ leads });
  } catch (err) {
    console.error('[admin] list outbound-leads failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /admin/outbound-leads — create single lead
router.post('/outbound-leads', requireAal2, express.json(), async (req, res) => {
  // Basic input validation (issue #12)
  const { phone, name } = req.body || {};
  if (!phone || typeof phone !== 'string' || phone.trim().length < 7) {
    return res.status(400).json({ error: 'phone is required and must be valid' });
  }
  if (name !== undefined && (typeof name !== 'string' || name.length > 200)) {
    return res.status(400).json({ error: 'name must be a string under 200 characters' });
  }
  try {
    const lead = await createLead(req.tenant.id, req.body);
    res.status(201).json({ lead });
  } catch (err) {
    console.error('[admin] create outbound-lead failed:', err);
    res.status(400).json({ error: err.message || 'could not create lead' });
  }
});

// POST /admin/outbound-leads/bulk — import array of leads
router.post('/outbound-leads/bulk', requireAal2, express.json(), async (req, res) => {
  const rows = req.body?.leads;
  if (!Array.isArray(rows) || !rows.length) {
    return res.status(400).json({ error: 'leads array required' });
  }
  if (rows.length > 500) {
    return res.status(400).json({ error: 'maximum 500 leads per bulk import' });
  }
  try {
    const created = await bulkCreateLeads(req.tenant.id, rows);
    res.status(201).json({ created: created.length, leads: created });
  } catch (err) {
    console.error('[admin] bulk create leads failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /admin/outbound-leads/:id
router.patch('/outbound-leads/:id', requireAal2, express.json(), async (req, res) => {
  try {
    const lead = await updateLead(req.tenant.id, req.params.id, req.body);
    res.json({ lead });
  } catch (err) {
    console.error('[admin] update outbound-lead failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /admin/outbound-leads/:id
router.delete('/outbound-leads/:id', requireAal2, async (req, res) => {
  try {
    await deleteLead(req.tenant.id, req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error('[admin] delete outbound-lead failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /admin/outbound-leads/:id/call — trigger an outbound call
router.post('/outbound-leads/:id/call', requireAal2, async (req, res) => {
  const outboundApiKey = process.env.OUTBOUND_API_KEY;
  if (!outboundApiKey) {
    return res.status(503).json({ error: 'Outbound calling not configured (OUTBOUND_API_KEY missing)' });
  }

  const { data: lead, error } = await supabase
    .from('outbound_leads')
    .select('*')
    .eq('id', req.params.id)
    .eq('tenant_id', req.tenant.id)
    .single();
  if (error || !lead) return res.status(404).json({ error: 'Lead not found' });
  if (['calling', 'dnc'].includes(lead.status)) {
    return res.status(409).json({ error: `Cannot call lead with status: ${lead.status}` });
  }

  // Delegate to the V1 outbound calling endpoint (same process, different router)
  // We make an internal HTTP call to keep concerns separated.
  // Use APP_BASE_URL for the internal call URL (issue #14).
  try {
    const baseUrl = (process.env.APP_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
    const fetch = require('node-fetch');
    const callRes = await fetch(`${baseUrl}/voice/outbound/call`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${outboundApiKey}`,
      },
      body: JSON.stringify({
        to: lead.phone,
        name: lead.name,
        businessType: lead.business_type,
        reason: lead.reason,
      }),
    });

    if (!callRes.ok) {
      const body = await callRes.json().catch(() => ({}));
      return res.status(callRes.status).json({ error: body.error || 'Call failed' });
    }

    const { callSid } = await callRes.json();
    // Mark as calling in the DB
    await supabase.from('outbound_leads').update({
      status: 'calling',
      call_sid: callSid,
      last_called_at: new Date().toISOString(),
      call_attempts: (lead.call_attempts || 0) + 1,
    }).eq('id', lead.id);

    res.json({ ok: true, callSid });
  } catch (err) {
    console.error('[admin] outbound call failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /admin/push/register { token, platform } — register this device for
// push notifications (live chat handoff alerts). Idempotent upsert by token.
router.post('/push/register', express.json(), async (req, res) => {
  try {
    const token = String(req.body && req.body.token || '').trim().slice(0, 200);
    const platform = String(req.body && req.body.platform || '').trim().slice(0, 20) || null;
    if (!/^ExponentPushToken/.test(token)) return res.status(400).json({ error: 'invalid token' });
    const { error } = await supabase
      .from('push_tokens')
      .upsert({ token, user_id: req.user.id, platform, updated_at: new Date().toISOString() }, { onConflict: 'token' });
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('[admin] push register failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// Live chat — conversational widget conversations + human takeover
// ---------------------------------------------------------------------------

// GET /admin/chats?status=active|waiting|all — this tenant's chat conversations.
// "active" (default) = anything not closed. Newest activity first.
router.get('/chats', async (req, res) => {
  try {
    const filter = req.query.status || 'active';
    let q = supabase
      .from('chat_conversations')
      .select('id, status, business_name, visitor_name, visitor_contact, source_url, waiting_since, last_message_at, agent_seen_at, created_at')
      .eq('tenant_id', req.tenant.id)
      .order('last_message_at', { ascending: false })
      .limit(100);
    if (filter === 'waiting') q = q.eq('status', 'waiting');
    else if (filter !== 'all') q = q.neq('status', 'closed');

    const { data, error } = await q;
    if (error) throw error;

    // Attach a short preview of the most recent message per conversation.
    const ids = (data || []).map((c) => c.id);
    const previews = {};
    if (ids.length) {
      const { data: recent } = await supabase
        .from('chat_messages')
        .select('conversation_id, role, body, created_at')
        .in('conversation_id', ids)
        .order('created_at', { ascending: false })
        .limit(300);
      for (const m of recent || []) {
        if (!previews[m.conversation_id]) previews[m.conversation_id] = { role: m.role, body: m.body.slice(0, 120) };
      }
    }
    const chats = (data || []).map((c) => ({
      ...c,
      preview: previews[c.id] || null,
      unread: !c.agent_seen_at || (c.last_message_at && c.last_message_at > c.agent_seen_at),
    }));
    res.json({ chats });
  } catch (err) {
    console.error('[admin] list chats failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /admin/chats/:id/messages — full transcript (also marks it seen).
router.get('/chats/:id/messages', async (req, res) => {
  try {
    const { data: conv, error: cErr } = await supabase
      .from('chat_conversations').select('*').eq('id', req.params.id).eq('tenant_id', req.tenant.id).maybeSingle();
    if (cErr) throw cErr;
    if (!conv) return res.status(404).json({ error: 'not found' });

    const { data: messages, error } = await supabase
      .from('chat_messages')
      .select('id, role, body, created_at')
      .eq('conversation_id', conv.id)
      .order('created_at', { ascending: true });
    if (error) throw error;

    await supabase.from('chat_conversations').update({ agent_seen_at: new Date().toISOString() }).eq('id', conv.id);
    res.json({ conversation: conv, messages: messages || [] });
  } catch (err) {
    console.error('[admin] chat messages failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /admin/chats/:id/claim — take over: AI goes silent, agent is live.
router.post('/chats/:id/claim', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('chat_conversations')
      .update({ status: 'live', claimed_by: req.user.id, claimed_at: new Date().toISOString(), agent_seen_at: new Date().toISOString() })
      .eq('id', req.params.id).eq('tenant_id', req.tenant.id)
      .neq('status', 'closed')
      .select('id, status').maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true, status: data.status });
  } catch (err) {
    console.error('[admin] claim chat failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /admin/chats/:id/message { body } — send an agent reply.
router.post('/chats/:id/message', express.json(), async (req, res) => {
  try {
    const body = String(req.body && req.body.body || '').trim().slice(0, 4000);
    if (!body) return res.status(400).json({ error: 'empty' });
    const { data: conv } = await supabase
      .from('chat_conversations').select('id, status').eq('id', req.params.id).eq('tenant_id', req.tenant.id).maybeSingle();
    if (!conv) return res.status(404).json({ error: 'not found' });

    const { data: msg, error } = await supabase
      .from('chat_messages')
      .insert({ conversation_id: conv.id, tenant_id: req.tenant.id, role: 'agent', body })
      .select('id, role, body, created_at').single();
    if (error) throw error;

    const patch = { last_message_at: new Date().toISOString(), agent_seen_at: new Date().toISOString() };
    if (conv.status !== 'live') { patch.status = 'live'; patch.claimed_by = req.user.id; patch.claimed_at = new Date().toISOString(); }
    await supabase.from('chat_conversations').update(patch).eq('id', conv.id);

    res.json({ ok: true, message: msg });
  } catch (err) {
    console.error('[admin] chat send failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /admin/chats/:id/release — hand control back to the AI.
router.post('/chats/:id/release', async (req, res) => {
  try {
    const { data } = await supabase
      .from('chat_conversations').select('id').eq('id', req.params.id).eq('tenant_id', req.tenant.id).maybeSingle();
    if (!data) return res.status(404).json({ error: 'not found' });
    await supabase.from('chat_conversations')
      .update({ status: 'ai', claimed_by: null, claimed_at: null, waiting_since: null }).eq('id', data.id);
    await supabase.from('chat_messages').insert({ conversation_id: data.id, tenant_id: req.tenant.id, role: 'system', body: 'The assistant is back to help.' });
    res.json({ ok: true, status: 'ai' });
  } catch (err) {
    console.error('[admin] release chat failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /admin/chats/:id/close — end the conversation.
router.post('/chats/:id/close', async (req, res) => {
  try {
    const { data } = await supabase
      .from('chat_conversations').update({ status: 'closed' })
      .eq('id', req.params.id).eq('tenant_id', req.tenant.id).select('id').maybeSingle();
    if (!data) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true, status: 'closed' });
  } catch (err) {
    console.error('[admin] close chat failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---- Team / Users (per-tenant multi-user, 2 roles: owner | admin) ----
const crypto = require('crypto');

// GET /admin/users — list this tenant's members. Any member may view.
router.get('/users', async (req, res) => {
  const { data, error } = await supabase
    .from('tenant_members')
    .select('id, email, full_name, role, status, invited_at, accepted_at')
    .eq('tenant_id', req.tenant.id)
    .order('created_at', { ascending: true });
  if (error) {
    console.error('[admin] list users failed:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
  res.json({ users: data || [], myRole: req.tenantRole });
});

// POST /admin/users — invite a user by email (owner only).
router.post('/users', requireAal2, requireTenantOwner, express.json(), async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const role = req.body.role === 'owner' ? 'owner' : 'admin';
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'A valid email is required.' });

  const { data: existing } = await supabase
    .from('tenant_members')
    .select('id').eq('tenant_id', req.tenant.id).ilike('email', email).maybeSingle();
  if (existing) return res.status(409).json({ error: 'That email is already a member or has a pending invite.' });

  const token = crypto.randomBytes(24).toString('hex');
  const invite_expires_at = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase.from('tenant_members').insert({
    tenant_id: req.tenant.id, email, role, status: 'invited',
    invite_token: token, invite_expires_at, invited_by: req.user.id,
  }).select('id, email, full_name, role, status, invited_at').maybeSingle();
  if (error) {
    console.error('[admin] invite user failed:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }

  const base = (process.env.WEB_BASE_URL || process.env.APP_BASE_URL || '').replace(/\/+$/, '');
  const link = `${base}/invite/${token}`;
  await sendEmail({
    to: email,
    subject: `You're invited to ${req.tenant.business_name} on SoCal Receptionist`,
    html: `<p>You've been invited to join <strong>${req.tenant.business_name}</strong> as a ${role}.</p>
           <p><a href="${link}">Accept your invitation</a> and set up your account. This link expires in 7 days.</p>`,
    text: `You've been invited to join ${req.tenant.business_name} as a ${role}. Accept: ${link} (expires in 7 days).`,
  });

  // Return the link too, so the owner can copy/share it even if email is unavailable.
  res.json({ user: data, invite_link: link });
});

// PATCH /admin/users/:id — change a member's role (owner only).
router.patch('/users/:id', requireAal2, requireTenantOwner, express.json(), async (req, res) => {
  const role = req.body.role === 'owner' ? 'owner' : 'admin';
  const { data, error } = await supabase
    .from('tenant_members')
    .update({ role })
    .eq('id', req.params.id).eq('tenant_id', req.tenant.id)
    .select('id, email, full_name, role, status').maybeSingle();
  if (error) {
    console.error('[admin] update member failed:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
  if (!data) return res.status(404).json({ error: 'Member not found.' });
  res.json({ user: data });
});

// DELETE /admin/users/:id — remove a member or pending invite (owner only).
router.delete('/users/:id', requireAal2, requireTenantOwner, async (req, res) => {
  const { data: target } = await supabase
    .from('tenant_members')
    .select('id, role').eq('id', req.params.id).eq('tenant_id', req.tenant.id).maybeSingle();
  if (!target) return res.status(404).json({ error: 'Member not found.' });
  if (target.role === 'owner') {
    const { count } = await supabase
      .from('tenant_members')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', req.tenant.id).eq('role', 'owner').eq('status', 'active');
    if ((count || 0) <= 1) return res.status(400).json({ error: 'Cannot remove the last owner.' });
  }
  const { error } = await supabase
    .from('tenant_members').delete().eq('id', req.params.id).eq('tenant_id', req.tenant.id);
  if (error) {
    console.error('[admin] remove member failed:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
  res.json({ ok: true });
});

module.exports = router;
