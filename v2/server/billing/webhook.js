// Stripe webhook.
//
// Mirrors subscription state into Postgres (the app reads entitlements from
// there, not from Stripe live). Idempotent via the `processed_events` ledger:
// the event id is inserted before processing, so a duplicate delivery is a
// primary-key conflict and is ACKed without reprocessing (Codex review #6).

const express = require('express');
const { stripe } = require('../lib/stripe');
const { supabase } = require('../lib/supabase');
const { syncSubscription, recordSetupPayment, maybeRefundSetupFee } = require('../lib/billing');
const { enqueue } = require('../lib/jobs');

const router = express.Router();
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

// express.raw — Stripe signature verification needs the unparsed body, so this
// route must be registered before any JSON body parser (see index.js).
router.post('/billing/webhook', express.raw({ type: '*/*' }), async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.header('stripe-signature'),
      webhookSecret
    );
  } catch (err) {
    console.warn('[billing] bad webhook signature:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Idempotency: first writer wins. A duplicate event id conflicts -> ACK only.
  const { error: dupErr } = await supabase
    .from('processed_events')
    .insert({ id: event.id, source: 'stripe' });
  if (dupErr) {
    return res.sendStatus(200); // already processed
  }

  try {
    await handleEvent(event);
  } catch (err) {
    console.error(`[billing] event ${event.type} (${event.id}) failed:`, err.message);
    // Drop the idempotency marker so Stripe's retry can reprocess this event.
    await supabase.from('processed_events').delete().eq('id', event.id);
    return res.status(500).send('handler error');
  }
  res.sendStatus(200);
});

async function handleEvent(event) {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      const tenantId =
        session.client_reference_id || (session.metadata && session.metadata.tenant_id);
      if (!tenantId || !session.subscription) return;
      const sub = await stripe.subscriptions.retrieve(session.subscription);
      await syncSubscription(tenantId, sub);
      // Capture the setup-fee payment so the 14-day refund policy can act on it.
      await recordSetupPayment(tenantId, session);
      // Billing is set up — kick off the provisioning pipeline.
      await enqueue(tenantId, 'provision_tenant', {});
      break;
    }

    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const sub = event.data.object;
      const tenantId =
        (sub.metadata && sub.metadata.tenant_id) || (await tenantIdForCustomer(sub.customer));
      if (!tenantId) break;
      await syncSubscription(tenantId, sub);
      // Cancellation -> apply the 14-day setup-fee refund policy. No-ops if the
      // window has closed or the refund was already issued.
      const canceling =
        event.type === 'customer.subscription.deleted' ||
        sub.cancel_at_period_end === true ||
        sub.status === 'canceled';
      if (canceling) await maybeRefundSetupFee(tenantId);
      break;
    }

    case 'invoice.payment_failed':
    case 'invoice.payment_succeeded': {
      const invoice = event.data.object;
      if (!invoice.subscription) return;
      const sub = await stripe.subscriptions.retrieve(invoice.subscription);
      const tenantId =
        (sub.metadata && sub.metadata.tenant_id) || (await tenantIdForCustomer(sub.customer));
      if (tenantId) await syncSubscription(tenantId, sub);
      break;
    }

    default:
      // Unhandled event type — ACKed and ignored.
      break;
  }
}

async function tenantIdForCustomer(customer) {
  const customerId = typeof customer === 'string' ? customer : customer && customer.id;
  if (!customerId) return null;
  const { data } = await supabase
    .from('subscriptions')
    .select('tenant_id')
    .eq('stripe_customer_id', customerId)
    .maybeSingle();
  return data ? data.tenant_id : null;
}

module.exports = router;
