// Microsoft Calendar integration via Microsoft Graph API.
// OAuth2 authorization code flow (AAD v2 common endpoint — works for both
// personal accounts and Microsoft 365 / Exchange tenants):
//
//   GET /integrations/microsoft-calendar/connect  → Microsoft consent screen
//   GET /integrations/microsoft-calendar/callback → exchange code, store tokens
//
// Calendar ops exposed to contact-resolver and reminder-poller:
//   listUpcomingEvents(tenantId, windowMs)  → events starting within windowMs
//   getEventAttendees(tenantId, eventId)    → attendees with emails
//   createEvent(tenantId, event)            → book an appointment

const fetch = require('node-fetch');
const { supabase } = require('../lib/supabase');
const { encryptToken, decryptToken } = require('../lib/token-crypto');

const GRAPH_BASE   = 'https://graph.microsoft.com/v1.0';
const AUTH_BASE    = 'https://login.microsoftonline.com/common/oauth2/v2.0';
const SCOPES       = 'Calendars.ReadWrite offline_access User.Read';

const CLIENT_ID     = process.env.MS_CAL_CLIENT_ID     || '';
const CLIENT_SECRET = process.env.MS_CAL_CLIENT_SECRET || '';

function getRedirectUri(baseUrl) {
  // Must match the PROVIDERS key in router.js (underscore) — the callback route
  // is /integrations/:provider/callback and :provider is looked up verbatim.
  return `${baseUrl}/integrations/microsoft_calendar/callback`;
}

function buildAuthUrl(baseUrl, state) {
  const params = new URLSearchParams({
    client_id:     CLIENT_ID,
    response_type: 'code',
    redirect_uri:  getRedirectUri(baseUrl),
    scope:         SCOPES,
    response_mode: 'query',
    state,
  });
  return `${AUTH_BASE}/authorize?${params}`;
}

async function exchangeCode(code, baseUrl) {
  const res = await fetch(`${AUTH_BASE}/token`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type:    'authorization_code',
      code,
      redirect_uri:  getRedirectUri(baseUrl),
      scope:         SCOPES,
    }),
  });
  if (!res.ok) throw new Error(`MS token exchange failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function refreshAccessToken(tenantId) {
  const { data } = await supabase
    .from('tenant_integrations')
    .select('refresh_token')
    .eq('tenant_id', tenantId)
    .eq('provider', 'microsoft_calendar')
    .single();
  if (!data?.refresh_token) throw new Error('No MS refresh token');

  const res = await fetch(`${AUTH_BASE}/token`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type:    'refresh_token',
      refresh_token: decryptToken(data.refresh_token),
      scope:         SCOPES,
    }),
  });
  if (!res.ok) throw new Error(`MS token refresh failed: ${res.status}`);
  const tokens = await res.json();

  await supabase.from('tenant_integrations').update({
    access_token:     encryptToken(tokens.access_token),
    refresh_token:    encryptToken(tokens.refresh_token || decryptToken(data.refresh_token)),
    token_expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
    last_error:       null,
  }).eq('tenant_id', tenantId).eq('provider', 'microsoft_calendar');

  return tokens.access_token;
}

async function getAccessToken(tenantId) {
  const { data, error } = await supabase
    .from('tenant_integrations')
    .select('access_token, token_expires_at')
    .eq('tenant_id', tenantId)
    .eq('provider', 'microsoft_calendar')
    .single();
  if (error || !data) throw new Error('Microsoft Calendar not connected');
  const expires   = data.token_expires_at ? new Date(data.token_expires_at) : null;
  const needsRefresh = !expires || expires <= new Date(Date.now() + 5 * 60 * 1000);
  return needsRefresh ? refreshAccessToken(tenantId) : decryptToken(data.access_token);
}

async function saveTokens(tenantId, tokens, extra = {}) {
  await supabase.from('tenant_integrations').upsert({
    tenant_id:        tenantId,
    provider:         'microsoft_calendar',
    access_token:     encryptToken(tokens.access_token),
    refresh_token:    encryptToken(tokens.refresh_token),
    token_expires_at: new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString(),
    extra,
    enabled:          true,
  }, { onConflict: 'tenant_id,provider' });
}

async function getAccountInfo(accessToken) {
  const res = await fetch(`${GRAPH_BASE}/me?$select=displayName,mail,userPrincipalName`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return {};
  const body = await res.json();
  return { display_name: body.displayName || '', email: body.mail || body.userPrincipalName || '' };
}

// List calendar events starting within the next windowMs milliseconds.
// Returns simplified event objects.
async function listUpcomingEvents(tenantId, windowMs = 30 * 60 * 1000) {
  const accessToken = await getAccessToken(tenantId);
  const now  = new Date();
  const end  = new Date(now.getTime() + windowMs);
  const params = new URLSearchParams({
    startDateTime: now.toISOString(),
    endDateTime:   end.toISOString(),
    $select:       'id,subject,start,end,attendees',
    $orderby:      'start/dateTime',
    $top:          '20',
  });
  const res = await fetch(`${GRAPH_BASE}/me/calendarView?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}`, Prefer: 'outlook.timezone="UTC"' },
  });
  if (!res.ok) throw new Error(`MS listEvents failed: ${res.status}`);
  const body = await res.json();
  return (body.value || []).map(e => ({
    id:        e.id,
    title:     e.subject || '',
    startAt:   e.start?.dateTime,
    endAt:     e.end?.dateTime,
    attendees: (e.attendees || []).map(a => ({
      name:  a.emailAddress?.name  || '',
      email: a.emailAddress?.address || '',
    })),
  }));
}

// Create an event on the tenant's primary calendar.
async function createEvent(tenantId, { title, startIso, durationMins = 30, attendeeEmail, attendeeName, timezone = 'America/Los_Angeles' }) {
  const accessToken = await getAccessToken(tenantId);
  const start = new Date(startIso);
  const end   = new Date(start.getTime() + durationMins * 60 * 1000);

  const body = {
    subject: title,
    start:   { dateTime: start.toISOString(), timeZone: timezone },
    end:     { dateTime: end.toISOString(),   timeZone: timezone },
    ...(attendeeEmail ? {
      attendees: [{ emailAddress: { address: attendeeEmail, name: attendeeName || attendeeEmail }, type: 'required' }],
    } : {}),
  };

  const res = await fetch(`${GRAPH_BASE}/me/events`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`MS createEvent failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function disconnect(tenantId) {
  await supabase.from('tenant_integrations').delete()
    .eq('tenant_id', tenantId).eq('provider', 'microsoft_calendar');
}

module.exports = { buildAuthUrl, exchangeCode, saveTokens, getAccountInfo, listUpcomingEvents, createEvent, disconnect };
