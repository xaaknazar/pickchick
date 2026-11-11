import { app, BrowserWindow, Menu, session, dialog, safeStorage, net } from 'electron';
import { spawn } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { clearInterval, setInterval } from 'node:timers';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_URL, isAllowedRendererRequest, startGateway, validateConfig } from './security.mjs';
import { createUpdater, readFeed } from './updater.mjs';

app.enableSandbox();
app.setName('PickChick Kitchen');
const testProfile = !app.isPackaged ? process.env.PICKCHICK_KITCHEN_TEST_USER_DATA : undefined;
if (testProfile && !isAbsolute(testProfile))
  throw new Error('Test profile must be an absolute path');
app.setPath('userData', testProfile || join(app.getPath('appData'), 'PickChickKitchen'));
app.setAppUserModelId('kz.pickchick.kitchen');
const ownsInstance = app.requestSingleInstanceLock();
let window, gateway;
// What stands in the window title: the build and the address the point server knows this
// device by (docs/operations/lan-clients.md), so that nobody has to look it up in Windows.
function windowTitle() {
  const addresses = Object.values(networkInterfaces())
    .flat()
    .filter(
      (entry) =>
        entry?.family === 'IPv4' && !entry.internal && !entry.address.startsWith('169.254.'),
    )
    .map((entry) => entry.address)
    .slice(0, 2);
  return (
    `PickChick Kitchen ${app.getVersion()} · ` +
    (addresses.length ? `адрес моноблока ${addresses.join(', ')}` : 'нет сети')
  );
}
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
      // Self-update (docs/operations/desktop-updates.md): the installed Windows build with a
      // feed only. Nothing here may stop the screen from opening.
      let updater = null;
      try {
        const feed =
          app.isPackaged && process.platform === 'win32' && !process.env.PORTABLE_EXECUTABLE_FILE
            ? readFeed({
                packagedPath: fileURLToPath(new URL('./update-feed.json', import.meta.url)),
                overridePath: join(profile, 'update.json'),
              })
            : null;
        if (feed)
          updater = createUpdater({
            app: 'kitchen',
            currentVersion: app.getVersion(),
            feed,
            directory: join(profile, 'updates'),
            fetchImpl: (url, init) => net.fetch(url, init),
            spawnImpl: spawn,
            quit: () => app.quit(),
          });
        // An installer verified during the previous run goes in before the screen opens.
        if (updater && (await updater.apply())) return;
      } catch {
        updater = null;
      }
      let terminalKey;
      if (config.terminalMode) {
        if (!safeStorage.isEncryptionAvailable()) throw new Error('PRIVATE_STORAGE_UNAVAILABLE');
        const path = join(profile, 'terminal-cookie-key.encrypted');
        let encrypted;
        try {
          encrypted = await readFile(path);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          encrypted = safeStorage.encryptString(randomBytes(32).toString('hex'));
          await writeFile(path, encrypted, { flag: 'wx', mode: 0o600 });
        }
        terminalKey = safeStorage.decryptString(encrypted);
        if (!/^[a-f0-9]{64}$/.test(terminalKey)) throw new Error('PRIVATE_STORAGE_INVALID');
      }
      gateway = await startGateway({
        config,
        terminalKey,
        assetDir: new URL('./renderer/', import.meta.url),
      });
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
        title: windowTitle(),
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
      // The guest board (paired as display) fills its screen; staff screens stay maximized windows.
      const board = config.terminalMode === 'display';
      window.once('ready-to-show', () => {
        if (board) window.setFullScreen(true);
        else window.maximize();
        window.show();
      });
      window.on('close', () => isolatedSession.flushStorageData());
      // The page does not rename the window; the address follows the network.
      window.on('page-title-updated', (event) => event.preventDefault());
      const retitle = setInterval(() => window.setTitle(windowTitle()), 30000);
      window.on('closed', () => clearInterval(retitle));
      await window.loadURL(APP_URL);
      updater?.start();
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
