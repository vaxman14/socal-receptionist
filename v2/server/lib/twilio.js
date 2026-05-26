// Twilio request verification.
//
// All tenants share the platform Twilio account, so a single auth token (from
// env) signs every webhook. The app runs behind the DigitalOcean / Cloudflare
// proxy, so req.protocol resolves to https only because index.js sets
// `trust proxy`.

const twilio = require('twilio');

const authToken = process.env.TWILIO_AUTH_TOKEN || '';
const validateSignature = process.env.TWILIO_VALIDATE_SIGNATURE !== 'false';

if (process.env.NODE_ENV === 'production' && !validateSignature) {
  throw new Error('TWILIO_VALIDATE_SIGNATURE=false is not allowed in production');
}
if (process.env.NODE_ENV === 'production' && !authToken) {
  throw new Error('TWILIO_AUTH_TOKEN is required in production');
}

// Verify a request genuinely came from Twilio (X-Twilio-Signature).
function isValidTwilioRequest(req) {
  if (!validateSignature) return true;
  const signature = req.header('X-Twilio-Signature') || '';
  const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
  return twilio.validateRequest(authToken, signature, url, req.body);
}

module.exports = { isValidTwilioRequest };
