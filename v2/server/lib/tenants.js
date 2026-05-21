// Tenant resolution.
//
// Inbound SMS is routed to a tenant by the Twilio `To` number (the tenant's
// own number, stored in phone_numbers). Lookups are cached briefly so the hot
// /sms path doesn't hit the DB on every message.

const { supabase } = require('./supabase');

const CACHE_TTL_MS = 60 * 1000;
const cache = new Map(); // key -> { tenant, expires }

function readCache(key) {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit;
  cache.delete(key);
  return undefined;
}

function writeCache(key, tenant) {
  cache.set(key, { tenant, expires: Date.now() + CACHE_TTL_MS });
}

// Resolve the tenant that owns an inbound `To` number. Returns the tenant row,
// or null if the number is not registered to any tenant.
async function resolveTenantByNumber(toNumber) {
  const key = `num:${toNumber}`;
  const hit = readCache(key);
  if (hit) return hit.tenant;

  const { data, error } = await supabase
    .from('phone_numbers')
    .select('tenant_id, status, tenants(*)')
    .eq('phone_e164', toNumber)
    .maybeSingle();
  if (error) throw error;

  const tenant = data && data.tenants ? data.tenants : null;
  writeCache(key, tenant);
  return tenant;
}

function clearCache() {
  cache.clear();
}

module.exports = { resolveTenantByNumber, clearCache };
