/**
 * Simple in-memory TTL cache.
 *
 * This is what you reach for FIRST on a single cPanel/Render instance —
 * zero infra, zero cost. It only helps because every process has its own
 * copy in memory: fine for one instance, but it will NOT stay in sync if
 * you ever run more than one instance (e.g. Render's autoscaling, or a
 * second dyno) — each instance would cache independently and could show
 * slightly stale/different data to different users.
 *
 * Swap to Redis once you scale past one instance: install `ioredis`,
 * replace get/set below with `await redis.get(key)` / `redis.set(key, val,
 * 'PX', ttlMs)`, and the rest of this file's call sites (routes/feed.js)
 * don't need to change — they already treat cache.get as async-safe.
 */
const store = new Map(); // key -> { value, expiresAt }

function get(key) {
  const hit = store.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) { store.delete(key); return null; }
  return hit.value;
}

function set(key, value, ttlMs = 30_000) {
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
}

function invalidatePrefix(prefix) {
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) store.delete(key);
  }
}

// Prevent unbounded growth if this runs for a long time with many distinct
// query combinations (wing x page x user).
setInterval(() => {
  const now = Date.now();
  for (const [key, hit] of store) {
    if (now > hit.expiresAt) store.delete(key);
  }
}, 60_000).unref();

module.exports = { get, set, invalidatePrefix };
