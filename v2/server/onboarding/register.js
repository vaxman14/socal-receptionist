// Onboarding API — new-business registration.
//
// The first step of self-serve onboarding. After a visitor creates a Supabase
// auth account, the web app calls this to create their tenant row (status
// 'onboarding'). Provisioning is NOT started here — it is gated on signing the
// Service Agreement (see onboarding/agreement.js).
//
//   GET  /onboarding/business   -> the caller's tenant, or null if none yet
//   POST /onboarding/business   -> create the tenant for the caller
//
// One tenant per auth account in V2.

const express = require('express');
const { supabase } = require('../lib/supabase');
const { requireAuth } = require('../lib/auth');
const { sendEmail } = require('../lib/email');
const { onboardingConfirmation } = require('../lib/email-templates');

const router = express.Router();
router.use(requireAuth);

// Fields the registrant supplies. Lifecycle/billing/spend fields are NOT here —
// those are owned by the backend.
const REQUIRED = ['business_name'];
const OPTIONAL = [
  'business_hours',
  'business_services',
  'calendly_link',
  'timezone',
  'voice_enabled',
  'staff_phone',
  'voice_greeting',
  'voicemail_email',
];

const E164_RE = /^\+[1-9]\d{7,14}$/;
const MAX_NAME_LEN = 200;

function validateRegistration(body) {
  if (body.business_name && String(body.business_name).trim().length > MAX_NAME_LEN) {
    return `business_name must be ${MAX_NAME_LEN} characters or less`;
  }
  if (body.staff_phone !== undefined && body.staff_phone !== null && body.staff_phone !== '') {
    if (!E164_RE.test(body.staff_phone)) return 'staff_phone must be E.164 format (e.g. +15551234567)';
  }
  if (body.calendly_link !== undefined && body.calendly_link !== null && body.calendly_link !== '') {
    try {
      const u = new URL(body.calendly_link);
      if (!['http:', 'https:'].includes(u.protocol)) throw new Error();
    } catch { return 'calendly_link must be a valid https URL'; }
  }
  if (body.voicemail_email !== undefined && body.voicemail_email !== null && body.voicemail_email !== '') {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.voicemail_email)) return 'voicemail_email must be a valid email address';
  }
  return null;
}

// Turn a business name into a URL-safe slug stem.
function slugify(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'business';
}

// GET /onboarding/business — does the caller already have a tenant?
router.get('/business', async (req, res) => {
  const { data, error } = await supabase
    .from('tenants')
    .select('*')
    .eq('owner_user_id', req.user.id)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ tenant: data || null });
});

// POST /onboarding/business — create the caller's tenant.
router.post('/business', async (req, res) => {
  // One tenant per account.
  const { data: existing } = await supabase
    .from('tenants')
    .select('id')
    .eq('owner_user_id', req.user.id)
    .maybeSingle();
  if (existing) {
    return res.status(409).json({ error: 'this account already has a business' });
  }

  for (const field of REQUIRED) {
    if (!req.body[field] || !String(req.body[field]).trim()) {
      return res.status(400).json({ error: `${field} is required` });
    }
  }

  const validationError = validateRegistration(req.body);
  if (validationError) return res.status(400).json({ error: validationError });

  const row = {
    owner_user_id: req.user.id,
    owner_email: req.user.email,
    business_name: String(req.body.business_name).trim(),
    status: 'onboarding',
  };
  for (const field of OPTIONAL) {
    if (req.body[field] !== undefined) row[field] = req.body[field];
  }

  // Insert with a unique slug; retry a few times on slug collision.
  const stem = slugify(row.business_name);
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const slug = attempt === 0 ? stem : `${stem}-${Math.random().toString(36).slice(2, 7)}`;
    const { data, error } = await supabase
      .from('tenants')
      .insert({ ...row, slug })
      .select()
      .single();
    if (!error) {
      // Best-effort onboarding-confirmation email. sendEmail never throws and
      // no-ops without RESEND_API_KEY, so this can't block or fail the request;
      // we don't await it so the response isn't held on the mail round-trip.
      if (data.owner_email) {
        const mail = onboardingConfirmation({ businessName: data.business_name });
        sendEmail({ to: data.owner_email, ...mail }).catch(() => {});
      }
      return res.status(201).json({ tenant: data });
    }
    lastError = error;
    // 23505 = unique_violation — retry with a fresh slug; anything else, stop.
    if (error.code !== '23505') break;
  }
  console.error('[onboarding] create business failed:', lastError && lastError.message);
  res.status(500).json({ error: 'could not create business' });
});

module.exports = router;
