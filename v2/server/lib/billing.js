// Billing + entitlements.
//
// Stripe drives entitlements, but the app decides service access from the
// mirrored `subscriptions` record — never from a live Stripe call (Codex
// review #6). syncSubscription() is the single point that updates that record
// and applies the resulting tenant suspension/reactivation.

const { stripe } = require('./stripe');
const { supabase } = require('./supabase');
const { transitionTenant } = require('./state-machine');

const TRIAL_DAYS = 7;

// Subscription statuses that grant access to the SMS service. `past_due` is
// included as a grace window — the tenant is suspended only once Stripe gives
// up (canceled / unpaid).
const ENTITLED_STATUSES = new Set(['trialing', 'active', 'past_due']);

function isEntitled(status) {
  return ENTITLED_STATUSES.has(status);
}

// Collapse Stripe statuses into the `subscription_status` enum (db/001_init.sql).
function mapStripeStatus(s) {
  switch (s) {
    case 'incomplete_expired':
      return 'canceled';
    case 'paused':
      return 'past_due';
    default:
      return s; // trialing | active | past_due | canceled | unpaid | incomplete
  }
}

// Create a Stripe Checkout session for a tenant to start a subscription.
// 7-day trial with the card collected up front (Codex: card-required trial).
async function createCheckoutSession({ tenant, priceId, successUrl, cancelUrl }) {
  return stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    customer_email: tenant.owner_email,
    client_reference_id: tenant.id,
    payment_method_collection: 'always', // require a card even during the trial
    subscription_data: {
      trial_period_days: TRIAL_DAYS,
      metadata: { tenant_id: tenant.id },
    },
    metadata: { tenant_id: tenant.id },
    success_url: successUrl,
    cancel_url: cancelUrl,
  });
}

// Create a Stripe Customer Portal session so a tenant can manage billing.
async function createPortalSession({ stripeCustomerId, returnUrl }) {
  return stripe.billingPortal.sessions.create({
    customer: stripeCustomerId,
    return_url: returnUrl,
  });
}

// Mirror a Stripe subscription into the `subscriptions` table, then apply the
// resulting tenant lifecycle transition.
async function syncSubscription(tenantId, sub) {
  const item = sub.items && sub.items.data && sub.items.data[0];
  const periodEnd = sub.current_period_end || (item && item.current_period_end);

  const record = {
    tenant_id: tenantId,
    stripe_customer_id: typeof sub.customer === 'string' ? sub.customer : sub.customer && sub.customer.id,
    stripe_subscription_id: sub.id,
    plan: item && item.price ? item.price.id : null,
    status: mapStripeStatus(sub.status),
    trial_ends_at: sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null,
    current_period_end: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
    cancel_at_period_end: Boolean(sub.cancel_at_period_end),
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabase
    .from('subscriptions')
    .upsert(record, { onConflict: 'tenant_id' });
  if (error) throw error;

  await applyEntitlement(tenantId, record.status);
}

// Translate the mirrored subscription status into a tenant lifecycle move.
async function applyEntitlement(tenantId, status) {
  const { data: tenant, error } = await supabase
    .from('tenants')
    .select('id, status')
    .eq('id', tenantId)
    .single();
  if (error) throw error;

  const entitled = isEntitled(status);

  // Billing lapsed -> suspend a live tenant.
  if (!entitled && tenant.status === 'active') {
    await transitionTenant(tenantId, 'suspended_billing', {
      actorType: 'system',
      reason: `subscription ${status}`,
    });
    return;
  }
  // Billing recovered -> reactivate a billing-suspended tenant.
  if (entitled && tenant.status === 'suspended_billing') {
    await transitionTenant(tenantId, 'active', {
      actorType: 'system',
      reason: `subscription ${status}`,
    });
  }
}

module.exports = {
  TRIAL_DAYS,
  isEntitled,
  createCheckoutSession,
  createPortalSession,
  syncSubscription,
};
