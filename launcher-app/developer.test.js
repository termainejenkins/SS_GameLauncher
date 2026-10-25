// Developer gate: signed "developer" entitlement, fetched from /entitlements under 15 minutes ago.
//   node --test developer.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const cfg = require('./config');
const {
  isDeveloper,
  createAccountManager,
  DEVELOPER_FRESH_MS,
  entitlementFilePath,
} = require('./account');
const { handleDebugConsoleToggle } = require('./dev-access');

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const pubHex = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex');

function sign(payload, key = privateKey) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${crypto.sign(null, Buffer.from(body, 'ascii'), key).toString('base64url')}`;
}

function payload(entitlements, expOffsetSec = 3600) {
  const now = Math.floor(Date.now() / 1000);
  return {
    v: 1,
    steamid: '76561198000000000',
    discord_id: '42',
    steam_app: 1865070,
    owns_full_game: false,
    tier: 0,
    tier_name: 'None',
    entitlements,
    iat: now,
    exp: now + expOffsetSec,
  };
}

const devToken = sign(payload(['supporter', 'developer']));
const fanToken = sign(payload(['supporter']));
const clock = 1_700_000_000_000;

test('developer token fresh => true', () => {
  assert.equal(DEVELOPER_FRESH_MS, 15 * 60 * 1000);
  assert.equal(isDeveloper({
    token: devToken, fetchedAt: clock, now: clock, publicKeyHex: pubHex,
  }), true);
  assert.equal(isDeveloper({
    token: devToken, fetchedAt: clock - DEVELOPER_FRESH_MS + 1, now: clock, publicKeyHex: pubHex,
  }), true);
});

test('non-developer token => false', () => {
  assert.equal(isDeveloper({
    token: fanToken, fetchedAt: clock, now: clock, publicKeyHex: pubHex,
  }), false);
});

test('tampered signature => false', () => {
  const [body, sig] = devToken.split('.');
  const flipped = sig.slice(0, -1) + (sig.endsWith('A') ? 'B' : 'A');
  assert.equal(isDeveloper({
    token: `${body}.${flipped}`, fetchedAt: clock, now: clock, publicKeyHex: pubHex,
  }), false);
  const other = crypto.generateKeyPairSync('ed25519').privateKey;
  assert.equal(isDeveloper({
    token: sign(payload(['developer']), other), fetchedAt: clock, now: clock, publicKeyHex: pubHex,
  }), false);
});

test('expired => false', () => {
  const expired = sign(payload(['developer'], -10));
  assert.equal(isDeveloper({
    token: expired, fetchedAt: clock, now: clock, publicKeyHex: pubHex,
  }), false);
});

test('stale fetchedAt (>15 min) => false', () => {
  assert.equal(isDeveloper({
    token: devToken, fetchedAt: clock - DEVELOPER_FRESH_MS, now: clock, publicKeyHex: pubHex,
  }), false);
  assert.equal(isDeveloper({
    token: devToken, fetchedAt: clock - DEVELOPER_FRESH_MS - 1, now: clock, publicKeyHex: pubHex,
  }), false);
});

test('cached-from-disk => false', () => {
  assert.equal(isDeveloper({ token: devToken, now: clock, publicKeyHex: pubHex }), false);
  assert.equal(isDeveloper({ token: devToken, fetchedAt: null, now: clock, publicKeyHex: pubHex }), false);
});

test('debug toggle IPC refuses for non-dev', async () => {
  let applied = 0;
  const refused = await handleDebugConsoleToggle({
    isDeveloperFn: async () => false,
    open: true,
    applyOpen() { applied += 1; return true; },
  });
  assert.deepEqual(refused, { ok: false, reason: 'not_developer', open: false });
  assert.equal(applied, 0);

  const missing = await handleDebugConsoleToggle({ open: true, applyOpen() { applied += 1; return true; } });
  assert.equal(missing.ok, false);
  assert.equal(applied, 0);

  let opened = null;
  const allowed = await handleDebugConsoleToggle({
    isDeveloperFn: async () => true,
    open: true,
    applyOpen(open) { opened = open; return open; },
  });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.open, true);
  assert.equal(opened, true);
});

test('debug console UI is hidden and main owns the toggle', () => {
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const renderer = fs.readFileSync(path.join(__dirname, 'renderer.js'), 'utf8');
  const preload = fs.readFileSync(path.join(__dirname, 'preload.js'), 'utf8');
  const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  assert.match(html, /id="debug-console-row" hidden/);
  assert.match(renderer, /debugRow\.hidden = !developer/);
  assert.match(renderer, /getDevStatus/);
  assert.match(preload, /getDevStatus: \(\) => ipcRenderer\.invoke\('dev:status'\)/);
  assert.match(preload, /toggleDebugConsole: \(open\) => ipcRenderer\.invoke\('dev:toggle-console', !!open\)/);
  assert.match(main, /ipcMain\.handle\('dev:status'/);
  assert.match(main, /ipcMain\.handle\('dev:toggle-console'/);
  assert.match(main, /refreshDeveloperIfStale/);
  assert.match(main, /handleDebugConsoleToggle/);
  assert.equal(main.includes('openDevTools'), true);
  const openAt = main.indexOf('openDevTools');
  const handlerAt = main.indexOf("ipcMain.handle('dev:toggle-console'");
  assert.ok(handlerAt !== -1 && openAt > handlerAt, 'DevTools open only from the gated toggle handler');
});

test('server fetch records fetchedAt; cache, stale, and a bad signature do not grant developer', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssgl-dev-'));
  const userData = path.join(root, 'user');
  const localApp = path.join(root, 'local');
  fs.mkdirSync(userData);
  const oldLocal = process.env.LOCALAPPDATA;
  const oldFetch = global.fetch;
  process.env.LOCALAPPDATA = localApp;
  const steamid = '76561198000000000';
  const metaPath = path.join(userData, 'entitlement_fetch.json');
  let fetches = 0;
  let serverToken = devToken;

  function manager(keyHex = pubHex) {
    return createAccountManager({
      app: { getPath: () => userData },
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (s) => Buffer.from(s, 'utf8'),
        decryptString: (buf) => Buffer.from(buf).toString('utf8'),
      },
      shell: {},
      utilityProcess: { fork() { throw new Error('steam should not start'); } },
      isSteamRunning: async () => false,
      publicKeyHex: keyHex,
    });
  }

  function writeSession() {
    const sess = { session: 'sess-1', steamid, expires_at: Math.floor(Date.now() / 1000) + 3600, appid: cfg.STEAM_DEMO_APP_ID };
    fs.writeFileSync(path.join(userData, 'account_session.bin'), Buffer.from(JSON.stringify(sess)));
  }

  global.fetch = async (url) => {
    fetches += 1;
    assert.match(String(url), /\/entitlements$/);
    return {
      status: 200,
      json: async () => ({ linked: true, token: serverToken, discord_username: 'dev' }),
    };
  };

  try {
    const tokenPath = entitlementFilePath();
    fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
    fs.writeFileSync(tokenPath, devToken, 'ascii');
    const cached = manager();
    const st = await cached.getStatus();
    assert.equal(st.source, 'cache');
    assert.equal(st.linked, true);
    assert.equal(cached.isDeveloper(), false);
    assert.equal(fs.existsSync(metaPath), false);

    const forged = sign(payload(['developer']));
    fs.writeFileSync(tokenPath, forged, 'ascii');
    fs.writeFileSync(metaPath, JSON.stringify({
      fetchedAt: Date.now(),
      tokenSha256: crypto.createHash('sha256').update(forged, 'ascii').digest('hex'),
    }));
    const prod = manager(cfg.ENTITLEMENT_PUBLIC_KEY_HEX);
    assert.equal(prod.isDeveloper(), false);
    fs.unlinkSync(metaPath);

    writeSession();
    serverToken = devToken;
    const acct = manager();
    const synced = await acct.getStatus();
    assert.equal(synced.source, 'server');
    assert.equal(acct.isDeveloper(), true);
    assert.equal(fs.existsSync(metaPath), true);
    const afterSync = fetches;
    assert.equal(await acct.refreshDeveloperIfStale(), true);
    assert.equal(fetches, afterSync);

    serverToken = fanToken;
    const fan = await acct.getStatus();
    assert.equal(fan.source, 'server');
    assert.ok(fan.entitlements.includes('supporter'));
    assert.equal(acct.isDeveloper(), false);

    serverToken = devToken;
    const played = await acct.refreshBeforePlay({ resolveApp: false });
    assert.equal(played.source, 'server');
    assert.equal(acct.isDeveloper(), true);

    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    meta.fetchedAt = Date.now() - DEVELOPER_FRESH_MS - 1000;
    fs.writeFileSync(metaPath, JSON.stringify(meta));
    const stale = manager();
    assert.equal(stale.isDeveloper(), false);
    global.fetch = async () => { throw new Error('offline'); };
    assert.equal(await stale.refreshDeveloperIfStale(), false);
    assert.equal(stale.isDeveloper(), false);
    const beforePlay = await stale.refreshBeforePlay({ resolveApp: false });
    assert.equal(beforePlay.source, 'cache');
    assert.equal(stale.isDeveloper(), false);

    let refreshed = 0;
    global.fetch = async (url) => {
      refreshed += 1;
      assert.match(String(url), /\/entitlements$/);
      return { status: 200, json: async () => ({ linked: true, token: devToken }) };
    };
    assert.equal(await stale.refreshDeveloperIfStale(), true);
    assert.equal(refreshed, 1);
    assert.equal(stale.isDeveloper(), true);

    meta.fetchedAt = Date.now() - DEVELOPER_FRESH_MS - 1000;
    fs.writeFileSync(metaPath, JSON.stringify(meta));
    const stalePlay = manager();
    assert.equal(stalePlay.isDeveloper(), false);
    const again = await stalePlay.refreshBeforePlay({ resolveApp: false });
    assert.equal(again.source, 'server');
    assert.equal(stalePlay.isDeveloper(), true);
    assert.equal(refreshed, 2);
  } finally {
    if (oldLocal === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = oldLocal;
    global.fetch = oldFetch;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
