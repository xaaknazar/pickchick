/* global require */
// eslint-disable-next-line @typescript-eslint/no-require-imports -- Sandboxed Electron preloads require CommonJS.
const { contextBridge, ipcRenderer } = require('electron');

// The customer display only listens: main sends the validated view, nothing goes back.
contextBridge.exposeInMainWorld('pickchickCustomer', {
  onView: (listener) => {
    if (typeof listener !== 'function') throw new TypeError('Expected listener');
    ipcRenderer.on('pickchick-pos-customer:view-v1', (_event, view) => {
      if (view && typeof view === 'object') listener(view);
    });
    ipcRenderer.send('pickchick-pos-customer:ready-v1');
  },
});
