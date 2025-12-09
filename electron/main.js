import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import path from 'path';
import { promises as fs } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function createWindow() {
  const preloadPath = path.join(__dirname, 'preload.js');
  try {
    const exists = fs.stat(preloadPath).then(() => true).catch(() => false);
    exists.then((ok) => console.log('main: preload path', preloadPath, 'exists=', ok));
  } catch (e) {
    console.warn('main: preload path check failed', e);
  }

  const win = new BrowserWindow({
    width: 1100,
    height: 800,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'src', 'ui', 'index.html'));
}

app.whenReady().then(createWindow);

ipcMain.handle('open-audio-file', async () => {
  console.log('main: open-audio-file handler invoked');
  const { canceled, filePaths } = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'Audio', extensions: ['wav', 'mp3', 'flac', 'm4a'] }],
  });
  if (canceled) return null;
  return filePaths[0];
});

ipcMain.handle('save-transcript', async (_, { filePath, text }) => {
  await fs.writeFile(filePath, text, 'utf8');
  return true;
});

ipcMain.handle('transcribe-file', async (_, filePath) => {
  try {
    // Import the compiled JS service module dynamically
    const svcPath = path.join(__dirname, '..', 'src', 'services', 'transcribe.js');
    const mod = await import(pathToFileURL(svcPath).href);
    if (!mod || !mod.transcribeFile) throw new Error('transcribe service not found');
    const text = await mod.transcribeFile(filePath);
    return { ok: true, text };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Simple streaming handlers that use the recording service
ipcMain.handle('stream-start', async (_, sessionId = 'default') => {
  try {
    const svcPath = path.join(__dirname, '..', 'src', 'services', 'recording.js');
    const rec = await import(pathToFileURL(svcPath).href);
    if (!rec || !rec.startSession) throw new Error('recording service not found');
    rec.startSession(sessionId);
    return { ok: true };
  } catch (err) {
    console.error('stream-start error', err);
    return { ok: false, error: String(err) };
  }
});

ipcMain.handle('stream-chunk', async (_, sessionId = 'default', arrayBuffer) => {
  try {
    const svcPath = path.join(__dirname, '..', 'src', 'services', 'recording.js');
    const rec = await import(pathToFileURL(svcPath).href);
    rec.pushChunk(sessionId, arrayBuffer);
    return { ok: true };
  } catch (err) {
    console.error('stream-chunk error', err);
    return { ok: false, error: String(err) };
  }
});

ipcMain.handle('stream-end', async (event, sessionId = 'default') => {
  try {
    const svcPath = path.join(__dirname, '..', 'src', 'services', 'recording.js');
    const rec = await import(pathToFileURL(svcPath).href);
    const text = await rec.endSession(sessionId);
    // notify renderer that transcription completed
    try {
      const win = BrowserWindow.getAllWindows()[0];
      if (win) win.webContents.send('transcription-result', sessionId, text);
    } catch (e) {
      console.warn('could not notify renderer', e);
    }
    return { ok: true, text };
  } catch (err) {
    console.error('stream-end error', err);
    return { ok: false, error: String(err) };
  }
});