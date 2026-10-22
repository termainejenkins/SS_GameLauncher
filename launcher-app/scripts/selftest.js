// Plain-Node tests for the account code (no Electron, no Steam, no secrets).
//   npm run selftest
'use strict';
const crypto = require('crypto');
const assert = require('assert');
const cfg = require('../config');
const { verifyEntitlementToken, tierFromPayload, entitlementFilePath } = require('../account');

let failed = 0;
async function t(name, fn) {
  try { await fn(); console.log('PASS', name); } catch (e) { failed++; console.log('FAIL', name, '-', e.message); }
}

// Sign exactly like SS_AccountServer/src/crypto.ts signEntitlement().
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const pubHex = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex');
function sign(payload, key = privateKey) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${crypto.sign(null, Buffer.from(body, 'ascii'), key).toString('base64url')}`;
}
const now = Math.floor(Date.now() / 1000);
const good = { v: 1, steamid: '76561198000000000', discord_id: '1', entitlements: ['supporter'], iat: now, exp: now + 3600 };

(async () => {
  await t('valid token verifies', () => {
    const r = verifyEntitlementToken(sign(good), pubHex, good.steamid);
    assert.strictEqual(r.ok, true); assert.deepStrictEqual(r.payload.entitlements, ['supporter']);
  });
  await t('tampered payload rejected', () => {
    const [b, s] = sign(good).split('.');
    const forged = Buffer.from(JSON.stringify({ ...good, entitlements: ['supporter', 'alpha_builds'] })).toString('base64url');
    assert.strictEqual(verifyEntitlementToken(`${forged}.${s}`, pubHex).reason, 'bad_signature');
    assert.ok(b);
  });
  await t('wrong key rejected', () => {
    const other = crypto.generateKeyPairSync('ed25519').privateKey;
    assert.strictEqual(verifyEntitlementToken(sign(good, other), pubHex).reason, 'bad_signature');
  });
  await t('embedded production key rejects a locally signed token', () => {
    assert.strictEqual(verifyEntitlementToken(sign(good)).reason, 'bad_signature');
  });
  await t('expired token rejected', () => {
    assert.strictEqual(verifyEntitlementToken(sign({ ...good, exp: now - 1 }), pubHex).reason, 'expired');
  });
  await t('steamid mismatch rejected', () => {
    assert.strictEqual(verifyEntitlementToken(sign(good), pubHex, '76561198999999999').reason, 'steamid_mismatch');
  });
  await t('garbage rejected', () => {
    for (const g of ['', 'abc', 'a.b.c', null, 42]) assert.strictEqual(verifyEntitlementToken(g, pubHex).ok, false);
  });
  await t('embedded key matches SS_AccountServer/public_key.txt', () => {
    const fs = require('fs'); const path = require('path');
    const p = process.env.SS_ACCOUNT_SERVER_DIR ? path.join(process.env.SS_ACCOUNT_SERVER_DIR, 'public_key.txt') : path.resolve(__dirname, '..', '..', '..', 'SS_AccountServer', 'public_key.txt');
    if (!fs.existsSync(p)) { console.log('   (skipped: public_key.txt not found at', p + ')'); return; }
    assert.ok(fs.readFileSync(p, 'utf8').includes(cfg.ENTITLEMENT_PUBLIC_KEY_HEX));
  });
  await t('demo payload fields pass through', () => {
    const r = verifyEntitlementToken(sign({ ...good, steam_app: 1865070, owns_full_game: false }), pubHex, good.steamid);
    assert.strictEqual(r.ok, true); assert.strictEqual(r.payload.steam_app, 1865070); assert.strictEqual(r.payload.owns_full_game, false);
  });
  await t('tier passes through a signed token', () => {
    const r = verifyEntitlementToken(sign({ ...good, tier: 4, tier_name: 'Gold', entitlements: ['restricted_content', 'supporter'] }), pubHex, good.steamid);
    assert.strictEqual(r.ok, true); assert.strictEqual(r.payload.tier, 4); assert.strictEqual(r.payload.tier_name, 'Gold');
    assert.deepStrictEqual(tierFromPayload(r.payload), { tier: 4, tierName: 'Gold' });
  });
  await t('tier: old tokens / bad values fall back to 0 None', () => {
    assert.deepStrictEqual(tierFromPayload(good), { tier: 0, tierName: 'None' });
    assert.deepStrictEqual(tierFromPayload({ tier: 9 }), { tier: 0, tierName: 'None' });
    assert.deepStrictEqual(tierFromPayload({ tier: 5, tier_name: 'bogus' }), { tier: 5, tierName: 'Platinum' });
  });
  await t('config app ids match SS_AccountServer/wrangler.toml STEAM_APP_IDS', () => {
    const fs = require('fs'); const path = require('path');
    assert.deepStrictEqual(cfg.STEAM_APP_IDS, [cfg.STEAM_APP_ID, cfg.STEAM_DEMO_APP_ID]);
    const p = process.env.SS_ACCOUNT_SERVER_DIR ? path.join(process.env.SS_ACCOUNT_SERVER_DIR, 'wrangler.toml') : path.resolve(__dirname, '..', '..', '..', 'SS_AccountServer', 'wrangler.toml');
    if (!fs.existsSync(p)) { console.log('   (skipped: wrangler.toml not found at', p + ')'); return; }
    const m = fs.readFileSync(p, 'utf8').match(/^STEAM_APP_IDS\s*=\s*"([^"]+)"/m);
    assert.ok(m, 'STEAM_APP_IDS missing'); assert.deepStrictEqual(m[1].split(',').map(Number), cfg.STEAM_APP_IDS);
  });
  await t('entitlement file path', () => {
    const p = entitlementFilePath();
    assert.ok(/SentientSolutions[\\/]+TGC[\\/]+entitlement\.token$/.test(p), p);
    console.log('   ->', p);
  });
  // Game launch (Steam starts the launcher, the launcher starts the game). No Electron, no Steam.
  const gl = require('../game-launch');
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tgc-launch-'));
  const launcherDir = path.join(tmp, 'Launcher');
  fs.mkdirSync(launcherDir);
  await t('launch config: defaults when no file', () => {
    const r = gl.loadLaunchConfig(launcherDir);
    assert.strictEqual(r.found, false); assert.strictEqual(r.config.launchMode, 'exe'); assert.strictEqual(r.config.gameRoot, '..');
    assert.strictEqual(r.config.afterLaunch, 'close-and-wait');
  });
  await t('launch config: bad JSON falls back to defaults', () => {
    fs.writeFileSync(path.join(launcherDir, gl.CONFIG_FILE_NAME), '{nope');
    const r = gl.loadLaunchConfig(launcherDir);
    assert.strictEqual(r.config.gameRoot, '..'); assert.ok(r.warnings.length);
  });
  await t('launch config: values are read and bad ones ignored', () => {
    fs.writeFileSync(path.join(launcherDir, gl.CONFIG_FILE_NAME), '\uFEFF' + JSON.stringify({ gameExe: 'Game.exe', afterLaunch: 'explode', extraArgs: ['-windowed'], forwardArgs: false }));
    const r = gl.loadLaunchConfig(launcherDir);
    assert.deepStrictEqual(r.config.gameExe, ['Game.exe']); assert.strictEqual(r.config.afterLaunch, 'close-and-wait');
    assert.deepStrictEqual(r.config.extraArgs, ['-windowed']); assert.strictEqual(r.config.forwardArgs, false);
  });
  await t('resolve game exe: missing -> clear error', () => {
    const r = gl.resolveGameExe(gl.DEFAULTS, launcherDir);
    assert.strictEqual(r.ok, false); assert.strictEqual(r.tried.length, 3);
    assert.ok(/Verify integrity/.test(gl.missingGameMessage(r)));
  });
  await t('resolve game exe: finds the UE shipping exe one folder up', () => {
    const ship = path.join(tmp, 'TheGreatCircle_4_27', 'Binaries', 'Win64');
    fs.mkdirSync(ship, { recursive: true });
    fs.writeFileSync(path.join(ship, 'TheGreatCircle_4_27-Win64-Shipping.exe'), '');
    let r = gl.resolveGameExe(gl.DEFAULTS, launcherDir);
    assert.strictEqual(r.ok, true); assert.ok(r.exe.endsWith('TheGreatCircle_4_27-Win64-Shipping.exe'));
    fs.writeFileSync(path.join(tmp, 'TheGreatCircle_4_27.exe'), ''); // the root stub wins when present
    r = gl.resolveGameExe(gl.DEFAULTS, launcherDir);
    assert.strictEqual(path.basename(r.exe), 'TheGreatCircle_4_27.exe');
  });
  await t('resolve game exe: refuses paths outside the game root and non-exe files', () => {
    fs.writeFileSync(path.join(os.tmpdir(), 'outside-tgc.exe'), '');
    fs.writeFileSync(path.join(tmp, 'notes.txt'), '');
    const r = gl.resolveGameExe({ ...gl.DEFAULTS, gameExe: ['../outside-tgc.exe', 'notes.txt'] }, launcherDir);
    assert.strictEqual(r.ok, false); assert.strictEqual(r.tried.length, 0);
  });
  await t('forwarded args: Unreal args pass, Chromium switches and the app path do not', () => {
    assert.deepStrictEqual(gl.forwardedArgs(['TGC_Launcher.exe', '-windowed', '-ResX=1280', '--inspect=9229', '--launcher-selfcheck=x'], true), ['-windowed', '-ResX=1280']);
    assert.deepStrictEqual(gl.forwardedArgs(['electron.exe', '.', '-dx12'], false), ['-dx12']);
  });
  await t('launched by Steam detection', () => {
    assert.strictEqual(gl.launchedBySteam({ SteamAppId: '1751950' }), true);
    assert.strictEqual(gl.launchedBySteam({}), false);
  });
  await t('start game: missing exe -> spawn_failed', async () => {
    const r = await gl.startGame(path.join(tmp, 'nope.exe'), [], { startupCheckMs: 2000 });
    assert.strictEqual(r.ok, false); assert.strictEqual(r.code, 'spawn_failed');
  });
  await t('start game: crash on start -> game_exited', async () => {
    const r = await gl.startGame(process.execPath, ['-e', 'process.exit(3)'], { startupCheckMs: 3000 });
    assert.strictEqual(r.ok, false); assert.strictEqual(r.code, 'game_exited'); assert.strictEqual(r.exitCode, 3);
  });
  await t('start game: still running after the check -> ok, gets args and SteamAppId', async () => {
    const out = path.join(tmp, 'dummy.json');
    const dummy = path.join(tmp, 'dummy-game.js'); // stands in for the game exe
    fs.writeFileSync(dummy, `require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify({ args: process.argv.slice(2), appid: process.env.SteamAppId || null })); setTimeout(() => {}, 1500)`);
    const r = await gl.startGame(process.execPath, [dummy, '-windowed'], { startupCheckMs: 700, env: { ...process.env, SteamAppId: '1865070' } });
    assert.strictEqual(r.ok, true); assert.ok(!r.exitedEarly);
    await new Promise((res) => r.child.once('exit', res));
    const d = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.deepStrictEqual(d.args, ['-windowed']); assert.strictEqual(d.appid, '1865070');
  });
  try { fs.rmSync(tmp, { recursive: true, force: true }); fs.rmSync(path.join(os.tmpdir(), 'outside-tgc.exe'), { force: true }); } catch (_) { /* ignore */ }
  // Live server contract checks (unauthenticated only).
  await t('server /health ok', async () => {
    const r = await fetch(`${cfg.ACCOUNT_SERVER_URL}/health`); const b = await r.json();
    assert.strictEqual(r.status, 200); assert.strictEqual(b.ok, true);
  });
  await t('server /entitlements without session -> 401', async () => {
    const r = await fetch(`${cfg.ACCOUNT_SERVER_URL}/entitlements`, { headers: { authorization: 'Bearer nope' } });
    assert.strictEqual(r.status, 401);
  });
  await t('server /steam/verify bad ticket -> 400 bad_ticket', async () => {
    const r = await fetch(`${cfg.ACCOUNT_SERVER_URL}/steam/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ticket: 'zz' }) });
    const b = await r.json(); assert.strictEqual(r.status, 400); assert.strictEqual(b.error, 'bad_ticket');
  });
  await t('server /steam/verify demo appid + bad ticket -> 400 bad_ticket', async () => {
    const r = await fetch(`${cfg.ACCOUNT_SERVER_URL}/steam/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ticket: 'zz', appid: cfg.STEAM_DEMO_APP_ID }) });
    const b = await r.json(); assert.strictEqual(r.status, 400); assert.strictEqual(b.error, 'bad_ticket');
  });
  await t('server /steam/verify disallowed appid -> 400 bad_appid', async () => {
    const r = await fetch(`${cfg.ACCOUNT_SERVER_URL}/steam/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ticket: '00112233445566778899aabbccddeeff', appid: 480 }) });
    const b = await r.json(); assert.strictEqual(r.status, 400); assert.strictEqual(b.error, 'bad_appid');
  });
  console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
  process.exit(failed ? 1 : 0);
})();
