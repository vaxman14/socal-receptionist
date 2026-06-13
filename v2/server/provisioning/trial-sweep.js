'use strict';

// No-card trial sweep.
//
// The Activate step (onboarding/activate.js) starts a 7-day trial with NO card
// on file — it just stamps tenants.trial_ends_at and provisions a number. There
// is no Stripe subscription yet, so Stripe webhooks never fire for these
// tenants and the normal billing.applyEntitlement() suspension path can't reach
// them. This sweep is what drives that lifecycle:
//
//   • ~2 days before trial_ends_at  -> email reminder #1 (add a card)
//   • on the final day              -> email reminder #2 (add a card)
//   • once trial_ends_at has passed -> suspend (suspended_billing)
//
// If the owner adds a card and subscribes at any point, an entitled
// subscription row exists and we skip them entirely — Stripe drives them from
// then on, and applyEntitlement() will lift any suspension we applied.

const { supabase } = require('../lib/supabase');
const { transitionTenant } = require('../lib/state-machine');
const { sendEmail } = require('../lib/email');
const { trialReminder } = require('../lib/email-templates');
const { isEntitled } = require('../lib/billing');
const logger = require('../lib/logger');

const DAY_MS = 24 * 60 * 60 * 1000;

// True if the tenant already has a Stripe subscription that grants service.
// Those tenants have converted off the no-card trial; we leave them to Stripe.
async function hasEntitledSubscription(tenantId) {
  const { data, error } = await supabase
    .from('subscriptions')
    .select('status')
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error) throw error;
  return Boolean(data && isEntitled(data.status));
}

// Process a single trial tenant: send the due reminder, or suspend if expired.
async function processTenant(tenant, now) {
  if (await hasEntitledSubscription(tenant.id)) return null; // converted — Stripe owns it

  const endsAt = new Date(tenant.trial_ends_at).getTime();
  const msLeft = endsAt - now;

  // ── Expired: suspend a still-active tenant (no card was added). ──
  if (msLeft <= 0) {
    if (tenant.status === 'active') {
      await transitionTenant(tenant.id, 'suspended_billing', {
        actorType: 'system',
        reason: 'no-card trial ended without a subscription',
      });
      logger.info('trial_sweep.suspended', { tenant: tenant.id });
      return 'suspended';
    }
    return null; // already suspended (or not active) — nothing to do
  }

  // Reminders only make sense while the receptionist is still live.
  if (tenant.status !== 'active') return null;

  const daysLeft = Math.ceil(msLeft / DAY_MS);

  // ── Final day (<= 1 day left): reminder #2. ──
  if (msLeft <= DAY_MS && !tenant.trial_reminder_0d_sent_at) {
    await sendReminder(tenant, Math.max(daysLeft, 0));
    await stamp(tenant.id, 'trial_reminder_0d_sent_at');
    logger.info('trial_sweep.reminder_0d', { tenant: tenant.id });
    return 'reminder_0d';
  }

  // ── ~2 days out (<= 2 days left): reminder #1. ──
  if (msLeft <= 2 * DAY_MS && !tenant.trial_reminder_2d_sent_at) {
    await sendReminder(tenant, daysLeft);
    await stamp(tenant.id, 'trial_reminder_2d_sent_at');
    logger.info('trial_sweep.reminder_2d', { tenant: tenant.id });
    return 'reminder_2d';
  }

  return null;
}

async function sendReminder(tenant, daysLeft) {
  const to = tenant.owner_email;
  if (!to) {
    logger.warn('trial_sweep.no_owner_email', { tenant: tenant.id });
    return;
  }
  const mail = trialReminder({
    businessName: tenant.business_name,
    daysLeft,
    trialEndsAt: tenant.trial_ends_at,
  });
  await sendEmail({ to, subject: mail.subject, html: mail.html, text: mail.text });
}

async function stamp(tenantId, column) {
  const { error } = await supabase
    .from('tenants')
    .update({ [column]: new Date().toISOString() })
    .eq('id', tenantId);
  if (error) throw error;
}

// One sweep pass over all no-card trial tenants. Safe to run repeatedly; each
// reminder is guarded by its sent-at stamp and suspension is idempotent.
async function sweepTrials() {
  const { data: tenants, error } = await supabase
    .from('tenants')
    .select('id, business_name, owner_email, status, trial_ends_at, trial_reminder_2d_sent_at, trial_reminder_0d_sent_at')
    .eq('activation_method', 'socal_number')
    .not('trial_ends_at', 'is', null)
    .in('status', ['active', 'suspended_billing']);
  if (error) throw error;

  const now = Date.now();
  let acted = 0;
  for (const tenant of tenants || []) {
    try {
      if (await processTenant(tenant, now)) acted += 1;
    } catch (err) {
      logger.error('trial_sweep.tenant_failed', { tenant: tenant.id, error: err.message });
    }
  }
  return { scanned: (tenants || []).length, acted };
}

// Start the periodic sweep. Returns a stop() function. Default cadence is every
// 15 minutes — trial boundaries are day-grained, so this is plenty frequent.
function startTrialSweep(opts = {}) {
  const intervalMs = opts.intervalMs || 15 * 60 * 1000;
  let stopped = false;
  let timer = null;

  async function tick() {
    if (stopped) return;
    try {
      const r = await sweepTrials();
      if (r.acted) logger.info('trial_sweep.pass', r);
    } catch (err) {
      logger.error('trial_sweep.pass_failed', { error: err.message });
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  }
  tick();

  return function stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

module.exports = { sweepTrials, startTrialSweep };
