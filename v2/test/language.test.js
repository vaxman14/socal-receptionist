// Tenant-scoped language helpers — the Israel localization is driven entirely
// by tenants.voice_settings.language_menu.enabled, never by hostname or env.

const test = require('node:test');
const assert = require('node:assert/strict');

const lang = require('../server/lib/language');

const US_TENANT = {
  id: 'bce079db-645f-4cf2-aaee-e6f76df25874',
  business_name: 'Acme Plumbing',
  voice_settings: {},
};

const IL_TENANT = {
  id: 'il-tenant',
  business_name: 'מרפאת שיניים חיוך',
  voice_greeting: 'שלום, הגעתם למרפאת שיניים חיוך.',
  voice_settings: { language_menu: { enabled: true } },
};

test('languageMenuEnabled: only an explicit true enables it', () => {
  assert.equal(lang.languageMenuEnabled(IL_TENANT), true);
  assert.equal(lang.languageMenuEnabled(US_TENANT), false);
  assert.equal(lang.languageMenuEnabled({}), false);
  assert.equal(lang.languageMenuEnabled(null), false);
  assert.equal(lang.languageMenuEnabled({ voice_settings: { language_menu: { enabled: 'true' } } }), false);
  assert.equal(lang.languageMenuEnabled({ voice_settings: { language_menu: { enabled: 1 } } }), false);
});

test('languageFromDigits: 2 selects Russian, anything else Hebrew', () => {
  assert.equal(lang.languageFromDigits('2'), 'ru');
  assert.equal(lang.languageFromDigits('1'), 'he');
  assert.equal(lang.languageFromDigits('9'), 'he');
  assert.equal(lang.languageFromDigits(''), 'he');
  assert.equal(lang.languageFromDigits(undefined), 'he');
});

test('resolveSelectedLanguage: validates untrusted WS input against the tenant setting', () => {
  // Menu tenant: only 'ru'/'he' accepted; everything else defaults to Hebrew.
  assert.equal(lang.resolveSelectedLanguage(IL_TENANT, 'ru'), 'ru');
  assert.equal(lang.resolveSelectedLanguage(IL_TENANT, 'he'), 'he');
  assert.equal(lang.resolveSelectedLanguage(IL_TENANT, 'en'), 'he');
  assert.equal(lang.resolveSelectedLanguage(IL_TENANT, 'xx"><script>'), 'he');
  assert.equal(lang.resolveSelectedLanguage(IL_TENANT, undefined), 'he');
  // Non-menu tenants stay English no matter what arrives over the WS.
  assert.equal(lang.resolveSelectedLanguage(US_TENANT, 'ru'), 'en');
  assert.equal(lang.resolveSelectedLanguage(US_TENANT, 'he'), 'en');
  assert.equal(lang.resolveSelectedLanguage(US_TENANT, undefined), 'en');
  assert.equal(lang.resolveSelectedLanguage(null, 'ru'), 'en');
});

test('Russian menu prompt is the exact required sentence', () => {
  assert.equal(lang.RUSSIAN_MENU_PROMPT, 'Для русского языка нажмите 2.');
});

test('hebrewMenuGreeting: tenant.voice_greeting wins, Hebrew fallback otherwise', () => {
  assert.equal(lang.hebrewMenuGreeting(IL_TENANT), 'שלום, הגעתם למרפאת שיניים חיוך.');
  const noGreeting = { ...IL_TENANT, voice_greeting: null };
  const fallback = lang.hebrewMenuGreeting(noGreeting);
  assert.ok(/[֐-׿]/.test(fallback), 'fallback must be Hebrew');
  assert.ok(fallback.includes(noGreeting.business_name));
  // The Hebrew greeting must NOT explain the Russian option.
  assert.ok(!/2/.test(fallback));
  assert.ok(!/[Ѐ-ӿ]/.test(fallback), 'no Cyrillic in the Hebrew greeting');
});

test('realtimeGreeting: natural fallbacks per language, tenant-overridable', () => {
  const he = lang.realtimeGreeting(IL_TENANT, 'he');
  assert.ok(/[֐-׿]/.test(he), 'Hebrew greeting is Hebrew');
  assert.ok(!/[Ѐ-ӿ]/.test(he));
  const ru = lang.realtimeGreeting(IL_TENANT, 'ru');
  assert.ok(/[Ѐ-ӿ]/.test(ru), 'Russian greeting is Russian');
  assert.ok(!/[֐-׿]/.test(ru));
  const custom = {
    ...IL_TENANT,
    voice_settings: { language_menu: { enabled: true, ai_greeting_he: 'שלום עולם', ai_greeting_ru: 'Привет мир' } },
  };
  assert.equal(lang.realtimeGreeting(custom, 'he'), 'שלום עולם');
  assert.equal(lang.realtimeGreeting(custom, 'ru'), 'Привет мир');
});

test('voiceLanguageInstructions: strong single-language blocks, empty for en', () => {
  assert.equal(lang.voiceLanguageInstructions('en'), '');
  const he = lang.voiceLanguageInstructions('he');
  assert.ok(/Hebrew/i.test(he));
  assert.ok(/ONLY/.test(he));
  assert.ok(/proper nouns/i.test(he));
  const ru = lang.voiceLanguageInstructions('ru');
  assert.ok(/Russian/i.test(ru));
  assert.ok(/ONLY/.test(ru));
  assert.ok(/proper nouns/i.test(ru));
});

