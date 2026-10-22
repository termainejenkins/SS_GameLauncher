// Electron smoke test: boots the real main.js, inspects the window, then quits.
//   npx electron scripts/smoke-electron.js
// Does NOT touch Steam or the Discord link (getLinkStatus never starts Steam).
'use strict';
const { app } = require('electron');

app.on('browser-window-created', (_e, win) => {
  win.webContents.on('console-message', (...args) => {
    const msg = typeof args[0] === 'object' && args[0] && 'message' in args[0] ? args[0].message : args[2];
    console.log('[renderer console]', msg);
  });
  win.webContents.on('did-finish-load', async () => {
    await new Promise((r) => setTimeout(r, 4000));
    const prefs = win.webContents.getLastWebPreferences();
    console.log('SMOKE_PREFS ' + JSON.stringify({ contextIsolation: prefs.contextIsolation, nodeIntegration: prefs.nodeIntegration, sandbox: prefs.sandbox, preload: !!prefs.preload }));
    const r = await win.webContents.executeJavaScript(`JSON.stringify({
      typeofRequire: typeof require, typeofProcess: typeof process,
      launcherApi: Object.keys(window.launcher || {}),
      accountStatus: document.getElementById('account-status').textContent,
      accountDetail: document.getElementById('account-detail').textContent,
      linkButton: document.getElementById('link-discord').textContent,
      newsItems: document.querySelectorAll('.news-item').length,
      newsImgs: document.querySelectorAll('#news-list img').length,
      newsText: [...document.querySelectorAll('.news-item')].map(d => d.textContent).join(' | ')
    })`);
    console.log('SMOKE_RESULT ' + r);
    app.quit();
  });
});

require('../main.js');
