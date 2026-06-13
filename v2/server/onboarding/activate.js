'use strict';

// Onboarding API — the "Activate" step, shown AFTER the Service Agreement.
//
// Two activation methods:
//   socal_number — self-serve (Essentials). Starts a 7-day NO-CARD trial and
//                  provisions a Twilio number. The tenant is entitled during the
//                  trial without a Stripe subscription (see lib/billing.isEntitled).
//   byo_sip      — the client already has their own phone system. This is part of
//                  our Concierge white-glove setup ($1,500 setup), sales-assisted —
//                  NOT a self-serve trial. We capture a lead and hand off; we do not
//                  start a trial or provision a number.
//
// Provisioning used to fire on /agreement/sign; it now fires here so activation
// is an explicit choice.

const express = require('express');
const { requireAuth, requireTenant } = require('../lib/auth');
const { supabase } = require('../lib/supabase');
const { enqueue } = require('../lib/jobs');
const logger = require('../lib/logger');

const router = express.Router();

const TRIAL_DAYS = 7;
const METHODS = new Set(['socal_number', 'byo_sip']);

// Auth is applied per-route (NOT router.use) so this router never gates sibling
// /onboarding paths mounted after it — see the chat-route mount-order bug.

// GET /onboarding/activation — current activation state (lets the wizard resume).
router.get('/activation', requireAuth, requireTenant, async (req, res) => {
  res.json({
    activation_method: req.tenant.activation_method || null,
    status: req.tenant.status,
    trial_ends_at: req.tenant.trial_ends_at || null,
  });
});

// POST /onboarding/activate  body: { method: 'socal_number' | 'byo_sip' }
router.post('/activate', requireAuth, requireTenant, async (req, res) => {
  const method = (req.body && req.body.method) || '';
  if (!METHODS.has(method)) {
    return res.status(400).json({ error: "method must be 'socal_number' or 'byo_sip'" });
  }

  try {
    if (method === 'socal_number') {
      const trialEndsAt = new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000).toISOString();
      const { error } = await supabase
        .from('tenants')
        .update({
          activation_method: 'socal_number',
          trial_ends_at: trialEndsAt,
          updated_at: new Date().toISOString(),
        })
        .eq('id', req.tenant.id);
      if (error) throw error;

      // provision_tenant is idempotent (only acts while status is 'onboarding')
      // and advances the tenant to 'active' when the number is wired.
      if (req.tenant.status === 'onboarding') {
        await enqueue(req.tenant.id, 'provision_tenant', {});
      }

      logger.info('activate.socal_number', { tenant: req.tenant.id, trialEndsAt });
      return res.status(201).json({
        ok: true,
        method: 'socal_number',
        trial_ends_at: trialEndsAt,
        provisioning_started: req.tenant.status === 'onboarding',
        message: 'Your 7-day free trial has started — setting up your number now.',
      });
    }

    // byo_sip — Concierge white-glove handoff. No trial, no provisioning.
    await supabase
      .from('tenants')
      .update({ activation_method: 'byo_sip', updated_at: new Date().toISOString() })
      .eq('id', req.tenant.id);

    await supabase.from('platform_leads').insert({
      source: 'byo_sip',
      name: req.tenant.business_name,
      email: req.tenant.owner_email || req.user.email,
      notes:
        `Wants to connect their own phone system / SIP trunk (Concierge white-glove). ` +
        `Tenant ${req.tenant.id} (${req.tenant.business_name}).`,
      status: 'new',
    });

    logger.info('activate.byo_sip', { tenant: req.tenant.id });
    return res.status(201).json({
      ok: true,
      method: 'byo_sip',
      handoff: true,
      message:
        'Connecting your own phone system is part of our Concierge white-glove setup. ' +
        'Our team will reach out to get your SIP trunk wired up.',
    });
  } catch (err) {
    logger.error('activate.error', { error: err.message });
    return res.status(500).json({ error: 'could not activate' });
  }
});

module.exports = router;
