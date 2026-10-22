const { app, BrowserWindow, ipcMain, shell, dialog, safeStorage, session, utilityProcess, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const crypto = require('crypto');
const { execFile } = require('child_process');
const cfg = require('./config');
const { createAccountManager } = require('./account');
const launch = require('./game-launch');
const updater = require('./updater');

const account = createAccountManager({ app, safeStorage, shell, utilityProcess });

// Folder TGC_Launcher.exe is in (packaged build), or this project folder (npm start).
// launcher-config.json there says where the game is (default: one folder up, see STEAM_SETUP.md).
// Without a config file, packaged builds start the game exe; npm start keeps the old steam://run behaviour.
const LAUNCHER_DIR = app.isPackaged ? path.dirname(process.execPath) : __dirname;
const launchCfg = launch.loadLaunchConfig(LAUNCHER_DIR, { ...launch.DEFAULTS, launchMode: app.isPackaged ? 'exe' : 'steam' });

// Test hook for the packaged build only runs when BOTH the env var and the flag are set.
const SELFCHECK_OUT = process.env.SS_LAUNCHER_SELFTEST === '1'
  ? ((process.argv.find((a) => a.startsWith('--launcher-selfcheck=')) || '').slice('--launcher-selfcheck='.length))
  : '';

// One launcher at a time (Steam's Play button, a desktop shortcut, ...). Dev runs and smoke tests skip this.
const gotLock = !app.isPackaged || !!SELFCHECK_OUT || app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

let waitingForGame = false; // window closed on purpose; quit when the game exits
let gameChild = null; // game process this launcher started, while it runs

// Only these URL schemes may leave the launcher via shell.openExternal.
function isAllowedExternal(url, schemes = ['https:', 'http:']) {
  try {
    return schemes.includes(new URL(url).protocol);
  } catch (_) {
    return false;
  }
}

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    useContentSize: true,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: '#14100c',
    title: 'SS Game Launcher',
    icon: path.join(__dirname, 'assets/brand/ss_appicon_win_multi_v2.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Links with target=_blank / window.open go to the system browser, never a new Electron window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternal(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // The top-level page may never navigate away from index.html.
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) {
      e.preventDefault();
      if (isAllowedExternal(url)) shell.openExternal(url);
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(() => {
  if (!gotLock) return;
  // Deny camera/mic/notifications/etc. for any content (including the web-game iframe).
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  if (SELFCHECK_OUT) return runSelfcheck(SELFCHECK_OUT);
  createWindow();
  initUpdater();
});

// ---------------- launcher self-update (website install only; see updater.js) ----------------

const updatePolicy = updater.updatePolicy({
  isPackaged: app.isPackaged,
  launchCfg,
  execPath: process.execPath,
  resourcesPath: process.resourcesPath,
  launchedBySteam: launch.launchedBySteam(),
});
let updateCtl = null;

function initUpdater() {
  try {
    updateCtl = updater.startAutoUpdate({
      app,
      policy: updatePolicy,
      logDir: path.join(app.getPath('userData'), 'logs'),
      send: (st) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('updater:status', st); },
      isBusy: () => !!gameChild || waitingForGame,
    });
  } catch (_) { updateCtl = null; } // never blocks the launcher
}

ipcMain.handle('updater:status', () => (updateCtl ? updateCtl.getStatus() : { state: 'disabled', reason: updatePolicy.reason, current: app.getVersion() }));
ipcMain.handle('updater:install', () => (updateCtl ? updateCtl.install() : { ok: false, reason: 'disabled' }));

app.on('window-all-closed', () => {
  if (waitingForGame) return; // close-and-wait: stay (windowless) until the game exits
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// ---------------- launch ----------------

/**
 * Steam starts this launcher; Play starts the game exe from the same install (launcher-config.json).
 * The game inherits our environment, including SteamAppId from Steam, so its SteamAPI_Init just works.
 * The launcher itself never holds the Steam API: the ticket helper is a separate process, and we wait
 * for it to exit before the game starts.
 */
async function playExe(argv = process.argv) {
  if (gameChild) return { success: false, mode: 'exe', code: 'game_running', error: 'THE GREAT CIRCLE is already running.' };
  const c = launchCfg.config;
  const found = launch.resolveGameExe(c, LAUNCHER_DIR);
  if (!found.ok) return { success: false, mode: 'exe', code: 'game_missing', error: launch.missingGameMessage(found) };
  const args = [...c.extraArgs, ...(c.forwardArgs ? launch.forwardedArgs(argv, app.isPackaged) : [])];
  await account.waitForSteamWorkers(5000);
  const r = await launch.startGame(found.exe, args, { startupCheckMs: c.startupCheckMs });
  if (!r.ok) return { success: false, mode: 'exe', code: r.code, error: r.message };
  afterGameStarted(r);
  return { success: true, mode: 'exe', exe: path.basename(found.exe), args, afterLaunch: c.afterLaunch };
}

function afterGameStarted(r) {
  const mode = launchCfg.config.afterLaunch;
  const running = !r.exitedEarly;
  if (running) {
    gameChild = r.child;
    r.child.once('exit', () => {
      gameChild = null;
      if (mode === 'close-and-wait') app.quit();
      else if (mode === 'minimize' && mainWindow && !mainWindow.isDestroyed()) mainWindow.restore();
    });
  }
  // Short pause so the renderer can show "Starting..." first.
  setTimeout(() => {
    if (mode === 'quit' || (mode === 'close-and-wait' && !running)) {
      r.child.unref();
      app.quit();
    } else if (mode === 'close-and-wait') {
      // Free the UI (renderer + GPU memory) but keep this small process alive while the game runs,
      // so Steam keeps the app "Running" (playtime, overlay, no double launch). Quit when the game exits.
      waitingForGame = true;
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
    } else if (mode === 'minimize' && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.minimize();
    }
  }, 1200);
}

ipcMain.handle('launcher:play', async (_event, arg) => {
  const isUrl = !!(arg && arg.method === 'url' && arg.url);
  const exeMode = !isUrl && launchCfg.config.launchMode === 'exe';
  // Refresh the signed Discord entitlement first so the game reads a current token. Never blocks launch for long.
  const entitlement = await account.refreshBeforePlay({ resolveApp: !exeMode });
  if (exeMode) return { ...(await playExe()), entitlement };
  if (isUrl) {
    if (!isAllowedExternal(arg.url, ['https:', 'http:', 'steam:'])) {
      return { success: false, error: 'Only http(s) or steam:// URLs can be launched.', entitlement };
    }
    await shell.openExternal(arg.url);
    return { success: true, entitlement };
  }
  // steam://run (dev / old behaviour). Refused when Steam started us: Steam would just start this launcher again.
  if (app.isPackaged && launch.launchedBySteam()) {
    return { success: false, mode: 'steam', code: 'steam_loop', error: 'This launcher was started by Steam, so it has to start the game directly. Set "launchMode": "exe" in launcher-config.json.', entitlement };
  }
  // Steam closed, or this Steam account owns neither app: don't open steam://run (it would point at the unreleased
  // full game). The renderer explains what to do and offers the demo's store page / opening Steam.
  const blocked = entitlement && entitlement.launchCode;
  if (blocked === 'not_owned' || blocked === 'steam_not_running') {
    const error = blocked === 'not_owned' ? "You don't have THE GREAT CIRCLE on Steam yet." : 'Steam is not running. Start Steam, sign in, then press Play again.';
    return { success: false, mode: 'steam', code: blocked, error, demoAppId: cfg.STEAM_DEMO_APP_ID, entitlement };
  }
  // Steam protocol: the full game, or the demo if that's all this account owns.
  const appId = cfg.STEAM_APP_IDS.includes(Number(entitlement && entitlement.launchAppId)) ? Number(entitlement.launchAppId) : cfg.DEFAULT_LAUNCH_APP_ID;
  await shell.openExternal(`steam://run/${appId}`);
  return { success: true, entitlement, appId };
});

ipcMain.handle('launcher:open-external', async (_event, url) => {
  // http(s), plus steam://store/<our app> and steam://open/main for the "no game / Steam closed" prompts.
  if (!isAllowedExternal(url) && !launch.isAllowedSteamLink(url, cfg.STEAM_APP_IDS)) return false;
  try {
    await shell.openExternal(url);
    return true;
  } catch (_) {
    return false; // e.g. no steam:// handler: the renderer falls back to the store website
  }
});

// ---------------- Discord account link ----------------

ipcMain.handle('account:status', () => account.getStatus());

ipcMain.handle('account:link', (event) =>
  account.linkDiscord((stage, info) => {
    if (!event.sender.isDestroyed()) event.sender.send('account:progress', stage, info || {});
  }),
);

ipcMain.handle('account:cancel-link', () => {
  account.cancelLink();
  return true;
});

// ---------------- Steam test-branch passwords ----------------
// Held in memory only for the copy button; never written to disk or logged. Cleared on every fetch and on quit.
let branchPasswords = new Map(); // branch name -> password
const COPY_CLEAR_MS = 60 * 1000; // clear the clipboard after this long, only if it still holds that password (0 = never)

ipcMain.handle('account:branches', async () => {
  branchPasswords = new Map();
  const r = await account.fetchBranches();
  for (const b of r.branches || []) branchPasswords.set(b.branch, b.password);
  return r;
});

// Called only from the Copy button's click handler in the renderer.
ipcMain.handle('account:copy-branch-password', (_event, branch) => {
  const pw = branchPasswords.get(String(branch));
  if (!pw) return false;
  clipboard.writeText(pw);
  if (COPY_CLEAR_MS > 0) {
    setTimeout(() => { try { if (clipboard.readText() === pw) clipboard.clear(); } catch (_) { /* ignore */ } }, COPY_CLEAR_MS).unref?.();
  }
  return true;
});

app.on('before-quit', () => { branchPasswords = new Map(); });

// ---------------- download / installer ----------------

let lastDownloadedPath = null; // the installer may only run what this process downloaded
let pendingDownloadPath = null; // set only by the save dialog below

ipcMain.handle('download:choose-location', async () => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Save UE4 Game Installer',
    defaultPath: path.join(require('os').homedir(), 'Downloads', 'UE4GameInstaller.bin'),
    buttonLabel: 'Save Installer',
    filters: [
      { name: 'Binary', extensions: ['bin', 'exe', 'zip'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  if (canceled || !filePath) return null;
  pendingDownloadPath = filePath;
  return filePath;
});

ipcMain.on('download:start', (event, savePath) => {
  if (!savePath || savePath !== pendingDownloadPath) {
    event.sender.send('download:error', 'Choose a download location first.');
    return;
  }
  pendingDownloadPath = null;
  // Placeholder file URL (test file)
  const fileUrl = 'https://speed.hetzner.de/100MB.bin';
  const file = fs.createWriteStream(savePath);
  https.get(fileUrl, (response) => {
    const total = parseInt(response.headers['content-length'], 10);
    let downloaded = 0;
    response.pipe(file);
    response.on('data', chunk => {
      downloaded += chunk.length;
      const percent = total ? Math.floor((downloaded / total) * 100) : 0;
      event.sender.send('download:progress', percent);
    });
    file.on('finish', () => {
      file.close(() => {
        // Compute SHA256 checksum
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(savePath);
        stream.on('data', data => hash.update(data));
        stream.on('end', () => {
          const checksum = hash.digest('hex');
          lastDownloadedPath = savePath;
          event.sender.send('download:complete', savePath, checksum);
          shell.showItemInFolder(savePath);
        });
      });
    });
  }).on('error', (err) => {
    fs.unlink(savePath, () => {});
    event.sender.send('download:error', err.message);
  });
});

ipcMain.on('installer:run', (event, filePath) => {
  if (!filePath || filePath !== lastDownloadedPath) {
    event.sender.send('download:error', 'Installer path not recognised.');
    return;
  }
  execFile(filePath, (error) => {
    if (error) {
      event.sender.send('download:error', 'Failed to launch installer: ' + error.message);
    }
  });
});

// ---------------- packaged-build self check (SS_LAUNCHER_SELFTEST=1 + --launcher-selfcheck=<file>) ----------------
// Writes a JSON report and quits. Never touches Steam login or Discord. With --launcher-selfcheck-play it
// also runs the real exe launch (playExe) against whatever launcher-config.json points at.
async function runSelfcheck(outFile) {
  const report = { at: new Date().toISOString(), packaged: app.isPackaged, exe: process.execPath, launcherDir: LAUNCHER_DIR,
    config: launchCfg, launchedBySteam: launch.launchedBySteam(), version: app.getVersion(), updater: updatePolicy, argv: process.argv.slice(1), forwarded: launch.forwardedArgs(process.argv, app.isPackaged) };
  const save = () => { try { fs.writeFileSync(outFile, JSON.stringify(report, null, 2)); } catch (_) { /* ignore */ } };
  const mem = () => app.getAppMetrics().map((m) => ({ type: m.type, MB: Math.round(m.memory.workingSetSize / 1024) }));
  try {
    const sw = require('steamworks.js'); // loads the native .node + steam_api64.dll; does NOT init Steam
    report.steamworks = { loaded: typeof sw.init === 'function' };
  } catch (e) {
    report.steamworks = { loaded: false, error: String(e && e.message).slice(0, 300) };
  }
  report.resolve = launch.resolveGameExe(launchCfg.config, LAUNCHER_DIR);
  createWindow();
  await new Promise((r) => mainWindow.webContents.once('did-finish-load', r));
  await new Promise((r) => setTimeout(r, 2500));
  report.ui = JSON.parse(await mainWindow.webContents.executeJavaScript(`JSON.stringify({ title: document.title,
    play: (document.getElementById('play-ue4') || {}).textContent, api: Object.keys(window.launcher || {}), typeofRequire: typeof require })`));
  report.memoryWithWindow = mem();
  save();
  if (!process.argv.includes('--launcher-selfcheck-play')) { app.quit(); return; }
  report.play = await playExe();
  save();
  if (!report.play.success) { app.quit(); return; }
  await new Promise((r) => setTimeout(r, 4000));
  report.windowAfterLaunch = mainWindow && !mainWindow.isDestroyed() ? 'open' : 'closed';
  report.memoryWhileGameRuns = mem();
  save();
  app.once('will-quit', () => { report.quitAfterGameExit = new Date().toISOString(); save(); });
}
