// Per-tenant + per-customer rate limiting and abuse detection.
//
// In-memory sliding window — fine for the single SMS service process. If the
// service is scaled horizontally, back this with Redis (a shared store).

const WINDOW_MS = 60 * 1000;
const TENANT_LIMIT = Number(process.env.RATE_TENANT_PER_MIN) || 60;
const CUSTOMER_LIMIT = Number(process.env.RATE_CUSTOMER_PER_MIN) || 12;
const ABUSE_THRESHOLD = Number(process.env.ABUSE_PER_MIN) || 30; // one phone hammering

const hits = new Map(); // key -> timestamp[]

function bump(key) {
  const now = Date.now();
  const live = (hits.get(key) || []).filter((t) => now - t < WINDOW_MS);
  live.push(now);
  hits.set(key, live);
  return live.length;
}

// Record an inbound message and decide whether to process it.
// Returns { allowed, reason, abuse }.
function checkInbound(tenantId, customerPhone) {
  const tenantCount = bump(`t:${tenantId}`);
  const customerCount = bump(`c:${tenantId}:${customerPhone}`);

  if (customerCount > ABUSE_THRESHOLD) {
    return { allowed: false, reason: 'customer_abuse', abuse: true };
  }
  if (customerCount > CUSTOMER_LIMIT) {
    return { allowed: false, reason: 'customer_rate', abuse: false };
  }
  if (tenantCount > TENANT_LIMIT) {
    return { allowed: false, reason: 'tenant_rate', abuse: false };
  }
  return { allowed: true, reason: null, abuse: false };
}

// Drop expired buckets so the map stays bounded.
setInterval(() => {
  const now = Date.now();
  for (const [key, arr] of hits) {
    const live = arr.filter((t) => now - t < WINDOW_MS);
    if (live.length) hits.set(key, live);
    else hits.delete(key);
  }
}, WINDOW_MS).unref();

module.exports = { checkInbound };
