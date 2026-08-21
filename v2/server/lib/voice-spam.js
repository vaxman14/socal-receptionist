const { supabase } = require('./supabase');
const logger = require('./logger');

const DEFAULT_BLOCKED_VOICE_CALLERS = new Set([
  '+19516673145',
  '+19518489623',
  '+19513046330',
  '+19517251228',
]);

const runtimeBlockedVoiceCallers = new Set();

function configuredBlockedVoiceCallers() {
  return String(process.env.VOICE_BLOCKED_CALLERS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

// The campaign rotates its script (July 2026: "not verified / press 1";
// August 2026: "press zero to speak / press nine to opt out"), so match on a
// pool of phrases instead of one fixed script. A strong phrase is IVR-speak
// no human caller says to a receptionist; weak phrases can occur in real
// speech ("I had trouble finding you on Google"), so two of them are needed.
const STRONG_SPAM_PHRASES = [
  '877 556 9255',
  'press 1 to verify your business',
  'press one to verify your business',
  'press zero to speak',
  'press 0 to speak',
  'press nine to opt out',
  'press 9 to opt out',
  'verify your google listing',
  'customers cannot find your business',
  'important message regarding your google business',
  'google voice clients are currently having trouble',
];

const WEAK_SPAM_PHRASES = [
  'not verified',
  'not showing correctly',
  'trouble finding you',
  'don t hang up',
  'speak with an agent',
  'speak to an agent',
];

function isGoogleVoiceSearchSpam(text) {
  const normalized = String(text || '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized.includes('google')) return false;

  if (STRONG_SPAM_PHRASES.some((phrase) => normalized.includes(phrase))) {
    return true;
  }

  const weakHits = WEAK_SPAM_PHRASES
    .filter((phrase) => normalized.includes(phrase)).length;
  return weakHits >= 2;
}

async function isBlockedVoiceCaller(number) {
  if (
    DEFAULT_BLOCKED_VOICE_CALLERS.has(number) ||
    runtimeBlockedVoiceCallers.has(number) ||
    configuredBlockedVoiceCallers().includes(number)
  ) {
    return true;
  }

  if (!number) return false;

  const { data, error } = await supabase
    .from('voice_blocked_callers')
    .select('number')
    .eq('number', number)
    .maybeSingle();

  if (error) {
    logger.error('voice.blocklist_lookup_failed', {
      from: number,
      error: error.message,
    });
    return false;
  }

  if (data) runtimeBlockedVoiceCallers.add(number);
  return !!data;
}

async function blockVoiceCaller(number, reason = 'google_voice_search_spam') {
  if (!number || number === 'anonymous') return;
  runtimeBlockedVoiceCallers.add(number);

  const now = new Date().toISOString();
  const { data: existing, error: lookupError } = await supabase
    .from('voice_blocked_callers')
    .select('hit_count')
    .eq('number', number)
    .maybeSingle();

  if (lookupError) {
    logger.error('voice.blocklist_write_lookup_failed', {
      from: number,
      error: lookupError.message,
    });
    return;
  }

  const { error } = await supabase.from('voice_blocked_callers').upsert({
    number,
    reason,
    source: 'transcript_fingerprint',
    first_seen_at: existing ? undefined : now,
    last_seen_at: now,
    hit_count: (existing?.hit_count || 0) + 1,
  }, { onConflict: 'number' });

  if (error) {
    logger.error('voice.blocklist_write_failed', {
      from: number,
      error: error.message,
    });
  }
}

module.exports = {
  blockVoiceCaller,
  isBlockedVoiceCaller,
  isGoogleVoiceSearchSpam,
};
