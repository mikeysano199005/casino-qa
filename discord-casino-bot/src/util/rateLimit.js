// Simple in-memory token bucket per user.
const buckets = new Map();

export function allow(userId, maxPerSec = 4) {
  const now  = Date.now();
  const cap  = maxPerSec;
  const refill = maxPerSec; // per second
  let b = buckets.get(userId);
  if (!b) { b = { tokens: cap, ts: now }; buckets.set(userId, b); }
  const elapsed = (now - b.ts) / 1000;
  b.tokens = Math.min(cap, b.tokens + elapsed * refill);
  b.ts = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}
