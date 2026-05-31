// Twilio request verification.
//
// All tenants share the platform Twilio account, so a single auth token (from
// env) signs every webhook. The app runs behind the DigitalOcean / Cloudflare
// proxy, so req.protocol resolves to https only because index.js sets
// `trust proxy`.
//
// SECURITY: TWILIO_VALIDATE_SIGNATURE defaults to true. Setting it to 'false'
// is only permitted when NODE_ENV is explicitly 'development'. In production,
// bypassing signature validation is not allowed.

const twilio = require('twilio');

const authToken = process.env.TWILIO_AUTH_TOKEN || '';
const isDev = process.env.NODE_ENV === 'development';
// Validation can only be disabled in development mode. In production the env
// var is ignored and validation is always enforced.
const validateSignature = isDev
  ? process.env.TWILIO_VALIDATE_SIGNATURE !== 'false'
  : true;

// Verify a request genuinely came from Twilio (X-Twilio-Signature).
// Uses APP_BASE_URL to build the canonical webhook URL so a spoofed
// Host header cannot bypass signature validation (issue #14).
function isValidTwilioRequest(req) {
  if (!validateSignature) return true;
  const signature = req.header('X-Twilio-Signature') || '';
  const appBase = process.env.APP_BASE_URL
    ? process.env.APP_BASE_URL.replace(/\/+$/, '')
    : `${req.protocol}://${req.get('host')}`;
  const url = `${appBase}${req.originalUrl}`;
  return twilio.validateRequest(authToken, signature, url, req.body);
}

module.exports = { isValidTwilioRequest };
