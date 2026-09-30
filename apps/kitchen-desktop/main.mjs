import { app, BrowserWindow, Menu, session, dialog } from 'electron';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { APP_URL, isAllowedRendererRequest, startGateway, validateConfig } from './security.mjs';

app.enableSandbox();
app.setName('PickChick Kitchen');
const testProfile = !app.isPackaged ? process.env.PICKCHICK_KITCHEN_TEST_USER_DATA : undefined;
if (testProfile && !isAbsolute(testProfile))
  throw new Error('Test profile must be an absolute path');
app.setPath('userData', testProfile || join(app.getPath('appData'), 'PickChickKitchen'));
app.setAppUserModelId('kz.pickchick.kitchen');
const ownsInstance = app.requestSingleInstanceLock();
let window, gateway;
if (!ownsInstance) app.quit();
else {
  app.on('second-instance', () => {
    if (window?.isMinimized()) window.restore();
    window?.show();
    window?.focus();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    gateway?.closeAllConnections();
    gateway?.close();
  });
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
        if ((await stat(configPath)).size > 64000) throw new Error('INVALID_KITCHEN_CONFIG');
        config = JSON.parse(await readFile(configPath, 'utf8'));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      config = validateConfig(config);
      gateway = await startGateway({ config, assetDir: new URL('./renderer/', import.meta.url) });
      gateway.on('error', () => app.quit());
      const isolatedSession = session.fromPartition('persist:kitchen-v1');
      isolatedSession.setPermissionRequestHandler((_contents, _permission, callback) =>
        callback(false),
      );
      isolatedSession.setPermissionCheckHandler(() => false);
      isolatedSession.setDevicePermissionHandler(() => false);
      isolatedSession.setDisplayMediaRequestHandler((_request, callback) => callback({}));
      isolatedSession.on('will-download', (event) => event.preventDefault());
      isolatedSession.webRequest.onBeforeRequest((details, callback) =>
        callback({ cancel: !isAllowedRendererRequest(details.url, details.method) }),
      );
      Menu.setApplicationMenu(null);
      window = new BrowserWindow({
        width: 1366,
        height: 900,
        minWidth: 1024,
        minHeight: 600,
        title: 'PickChick Kitchen',
        backgroundColor: '#08224f',
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
      // Do not expose arbitrary config values or imported staff credentials.
      dialog.showErrorBox(
        'PickChick Kitchen',
        'Не удалось открыть кухню. Проверьте config.json в профиле PickChickKitchen и освободите локальный порт 4178. Журнал команд не удалён.',
      );
      app.quit();
    });
}
