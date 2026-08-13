// Router-level tests for /voice: existing (US) tenants keep the exact current
// flow — direct <Connect><Stream>, and /voice/menu press-2 = staff transfer —
// while language-menu tenants get the Hebrew greeting + Russian-only option
// and DTMF language selection feeding selected_language to the stream.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { stubModule, loadReal } = require('./helpers/stub-modules');

process.env.API_PUBLIC_BASE_URL = 'https://api.test.example';
process.env.TWILIO_AUTH_TOKEN = 'testtoken';

const state = { valid: true, tenants: {}, blocked: false, overLimit: false, caps: { ok: true } };

stubModule('server/lib/twilio', { isValidTwilioRequest: () => state.valid });
stubModule('server/lib/tenants', {
  resolveTenantByNumber: async (to) => state.tenants[to] || null,
  clearCache: () => {},
});
stubModule('server/lib/abuse-guard', { overLimit: () => state.overLimit });
stubModule('server/lib/conversations', { getOrCreateConversation: async () => ({ id: 'conv-1' }) });
stubModule('server/lib/ai', { handleMessage: async () => 'ok', buildSystemPrompt: () => '' });
stubModule('server/lib/calls', {
  recordCallStart: async () => {},
  updateCall: async () => {},
  getCallBySid: async () => null,
});
stubModule('server/lib/time-tickets', { draftFromCall: async () => {} });
stubModule('server/lib/email', { sendEmail: async () => {}, brandedEmail: () => '', tenantBrand: () => ({}) });
stubModule('server/lib/public-api', { fireWebhooks: () => {} });
stubModule('server/lib/usage', {
  withinCaps: () => state.caps,
  notifyCapBreach: () => {},
  recordUsage: async () => {},
  estimateRealtimeCostCents: () => 0,
});
stubModule('server/lib/voice-spam', {
  isBlockedVoiceCaller: async () => state.blocked,
  blockVoiceCaller: async () => {},
  isGoogleVoiceSearchSpam: () => false,
});
stubModule('server/lib/supabase', { supabase: {} });
stubModule('server/lib/logger', { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} });

const express = require('express');
const router = loadReal('server/voice/webhook');
const { verifyStreamCapability } = loadReal('server/voice/stream-capability');

const US_NUMBER = '+19514776060';
const IL_NUMBER = '+97235550000';

const US_TENANT = {
  id: 'bce079db-645f-4cf2-aaee-e6f76df25874',
  business_name: 'Acme Plumbing',
  status: 'active',
  staff_phone: '+19995551111',
  voice_greeting: 'Thank you for calling Acme Plumbing.',
};

const IL_TENANT = {
  id: 'il-tenant',
  business_name: 'מרפאת חיוך',
  status: 'active',
  staff_phone: '+972505550000',
  voice_greeting: 'שלום, הגעתם למרפאת חיוך.',
  voice_settings: { language_menu: { enabled: true } },
};

state.tenants[US_NUMBER] = US_TENANT;
state.tenants[IL_NUMBER] = IL_TENANT;

let server;
let port;

test.before(async () => {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use('/', router);
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

test.after(() => server && server.close());

async function post(path, params) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  return { status: res.status, body: await res.text() };
}

function capabilityFromTwiML(body) {
  const encoded = body.match(/<Parameter name="stream_capability" value="([^"]+)"\/>/)?.[1];
  assert.ok(encoded, 'stream capability parameter present');
  return verifyStreamCapability(encoded.replaceAll('&amp;', '&'));
}

test('US tenant /voice: direct stream connect, no language menu, no selected_language', async () => {
  const r = await post('/voice', { From: '+19515551234', To: US_NUMBER, CallSid: 'CA1' });
  assert.equal(r.status, 200);
  assert.ok(r.body.includes('<Connect>'));
  assert.ok(r.body.includes('wss://api.test.example/voice/stream'));
  assert.deepEqual(capabilityFromTwiML(r.body), {
    tenantId: US_TENANT.id, callSid: 'CA1', from: '+19515551234', to: US_NUMBER,
    isCallback: false, leadName: null,
  });
  assert.ok(!r.body.includes('selected_language'));
  assert.ok(!r.body.includes('<Gather'));
  assert.ok(!/[Ѐ-ӿ֐-׿]/.test(r.body), 'no Cyrillic/Hebrew for US tenants');
});

test('US tenant /voice/menu press 2 still transfers to staff (unchanged)', async () => {
  const r = await post('/voice/menu', { From: '+19515551234', To: US_NUMBER, CallSid: 'CA2', Digits: '2' });
  assert.equal(r.status, 200);
  assert.ok(r.body.includes('One moment while I connect you with our staff.'));
  assert.ok(r.body.includes(US_TENANT.staff_phone));
  assert.ok(r.body.includes('<Dial'));
  assert.ok(r.body.includes('action="/voice/dial-status"'));
});

test('US tenant /voice/menu press 1 still routes to the AI converse loop', async () => {
  const r = await post('/voice/menu', { From: '+19515551234', To: US_NUMBER, CallSid: 'CA3', Digits: '1' });
  assert.equal(r.status, 200);
  assert.ok(r.body.includes('action="/voice/converse"'));
});

