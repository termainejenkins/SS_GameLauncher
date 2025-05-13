const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const { execFile } = require('child_process');
const fs = require('fs');
const https = require('https');
const crypto = require('crypto');

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

ipcMain.on('choose-download-location', async (event) => {
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: 'Save UE4 Game Installer',
    defaultPath: require('os').homedir() + '/Downloads/UE4GameInstaller.bin',
    buttonLabel: 'Save Installer',
    filters: [
      { name: 'Binary', extensions: ['bin', 'exe', 'zip'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  if (!canceled && filePath) {
    event.sender.send('download-location-chosen', filePath);
  }
});

ipcMain.on('download-ue4', (event, savePath) => {
  // Placeholder file URL (test file)
  const fileUrl = 'https://speed.hetzner.de/100MB.bin';
  const fs = require('fs');
  const https = require('https');
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
        // Compute SHA256 checksum
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(savePath);
        stream.on('data', data => hash.update(data));
        stream.on('end', () => {
          const checksum = hash.digest('hex');
          event.sender.send('download-ue4-complete', savePath, checksum);
          shell.showItemInFolder(savePath);
        });
      });
    });
  }).on('error', (err) => {
    fs.unlink(savePath, () => {});
    event.sender.send('download-ue4-error', err.message);
  });
}); 