// SMS webhook: existing tenants keep the exact English copy; language-menu
// tenants get Hebrew consent/HELP/error copy by default and Russian when the
// inbound message is predominantly Cyrillic. Carrier STOP/START/HELP keywords
// keep working unchanged in all cases.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { stubModule, loadReal } = require('./helpers/stub-modules');

process.env.SMS_ENABLED = 'true';

const state = {
  valid: true,
  tenants: {},
  consent: new Map(), // `${tenantId}:${phone}` -> status
  aiReply: 'AI reply',
  aiThrows: false,
  aiCalls: [],
};

stubModule('server/lib/twilio', { isValidTwilioRequest: () => state.valid });
stubModule('server/lib/tenants', {
  resolveTenantByNumber: async (to) => state.tenants[to] || null,
  clearCache: () => {},
});
stubModule('server/lib/consent', {
  getStatus: async (tenantId, phone) => state.consent.get(`${tenantId}:${phone}`) || 'unknown',
  setStatus: async (tenantId, phone, status) => state.consent.set(`${tenantId}:${phone}`, status),
});
stubModule('server/lib/conversations', { getOrCreateConversation: async () => ({ id: 'conv-1' }) });
stubModule('server/lib/ai', {
  handleMessage: async (tenant, conversation, from, body) => {
    state.aiCalls.push({ tenant, body });
    if (state.aiThrows) throw new Error('boom');
    return state.aiReply;
  },
  buildSystemPrompt: () => '',
});
stubModule('server/lib/supabase', { supabase: { from: () => ({ insert: async () => ({}) }) } });
stubModule('server/lib/ratelimit', { checkInbound: async () => ({ allowed: true }) });
stubModule('server/lib/abuse-guard', { overLimit: () => false });
stubModule('server/lib/usage', {
  withinCaps: () => ({ ok: true }),
  recordUsage: async () => {},
  notifyCapBreach: () => {},
});
stubModule('server/lib/logger', { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} });

const express = require('express');
const router = loadReal('server/sms/webhook');

const US_NUMBER = '+19513958776';
const IL_NUMBER = '+97235550000';
const US_TENANT = { id: 'bce079db-645f-4cf2-aaee-e6f76df25874', business_name: 'Acme Plumbing', status: 'active' };
const IL_TENANT = {
  id: 'il-tenant',
  business_name: 'מרפאת חיוך',
  status: 'active',
  voice_settings: { language_menu: { enabled: true } },
};
state.tenants[US_NUMBER] = US_TENANT;
state.tenants[IL_NUMBER] = IL_TENANT;

let server;
let port;
let counter = 0;

