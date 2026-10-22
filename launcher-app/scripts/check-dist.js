// Checks the packaged launcher in dist\win-unpacked (run after `npm run dist`).
//   npm run dist:check
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', 'dist', 'win-unpacked');
const must = [
  'TGC_Launcher.exe',
  'launcher-config.json',
  'resources/app.asar',
  'resources/app.asar.unpacked/node_modules/steamworks.js/dist/win64/steamworksjs.win32-x64-msvc.node',
  'resources/app.asar.unpacked/node_modules/steamworks.js/dist/win64/steam_api64.dll',
];
const mustNot = ['steam_appid.txt', 'resources/steam_appid.txt'];
let bad = 0;
for (const f of must) { const ok = fs.existsSync(path.join(root, f)); if (!ok) bad++; console.log(ok ? 'OK     ' : 'MISSING', f); }
for (const f of mustNot) { const there = fs.existsSync(path.join(root, f)); if (there) bad++; console.log(there ? 'UNWANTED' : 'OK     ', 'no', f); }
let bytes = 0; let files = 0;
(function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else { files++; bytes += fs.statSync(p).size; } } })(root);
try { JSON.parse(fs.readFileSync(path.join(root, 'launcher-config.json'), 'utf8')); console.log('OK      launcher-config.json is valid JSON'); } catch (e) { bad++; console.log('BAD     launcher-config.json', e.message); }
// The Steam depot copy must never self-update (Steam owns these files).
try {
  const { updatePolicy } = require('../updater');
  const { loadLaunchConfig } = require('../game-launch');
  const lc = loadLaunchConfig(root);
  const pol = updatePolicy({ isPackaged: true, launchCfg: lc, execPath: path.join(root, 'TGC_Launcher.exe'), resourcesPath: path.join(root, 'resources'), launchedBySteam: false });
  if (lc.config.launchMode !== 'exe') { bad++; console.log('BAD     launcher-config.json launchMode is', lc.config.launchMode, '(Steam build needs exe)'); } else console.log('OK      launchMode exe (Steam layout)');
  if (pol.enabled) { bad++; console.log('BAD     self-update would be ON for the Steam build'); } else console.log(`OK      self-update off for the Steam build (${pol.reason})`);
} catch (e) { bad++; console.log('BAD     update policy check', e.message); }
console.log(`${files} files, ${(bytes / 1048576).toFixed(1)} MB in ${root}`);
console.log(bad ? `${bad} PROBLEM(S)` : 'DIST OK');
process.exit(bad ? 1 : 0);
