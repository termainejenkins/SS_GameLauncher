import { DAY_MS, RETENTION_DAYS, RETENTION_LOOKBACK_DAYS } from './limits.js';
import { safeError } from './discord.js';

/** UTC date prefixes strictly older than the retention window, limited to the cron lookback. */
export function expiredDatePrefixes(now, retentionDays = RETENTION_DAYS, lookbackDays = RETENTION_LOOKBACK_DAYS) {
  const prefixes = [];
  const end = retentionDays + lookbackDays;
  for (let age = retentionDays + 1; age <= end; age++) {
    const d = new Date(now.getTime() - age * DAY_MS);
    prefixes.push(`reports/${d.toISOString().slice(0, 10)}/`);
  }
  return prefixes;
}

export async function purgeExpired(env, now = new Date()) {
  let deleted = 0;
  for (const prefix of expiredDatePrefixes(now)) {
    let cursor;
    do {
      const page = await env.BUGS.list({ prefix, cursor });
      for (const obj of page.objects || []) {
        await env.BUGS.delete(obj.key);
        deleted += 1;
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }
  console.log(JSON.stringify({ message: 'retention purge', deleted }));
  return deleted;
}

export async function runRetention(env, ctx, now = new Date()) {
  const job = purgeExpired(env, now).catch((err) => {
    console.error(JSON.stringify({ message: 'retention purge failed', error: safeError(err) }));
  });
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(job);
  return job;
}
