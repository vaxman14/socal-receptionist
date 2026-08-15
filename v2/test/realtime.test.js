// Realtime bridge tests: the OpenAI session must request PCM16@24k output and
// transcode to mu-law with paced 20ms frames (known-good audio baseline), set
// the transcription language from the validated tenant-scoped selection, and
// never trust the raw selected_language custom parameter from the WebSocket.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { stubModule, loadReal } = require('./helpers/stub-modules');

process.env.TWILIO_ACCOUNT_SID = 'ACtest00000000000000000000000000';
process.env.TWILIO_AUTH_TOKEN = 'testtoken';
process.env.API_PUBLIC_BASE_URL = 'https://api.test.example';

const state = { tenant: null, tenantError: null, callStarts: 0, azureTexts: [], azureSignals: [], azureImpl: null };

class FakeWS extends EventEmitter {
  static OPEN = 1;
  static instances = [];
  constructor(url) {
    super();
    this.url = url;
    this.readyState = FakeWS.OPEN;
    this.sent = [];
    FakeWS.instances.push(this);
  }
  send(data) {
    this.sent.push(String(data));
  }
  close() {
    this.readyState = 3;
    this.emit('close');
  }
}

// A chainable no-op Supabase query builder; every terminal resolves to the
// configured tenant row (only the tenants lookup is exercised here).
function queryStub() {
  const q = {};
  for (const m of ['select', 'eq', 'in', 'insert', 'upsert', 'update']) q[m] = () => q;
  q.maybeSingle = async () => ({ data: state.tenant, error: state.tenantError });
  q.single = async () => ({ data: null });
  return q;
}

stubModule('ws', FakeWS);
stubModule('server/lib/supabase', { supabase: { from: () => queryStub() } });
stubModule('server/lib/conversations', {
  getOrCreateConversation: async () => ({ id: 'conv-1' }),
  loadTranscript: async () => [],
  appendMessage: async () => {},
});
stubModule('server/lib/calls', {
  recordCallStart: async () => { state.callStarts++; },
  updateCall: async () => {},
  getCallBySid: async () => null,
});
stubModule('server/lib/usage', {
  recordUsage: async () => {},
  estimateRealtimeCostCents: () => 0,
  estimateOpenaiCostCents: () => 0,
  withinCaps: () => ({ ok: true }),
  notifyCapBreach: () => {},
});
stubModule('server/lib/email', { sendEmail: async () => {}, brandedEmail: () => '', tenantBrand: () => ({}) });
stubModule('server/lib/public-api', { fireWebhooks: () => {} });
stubModule('server/lib/booking', { computeSlots: () => [], resolveDayPreference: () => null });
stubModule('server/integrations/google-calendar', {});
stubModule('server/integrations/microsoft-calendar', {});
stubModule('server/lib/voice-spam', { blockVoiceCaller: async () => {}, isGoogleVoiceSearchSpam: () => false });
stubModule('server/lib/logger', { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} });
stubModule('server/voice/azure-tts', {
  isAzureHebrewConfigured: (tenant) => tenant?.voice_settings?.tts_provider_he === 'azure',
  synthesizeHebrew: async (text, options = {}) => {
    state.azureTexts.push(text);
    state.azureSignals.push(options.signal);
    if (state.azureImpl) return state.azureImpl(text, options);
    return Buffer.alloc(1920);
  },
});

const { handleMediaStream } = loadReal('server/voice/realtime');
const audio = loadReal('server/voice/audio');
const { issueStreamCapability } = loadReal('server/voice/stream-capability');

const IL_TENANT = {
  id: 'il-tenant',
  business_name: 'מרפאת חיוך',
  status: 'active',
  voice_greeting: 'שלום, הגעתם למרפאת חיוך.',
  voice_settings: { language_menu: { enabled: true } },
};

const US_TENANT = {
  id: 'bce079db-645f-4cf2-aaee-e6f76df25874',
  business_name: 'Acme Plumbing',
  status: 'active',
  voice_greeting: 'Thank you for calling Acme Plumbing.',
};

