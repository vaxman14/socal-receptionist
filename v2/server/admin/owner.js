// Owner super-admin API — Roman's cross-tenant view.
//
// Mounted at /admin/owner. Every route requires a platform_admins membership.
// Unlike the client API these routes are intentionally NOT tenant-scoped.

const express = require('express');
const { supabase } = require('../lib/supabase');
const { requireAuth, requirePlatformAdmin, requireAal2 } = require('../lib/auth');
const {
  DocumentError,
  LEGAL_DOC_SLUGS,
  listDocuments,
  getDocument,
  upsertDocument,
  listContractVersions,
  getCurrentContract,
  createContractVersion,
  publishContractVersion,
} = require('../lib/documents');

const router = express.Router();

router.use(requireAuth, requireAal2, requirePlatformAdmin);

// GET /admin/owner/tenants?page=1&limit=25 — every tenant with a subscription summary.
router.get('/tenants', async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 100);
  const page = Math.max(Number(req.query.page) || 1, 1);
  const offset = (page - 1) * limit;

  const [{ count }, { data, error }] = await Promise.all([
    supabase.from('tenants').select('*', { count: 'exact', head: true }),
    supabase
      .from('tenants')
      .select('*, subscriptions(status, plan, current_period_end, trial_ends_at)')
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1),
  ]);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ tenants: data, total: count ?? 0, page, limit });
});

