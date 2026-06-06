// Public REST API — v1
// Auth: Bearer API key in Authorization header
// Mount at /api/v1 in server.js

const express = require('express');
const { getLeads, getCalls, getApiKeys, createApiKey, revokeApiKey, getWebhooks, addWebhook, removeWebhook } = require('./api-store');

const router = express.Router();

// --- Auth middleware ---
function requireApiKey(req, res, next) {
  const header = req.headers['authorization'] || '';
  const key = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  if (!key) return res.status(401).json({ error: 'Missing API key. Pass Authorization: Bearer sk_...' });
  const { validateApiKey } = require('./api-store');
  const record = validateApiKey(key);
  if (!record) return res.status(401).json({ error: 'Invalid or revoked API key.' });
  req.apiKey = record;
  next();
}

// --- Leads ---
// GET /api/v1/leads?limit=50&offset=0&since=ISO
router.get('/leads', requireApiKey, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 500);
  const offset = parseInt(req.query.offset) || 0;
  const since = req.query.since ? new Date(req.query.since) : null;
  let leads = getLeads();
  if (since) leads = leads.filter(l => new Date(l.timestamp) >= since);
  const total = leads.length;
  res.json({ data: leads.slice(offset, offset + limit), total, limit, offset });
});

// GET /api/v1/leads/:id
router.get('/leads/:id', requireApiKey, (req, res) => {
  const lead = getLeads().find(l => l.id === req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead not found.' });
  res.json(lead);
});

// --- Calls ---
// GET /api/v1/calls?limit=50&offset=0&since=ISO
router.get('/calls', requireApiKey, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 500);
  const offset = parseInt(req.query.offset) || 0;
  const since = req.query.since ? new Date(req.query.since) : null;
  let calls = getCalls();
  if (since) calls = calls.filter(c => new Date(c.timestamp) >= since);
  const total = calls.length;
  res.json({ data: calls.slice(offset, offset + limit), total, limit, offset });
});

// GET /api/v1/calls/:id
router.get('/calls/:id', requireApiKey, (req, res) => {
  const call = getCalls().find(c => c.id === req.params.id);
  if (!call) return res.status(404).json({ error: 'Call not found.' });
  res.json(call);
});

// --- API Keys (internal management — no auth required, use internal token) ---
const INTERNAL_TOKEN = process.env.API_ADMIN_TOKEN;

function requireInternalToken(req, res, next) {
  if (!INTERNAL_TOKEN) return res.status(503).json({ error: 'API management not configured. Set API_ADMIN_TOKEN env var.' });
  if (req.headers['x-admin-token'] !== INTERNAL_TOKEN) return res.status(403).json({ error: 'Forbidden.' });
  next();
}

router.get('/keys', requireInternalToken, (req, res) => {
  res.json(getApiKeys().map(k => ({ ...k, key: k.key.slice(0, 10) + '...' })));
});

router.post('/keys', requireInternalToken, express.json(), (req, res) => {
  const { label } = req.body || {};
  const key = createApiKey(label || 'API Key');
  res.status(201).json({ message: 'Save this key — it will not be shown again.', ...key });
});

router.delete('/keys/:id', requireInternalToken, (req, res) => {
  revokeApiKey(req.params.id);
  res.json({ message: 'Key revoked.' });
});

// --- Webhooks ---
router.get('/webhooks', requireApiKey, (req, res) => {
  res.json(getWebhooks());
});

router.post('/webhooks', requireApiKey, express.json(), (req, res) => {
  const { url, events, label } = req.body || {};
  if (!url || !url.startsWith('https://')) return res.status(400).json({ error: 'url must be a valid https URL.' });
  const hook = addWebhook({ url, events, label });
  res.status(201).json(hook);
});

router.delete('/webhooks/:id', requireApiKey, (req, res) => {
  removeWebhook(req.params.id);
  res.json({ message: 'Webhook removed.' });
});

// --- Ping ---
router.get('/ping', requireApiKey, (req, res) => {
  res.json({ ok: true, key: req.apiKey.label, timestamp: new Date().toISOString() });
});

module.exports = router;
