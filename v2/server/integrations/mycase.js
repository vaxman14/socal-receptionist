// MyCase practice management integration.
// MyCase API: https://api.mycase.com/api/v2
//
// OAuth2 authorization code flow (same pattern as Clio):
//   1. GET /integrations/mycase/connect  → redirect to MyCase OAuth
//   2. GET /integrations/mycase/callback → exchange code, store tokens
//
// Time entry push:
//   pushTimeEntry(tenantId, ticket) → creates a Time Entry in MyCase

const fetch = require('node-fetch');
const { supabase } = require('../lib/supabase');
const { encryptToken, decryptToken } = require('../lib/token-crypto');

const MYCASE_BASE = 'https://api.mycase.com/api/v2';
const MYCASE_AUTH_URL = 'https://auth.mycase.com/oauth2/authorize';
const MYCASE_TOKEN_URL = 'https://auth.mycase.com/oauth2/token';

const CLIENT_ID = process.env.MYCASE_CLIENT_ID || '';
const CLIENT_SECRET = process.env.MYCASE_CLIENT_SECRET || '';

function getRedirectUri(baseUrl) {
  return `${baseUrl}/integrations/mycase/callback`;
}

function buildAuthUrl(baseUrl, state) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: getRedirectUri(baseUrl),
    scope: 'time_entries matters',
    state,
  });
  return `${MYCASE_AUTH_URL}?${params}`;
}

async function exchangeCode(code, baseUrl) {
  const res = await fetch(MYCASE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: getRedirectUri(baseUrl),
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`MyCase token exchange failed: ${res.status} ${body}`);
  }
  return res.json();
}

async function refreshAccessToken(tenantId) {
  const { data: integration } = await supabase
    .from('tenant_integrations')
    .select('refresh_token')
    .eq('tenant_id', tenantId)
    .eq('provider', 'mycase')
    .single();
  if (!integration?.refresh_token) throw new Error('No MyCase refresh token');

  const res = await fetch(MYCASE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: decryptToken(integration.refresh_token),
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  });
  if (!res.ok) throw new Error(`MyCase token refresh failed: ${res.status}`);
  const tokens = await res.json();

  await supabase.from('tenant_integrations').update({
    access_token: encryptToken(tokens.access_token),
    refresh_token: encryptToken(tokens.refresh_token || decryptToken(integration.refresh_token)),
    token_expires_at: new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString(),
    last_error: null,
  }).eq('tenant_id', tenantId).eq('provider', 'mycase');

  return tokens.access_token;
}

async function getAccessToken(tenantId) {
  const { data } = await supabase
    .from('tenant_integrations')
    .select('access_token, token_expires_at')
    .eq('tenant_id', tenantId)
    .eq('provider', 'mycase')
    .single();
  if (!data) throw new Error('MyCase not connected');

  const expires = data.token_expires_at ? new Date(data.token_expires_at) : null;
  const needsRefresh = !expires || expires <= new Date(Date.now() + 5 * 60 * 1000);
  return needsRefresh ? refreshAccessToken(tenantId) : decryptToken(data.access_token);
}

async function saveTokens(tenantId, tokens, extra = {}) {
  await supabase.from('tenant_integrations').upsert({
    tenant_id: tenantId,
    provider: 'mycase',
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    token_expires_at: new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString(),
    extra,
    enabled: true,
  }, { onConflict: 'tenant_id,provider' });
}

async function getAccountInfo(accessToken) {
  const res = await fetch(`${MYCASE_BASE}/users/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return {};
  const body = await res.json();
  return {
    account_id: body.firm_id || body.id || '',
    firm_name: body.firm_name || '',
  };
}

// Push a billable time entry to MyCase.
async function pushTimeEntry(tenantId, ticket) {
  const accessToken = await getAccessToken(tenantId);

  // Look up case/matter by name
  let caseId = null;
  if (ticket.matter_name) {
    const searchRes = await fetch(
      `${MYCASE_BASE}/cases?name=${encodeURIComponent(ticket.matter_name)}&per_page=5`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (searchRes.ok) {
      const body = await searchRes.json();
      caseId = body.cases?.[0]?.id || null;
    }
  }

  const payload = {
    time_entry: {
      date: (ticket.created_at ? new Date(ticket.created_at) : new Date()).toISOString().split('T')[0],
      duration: ticket.billable_mins || 0,
      note: ticket.description || 'Phone call via SoCal Receptionist',
      rate: ticket.hourly_rate ? ticket.hourly_rate / 100 : undefined,
      ...(caseId ? { case_id: caseId } : {}),
    },
  };

  const res = await fetch(`${MYCASE_BASE}/time_entries`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text();
    await supabase.from('tenant_integrations')
      .update({ last_error: `pushTimeEntry failed: ${res.status} ${body.slice(0, 200)}` })
      .eq('tenant_id', tenantId).eq('provider', 'mycase');
    throw new Error(`MyCase push failed: ${res.status}`);
  }

  await supabase.from('tenant_integrations')
    .update({ last_sync_at: new Date().toISOString(), last_error: null })
    .eq('tenant_id', tenantId).eq('provider', 'mycase');

  return res.json();
}

async function disconnect(tenantId) {
  await supabase.from('tenant_integrations')
    .delete()
    .eq('tenant_id', tenantId)
    .eq('provider', 'mycase');
}

module.exports = { buildAuthUrl, exchangeCode, saveTokens, getAccountInfo, pushTimeEntry, disconnect };
