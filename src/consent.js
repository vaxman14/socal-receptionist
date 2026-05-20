// Tracks SMS opt-in consent per phone number, persisted in Supabase.
// States: 'unknown' | 'pending' | 'opted_in' | 'opted_out'
// Twilio also blocks opted-out numbers at the carrier level (safety net),
// but we track here so we never feed opted-out numbers to the AI.

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// In-memory cache so every SMS doesn't need a DB round-trip
const cache = new Map();

async function getStatus(phone) {
  if (cache.has(phone)) return cache.get(phone);
  const { data } = await supabase
    .from('consent')
    .select('status')
    .eq('phone', phone)
    .maybeSingle();
  const status = data?.status || 'unknown';
  cache.set(phone, status);
  return status;
}

async function setStatus(phone, status) {
  cache.set(phone, status);
  await supabase
    .from('consent')
    .upsert({ phone, status, updated_at: new Date().toISOString() });
}

module.exports = { getStatus, setStatus };
