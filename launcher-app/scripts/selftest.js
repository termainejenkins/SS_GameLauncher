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
  // ---------- launcher self-update policy (updater.js) ----------
  {
    const fs = require('fs'); const os = require('os'); const path = require('path');
    const { updatePolicy, scrub, createLogger } = require('../updater');
    const { loadLaunchConfig } = require('../game-launch');
    const mk = (cfgFile, withYml) => {
      const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ssgl-upd-'));
      if (cfgFile) fs.copyFileSync(path.join(__dirname, '..', 'build', cfgFile), path.join(d, 'launcher-config.json'));
      fs.mkdirSync(path.join(d, 'resources'));
      if (withYml) fs.writeFileSync(path.join(d, 'resources', 'app-update.yml'), 'provider: github\nowner: termainejenkins\nrepo: SS_GameLauncher\n');
      return d;
    };
    const pol = (d, extra = {}) => updatePolicy({ isPackaged: true, launchCfg: loadLaunchConfig(d), execPath: path.join(d, 'TGC_Launcher.exe'), resourcesPath: path.join(d, 'resources'), launchedBySteam: false, ...extra });
    await t('update: Steam depot config (build/launcher-config.json) -> self-update OFF, even with app-update.yml', () => {
      const r = pol(mk('launcher-config.json', true)); assert.strictEqual(r.enabled, false); assert.strictEqual(r.reason, 'steam_depot_copy');
    });
    await t('update: packaged with NO launcher-config.json (defaults to exe) -> OFF', () => {
      const r = pol(mk(null, true)); assert.strictEqual(r.enabled, false); assert.strictEqual(r.reason, 'no_launcher_config');
    });
    await t('update: web config (launcher-config.web.json) + app-update.yml -> ON', () => {
      const r = pol(mk('launcher-config.web.json', true)); assert.strictEqual(r.enabled, true); assert.strictEqual(r.reason, 'web_install');
    });
    await t('update: web config but no app-update.yml -> OFF', () => {
      assert.strictEqual(pol(mk('launcher-config.web.json', false)).reason, 'no_app_update_yml');
    });
    await t('update: web config inside a Steam library (steamapps) -> OFF', () => {
      const d = mk('launcher-config.web.json', true);
      const r = pol(d, { execPath: 'D:\\SteamLibrary\\steamapps\\common\\THE GREAT CIRCLE\\WindowsNoEditor\\Launcher\\TGC_Launcher.exe' });
      assert.strictEqual(r.enabled, false); assert.strictEqual(r.reason, 'inside_steam_library');
    });
    await t('update: started by Steam -> OFF', () => {
      assert.strictEqual(pol(mk('launcher-config.web.json', true), { launchedBySteam: true }).reason, 'started_by_steam');
    });
    await t('update: not packaged (npm start) -> OFF', () => {
      assert.strictEqual(pol(mk('launcher-config.web.json', true), { isPackaged: false }).reason, 'not_packaged');
    });
    await t('update: bad input never throws', () => {
      assert.strictEqual(updatePolicy(null).enabled, false); assert.strictEqual(updatePolicy({ isPackaged: true }).enabled, false);
    });
    await t('update: log scrubber removes tokens/passwords', () => {
      const out = scrub('GET https://x/y?token=abc123&a=1 Authorization: Bearer eyJhbGciOi password=hunter2 ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123');
      for (const leak of ['abc123', 'eyJhbGciOi', 'hunter2', 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123']) assert.ok(!out.includes(leak), 'leaked ' + leak);
      assert.ok(out.includes('a=1'));
    });
    await t('update: logger writes a scrubbed line and never throws', () => {
      const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ssgl-log-'));
      const log = createLogger(d); log.error('boom session=s3cr3t', new Error('x')); log.info({ a: 1 });
      const txt = fs.readFileSync(log.file, 'utf8'); assert.ok(txt.includes('ERROR boom')); assert.ok(!txt.includes('s3cr3t'));
      createLogger('\0bad').error('no throw');
    });
    await t('update: package.json publish = github termainejenkins/SS_GameLauncher, artifactName + exe name unchanged, no publisherName', () => {
      const pkg = require('../package.json'); const p = pkg.build.publish[0];
      assert.deepStrictEqual([p.provider, p.owner, p.repo], ['github', 'termainejenkins', 'SS_GameLauncher']);
      assert.strictEqual(pkg.build.nsis.artifactName, 'SS_GameLauncher-Setup-${version}.${ext}');
      assert.strictEqual(pkg.build.executableName, 'TGC_Launcher');
      assert.ok(!('publisherName' in (pkg.build.win || {})) && !('verifyUpdateCodeSignature' in (pkg.build.win || {})));
      assert.ok(pkg.build.files.includes('updater.js')); assert.ok(pkg.dependencies['electron-updater']);
    });
    await t('ui: launcher version label is wired (index.html #launcher-version, preload getVersion, renderer fills it)', () => {
      const fs = require('fs'); const path = require('path'); const rd = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
      assert.ok(rd('index.html').includes('id="launcher-version"'));
      assert.ok(/getVersion:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('updater:status'\)/.test(rd('preload.js')));
      assert.ok(rd('renderer.js').includes('versionLabel.textContent = `v${v}`'));
    });
    await t('ui: version line sits under the sidebar brand; Downloads & updates sits above Discord unlocks', () => {
      const fs = require('fs'); const path = require('path'); const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
      const brand = html.slice(html.indexOf('<div class="brand publisher">'), html.indexOf('<nav class="nav">'));
      assert.ok(brand.includes('id="launcher-version"'), 'version line not in brand block');
      assert.strictEqual(html.split('id="launcher-version"').length, 2, 'version label should appear once');
      const dl = html.indexOf('<section id="downloads"'), acc = html.indexOf('<section id="account"');
      assert.ok(dl > 0 && acc > 0 && dl < acc, 'downloads should come before account');
      const nd = html.indexOf('data-scroll="downloads"'), na = html.indexOf('data-scroll="account"');
      assert.ok(nd > 0 && na > 0 && nd < na, 'Downloads nav button should come before Discord unlocks');
    });
    await t('ui: hero art picks v9 or the trio at random (renderer .hero-trio class, CSS variant, both images exist)', () => {
      const fs = require('fs'); const path = require('path'); const rd = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
      assert.ok(rd('renderer.js').includes("document.querySelector('.hero-art')?.classList.toggle('hero-trio', Math.random() < 0.5);"), 'renderer random pick missing');
      const css = rd('styles.css');
      assert.ok(/\.hero-art \{[^}]*tgc-hero-v9\.png[^}]*image-set\(url\("assets\/art\/tgc-hero-v9\.png"\) 1x, url\("assets\/art\/tgc-hero-v9_2x\.png"\) 2x\)/.test(css), 'v9 default + 2x missing');
      assert.ok(css.includes('.hero-art.hero-trio { background-image: url("assets/art/tgc-hero-trio-v1e.png"); }'), 'trio CSS variant missing');
      for (const f of ['tgc-hero-v9.png', 'tgc-hero-v9_2x.png', 'tgc-hero-trio-v1e.png']) assert.ok(fs.existsSync(path.join(__dirname, '..', 'assets', 'art', f)), f + ' missing');
    });
  }
  // ---------- Play when the account owns nothing / Steam is closed (account.js + main.js + renderer.js) ----------
  {
    const fs = require('fs'); const os = require('os'); const path = require('path'); const { EventEmitter } = require('events');
    const { launchDecisionFromProbe, createAccountManager } = require('../account');
    const { isAllowedSteamLink } = require('../game-launch');
    await t('play decision: owns full game / demo -> that app', () => {
      assert.deepStrictEqual(launchDecisionFromProbe({ ok: true, appid: 1751950 }), { appId: 1751950, code: null });
      assert.deepStrictEqual(launchDecisionFromProbe({ ok: true, appid: 1865070 }), { appId: 1865070, code: null });
    });
    await t('play decision: owns nothing -> not_owned, no app (never steam://run)', () => {
      assert.deepStrictEqual(launchDecisionFromProbe({ ok: false, code: 'steam_not_owned' }), { appId: null, code: 'not_owned' });
    });
    await t('play decision: Steam not running -> steam_not_running, no app', () => {
      assert.deepStrictEqual(launchDecisionFromProbe({ ok: false, code: 'steam_not_running' }), { appId: null, code: 'steam_not_running' });
    });
    await t('play decision: unknown helper failure -> DEFAULT_LAUNCH_APP_ID (demo while full game is unreleased)', () => {
      assert.strictEqual(cfg.DEFAULT_LAUNCH_APP_ID, cfg.STEAM_DEMO_APP_ID);
      for (const code of ['steamworks_missing', 'steam_timeout', 'steam_worker_failed', 'steam_worker_exit', undefined]) {
        assert.strictEqual(launchDecisionFromProbe({ ok: false, code }).appId, cfg.DEFAULT_LAUNCH_APP_ID, String(code));
      }
      assert.strictEqual(launchDecisionFromProbe(null).appId, cfg.DEFAULT_LAUNCH_APP_ID);
    });
    // refreshBeforePlay end to end with a fake Steam helper (utilityProcess.fork) and a temp userData / LOCALAPPDATA.
    const playWith = async (perApp, steamRunning) => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ssgl-play-'));
      const oldLocal = process.env.LOCALAPPDATA; process.env.LOCALAPPDATA = tmp; // no entitlement token -> not linked
      const asked = [];
      const utilityProcess = { fork: (_file, args) => {
        const child = new EventEmitter(); child.kill = () => {}; const appid = Number(args[0]); asked.push(appid);
        setImmediate(() => { child.emit('message', { appid, ...(perApp[appid] || { ok: false, code: 'steam_init_failed' }) }); child.emit('exit', 0); });
        return child;
      } };
      try {
        const acct = createAccountManager({ app: { getPath: () => tmp }, safeStorage: { isEncryptionAvailable: () => false }, shell: {}, utilityProcess, isSteamRunning: async () => steamRunning });
        return { r: await acct.refreshBeforePlay(), asked, remembered: fs.existsSync(path.join(tmp, 'steam_app.json')) };
      } finally {
        if (oldLocal === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = oldLocal;
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* ignore */ }
      }
    };
    await t('play (fake Steam): owns neither app, Steam running -> launchAppId null, launchCode not_owned', async () => {
      const { r, asked } = await playWith({}, true);
      assert.strictEqual(r.launchAppId, null); assert.strictEqual(r.launchCode, 'not_owned'); assert.deepStrictEqual(asked, cfg.STEAM_APP_IDS);
    });
    await t('play (fake Steam): Steam closed -> launchAppId null, launchCode steam_not_running', async () => {
      const { r } = await playWith({}, false);
      assert.strictEqual(r.launchAppId, null); assert.strictEqual(r.launchCode, 'steam_not_running');
    });
    await t('play (fake Steam): demo only -> 1865070 and remembered', async () => {
      const { r, remembered } = await playWith({ 1865070: { ok: true } }, true);
      assert.strictEqual(r.launchAppId, 1865070); assert.strictEqual(r.launchCode, null); assert.ok(remembered);
    });
    await t('play (fake Steam): helper timeout -> falls back to DEFAULT_LAUNCH_APP_ID', async () => {
      const { r } = await playWith({ 1751950: { ok: false, code: 'steam_timeout' } }, true);
      assert.strictEqual(r.launchAppId, cfg.DEFAULT_LAUNCH_APP_ID); assert.strictEqual(r.launchCode, 'steam_timeout');
    });
    await t('open-external steam links: only store/<our app> and open/main', () => {
      assert.ok(isAllowedSteamLink('steam://store/1865070', cfg.STEAM_APP_IDS));
      assert.ok(isAllowedSteamLink('steam://open/main', cfg.STEAM_APP_IDS));
      for (const u of ['steam://run/1865070', 'steam://store/480', 'steam://install/1865070', 'steam://store/1865070/../run/1', 'https://store.steampowered.com/app/1865070/', '', null]) {
        assert.strictEqual(isAllowedSteamLink(u, cfg.STEAM_APP_IDS), false, String(u));
      }
    });
    await t('main/renderer wiring: no full-game fallback, not_owned / steam_not_running handled', () => {
      const rd = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
      const main = rd('main.js'); const ren = rd('renderer.js');
      assert.ok(!/:\s*cfg\.STEAM_APP_ID;/.test(main), 'main.js still falls back to cfg.STEAM_APP_ID');
      assert.ok(main.includes('cfg.DEFAULT_LAUNCH_APP_ID') && main.includes("blocked === 'not_owned' || blocked === 'steam_not_running'"));
      assert.ok(main.includes('launch.isAllowedSteamLink(url, cfg.STEAM_APP_IDS)'));
      assert.ok(ren.includes("You don't have THE GREAT CIRCLE on Steam yet") && ren.includes('Get the free demo on Steam'));
      assert.ok(ren.includes('steam://store/${demo}') && ren.includes('https://store.steampowered.com/app/1865070/') && ren.includes("'steam://open/main'"));
    });
  }
  console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
  process.exit(failed ? 1 : 0);
})();
