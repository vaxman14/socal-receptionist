const crypto = require('crypto');
const config = require('./config');

// Stateless HMAC-signed tokens for Twilio stream authentication.
// Passed as a <Parameter> in TwiML (not as a URL query param — DO strips those from WS upgrades).
// Uses the OpenAI API key as HMAC secret: it's already in env, consistent across all instances.

function makeStreamToken(callSid, from) {
  const exp = Date.now() + 30_000;
  const payload = Buffer.from(JSON.stringify({ callSid, from, exp })).toString('base64url');
  const sig = crypto.createHmac('sha256', config.openai.apiKey).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifyStreamToken(raw) {
  if (!raw) return null;
  const dot = raw.lastIndexOf('.');
  if (dot < 1) return null;
  const payload = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  try {
    const expected = crypto.createHmac('sha256', config.openai.apiKey).update(payload).digest('base64url');
    const sBuf = Buffer.from(sig, 'utf8');
    const eBuf = Buffer.from(expected, 'utf8');
    if (sBuf.length !== eBuf.length || !crypto.timingSafeEqual(sBuf, eBuf)) return null;
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!data.exp || data.exp < Date.now()) return null;
    return data;
  } catch { return null; }
}

module.exports = { makeStreamToken, verifyStreamToken };
