// Practice management integration OAuth routes.
// Mounted at /integrations in the main server.
//
// Supported providers: clio, mycase
// Flow: /connect → provider OAuth screen → /callback → tokens stored in DB

const express = require('express');
const crypto = require('crypto');
const { requireAuth, requireTenant, requireAal2 } = require('../lib/auth');
const { supabase } = require('../lib/supabase');
const { encryptToken } = require('../lib/token-crypto');
const clio = require('./clio');
const mycase = require('./mycase');

const router = express.Router();

const PROVIDERS = {
  clio: {
    buildAuthUrl: clio.buildAuthUrl,
    exchangeCode: clio.exchangeCode,
    saveTokens: clio.saveTokens,
    getAccountInfo: clio.getFirmInfo,
    disconnect: clio.disconnect,
  },
  mycase: {
    buildAuthUrl: mycase.buildAuthUrl,
    exchangeCode: mycase.exchangeCode,
    saveTokens: mycase.saveTokens,
    getAccountInfo: mycase.getAccountInfo,
    disconnect: mycase.disconnect,
  },
};

// API_PUBLIC_BASE_URL is the backend's own public origin — used for OAuth
// redirect_uri so providers can POST the code back to us. APP_BASE_URL is the
// SPA origin used only for browser redirects after auth completes.
function apiBase() {
  return (
    process.env.API_PUBLIC_BASE_URL ||
    process.env.APP_BASE_URL ||
    'https://socal-receptionist-v2-spbrw.ondigitalocean.app'
  ).replace(/\/+$/, '');
}

function spaBase() {
  return (process.env.APP_BASE_URL || 'https://app.socalreceptionist.com').replace(/\/+$/, '');
}

// ---------------------------------------------------------------------------
// HMAC-signed OAuth state helpers
// ---------------------------------------------------------------------------
// OAUTH_STATE_SECRET must be set when integrations are enabled.
// Fallback to a random per-process secret (safe but state won't survive restarts).
const STATE_SECRET = process.env.OAUTH_STATE_SECRET || (() => {
  if (process.env.NODE_ENV === 'production') {
    console.warn('[integrations] OAUTH_STATE_SECRET not set — OAuth state will not survive restarts');
  }
  return crypto.randomBytes(32).toString('hex');
})();
const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// In-memory nonce store to prevent OAuth state replay within the TTL window.
// Entries are [nonce, expiry] pairs, pruned periodically.
const _usedNonces = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [nonce, expiry] of _usedNonces) {
    if (expiry < now) _usedNonces.delete(nonce);
  }
}, STATE_TTL_MS).unref();

function signState(payload) {
  const data = { ...payload, exp: Date.now() + STATE_TTL_MS };
  const raw = Buffer.from(JSON.stringify(data)).toString('base64url');
  const sig = crypto.createHmac('sha256', STATE_SECRET).update(raw).digest('hex');
  return `${raw}.${sig}`;
}

function verifyState(state) {
  const dot = state.lastIndexOf('.');
  if (dot === -1) throw new Error('malformed state');
  const raw = state.slice(0, dot);
  const sig = state.slice(dot + 1);
  const expected = crypto.createHmac('sha256', STATE_SECRET).update(raw).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))) {
    throw new Error('invalid state signature');
  }
  const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString());
  if (!parsed.exp || Date.now() > parsed.exp) throw new Error('state expired');
  // Enforce single-use: reject replayed nonces within the TTL window.
  if (parsed.nonce) {
    if (_usedNonces.has(parsed.nonce)) throw new Error('state already used');
    _usedNonces.set(parsed.nonce, parsed.exp);
  }
  return parsed;
}

// GET /integrations — list connected integrations for this tenant
router.get('/', requireAuth, requireTenant, async (req, res) => {
  const { data, error } = await supabase
    .from('tenant_integrations')
    .select('provider, enabled, last_sync_at, last_error, extra, created_at')
    .eq('tenant_id', req.tenant.id);
  if (error) return res.status(500).json({ error: 'Internal server error' });
  res.json({ integrations: data });
});

