const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const { execFile } = require('child_process');

// Path to your UE4 game executable (update this as needed)
const UE4_GAME_PATH = 'C:/Path/To/Your/UE4Game.exe';

function createWindow() {
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  win.loadFile('index.html');
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

ipcMain.on('launch-ue4', (event, arg) => {
  if (arg && arg.method === 'url' && arg.url) {
    shell.openExternal(arg.url);
    event.reply('launch-ue4-reply', { success: true });
  } else {
    // Default to Steam protocol
    shell.openExternal('steam://run/1751950');
    event.reply('launch-ue4-reply', { success: true });
  }
}); 