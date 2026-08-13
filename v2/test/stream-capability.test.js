const test = require('node:test');
const assert = require('node:assert/strict');

process.env.TWILIO_AUTH_TOKEN = 'testtoken';
const { issueStreamCapability, verifyStreamCapability } = require('../server/voice/stream-capability');

const claims = {
  tenantId: 'tenant-1',
  callSid: 'CA123',
  from: '+15551230000',
  to: '+15559870000',
  selectedLanguage: 'ru',
  isCallback: true,
  leadName: 'Ирина',
};

test('stream capability round-trips all bound fields', () => {
  const token = issueStreamCapability(claims, { now: 1_000_000, ttlMs: 60_000 });
  assert.deepEqual(verifyStreamCapability(token, { now: 1_030_000 }), claims);
});

test('stream capability rejects tampering, expiry, and missing secret', () => {
  const token = issueStreamCapability(claims, { now: 1_000_000, ttlMs: 60_000 });
  assert.equal(verifyStreamCapability(`${token.slice(0, -1)}x`, { now: 1_030_000 }), null);
  assert.equal(verifyStreamCapability(token, { now: 1_060_001 }), null);
  const old = process.env.TWILIO_AUTH_TOKEN;
  delete process.env.TWILIO_AUTH_TOKEN;
  try {
    assert.throws(() => issueStreamCapability(claims), /TWILIO_AUTH_TOKEN/);
    assert.equal(verifyStreamCapability(token), null);
  } finally {
    process.env.TWILIO_AUTH_TOKEN = old;
  }
});
