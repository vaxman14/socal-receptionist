// Clio practice management integration.
// Clio API v4: https://app.clio.com/api/v4
//
// OAuth2 authorization code flow:
//   1. GET /integrations/clio/connect  → redirects to Clio OAuth screen
//   2. GET /integrations/clio/callback → exchanges code for tokens, stores in DB
//
// Time entry push:
//   pushTimeEntry(tenantId, ticket) → creates an Activity in Clio

const fetch = require('node-fetch');
const { supabase } = require('../lib/supabase');

const CLIO_BASE = 'https://app.clio.com/api/v4';
const CLIO_AUTH_URL = 'https://app.clio.com/oauth/authorize';
const CLIO_TOKEN_URL = 'https://app.clio.com/oauth/token';

const CLIENT_ID = process.env.CLIO_CLIENT_ID || '';
const CLIENT_SECRET = process.env.CLIO_CLIENT_SECRET || '';

function getRedirectUri(baseUrl) {
  return `${baseUrl}/integrations/clio/callback`;
}

function buildAuthUrl(baseUrl, state) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: getRedirectUri(baseUrl),
    state,
  });
  return `${CLIO_AUTH_URL}?${params}`;
}

async function exchangeCode(code, baseUrl) {
  const res = await fetch(CLIO_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: getRedirectUri(baseUrl),
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Clio token exchange failed: ${res.status} ${body}`);
  }
  return res.json();
}

async function refreshAccessToken(tenantId) {
  const { data: integration, error } = await supabase
    .from('tenant_integrations')
    .select('refresh_token')
    .eq('tenant_id', tenantId)
    .eq('provider', 'clio')
    .single();
  if (error || !integration?.refresh_token) throw new Error('No Clio refresh token found');

  const res = await fetch(CLIO_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: integration.refresh_token,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  });
  if (!res.ok) throw new Error(`Clio token refresh failed: ${res.status}`);
  const tokens = await res.json();

  await supabase.from('tenant_integrations').update({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token || integration.refresh_token,
    token_expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
    last_error: null,
  }).eq('tenant_id', tenantId).eq('provider', 'clio');

  return tokens.access_token;
}

async function getAccessToken(tenantId) {
  const { data, error } = await supabase
    .from('tenant_integrations')
    .select('access_token, token_expires_at')
    .eq('tenant_id', tenantId)
    .eq('provider', 'clio')
    .single();
  if (error || !data) throw new Error('Clio not connected');

  const expires = data.token_expires_at ? new Date(data.token_expires_at) : null;
  const needsRefresh = !expires || expires <= new Date(Date.now() + 5 * 60 * 1000);
  return needsRefresh ? refreshAccessToken(tenantId) : data.access_token;
}

async function saveTokens(tenantId, tokens, extra = {}) {
  await supabase.from('tenant_integrations').upsert({
    tenant_id: tenantId,
    provider: 'clio',
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    token_expires_at: new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString(),
    extra,
    enabled: true,
  }, { onConflict: 'tenant_id,provider' });
}

async function getFirmInfo(accessToken) {
  const res = await fetch(`${CLIO_BASE}/users/who_am_i.json`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return {};
  const body = await res.json();
  return {
    firm_name: body.data?.account?.name || '',
    user_name: body.data?.name || '',
  };
}

// Push a billable time entry (time_ticket) to Clio as an Activity.
// ticket fields: client_name, matter_name, description, billable_mins, hourly_rate, activity
async function pushTimeEntry(tenantId, ticket) {
  const accessToken = await getAccessToken(tenantId);

  // Clio requires a Matter reference. We look up by matter name — if not found,
  // we'll create the entry on the default matter or skip gracefully.
  let matterId = null;
  if (ticket.matter_name) {
    const searchRes = await fetch(
      `${CLIO_BASE}/matters.json?query=${encodeURIComponent(ticket.matter_name)}&fields=id,display_number,description`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (searchRes.ok) {
      const body = await searchRes.json();
      matterId = body.data?.[0]?.id || null;
    }
  }

  const payload = {
    data: {
      type: 'TimeEntry',
      date: (ticket.created_at ? new Date(ticket.created_at) : new Date()).toISOString().split('T')[0],
      quantity: (ticket.billable_mins || 0) * 60, // Clio uses seconds
      price: ticket.hourly_rate ? ticket.hourly_rate / 100 : undefined,
      note: ticket.description || 'Phone call via SoCal Receptionist',
      ...(matterId ? { matter: { id: matterId } } : {}),
    },
  };

  const res = await fetch(`${CLIO_BASE}/activities.json`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text();
    // Store last error on the integration row for debugging
    await supabase.from('tenant_integrations')
      .update({ last_error: `pushTimeEntry failed: ${res.status} ${body.slice(0, 200)}` })
      .eq('tenant_id', tenantId).eq('provider', 'clio');
    throw new Error(`Clio push failed: ${res.status}`);
  }

  await supabase.from('tenant_integrations')
    .update({ last_sync_at: new Date().toISOString(), last_error: null })
    .eq('tenant_id', tenantId).eq('provider', 'clio');

  return res.json();
}

async function disconnect(tenantId) {
  await supabase.from('tenant_integrations')
    .delete()
    .eq('tenant_id', tenantId)
    .eq('provider', 'clio');
}

module.exports = { buildAuthUrl, exchangeCode, saveTokens, getFirmInfo, pushTimeEntry, disconnect };
