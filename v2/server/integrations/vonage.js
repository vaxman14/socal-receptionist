// Vonage Business Communications integration.
// Uses Vonage API Platform OAuth (OIDC-based).
//
//   GET /integrations/vonage/connect  → Vonage login
//   GET /integrations/vonage/callback → exchange code, store tokens
//   POST /integrations/vonage/configure-webhook → set inbound call webhook
//
// After OAuth, configure a webhook on the tenant's Vonage account so inbound
// calls hit our /voice endpoint instead of (or before) their desk phones.

const fetch = require('node-fetch');
const { supabase } = require('../lib/supabase');
const { encryptToken, decryptToken } = require('../lib/token-crypto');

const OIDC_BASE    = 'https://oidc.idp.vonage.com/oauth2';
const API_BASE     = 'https://api.vonage.com/t/vbc.prod/provisioning/v1';

const CLIENT_ID     = process.env.VONAGE_CLIENT_ID     || '';
const CLIENT_SECRET = process.env.VONAGE_CLIENT_SECRET || '';

function getRedirectUri(baseUrl) {
  return `${baseUrl}/integrations/vonage/callback`;
}

function buildAuthUrl(baseUrl, state) {
  const params = new URLSearchParams({
    client_id:     CLIENT_ID,
    response_type: 'code',
    scope:         'openid offline_access',
    redirect_uri:  getRedirectUri(baseUrl),
    state,
  });
  return `${OIDC_BASE}/auth?${params}`;
}

async function exchangeCode(code, baseUrl) {
  const res = await fetch(`${OIDC_BASE}/token`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      grant_type:    'authorization_code',
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri:  getRedirectUri(baseUrl),
      code,
    }),
  });
  if (!res.ok) throw new Error(`Vonage token exchange failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function refreshAccessToken(tenantId) {
  const { data } = await supabase
    .from('tenant_integrations')
    .select('refresh_token')
    .eq('tenant_id', tenantId).eq('provider', 'vonage').single();
  if (!data?.refresh_token) throw new Error('No Vonage refresh token');

  const res = await fetch(`${OIDC_BASE}/token`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      grant_type:    'refresh_token',
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: decryptToken(data.refresh_token),
    }),
  });
  if (!res.ok) throw new Error(`Vonage token refresh failed: ${res.status}`);
  const tokens = await res.json();

  await supabase.from('tenant_integrations').update({
    access_token:     encryptToken(tokens.access_token),
    refresh_token:    encryptToken(tokens.refresh_token || decryptToken(data.refresh_token)),
    token_expires_at: new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString(),
    last_error:       null,
  }).eq('tenant_id', tenantId).eq('provider', 'vonage');

  return tokens.access_token;
}

async function getAccessToken(tenantId) {
  const { data, error } = await supabase
    .from('tenant_integrations')
    .select('access_token, token_expires_at')
    .eq('tenant_id', tenantId).eq('provider', 'vonage').single();
  if (error || !data) throw new Error('Vonage not connected');
  const expires = data.token_expires_at ? new Date(data.token_expires_at) : null;
  const needsRefresh = !expires || expires <= new Date(Date.now() + 5 * 60 * 1000);
  return needsRefresh ? refreshAccessToken(tenantId) : decryptToken(data.access_token);
}

async function saveTokens(tenantId, tokens, extra = {}) {
  await supabase.from('tenant_integrations').upsert({
    tenant_id:        tenantId,
    provider:         'vonage',
    access_token:     encryptToken(tokens.access_token),
    refresh_token:    tokens.refresh_token ? encryptToken(tokens.refresh_token) : null,
    token_expires_at: new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString(),
    extra,
    enabled:          true,
  }, { onConflict: 'tenant_id,provider' });
}

async function getAccountInfo(accessToken) {
  const res = await fetch(`${API_BASE}/accounts`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return {};
  const body = await res.json();
  const account = (body.accounts || [])[0] || {};
  return { account_id: account.account_id, name: account.name };
}

// Set an inbound call webhook on the Vonage account so calls hit our handler.
// webhookUrl should be our public /voice endpoint.
async function configureWebhook(tenantId, webhookUrl) {
  const accessToken = await getAccessToken(tenantId);

  // Get the account ID from extra
  const { data } = await supabase
    .from('tenant_integrations')
    .select('extra')
    .eq('tenant_id', tenantId).eq('provider', 'vonage').single();
  const accountId = data?.extra?.account_id;
  if (!accountId) throw new Error('No Vonage account ID on record — reconnect the integration');

  // Vonage VBC: update call handling webhook via provisioning API
  const res = await fetch(`${API_BASE}/accounts/${accountId}/callHandling`, {
    method:  'PUT',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      primary_handling_order: [{
        type:        'webhook',
        webhook_url: webhookUrl,
        method:      'POST',
      }],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Vonage webhook config failed: ${res.status} ${err}`);
  }

  await supabase.from('tenant_integrations').update({
    last_sync_at: new Date().toISOString(),
    last_error:   null,
    extra:        { ...(data?.extra || {}), webhook_url: webhookUrl },
  }).eq('tenant_id', tenantId).eq('provider', 'vonage');

  return { success: true };
}

async function disconnect(tenantId) {
  await supabase.from('tenant_integrations').delete()
    .eq('tenant_id', tenantId).eq('provider', 'vonage');
}

module.exports = { buildAuthUrl, exchangeCode, saveTokens, getAccountInfo, configureWebhook, disconnect };
