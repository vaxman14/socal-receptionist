// Client admin API — a tenant owner managing their own business.
//
// Mounted at /admin. Every route runs requireAuth + requireTenant, and every
// query is explicitly scoped to req.tenant.id — the backend bypasses RLS, so
// this scoping IS the tenant-isolation boundary for the admin surface.

const express = require('express');
const { supabase } = require('../lib/supabase');
const { requireAuth, requireTenant } = require('../lib/auth');
const { createCheckoutSession, createPortalSession } = require('../lib/billing');
const { listTickets, updateTicket, bulkAccept, exportCsv } = require('../lib/time-tickets');
const { listLeads: listOutboundLeads, createLead, bulkCreateLeads, updateLead, deleteLead } = require('../lib/outbound-leads');

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

// POST /admin/billing/checkout — start a subscription. Billed as a one-time
// setup fee (includes month one) plus the recurring monthly price, which is
// deferred 30 days via a trial.
router.post('/billing/checkout', async (req, res) => {
  try {
    const priceId = req.body.priceId || process.env.STRIPE_PRICE_ID;
    if (!priceId) return res.status(400).json({ error: 'no plan price configured' });
    const setupPriceId = req.body.setupPriceId || process.env.STRIPE_SETUP_PRICE_ID;
    const base = process.env.APP_BASE_URL || '';
    const session = await createCheckoutSession({
      tenant: req.tenant,
      priceId,
      setupPriceId,
      successUrl: req.body.successUrl || `${base}/billing/success`,
      cancelUrl: req.body.cancelUrl || `${base}/billing/cancel`,
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

// ---------------------------------------------------------------------------
// Time tickets
// ---------------------------------------------------------------------------

// GET /admin/time-tickets?status=draft|accepted|rejected
router.get('/time-tickets', async (req, res) => {
  try {
    const tickets = await listTickets(req.tenant.id, { status: req.query.status });
    res.json({ tickets });
  } catch (err) {
    console.error('[admin] list tickets failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /admin/time-tickets/:id — accept/edit a ticket
router.patch('/time-tickets/:id', express.json(), async (req, res) => {
  try {
    const ticket = await updateTicket(req.params.id, req.tenant.id, req.body);
    res.json({ ticket });
  } catch (err) {
    console.error('[admin] update ticket failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /admin/time-tickets/:id — reject a ticket
router.delete('/time-tickets/:id', async (req, res) => {
  try {
    await updateTicket(req.params.id, req.tenant.id, { status: 'rejected' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /admin/time-tickets/bulk-approve — accept all drafts
router.post('/time-tickets/bulk-approve', express.json(), async (req, res) => {
  try {
    const count = await bulkAccept(req.tenant.id);
    res.json({ accepted: count });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
  }
});

// POST /admin/outbound-leads — create single lead
router.post('/outbound-leads', express.json(), async (req, res) => {
  try {
    const lead = await createLead(req.tenant.id, req.body);
    res.status(201).json({ lead });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /admin/outbound-leads/bulk — import array of leads
router.post('/outbound-leads/bulk', express.json(), async (req, res) => {
  const rows = req.body?.leads;
  if (!Array.isArray(rows) || !rows.length) {
    return res.status(400).json({ error: 'leads array required' });
  }
  try {
    const created = await bulkCreateLeads(req.tenant.id, rows);
    res.status(201).json({ created: created.length, leads: created });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /admin/outbound-leads/:id
router.patch('/outbound-leads/:id', express.json(), async (req, res) => {
  try {
    const lead = await updateLead(req.tenant.id, req.params.id, req.body);
    res.json({ lead });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /admin/outbound-leads/:id
router.delete('/outbound-leads/:id', async (req, res) => {
  try {
    await deleteLead(req.tenant.id, req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /admin/outbound-leads/:id/call — trigger an outbound call
router.post('/outbound-leads/:id/call', async (req, res) => {
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
  try {
    const baseUrl = `${req.protocol}://${req.get('host')}`;
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
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