test.before(async () => {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use('/', router);
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

test.after(() => server && server.close());

// Fresh sender each call so consent state never leaks between tests.
function freshPhone() {
  counter += 1;
  return `+1408555${String(1000 + counter)}`;
}

async function sms(to, body, from = freshPhone()) {
  const res = await fetch(`http://127.0.0.1:${port}/sms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ From: from, To: to, Body: body }).toString(),
  });
  return { status: res.status, body: await res.text(), from };
}

function messageText(xml) {
  const m = xml.match(/<Message>([\s\S]*?)<\/Message>/);
  return m ? m[1] : null;
}

test('US tenant consent prompt is the exact English string', async () => {
  const r = await sms(US_NUMBER, 'hi there');
  assert.equal(
    messageText(r.body),
    "Hi! You've reached Acme Plumbing. Reply YES to chat with our virtual receptionist, or STOP to opt out. Msg &amp; data rates may apply."
  );
});

test('US tenant HELP / pending / opt-in flows keep exact English copy', async () => {
  const help = await sms(US_NUMBER, 'HELP');
  assert.ok(help.body.includes('Acme Plumbing: automated virtual receptionist. Reply STOP to opt out. Msg &amp; data rates may apply.'));

  const phone = freshPhone();
  await sms(US_NUMBER, 'hello', phone); // -> pending
  const nag = await sms(US_NUMBER, 'what?', phone);
  assert.equal(messageText(nag.body), 'Reply YES to continue or STOP to opt out.');
  const yes = await sms(US_NUMBER, 'YES', phone);
  assert.equal(messageText(yes.body), "You're all set! How can I help you today?");
});

test('US tenant AI-error fallback keeps exact English copy', async () => {
  const phone = freshPhone();
  state.consent.set(`${US_TENANT.id}:${phone}`, 'opted_in');
  state.aiThrows = true;
  try {
    const r = await sms(US_NUMBER, 'book me in', phone);
    assert.equal(
      messageText(r.body),
      "Thanks for contacting Acme Plumbing! We're having a brief technical hiccup — someone will follow up shortly."
    );
  } finally {
    state.aiThrows = false;
  }
});

test('Israel tenant: Hebrew consent prompt by default, keywords intact', async () => {
  const r = await sms(IL_NUMBER, 'שלום, אפשר לקבוע תור?');
  const msg = messageText(r.body);
  assert.ok(/[֐-׿]/.test(msg), 'Hebrew consent prompt');
  assert.ok(msg.includes('YES') && msg.includes('STOP'));
  assert.ok(msg.includes(IL_TENANT.business_name));
});

test('Israel tenant: Russian consent prompt when the message is predominantly Cyrillic', async () => {
  const r = await sms(IL_NUMBER, 'Здравствуйте, можно записаться на приём?');
  const msg = messageText(r.body);
  assert.ok(/[Ѐ-ӿ]/.test(msg), 'Russian consent prompt');
  // The Hebrew business name is a proper noun and stays as-is; everything
  // else in the message must not be Hebrew.
  const withoutName = msg.split(IL_TENANT.business_name).join('');
  assert.ok(!/[֐-׿]/.test(withoutName), 'no Hebrew outside the business name');
  assert.ok(msg.includes('YES') && msg.includes('STOP'));
});

test('Israel tenant: HELP answers in Hebrew and still mentions STOP', async () => {
  const r = await sms(IL_NUMBER, 'HELP');
  const msg = messageText(r.body);
  assert.ok(/[֐-׿]/.test(msg));
  assert.ok(msg.includes('STOP'));
});

test('Israel tenant: STOP still opts out silently (carrier keyword handling unchanged)', async () => {
  const phone = freshPhone();
  const r = await sms(IL_NUMBER, 'STOP', phone);
  assert.ok(!r.body.includes('<Message>'), 'empty TwiML — Twilio sends its own STOP confirmation');
  assert.equal(state.consent.get(`${IL_TENANT.id}:${phone}`), 'opted_out');
});

test('Israel tenant: pending YES confirms in Hebrew; Russian pending re-prompt in Russian', async () => {
  const phone = freshPhone();
  await sms(IL_NUMBER, 'שלום', phone); // -> pending
  const nagRu = await sms(IL_NUMBER, 'что это такое?', phone);
  assert.ok(/[Ѐ-ӿ]/.test(messageText(nagRu.body)), 'Russian re-prompt for a Russian message');
  const yes = await sms(IL_NUMBER, 'YES', phone);
  assert.ok(/[֐-׿]/.test(messageText(yes.body)), 'Hebrew confirmation (YES is not Cyrillic)');
});

test('Israel tenant: opted-in messages reach the AI pipeline; errors fall back in language', async () => {
  const phone = freshPhone();
  state.consent.set(`${IL_TENANT.id}:${phone}`, 'opted_in');
  const ok = await sms(IL_NUMBER, 'мне нужна запись', phone);
  assert.equal(messageText(ok.body), 'AI reply');
  assert.equal(state.aiCalls[state.aiCalls.length - 1].tenant.id, IL_TENANT.id);

  state.aiThrows = true;
  try {
    const he = await sms(IL_NUMBER, 'אני רוצה תור', phone);
    assert.ok(/[֐-׿]/.test(messageText(he.body)), 'Hebrew error fallback');
    const ru = await sms(IL_NUMBER, 'запишите меня пожалуйста', phone);
    assert.ok(/[Ѐ-ӿ]/.test(messageText(ru.body)), 'Russian error fallback');
  } finally {
    state.aiThrows = false;
  }
});

test('Israel tenant not yet active: localized not-live message', async () => {
  const inactiveNumber = '+97235551111';
  state.tenants[inactiveNumber] = { ...IL_TENANT, id: 'il-2', status: 'provisioning' };
  const phone = freshPhone();
  state.consent.set(`il-2:${phone}`, 'opted_in');
  const r = await sms(inactiveNumber, 'שלום', phone);
  assert.ok(/[֐-׿]/.test(messageText(r.body)));
});