function makeTwilioWs() {
  const ws = new EventEmitter();
  ws.readyState = 1;
  ws.sent = [];
  ws.send = (data) => ws.sent.push(JSON.parse(data));
  ws.close = () => { ws.readyState = 3; ws.emit('close'); };
  return ws;
}

const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));

// Boot a call: returns { twilioWs, oaiWs, session, greeting } after 'start'.
// Cleanup is registered on the test context so call timers (the 20ms drain
// interval, wrap-up/hard-stop timeouts) are cleared even when an assert fails.
async function startCall(t, tenant, customParams) {
  state.tenant = tenant;
  state.tenantError = null;
  const twilioWs = makeTwilioWs();
  t.after(() => twilioWs.emit('close'));
  handleMediaStream(twilioWs, {});
  twilioWs.emit('message', JSON.stringify({
    event: 'start',
    start: {
      streamSid: 'MZ-test',
      callSid: 'CA-test',
      customParameters: {
        stream_capability: issueStreamCapability({
          tenantId: tenant.id, callSid: 'CA-test', from: '+972****2222', to: '+972****0000',
          selectedLanguage: customParams?.selected_language,
          isCallback: customParams?.is_callback === 'true', leadName: customParams?.lead_name || null,
        }),
      },
    },
  }));
  await tick();
  const oaiWs = FakeWS.instances[FakeWS.instances.length - 1];
  const parsed = oaiWs.sent.map((s) => JSON.parse(s));
  const session = parsed.find((m) => m.type === 'session.update')?.session;
  const greeting = parsed.find((m) => m.type === 'response.create')?.response?.instructions;
  return { twilioWs, oaiWs, session, greeting };
}

test('session requests PCM16 @ 24kHz output (not pcmu) for every call', async (t) => {
  const { twilioWs, session } = await startCall(t, US_TENANT, {});
  assert.ok(session, 'session.update sent');
  assert.deepEqual(session.audio.output.format, { type: 'audio/pcm', rate: 24000 });
  assert.deepEqual(session.audio.input.format, { type: 'audio/pcmu' });
  twilioWs.emit('close');
});

test('Israel + selected_language=ru: Russian transcription, prompt, and greeting', async (t) => {
  const { twilioWs, session, greeting } = await startCall(t, IL_TENANT, { selected_language: 'ru' });
  assert.equal(session.audio.input.transcription.language, 'ru');
  assert.ok(session.instructions.includes('SELECTED CALL LANGUAGE: RUSSIAN'));
  assert.ok(!session.instructions.includes('SELECTED CALL LANGUAGE: HEBREW'));
  assert.ok(/[Ѐ-ӿ]/.test(greeting), 'greeting instruction contains Russian text');
  assert.ok(!greeting.includes(IL_TENANT.voice_greeting), 'Hebrew IVR greeting is not repeated in Russian mode');
  twilioWs.emit('close');
});

test('Israel + no selection (timeout path): Hebrew everywhere', async (t) => {
  const { twilioWs, session, greeting } = await startCall(t, IL_TENANT, {});
  assert.equal(session.audio.input.transcription.language, 'he');
  assert.ok(session.instructions.includes('SELECTED CALL LANGUAGE: HEBREW'));
  assert.ok(/[֐-׿]/.test(greeting), 'greeting instruction contains Hebrew text');
  twilioWs.emit('close');
});

test('Israel chooses the configured Realtime voice for each selected language', async (t) => {
  const tenant = {
    ...IL_TENANT,
    voice_settings: {
      ...IL_TENANT.voice_settings,
      realtime_voice_he: 'sage',
      realtime_voice_ru: 'coral',
    },
  };
  const hebrew = await startCall(t, tenant, {});
  assert.equal(hebrew.session.audio.output.voice, 'sage');
  hebrew.twilioWs.emit('close');

  const russian = await startCall(t, tenant, { selected_language: 'ru' });
  assert.equal(russian.session.audio.output.voice, 'coral');
  russian.twilioWs.emit('close');
});

