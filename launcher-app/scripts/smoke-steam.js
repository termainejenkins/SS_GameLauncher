// Steam step only: same order as the launcher (full game, then demo), one helper process per app,
// each doing init + ticket + POST /steam/verify {ticket, appid}. Then quits.
//   npx electron scripts/smoke-steam.js
// Prints only ok/code and whether a session came back; the session itself is never printed or stored.
// Also prints Steam's RunningAppID (registry) before/after, to show nothing is left "playing".
'use strict';
const path = require('path');
const { execFileSync } = require('child_process');
const { app, utilityProcess } = require('electron');
const cfg = require('../config');

function runningAppId() {
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'RunningAppID'], { encoding: 'utf8', windowsHide: true });
    const m = out.match(/RunningAppID\s+REG_DWORD\s+0x([0-9a-f]+)/i);
    return m ? parseInt(m[1], 16) : null;
  } catch (_) { return null; }
}

function runWorker(appid) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = utilityProcess.fork(path.join(__dirname, '..', 'steam-ticket-worker.js'), [String(appid), 'verify'], { cwd: path.join(__dirname, '..'), stdio: 'ignore' });
    let result = null;
    const kill = setTimeout(() => { try { child.kill(); } catch (_) {} }, 30000);
    child.on('message', (m) => { result = m; });
    child.on('exit', (code) => {
      clearTimeout(kill);
      const r = result || {};
      resolve({ appid, ok: !!r.ok, code: r.code || null, message: r.ok ? null : r.message || null, gotSession: typeof r.session === 'string' && r.session.length > 20, steamidLen: (r.steamid || '').length, workerExit: code, ms: Date.now() - t0 });
    });
  });
}

app.whenReady().then(async () => {
  console.log('SMOKE_STEAM RunningAppID before: ' + runningAppId());
  let final = null;
  for (const appid of cfg.STEAM_APP_IDS) {
    const r = await runWorker(appid);
    console.log('SMOKE_STEAM attempt ' + JSON.stringify(r));
    if (r.ok || r.code !== 'steam_init_failed') { final = r; break; }
  }
  await new Promise((res) => setTimeout(res, 2000));
  console.log('SMOKE_STEAM RunningAppID 2s after: ' + runningAppId());
  console.log('SMOKE_STEAM result ' + JSON.stringify(final ? { ok: final.ok, appid: final.appid, code: final.code } : { ok: false, code: 'steam_not_owned', message: "This Steam account doesn't own THE GREAT CIRCLE or its demo." }));
  app.quit();
});
