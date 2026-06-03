// Number picker — search available Twilio numbers and provision one for a tenant.
//
// GET  /onboarding/numbers?areaCode=XXX   — list available local numbers
// POST /onboarding/numbers/provision       — buy + wire a chosen number

const express = require('express');
const twilio = require('twilio');
const { supabase } = require('../lib/supabase');
const { requireAuth, requireTenant } = require('../lib/auth');

const router = express.Router();
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

router.use(requireAuth, requireTenant);

// GET /onboarding/numbers?areaCode=NXX&state=CA
// Returns up to 10 available local numbers.
router.get('/numbers', async (req, res) => {
  try {
    const { areaCode, state } = req.query;
    const params = { limit: 10, voiceEnabled: true };
    if (areaCode) params.areaCode = areaCode;
    if (state) params.inRegion = state;

    const numbers = await twilioClient
      .availablePhoneNumbers('US')
      .local.list(params);

    res.json({
      numbers: numbers.map((n) => ({
        phoneNumber: n.phoneNumber,
        friendlyName: n.friendlyName,
        locality: n.locality,
        region: n.region,
      })),
    });
  } catch (err) {
    console.error('[numbers] search failed:', err.message);
    res.status(500).json({ error: 'Could not search available numbers.' });
  }
});

// POST /onboarding/numbers/provision { phoneNumber: '+1...' }
// Buys the number, wires voice webhooks, saves to phone_numbers table.
router.post('/numbers/provision', express.json(), async (req, res) => {
  const { phoneNumber } = req.body;
  if (!phoneNumber) return res.status(400).json({ error: 'phoneNumber required' });
  // Enforce E.164 format — prevents malformed/attacker-controlled strings reaching Twilio.
  if (typeof phoneNumber !== 'string' || !/^\+1[2-9]\d{9}$/.test(phoneNumber)) {
    return res.status(400).json({ error: 'phoneNumber must be a valid US E.164 number (e.g. +12125551234)' });
  }

  // Only provision once.
  const { data: existing } = await supabase
    .from('phone_numbers')
    .select('id')
    .eq('tenant_id', req.tenant.id)
    .limit(1);
  if (existing && existing.length > 0) {
    return res.status(409).json({ error: 'A number is already provisioned for this account.' });
  }

  const baseUrl = process.env.API_BASE_URL || `https://${req.get('host')}`;

  try {
    // Buy the number from Twilio.
    const purchased = await twilioClient.incomingPhoneNumbers.create({
      phoneNumber,
      voiceUrl: `${baseUrl}/voice`,
      voiceMethod: 'POST',
      voiceFallbackUrl: `${baseUrl}/voice`,
      voiceFallbackMethod: 'POST',
      friendlyName: `SoCal Receptionist — ${req.tenant.business_name || req.tenant.id}`,
    });

    // Insert into phone_numbers table.
    const { error: dbErr } = await supabase.from('phone_numbers').insert({
      tenant_id: req.tenant.id,
      phone_e164: purchased.phoneNumber,
      twilio_sid: purchased.sid,
      status: 'active',
      number_type: 'local_10dlc',
    });
    if (dbErr) {
      // Best-effort cleanup — release the number back to Twilio.
      await twilioClient.incomingPhoneNumbers(purchased.sid).remove().catch(() => {});
      throw dbErr;
    }

    // Move tenant to active.
    await supabase
      .from('tenants')
      .update({ status: 'active' })
      .eq('id', req.tenant.id);

    res.json({ phoneNumber: purchased.phoneNumber, sid: purchased.sid });
  } catch (err) {
    console.error('[numbers] provision failed:', err.message);
    res.status(500).json({ error: err.message || 'Could not provision number.' });
  }
});

module.exports = router;
