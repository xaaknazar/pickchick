// Windows acceptance of the self-update (docs/operations/desktop-updates.md): the installed
// previous build finds a newer installer on a local feed, verifies it, installs it silently and
// comes back up as the new version. The installer itself makes the desktop shortcut and turns
// on autostart (owner, 12.11.2026); the self-update brings both back, and only a real uninstall
// removes them. Run by the Windows package workflows; never on a desk.
// node tests/desktop-update/self-update-win.mjs --app pos|kitchen --old <Setup A> --new <Setup B>
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { APPS, CHUNK_BYTES, parseManifest } from '../../apps/pos-desktop/updater.mjs';

const CLIENTS = {
  pos: { exe: 'PickChickPOS', profile: 'PickChickPOS', shortcut: 'PickChick POS' },
  kitchen: { exe: 'PickChickKitchen', profile: 'PickChickKitchen', shortcut: 'PickChick Kitchen' },
};
const args = {};
for (let i = 2; i < process.argv.length; i += 2)
  args[process.argv[i].slice(2)] = process.argv[i + 1];
assert.equal(process.platform, 'win32', 'Windows only');
assert.ok(Object.hasOwn(CLIENTS, args.app), '--app pos|kitchen');
const { exe, profile: profileName, shortcut } = CLIENTS[args.app];
const versionOf = (path) => {
  const match = new RegExp(`^${APPS[args.app]}(\\d+\\.\\d+\\.\\d+)-x64\\.exe$`).exec(
    basename(path),
  );
  assert.ok(match, 'installer name: ' + path);
  return match[1];
};
const oldVersion = versionOf(args.old);
const newVersion = versionOf(args.new);
assert.notEqual(oldVersion, newVersion);
const installed = join(process.env.LOCALAPPDATA, 'Programs', exe, exe + '.exe');
const profile = join(process.env.APPDATA, profileName);
const updates = join(profile, 'updates');
const log = (text) => console.log(`[${new Date().toISOString()}] ${text}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const powershell = (command) => {
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', command],
    {
      encoding: 'utf8',
    },
  );
  return result.status === 0 ? result.stdout.trim() : '';
};
// ProductVersion of the installed executable, without a fourth ".0" some builders add.
const installedVersion = () =>
  existsSync(installed)
    ? powershell(`(Get-Item -LiteralPath '${installed}').VersionInfo.ProductVersion`).replace(
        /^(\d+\.\d+\.\d+)\.0$/,
        '$1',
      )
    : '';
const leftovers = () => {
  try {
    return readdirSync(updates).filter((name) => name !== 'state.json');
  } catch {
    return [];
  }
};
const running = () =>
  Number(powershell(`@(Get-Process -Name '${exe}' -ErrorAction SilentlyContinue).Count`)) > 0;
const RUN = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
// The autostart value of this app ('' when there is none).
const autostart = () =>
  powershell(
    `$v=Get-ItemProperty -LiteralPath '${RUN}' -Name '${exe}' -ErrorAction SilentlyContinue; if($v){$v.'${exe}'}`,
  );
const desktopShortcut = () =>
  join(powershell(`[Environment]::GetFolderPath('Desktop')`), shortcut + '.lnk');
const shortcutTarget = () =>
  existsSync(desktopShortcut())
    ? powershell(
        `(New-Object -ComObject WScript.Shell).CreateShortcut('${desktopShortcut()}').TargetPath`,
      )
    : '';
const assertDesktopAndAutostart = (when) => {
  assert.equal(autostart(), `"${installed}"`, `${when}: autostart value`);
  assert.equal(
    shortcutTarget().toLowerCase(),
    installed.toLowerCase(),
    `${when}: desktop shortcut`,
  );
};
const state = () => {
  try {
    return JSON.parse(readFileSync(join(updates, 'state.json'), 'utf8'));
  } catch {
    return null;
  }
};

// 1. The previous build, installed the way a desk gets it.
log(`Installing ${basename(args.old)}`);
const setup = spawnSync(args.old, ['/S'], { stdio: 'ignore' });
assert.equal(setup.status, 0, 'previous installer exit code');
assert.equal(installedVersion(), oldVersion, 'previous version installed');
assertDesktopAndAutostart('after the first install');
log(`Desktop shortcut and autostart are in place; removing both before the self-update`);
rmSync(desktopShortcut());
powershell(`Remove-ItemProperty -LiteralPath '${RUN}' -Name '${exe}'`);
assert.equal(autostart(), '', 'autostart value removed for the check');

// 2. A local feed with the next build, laid out by the release script.
const feed = await mkdtemp(join(tmpdir(), 'pickchick-feed-'));
const layout = spawnSync(
  process.execPath,
  ['scripts/desktop-update-feed.mjs', '--app', args.app, '--installer', args.new, '--out', feed],
  { encoding: 'utf8' },
);
assert.equal(layout.status, 0, layout.stderr);
const manifest = parseManifest(readFileSync(join(feed, args.app, 'latest.json'), 'utf8'), args.app);
assert.equal(manifest.version, newVersion);
const requests = [];
// Like the gateway: GET of the two known files only, the installer in ranges.
const server = createServer((request, response) => {
  const name = request.url.replace(/^\/+/, '');
  const known = [`${args.app}/latest.json`, `${args.app}/${manifest.file}`].includes(name);
  const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? '');
  const status = request.method !== 'GET' || !known ? 404 : range ? 206 : 200;
  requests.push(`${request.method} ${request.url} ${status}`);
  if (status === 404) {
    response.writeHead(404).end();
    return;
  }
  const path = join(feed, ...name.split('/'));
  const size = statSync(path).size;
  if (!range) {
    response.writeHead(200, { 'content-length': size });
    createReadStream(path).pipe(response);
    return;
  }
  const start = Number(range[1]);
  const end = Math.min(Number(range[2]), size - 1);
  if (start > end) {
    response.writeHead(416).end();
    return;
  }
  response.writeHead(206, {
    'content-length': end - start + 1,
    'content-range': `bytes ${start}-${end}/${size}`,
  });
  createReadStream(path, { start, end }).pipe(response);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = `http://127.0.0.1:${server.address().port}/`;

// 3. This desk reads updates from the stand feed, then the previous build is opened.
mkdirSync(profile, { recursive: true });
writeFileSync(join(profile, 'update.json'), JSON.stringify({ feed: address }) + '\n');
log(`Starting ${exe} ${oldVersion} with feed ${address}`);
spawn(installed, [], { detached: true, stdio: 'ignore' }).unref();

// 4. Without anyone touching the desk it becomes the next build and is running again.
const deadline = Date.now() + 8 * 60 * 1000;
let seen = '';
let done = false;
while (Date.now() < deadline) {
  await sleep(3000);
  const snapshot = JSON.stringify({
    version: installedVersion(),
    running: running(),
    result: state()?.last?.result ?? null,
    staged: state()?.staged?.version ?? null,
    current: state()?.last?.current ?? null,
    leftovers: leftovers().length,
    requests: requests.length,
  });
  if (snapshot !== seen) log(snapshot);
  seen = snapshot;
  const now = JSON.parse(snapshot);
  if (
    now.version === newVersion &&
    now.running &&
    now.result === 'current' &&
    now.staged === null &&
    now.current === newVersion &&
    now.leftovers === 0
  ) {
    done = true;
    break;
  }
}
log('Feed requests: ' + JSON.stringify([...new Set(requests)]) + ` (${requests.length} in all)`);
powershell(`Get-Process -Name '${exe}' -ErrorAction SilentlyContinue | Stop-Process -Force`);
server.closeAllConnections();
server.close();
assert.ok(done, `the desk did not become ${newVersion}: ${seen}`);
assert.ok(requests.includes(`GET /${args.app}/latest.json 200`), 'manifest was read');
const pieces = requests.filter((line) => line === `GET /${args.app}/${manifest.file} 206`).length;
assert.equal(pieces, Math.ceil(manifest.bytes / CHUNK_BYTES), 'installer was read in pieces');
assert.ok(
  requests.every((line) => / 20[06]$/.test(line)),
  'nothing but the manifest and the installer was requested',
);
assert.deepEqual(leftovers(), [], 'the new version removed the used installer');
assertDesktopAndAutostart('after the self-update');
log(`OK: ${exe} ${oldVersion} updated itself to ${newVersion} and is running.`);

// 4. A real uninstall removes the program, its desktop shortcut and its autostart value.
const directory = dirname(installed);
const uninstaller = readdirSync(directory).find((name) => /^Uninstall .+\.exe$/.test(name));
assert.ok(uninstaller, 'uninstaller next to the program');
assert.equal(spawnSync(join(directory, uninstaller), ['/S'], { stdio: 'ignore' }).status, 0);
// The NSIS uninstaller runs on from a copy of itself: wait for it to finish.
for (let i = 0; i < 120 && (existsSync(installed) || autostart() !== ''); i += 1) await sleep(1000);
assert.ok(!existsSync(installed), 'uninstalled');
assert.equal(autostart(), '', 'uninstall removed the autostart value');
assert.ok(!existsSync(desktopShortcut()), 'uninstall removed the desktop shortcut');
log(`OK: uninstall removed ${exe}, its desktop shortcut and its autostart value.`);
