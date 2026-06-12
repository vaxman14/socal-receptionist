// Google Calendar integration — per-tenant OAuth2 (authorization code flow).
// Replaces the legacy single-tenant env-token setup for v3 tenants:
//
//   GET /integrations/google_calendar/connect  → Google consent screen
//   GET /integrations/google_calendar/callback → exchange code, store tokens
//
// Tokens land in tenant_integrations (provider='google_calendar'), which is
// exactly where contact-resolver.js and reminder-poller.js already look.
//
// Calendar ops exposed to contact-resolver and reminder-poller:
//   listUpcomingEvents(tenantId, windowMs)  → events starting within windowMs
//   createEvent(tenantId, event)            → book an appointment

const fetch = require('node-fetch');
const { supabase } = require('../lib/supabase');
const { encryptToken, decryptToken } = require('../lib/token-crypto');

const AUTH_URL  = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CAL_BASE  = 'https://www.googleapis.com/calendar/v3';
const SCOPES    = 'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/userinfo.email';

// GCAL_* are the dedicated names used by contact-resolver/reminder-poller;
// fall back to the GOOGLE_* pair Roman already has registered.
const CLIENT_ID     = process.env.GCAL_CLIENT_ID     || process.env.GOOGLE_CLIENT_ID     || '';
const CLIENT_SECRET = process.env.GCAL_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET || '';

function getRedirectUri(baseUrl) {
  // Must match the PROVIDERS key in router.js (underscore).
  return `${baseUrl}/integrations/google_calendar/callback`;
}

function buildAuthUrl(baseUrl, state) {
  const params = new URLSearchParams({
    client_id:     CLIENT_ID,
    response_type: 'code',
    redirect_uri:  getRedirectUri(baseUrl),
    scope:         SCOPES,
    access_type:   'offline', // ask for a refresh_token
    prompt:        'consent', // force refresh_token even on re-auth
    state,
  });
  return `${AUTH_URL}?${params}`;
}

async function exchangeCode(code, baseUrl) {
  const res = await fetch(TOKEN_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type:    'authorization_code',
      code,
      redirect_uri:  getRedirectUri(baseUrl),
    }),
  });
  if (!res.ok) throw new Error(`Google token exchange failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function refreshAccessToken(tenantId) {
  const { data } = await supabase
    .from('tenant_integrations')
    .select('refresh_token')
    .eq('tenant_id', tenantId)
    .eq('provider', 'google_calendar')
    .single();
  if (!data?.refresh_token) throw new Error('No Google refresh token');

  const res = await fetch(TOKEN_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type:    'refresh_token',
      refresh_token: decryptToken(data.refresh_token),
    }),
  });
  if (!res.ok) throw new Error(`Google token refresh failed: ${res.status}`);
  const tokens = await res.json();

  // Google only returns refresh_token on first consent — keep the stored one.
  await supabase.from('tenant_integrations').update({
    access_token:     encryptToken(tokens.access_token),
    token_expires_at: new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString(),
    last_error:       null,
  }).eq('tenant_id', tenantId).eq('provider', 'google_calendar');

  return tokens.access_token;
}

async function getAccessToken(tenantId) {
  const { data, error } = await supabase
    .from('tenant_integrations')
    .select('access_token, token_expires_at')
    .eq('tenant_id', tenantId)
    .eq('provider', 'google_calendar')
    .single();
  if (error || !data) throw new Error('Google Calendar not connected');
  const expires      = data.token_expires_at ? new Date(data.token_expires_at) : null;
  const needsRefresh = !expires || expires <= new Date(Date.now() + 5 * 60 * 1000);
  return needsRefresh ? refreshAccessToken(tenantId) : decryptToken(data.access_token);
}

async function saveTokens(tenantId, tokens, extra = {}) {
  await supabase.from('tenant_integrations').upsert({
    tenant_id:        tenantId,
    provider:         'google_calendar',
    access_token:     encryptToken(tokens.access_token),
    refresh_token:    encryptToken(tokens.refresh_token),
    token_expires_at: new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString(),
    extra,
    enabled:          true,
  }, { onConflict: 'tenant_id,provider' });
}

async function getAccountInfo(accessToken) {
  const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return {};
  const body = await res.json();
  return { email: body.email || '', display_name: body.name || body.email || '' };
}

// List calendar events starting within the next windowMs milliseconds.
// Same simplified shape as microsoft-calendar.listUpcomingEvents.
async function listUpcomingEvents(tenantId, windowMs = 30 * 60 * 1000) {
  const accessToken = await getAccessToken(tenantId);
  const now = new Date();
  const end = new Date(now.getTime() + windowMs);
  const params = new URLSearchParams({
    timeMin:      now.toISOString(),
    timeMax:      end.toISOString(),
    singleEvents: 'true',
    orderBy:      'startTime',
    maxResults:   '20',
  });
  const res = await fetch(`${CAL_BASE}/calendars/primary/events?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Google listEvents failed: ${res.status}`);
  const body = await res.json();
  return (body.items || []).map(e => ({
    id:        e.id,
    title:     e.summary || '',
    startAt:   e.start?.dateTime || e.start?.date,
    endAt:     e.end?.dateTime   || e.end?.date,
    attendees: (e.attendees || []).map(a => ({
      name:  a.displayName || (a.email ? a.email.split('@')[0] : ''),
      email: a.email || '',
    })),
  }));
}

// Create an event on the tenant's primary calendar.
async function createEvent(tenantId, { title, startIso, durationMins = 30, attendeeEmail, attendeeName, timezone = 'America/Los_Angeles' }) {
  const accessToken = await getAccessToken(tenantId);
  const start = new Date(startIso);
  const end   = new Date(start.getTime() + durationMins * 60 * 1000);

  const body = {
    summary: title,
    start:   { dateTime: start.toISOString(), timeZone: timezone },
    end:     { dateTime: end.toISOString(),   timeZone: timezone },
    ...(attendeeEmail ? {
      attendees: [{ email: attendeeEmail, displayName: attendeeName || attendeeEmail }],
    } : {}),
  };

  const res = await fetch(`${CAL_BASE}/calendars/primary/events`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Google createEvent failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function disconnect(tenantId) {
  // Best-effort revoke so the grant doesn't linger on the Google account.
  try {
    const token = await getAccessToken(tenantId);
    await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: 'POST' });
  } catch { /* not connected or already expired — nothing to revoke */ }
  await supabase.from('tenant_integrations').delete()
    .eq('tenant_id', tenantId).eq('provider', 'google_calendar');
}

module.exports = { buildAuthUrl, exchangeCode, saveTokens, getAccountInfo, getAccessToken, listUpcomingEvents, createEvent, disconnect };
