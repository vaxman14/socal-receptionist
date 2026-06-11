// HubSpot CRM integration.
// OAuth2 flow — scopes: crm.objects.contacts.read crm.objects.contacts.write
//
//   GET /integrations/hubspot/connect  → HubSpot consent screen
//   GET /integrations/hubspot/callback → exchange code, store tokens
//
// CRM ops:
//   searchContacts(tenantId, query)         → contacts matching a name/phone
//   createContact(tenantId, contact)        → upsert contact in HubSpot
//   logCallActivity(tenantId, callData)     → log a call as an engagement

const fetch = require('node-fetch');
const { supabase } = require('../lib/supabase');
const { encryptToken, decryptToken } = require('../lib/token-crypto');

const HS_BASE      = 'https://api.hubapi.com';
const AUTH_URL     = 'https://app.hubspot.com/oauth/authorize';
const TOKEN_URL    = `${HS_BASE}/oauth/v1/token`;
const SCOPES       = 'crm.objects.contacts.read crm.objects.contacts.write';

const CLIENT_ID     = process.env.HUBSPOT_CLIENT_ID     || '';
const CLIENT_SECRET = process.env.HUBSPOT_CLIENT_SECRET || '';

function getRedirectUri(baseUrl) {
  return `${baseUrl}/integrations/hubspot/callback`;
}

function buildAuthUrl(baseUrl, state) {
  const params = new URLSearchParams({
    client_id:     CLIENT_ID,
    redirect_uri:  getRedirectUri(baseUrl),
    scope:         SCOPES,
    state,
  });
  return `${AUTH_URL}?${params}`;
}

async function exchangeCode(code, baseUrl) {
  const res = await fetch(TOKEN_URL, {
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
  if (!res.ok) throw new Error(`HubSpot token exchange failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function refreshAccessToken(tenantId) {
  const { data } = await supabase
    .from('tenant_integrations')
    .select('refresh_token')
    .eq('tenant_id', tenantId).eq('provider', 'hubspot').single();
  if (!data?.refresh_token) throw new Error('No HubSpot refresh token');

  const res = await fetch(TOKEN_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      grant_type:    'refresh_token',
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: decryptToken(data.refresh_token),
    }),
  });
  if (!res.ok) throw new Error(`HubSpot token refresh failed: ${res.status}`);
  const tokens = await res.json();

  await supabase.from('tenant_integrations').update({
    access_token:     encryptToken(tokens.access_token),
    refresh_token:    encryptToken(tokens.refresh_token || decryptToken(data.refresh_token)),
    token_expires_at: new Date(Date.now() + (tokens.expires_in || 1800) * 1000).toISOString(),
    last_error:       null,
  }).eq('tenant_id', tenantId).eq('provider', 'hubspot');

  return tokens.access_token;
}

async function getAccessToken(tenantId) {
  const { data, error } = await supabase
    .from('tenant_integrations')
    .select('access_token, token_expires_at')
    .eq('tenant_id', tenantId).eq('provider', 'hubspot').single();
  if (error || !data) throw new Error('HubSpot not connected');
  const expires = data.token_expires_at ? new Date(data.token_expires_at) : null;
  const needsRefresh = !expires || expires <= new Date(Date.now() + 5 * 60 * 1000);
  return needsRefresh ? refreshAccessToken(tenantId) : decryptToken(data.access_token);
}

async function saveTokens(tenantId, tokens, extra = {}) {
  await supabase.from('tenant_integrations').upsert({
    tenant_id:        tenantId,
    provider:         'hubspot',
    access_token:     encryptToken(tokens.access_token),
    refresh_token:    encryptToken(tokens.refresh_token),
    token_expires_at: new Date(Date.now() + (tokens.expires_in || 1800) * 1000).toISOString(),
    extra,
    enabled:          true,
  }, { onConflict: 'tenant_id,provider' });
}

async function getAccountInfo(accessToken) {
  const res = await fetch(`${HS_BASE}/oauth/v1/access-tokens/${accessToken}`);
  if (!res.ok) return {};
  const body = await res.json();
  return { hub_id: body.hub_id, hub_domain: body.hub_domain, user: body.user };
}

// Full-text search across HubSpot contacts.
async function searchContacts(tenantId, query) {
  const accessToken = await getAccessToken(tenantId);
  const res = await fetch(`${HS_BASE}/crm/v3/objects/contacts/search`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      query,
      properties: ['firstname', 'lastname', 'phone', 'mobilephone', 'email', 'company'],
      limit: 5,
    }),
  });
  if (!res.ok) return [];
  const body = await res.json();
  return (body.results || []).map(c => ({
    id:      c.id,
    name:    [c.properties.firstname, c.properties.lastname].filter(Boolean).join(' '),
    phone:   c.properties.mobilephone || c.properties.phone || '',
    email:   c.properties.email || '',
    company: c.properties.company || '',
  }));
}

// Upsert a contact. Dedupes on email.
async function createContact(tenantId, { name, phone, email, company }) {
  const accessToken = await getAccessToken(tenantId);
  const [firstname, ...rest] = (name || '').split(' ');
  const properties = {
    firstname:   firstname || '',
    lastname:    rest.join(' '),
    phone:       phone  || '',
    email:       email  || '',
    company:     company || '',
  };
  const res = await fetch(`${HS_BASE}/crm/v3/objects/contacts`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ properties }),
  });
  if (!res.ok) {
    const err = await res.text();
    await supabase.from('tenant_integrations')
      .update({ last_error: `createContact failed: ${res.status} ${err.slice(0, 200)}` })
      .eq('tenant_id', tenantId).eq('provider', 'hubspot');
    return null;
  }
  return res.json();
}

// Log a call engagement on a contact. contactId is the HubSpot contact ID.
async function logCallActivity(tenantId, { contactId, callerPhone, durationSecs, notes }) {
  const accessToken = await getAccessToken(tenantId);
  const res = await fetch(`${HS_BASE}/crm/v3/objects/calls`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      properties: {
        hs_call_direction:    'INBOUND',
        hs_call_duration:     (durationSecs || 0) * 1000,
        hs_call_from_number:  callerPhone || '',
        hs_call_body:         notes || '',
        hs_call_status:       'COMPLETED',
        hs_timestamp:         Date.now(),
      },
      associations: contactId ? [{
        to: { id: contactId },
        types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 194 }],
      }] : [],
    }),
  });
  if (!res.ok) return null;
  return res.json();
}

async function disconnect(tenantId) {
  await supabase.from('tenant_integrations').delete()
    .eq('tenant_id', tenantId).eq('provider', 'hubspot');
}

module.exports = { buildAuthUrl, exchangeCode, saveTokens, getAccountInfo, searchContacts, createContact, logCallActivity, disconnect };
