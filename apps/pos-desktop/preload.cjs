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
