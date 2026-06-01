// Client admin API — a tenant owner managing their own business.
//
// Mounted at /admin. Every route runs requireAuth + requireTenant, and every
// query is explicitly scoped to req.tenant.id — the backend bypasses RLS, so
// this scoping IS the tenant-isolation boundary for the admin surface.

const express = require('express');
const { supabase } = require('../lib/supabase');
const { requireAuth, requireTenant, requireAal2 } = require('../lib/auth');
const { createCheckoutSession, createPortalSession } = require('../lib/billing');
const { listTickets, updateTicket, bulkAccept, exportCsv } = require('../lib/time-tickets');
const { listLeads: listOutboundLeads, createLead, bulkCreateLeads, updateLead, deleteLead } = require('../lib/outbound-leads');

// ---------------------------------------------------------------------------
// Server-side price ID allowlist (issue #3 — client-supplied price IDs)
// ---------------------------------------------------------------------------
const ALLOWED_PRICE_IDS = new Set([
  process.env.STRIPE_PRICE_ID_ESSENTIALS,
  process.env.STRIPE_PRICE_ID_ESSENTIALS_ANNUAL,
  process.env.STRIPE_PRICE_ID_CONCIERGE,
  process.env.STRIPE_PRICE_ID_CONCIERGE_ANNUAL,
  // Legacy single-price fallback
  process.env.STRIPE_PRICE_ID,
].filter(Boolean));

const ALLOWED_SETUP_PRICE_IDS = new Set([
  process.env.STRIPE_SETUP_PRICE_ID_CONCIERGE,
  process.env.STRIPE_SETUP_PRICE_ID,
].filter(Boolean));

// Named plan keys — frontend sends a plan name, backend resolves price IDs.
const PLAN_PRICE_MAP = {
  essentials_monthly: process.env.STRIPE_PRICE_ID_ESSENTIALS,
  essentials_annual: process.env.STRIPE_PRICE_ID_ESSENTIALS_ANNUAL,
  concierge_monthly: process.env.STRIPE_PRICE_ID_CONCIERGE,
  concierge_annual: process.env.STRIPE_PRICE_ID_CONCIERGE_ANNUAL,
};

const PLAN_SETUP_MAP = {
  concierge_monthly: process.env.STRIPE_SETUP_PRICE_ID_CONCIERGE,
  concierge_annual: process.env.STRIPE_SETUP_PRICE_ID_CONCIERGE,
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
  // Voice receptionist config.
  'voice_enabled',
  'staff_phone',      // "press 2 / speak to staff" transfer target
  'voice_greeting',
  'voicemail_email',
  'voice_id',         // Twilio Polly Neural voice selection
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
      const err = await response.text();
      return res.status(502).json({ error: 'TTS failed', detail: err });
    }
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    const buf = await response.arrayBuffer();
    res.send(Buffer.from(buf));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /admin/tenant — update business config (whitelisted fields only).
router.patch('/tenant', requireAal2, async (req, res) => {
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
  if (error) {
    console.error('[admin] update tenant failed:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
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
  if (error) {
    console.error('[admin] list leads failed:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
  res.json({ leads: data });
});

// GET /admin/calls — this tenant's inbound calls, newest first.
router.get('/calls', async (req, res) => {
  const { data, error } = await supabase
    .from('calls')
    .select('*')
    .eq('tenant_id', req.tenant.id)
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) {
    console.error('[admin] list calls failed:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
  res.json({ calls: data });
});

// POST /admin/billing/checkout — start a subscription. Billed as a one-time
// setup fee (includes month one) plus the recurring monthly price, which is
// deferred 30 days via a trial.
// SECURITY: priceId and setupPriceId are validated against a server-side
// allowlist — client-supplied IDs are never used directly (issue #3).
// successUrl and cancelUrl are always derived from APP_BASE_URL (issue #14).
router.post('/billing/checkout', requireAal2, async (req, res) => {
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

    // Build redirect URLs server-side from APP_BASE_URL — never trust the client
    const base = (process.env.APP_BASE_URL || '').replace(/\/+$/, '');
    const session = await createCheckoutSession({
      tenant: req.tenant,
      priceId,
      setupPriceId,
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
router.post('/billing/portal', requireAal2, async (req, res) => {
  try {
    const { data: sub } = await supabase
      .from('subscriptions')
      .select('stripe_customer_id')
      .eq('tenant_id', req.tenant.id)
      .maybeSingle();
    if (!sub || !sub.stripe_customer_id) {
      return res.status(400).json({ error: 'no billing account yet' });
    }
    const base = (process.env.APP_BASE_URL || '').replace(/\/+$/, '');
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

// Also fix the PATCH /admin/tenant error response
module.exports = router;
