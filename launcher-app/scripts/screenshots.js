// Renders the launcher at 1280x800 in two mocked states and saves PNGs to ../screenshots.
//   npx electron scripts/screenshots.js
// Uses a throwaway userData folder and a mocked account:status handler, so it never touches
// the real session, Steam, or the account server.
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, ipcMain, BrowserWindow } = require('electron');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'ss-launcher-shots-')));
require('../main.js');

const OUT = path.join(__dirname, '..', 'screenshots');
fs.mkdirSync(OUT, { recursive: true });

const now = Math.floor(Date.now() / 1000);
const STATES = {
  'not-linked': { linked: false, source: 'none', reason: 'not_linked' },
  'linked-gold-tier4-demo': {
    linked: true, source: 'server', steamid: '76561198000000000', steamApp: 1865070, ownsFullGame: false,
    discordId: '123456789012345678', discordUsername: 'termaine', tier: 4, tierName: 'Gold',
    entitlements: ['alpha_builds', 'multiplayer', 'restricted_content', 'supporter'],
    expiresAt: now + 7 * 24 * 3600, inGuild: true,
  },
};
let current = STATES['not-linked'];
ipcMain.removeHandler('account:status');
ipcMain.handle('account:status', () => current);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function loaded(wc) { return new Promise((r) => wc.once('did-finish-load', r)); }

app.whenReady().then(async () => {
  await sleep(300);
  const win = BrowserWindow.getAllWindows()[0];
  const wc = win.webContents;
  wc.on('console-message', (...a) => {
    const msg = typeof a[0] === 'object' && a[0] && 'message' in a[0] ? a[0].message : a[2];
    console.log('[renderer console]', msg);
  });
  win.setContentSize(1280, 800);
  if (wc.isLoading()) await loaded(wc);
  await wc.executeJavaScript("localStorage.setItem('analyticsConsentAsked','true'); localStorage.setItem('theme','dark');");

  for (const [name, state] of Object.entries(STATES)) {
    current = state;
    const l = loaded(wc);
    wc.reload();
    await l;
    await wc.executeJavaScript('document.fonts.ready.then(() => true)');
    if (name.startsWith('linked')) {
      // Show the download progress area in the second shot.
      await wc.executeJavaScript(`(() => {
        document.getElementById('download-progress-container').style.display = 'block';
        document.getElementById('download-progress').style.width = '62%';
        document.getElementById('download-status').textContent = 'Downloading... 62%';
      })()`);
    }
    await sleep(4200); // let the "update available" toast fade out
    const info = await wc.executeJavaScript(`JSON.stringify({
      fonts: [...document.fonts].filter(f => f.status === 'loaded').map(f => f.family),
      w: innerWidth, h: innerHeight,
      status: document.getElementById('account-status').textContent,
      state: document.getElementById('account-state').textContent,
      badge: document.getElementById('account-game-badge').textContent,
      chips: [...document.querySelectorAll('#account-entitlements li')].map(l => l.textContent),
      news: document.querySelectorAll('.news-item').length,
      requireType: typeof require
    })`);
    let img = await wc.capturePage();
    for (let i = 0; i < 5 && img.isEmpty(); i++) { // first frame can be empty if the window hasn't painted yet
      win.show(); wc.invalidate(); await sleep(800);
      img = await wc.capturePage();
    }
    const native = img.getSize();
    if (native.width !== 1280) img = img.resize({ width: 1280, height: 800, quality: 'best' }); // HiDPI displays
    const file = path.join(OUT, `launcher-${name}-1280x800.png`);
    fs.writeFileSync(file, img.toPNG());
    const sz = img.getSize();
    console.log(`SHOT ${name} ${sz.width}x${sz.height} (native ${native.width}x${native.height}) ${file} ${info}`);
  }
  app.quit();
});
