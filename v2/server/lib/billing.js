// Billing + entitlements.
//
// Stripe drives entitlements, but the app decides service access from the
// mirrored `subscriptions` record — never from a live Stripe call (Codex
// review #6). syncSubscription() is the single point that updates that record
// and applies the resulting tenant suspension/reactivation.
//
// One self-serve plan: $69 monthly or $690 annually. Every new tenant receives
// one 30-day trial. Checkout collects a card and schedules the first charge for
// the end of the tenant's existing no-card trial.

const { stripe } = require('./stripe');
const { supabase } = require('./supabase');
const { transitionTenant } = require('./state-machine');

// The setup fee covers month one, so the recurring price is deferred 30 days
// via a Stripe trial — the client is not billed the monthly fee until the
// prepaid first month is up. Stripe reports the subscription as `trialing`
// during this window; that status is entitled (see ENTITLED_STATUSES).
const TRIAL_DAYS = 30;

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
//
// The session bills the one-time setup fee today and starts the recurring
// monthly price after a 30-day trial — the setup fee already covers month one.
// In subscription mode Stripe invoices one-time line items on the first
// invoice, i.e. immediately at checkout. `payment_method_collection: 'always'`
// keeps the card on file for the recurring charges that begin after the trial.
async function createCheckoutSession({ tenant, priceId, successUrl, cancelUrl, trialEndsAt }) {
  const subscriptionData = { metadata: { tenant_id: tenant.id } };
  const existingTrialEnd = trialEndsAt ? new Date(trialEndsAt).getTime() : 0;
  const now = Date.now();
  if (existingTrialEnd > now) {
    const remainingMs = existingTrialEnd - now;
    if (remainingMs >= 48 * 60 * 60 * 1000) {
      subscriptionData.trial_end = Math.floor(existingTrialEnd / 1000);
    } else {
      subscriptionData.trial_period_days = 1;
    }
  } else if (!trialEndsAt) {
    subscriptionData.trial_period_days = TRIAL_DAYS;
  }

  return stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    customer_email: tenant.owner_email,
    client_reference_id: tenant.id,
    payment_method_collection: 'always',
    subscription_data: subscriptionData,
    metadata: { tenant_id: tenant.id },
    allow_promotion_codes: false,
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

  // upsert only touches the columns in `record`, so the setup_* refund-tracking
  // columns written by recordSetupPayment/maybeRefundSetupFee are preserved.
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
