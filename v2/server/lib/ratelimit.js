// Per-tenant + per-customer rate limiting and abuse detection.
//
// Backed by Redis when REDIS_URL is set (required for horizontal scaling);
// falls back to an in-memory sliding window for the single-process case.
// Redis failures fail over to the in-memory window rather than dropping
// messages — limiting degrades, service doesn't.

const logger = require('./logger');

const WINDOW_MS = 60 * 1000;
const TENANT_LIMIT = Number(process.env.RATE_TENANT_PER_MIN) || 60;
const CUSTOMER_LIMIT = Number(process.env.RATE_CUSTOMER_PER_MIN) || 12;
const ABUSE_THRESHOLD = Number(process.env.ABUSE_PER_MIN) || 30; // one phone hammering

// --- Shared Redis client (also used by the express-rate-limit stores) --------

let redisClient = null;

function getRedisClient() {
  if (!process.env.REDIS_URL) return null;
  if (!redisClient) {
    const { createClient } = require('redis');
    redisClient = createClient({ url: process.env.REDIS_URL });
    redisClient.on('error', (err) => logger.error('redis_error', { error: err.message }));
    redisClient.connect().catch((err) => {
      logger.error('redis_connect_failed', { error: err.message });
    });
  }
  return redisClient;
}

// express-rate-limit store factory — one store per limiter (separate prefixes).
// Returns undefined when Redis is not configured so limiters use their default
// in-memory store.
function makeLimiterStore(prefix) {
  const client = getRedisClient();
  if (!client) return undefined;
  const { RedisStore } = require('rate-limit-redis');
  return new RedisStore({
    prefix: `rl:${prefix}:`,
    sendCommand: (...args) => client.sendCommand(args),
  });
}

// --- In-memory fallback window ------------------------------------------------

const hits = new Map(); // key -> timestamp[]

function bumpMemory(key) {
  const now = Date.now();
  const live = (hits.get(key) || []).filter((t) => now - t < WINDOW_MS);
  live.push(now);
  hits.set(key, live);
  return live.length;
}

// Fixed 60s window in Redis: INCR + EXPIRE on first hit. Slightly coarser than
// the in-memory sliding window, which is fine at these limits.
async function bumpRedis(client, key) {
  const redisKey = `inbound:${key}`;
  const count = await client.incr(redisKey);
  if (count === 1) await client.expire(redisKey, Math.ceil(WINDOW_MS / 1000));
  return count;
}

async function bump(key) {
  const client = getRedisClient();
  if (client && client.isReady) {
    try {
      return await bumpRedis(client, key);
    } catch (err) {
      logger.warn('ratelimit_redis_fallback', { error: err.message });
    }
  }
  return bumpMemory(key);
}

// Record an inbound message and decide whether to process it.
// Returns { allowed, reason, abuse }.
async function checkInbound(tenantId, customerPhone) {
  const tenantCount = await bump(`t:${tenantId}`);
  const customerCount = await bump(`c:${tenantId}:${customerPhone}`);

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

// Drop expired in-memory buckets so the map stays bounded.
setInterval(() => {
  const now = Date.now();
  for (const [key, arr] of hits) {
    const live = arr.filter((t) => now - t < WINDOW_MS);
    if (live.length) hits.set(key, live);
    else hits.delete(key);
  }
}, WINDOW_MS).unref();

module.exports = { checkInbound, makeLimiterStore };
