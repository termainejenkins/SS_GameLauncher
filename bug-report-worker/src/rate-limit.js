import { INSTALL_LIMIT, IP_LIMIT } from './limits.js';

export function utcDay(now) {
  return now.toISOString().slice(0, 10);
}

export function retryAfterSeconds(now) {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
  let hex = '';
  for (const b of new Uint8Array(digest)) hex += b.toString(16).padStart(2, '0');
  return hex;
}

function asCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** Salt for this UTC day, created once and kept in KV. Raw IPs are never the key. */
export async function dailySalt(kv, day) {
  const key = `salt:${day}`;
  const existing = await kv.get(key);
  if (existing) return existing;
  const salt = crypto.randomUUID();
  // Keep the salt a little longer than the counters so a late request in the day still matches.
  await kv.put(key, salt, { expirationTtl: 3 * 24 * 60 * 60 });
  return salt;
}

export async function rateKeys(kv, env, { installId, ip, now }) {
  const day = utcDay(now);
  const salt = await dailySalt(kv, day);
  const pepper = env && env.RATE_LIMIT_SALT ? String(env.RATE_LIMIT_SALT) : '';
  const ipHash = await sha256Hex(`${pepper}:${salt}:${ip}`);
  return {
    day,
    installKey: `install:${installId}:${day}`,
    ipKey: `ip:${ipHash}:${day}`,
  };
}

export async function peekRate(kv, { installKey, ipKey }) {
  const [installRaw, ipRaw] = await Promise.all([kv.get(installKey), kv.get(ipKey)]);
  const installCount = asCount(installRaw);
  const ipCount = asCount(ipRaw);
  return {
    ok: installCount < INSTALL_LIMIT && ipCount < IP_LIMIT,
    installCount,
    ipCount,
    limit: installCount >= INSTALL_LIMIT ? 'install' : (ipCount >= IP_LIMIT ? 'ip' : null),
  };
}

export async function commitRate(kv, { installKey, ipKey, installCount, ipCount, now }) {
  const ttl = Math.max(60, retryAfterSeconds(now) + 3600);
  await kv.put(installKey, String(installCount + 1), { expirationTtl: ttl });
  await kv.put(ipKey, String(ipCount + 1), { expirationTtl: ttl });
}
