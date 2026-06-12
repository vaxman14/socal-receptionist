// Contact resolver for Outbound Call Assist.
// Given a tenant ID and a spoken name (e.g. "Robert" or "Robert Smith"),
// returns the best matching contact with a phone number.
//
// Search order (fastest/cheapest first):
//   1. tenant_contacts table (pre-synced / manual)
//   2. Google Calendar upcoming attendees
//   3. Microsoft Calendar upcoming attendees
//   4. HubSpot contacts (if connected)
//   5. Clio contacts (if connected)
//
// Returns: { name, phone, email, source, confidence } | null

const { supabase } = require('./supabase');
const logger       = require('./logger');

// ── Normalise a spoken name into search tokens ────────────────────────────────
function tokenise(name) {
  return name.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim().split(/\s+/).filter(Boolean);
}

function matchScore(contactName, queryTokens) {
  const contactTokens = tokenise(contactName);
  let hits = 0;
  for (const q of queryTokens) {
    if (contactTokens.some(c => c.startsWith(q) || q.startsWith(c))) hits++;
  }
  return hits / Math.max(queryTokens.length, 1);
}

// ── 1. tenant_contacts table ──────────────────────────────────────────────────
async function searchLocalContacts(tenantId, queryTokens) {
  // Postgres full-text search on name
  const query = queryTokens.join(' & ');
  const { data } = await supabase
    .from('tenant_contacts')
    .select('name, phone, email, source')
    .eq('tenant_id', tenantId)
    .textSearch('name', query, { config: 'english' })
    .not('phone', 'is', null)
    .limit(5);
  return (data || []).map(c => ({ ...c, confidence: matchScore(c.name, queryTokens) }));
}

// ── 2. Google Calendar attendees ──────────────────────────────────────────────
async function searchGoogleCalAttendees(tenantId, queryTokens) {
  // Tokens live in tenant_integrations (provider='google_calendar') — written
  // by the per-tenant OAuth flow in integrations/google-calendar.js, which also
  // owns token refresh.
  const { data: integration } = await supabase
    .from('tenant_integrations')
    .select('enabled')
    .eq('tenant_id', tenantId)
    .eq('provider', 'google_calendar')
    .maybeSingle();

  if (!integration?.enabled) return [];

  try {
    const gcal = require('../integrations/google-calendar');
    const events = await gcal.listUpcomingEvents(tenantId, 24 * 60 * 60 * 1000); // next 24h

    const attendees = [];
    for (const event of events) {
      for (const a of (event.attendees || [])) {
        if (a.name) {
          attendees.push({ name: a.name, email: a.email || '', phone: '', source: 'google_cal' });
        }
      }
    }
    return attendees
      .filter(a => matchScore(a.name, queryTokens) > 0)
      .map(a => ({ ...a, confidence: matchScore(a.name, queryTokens) }));
  } catch (err) {
    logger.warn('contact-resolver.gcal_failed', { tenantId, error: err.message });
    return [];
  }
}

// ── 3. Microsoft Calendar attendees ──────────────────────────────────────────
async function searchMsCalAttendees(tenantId, queryTokens) {
  const { data: integration } = await supabase
    .from('tenant_integrations')
    .select('enabled')
    .eq('tenant_id', tenantId)
    .eq('provider', 'microsoft_calendar')
    .maybeSingle();
  if (!integration?.enabled) return [];

  try {
    const msCal   = require('../integrations/microsoft-calendar');
    const events  = await msCal.listUpcomingEvents(tenantId, 24 * 60 * 60 * 1000);
    const attendees = [];
    for (const event of events) {
      for (const a of (event.attendees || [])) {
        if (a.name) attendees.push({ name: a.name, email: a.email || '', phone: '', source: 'ms_cal' });
      }
    }
    return attendees
      .filter(a => matchScore(a.name, queryTokens) > 0)
      .map(a => ({ ...a, confidence: matchScore(a.name, queryTokens) }));
  } catch (err) {
    logger.warn('contact-resolver.mscal_failed', { tenantId, error: err.message });
    return [];
  }
}

// ── 4. HubSpot contacts ───────────────────────────────────────────────────────
async function searchHubSpot(tenantId, queryTokens) {
  const { data: integration } = await supabase
    .from('tenant_integrations')
    .select('enabled')
    .eq('tenant_id', tenantId).eq('provider', 'hubspot').maybeSingle();
  if (!integration?.enabled) return [];

  try {
    const hubspot  = require('../integrations/hubspot');
    const results  = await hubspot.searchContacts(tenantId, queryTokens.join(' '));
    return results
      .filter(c => c.phone)
      .map(c => ({ ...c, source: 'hubspot', confidence: matchScore(c.name, queryTokens) }));
  } catch (err) {
    logger.warn('contact-resolver.hubspot_failed', { tenantId, error: err.message });
    return [];
  }
}

// ── 5. Clio contacts ──────────────────────────────────────────────────────────
async function searchClio(tenantId, queryTokens) {
  const { data: integration } = await supabase
    .from('tenant_integrations')
    .select('enabled')
    .eq('tenant_id', tenantId).eq('provider', 'clio').maybeSingle();
  if (!integration?.enabled) return [];

  try {
    const { getAccessToken } = require('../integrations/clio');
    const fetch              = require('node-fetch');
    const accessToken        = await getAccessToken(tenantId);

    const q   = queryTokens.join(' ');
    const res = await fetch(
      `https://app.clio.com/api/v4/contacts.json?query=${encodeURIComponent(q)}&fields=id,name,phone_numbers&type=Person&limit=5`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!res.ok) return [];
    const body    = await res.json();
    const results = (body.data || []).map(c => ({
      name:       c.name || '',
      phone:      c.phone_numbers?.[0]?.number || '',
      email:      '',
      source:     'clio',
      confidence: matchScore(c.name || '', queryTokens),
    }));
    return results.filter(r => r.phone && r.confidence > 0);
  } catch (err) {
    logger.warn('contact-resolver.clio_failed', { tenantId, error: err.message });
    return [];
  }
}

// ── Main resolver ─────────────────────────────────────────────────────────────

// Resolve a spoken name to a contact with a phone number.
// Returns the best match above 0.4 confidence, or null if nothing found.
// If multiple strong matches exist, returns an array (disambiguation needed).
async function resolve(tenantId, spokenName) {
  const queryTokens = tokenise(spokenName);
  if (!queryTokens.length) return null;

  // Run all sources in parallel; filter out errors via .filter(Boolean)
  const [local, gcal, msCal, hs, clio] = await Promise.allSettled([
    searchLocalContacts(tenantId, queryTokens),
    searchGoogleCalAttendees(tenantId, queryTokens),
    searchMsCalAttendees(tenantId, queryTokens),
    searchHubSpot(tenantId, queryTokens),
    searchClio(tenantId, queryTokens),
  ]).then(results => results.map(r => r.status === 'fulfilled' ? r.value : []));

  const all = [...local, ...gcal, ...msCal, ...hs, ...clio]
    .filter(c => c.confidence > 0.3)
    .sort((a, b) => b.confidence - a.confidence);

  if (!all.length) return null;

  // If the top two results are close in confidence AND have different names,
  // return both so the caller can ask which one.
  if (all.length > 1 && all[0].confidence - all[1].confidence < 0.15 && all[0].name !== all[1].name) {
    return { ambiguous: true, candidates: all.slice(0, 3) };
  }

  return all[0];
}

module.exports = { resolve, tokenise, matchScore };
