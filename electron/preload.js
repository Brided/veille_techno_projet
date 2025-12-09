// electron/preload.js (ESM)
const { contextBridge, ipcRenderer } = require('electron');

try {
  console.debug('preload: loaded (cjs)');
  contextBridge.exposeInMainWorld('electronAPI', {
    openAudioFile: () => {
      console.debug('preload: openAudioFile invoked');
      return ipcRenderer.invoke('open-audio-file');
    },
    saveTranscript: (filePath, text) => {
      console.debug('preload: saveTranscript invoked', filePath);
      return ipcRenderer.invoke('save-transcript', { filePath, text });
    },
    transcribeFile: (filePath) => {
      console.debug('preload: transcribeFile invoked', filePath);
      return ipcRenderer.invoke('transcribe-file', filePath);
    },
  });
} catch (err) {
  console.error('preload: failed to initialize', err);
  throw err;
}