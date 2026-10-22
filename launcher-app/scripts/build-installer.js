// Builds the website installer: SS_GameLauncher-Setup-<version>.exe (NSIS) in dist-installer\,
// plus latest.yml and the .blockmap that electron-updater reads from the GitHub release, and a .sha256.
//   npm run dist:installer
// The Steam build (npm run dist -> dist\win-unpacked) ships build\launcher-config.json (launchMode "exe",
// game one folder up) and never self-updates. The website installer is NOT inside the game folder, so it ships
// build\launcher-config.web.json instead (launchMode "steam": Play opens steam://run/<appid>; self-update on).
// Nothing is uploaded: publish is "never". Upload the four files to the GitHub release by hand (gh release create).
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { build, Platform, Arch } = require('electron-builder');
const pkg = require('../package.json');

const projectDir = path.resolve(__dirname, '..');
const outDir = path.join(projectDir, 'dist-installer');
const webConfig = path.join(projectDir, 'build', 'launcher-config.web.json');
const baseAfterPack = require('../build/afterPack.js').default;

const config = {
  ...pkg.build,
  // Own output folder so this never wipes the Steam build in dist\win-unpacked.
  directories: { ...pkg.build.directories, output: 'dist-installer' },
  extraFiles: [{ from: 'build/launcher-config.web.json', to: 'launcher-config.json' }],
  win: { ...pkg.build.win, target: [{ target: 'nsis', arch: ['x64'] }] },
  // Single object, not package.json's array: electron-builder merges the programmatic config with package.json's
  // build section, and two publish arrays merge into an entry that fails its schema check.
  publish: { ...pkg.build.publish[0] },
  // electron-builder MERGES this extraFiles with package.json's (both write launcher-config.json), and which copy
  // wins is not guaranteed. So overwrite it in afterPack. afterPack runs on the unpacked app BEFORE NSIS packs it,
  // and latest.yml / .blockmap are computed from the finished installer after that, so their hashes cover this file.
  afterPack: async (context) => {
    await baseAfterPack(context);
    fs.copyFileSync(webConfig, path.join(context.appOutDir, 'launcher-config.json'));
    const mode = JSON.parse(fs.readFileSync(path.join(context.appOutDir, 'launcher-config.json'), 'utf8')).launchMode;
    if (mode !== 'steam') throw new Error('installer launcher-config.json launchMode is ' + mode + ', expected steam');
    if (!fs.existsSync(path.join(context.appOutDir, 'resources', 'app-update.yml'))) console.log('  installer: (app-update.yml is written later by the nsis target)');
    console.log('  installer: launcher-config.json = launcher-config.web.json (launchMode steam)');
  },
};

const hash = (file, algo, enc) => crypto.createHash(algo).update(fs.readFileSync(file)).digest(enc);

function verify() {
  const exeName = `SS_GameLauncher-Setup-${pkg.version}.exe`;
  const exe = path.join(outDir, exeName);
  const yml = fs.readFileSync(path.join(outDir, 'latest.yml'), 'utf8');
  const field = (k) => ((yml.match(new RegExp(`^\\s*${k}:\\s*(.+)$`, 'm')) || [])[1] || '').trim().replace(/^['"]|['"]$/g, '');
  const sha512 = hash(exe, 'sha512', 'base64');
  const size = fs.statSync(exe).size;
  const problems = [];
  if (field('version') !== pkg.version) problems.push(`latest.yml version ${field('version')} != ${pkg.version}`);
  if (field('path') !== exeName) problems.push(`latest.yml path ${field('path')} != ${exeName}`);
  if (field('sha512') !== sha512) problems.push('latest.yml sha512 does not match the installer');
  if (!yml.includes(`url: ${exeName}`)) problems.push('latest.yml files[0].url is not the installer');
  if (!yml.includes(`size: ${size}`)) problems.push(`latest.yml size != ${size}`);
  if (!fs.existsSync(exe + '.blockmap')) problems.push('missing .blockmap');
  const unpacked = path.join(outDir, 'win-unpacked');
  const appUpdate = path.join(unpacked, 'resources', 'app-update.yml');
  if (!fs.existsSync(appUpdate)) problems.push('missing resources/app-update.yml in the installed app');
  else if (!/provider:\s*github/.test(fs.readFileSync(appUpdate, 'utf8'))) problems.push('app-update.yml is not the github provider');
  if (fs.existsSync(appUpdate) && /publisherName/.test(fs.readFileSync(appUpdate, 'utf8'))) problems.push('app-update.yml has publisherName (unsigned build must not)');
  const sha256 = hash(exe, 'sha256', 'hex');
  fs.writeFileSync(exe + '.sha256', `${sha256}  ${exeName}\n`);
  console.log(`\nInstaller  ${exeName}  ${size} bytes`);
  console.log(`SHA-256    ${sha256}`);
  console.log(`SHA-512    ${sha512}`);
  console.log('Upload     ' + [exeName, exeName + '.sha256', exeName + '.blockmap', 'latest.yml'].join(', '));
  if (problems.length) { console.error('VERIFY FAILED:\n  ' + problems.join('\n  ')); process.exit(1); }
  console.log('VERIFY OK: latest.yml version/path/size/sha512 match the installer; app-update.yml = github, no publisherName');
}

build({ projectDir, targets: Platform.WINDOWS.createTarget('nsis', Arch.x64), config, publish: 'never' })
  .then((files) => { console.log('Built:'); for (const f of files) console.log('  ' + f); verify(); })
  .catch((e) => { console.error(e); process.exit(1); });
