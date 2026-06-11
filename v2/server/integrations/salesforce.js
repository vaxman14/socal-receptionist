// Salesforce CRM integration.
// OAuth2 Connected App flow.
//
//   GET /integrations/salesforce/connect  → Salesforce login/consent
//   GET /integrations/salesforce/callback → exchange code, store tokens + instance_url
//
// CRM ops:
//   searchContacts(tenantId, query) → Lead and Contact records matching name
//   createLead(tenantId, lead)      → create a Lead in Salesforce
//   logCallActivity(tenantId, data) → log a Task (call activity) on a record

const fetch = require('node-fetch');
const { supabase } = require('../lib/supabase');
const { encryptToken, decryptToken } = require('../lib/token-crypto');

const SF_AUTH_URL   = 'https://login.salesforce.com/services/oauth2/authorize';
const SF_TOKEN_URL  = 'https://login.salesforce.com/services/oauth2/token';

const CLIENT_ID     = process.env.SALESFORCE_CLIENT_ID     || '';
const CLIENT_SECRET = process.env.SALESFORCE_CLIENT_SECRET || '';

function getRedirectUri(baseUrl) {
  return `${baseUrl}/integrations/salesforce/callback`;
}

function buildAuthUrl(baseUrl, state) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     CLIENT_ID,
    redirect_uri:  getRedirectUri(baseUrl),
    scope:         'api id',
    state,
  });
  return `${SF_AUTH_URL}?${params}`;
}

async function exchangeCode(code, baseUrl) {
  const res = await fetch(SF_TOKEN_URL, {
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
  if (!res.ok) throw new Error(`Salesforce token exchange failed: ${res.status} ${await res.text()}`);
  return res.json(); // includes instance_url — must be stored in extra
}

async function refreshAccessToken(tenantId) {
  const { data } = await supabase
    .from('tenant_integrations')
    .select('refresh_token, extra')
    .eq('tenant_id', tenantId).eq('provider', 'salesforce').single();
  if (!data?.refresh_token) throw new Error('No Salesforce refresh token');

  const res = await fetch(SF_TOKEN_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      grant_type:    'refresh_token',
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: decryptToken(data.refresh_token),
    }),
  });
  if (!res.ok) throw new Error(`Salesforce token refresh failed: ${res.status}`);
  const tokens = await res.json();

  await supabase.from('tenant_integrations').update({
    access_token:     encryptToken(tokens.access_token),
    token_expires_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(), // SF tokens last ~2h
    last_error:       null,
    // Preserve (possibly updated) instance_url in extra
    extra:            { ...(data.extra || {}), instance_url: tokens.instance_url || data.extra?.instance_url },
  }).eq('tenant_id', tenantId).eq('provider', 'salesforce');

  return tokens.access_token;
}

async function getAccessToken(tenantId) {
  const { data, error } = await supabase
    .from('tenant_integrations')
    .select('access_token, token_expires_at, extra')
    .eq('tenant_id', tenantId).eq('provider', 'salesforce').single();
  if (error || !data) throw new Error('Salesforce not connected');
  const expires = data.token_expires_at ? new Date(data.token_expires_at) : null;
  const needsRefresh = !expires || expires <= new Date(Date.now() + 5 * 60 * 1000);
  const token = needsRefresh ? await refreshAccessToken(tenantId) : decryptToken(data.access_token);
  return { token, instanceUrl: data.extra?.instance_url || '' };
}

async function saveTokens(tenantId, tokens, extra = {}) {
  await supabase.from('tenant_integrations').upsert({
    tenant_id:        tenantId,
    provider:         'salesforce',
    access_token:     encryptToken(tokens.access_token),
    refresh_token:    tokens.refresh_token ? encryptToken(tokens.refresh_token) : null,
    token_expires_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
    extra:            { ...extra, instance_url: tokens.instance_url || '' },
    enabled:          true,
  }, { onConflict: 'tenant_id,provider' });
}

async function getAccountInfo(accessToken, instanceUrl) {
  if (!instanceUrl) return {};
  const res = await fetch(`${instanceUrl}/services/oauth2/userinfo`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return {};
  const body = await res.json();
  return { org_id: body.organization_id, user_name: body.preferred_username };
}

// SOQL search across Contact and Lead objects by name or phone.
async function searchContacts(tenantId, query) {
  const { token, instanceUrl } = await getAccessToken(tenantId);
  if (!instanceUrl) return [];

  // Search both Contact and Lead objects via SOSL
  const sosl = `FIND {${query.replace(/'/g, "\\'")}} IN NAME FIELDS RETURNING Contact(Id, Name, Phone, MobilePhone, Email, Account.Name LIMIT 3), Lead(Id, Name, Phone, MobilePhone, Email, Company LIMIT 3)`;
  const res = await fetch(
    `${instanceUrl}/services/data/v58.0/search/?q=${encodeURIComponent(sosl)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) return [];
  const body = await res.json();
  const contacts = (body.searchRecords || []).map(r => ({
    id:      r.Id,
    name:    r.Name || '',
    phone:   r.MobilePhone || r.Phone || '',
    email:   r.Email || '',
    company: r.Account?.Name || r.Company || '',
    type:    r.attributes?.type || '',
  }));
  return contacts;
}

// Create a Lead record.
async function createLead(tenantId, { name, phone, email, company, description }) {
  const { token, instanceUrl } = await getAccessToken(tenantId);
  if (!instanceUrl) return null;

  const [firstName, ...rest] = (name || 'Unknown').split(' ');
  const res = await fetch(`${instanceUrl}/services/data/v58.0/sobjects/Lead`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      FirstName:   firstName,
      LastName:    rest.join(' ') || 'Unknown',
      Phone:       phone   || '',
      Email:       email   || '',
      Company:     company || 'Unknown',
      Description: description || 'Captured via SoCal Receptionist AI',
      LeadSource:  'Phone Inquiry',
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    await supabase.from('tenant_integrations')
      .update({ last_error: `createLead failed: ${res.status} ${err.slice(0, 200)}` })
      .eq('tenant_id', tenantId).eq('provider', 'salesforce');
    return null;
  }
  return res.json();
}

// Log a call Task on a Contact or Lead.
async function logCallActivity(tenantId, { recordId, recordType = 'Contact', callerPhone, durationSecs, notes }) {
  const { token, instanceUrl } = await getAccessToken(tenantId);
  if (!instanceUrl || !recordId) return null;

  const res = await fetch(`${instanceUrl}/services/data/v58.0/sobjects/Task`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      Subject:        'Inbound call via SoCal Receptionist',
      Status:         'Completed',
      Priority:       'Normal',
      TaskSubtype:    'Call',
      CallType:       'Inbound',
      CallDurationInSeconds: durationSecs || 0,
      Description:    notes || `Caller: ${callerPhone}`,
      WhoId:          recordType !== 'Account' ? recordId : undefined,
      WhatId:         recordType === 'Account' ? recordId : undefined,
    }),
  });
  if (!res.ok) return null;
  return res.json();
}

async function disconnect(tenantId) {
  await supabase.from('tenant_integrations').delete()
    .eq('tenant_id', tenantId).eq('provider', 'salesforce');
}

module.exports = { buildAuthUrl, exchangeCode, saveTokens, getAccountInfo, searchContacts, createLead, logCallActivity, disconnect };
