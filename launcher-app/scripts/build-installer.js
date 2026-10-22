// Builds the website installer: SS_GameLauncher-Setup-<version>.exe (NSIS) in dist-installer\.
//   npm run dist:installer
// The Steam build (npm run dist -> dist\win-unpacked) ships build\launcher-config.json (launchMode "exe",
// game one folder up). The website installer is NOT inside the game folder, so it ships
// build\launcher-config.web.json instead (launchMode "steam": Play opens steam://run/<appid>).
'use strict';
const path = require('path');
const { build, Platform, Arch } = require('electron-builder');
const pkg = require('../package.json');

const config = {
  ...pkg.build,
  // Own output folder so this never wipes the Steam build in dist\win-unpacked.
  directories: { ...pkg.build.directories, output: 'dist-installer' },
  extraFiles: [{ from: 'build/launcher-config.web.json', to: 'launcher-config.json' }],
  win: { ...pkg.build.win, target: [{ target: 'nsis', arch: ['x64'] }] },
};

// electron-builder MERGES this extraFiles with package.json's (both write launcher-config.json), and which copy
// wins is not guaranteed. So overwrite it after packing (before NSIS zips it) and assert the result.
const fs = require('fs');
const projectDir = path.resolve(__dirname, '..');
const webConfig = path.join(projectDir, 'build', 'launcher-config.web.json');
const baseAfterPack = require('../build/afterPack.js').default;
config.afterPack = async (context) => {
  await baseAfterPack(context);
  fs.copyFileSync(webConfig, path.join(context.appOutDir, 'launcher-config.json'));
  const mode = JSON.parse(fs.readFileSync(path.join(context.appOutDir, 'launcher-config.json'), 'utf8')).launchMode;
  if (mode !== 'steam') throw new Error('installer launcher-config.json launchMode is ' + mode + ', expected steam');
  console.log('  installer: launcher-config.json = launcher-config.web.json (launchMode steam)');
};

build({ projectDir, targets: Platform.WINDOWS.createTarget('nsis', Arch.x64), config })
  .then((files) => { console.log('Built:'); for (const f of files) console.log('  ' + f); })
  .catch((e) => { console.error(e); process.exit(1); });