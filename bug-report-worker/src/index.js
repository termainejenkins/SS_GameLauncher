import { MAX_BODY_BYTES } from './limits.js';
import { contentLengthTooBig, isMultipart, json, validateReport } from './validate.js';
import { commitRate, peekRate, rateKeys, retryAfterSeconds } from './rate-limit.js';
import { discordPayload, notifyDiscord, safeError } from './discord.js';
import { developerFromToken } from './entitlement.js';
import { runRetention } from './retention.js';

function clientIp(request) {
  // Used only as input to a daily-salted hash. Never log this value.
  return request.headers.get('CF-Connecting-IP') || 'unknown';
}

async function deleteQuiet(bucket, key) {
  try { await bucket.delete(key); } catch (_) { /* best effort rollback */ }
}

export async function handleRequest(request, env, _ctx, deps = {}) {
  const url = new URL(request.url);
  if (url.pathname !== '/api/bug-report') {
    return json(404, { error: 'not_found', message: 'Not found.' });
  }
  if (request.method !== 'POST') {
    return json(405, { error: 'method_not_allowed', message: 'Use POST.' });
  }
  if (!isMultipart(request.headers.get('content-type'))) {
    return json(415, { error: 'unsupported_media_type', message: 'Send multipart/form-data.' });
  }
  // formData() reads the whole body. A missing or non-numeric length means there is no cap to apply first.
  const contentLength = request.headers.get('content-length');
  if (contentLength == null || contentLength.trim() === '' || !Number.isFinite(Number(contentLength))) {
    return json(411, { error: 'length_required', message: 'Content-Length is required.' });
  }
  if (contentLengthTooBig(contentLength, MAX_BODY_BYTES)) {
    return json(413, { error: 'too_large', message: 'Report is over the size limit.' });
  }

  let form;
  try {
    form = await request.formData();
  } catch (_) {
    return json(400, { error: 'invalid_multipart', message: 'Could not read the form.' });
  }

  const validated = await validateReport(form);
  if (!validated.ok) return validated.response;
  const report = validated.report;

  const now = (deps.now || (() => new Date()))();
  // Optional. A bad, expired, or missing token leaves the report untagged. Never store the token.
  let developer = false;
  try {
    const raw = form.get('entitlementToken');
    if (typeof raw === 'string' && raw.trim()) {
      developer = await developerFromToken(raw, env.ENTITLEMENT_PUBLIC_KEY_HEX, Math.floor(now.getTime() / 1000));
    }
  } catch (_) {
    developer = false;
  }
  const keys = await rateKeys(env.RATE, env, { installId: report.installId, ip: clientIp(request), now });
  const gate = await peekRate(env.RATE, keys);
  if (!gate.ok) {
    const retry = String(retryAfterSeconds(now));
    return json(429, {
      error: 'rate_limited',
      message: 'Too many bug reports from this install or network today.',
    }, { 'retry-after': retry });
  }

  const reportId = crypto.randomUUID();
  const day = keys.day;
  const zipKey = `reports/${day}/${reportId}.zip`;
  const jsonKey = `reports/${day}/${reportId}.json`;
  const shotKey = report.screenshot ? `reports/${day}/${reportId}.${report.screenshot.ext}` : null;
  const meta = {
    category: report.category,
    gameBuild: report.gameBuild,
    gpu: report.gpu,
    description: report.description,
    launcherVersion: report.launcherVersion,
    app: report.app || 'launcher',
    appVersion: report.appVersion,
    createdAt: now.toISOString(),
    reportId,
    hasScreenshot: !!report.screenshot,
  };
  if (developer) meta.developer = true;

  // customMetadata is how a listing tells ReplyReader objects from launcher ones without reading the JSON.
  const customMetadata = {
    app: meta.app,
    appVersion: report.appVersion || '',
    category: report.category,
  };

  try {
    await env.BUGS.put(zipKey, report.zipBytes, { httpMetadata: { contentType: 'application/zip' }, customMetadata });
    await env.BUGS.put(jsonKey, JSON.stringify(meta), { httpMetadata: { contentType: 'application/json' }, customMetadata });
    if (shotKey) {
      await env.BUGS.put(shotKey, report.screenshot.bytes, { httpMetadata: { contentType: report.screenshot.contentType } });
    }
  } catch (err) {
    await deleteQuiet(env.BUGS, zipKey);
    await deleteQuiet(env.BUGS, jsonKey);
    if (shotKey) await deleteQuiet(env.BUGS, shotKey);
    console.error(JSON.stringify({ message: 'bug report store failed', error: safeError(err) }));
    return json(500, { error: 'store_failed', message: 'Could not store the report. Nothing was kept.' });
  }

  try {
    await commitRate(env.RATE, { ...keys, installCount: gate.installCount, ipCount: gate.ipCount, now });
  } catch (err) {
    // The report is already stored. A missed counter can only allow an extra report, which we log without identifiers.
    console.error(JSON.stringify({ message: 'rate counter update failed', reportId, error: safeError(err) }));
  }

  let discordNotified = false;
  try {
    const payload = discordPayload({
      category: report.category,
      gameBuild: report.gameBuild,
      gpu: report.gpu,
      description: report.description,
      reportId,
      launcherVersion: report.launcherVersion,
      developer,
      app: report.app,
      appVersion: report.appVersion,
    });
    const note = await notifyDiscord(env.DISCORD_WEBHOOK_URL, payload);
    discordNotified = !!note.ok;
    if (!note.ok) {
      console.error(JSON.stringify({
        message: note.skipped ? 'discord webhook not set' : 'discord notify failed',
        reportId,
        status: note.status || 0,
      }));
    }
  } catch (err) {
    console.error(JSON.stringify({ message: 'discord notify failed', reportId, error: safeError(err) }));
  }

  console.log(JSON.stringify({ message: 'bug report stored', reportId, category: report.category, discordNotified }));
  return json(201, { id: reportId, discordNotified });
}

export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  },
  async scheduled(_event, env, ctx) {
    return runRetention(env, ctx);
  },
};
