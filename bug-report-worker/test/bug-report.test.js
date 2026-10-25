import nodeCrypto from 'node:crypto';
import { describe, expect, it, vi, afterEach } from 'vitest';
import worker, { handleRequest } from '../src/index.js';
import { MAX_BODY_BYTES, SCREENSHOT_MAX_BYTES, ZIP_MAX_BYTES } from '../src/limits.js';
import { commitRate, dailySalt, peekRate, retryAfterSeconds, sha256Hex } from '../src/rate-limit.js';
import { discordPayload } from '../src/discord.js';
import { expiredDatePrefixes, purgeExpired } from '../src/retention.js';

const NOW = new Date('2026-10-24T15:00:00.000Z');
const INSTALL = 'ab'.repeat(32);
const WEBHOOK = 'https://discord.example/api/webhooks/123/webhook-secret-value';

function memoryKv() {
  const store = new Map();
  return {
    store,
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, value) { store.set(key, String(value)); },
    async delete(key) { store.delete(key); },
  };
}

async function toBuf(value) {
  if (typeof value === 'string') return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (value && typeof value.arrayBuffer === 'function') return Buffer.from(await value.arrayBuffer());
  throw new Error('unsupported r2 body');
}

function memoryR2() {
  const objects = new Map();
  return {
    objects,
    async put(key, value, opts) {
      objects.set(key, { key, body: await toBuf(value), httpMetadata: opts && opts.httpMetadata });
    },
    async get(key) { return objects.get(key) || null; },
    async delete(key) { objects.delete(key); },
    async list({ prefix, cursor } = {}) {
      const keys = [...objects.keys()].filter((k) => !prefix || k.startsWith(prefix)).sort();
      const start = cursor ? keys.indexOf(cursor) + 1 : 0;
      return { objects: keys.slice(start).map((key) => ({ key })), truncated: false };
    },
  };
}

function testEnv(over = {}) {
  return {
    BUGS: memoryR2(),
    RATE: memoryKv(),
    DISCORD_WEBHOOK_URL: WEBHOOK,
    ...over,
  };
}

function zipFile(bytes = [0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]) {
  return new File([Uint8Array.from(bytes)], 'report.zip', { type: 'application/zip' });
}

function pngFile() {
  return new File([Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], 'shot.png', { type: 'image/png' });
}

function baseFields(over = {}) {
  return {
    category: 'crash',
    description: 'The game froze while tracking the herd at dusk.',
    installId: INSTALL,
    launcherVersion: '1.1.5',
    gameBuild: '1234',
    gpu: 'Test GPU',
    zip: zipFile(),
    ...over,
  };
}

async function submit(env, fields, { ip = '203.0.113.9', now = NOW } = {}) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value instanceof File) form.set(key, value, value.name);
    else if (value != null) form.set(key, String(value));
  }
  const req = new Request('https://bug-report.example.com/api/bug-report', {
    method: 'POST',
    body: form,
    headers: { 'CF-Connecting-IP': ip },
  });
  return handleRequest(req, env, {}, { now: () => now });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubDiscord({ status = 204, throwMessage = '' } = {}) {
  const calls = [];
  const logs = [];
  vi.spyOn(console, 'log').mockImplementation((line) => logs.push(String(line)));
  vi.spyOn(console, 'error').mockImplementation((line) => logs.push(String(line)));
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    calls.push({ url: String(url), init });
    if (throwMessage) throw new Error(throwMessage);
    return new Response('', { status });
  }));
  return { calls, logs };
}

