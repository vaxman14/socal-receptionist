// Tenant-scoped language helpers for language-menu deployments (Israel).
//
// Every behavior here is gated on tenants.voice_settings.language_menu.enabled
// being EXACTLY true — never on hostname, env vars, or deployment identity —
// so existing US tenants keep their current English behavior byte-for-byte on
// any deployment of this code.
//
// Pure module: no env, no network, no SDK imports — testable without secrets.

// The one Russian sentence played after the Hebrew greeting. The Russian
// option is announced ONLY in Russian — the Hebrew greeting never explains it.
const RUSSIAN_MENU_PROMPT = 'Для русского языка нажмите 2.';

function languageMenuEnabled(tenant) {
  return !!(
    tenant &&
    tenant.voice_settings &&
    tenant.voice_settings.language_menu &&
    tenant.voice_settings.language_menu.enabled === true
  );
}

function menuSettings(tenant) {
  return (tenant && tenant.voice_settings && tenant.voice_settings.language_menu) || {};
}

// IVR digit -> language. Digit 2 selects Russian; timeout or any other digit
// falls back to Hebrew.
function languageFromDigits(digits) {
  return digits === '2' ? 'ru' : 'he';
}

// Validate a language selection that arrived over the media-stream WebSocket
// (untrusted input) against the tenant's own setting. Non-menu tenants are
// always English regardless of what the stream claims; menu tenants accept
// only 'ru' or 'he' and default to Hebrew for anything else.
function resolveSelectedLanguage(tenant, raw) {
  if (!languageMenuEnabled(tenant)) return 'en';
  return raw === 'ru' ? 'ru' : 'he';
}

// IVR greeting for the language menu: the tenant's own (Hebrew) greeting, or a
// natural Hebrew fallback.
function hebrewMenuGreeting(tenant) {
  return (
    (tenant && tenant.voice_greeting) ||
    `תודה שהתקשרתם אל ${tenant && tenant.business_name ? tenant.business_name : 'העסק'}. שמחים לעזור.`
  );
}

// Opening line the Realtime AI speaks once the caller picked a language. The
// business-name greeting already played in the IVR, so this stays short and
// natural. Overridable per tenant via voice_settings.language_menu.
function realtimeGreeting(tenant, selectedLanguage) {
  const ms = menuSettings(tenant);
  if (selectedLanguage === 'ru') {
    return ms.ai_greeting_ru || 'Здравствуйте! Чем я могу вам помочь?';
  }
  return ms.ai_greeting_he || 'שלום! איך אפשר לעזור לך היום?';
}

// Strong single-language instructions appended to the voice system prompt.
function voiceLanguageInstructions(selectedLanguage) {
  if (selectedLanguage !== 'he' && selectedLanguage !== 'ru') return '';
  const name = selectedLanguage === 'he' ? 'Hebrew' : 'Russian';
  const other = selectedLanguage === 'he' ? 'Russian, English, or any other language' : 'Hebrew, English, or any other language';
  return `

SELECTED CALL LANGUAGE: ${name.toUpperCase()} (non-negotiable, overrides anything above):
- The caller chose ${name}. Speak ONLY ${name} for the entire call — every single reply.
- Never switch to ${other}, even if the caller mixes languages; keep replying in ${name}.
- Proper nouns (people, businesses, brands, street or product names) may be said in their original language.
- Numbers, dates, and times are spoken naturally in ${name}.`;
}

// --- SMS -----------------------------------------------------------------

// A message is "predominantly Russian" when Cyrillic letters outnumber all
// other letters (Latin + Hebrew) in it. Digits/punctuation don't count.
function isPredominantlyRussian(text) {
  if (!text) return false;
  const cyr = (String(text).match(/[Ѐ-ӿ]/g) || []).length;
  if (cyr === 0) return false;
  const other = (String(text).match(/[A-Za-z֐-׿]/g) || []).length;
  return cyr > other;
}

// Language for a single inbound SMS: normal tenants are always English; menu
// tenants default to Hebrew and flip to Russian when the inbound message is
// predominantly Russian/Cyrillic.
function smsLanguage(tenant, inboundText) {
  if (!languageMenuEnabled(tenant)) return 'en';
  return isPredominantlyRussian(inboundText) ? 'ru' : 'he';
}

