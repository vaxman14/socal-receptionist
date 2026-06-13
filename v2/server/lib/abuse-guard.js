// Per-phone-number abuse guard (in-memory, 24h sliding window).
//
// Per-IP rate limiting is useless on Twilio webhooks — every call and text
// arrives from Twilio's IPs — so abuse has to be capped per originating
// phone number, scoped per tenant. In-memory is acceptable: a dyno restart
// resets the counters, which only ever errs in the caller's favor.

const DAY_MS = 24 * 60 * 60 * 1000;
const store = new Map();

setInterval(() => {
  const cutoff = Date.now() - DAY_MS;
  for (const [k, hits] of store) {
    if (!hits.length || hits[hits.length - 1] < cutoff) store.delete(k);
  }
}, 10 * 60 * 1000).unref();

// Returns true (and does NOT record a hit) when the key is already at the cap.
function overLimit(kind, key, maxPerDay) {
  if (!key) return false; // anonymous callers are handled by channel-specific logic
  const mapKey = `${kind}:${key}`;
  const now = Date.now();
  const hits = (store.get(mapKey) || []).filter(t => t > now - DAY_MS);
  if (hits.length >= maxPerDay) {
    store.set(mapKey, hits);
    return true;
  }
  hits.push(now);
  store.set(mapKey, hits);
  return false;
}

module.exports = { overLimit };
