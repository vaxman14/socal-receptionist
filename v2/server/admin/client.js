// Client admin API — a tenant owner managing their own business.
//
// Mounted at /admin. Every route runs requireAuth + requireTenant, and every
// query is explicitly scoped to req.tenant.id — the backend bypasses RLS, so
// this scoping IS the tenant-isolation boundary for the admin surface.

const express = require('express');
const { supabase } = require('../lib/supabase');
const { requireAuth, requireTenant } = require('../lib/auth');
const { createCheckoutSession, createPortalSession } = require('../lib/billing');

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
  // Voice receptionist config.
  'voice_enabled',
  'voice_id',
  'staff_phone',      // "press 2 / speak to staff" transfer target
  'voice_greeting',
  'voicemail_email',
];

const ALLOWED_VOICE_IDS = new Set([
  'Polly.Joanna-Neural',
  'Polly.Ruth-Neural',
  'Polly.Kendra-Neural',
  'Polly.Salli-Neural',
  'Polly.Matthew-Neural',
  'Polly.Stephen-Neural',
  'Polly.Amy-Neural',
  'Polly.Brian-Neural',
]);

router.use(requireAuth, requireTenant);

const E164_RE = /^\+[1-9]\d{7,14}$/;
const MAX_PROMPT_LEN = 4000;

function validateTenantPatch(patch) {
  if (patch.staff_phone !== undefined && patch.staff_phone !== null && patch.staff_phone !== '') {
    if (!E164_RE.test(patch.staff_phone)) return 'staff_phone must be E.164 format (e.g. +15551234567)';
  }
  if (patch.calendly_link !== undefined && patch.calendly_link !== null && patch.calendly_link !== '') {
    try { const u = new URL(patch.calendly_link); if (!['http:', 'https:'].includes(u.protocol)) throw new Error(); }
    catch { return 'calendly_link must be a valid https URL'; }
  }
  if (patch.voicemail_email !== undefined && patch.voicemail_email !== null && patch.voicemail_email !== '') {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(patch.voicemail_email)) return 'voicemail_email must be a valid email address';
  }
  if (patch.ai_system_prompt && patch.ai_system_prompt.length > MAX_PROMPT_LEN) {
    return `ai_system_prompt must be ${MAX_PROMPT_LEN} characters or less`;
  }
  if (patch.voice_id !== undefined && patch.voice_id !== null && !ALLOWED_VOICE_IDS.has(patch.voice_id)) {
    return `voice_id must be one of: ${[...ALLOWED_VOICE_IDS].join(', ')}`;
  }
  return null;
}

// GET /admin/me — account, tenant, subscription.
router.get('/me', async (req, res) => {
  const { data: subscription } = await supabase
    .from('subscriptions')
    .select('*')
    .eq('tenant_id', req.tenant.id)
    .maybeSingle();
  res.json({
    user: { id: req.user.id, email: req.user.email },
    tenant: req.tenant,
    subscription: subscription || null,
  });
});

// PATCH /admin/tenant — update business config (whitelisted fields only).
router.patch('/tenant', async (req, res) => {
  const patch = {};
  for (const field of EDITABLE_FIELDS) {
    if (req.body[field] !== undefined) patch[field] = req.body[field];
  }
  if (!Object.keys(patch).length) {
    return res.status(400).json({ error: 'no editable fields supplied' });
  }
  const validationError = validateTenantPatch(patch);
  if (validationError) return res.status(400).json({ error: validationError });
  const { data, error } = await supabase
    .from('tenants')
    .update(patch)
    .eq('id', req.tenant.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ tenant: data });
});

// GET /admin/leads — this tenant's leads, newest first.
router.get('/leads', async (req, res) => {
  const { data, error } = await supabase
    .from('leads')
    .select('*')
    .eq('tenant_id', req.tenant.id)
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ leads: data });
});

// GET /admin/conversations — this tenant's conversation threads.
router.get('/conversations', async (req, res) => {
  const { data, error } = await supabase
    .from('conversations')
    .select('*')
    .eq('tenant_id', req.tenant.id)
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .limit(200);
  if (error) return res.status(500).json({ error: error.message });
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
  if (error) return res.status(500).json({ error: error.message });
  res.json({ messages: data });
});

// GET /admin/calls — this tenant's inbound calls, newest first.
router.get('/calls', async (req, res) => {
  const { data, error } = await supabase
    .from('calls')
    .select('*')
    .eq('tenant_id', req.tenant.id)
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ calls: data });
});

const PLAN_PRICE_IDS = {
  essentials:          process.env.STRIPE_PRICE_ID_ESSENTIALS,
  concierge:           process.env.STRIPE_PRICE_ID_CONCIERGE,
  essentials_annual:   process.env.STRIPE_PRICE_ID_ESSENTIALS_ANNUAL,
  concierge_annual:    process.env.STRIPE_PRICE_ID_CONCIERGE_ANNUAL,
};

// POST /admin/billing/checkout — start a subscription. Billed as a one-time
// setup fee (includes month one) plus the recurring monthly/annual price.
router.post('/billing/checkout', async (req, res) => {
  try {
    if (!req.user.email_confirmed_at) {
      return res.status(403).json({ error: 'email_not_confirmed', message: 'Please confirm your email before starting a trial.' });
    }
    // Resolve price from server-side plan map only — never trust client-supplied price IDs.
    const planPriceId = req.body.plan ? PLAN_PRICE_IDS[req.body.plan] : null;
    const priceId = planPriceId || process.env.STRIPE_PRICE_ID;
    if (!priceId) return res.status(400).json({ error: 'invalid or missing plan' });
    const basePlan = (req.body.plan || '').replace('_annual', '');
    // Only Concierge has a setup fee — Essentials has none.
    const setupPriceId = basePlan === 'concierge' ? process.env.STRIPE_SETUP_PRICE_ID_CONCIERGE : null;
    const base = process.env.APP_BASE_URL || '';
    const session = await createCheckoutSession({
      tenant: req.tenant,
      priceId,
      setupPriceId,
      successUrl: `${base}/billing/success`,
      cancelUrl: `${base}/billing/cancel`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('[admin] checkout failed:', err.message);
    res.status(500).json({ error: 'checkout failed' });
  }
});

// POST /admin/billing/portal — open the Stripe Customer Portal.
router.post('/billing/portal', async (req, res) => {
  try {
    const { data: sub } = await supabase
      .from('subscriptions')
      .select('stripe_customer_id')
      .eq('tenant_id', req.tenant.id)
      .maybeSingle();
    if (!sub || !sub.stripe_customer_id) {
      return res.status(400).json({ error: 'no billing account yet' });
    }
    const base = process.env.APP_BASE_URL || '';
    const session = await createPortalSession({
      stripeCustomerId: sub.stripe_customer_id,
      returnUrl: `${base}/billing`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('[admin] portal failed:', err.message);
    res.status(500).json({ error: 'portal failed' });
  }
});

module.exports = router;