// GET /integrations/:provider/connect — start OAuth flow (MFA required)
router.get('/:provider/connect', requireAuth, requireAal2, requireTenant, (req, res) => {
  const provider = PROVIDERS[req.params.provider];
  if (!provider) return res.status(404).json({ error: 'Unknown provider' });

  const state = signState({
    tenantId: req.tenant.id,
    userId: req.user.id,
    provider: req.params.provider,
    nonce: crypto.randomBytes(16).toString('hex'),
  });

  const callbackBase = apiBase().includes('localhost')
    ? `http://localhost:${process.env.PORT || 8080}`
    : apiBase();
  const url = provider.buildAuthUrl(callbackBase, state);
  res.redirect(url);
});

// GET /integrations/:provider/callback — handle OAuth callback
router.get('/:provider/callback', async (req, res) => {
  const provider = PROVIDERS[req.params.provider];
  if (!provider) return res.status(404).send('Unknown provider');

  const { code, state, error: oauthError } = req.query;
  if (oauthError) return res.status(400).send(`OAuth error: ${oauthError}`);
  if (!code || !state) return res.status(400).send('Missing code or state');

  let tenantId;
  try {
    // Verify HMAC signature + expiry before trusting state content (issue #1)
    const parsed = verifyState(state);
    tenantId = parsed.tenantId;
    if (!tenantId) throw new Error('no tenantId in state');
    // Verify provider in state matches URL param to prevent cross-provider attacks
    if (parsed.provider && parsed.provider !== req.params.provider) {
      throw new Error('provider mismatch in state');
    }
  } catch {
    return res.status(400).send('Invalid state parameter');
  }

  try {
    const callbackBase = apiBase().includes('localhost')
      ? `http://localhost:${process.env.PORT || 8080}`
      : apiBase();
    const tokens = await provider.exchangeCode(code, callbackBase);
    const extra = tokens.access_token ? await provider.getAccountInfo(tokens.access_token).catch(() => ({})) : {};

    // Encrypt tokens before storing in DB.
    const encryptedTokens = {
      ...tokens,
      access_token: encryptToken(tokens.access_token),
      refresh_token: encryptToken(tokens.refresh_token),
    };
    await provider.saveTokens(tenantId, encryptedTokens, extra);

    // Redirect browser back to SPA settings page — use APP_BASE_URL (SPA origin).
    res.redirect(`${spaBase()}/settings?integration=${req.params.provider}&status=connected`);
  } catch (err) {
    console.error(`[integrations/${req.params.provider}] callback error:`, err.message);
    res.redirect(`${spaBase()}/settings?integration=${req.params.provider}&status=error`);
  }
});

// DELETE /integrations/:provider — disconnect (MFA required)
router.delete('/:provider', requireAuth, requireAal2, requireTenant, async (req, res) => {
  const provider = PROVIDERS[req.params.provider];
  if (!provider) return res.status(404).json({ error: 'Unknown provider' });
  try {
    await provider.disconnect(req.tenant.id);
    res.json({ ok: true });
  } catch (err) {
    console.error(`[integrations/${req.params.provider}] disconnect error:`, err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /integrations/:provider/push-ticket/:ticketId — manually push a time ticket (MFA required)
router.post('/:provider/push-ticket/:ticketId', requireAuth, requireAal2, requireTenant, async (req, res) => {
  const providerName = req.params.provider;
  const provider = PROVIDERS[providerName];
  if (!provider) return res.status(404).json({ error: 'Unknown provider' });

  const { data: ticket, error } = await supabase
    .from('time_tickets')
    .select('*')
    .eq('id', req.params.ticketId)
    .eq('tenant_id', req.tenant.id)
    .single();
  if (error || !ticket) return res.status(404).json({ error: 'Ticket not found' });

  try {
    const pushFn = providerName === 'clio' ? clio.pushTimeEntry : mycase.pushTimeEntry;
    const result = await pushFn(req.tenant.id, ticket);
    res.json({ ok: true, result });
  } catch (err) {
    console.error(`[integrations/${providerName}] push-ticket error:`, err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
