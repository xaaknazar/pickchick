import { app, BrowserWindow, Menu, protocol, session, dialog } from 'electron';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
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
        createProtocolHandler({ assetDir: new URL('./renderer/', import.meta.url), config }),
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
        webPreferences: {
          session: isolatedSession,
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
        window.maximize();
        window.show();
      });
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