test('isPredominantlyRussian: Cyrillic-majority detection', () => {
  assert.equal(lang.isPredominantlyRussian('Здравствуйте, я хочу записаться на приём'), true);
  assert.equal(lang.isPredominantlyRussian('שלום, אני רוצה לקבוע תור'), false);
  assert.equal(lang.isPredominantlyRussian('hello there'), false);
  assert.equal(lang.isPredominantlyRussian(''), false);
  assert.equal(lang.isPredominantlyRussian(null), false);
  // Mixed but mostly Russian with a Latin proper noun.
  assert.equal(lang.isPredominantlyRussian('Можно записаться к Dr. Cohen завтра?'), true);
  // Mostly Hebrew with one Russian word.
  assert.equal(lang.isPredominantlyRussian('שלום שלום שלום привет'), false);
  // Digits/punctuation only — not Russian.
  assert.equal(lang.isPredominantlyRussian('123 !!!'), false);
});

test('smsLanguage: en for normal tenants; he default / ru on Cyrillic for menu tenants', () => {
  assert.equal(lang.smsLanguage(US_TENANT, 'Здравствуйте'), 'en');
  assert.equal(lang.smsLanguage(IL_TENANT, 'שלום'), 'he');
  assert.equal(lang.smsLanguage(IL_TENANT, 'what are your hours?'), 'he');
  assert.equal(lang.smsLanguage(IL_TENANT, 'Здравствуйте, вы работаете завтра?'), 'ru');
});

test('smsLanguagePolicy: empty for normal tenants, Hebrew-default policy for menu tenants', () => {
  assert.equal(lang.smsLanguagePolicy(US_TENANT), '');
  const policy = lang.smsLanguagePolicy(IL_TENANT);
  assert.ok(/Hebrew/.test(policy));
  assert.ok(/Russian/.test(policy));
  assert.ok(/Cyrillic/i.test(policy));
  assert.ok(/proper nouns/i.test(policy));
});

// The SMS copy for existing tenants must be byte-identical to what shipped.
test('smsCopy: English strings for non-menu tenants are exactly unchanged', () => {
  const t = { ...US_TENANT, business_name: 'Acme Plumbing' };
  assert.equal(
    lang.smsCopy(t, 'help', 'en'),
    'Acme Plumbing: automated virtual receptionist. Reply STOP to opt out. Msg & data rates may apply.'
  );
  assert.equal(lang.smsCopy(t, 'opted_back_in', 'en'), "You're opted back in. How can I help you today?");
  assert.equal(
    lang.smsCopy(t, 'consent_prompt', 'en'),
    'Hi! You\'ve reached Acme Plumbing. Reply YES to chat with our virtual receptionist, or STOP to opt out. Msg & data rates may apply.'
  );
  assert.equal(lang.smsCopy(t, 'opted_in_confirm', 'en'), "You're all set! How can I help you today?");
  assert.equal(lang.smsCopy(t, 'pending_reprompt', 'en'), 'Reply YES to continue or STOP to opt out.');
  assert.equal(
    lang.smsCopy(t, 'not_live', 'en'),
    "Thanks for reaching Acme Plumbing! Our virtual receptionist isn't live yet — please try again soon."
  );
  assert.equal(
    lang.smsCopy(t, 'unavailable', 'en'),
    "Thanks for contacting Acme Plumbing! We're unavailable right now — please try again later."
  );
  assert.equal(
    lang.smsCopy(t, 'error_fallback', 'en'),
    "Thanks for contacting Acme Plumbing! We're having a brief technical hiccup — someone will follow up shortly."
  );
});

test('smsCopy: Hebrew and Russian variants keep carrier keywords in English', () => {
  for (const l of ['he', 'ru']) {
    const consent = lang.smsCopy(IL_TENANT, 'consent_prompt', l);
    assert.ok(consent.includes('YES'), `consent (${l}) keeps YES`);
    assert.ok(consent.includes('STOP'), `consent (${l}) keeps STOP`);
    assert.ok(consent.includes(IL_TENANT.business_name));
    const reprompt = lang.smsCopy(IL_TENANT, 'pending_reprompt', l);
    assert.ok(reprompt.includes('YES') && reprompt.includes('STOP'));
    assert.ok(lang.smsCopy(IL_TENANT, 'help', l).includes('STOP'));
  }
  assert.ok(/[֐-׿]/.test(lang.smsCopy(IL_TENANT, 'consent_prompt', 'he')));
  assert.ok(/[Ѐ-ӿ]/.test(lang.smsCopy(IL_TENANT, 'consent_prompt', 'ru')));
  assert.ok(/[֐-׿]/.test(lang.smsCopy(IL_TENANT, 'error_fallback', 'he')));
  assert.ok(/[Ѐ-ӿ]/.test(lang.smsCopy(IL_TENANT, 'error_fallback', 'ru')));
});
