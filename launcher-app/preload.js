// The only bridge between the page and Electron. Runs sandboxed with contextIsolation,
// so the page gets these functions and nothing else (no require, no ipcRenderer).
const { contextBridge, ipcRenderer } = require('electron');

function on(channel, cb) {
  const handler = (_event, ...args) => cb(...args);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('launcher', {
  // Launch
  play: (opts) => ipcRenderer.invoke('launcher:play', opts || { method: 'steam' }),
  openExternal: (url) => ipcRenderer.invoke('launcher:open-external', String(url)),

  // Discord account link
  getLinkStatus: () => ipcRenderer.invoke('account:status'),
  linkDiscord: () => ipcRenderer.invoke('account:link'),
  cancelLink: () => ipcRenderer.invoke('account:cancel-link'),
  onLinkProgress: (cb) => on('account:progress', cb),

  // Steam test branches (passwords for branches your Discord tier grants)
  getBranches: () => ipcRenderer.invoke('account:branches'),
  copyBranchPassword: (branch) => ipcRenderer.invoke('account:copy-branch-password', String(branch)),

  // Download / installer
  chooseDownloadLocation: () => ipcRenderer.invoke('download:choose-location'),
  startDownload: (filePath) => ipcRenderer.send('download:start', String(filePath)),
  runInstaller: (filePath) => ipcRenderer.send('installer:run', String(filePath)),
  onDownloadProgress: (cb) => on('download:progress', cb),
  onDownloadComplete: (cb) => on('download:complete', cb),
  onDownloadError: (cb) => on('download:error', cb),
});
