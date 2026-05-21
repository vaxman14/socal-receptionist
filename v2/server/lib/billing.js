// Billing + entitlements.
//
// Stripe drives entitlements, but the app decides service access from the
// mirrored `subscriptions` record — never from a live Stripe call (Codex
// review #6). syncSubscription() is the single point that updates that record
// and applies the resulting tenant suspension/reactivation.
//
// Pricing model (2026-05-21): checkout charges a one-time $1,500 setup fee that
// includes the first month of service, then $500/mo recurring. The monthly
// charge is deferred 30 days via a Stripe trial so the prepaid first month is
// not billed twice. A client who cancels within 14 days of paying the setup fee
// is automatically refunded $1,000 of it.

const { stripe } = require('./stripe');
const { supabase } = require('./supabase');
const { transitionTenant } = require('./state-machine');

// The setup fee covers month one, so the recurring price is deferred 30 days
// via a Stripe trial — the client is not billed the monthly fee until the
// prepaid first month is up. Stripe reports the subscription as `trialing`
// during this window; that status is entitled (see ENTITLED_STATUSES).
const TRIAL_DAYS = 30;

// 14-day cancellation policy: a client who cancels within 14 days of paying the
// setup fee is refunded $1,000 of it. The remaining $500 (the first month) is
// non-refundable.
const SETUP_REFUND_WINDOW_DAYS = 14;
const SETUP_REFUND_AMOUNT_CENTS = 100000; // $1,000.00

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
async function createCheckoutSession({ tenant, priceId, setupPriceId, successUrl, cancelUrl }) {
  const lineItems = [{ price: priceId, quantity: 1 }];
  if (setupPriceId) lineItems.push({ price: setupPriceId, quantity: 1 });

  return stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: lineItems,
    customer_email: tenant.owner_email,
    client_reference_id: tenant.id,
    payment_method_collection: 'always', // keep a card on file through the trial
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

// Record the setup-fee payment from a completed Checkout session so the 14-day
// refund policy has a clock start and a PaymentIntent to refund against. Called
// once, from the checkout.session.completed handler, after syncSubscription()
// has created the subscriptions row.
async function recordSetupPayment(tenantId, session) {
  if (!session.invoice) return; // subscription-mode checkout always has a first invoice
  const invoiceId = typeof session.invoice === 'string' ? session.invoice : session.invoice.id;
  const invoice = await stripe.invoices.retrieve(invoiceId);

  const paymentIntent =
    typeof invoice.payment_intent === 'string'
      ? invoice.payment_intent
      : invoice.payment_intent && invoice.payment_intent.id;
  if (!paymentIntent) return; // nothing charged at checkout (no setup fee configured)

  const paidAtUnix =
    (invoice.status_transitions && invoice.status_transitions.paid_at) || invoice.created;

  const { error } = await supabase
    .from('subscriptions')
    .update({
      setup_payment_intent: paymentIntent,
      setup_paid_at: new Date(paidAtUnix * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('tenant_id', tenantId);
  if (error) throw error;
}

// Apply the 14-day cancellation policy: if the tenant cancels within 14 days of
// paying the setup fee, refund $1,000 of it. Safe to call on every cancellation
// event — it no-ops outside the window or once the refund has been issued, and
// the Stripe idempotency key guards against a double refund from concurrent or
// retried webhook deliveries.
async function maybeRefundSetupFee(tenantId) {
  const { data: rec, error } = await supabase
    .from('subscriptions')
    .select('setup_payment_intent, setup_paid_at, setup_refunded_at')
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error) throw error;
  if (!rec || !rec.setup_payment_intent || !rec.setup_paid_at) return null;
  if (rec.setup_refunded_at) return null; // already refunded

  const ageMs = Date.now() - new Date(rec.setup_paid_at).getTime();
  if (ageMs > SETUP_REFUND_WINDOW_DAYS * 24 * 60 * 60 * 1000) return null; // window closed

  const refund = await stripe.refunds.create(
    {
      payment_intent: rec.setup_payment_intent,
      amount: SETUP_REFUND_AMOUNT_CENTS,
      reason: 'requested_by_customer',
      metadata: { tenant_id: tenantId, policy: '14_day_cancellation' },
    },
    { idempotencyKey: `setup-refund-${tenantId}` }
  );

  const { error: stampErr } = await supabase
    .from('subscriptions')
    .update({
      setup_refunded_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('tenant_id', tenantId);
  if (stampErr) throw stampErr;

  console.log(`[billing] tenant ${tenantId}: 14-day cancellation refund issued (${refund.id}, $1000)`);
  return refund;
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
  SETUP_REFUND_WINDOW_DAYS,
  SETUP_REFUND_AMOUNT_CENTS,
  isEntitled,
  createCheckoutSession,
  createPortalSession,
  recordSetupPayment,
  maybeRefundSetupFee,
  syncSubscription,
};
