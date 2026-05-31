// Practice management integration OAuth routes.
// Mounted at /integrations in the main server.
//
// Supported providers: clio, mycase
// Flow: /connect → provider OAuth screen → /callback → tokens stored in DB

const express = require('express');
const crypto = require('crypto');
const { requireAuth, requireTenant } = require('../lib/auth');
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

function baseUrl(req) {
  return `${req.protocol}://${req.get('host')}`;
}

// GET /integrations — list connected integrations for this tenant
router.get('/', requireAuth, requireTenant, async (req, res) => {
  const { data, error } = await supabase
    .from('tenant_integrations')
    .select('provider, enabled, last_sync_at, last_error, extra, created_at')
    .eq('tenant_id', req.tenant.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ integrations: data });
});

// GET /integrations/:provider/connect — start OAuth flow
router.get('/:provider/connect', requireAuth, requireTenant, (req, res) => {
  const provider = PROVIDERS[req.params.provider];
  if (!provider) return res.status(404).json({ error: 'Unknown provider' });

  // Encode tenantId + random nonce in the state param so callback can recover context
  const state = Buffer.from(JSON.stringify({
    tenantId: req.tenant.id,
    nonce: crypto.randomBytes(16).toString('hex'),
  })).toString('base64url');

  const url = provider.buildAuthUrl(baseUrl(req), state);
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
    const parsed = JSON.parse(Buffer.from(state, 'base64url').toString());
    tenantId = parsed.tenantId;
    if (!tenantId) throw new Error('no tenantId in state');
  } catch {
    return res.status(400).send('Invalid state parameter');
  }

  try {
    const tokens = await provider.exchangeCode(code, baseUrl(req));
    const extra = tokens.access_token ? await provider.getAccountInfo(tokens.access_token).catch(() => ({})) : {};
    await provider.saveTokens(tenantId, tokens, extra);

    // Redirect to settings page in the SPA
    const appBase = process.env.APP_BASE_URL || 'https://app.socalreceptionist.com';
    res.redirect(`${appBase}/settings?integration=${req.params.provider}&status=connected`);
  } catch (err) {
    console.error(`[integrations/${req.params.provider}] callback error:`, err.message);
    const appBase = process.env.APP_BASE_URL || 'https://app.socalreceptionist.com';
    res.redirect(`${appBase}/settings?integration=${req.params.provider}&status=error&msg=${encodeURIComponent(err.message)}`);
  }
});

// DELETE /integrations/:provider — disconnect
router.delete('/:provider', requireAuth, requireTenant, async (req, res) => {
  const provider = PROVIDERS[req.params.provider];
  if (!provider) return res.status(404).json({ error: 'Unknown provider' });
  try {
    await provider.disconnect(req.tenant.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /integrations/:provider/push-ticket/:ticketId — manually push a time ticket
router.post('/:provider/push-ticket/:ticketId', requireAuth, requireTenant, async (req, res) => {
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
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
