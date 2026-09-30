import { app, BrowserWindow, Menu, protocol, session, dialog, ipcMain } from 'electron';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJournalStore } from './journal.mjs';
import {
  APP_URL,
  createProtocolHandler,
  isAllowedRendererURL,
  validateConfig,
} from './protocol.mjs';

// This origin and profile are part of the existing POS journal's storage identity.
// They must not depend on the app version, installation path, or a random port.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'pickchick-pos',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);
app.enableSandbox();
app.setName('PickChick POS');
const testDataDir = !app.isPackaged ? process.env.PICKCHICK_POS_TEST_USER_DATA : undefined;
if (testDataDir && !isAbsolute(testDataDir))
  throw new Error('Test profile must be an absolute path');
app.setPath('userData', testDataDir || join(app.getPath('appData'), 'PickChickPOS'));
app.setAppUserModelId('kz.pickchick.pos');
const ownsInstance = app.requestSingleInstanceLock();
let window;
let fullscreenChange;
function toggleFullscreen() {
  if (fullscreenChange) return fullscreenChange;
  const target = !window.isFullScreen();
  const event = target ? 'enter-full-screen' : 'leave-full-screen';
  fullscreenChange = new Promise((resolve, reject) => {
    const done = () => {
      clearTimeout(timeout);
      resolve(window.isFullScreen());
    };
    const timeout = setTimeout(() => {
      window.removeListener(event, done);
      reject(new Error('WINDOW_CONTROL_UNAVAILABLE'));
    }, 10000);
    window.once(event, done);
    window.setFullScreen(target);
  }).finally(() => {
    fullscreenChange = null;
  });
  return fullscreenChange;
}
if (!ownsInstance) app.quit();
else {
  app.on('second-instance', () => {
    if (window?.isMinimized()) window.restore();
    window?.show();
    window?.focus();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (event) => event.preventDefault());
    contents.on('will-frame-navigate', (event) => event.preventDefault());
    contents.on('will-redirect', (event) => event.preventDefault());
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });
  app
    .whenReady()
    .then(async () => {
      const profile = app.getPath('userData');
      await mkdir(profile, { recursive: true });
      const configPath = join(profile, 'config.json');
      let config = {};
      try {
        if ((await stat(configPath)).size > 64000) throw new Error('INVALID_POS_CONFIG');
        config = JSON.parse(await readFile(configPath, 'utf8'));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      config = validateConfig(config);
      const journal = createJournalStore({ directory: join(profile, 'journal-v1') });
      ipcMain.handle('pickchick-pos:window-v1', (event, operation) => {
        if (
          !window ||
          window.isDestroyed() ||
          event.sender !== window.webContents ||
          event.senderFrame !== window.webContents.mainFrame ||
          event.senderFrame.url !== APP_URL ||
          !['state', 'toggle'].includes(operation)
        )
          throw new Error('WINDOW_CONTROL_UNAVAILABLE');
        if (operation === 'toggle') return toggleFullscreen();
        return window.isFullScreen();
      });
      ipcMain.on('pickchick-pos:journal-v1', (event, message) => {
        try {
          if (
            !window ||
            event.sender !== window.webContents ||
            event.senderFrame !== window.webContents.mainFrame ||
            event.senderFrame.url !== APP_URL ||
            !message ||
            typeof message !== 'object' ||
            Array.isArray(message)
          )
            throw new Error('STORAGE_UNAVAILABLE');
          const keys = Object.keys(message);
          if (message.operation === 'endSession' && keys.length === 1) {
            journal.setSession(null);
            event.returnValue = { ok: true, value: null };
          } else if (message.operation === 'get' && keys.length === 2 && keys.includes('key'))
            event.returnValue = { ok: true, value: journal.getItem(message.key) };
          else if (
            message.operation === 'set' &&
            keys.length === 3 &&
            keys.includes('key') &&
            keys.includes('value')
          ) {
            journal.setItem(message.key, message.value);
            event.returnValue = { ok: true, value: null };
          } else throw new Error('STORAGE_UNAVAILABLE');
        } catch {
          event.returnValue = { ok: false };
        }
      });
      const isolatedSession = session.fromPartition('persist:pos-v1');
      isolatedSession.setPermissionRequestHandler((_contents, _permission, callback) =>
        callback(false),
      );
      isolatedSession.setPermissionCheckHandler(() => false);
      isolatedSession.setDevicePermissionHandler(() => false);
      isolatedSession.setDisplayMediaRequestHandler((_request, callback) => callback({}));
      isolatedSession.on('will-download', (event) => event.preventDefault());
      isolatedSession.webRequest.onBeforeRequest((details, callback) =>
        callback({ cancel: !isAllowedRendererURL(details.url) }),
      );
      isolatedSession.protocol.handle(
        'pickchick-pos',
        createProtocolHandler({
          assetDir: new URL('./renderer/', import.meta.url),
          config,
          onSession: (value, sessionId) => journal.setSession(value, sessionId),
        }),
      );
      Menu.setApplicationMenu(null);
      window = new BrowserWindow({
        width: 1366,
        height: 900,
        minWidth: 1024,
        minHeight: 600,
        title: 'PickChick POS',
        backgroundColor: '#0b1d42',
        show: false,
        autoHideMenuBar: true,
        fullscreenable: true,
        fullscreen: process.platform === 'win32',
        webPreferences: {
          session: isolatedSession,
          preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)),
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          nodeIntegrationInWorker: false,
          nodeIntegrationInSubFrames: false,
          webSecurity: true,
          allowRunningInsecureContent: false,
          webviewTag: false,
          experimentalFeatures: false,
          navigateOnDragDrop: false,
          devTools: !app.isPackaged,
        },
      });
      window.once('ready-to-show', () => {
        if (process.platform !== 'win32' && !window.isFullScreen()) window.maximize();
        window.show();
        // Apply after showing as well: older Windows may defer the initial window state.
        if (process.platform === 'win32') window.setFullScreen(true);
      });
      for (const event of ['enter-full-screen', 'leave-full-screen']) {
        window.on(event, () => {
          window.webContents.send('pickchick-pos:fullscreen-v1', window.isFullScreen());
        });
      }
      window.webContents.on('before-input-event', (event, input) => {
        if (input.type === 'keyDown' && input.key === 'F11' && !input.isAutoRepeat) {
          event.preventDefault();
          void toggleFullscreen().catch(() => {});
        }
      });
      window.webContents.on('did-navigate', () => journal.setSession(null));
      window.webContents.on('render-process-gone', () => journal.setSession(null));
      window.on('close', () => isolatedSession.flushStorageData());
      await window.loadURL(APP_URL);
    })
    .catch(() => {
      // Never put credentials or arbitrary configuration contents in the error dialog.
      dialog.showErrorBox(
        'PickChick POS',
        'Не удалось открыть локальную кассу. Проверьте установку и config.json в профиле PickChickPOS. Локальный журнал не удалён.',
      );
      app.quit();
    });
}
