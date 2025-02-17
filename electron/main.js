import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { autoUpdater } from 'electron-updater';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = process.env.NODE_ENV === 'development';

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    icon: path.join(__dirname, 'icons', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    show: false, // Don't show the window until it's ready
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  // Show window when ready
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    checkForUpdates();
  });

  // Handle window state
  let windowState = {
    bounds: mainWindow.getBounds()
  };

  mainWindow.on('close', () => {
    windowState.bounds = mainWindow.getBounds();
    fs.writeFileSync(
      path.join(app.getPath('userData'), 'window-state.json'),
      JSON.stringify(windowState)
    );
  });
}

function checkForUpdates() {
  if (!isDev) {
    autoUpdater.checkForUpdates();
  }
}

// Restore window state
function restoreWindowState() {
  let windowState;
  try {
    windowState = JSON.parse(
      fs.readFileSync(path.join(app.getPath('userData'), 'window-state.json'), 'utf8')
    );
  } catch (e) {
    // File doesn't exist or is corrupt
    return null;
  }
  return windowState;
}

app.whenReady().then(() => {
  createWindow();

  // Set up auto-update check interval (every 4 hours)
  setInterval(checkForUpdates, 4 * 60 * 60 * 1000);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// Auto-updater events
autoUpdater.on('checking-for-update', () => {
  mainWindow?.webContents.send('update-status', 'Verificando atualizações...');
});

autoUpdater.on('update-available', (info) => {
  dialog.showMessageBox({
    type: 'info',
    title: 'Atualização Disponível',
    message: `Uma nova versão do ConvertaTXT (${info.version}) está disponível. A atualização será baixada automaticamente.`,
    buttons: ['OK']
  });
  mainWindow?.webContents.send('update-status', 'Baixando atualização...');
});

autoUpdater.on('update-not-available', () => {
  mainWindow?.webContents.send('update-status', 'Aplicativo atualizado');
});

autoUpdater.on('error', (err) => {
  mainWindow?.webContents.send('update-status', 'Erro na atualização');
  dialog.showErrorBox(
    'Erro na Atualização',
    'Ocorreu um erro ao verificar por atualizações: ' + err.message
  );
});

autoUpdater.on('download-progress', (progressObj) => {
  mainWindow?.webContents.send(
    'update-status',
    `Baixando: ${progressObj.percent.toFixed(2)}%`
  );
});

autoUpdater.on('update-downloaded', (info) => {
  mainWindow?.webContents.send('update-status', 'Atualização pronta para instalar');
  dialog.showMessageBox({
    type: 'info',
    title: 'Atualização Pronta',
    message: `A atualização para a versão ${info.version} foi baixada e será instalada ao reiniciar o aplicativo.`,
    buttons: ['Reiniciar Agora', 'Mais Tarde']
  }).then((buttonIndex) => {
    if (buttonIndex.response === 0) {
      autoUpdater.quitAndInstall();
    }
  });
});