// GET /admin/owner/tenants/:id — one tenant with billing + phone numbers.
router.get('/tenants/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('tenants')
    .select('*, subscriptions(*), phone_numbers(*)')
    .eq('id', req.params.id)
    .maybeSingle();
  if (error) {
    console.error('[owner] get tenant failed:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
  if (!data) return res.status(404).json({ error: 'tenant not found' });
  res.json({ tenant: data });
});

// ---- Platform-admin write actions (billing / plan / lifecycle) ----

const jsonBody = express.json();
const SUB_STATUS = ['trialing', 'active', 'past_due', 'canceled', 'unpaid', 'incomplete'];
const TENANT_STATUS = ['active', 'suspended_billing', 'suspended_compliance'];

// Update (or create) a tenant's single subscription row.
async function upsertSubscription(tenantId, fields) {
  const { data: existing } = await supabase
    .from('subscriptions').select('id').eq('tenant_id', tenantId).maybeSingle();
  if (existing) {
    return supabase.from('subscriptions')
      .update({ ...fields, updated_at: new Date().toISOString() })
      .eq('tenant_id', tenantId).select().maybeSingle();
  }
  return supabase.from('subscriptions')
    .insert({ tenant_id: tenantId, ...fields }).select().maybeSingle();
}

async function audit(req, tenantId, action, metadata) {
  try {
    await supabase.from('audit_log').insert({
      tenant_id: tenantId, actor_type: 'owner', actor_user_id: req.user.id,
      action, target_type: 'tenant', target_id: tenantId, metadata: metadata || {},
    });
  } catch (e) { console.error('[owner] audit write failed:', e.message); }
}

// PATCH /admin/owner/tenants/:id/billing — edit subscription billing fields.
router.patch('/tenants/:id/billing', jsonBody, async (req, res) => {
  const tenantId = req.params.id;
  const b = req.body || {};
  const fields = {};
  if (b.status !== undefined) {
    if (!SUB_STATUS.includes(b.status)) return res.status(400).json({ error: 'invalid subscription status' });
    fields.status = b.status;
  }
  if (b.trial_ends_at !== undefined) fields.trial_ends_at = b.trial_ends_at || null;
  if (b.current_period_end !== undefined) fields.current_period_end = b.current_period_end || null;
  if (b.cancel_at_period_end !== undefined) fields.cancel_at_period_end = !!b.cancel_at_period_end;
  if (b.setup_paid === true) fields.setup_paid_at = new Date().toISOString();
  if (b.setup_paid === false) fields.setup_paid_at = null;
  if (b.setup_refunded === true) fields.setup_refunded_at = new Date().toISOString();
  if (b.setup_refunded === false) fields.setup_refunded_at = null;
  if (Object.keys(fields).length === 0) return res.status(400).json({ error: 'no billing fields provided' });
  const { data, error } = await upsertSubscription(tenantId, fields);
  if (error) return res.status(500).json({ error: error.message });
  await audit(req, tenantId, 'billing.updated', fields);
  res.json({ subscription: data });
});

// PATCH /admin/owner/tenants/:id/plan — assign plan + optional custom price override.
router.patch('/tenants/:id/plan', jsonBody, async (req, res) => {
  const tenantId = req.params.id;
  const b = req.body || {};
  const fields = {};
  if (b.plan !== undefined) fields.plan = b.plan || null;
  if (b.custom_price_cents !== undefined) {
    if (b.custom_price_cents === null || b.custom_price_cents === '') {
      fields.custom_price_cents = null;
    } else {
      const n = Number(b.custom_price_cents);
      if (!Number.isInteger(n) || n < 0) {
        return res.status(400).json({ error: 'custom_price_cents must be a non-negative integer (cents)' });
      }
      fields.custom_price_cents = n;
    }
  }
  if (Object.keys(fields).length === 0) return res.status(400).json({ error: 'no plan fields provided' });
  const { data, error } = await upsertSubscription(tenantId, fields);
  if (error) return res.status(500).json({ error: error.message });
  await audit(req, tenantId, 'plan.updated', fields);
  res.json({ subscription: data });
});

// PATCH /admin/owner/tenants/:id/status — tenant lifecycle (suspend / reactivate / close).
router.patch('/tenants/:id/status', jsonBody, async (req, res) => {
  const tenantId = req.params.id;
  const status = (req.body || {}).status;
  if (!TENANT_STATUS.includes(status)) return res.status(400).json({ error: 'invalid tenant status' });
  const patch = { status };
  if (status !== 'active') patch.voice_enabled = false;
  const { data, error } = await supabase.from('tenants').update(patch).eq('id', tenantId).select().maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  await audit(req, tenantId, 'tenant.status_changed', { status });
  res.json({ tenant: data });
});

// GET /admin/owner/stats — platform KPIs (tenant mix, billing, volume).
router.get('/stats', async (req, res) => {
  try {
    const [tenants, subs, leads, messages] = await Promise.all([
      supabase.from('tenants').select('status'),
      supabase.from('subscriptions').select('status, plan'),
      supabase.from('leads').select('id', { count: 'exact', head: true }),
      supabase.from('messages').select('id', { count: 'exact', head: true }),
    ]);

    const tenantsByStatus = {};
    for (const t of tenants.data || []) {
      tenantsByStatus[t.status] = (tenantsByStatus[t.status] || 0) + 1;
    }

    const subsByPlan = {};
    let activeOrTrialing = 0;
    for (const s of subs.data || []) {
      if (s.status === 'active' || s.status === 'trialing') activeOrTrialing += 1;
      const key = s.plan || 'unknown';
      subsByPlan[key] = (subsByPlan[key] || 0) + 1;
    }

    res.json({
      tenants: { total: (tenants.data || []).length, by_status: tenantsByStatus },
      subscriptions: {
        total: (subs.data || []).length,
        active_or_trialing: activeOrTrialing,
        by_plan: subsByPlan,
      },
      leads_total: leads.count || 0,
      messages_total: messages.count || 0,
    });
  } catch (err) {
    console.error('[owner] stats failed:', err.message);
    res.status(500).json({ error: 'stats failed' });
  }
});

// GET /admin/owner/conversations/:id/messages — read any tenant's transcript.
router.get('/conversations/:id/messages', async (req, res) => {
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('conversation_id', req.params.id)
    .order('created_at', { ascending: true });
  if (error) {
    console.error('[owner] list messages failed:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
  res.json({ messages: data });
});

// GET /admin/owner/audit-log?page=1&limit=25 — platform-wide audit trail.
router.get('/audit-log', async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 100);
  const page = Math.max(Number(req.query.page) || 1, 1);
  const offset = (page - 1) * limit;

  const [{ count }, { data, error }] = await Promise.all([
    supabase.from('audit_log').select('*', { count: 'exact', head: true }),
    supabase
      .from('audit_log')
      .select('*')
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1),
  ]);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ audit_log: data, total: count ?? 0, page, limit });
});

// ===========================================================================
// Content management — editable policy pages + e-sign contracts.
// This is the backend for the admin's "Documents" menu.
// ===========================================================================

// GET /admin/owner/legal-documents — all policy/info pages (+ which slugs exist).
router.get('/legal-documents', async (req, res) => {
  try {
    const docs = await listDocuments();
    const present = new Set(docs.map((d) => d.slug));
    res.json({
      documents: docs,
      editable_slugs: LEGAL_DOC_SLUGS,
      missing_slugs: LEGAL_DOC_SLUGS.filter((s) => !present.has(s)),
    });
  } catch (err) {
    console.error('[owner] list legal-documents failed:', err.message);
    res.status(500).json({ error: 'could not list documents' });
  }
});

