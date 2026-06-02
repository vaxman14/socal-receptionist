// Twilio request verification.
//
// All tenants share the platform Twilio account, so a single auth token (from
// env) signs every webhook. The app runs behind the DigitalOcean / Cloudflare
// proxy, so req.protocol resolves to https only because index.js sets
// `trust proxy`.

const twilio = require('twilio');

const authToken = process.env.TWILIO_AUTH_TOKEN || '';
const validateSignature = process.env.TWILIO_VALIDATE_SIGNATURE !== 'false';

// Verify a request genuinely came from Twilio (X-Twilio-Signature).
// Use APP_BASE_URL when set — avoids proxy/header reconstruction mismatches.
function isValidTwilioRequest(req) {
  if (!validateSignature) return true;
  const signature = req.header('X-Twilio-Signature') || '';
  const base = process.env.APP_BASE_URL
    ? process.env.APP_BASE_URL.replace(/\/+$/, '')
    : `${req.protocol}://${req.get('host')}`;
  const url = `${base}${req.originalUrl}`;
  return twilio.validateRequest(authToken, signature, url, req.body);
}

module.exports = { isValidTwilioRequest };
