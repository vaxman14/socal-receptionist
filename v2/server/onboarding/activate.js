'use strict';

// Onboarding API — the "Activate" step, shown AFTER the Service Agreement.
//
// One activation method: self-serve provisioning of a SoCal number with a
// 30-day no-card trial. Support can assist when needed, but there is no separate
// concierge or sales-assisted tier.
//
// Provisioning used to fire on /agreement/sign; it now fires here so activation
// is an explicit choice.

const express = require('express');
const { requireAuth, requireTenant } = require('../lib/auth');
const { supabase } = require('../lib/supabase');
const { enqueue } = require('../lib/jobs');
const logger = require('../lib/logger');

const router = express.Router();

const TRIAL_DAYS = 30;
const METHODS = new Set(['socal_number']);

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

// POST /onboarding/activate  body: { method: 'socal_number' }
router.post('/activate', requireAuth, requireTenant, async (req, res) => {
  const method = (req.body && req.body.method) || '';
  if (!METHODS.has(method)) {
    return res.status(400).json({ error: "method must be 'socal_number'" });
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
        message: 'Your 30-day free trial has started — setting up your number now.',
      });
    }
  } catch (err) {
    logger.error('activate.error', { error: err.message });
    return res.status(500).json({ error: 'could not activate' });
  }
});

module.exports = router;
