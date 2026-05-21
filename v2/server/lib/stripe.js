// Stripe client. Backend-only — the secret key must never reach the browser.

const Stripe = require('stripe');

const key = process.env.STRIPE_SECRET_KEY;
if (!key) {
  throw new Error('STRIPE_SECRET_KEY environment variable is required');
}

const stripe = new Stripe(key);

module.exports = { stripe };
