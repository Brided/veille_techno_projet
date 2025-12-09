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
    startStream: (sessionId) => {
      console.debug('preload: startStream', sessionId);
      return ipcRenderer.invoke('stream-start', sessionId);
    },
    sendStreamChunk: (sessionId, arrayBuffer) => {
      // arrayBuffer should be transferable
      console.debug('preload: sendStreamChunk', sessionId, arrayBuffer && arrayBuffer.byteLength);
      return ipcRenderer.invoke('stream-chunk', sessionId, arrayBuffer);
    },
    endStream: (sessionId) => {
      console.debug('preload: endStream', sessionId);
      return ipcRenderer.invoke('stream-end', sessionId);
    },
    onTranscription: (cb) => {
      console.debug('preload: onTranscription registered');
      ipcRenderer.on('transcription-result', (_, sessionId, text) => cb(sessionId, text));
    }
  });
} catch (err) {
  console.error('preload: failed to initialize', err);
  throw err;
}