// GET /admin/owner/legal-documents/:slug — one policy page.
router.get('/legal-documents/:slug', async (req, res) => {
  if (!LEGAL_DOC_SLUGS.includes(req.params.slug)) {
    return res.status(404).json({ error: 'unknown document slug' });
  }
  try {
    const doc = await getDocument(req.params.slug);
    if (!doc) return res.status(404).json({ error: 'document not created yet' });
    res.json({ document: doc });
  } catch (err) {
    console.error('[owner] get legal-document failed:', err.message);
    res.status(500).json({ error: 'could not load document' });
  }
});

// PUT /admin/owner/legal-documents/:slug — create or update a policy page.
// body: { title, body }
router.put('/legal-documents/:slug', async (req, res) => {
  try {
    const doc = await upsertDocument(
      req.params.slug,
      { title: req.body.title, body: req.body.body },
      req.user.id
    );
    res.json({ ok: true, document: doc });
  } catch (err) {
    if (err instanceof DocumentError) return res.status(400).json({ error: err.message });
    console.error('[owner] save legal-document failed:', err.message);
    res.status(500).json({ error: 'could not save document' });
  }
});

// GET /admin/owner/contracts — every e-sign contract version (newest first).
router.get('/contracts', async (req, res) => {
  try {
    res.json({ contracts: await listContractVersions() });
  } catch (err) {
    console.error('[owner] list contracts failed:', err.message);
    res.status(500).json({ error: 'could not list contracts' });
  }
});

// GET /admin/owner/contracts/current — the contract clients currently sign.
router.get('/contracts/current', async (req, res) => {
  try {
    res.json({ contract: await getCurrentContract() });
  } catch (err) {
    console.error('[owner] get current contract failed:', err.message);
    res.status(500).json({ error: 'could not load current contract' });
  }
});

// POST /admin/owner/contracts — upload a new contract version.
// body: { version, title, body }. Created NOT current — publish it separately.
router.post('/contracts', async (req, res) => {
  try {
    const contract = await createContractVersion(
      { version: req.body.version, title: req.body.title, body: req.body.body },
      req.user.id
    );
    res.status(201).json({
      ok: true,
      contract,
      note: 'uploaded but not yet live — POST /contracts/:id/publish to make it the signed version',
    });
  } catch (err) {
    if (err instanceof DocumentError) return res.status(400).json({ error: err.message });
    console.error('[owner] create contract failed:', err.message);
    res.status(500).json({ error: 'could not create contract' });
  }
});

// POST /admin/owner/contracts/:id/publish — make a version the live contract.
router.post('/contracts/:id/publish', async (req, res) => {
  try {
    const contract = await publishContractVersion(req.params.id, req.user.id);
    res.json({ ok: true, contract });
  } catch (err) {
    if (err instanceof DocumentError) return res.status(400).json({ error: err.message });
    console.error('[owner] publish contract failed:', err.message);
    res.status(500).json({ error: 'could not publish contract' });
  }
});

// GET /admin/owner/tenants/:id/agreements — executed service agreements.
router.get('/tenants/:id/agreements', async (req, res) => {
  const { data, error } = await supabase
    .from('service_agreements')
    .select('id, contract_version, signer_name, signer_email, signer_title, signed_at, revoked_at')
    .eq('tenant_id', req.params.id)
    .order('signed_at', { ascending: false });
  if (error) {
    console.error('[owner] list agreements failed:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
  res.json({ agreements: data || [] });
});

// POST /admin/owner/agreements/:id/revoke — end an active agreement.
// Signed rows are immutable except revoked_at; revocation is audit-logged.
router.post('/agreements/:id/revoke', async (req, res) => {
  const { data: agreement, error: findErr } = await supabase
    .from('service_agreements')
    .select('id, tenant_id, contract_version, revoked_at')
    .eq('id', req.params.id)
    .maybeSingle();
  if (findErr) {
    console.error('[owner] find agreement failed:', findErr);
    return res.status(500).json({ error: 'Internal server error' });
  }
  if (!agreement) return res.status(404).json({ error: 'agreement not found' });
  if (agreement.revoked_at) return res.status(409).json({ error: 'agreement is already revoked' });

  const { data, error } = await supabase
    .from('service_agreements')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', agreement.id)
    .select('id, contract_version, signed_at, revoked_at')
    .single();
  if (error) {
    console.error('[owner] revoke agreement failed:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }

  await supabase.from('audit_log').insert({
    tenant_id: agreement.tenant_id,
    actor_type: 'owner',
    actor_user_id: req.user.id,
    action: 'agreement.revoked',
    target_type: 'service_agreement',
    target_id: agreement.id,
    metadata: { contract_version: agreement.contract_version, reason: (req.body && req.body.reason) || null },
  });

  res.json({ ok: true, agreement: data });
});

module.exports = router;