test('Azure-enabled Hebrew converts OpenAI text to paced Twilio audio while Russian stays Realtime audio', async (t) => {
  state.azureTexts = [];
  state.azureSignals = [];
  state.azureImpl = null;
  const tenant = {
    ...IL_TENANT,
    voice_settings: {
      ...IL_TENANT.voice_settings,
      tts_provider_he: 'azure',
      realtime_voice_ru: 'coral',
    },
  };

  const hebrew = await startCall(t, tenant, {});
  assert.deepEqual(hebrew.session.output_modalities, ['text']);
  hebrew.oaiWs.emit('message', JSON.stringify({ type: 'response.output_text.done', text: 'שלום, איך אפשר לעזור?' }));
  hebrew.oaiWs.emit('message', JSON.stringify({ type: 'response.done', response: { status: 'completed' } }));
  await tick(150);
  assert.deepEqual(state.azureTexts, ['שלום, איך אפשר לעזור?']);
  assert.ok(hebrew.twilioWs.sent.some((message) => message.event === 'media'));
  hebrew.twilioWs.emit('close');

  const russian = await startCall(t, tenant, { selected_language: 'ru' });
  assert.deepEqual(russian.session.output_modalities, ['audio']);
  assert.equal(russian.session.audio.output.voice, 'coral');
  russian.twilioWs.emit('close');
});

test('caller speech aborts pending Azure Hebrew synthesis and clears Twilio playback', async (t) => {
  state.azureTexts = [];
  state.azureSignals = [];
  state.azureImpl = () => new Promise(() => {});
  t.after(() => { state.azureImpl = null; });
  const tenant = {
    ...IL_TENANT,
    voice_settings: { ...IL_TENANT.voice_settings, tts_provider_he: 'azure' },
  };
  const call = await startCall(t, tenant, {});
  call.oaiWs.emit('message', JSON.stringify({ type: 'response.output_text.done', text: 'שלום' }));
  call.oaiWs.emit('message', JSON.stringify({ type: 'response.done', response: { status: 'completed' } }));
  await tick();
  assert.equal(state.azureSignals.length, 1);
  assert.equal(state.azureSignals[0].aborted, false);

  call.oaiWs.emit('message', JSON.stringify({ type: 'input_audio_buffer.speech_started' }));
  await tick();
  assert.equal(state.azureSignals[0].aborted, true);
  assert.ok(call.twilioWs.sent.some((message) => message.event === 'clear'));
  call.twilioWs.emit('close');
});

test('Israel + forged selection is rejected to Hebrew', async (t) => {
  const { twilioWs, session } = await startCall(t, IL_TENANT, { selected_language: 'en"><injected>' });
  assert.equal(session.audio.input.transcription.language, 'he');
  assert.ok(session.instructions.includes('SELECTED CALL LANGUAGE: HEBREW'));
  twilioWs.emit('close');
});

test('US tenant ignores a smuggled selected_language: stays English, greeting unchanged', async (t) => {
  const { twilioWs, session, greeting } = await startCall(t, US_TENANT, { selected_language: 'ru' });
  assert.equal(session.audio.input.transcription.language, 'en');
  assert.ok(!session.instructions.includes('SELECTED CALL LANGUAGE'));
  assert.ok(greeting.includes(`Say this greeting exactly: "${US_TENANT.voice_greeting}"`));
  assert.ok(!/[Ѐ-ӿ֐-׿]/.test(greeting));
  twilioWs.emit('close');
});

test('OpenAI PCM deltas are transcoded to mu-law and paced in 20ms frames', async (t) => {
  const { twilioWs, oaiWs } = await startCall(t, US_TENANT, {});
  // 1920 bytes = 960 PCM16 samples of silence @24k -> 320 mu-law bytes = 2 frames.
  const silence = Buffer.alloc(1920).toString('base64');
  oaiWs.emit('message', JSON.stringify({ type: 'response.output_audio.delta', delta: silence }));
  await tick(150);
  const media = twilioWs.sent.filter((m) => m.event === 'media');
  assert.ok(media.length >= 2, `expected >=2 paced frames, got ${media.length}`);
  for (const m of media) {
    const frame = Buffer.from(m.media.payload, 'base64');
    assert.equal(frame.length, audio.FRAME_BYTES);
    assert.ok(frame.every((b) => b === audio.linearToMulaw(0)), 'silence PCM must arrive as mu-law silence (0xff), not raw bytes');
  }
  twilioWs.emit('close');
});

