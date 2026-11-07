// Renders the Characters, Account, and Map panels from the fake snapshot.
//   SS_TGC_SNAPSHOT_DIR is set to a copy of fixtures/tgc-snapshot before main loads.
//   npx electron scripts/snapshot-screenshots.js
// Writes PNGs under /opt/cursor/artifacts/tgc-snapshot (and launcher-app/screenshots/snapshot).
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, ipcMain, BrowserWindow } = require('electron');

const fixtureSrc = path.join(__dirname, '..', 'fixtures', 'tgc-snapshot');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tgc-shot-'));
fs.cpSync(fixtureSrc, work, { recursive: true });
process.env.SS_TGC_SNAPSHOT_DIR = work;

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'ss-launcher-snap-')));
require('../main.js');

const OUTS = [
  path.join(__dirname, '..', 'screenshots', 'snapshot'),
  '/opt/cursor/artifacts/tgc-snapshot',
].filter((dir) => {
  try { fs.mkdirSync(dir, { recursive: true }); return true; } catch (_) { return false; }
});

ipcMain.removeHandler('account:status');
ipcMain.handle('account:status', () => ({ linked: false, source: 'none', reason: 'not_linked' }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function loaded(wc) { return new Promise((r) => wc.once('did-finish-load', r)); }

function writePng(name, buf) {
  for (const dir of OUTS) fs.writeFileSync(path.join(dir, name), buf);
  console.log('SHOT', name, buf.length);
}

async function waitFor(wc, expr) {
  for (let i = 0; i < 50; i++) {
    const ok = await wc.executeJavaScript(expr);
    if (ok) return;
    await sleep(100);
  }
  throw new Error(`timed out: ${expr}`);
}

async function captureWindow(win, wc, name) {
  win.setContentSize(1280, 800);
  await sleep(250);
  await wc.executeJavaScript(`document.getElementById('main').scrollTop = 0`);
  await sleep(150);
  let img = await wc.capturePage();
  for (let i = 0; i < 5 && img.isEmpty(); i++) {
    win.show();
    wc.invalidate();
    await sleep(400);
    img = await wc.capturePage();
  }
  const native = img.getSize();
  if (native.width !== 1280) img = img.resize({ width: 1280, height: 800, quality: 'best' });
  writePng(name, img.toPNG());
  const info = await wc.executeJavaScript(`JSON.stringify({
    home: document.getElementById('home').hidden,
    game: document.getElementById('game-view').hidden,
    tab: document.getElementById('game-view').dataset.game || '',
    state: document.getElementById('game-view').dataset.state
  })`);
  console.log('  ', name, img.getSize(), info);
}

function writeSnapshot(value) {
  const file = path.join(work, 'launcher_snapshot.json');
  if (value === null) {
    fs.rmSync(file, { force: true });
    return;
  }
  const body = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
  fs.writeFileSync(file, body);
}

app.whenReady().then(async () => {
  await sleep(400);
  const win = BrowserWindow.getAllWindows()[0];
  const wc = win.webContents;
  wc.on('console-message', (...args) => {
    const msg = typeof args[0] === 'object' && args[0] && 'message' in args[0] ? args[0].message : args[2];
    if (msg) console.log('[renderer]', msg);
  });
  win.setContentSize(1280, 800);
  if (wc.isLoading()) await loaded(wc);
  await wc.executeJavaScript("localStorage.setItem('analyticsConsentAsked','true'); localStorage.setItem('theme','dark');");
  const again = loaded(wc);
  wc.reload();
  await again;
  await waitFor(wc, `document.getElementById('game-view').dataset.state === 'ok' && document.getElementById('game-view').hidden`);
  await captureWindow(win, wc, 'home.png');

  await wc.executeJavaScript(`document.querySelector('[data-open-game="tgc"]').click()`);
  await waitFor(wc, `document.getElementById('game-view').hidden === false && document.getElementById('tgc-last-name').textContent === 'Jasiri'`);
  await sleep(200);
  await captureWindow(win, wc, 'tgc-overview.png');

  await wc.executeJavaScript(`document.querySelector('#game-tablist [data-tab="characters"]').click()`);
  await waitFor(wc, `document.getElementById('game-panel-tgc-characters').hidden === false && document.getElementById('tgc-history').children.length > 0`);
  await sleep(200);
  await captureWindow(win, wc, 'tgc-characters.png');

  await wc.executeJavaScript(`document.querySelector('#game-tablist [data-tab="map"]').click()`);
  await waitFor(wc, `document.getElementById('game-view').dataset.mapready === '1' && document.getElementById('tgc-map-pin').hidden === false`);
  await sleep(250);
  await captureWindow(win, wc, 'tgc-map.png');

  await wc.executeJavaScript(`document.querySelector('#game-tablist [data-tab="library"]').click()`);
  await waitFor(wc, `document.getElementById('game-view').dataset.libraryready === '1' && document.getElementById('tgc-lore-count').textContent.includes('4 / 10')`);
  await sleep(200);
  await captureWindow(win, wc, 'tgc-library.png');

  await wc.executeJavaScript(`document.querySelector('#tgc-lore-list button:not([disabled])').click()`);
  await waitFor(wc, `document.getElementById('game-view').dataset.readerready === '1' && document.getElementById('tgc-lore-title').textContent.length > 3`);
  await sleep(200);
  await captureWindow(win, wc, 'tgc-lore-reader.png');

  await wc.executeJavaScript(`document.querySelector('#game-tablist [data-tab="gallery"]').click()`);
  await waitFor(wc, `document.querySelectorAll('#tgc-photo-grid img[src^="data:"]').length >= 2`);
  await sleep(200);
  await captureWindow(win, wc, 'tgc-gallery.png');

  await wc.executeJavaScript(`document.querySelector('#tgc-photo-grid button').click()`);
  await waitFor(wc, `document.getElementById('game-view').dataset.photoready === '1' && document.getElementById('tgc-photo-caption').textContent.length > 0`);
  await sleep(200);
  await captureWindow(win, wc, 'tgc-photo.png');

  writeSnapshot(null);
  wc.send('snapshot:updated');
  await wc.executeJavaScript(`document.querySelector('#game-tablist [data-tab="library"]').click()`);
  await waitFor(wc, `document.getElementById('game-view').dataset.state === 'missing' && document.getElementById('game-status').textContent.includes('Play once')`);
  await sleep(150);
  await captureWindow(win, wc, 'tgc-empty.png');
  app.quit();
}).catch((err) => {
  console.error(err);
  app.exit(1);
});
