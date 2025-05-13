const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const { execFile } = require('child_process');
const fs = require('fs');
const https = require('https');

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

ipcMain.on('download-ue4', (event) => {
  // Placeholder file URL (test file)
  const fileUrl = 'https://speed.hetzner.de/100MB.bin';
  const savePath = path.join(require('os').homedir(), 'Downloads', 'UE4GameInstaller.bin');
  const file = fs.createWriteStream(savePath);
  https.get(fileUrl, (response) => {
    const total = parseInt(response.headers['content-length'], 10);
    let downloaded = 0;
    response.pipe(file);
    response.on('data', chunk => {
      downloaded += chunk.length;
      const percent = Math.floor((downloaded / total) * 100);
      event.sender.send('download-ue4-progress', percent);
    });
    file.on('finish', () => {
      file.close(() => {
        event.sender.send('download-ue4-complete', savePath);
        shell.showItemInFolder(savePath);
      });
    });
  }).on('error', (err) => {
    fs.unlink(savePath, () => {});
    event.sender.send('download-ue4-error', err.message);
  });
}); 