test('incremental audio deltas retain partial frames until enough bytes arrive', async (t) => {
  const { twilioWs, oaiWs } = await startCall(t, US_TENANT, {});
  const delta = Buffer.alloc(40 * 6).toString('base64');
  for (let i = 0; i < 3; i++) {
    oaiWs.emit('message', JSON.stringify({ type: 'response.output_audio.delta', delta }));
    await tick(30);
  }
  assert.equal(twilioWs.sent.filter((m) => m.event === 'media').length, 0);
  oaiWs.emit('message', JSON.stringify({ type: 'response.output_audio.delta', delta }));
  await tick(30);
  const media = twilioWs.sent.filter((m) => m.event === 'media');
  assert.equal(media.length, 1);
  assert.equal(Buffer.from(media[0].media.payload, 'base64').length, 160);
});

for (const [label, transcript, language] of [['Hebrew', 'כן', 'he'], ['Russian', 'да', 'ru']]) {
  test(`manual turn mode recognizes ${label} letters`, async (t) => {
    const tenant = { ...IL_TENANT, voice_settings: { ...IL_TENANT.voice_settings, turn_detection: { create_response: false } } };
    const { oaiWs } = await startCall(t, tenant, { selected_language: language });
    const before = oaiWs.sent.length;
    oaiWs.emit('message', JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', transcript }));
    await tick();
    assert.ok(oaiWs.sent.slice(before).map(JSON.parse).some((m) => m.type === 'response.create'));
  });
}

test('invalid capability closes before OpenAI creation or tenant side effects', async () => {
  state.callStarts = 0;
  const count = FakeWS.instances.length;
  const twilioWs = makeTwilioWs();
  handleMediaStream(twilioWs, {});
  twilioWs.emit('message', JSON.stringify({ event: 'start', start: { streamSid: 'MZ-x', callSid: 'CA-x', customParameters: { stream_capability: 'bad' } } }));
  await tick();
  assert.equal(twilioWs.readyState, 3);
  assert.equal(FakeWS.instances.length, count);
  assert.equal(state.callStarts, 0);
});

test('malformed Twilio JSON closes without opening OpenAI', async () => {
  const count = FakeWS.instances.length;
  const twilioWs = makeTwilioWs();
  handleMediaStream(twilioWs, {});
  twilioWs.emit('message', '{bad');
  await tick();
  assert.equal(twilioWs.readyState, 3);
  assert.equal(FakeWS.instances.length, count);
});

test('tenant lookup errors close both sockets and do not record a call', async () => {
  state.tenant = US_TENANT;
  state.tenantError = new Error('db down');
  state.callStarts = 0;
  const count = FakeWS.instances.length;
  const twilioWs = makeTwilioWs();
  handleMediaStream(twilioWs, {});
  const token = issueStreamCapability({ tenantId: US_TENANT.id, callSid: 'CA-db', from: '+1', to: '+2' });
  twilioWs.emit('message', JSON.stringify({ event: 'start', start: { streamSid: 'MZ-db', callSid: 'CA-db', customParameters: { stream_capability: token } } }));
  await tick();
  assert.equal(twilioWs.readyState, 3);
  assert.equal(FakeWS.instances.length, count, 'OpenAI is not opened on failed lookup');
  assert.equal(state.callStarts, 0);
  state.tenantError = null;
});

test('malformed OpenAI JSON closes both sockets', async (t) => {
  const { twilioWs, oaiWs } = await startCall(t, US_TENANT, {});
  oaiWs.emit('message', '{bad');
  await tick();
  assert.equal(twilioWs.readyState, 3);
  assert.equal(oaiWs.readyState, 3);
});