test('Israel tenant /voice: Hebrew greeting then Russian-only option, exact order', async () => {
  const r = await post('/voice', { From: '+972501112222', To: IL_NUMBER, CallSid: 'CA4' });
  assert.equal(r.status, 200);
  // One-digit gather posting to the language selector.
  assert.ok(/<Gather[^>]*numDigits="1"/.test(r.body));
  assert.ok(/<Gather[^>]*action="\/voice\/language-select"/.test(r.body));
  // Hebrew greeting comes from tenant.voice_greeting, and comes FIRST.
  const hebrewIdx = r.body.indexOf(IL_TENANT.voice_greeting);
  const russianIdx = r.body.indexOf('Для русского языка нажмите 2.');
  assert.ok(hebrewIdx !== -1, 'Hebrew greeting present');
  assert.ok(russianIdx !== -1, 'Russian option present, exact sentence');
  assert.ok(hebrewIdx < russianIdx, 'Hebrew greeting precedes the Russian option');
  // The Russian option is never explained in Hebrew: the only "2" and the only
  // press-instruction live in the single Russian sentence.
  const says = [...r.body.matchAll(/<Say[^>]*>([\s\S]*?)<\/Say>/g)].map((m) => m[1]);
  const hebrewSays = says.filter((s) => /[֐-׿]/.test(s));
  for (const s of hebrewSays) {
    assert.ok(!s.includes('2'), 'Hebrew prompts never mention the digit');
    assert.ok(!/[Ѐ-ӿ]/.test(s), 'Hebrew prompts contain no Russian');
  }
  assert.equal(says.filter((s) => s.includes('2')).length, 1, 'digit 2 mentioned only once — in Russian');
  // Timeout falls through to the selector (-> Hebrew), not to the old menu.
  assert.ok(r.body.includes('<Redirect method="POST">/voice/language-select</Redirect>'));
  // No stream yet, and no staff-transfer menu at this stage.
  assert.ok(!r.body.includes('<Connect>'));
  assert.ok(!r.body.includes('/voice/menu'));
});

test('Israel /voice/language-select: 2 = Russian', async () => {
  const r = await post('/voice/language-select', { From: '+972501112222', To: IL_NUMBER, CallSid: 'CA5', Digits: '2' });
  assert.equal(r.status, 200);
  assert.ok(r.body.includes('<Connect>'));
  assert.ok(r.body.includes('wss://api.test.example/voice/stream'));
  assert.equal(capabilityFromTwiML(r.body).selectedLanguage, 'ru');
  assert.equal(capabilityFromTwiML(r.body).tenantId, IL_TENANT.id);
  // Press-2 no longer dials staff for language-menu tenants.
  assert.ok(!r.body.includes('<Dial'));
  assert.ok(!r.body.includes(IL_TENANT.staff_phone));
});

test('Israel /voice/language-select: other digit or timeout = Hebrew', async () => {
  for (const params of [
    { From: '+972501112222', To: IL_NUMBER, CallSid: 'CA6', Digits: '1' },
    { From: '+972501112222', To: IL_NUMBER, CallSid: 'CA7', Digits: '9' },
    { From: '+972501112222', To: IL_NUMBER, CallSid: 'CA8' }, // timeout — no digits
  ]) {
    const r = await post('/voice/language-select', params);
    assert.equal(r.status, 200);
    assert.equal(capabilityFromTwiML(r.body).selectedLanguage, 'he', JSON.stringify(params));
  }
});

test('US tenant reaching /voice/language-select is rejected fail-closed', async () => {
  const r = await post('/voice/language-select', { From: '+19515551234', To: US_NUMBER, CallSid: 'CA9', Digits: '2' });
  assert.equal(r.status, 200);
  assert.ok(r.body.includes('<Reject'));
  assert.ok(!r.body.includes('<Connect>'));
});

test('language-select repeats active, voice-enabled, blocked, caller-limit, and spend gates', async () => {
  const cases = [
    () => { IL_TENANT.status = 'suspended_billing'; },
    () => { IL_TENANT.voice_enabled = false; },
    () => { state.blocked = true; },
    () => { state.overLimit = true; },
    () => { state.caps = { ok: false, reason: 'monthly' }; },
  ];
  for (const arrange of cases) {
    IL_TENANT.status = 'active'; delete IL_TENANT.voice_enabled;
    state.blocked = false; state.overLimit = false; state.caps = { ok: true };
    arrange();
    const r = await post('/voice/language-select', { From: '+972545552222', To: IL_NUMBER, CallSid: 'CA-gate', Digits: '2' });
    assert.ok(!r.body.includes('<Connect>'), `gate leaked stream: ${r.body}`);
  }
  IL_TENANT.status = 'active'; delete IL_TENANT.voice_enabled;
  state.blocked = false; state.overLimit = false; state.caps = { ok: true };
});

test('Twilio signature is still enforced on /voice and /voice/language-select', async () => {
  state.valid = false;
  try {
    for (const path of ['/voice', '/voice/language-select', '/voice/menu']) {
      const r = await post(path, { From: '+19515551234', To: US_NUMBER, CallSid: 'CA10' });
      assert.equal(r.status, 403, path);
    }
  } finally {
    state.valid = true;
  }
});
