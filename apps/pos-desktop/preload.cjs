/* global require */
// eslint-disable-next-line @typescript-eslint/no-require-imports -- Sandboxed Electron preloads require CommonJS.
const { contextBridge, ipcRenderer } = require('electron');

function call(operation, key, value) {
  if (
    operation !== 'endSession' &&
    (typeof key !== 'string' ||
      key.length > 160 ||
      (operation === 'set' && (typeof value !== 'string' || value.length > 100000)))
  )
    throw new Error('STORAGE_UNAVAILABLE');
  // The synchronous acknowledgement is the controller's save-before-POST
  // barrier. Only this small journal API crosses the isolated context.
  const result = ipcRenderer.sendSync(
    'pickchick-pos:journal-v1',
    operation === 'endSession'
      ? { operation }
      : operation === 'get'
        ? { operation, key }
        : { operation, key, value },
  );
  if (!result || result.ok !== true) throw new Error('STORAGE_UNAVAILABLE');
  return result.value;
}
contextBridge.exposeInMainWorld('pickchickPosJournal', {
  getItem: (key) => call('get', key),
  setItem: (key, value) => {
    call('set', key, value);
  },
  endSession: () => {
    call('endSession');
  },
});

contextBridge.exposeInMainWorld('pickchickPosWindow', {
  isFullscreen: () => ipcRenderer.invoke('pickchick-pos:window-v1', 'state'),
  toggleFullscreen: () => ipcRenderer.invoke('pickchick-pos:window-v1', 'toggle'),
  onChange: (listener) => {
    if (typeof listener !== 'function') throw new TypeError('Expected listener');
    const receive = (_event, value) => {
      if (typeof value === 'boolean') listener(value);
    };
    ipcRenderer.on('pickchick-pos:fullscreen-v1', receive);
    return () => ipcRenderer.removeListener('pickchick-pos:fullscreen-v1', receive);
  },
});

// Tickets and the cash drawer (contracts section 5.8). Only plain JSON crosses: main validates the
// ticket and builds the paper. Each call is one attempt; the answer is
// {state:'sent'|'failed'|'unknown'|'not_configured'|'unsupported', code?}.
contextBridge.exposeInMainWorld('pickchickPosPrinter', {
  print: (ticket) => {
    let json;
    try {
      json = JSON.stringify(ticket);
    } catch {
      json = undefined;
    }
    if (typeof json !== 'string' || json.length > 32000)
      return Promise.resolve({ state: 'failed', code: 'INVALID_TICKET' });
    return ipcRenderer.invoke('pickchick-pos:printer-v1', {
      operation: 'print',
      ticket: JSON.parse(json),
    });
  },
  openDrawer: () => ipcRenderer.invoke('pickchick-pos:printer-v1', { operation: 'drawer' }),
});
