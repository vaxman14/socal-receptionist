// Practice management integration OAuth routes.
// Mounted at /integrations in the main server.
//
// Supported providers: clio, mycase
// Flow: /connect → provider OAuth screen → /callback → tokens stored in DB

const express = require('express');
const crypto = require('crypto');
const { requireAuth, requireTenant, requireAal2 } = require('../lib/auth');
const { supabase } = require('../lib/supabase');
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

// Use APP_BASE_URL so the redirect is never influenced by a spoofed Host header.
function baseUrl() {
  return process.env.APP_BASE_URL
    ? process.env.APP_BASE_URL.replace(/\/+$/, '')
    : 'https://app.socalreceptionist.com';
}

// ---------------------------------------------------------------------------
// HMAC-signed OAuth state helpers (issue #1 — unsigned state)
// ---------------------------------------------------------------------------
const STATE_SECRET = process.env.OAUTH_STATE_SECRET || process.env.SUPABASE_SERVICE_KEY || 'change-me';
const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

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
  return parsed;
}

// ---------------------------------------------------------------------------
// Token encryption helpers (issue #13 — tokens plaintext in DB)
// ---------------------------------------------------------------------------
const ENCRYPTION_KEY_HEX = process.env.TOKEN_ENCRYPTION_KEY || '';

function encryptToken(plaintext) {
  if (!ENCRYPTION_KEY_HEX || !plaintext) return plaintext;
  const key = Buffer.from(ENCRYPTION_KEY_HEX, 'hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

function decryptToken(value) {
  if (!ENCRYPTION_KEY_HEX || !value || !value.startsWith('enc:')) return value;
  const [, ivHex, tagHex, encHex] = value.split(':');
  const key = Buffer.from(ENCRYPTION_KEY_HEX, 'hex');
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const enc = Buffer.from(encHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(enc).toString('utf8') + decipher.final('utf8');
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

  // State is HMAC-signed (issue #1) so it cannot be forged or replayed.
  const state = signState({
    tenantId: req.tenant.id,
    userId: req.user.id,
    provider: req.params.provider,
    nonce: crypto.randomBytes(16).toString('hex'),
  });

  const appBase = process.env.APP_BASE_URL || 'https://app.socalreceptionist.com';
  const callbackBase = appBase.includes('localhost') ? `http://localhost:${process.env.PORT || 8080}` : appBase;
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
    const appBase = process.env.APP_BASE_URL || 'https://app.socalreceptionist.com';
    const callbackBase = appBase.includes('localhost') ? `http://localhost:${process.env.PORT || 8080}` : appBase;
    const tokens = await provider.exchangeCode(code, callbackBase);
    const extra = tokens.access_token ? await provider.getAccountInfo(tokens.access_token).catch(() => ({})) : {};

    // Encrypt tokens before storing (issue #13)
    const encryptedTokens = {
      ...tokens,
      access_token: encryptToken(tokens.access_token),
      refresh_token: encryptToken(tokens.refresh_token),
    };
    await provider.saveTokens(tenantId, encryptedTokens, extra);

    // Redirect to settings page in the SPA — always use APP_BASE_URL (issue #14)
    const redirectBase = process.env.APP_BASE_URL || 'https://app.socalreceptionist.com';
    res.redirect(`${redirectBase}/settings?integration=${req.params.provider}&status=connected`);
  } catch (err) {
    console.error(`[integrations/${req.params.provider}] callback error:`, err.message);
    const redirectBase = process.env.APP_BASE_URL || 'https://app.socalreceptionist.com';
    res.redirect(`${redirectBase}/settings?integration=${req.params.provider}&status=error`);
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
