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

async function fitAndCapture(win, wc, name) {
  await wc.executeJavaScript(`(() => {
    const hero = document.querySelector('.hero');
    const columns = document.querySelector('.columns');
    const toast = document.getElementById('toast');
    if (hero) hero.style.display = 'none';
    if (columns) columns.style.display = 'none';
    if (toast) toast.style.display = 'none';
    document.getElementById('characters').scrollIntoView({ block: 'start' });
  })()`);
  const box = await wc.executeJavaScript(`(() => {
    const el = document.getElementById('characters');
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, iw: innerWidth, ih: innerHeight };
  })()`);
  const targetH = Math.min(1700, Math.max(720, Math.ceil(box.y + box.h + 28)));
  win.setContentSize(1280, targetH);
  await sleep(250);
  await wc.executeJavaScript(`document.getElementById('characters').scrollIntoView({ block: 'start' })`);
  await sleep(200);
  const box2 = await wc.executeJavaScript(`(() => {
    const el = document.getElementById('characters');
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, iw: innerWidth, ih: innerHeight, state: el.dataset.state };
  })()`);
  let img = await wc.capturePage();
  for (let i = 0; i < 5 && img.isEmpty(); i++) {
    win.show();
    wc.invalidate();
    await sleep(400);
    img = await wc.capturePage();
  }
  const native = img.getSize();
  const scaleX = native.width / box2.iw;
  const scaleY = native.height / box2.ih;
  let crop = {
    x: Math.max(0, Math.floor(box2.x * scaleX)),
    y: Math.max(0, Math.floor(box2.y * scaleY)),
    width: Math.max(1, Math.floor(box2.w * scaleX)),
    height: Math.max(1, Math.floor(box2.h * scaleY)),
  };
  if (crop.x + crop.width > native.width) crop.width = native.width - crop.x;
  if (crop.y + crop.height > native.height) crop.height = native.height - crop.y;
  const shot = crop.width > 0 && crop.height > 0 ? img.crop(crop) : img;
  writePng(name, shot.toPNG());
  console.log('  ', name, shot.getSize(), 'state', box2.state, 'crop', crop);
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
  win.setContentSize(1280, 1100);
  if (wc.isLoading()) await loaded(wc);
  await wc.executeJavaScript("localStorage.setItem('analyticsConsentAsked','true'); localStorage.setItem('theme','dark');");
  const again = loaded(wc);
  wc.reload();
  await again;
  await waitFor(wc, `document.getElementById('characters').dataset.state === 'ok'`);
  await wc.executeJavaScript(`document.getElementById('tgc-tab-detail').click()`);
  await sleep(200);
  await fitAndCapture(win, wc, 'characters-roster-stats-history.png');

  await wc.executeJavaScript(`document.getElementById('tgc-tab-map').click()`);
  await waitFor(wc, `document.getElementById('characters').dataset.mapready === '1' && !document.getElementById('tgc-map-pin').hidden`);
  await sleep(200);
  await fitAndCapture(win, wc, 'map-pin-and-fog.png');

  await wc.executeJavaScript(`document.querySelector('#tgc-graveyard button').click(); document.getElementById('tgc-tab-map').click();`);
  await waitFor(wc, `document.getElementById('characters').dataset.mapready === '1' && document.getElementById('tgc-map-caption').textContent.includes('pin only')`);
  await sleep(200);
  await fitAndCapture(win, wc, 'map-graveyard-pin-only.png');

  const good = JSON.parse(fs.readFileSync(path.join(fixtureSrc, 'launcher_snapshot.json'), 'utf8'));
  const cases = [
    ['error-missing.png', null, 'missing'],
    ['error-corrupt.png', '{"schemaVersion":1,"characters":[', 'corrupt'],
    ['error-unknown-schema.png', { schemaVersion: 9, savedAtUnix: 1, characters: [] }, 'unknown_schema'],
    ['error-oversize.png', Buffer.alloc(33 * 1024, 0x20), 'oversize'],
    ['error-stale.png', { ...good, savedAtUnix: Math.floor(Date.now() / 1000) - 40 * 86400 }, 'stale'],
  ];
  for (const [name, body, state] of cases) {
    writeSnapshot(body);
    wc.send('snapshot:updated');
    await waitFor(wc, `document.getElementById('characters').dataset.state === ${JSON.stringify(state)}`);
    await sleep(150);
    await fitAndCapture(win, wc, name);
  }
  app.quit();
}).catch((err) => {
  console.error(err);
  app.exit(1);
});
