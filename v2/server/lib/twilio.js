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
// Uses API_PUBLIC_BASE_URL (the backend's public origin) — not APP_BASE_URL
// which is the SPA/frontend origin and may differ.
function isValidTwilioRequest(req) {
  if (!validateSignature) return true;
  const signature = req.header('X-Twilio-Signature') || '';
  const apiBase = (
    process.env.API_PUBLIC_BASE_URL ||
    process.env.APP_BASE_URL ||
    `${req.protocol}://${req.get('host')}`
  ).replace(/\/+$/, '');
  const url = `${apiBase}${req.originalUrl}`;
  return twilio.validateRequest(authToken, signature, url, req.body);
}

module.exports = { isValidTwilioRequest };
