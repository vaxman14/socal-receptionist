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
  'staff_phone',      // "press 2 / speak to staff" transfer target
  'voice_greeting',
  'voicemail_email',
];

router.use(requireAuth, requireTenant);

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
  after_hours: process.env.STRIPE_PRICE_ID_AFTER_HOURS,
  always_on:   process.env.STRIPE_PRICE_ID_ALWAYS_ON,
  total_care:  process.env.STRIPE_PRICE_ID_TOTAL_CARE,
};

// POST /admin/billing/checkout — start a subscription. Billed as a one-time
// setup fee (includes month one) plus the recurring monthly price, which is
// deferred 30 days via a trial.
router.post('/billing/checkout', async (req, res) => {
  try {
    // Resolve price from server-side plan map only — never trust client-supplied price IDs.
    const planPriceId = req.body.plan ? PLAN_PRICE_IDS[req.body.plan] : null;
    const priceId = planPriceId || process.env.STRIPE_PRICE_ID;
    if (!priceId) return res.status(400).json({ error: 'invalid or missing plan' });
    const setupPriceId = process.env.STRIPE_SETUP_PRICE_ID;
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
      returnUrl: req.body.returnUrl || `${base}/billing`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('[admin] portal failed:', err.message);
    res.status(500).json({ error: 'portal failed' });
  }
});

module.exports = router;
