// API access management — a tenant owner managing their own API keys and
// outbound webhooks for the public REST API (/api/v1).
//
// Mounted at /admin alongside admin/client.js; same auth chain, same rule:
// every query scoped to req.tenant.id.

const express = require('express');
const { requireAuth, requireTenant } = require('../lib/auth');
const {
  createApiKey,
  listApiKeys,
  revokeApiKey,
  listWebhooks,
  addWebhook,
  removeWebhook,
} = require('../lib/public-api');
const logger = require('../lib/logger');

const router = express.Router();
router.use(requireAuth, requireTenant);

const VALID_EVENTS = ['lead.created', 'call.completed'];

// --- API keys ---

router.get('/api-keys', async (req, res) => {
  try {
    res.json({ keys: await listApiKeys(req.tenant.id) });
  } catch (err) {
    logger.error('api_keys_list_failed', { tenantId: req.tenant.id, error: err.message });
    res.status(500).json({ error: 'Failed to list API keys.' });
  }
});

router.post('/api-keys', async (req, res) => {
  const label = (req.body?.label || '').toString().slice(0, 80);
  try {
    const active = (await listApiKeys(req.tenant.id)).filter((k) => !k.revoked_at);
    if (active.length >= 5) {
      return res.status(400).json({ error: 'Key limit reached (5 active). Revoke an old key first.' });
    }
    const key = await createApiKey(req.tenant.id, label);
    res.status(201).json({ message: 'Save this key now — it will not be shown again.', ...key });
  } catch (err) {
    logger.error('api_key_create_failed', { tenantId: req.tenant.id, error: err.message });
    res.status(500).json({ error: 'Failed to create API key.' });
  }
});

router.delete('/api-keys/:id', async (req, res) => {
  try {
    const revoked = await revokeApiKey(req.tenant.id, req.params.id);
    if (!revoked) return res.status(404).json({ error: 'Key not found or already revoked.' });
    res.json({ ok: true });
  } catch (err) {
    logger.error('api_key_revoke_failed', { tenantId: req.tenant.id, error: err.message });
    res.status(500).json({ error: 'Failed to revoke API key.' });
  }
});

// --- Webhooks ---

router.get('/api-webhooks', async (req, res) => {
  try {
    res.json({ webhooks: await listWebhooks(req.tenant.id) });
  } catch (err) {
    logger.error('api_webhooks_list_failed', { tenantId: req.tenant.id, error: err.message });
    res.status(500).json({ error: 'Failed to list webhooks.' });
  }
});

router.post('/api-webhooks', async (req, res) => {
  const { url, events } = req.body || {};
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return res.status(400).json({ error: 'Invalid webhook URL.' });
  }
  if (parsed.protocol !== 'https:') {
    return res.status(400).json({ error: 'Webhook URL must be https.' });
  }
  const wanted = Array.isArray(events) && events.length ? events : VALID_EVENTS;
  if (!wanted.every((e) => VALID_EVENTS.includes(e))) {
    return res.status(400).json({ error: `Events must be among: ${VALID_EVENTS.join(', ')}` });
  }
  try {
    const existing = await listWebhooks(req.tenant.id);
    if (existing.length >= 5) {
      return res.status(400).json({ error: 'Webhook limit reached (5). Remove one first.' });
    }
    res.status(201).json(await addWebhook(req.tenant.id, parsed.toString(), wanted));
  } catch (err) {
    logger.error('api_webhook_add_failed', { tenantId: req.tenant.id, error: err.message });
    res.status(500).json({ error: 'Failed to add webhook.' });
  }
});

router.delete('/api-webhooks/:id', async (req, res) => {
  try {
    const removed = await removeWebhook(req.tenant.id, req.params.id);
    if (!removed) return res.status(404).json({ error: 'Webhook not found.' });
    res.json({ ok: true });
  } catch (err) {
    logger.error('api_webhook_remove_failed', { tenantId: req.tenant.id, error: err.message });
    res.status(500).json({ error: 'Failed to remove webhook.' });
  }
});

module.exports = router;
