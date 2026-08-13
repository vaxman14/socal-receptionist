const crypto = require('crypto');

const DEFAULT_TTL_MS = 2 * 60 * 1000;
const CONTEXT = 'socal-receptionist:voice-stream:v1';

function signingKey() {
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!token) throw new Error('TWILIO_AUTH_TOKEN is required to sign stream capabilities');
  return crypto.createHmac('sha256', token).update(CONTEXT).digest();
}

function issueStreamCapability(claims, { now = Date.now(), ttlMs = DEFAULT_TTL_MS } = {}) {
  const payload = Buffer.from(JSON.stringify({ v: 1, exp: now + ttlMs, claims })).toString('base64url');
  const signature = crypto.createHmac('sha256', signingKey()).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function verifyStreamCapability(token, { now = Date.now() } = {}) {
  try {
    if (typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const [payload, supplied] = parts;
    const expected = crypto.createHmac('sha256', signingKey()).update(payload).digest();
    const actual = Buffer.from(supplied, 'base64url');
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (decoded.v !== 1 || !Number.isFinite(decoded.exp) || decoded.exp < now || !decoded.claims) return null;
    return decoded.claims;
  } catch (_) {
    return null;
  }
}

module.exports = { issueStreamCapability, verifyStreamCapability };
