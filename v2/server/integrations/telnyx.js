// Telnyx integration.
// Telnyx uses API key auth — no OAuth needed. The tenant pastes their
// Telnyx API key into the settings UI; we store it encrypted.
//
//   POST /integrations/telnyx/connect       → save API key
//   POST /integrations/telnyx/configure-webhook → update inbound profile webhook
//   DELETE /integrations/telnyx/disconnect  → remove
//
// Telnyx is the most developer-friendly of the three SIP providers.
// Inbound call handling is configured via Messaging/Voice Inbound Profiles.

const fetch = require('node-fetch');
const { supabase } = require('../lib/supabase');
const { encryptToken, decryptToken } = require('../lib/token-crypto');

const TELNYX_BASE = 'https://api.telnyx.com/v2';

async function getApiKey(tenantId) {
  const { data, error } = await supabase
    .from('tenant_integrations')
    .select('access_token')
    .eq('tenant_id', tenantId).eq('provider', 'telnyx').single();
  if (error || !data?.access_token) throw new Error('Telnyx not connected');
  return decryptToken(data.access_token);
}

async function saveApiKey(tenantId, apiKey, extra = {}) {
  await supabase.from('tenant_integrations').upsert({
    tenant_id:    tenantId,
    provider:     'telnyx',
    access_token: encryptToken(apiKey),
    extra,
    enabled:      true,
  }, { onConflict: 'tenant_id,provider' });
}

// Verify the API key works and return account info.
async function getAccountInfo(apiKey) {
  const res = await fetch(`${TELNYX_BASE}/messaging_profiles`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) return {};
  const body = await res.json();
  return { profile_count: (body.data || []).length };
}

// List Voice Inbound Profiles on this Telnyx account.
async function listInboundProfiles(tenantId) {
  const apiKey = await getApiKey(tenantId);
  const res = await fetch(`${TELNYX_BASE}/calls/voice/inbound`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`Telnyx listInboundProfiles failed: ${res.status}`);
  const body = await res.json();
  return body.data || [];
}

// Create or update a Voice Inbound Profile so inbound calls hit our webhook.
// If profileId is provided, updates that profile. Otherwise creates a new one.
async function configureInboundProfile(tenantId, webhookUrl, profileId = null) {
  const apiKey = await getApiKey(tenantId);

  const payload = {
    data: {
      type:       'inbound_voice',
      attributes: {
        inbound_call_handling: {
          type: 'webhook',
          attributes: {
            webhook_url: webhookUrl,
          },
        },
      },
    },
  };

  let res;
  if (profileId) {
    res = await fetch(`${TELNYX_BASE}/calls/voice/inbound/${profileId}`, {
      method:  'PATCH',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
  } else {
    payload.data.attributes.name = 'SoCal Receptionist';
    res = await fetch(`${TELNYX_BASE}/calls/voice/inbound`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
  }

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Telnyx inbound profile config failed: ${res.status} ${err}`);
  }
  const result = await res.json();
  const newProfileId = result.data?.id;

  await supabase.from('tenant_integrations').update({
    last_sync_at: new Date().toISOString(),
    last_error:   null,
    extra:        { inbound_profile_id: newProfileId, webhook_url: webhookUrl },
  }).eq('tenant_id', tenantId).eq('provider', 'telnyx');

  return { success: true, profileId: newProfileId };
}

// Telnyx: assign a phone number to an inbound profile so it routes to our webhook.
async function assignNumberToProfile(tenantId, phoneNumber, profileId) {
  const apiKey = await getApiKey(tenantId);

  // First find the phone number record
  const searchRes = await fetch(
    `${TELNYX_BASE}/phone_numbers?filter[phone_number]=${encodeURIComponent(phoneNumber)}`,
    { headers: { Authorization: `Bearer ${apiKey}` } }
  );
  if (!searchRes.ok) throw new Error('Could not find phone number in Telnyx account');
  const searchBody = await searchRes.json();
  const numberRecord = (searchBody.data || [])[0];
  if (!numberRecord) throw new Error(`Phone number ${phoneNumber} not found in Telnyx account`);

  const res = await fetch(`${TELNYX_BASE}/phone_numbers/${numberRecord.id}`, {
    method:  'PATCH',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      data: {
        type: 'phone_number',
        attributes: {
          voice: {
            inbound: {
              inbound_call_handling: { type: 'inbound_voice', inbound_voice_id: profileId },
            },
          },
        },
      },
    }),
  });
  if (!res.ok) throw new Error(`Telnyx number assignment failed: ${res.status}`);
  return res.json();
}

async function disconnect(tenantId) {
  await supabase.from('tenant_integrations').delete()
    .eq('tenant_id', tenantId).eq('provider', 'telnyx');
}

// Telnyx uses API key — no standard OAuth flow. These are no-ops / stubs
// to satisfy the integrations router's PROVIDERS interface.
function buildAuthUrl() { return null; }
async function exchangeCode() { return null; }
async function saveTokens(tenantId, tokens, extra) { return saveApiKey(tenantId, tokens.api_key, extra); }

module.exports = {
  buildAuthUrl, exchangeCode, saveTokens, saveApiKey, getAccountInfo,
  listInboundProfiles, configureInboundProfile, assignNumberToProfile, disconnect,
};
