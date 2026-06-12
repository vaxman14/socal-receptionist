// Public REST API v1 — tenant-scoped, authenticated by per-tenant API key.
//
// Mounted at /api/v1. Auth: Authorization: Bearer sk_live_... (created in the
// client admin console). Every query is scoped to the key's tenant_id — the
// backend bypasses RLS, so this scoping IS the isolation boundary.

const express = require('express');
const { supabase } = require('../lib/supabase');
const { validateApiKey } = require('../lib/public-api');

const router = express.Router();

async function requireApiKey(req, res, next) {
  const header = req.headers['authorization'] || '';
  const key = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  if (!key) {
    return res.status(401).json({ error: 'Missing API key. Pass Authorization: Bearer sk_live_...' });
  }
  const record = await validateApiKey(key);
  if (!record) return res.status(401).json({ error: 'Invalid or revoked API key.' });
  req.tenantId = record.tenant_id;
  next();
}

router.use(requireApiKey);

function parsePage(req) {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const since = req.query.since ? new Date(req.query.since) : null;
  if (since && Number.isNaN(since.getTime())) return { error: 'Invalid `since` — pass an ISO 8601 timestamp.' };
  return { limit, offset, since };
}

// --- Leads ---
// GET /api/v1/leads?limit=50&offset=0&since=ISO
router.get('/leads', async (req, res) => {
  const page = parsePage(req);
  if (page.error) return res.status(400).json({ error: page.error });
  let q = supabase
    .from('leads')
    .select('id, customer_phone, customer_name, service_interest, status, notes, created_at, updated_at', { count: 'exact' })
    .eq('tenant_id', req.tenantId)
    .order('created_at', { ascending: false })
    .range(page.offset, page.offset + page.limit - 1);
  if (page.since) q = q.gte('created_at', page.since.toISOString());
  const { data, count, error } = await q;
  if (error) return res.status(500).json({ error: 'Failed to fetch leads.' });
  res.json({ data, total: count, limit: page.limit, offset: page.offset });
});

router.get('/leads/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('leads')
    .select('id, customer_phone, customer_name, service_interest, status, notes, created_at, updated_at')
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id)
    .maybeSingle();
  if (error) return res.status(400).json({ error: 'Invalid lead id.' });
  if (!data) return res.status(404).json({ error: 'Lead not found.' });
  res.json(data);
});

// --- Calls ---
// GET /api/v1/calls?limit=50&offset=0&since=ISO
router.get('/calls', async (req, res) => {
  const page = parsePage(req);
  if (page.error) return res.status(400).json({ error: page.error });
  let q = supabase
    .from('calls')
    .select('id, from_number, to_number, outcome, duration_seconds, transcript, created_at, updated_at', { count: 'exact' })
    .eq('tenant_id', req.tenantId)
    .order('created_at', { ascending: false })
    .range(page.offset, page.offset + page.limit - 1);
  if (page.since) q = q.gte('created_at', page.since.toISOString());
  const { data, count, error } = await q;
  if (error) return res.status(500).json({ error: 'Failed to fetch calls.' });
  res.json({ data, total: count, limit: page.limit, offset: page.offset });
});

router.get('/calls/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('calls')
    .select('id, from_number, to_number, outcome, duration_seconds, transcript, created_at, updated_at')
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id)
    .maybeSingle();
  if (error) return res.status(400).json({ error: 'Invalid call id.' });
  if (!data) return res.status(404).json({ error: 'Call not found.' });
  res.json(data);
});

module.exports = router;
