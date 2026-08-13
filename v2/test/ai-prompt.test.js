// buildSystemPrompt language appendices: voice prompts gain a strong
// selected-language block for menu tenants; SMS prompts gain the Hebrew/Russian
// policy; non-menu (US) tenants get byte-identical prompts to before.

const test = require('node:test');
const assert = require('node:assert/strict');
const { stubModule, loadReal } = require('./helpers/stub-modules');

// lib/ai pulls in supabase/usage/email/public-api at require time — stub them
// so no env secrets are needed.
stubModule('server/lib/supabase', { supabase: {} });
stubModule('server/lib/conversations', { loadTranscript: async () => [], appendMessage: async () => {} });
stubModule('server/lib/usage', { recordUsage: async () => {}, estimateOpenaiCostCents: () => 0 });
stubModule('server/lib/email', { sendEmail: async () => {} });
stubModule('server/lib/public-api', { fireWebhooks: () => {} });

const { buildSystemPrompt } = loadReal('server/lib/ai');

const US_TENANT = {
  id: 'bce079db-645f-4cf2-aaee-e6f76df25874',
  business_name: 'Acme Plumbing',
  business_hours: 'Mon-Fri 9-5',
  business_services: 'Plumbing',
};

const IL_TENANT = {
  id: 'il-tenant',
  business_name: 'מרפאת חיוך',
  business_hours: 'א-ה 9-17',
  business_services: 'רפואת שיניים',
  voice_settings: { language_menu: { enabled: true } },
};

test('US tenant voice prompt is unchanged — no language block', () => {
  const p = buildSystemPrompt(US_TENANT, { channel: 'voice', callerPhone: '+19515551234' });
  assert.ok(!p.includes('SELECTED CALL LANGUAGE'));
  assert.ok(!p.includes('LANGUAGE POLICY'));
  assert.ok(p.trim().endsWith('by its last four digits.'), 'still ends with the guardrails block');
});

test('US tenant SMS prompt is unchanged — no language policy', () => {
  const p = buildSystemPrompt(US_TENANT, {});
  assert.ok(!p.includes('LANGUAGE POLICY'));
  assert.ok(!p.includes('SELECTED CALL LANGUAGE'));
});

test('Israel voice prompt: Hebrew mode appends Hebrew-only instructions', () => {
  const p = buildSystemPrompt(IL_TENANT, { channel: 'voice', selectedLanguage: 'he' });
  assert.ok(p.includes('SELECTED CALL LANGUAGE: HEBREW'));
  assert.ok(/Speak ONLY Hebrew/.test(p));
  assert.ok(/[Pp]roper nouns/.test(p));
  assert.ok(!p.includes('SELECTED CALL LANGUAGE: RUSSIAN'));
});

test('Israel voice prompt: Russian mode appends Russian-only instructions', () => {
  const p = buildSystemPrompt(IL_TENANT, { channel: 'voice', selectedLanguage: 'ru' });
  assert.ok(p.includes('SELECTED CALL LANGUAGE: RUSSIAN'));
  assert.ok(/Speak ONLY Russian/.test(p));
});

test('Israel voice prompt: invalid selection falls back to Hebrew', () => {
  const p = buildSystemPrompt(IL_TENANT, { channel: 'voice', selectedLanguage: 'zz' });
  assert.ok(p.includes('SELECTED CALL LANGUAGE: HEBREW'));
});

test('US tenant voice prompt ignores a smuggled selectedLanguage', () => {
  const p = buildSystemPrompt(US_TENANT, { channel: 'voice', selectedLanguage: 'ru' });
  assert.ok(!p.includes('SELECTED CALL LANGUAGE'));
});

test('Israel SMS prompt appends the Hebrew-default / Russian-detection policy', () => {
  const p = buildSystemPrompt(IL_TENANT, {});
  assert.ok(p.includes('LANGUAGE POLICY'));
  assert.ok(/Default language is Hebrew/.test(p));
  assert.ok(/Cyrillic/.test(p));
});

test('language block also lands on tenant-supplied custom prompts', () => {
  const custom = { ...IL_TENANT, ai_system_prompt: 'You are a custom receptionist.' };
  const voice = buildSystemPrompt(custom, { channel: 'voice', selectedLanguage: 'ru' });
  assert.ok(voice.startsWith('You are a custom receptionist.'));
  assert.ok(voice.includes('SELECTED CALL LANGUAGE: RUSSIAN'));
  const sms = buildSystemPrompt(custom, {});
  assert.ok(sms.includes('LANGUAGE POLICY'));

  const usCustom = { ...US_TENANT, ai_system_prompt: 'You are a custom receptionist.' };
  const usPrompt = buildSystemPrompt(usCustom, { channel: 'voice' });
  assert.ok(!usPrompt.includes('SELECTED CALL LANGUAGE'));
});
