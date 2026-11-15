/* global require */
// eslint-disable-next-line @typescript-eslint/no-require-imports -- Sandboxed Electron preloads require CommonJS.
const { contextBridge, ipcRenderer } = require('electron');

// Only the full-screen switch crosses the isolated context; main checks the frame and origin.
contextBridge.exposeInMainWorld('pickchickKitchenWindow', {
  isFullscreen: () => ipcRenderer.invoke('pickchick-kitchen:window-v1', 'state'),
  toggleFullscreen: () => ipcRenderer.invoke('pickchick-kitchen:window-v1', 'toggle'),
  onChange: (listener) => {
    if (typeof listener !== 'function') throw new TypeError('Expected listener');
    const receive = (_event, value) => {
      if (typeof value === 'boolean') listener(value);
    };
    ipcRenderer.on('pickchick-kitchen:fullscreen-v1', receive);
    return () => ipcRenderer.removeListener('pickchick-kitchen:fullscreen-v1', receive);
  },
});
