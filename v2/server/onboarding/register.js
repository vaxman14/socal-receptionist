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
    if (!error) return res.status(201).json({ tenant: data });
    lastError = error;
    // 23505 = unique_violation — retry with a fresh slug; anything else, stop.
    if (error.code !== '23505') break;
  }
  console.error('[onboarding] create business failed:', lastError && lastError.message);
  res.status(500).json({ error: 'could not create business' });
});

module.exports = router;
