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

build({ projectDir: path.resolve(__dirname, '..'), targets: Platform.WINDOWS.createTarget('nsis', Arch.x64), config })
  .then((files) => { console.log('Built:'); for (const f of files) console.log('  ' + f); })
  .catch((e) => { console.error(e); process.exit(1); });