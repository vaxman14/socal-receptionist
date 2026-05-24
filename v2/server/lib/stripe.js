const Stripe = require('stripe');

let _stripe = null;

function getStripe() {
  if (!_stripe) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error('STRIPE_SECRET_KEY environment variable is required');
    _stripe = new Stripe(key);
  }
  return _stripe;
}

const stripe = new Proxy({}, {
  get(_, prop) { return Reflect.get(getStripe(), prop); },
  apply(_, thisArg, args) { return Reflect.apply(getStripe(), thisArg, args); },
});

module.exports = { stripe };