// Language policy appended to the SMS system prompt for menu tenants only.
function smsLanguagePolicy(tenant) {
  if (!languageMenuEnabled(tenant)) return '';
  return `

LANGUAGE POLICY (non-negotiable, overrides anything above):
- Default language is Hebrew: reply in Hebrew.
- EXCEPTION: if the customer's latest message is predominantly Russian (written mostly in Cyrillic), reply in Russian instead.
- Never reply in English unless the customer explicitly asks for English.
- Proper nouns (people, businesses, brands, street or product names) may stay in their original language.`;
}

// --- Localized fixed SMS copy --------------------------------------------
//
// The 'en' strings below are the exact strings that shipped in sms/webhook.js —
// existing tenants must keep them byte-for-byte. Carrier keywords (YES / STOP)
// stay in English in every language, as carriers require.

const SMS_COPY = {
  en: {
    help: (b) => `${b}: automated virtual receptionist. Reply STOP to opt out. Msg & data rates may apply.`,
    opted_back_in: () => "You're opted back in. How can I help you today?",
    consent_prompt: (b) => `Hi! You've reached ${b}. Reply YES to chat with our virtual receptionist, or STOP to opt out. Msg & data rates may apply.`,
    opted_in_confirm: () => "You're all set! How can I help you today?",
    pending_reprompt: () => 'Reply YES to continue or STOP to opt out.',
    not_live: (b) => `Thanks for reaching ${b}! Our virtual receptionist isn't live yet — please try again soon.`,
    unavailable: (b) => `Thanks for contacting ${b}! We're unavailable right now — please try again later.`,
    error_fallback: (b) => `Thanks for contacting ${b}! We're having a brief technical hiccup — someone will follow up shortly.`,
  },
  he: {
    help: (b) => `${b}: מענה וירטואלי אוטומטי. להסרה השיבו STOP. ייתכנו חיובי הודעות לפי התוכנית שלכם.`,
    opted_back_in: () => 'נרשמתם מחדש בהצלחה. איך אפשר לעזור?',
    consent_prompt: (b) => `שלום! הגעתם אל ${b}. השיבו YES כדי להתכתב עם המענה הווירטואלי שלנו, או STOP להסרה. ייתכנו חיובי הודעות.`,
    opted_in_confirm: () => 'מעולה, הכול מוכן! איך אפשר לעזור?',
    pending_reprompt: () => 'השיבו YES כדי להמשיך או STOP להסרה.',
    not_live: (b) => `תודה שפניתם אל ${b}! המענה הווירטואלי עדיין לא פעיל — נסו שוב בקרוב.`,
    unavailable: (b) => `תודה שפניתם אל ${b}! אנחנו לא זמינים כרגע — נסו שוב מאוחר יותר.`,
    error_fallback: (b) => `תודה שפניתם אל ${b}! יש לנו תקלה טכנית קצרה — ניצור איתכם קשר בהקדם.`,
  },
  ru: {
    help: (b) => `${b}: автоматический виртуальный секретарь. Ответьте STOP, чтобы отписаться. Возможна плата за сообщения.`,
    opted_back_in: () => 'Вы снова подписаны. Чем могу помочь?',
    consent_prompt: (b) => `Здравствуйте! Это ${b}. Ответьте YES, чтобы переписываться с нашим виртуальным секретарём, или STOP, чтобы отказаться. Возможна плата за сообщения.`,
    opted_in_confirm: () => 'Отлично, всё готово! Чем могу помочь?',
    pending_reprompt: () => 'Ответьте YES, чтобы продолжить, или STOP, чтобы отказаться.',
    not_live: (b) => `Спасибо за обращение в ${b}! Виртуальный секретарь ещё не запущен — попробуйте позже.`,
    unavailable: (b) => `Спасибо за обращение в ${b}! Мы сейчас недоступны — попробуйте позже.`,
    error_fallback: (b) => `Спасибо за обращение в ${b}! У нас небольшая техническая неполадка — мы скоро свяжемся с вами.`,
  },
};

function smsCopy(tenant, key, language) {
  const lang = languageMenuEnabled(tenant) ? (language === 'ru' ? 'ru' : 'he') : 'en';
  const table = SMS_COPY[lang];
  const entry = table && table[key];
  if (!entry) throw new Error(`unknown sms copy key: ${key}`);
  return entry(tenant && tenant.business_name);
}

module.exports = {
  RUSSIAN_MENU_PROMPT,
  languageMenuEnabled,
  menuSettings,
  languageFromDigits,
  resolveSelectedLanguage,
  hebrewMenuGreeting,
  realtimeGreeting,
  voiceLanguageInstructions,
  isPredominantlyRussian,
  smsLanguage,
  smsLanguagePolicy,
  smsCopy,
};
