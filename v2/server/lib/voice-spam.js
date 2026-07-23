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

function isGoogleVoiceSearchSpam(text) {
  const normalized = String(text || '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const mentionsGoogleVoiceSearch =
    normalized.includes('google voice search') ||
    normalized.includes('google voice searches');
  const hasVerificationPitch =
    normalized.includes('not verified') ||
    normalized.includes('press 1 to verify your business');
  const hasCampaignFingerprint =
    normalized.includes('877 556 9255') ||
    normalized.includes('customers cannot find your business');

  return mentionsGoogleVoiceSearch &&
    hasVerificationPitch &&
    hasCampaignFingerprint;
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
