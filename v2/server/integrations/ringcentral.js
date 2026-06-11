// RingCentral integration.
// OAuth2 flow for RingCentral platform.
//
//   GET /integrations/ringcentral/connect  → RingCentral login
//   GET /integrations/ringcentral/callback → exchange code, store tokens
//   POST /integrations/ringcentral/configure-forwarding → set call forwarding rule
//
// After OAuth, configure a forwarding rule that routes calls to our Twilio DID.
// This lets the tenant's RingCentral number ring through to SoCal Receptionist.

const fetch = require('node-fetch');
const { supabase } = require('../lib/supabase');
const { encryptToken, decryptToken } = require('../lib/token-crypto');

const RC_BASE      = 'https://platform.ringcentral.com';
const AUTH_URL     = `${RC_BASE}/restapi/oauth/authorize`;
const TOKEN_URL    = `${RC_BASE}/restapi/oauth/token`;
const API_BASE     = `${RC_BASE}/restapi/v1.0`;

const CLIENT_ID     = process.env.RINGCENTRAL_CLIENT_ID     || '';
const CLIENT_SECRET = process.env.RINGCENTRAL_CLIENT_SECRET || '';

function getRedirectUri(baseUrl) {
  return `${baseUrl}/integrations/ringcentral/callback`;
}

function buildAuthUrl(baseUrl, state) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     CLIENT_ID,
    redirect_uri:  getRedirectUri(baseUrl),
    state,
  });
  return `${AUTH_URL}?${params}`;
}

async function exchangeCode(code, baseUrl) {
  const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const res = await fetch(TOKEN_URL, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/x-www-form-urlencoded',
      Authorization: `Basic ${credentials}`,
    },
    body: new URLSearchParams({
      grant_type:   'authorization_code',
      code,
      redirect_uri: getRedirectUri(baseUrl),
    }),
  });
  if (!res.ok) throw new Error(`RingCentral token exchange failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function refreshAccessToken(tenantId) {
  const { data } = await supabase
    .from('tenant_integrations')
    .select('refresh_token')
    .eq('tenant_id', tenantId).eq('provider', 'ringcentral').single();
  if (!data?.refresh_token) throw new Error('No RingCentral refresh token');

  const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const res = await fetch(TOKEN_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${credentials}` },
    body:    new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: decryptToken(data.refresh_token),
    }),
  });
  if (!res.ok) throw new Error(`RingCentral token refresh failed: ${res.status}`);
  const tokens = await res.json();

  await supabase.from('tenant_integrations').update({
    access_token:     encryptToken(tokens.access_token),
    refresh_token:    encryptToken(tokens.refresh_token || decryptToken(data.refresh_token)),
    token_expires_at: new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString(),
    last_error:       null,
  }).eq('tenant_id', tenantId).eq('provider', 'ringcentral');

  return tokens.access_token;
}

async function getAccessToken(tenantId) {
  const { data, error } = await supabase
    .from('tenant_integrations')
    .select('access_token, token_expires_at')
    .eq('tenant_id', tenantId).eq('provider', 'ringcentral').single();
  if (error || !data) throw new Error('RingCentral not connected');
  const expires = data.token_expires_at ? new Date(data.token_expires_at) : null;
  const needsRefresh = !expires || expires <= new Date(Date.now() + 5 * 60 * 1000);
  return needsRefresh ? refreshAccessToken(tenantId) : decryptToken(data.access_token);
}

async function saveTokens(tenantId, tokens, extra = {}) {
  await supabase.from('tenant_integrations').upsert({
    tenant_id:        tenantId,
    provider:         'ringcentral',
    access_token:     encryptToken(tokens.access_token),
    refresh_token:    encryptToken(tokens.refresh_token),
    token_expires_at: new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString(),
    extra,
    enabled:          true,
  }, { onConflict: 'tenant_id,provider' });
}

async function getAccountInfo(accessToken) {
  const res = await fetch(`${API_BASE}/account/~`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return {};
  const body = await res.json();
  return { account_id: body.id, main_number: body.mainNumber, service_plan: body.servicePlan?.name };
}

// Configure call forwarding on the primary extension so incoming calls
// ring through to our Twilio number (forwardToNumber).
// Uses RingCentral's Forwarding Number + Answering Rule API.
async function configureForwarding(tenantId, forwardToNumber) {
  const accessToken = await getAccessToken(tenantId);

  // Step 1: register our Twilio number as a forwarding number
  const addRes = await fetch(`${API_BASE}/account/~/extension/~/forwarding-number`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      phoneNumber: forwardToNumber,
      label:       'SoCal Receptionist',
      type:        'Other',
    }),
  });

  let forwardingNumberId = null;
  if (addRes.ok) {
    const fn = await addRes.json();
    forwardingNumberId = fn.id;
  } else {
    // Number may already be registered — fetch existing
    const listRes = await fetch(`${API_BASE}/account/~/extension/~/forwarding-number`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (listRes.ok) {
      const list = await listRes.json();
      const existing = (list.records || []).find(r => r.phoneNumber === forwardToNumber);
      forwardingNumberId = existing?.id;
    }
  }

  if (!forwardingNumberId) throw new Error('Could not register forwarding number with RingCentral');

  // Step 2: update the "Business Hours" answering rule to forward to our number
  const ruleRes = await fetch(`${API_BASE}/account/~/extension/~/answering-rule/business-hours-rule`, {
    method:  'PUT',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      forwarding: {
        notifyMySoftPhones:  false,
        notifyAdminSoftPhones: false,
        softPhonesRingCount: 0,
        ringingMode:         'Sequentially',
        rules: [{
          index:            1,
          ringCount:        4,
          forwardingNumbers: [{ id: forwardingNumberId }],
        }],
      },
    }),
  });

  if (!ruleRes.ok) {
    const err = await ruleRes.text();
    throw new Error(`RingCentral answering rule update failed: ${ruleRes.status} ${err}`);
  }

  await supabase.from('tenant_integrations').update({
    last_sync_at: new Date().toISOString(),
    last_error:   null,
    extra:        { forwarding_number_id: forwardingNumberId, forward_to: forwardToNumber },
  }).eq('tenant_id', tenantId).eq('provider', 'ringcentral');

  return { success: true, forwardingNumberId };
}

async function disconnect(tenantId) {
  await supabase.from('tenant_integrations').delete()
    .eq('tenant_id', tenantId).eq('provider', 'ringcentral');
}

module.exports = { buildAuthUrl, exchangeCode, saveTokens, getAccountInfo, configureForwarding, disconnect };