describe('validation', () => {
  it('rejects a non-multipart body, the wrong method, and unknown paths', async () => {
    const env = testEnv();
    const type = await handleRequest(new Request('https://bug-report.example.com/api/bug-report', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }), env, {});
    expect(type.status).toBe(415);
    const method = await handleRequest(new Request('https://bug-report.example.com/api/bug-report', { method: 'GET' }), env, {});
    expect(method.status).toBe(405);
    const missing = await handleRequest(new Request('https://bug-report.example.com/health'), env, {});
    expect(missing.status).toBe(404);
    expect(env.BUGS.objects.size).toBe(0);
  });

  it('rejects an oversized content-length before reading the form', async () => {
    const env = testEnv();
    let parsed = false;
    const res = await handleRequest({
      method: 'POST',
      url: 'https://bug-report.example.com/api/bug-report',
      headers: new Headers({
        'content-type': 'multipart/form-data; boundary=abc',
        'content-length': String(MAX_BODY_BYTES + 1),
      }),
      async formData() { parsed = true; return new FormData(); },
    }, env, {});
    expect(res.status).toBe(413);
    expect(parsed).toBe(false);
    expect(env.BUGS.objects.size).toBe(0);
  });

  it('rejects a bad category, a short or long description, a bad install id, and a non-zip', async () => {
    const env = testEnv();
    expect((await submit(env, baseFields({ category: 'nope' }))).status).toBe(400);
    expect((await submit(env, baseFields({ description: 'x'.repeat(19) }))).status).toBe(400);
    expect((await submit(env, baseFields({ description: 'x'.repeat(2001) }))).status).toBe(400);
    expect((await submit(env, baseFields({ description: '   ' }))).status).toBe(400);
    expect((await submit(env, baseFields({ installId: 'AB'.repeat(32) }))).status).toBe(400);
    expect((await submit(env, baseFields({ installId: 'not-a-hash' }))).status).toBe(400);
    expect((await submit(env, baseFields({ zip: zipFile([1, 2, 3, 4, 5, 6]) }))).status).toBe(400);
    const noZip = baseFields();
    delete noZip.zip;
    expect((await submit(env, noZip)).status).toBe(400);
    expect(env.BUGS.objects.size).toBe(0);
  });

  it('rejects a zip over 25 MB and a screenshot over the allowance', async () => {
    const env = testEnv();
    const hugeZip = { size: ZIP_MAX_BYTES + 1, type: 'application/zip', async arrayBuffer() { throw new Error('should not read'); } };
    const hugeShot = { size: SCREENSHOT_MAX_BYTES + 1, type: 'image/png', async arrayBuffer() { throw new Error('should not read'); } };
    const form = {
      get(name) {
        return {
          category: 'crash',
          description: 'x'.repeat(30),
          installId: INSTALL,
          zip: name === 'zip' ? hugeZip : null,
          screenshot: null,
        }[name] ?? null;
      },
    };
    const zipRes = await handleRequest({
      method: 'POST',
      url: 'https://bug-report.example.com/api/bug-report',
      headers: new Headers({ 'content-type': 'multipart/form-data; boundary=abc' }),
      formData: async () => form,
    }, env, {}, { now: () => NOW });
    expect(zipRes.status).toBe(413);

    const form2 = {
      get(name) {
        const fields = {
          category: 'crash',
          description: 'x'.repeat(30),
          installId: INSTALL,
          zip: zipFile(),
          screenshot: hugeShot,
        };
        return Object.prototype.hasOwnProperty.call(fields, name) ? fields[name] : null;
      },
    };
    const shotRes = await handleRequest({
      method: 'POST',
      url: 'https://bug-report.example.com/api/bug-report',
      headers: new Headers({ 'content-type': 'multipart/form-data; boundary=abc' }),
      formData: async () => form2,
    }, env, {}, { now: () => NOW });
    expect(shotRes.status).toBe(413);
    expect(env.BUGS.objects.size).toBe(0);
  });
});

