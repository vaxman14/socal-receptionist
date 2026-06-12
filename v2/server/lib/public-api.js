// Public API support — per-tenant API keys + outbound webhooks (db/012).
//
// Keys are random 32-byte tokens shown once at creation; only the SHA-256
// hash is stored. validateApiKey() is the auth path for /api/v1 requests.

const crypto = require('crypto');
const { supabase } = require('./supabase');
const logger = require('./logger');

const KEY_PREFIX = 'sk_live_';

function hashKey(plaintext) {
  return crypto.createHash('sha256').update(plaintext).digest('hex');
}

// --- Keys --------------------------------------------------------------------

async function createApiKey(tenantId, label) {
  const plaintext = KEY_PREFIX + crypto.randomBytes(32).toString('hex');
  const { data, error } = await supabase
    .from('api_keys')
    .insert({
      tenant_id: tenantId,
      key_hash: hashKey(plaintext),
      key_prefix: plaintext.slice(0, 12),
      label: label || 'API key',
    })
    .select('id, key_prefix, label, created_at')
    .single();
  if (error) throw error;
  // plaintext is returned exactly once and never persisted
  return { ...data, key: plaintext };
}

async function listApiKeys(tenantId) {
  const { data, error } = await supabase
    .from('api_keys')
    .select('id, key_prefix, label, created_at, last_used_at, revoked_at')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

async function revokeApiKey(tenantId, keyId) {
  const { data, error } = await supabase
    .from('api_keys')
    .update({ revoked_at: new Date().toISOString() })
    .eq('tenant_id', tenantId)
    .eq('id', keyId)
    .is('revoked_at', null)
    .select('id')
    .maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

// Resolve a bearer token to its key row, or null. Touches last_used_at
// fire-and-forget so the hot path stays one query.
async function validateApiKey(plaintext) {
  if (!plaintext || !plaintext.startsWith(KEY_PREFIX)) return null;
  const { data, error } = await supabase
    .from('api_keys')
    .select('id, tenant_id, revoked_at')
    .eq('key_hash', hashKey(plaintext))
    .maybeSingle();
  if (error) {
    logger.error('api_key_lookup_failed', { error: error.message });
    return null;
  }
  if (!data || data.revoked_at) return null;
  supabase
    .from('api_keys')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', data.id)
    .then(({ error: e }) => {
      if (e) logger.warn('api_key_touch_failed', { error: e.message });
    });
  return data;
}

// --- Webhooks ------------------------------------------------------------------

async function listWebhooks(tenantId) {
  const { data, error } = await supabase
    .from('api_webhooks')
    .select('id, url, events, created_at, last_status, last_fired_at')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

async function addWebhook(tenantId, url, events) {
  const { data, error } = await supabase
    .from('api_webhooks')
    .insert({ tenant_id: tenantId, url, events })
    .select('id, url, events, created_at')
    .single();
  if (error) throw error;
  return data;
}

async function removeWebhook(tenantId, webhookId) {
  const { data, error } = await supabase
    .from('api_webhooks')
    .delete()
    .eq('tenant_id', tenantId)
    .eq('id', webhookId)
    .select('id')
    .maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

// Deliver an event to every subscribed webhook for the tenant. Never throws —
// callers fire this after their own DB write and must not fail on delivery.
async function fireWebhooks(tenantId, event, payload) {
  try {
    const { data: hooks, error } = await supabase
      .from('api_webhooks')
      .select('id, url, events')
      .eq('tenant_id', tenantId)
      .contains('events', [event]);
    if (error) throw error;
    if (!hooks || !hooks.length) return;

    const body = JSON.stringify({ event, created_at: new Date().toISOString(), data: payload });
    await Promise.allSettled(
      hooks.map(async (hook) => {
        let status = 0;
        try {
          const res = await fetch(hook.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'User-Agent': 'SoCalReceptionist-Webhooks/1.0' },
            body,
            signal: AbortSignal.timeout(5000),
          });
          status = res.status;
        } catch (err) {
          logger.warn('webhook_delivery_failed', { webhookId: hook.id, event, error: err.message });
        }
        await supabase
          .from('api_webhooks')
          .update({ last_status: status || null, last_fired_at: new Date().toISOString() })
          .eq('id', hook.id);
      })
    );
  } catch (err) {
    logger.error('webhook_fire_failed', { tenantId, event, error: err.message });
  }
}

module.exports = {
  createApiKey,
  listApiKeys,
  revokeApiKey,
  validateApiKey,
  listWebhooks,
  addWebhook,
  removeWebhook,
  fireWebhooks,
};