describe('stored report', () => {
  it('writes the zip and metadata to R2 and does not keep an IP', async () => {
    const env = testEnv();
    const { calls } = stubDiscord();
    const res = await submit(env, baseFields({
      description: `${'b'.repeat(200)}UNIQUE_TAIL`,
      gameBuild: 'build-9',
      gpu: 'GPU-Z',
    }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/i);
    const zipKey = `reports/2026-10-24/${body.id}.zip`;
    const jsonKey = `reports/2026-10-24/${body.id}.json`;
    const zip = env.BUGS.objects.get(zipKey);
    expect([...zip.body.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    const meta = JSON.parse(env.BUGS.objects.get(jsonKey).body.toString('utf8'));
    expect(meta).toMatchObject({
      category: 'crash',
      gameBuild: 'build-9',
      gpu: 'GPU-Z',
      launcherVersion: '1.1.5',
      reportId: body.id,
      hasScreenshot: false,
    });
    expect(meta.description.endsWith('UNIQUE_TAIL')).toBe(true);
    expect(meta.createdAt).toBe(NOW.toISOString());
    expect(meta.ip).toBeUndefined();
    expect(JSON.stringify(meta).includes('203.0.113.9')).toBe(false);
    expect(JSON.stringify(meta).includes(INSTALL)).toBe(false);
    expect(calls).toHaveLength(1);
    const payload = JSON.parse(calls[0].init.body);
    expect(payload.allowed_mentions).toEqual({ parse: [] });
    expect(payload.content.includes('UNIQUE_TAIL')).toBe(false);
    expect(payload.content.includes('build-9')).toBe(true);
    expect(payload.content.includes('GPU-Z')).toBe(true);
    expect(calls[0].init.redirect).toBe('manual');
  });

  it('stores a png screenshot beside the zip', async () => {
    const env = testEnv();
    stubDiscord();
    const res = await submit(env, baseFields({ screenshot: pngFile() }));
    expect(res.status).toBe(201);
    const { id } = await res.json();
    const shot = env.BUGS.objects.get(`reports/2026-10-24/${id}.png`);
    expect(shot.body[0]).toBe(0x89);
    const meta = JSON.parse(env.BUGS.objects.get(`reports/2026-10-24/${id}.json`).body.toString('utf8'));
    expect(meta.hasScreenshot).toBe(true);
  });

  it('strips discord mentions and webhook urls from user text', async () => {
    const env = testEnv();
    const { calls, logs } = stubDiscord();
    const leaked = 'https://discord.com/api/webhooks/9/should-not-stick';
    const res = await submit(env, baseFields({
      description: `hello @everyone and @here look ${leaked} now`,
      gpu: 'card @everyone',
    }));
    expect(res.status).toBe(201);
    const { id } = await res.json();
    const meta = JSON.parse(env.BUGS.objects.get(`reports/2026-10-24/${id}.json`).body.toString('utf8'));
    expect(meta.description.includes('discord.com/api/webhooks')).toBe(false);
    expect(meta.description.includes('[webhook]')).toBe(true);
    const payload = JSON.parse(calls[0].init.body);
    expect(payload.content.includes('@everyone')).toBe(false);
    expect(payload.content.includes('@here')).toBe(false);
    expect(payload.content.includes('everyone')).toBe(true);
    expect(calls[0].url).toBe(WEBHOOK);
    expect(logs.join('\n').includes('webhook-secret-value')).toBe(false);
    expect(logs.join('\n').includes('should-not-stick')).toBe(false);
  });

  it('keeps the stored report when Discord fails and never logs the webhook', async () => {
    const env = testEnv();
    const { calls, logs } = stubDiscord({ throwMessage: `connect ${WEBHOOK}` });
    const res = await submit(env, baseFields());
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.discordNotified).toBe(false);
    expect(env.BUGS.objects.has(`reports/2026-10-24/${body.id}.zip`)).toBe(true);
    expect(calls).toHaveLength(1);
    const logged = logs.join('\n');
    expect(logged.includes('webhook-secret-value')).toBe(false);
    expect(logged.includes('discord notify failed')).toBe(true);
  });
});

describe('rate limit', () => {
  it('counts installs and IPs, expires counters, and never stores the raw IP', async () => {
    const kv = memoryKv();
    const ttls = [];
    const innerPut = kv.put.bind(kv);
    kv.put = async (key, value, opts) => {
      if (opts && opts.expirationTtl) ttls.push(opts.expirationTtl);
      await innerPut(key, value);
    };
    const now = NOW;
    const installKey = `install:${INSTALL}:2026-10-24`;
    const ipKey = 'ip:abc:2026-10-24';
    for (let i = 0; i < 5; i++) {
      const peek = await peekRate(kv, { installKey, ipKey });
      expect(peek.ok).toBe(true);
      await commitRate(kv, { installKey, ipKey, installCount: peek.installCount, ipCount: peek.ipCount, now });
    }
    const blocked = await peekRate(kv, { installKey, ipKey });
    expect(blocked.ok).toBe(false);
    expect(blocked.limit).toBe('install');
    expect(blocked.installCount).toBe(5);
    expect(ttls.every((n) => n >= 60)).toBe(true);
    expect(retryAfterSeconds(now)).toBe(9 * 60 * 60);

    const saltA = await dailySalt(kv, '2026-10-24');
    expect(await dailySalt(kv, '2026-10-24')).toBe(saltA);
    const saltB = await dailySalt(kv, '2026-10-25');
    expect(saltB).not.toBe(saltA);
    const ip = '203.0.113.9';
    const h1 = await sha256Hex(`${saltA}:${ip}`);
    const h2 = await sha256Hex(`${saltB}:${ip}`);
    expect(h1).not.toBe(h2);
    expect([...kv.store.keys()].join(' ')).not.toContain(ip);
  });

  it('returns 429 with Retry-After on the 6th report for one install', async () => {
    const env = testEnv();
    stubDiscord();
    let last;
    for (let i = 0; i < 5; i++) {
      last = await submit(env, baseFields({ installId: INSTALL }), { ip: `203.0.113.${i + 1}` });
      expect(last.status).toBe(201);
    }
    const zipCount = [...env.BUGS.objects.keys()].filter((k) => k.endsWith('.zip')).length;
    const blocked = await submit(env, baseFields({ installId: INSTALL }), { ip: '198.51.100.8' });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBe(String(9 * 60 * 60));
    const err = await blocked.json();
    expect(err.error).toBe('rate_limited');
    expect([...env.BUGS.objects.keys()].filter((k) => k.endsWith('.zip')).length).toBe(zipCount);
    const dumped = [...env.RATE.store.keys()].join(' ');
    expect(dumped.includes('198.51.100.8')).toBe(false);
    expect(dumped.includes('203.0.113.1')).toBe(false);
  });

  it('returns 429 when one IP sends more than 20 reports', async () => {
    const env = testEnv();
    stubDiscord();
    for (let i = 0; i < 20; i++) {
      const installId = i.toString(16).padStart(64, '0');
      const res = await submit(env, baseFields({ installId }), { ip: '198.51.100.20' });
      expect(res.status).toBe(201);
    }
    const extra = (20).toString(16).padStart(64, '0');
    const blocked = await submit(env, baseFields({ installId: extra }), { ip: '198.51.100.20' });
    expect(blocked.status).toBe(429);
    expect([...env.RATE.store.keys()].join(' ')).not.toContain('198.51.100.20');
  });
});

describe('discord payload', () => {
  it('caps the description at 200 characters and disables mention parsing', () => {
    const payload = discordPayload({
      category: 'performance',
      gameBuild: '9',
      gpu: 'GPU',
      description: `${'z'.repeat(200)}TAIL`,
      reportId: '11111111-1111-4111-8111-111111111111',
      launcherVersion: '1.1.5',
    });
    expect(payload.allowed_mentions).toEqual({ parse: [] });
    expect(payload.content.includes('TAIL')).toBe(false);
    expect(payload.content.includes('z'.repeat(200))).toBe(true);
  });
});

const { publicKey, privateKey } = nodeCrypto.generateKeyPairSync('ed25519');
const entitlementPubHex = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex');
const nowSec = Math.floor(NOW.getTime() / 1000);

function signEntitlement(payload, key = privateKey) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = nodeCrypto.sign(null, Buffer.from(body, 'ascii'), key).toString('base64url');
  return `${body}.${sig}`;
}

function entitlementPayload(entitlements, exp) {
  return {
    v: 1,
    steamid: '76561198000000000',
    discord_id: '42',
    steam_app: 1865070,
    owns_full_game: false,
    tier: 0,
    tier_name: 'None',
    entitlements,
    iat: nowSec,
    exp,
  };
}

describe('developer tag', () => {
  const devToken = signEntitlement(entitlementPayload(['developer'], nowSec + 86400));
  const fanToken = signEntitlement(entitlementPayload(['supporter'], nowSec + 86400));

  async function tagged(fields) {
    const env = testEnv({ ENTITLEMENT_PUBLIC_KEY_HEX: entitlementPubHex });
    const { calls, logs } = stubDiscord();
    const res = await submit(env, fields);
    expect(res.status).toBe(201);
    const body = await res.json();
    const raw = env.BUGS.objects.get(`reports/2026-10-24/${body.id}.json`).body.toString('utf8');
    const meta = JSON.parse(raw);
    const note = JSON.parse(calls[0].init.body).content;
    return { env, meta, raw, note, logs, calls };
  }

  it('valid dev token tags the stored json and the Discord note', async () => {
    const { meta, note } = await tagged(baseFields({ entitlementToken: devToken }));
    expect(meta.developer).toBe(true);
    expect(note.startsWith('[DEV] Bug report ')).toBe(true);
  });

  it('non-dev token does not tag', async () => {
    const { meta, note } = await tagged(baseFields({ entitlementToken: fanToken }));
    expect(meta.developer).toBeUndefined();
    expect(note.includes('[DEV]')).toBe(false);
  });

  it('bad signature does not tag', async () => {
    const [body, sig] = devToken.split('.');
    // Flip the first character. The last one is mostly unused padding and can still verify.
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const flipped = alphabet[(alphabet.indexOf(sig[0]) + 1) % alphabet.length] + sig.slice(1);
    const { meta, note } = await tagged(baseFields({ entitlementToken: `${body}.${flipped}` }));
    expect(meta.developer).toBeUndefined();
    expect(note.includes('[DEV]')).toBe(false);
  });

  it('expired token does not tag', async () => {
    const expired = signEntitlement(entitlementPayload(['developer'], nowSec - 5));
    const { meta, note } = await tagged(baseFields({ entitlementToken: expired }));
    expect(meta.developer).toBeUndefined();
    expect(note.includes('[DEV]')).toBe(false);
  });

  it('missing token does not tag', async () => {
    const { meta, note } = await tagged(baseFields());
    expect(meta.developer).toBeUndefined();
    expect(note.includes('[DEV]')).toBe(false);
  });

  it('does not persist the token in the stored json', async () => {
    const { meta, raw, note, logs, env } = await tagged(baseFields({ entitlementToken: devToken }));
    expect(meta.developer).toBe(true);
    expect(meta.entitlementToken).toBeUndefined();
    expect(raw.includes(devToken)).toBe(false);
    expect(raw.includes('entitlementToken')).toBe(false);
    const stored = [...env.BUGS.objects.values()].map((o) => o.body.toString('utf8')).join('\n');
    expect(stored.includes(devToken)).toBe(false);
    expect(note.includes(devToken)).toBe(false);
    expect(logs.join('\n').includes(devToken)).toBe(false);
    expect(logs.join('\n').includes('entitlementToken')).toBe(false);
  });
});

describe('retention', () => {
  it('lists only dates older than 90 days within the lookback', () => {
    const prefixes = expiredDatePrefixes(NOW);
    expect(prefixes).toHaveLength(120);
    expect(prefixes[0]).toBe(`reports/${new Date(NOW.getTime() - 91 * 86400000).toISOString().slice(0, 10)}/`);
    expect(prefixes.some((p) => p.startsWith('reports/2026-10-'))).toBe(false);
  });

  it('deletes expired objects through the scheduled handler and leaves recent ones', async () => {
    const env = testEnv({ DISCORD_WEBHOOK_URL: '' });
    const oldPrefix = expiredDatePrefixes(NOW)[0];
    await env.BUGS.put(`${oldPrefix}old.zip`, 'zip');
    await env.BUGS.put(`${oldPrefix}old.json`, '{}');
    await env.BUGS.put('reports/2026-10-20/new.zip', 'zip');
    let job;
    await worker.scheduled({}, env, { waitUntil(p) { job = p; } });
    await job;
    expect(env.BUGS.objects.has(`${oldPrefix}old.zip`)).toBe(false);
    expect(env.BUGS.objects.has(`${oldPrefix}old.json`)).toBe(false);
    expect(env.BUGS.objects.has('reports/2026-10-20/new.zip')).toBe(true);
    const deleted = await purgeExpired(env, NOW);
    expect(deleted).toBe(0);
  });
});
