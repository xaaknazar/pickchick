import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  APPS,
  CHECK_INTERVAL_MS,
  FIRST_CHECK_MS,
  MAX_ATTEMPTS,
  MAX_INSTALLER_BYTES,
  STARTUP_WINDOW_MS,
  compareVersions,
  createUpdater,
  parseFeedFile,
  parseManifest,
  readFeed,
  validateFeed,
} from '../../apps/pos-desktop/updater.mjs';
import { createJournalStore, journalsSettled } from '../../apps/pos-desktop/journal.mjs';
import { writeFeed } from '../../scripts/desktop-update-feed.mjs';

const root = new URL('../../', import.meta.url);
// A Windows checkout may hold CRLF; the rules are about the text.
const text = (path) => readFileSync(new URL(path, root), 'utf8').replaceAll('\r\n', '\n');
const sha = (data) => createHash('sha256').update(data).digest('hex');
const FEED = 'https://updates.example.kz/desktop/';
const installer = Buffer.alloc(1_200_000, 7);
const manifest = (overrides = {}) => ({
  app: 'pos',
  version: '0.5.1',
  file: 'PickChick-POS-Setup-0.5.1-x64.exe',
  sha256: sha(installer),
  bytes: installer.byteLength,
  ...overrides,
});
/** Local noon and local 04:00 of one day, whatever the time zone of the machine. */
const NOON = new Date(2026, 10, 20, 12, 0, 0).getTime();
const NIGHT = new Date(2026, 10, 21, 4, 0, 0).getTime();

async function fixture(run, options = {}) {
  const directory = join(await mkdtemp(join(tmpdir(), 'pickchick-updater-')), 'updates');
  const state = {
    clock: options.clock ?? NOON,
    files: { 'pos/latest.json': JSON.stringify(manifest()), [`pos/${manifest().file}`]: installer },
    requests: [],
    spawned: [],
    quits: 0,
    safe: true,
    spawnFails: false,
    // Feed server behaviour: no Range support, or a connection cut after this many body bytes.
    noRange: false,
    cutAfter: null,
  };
  const updater = createUpdater({
    app: 'pos',
    currentVersion: options.currentVersion ?? '0.5.0',
    feed: FEED,
    directory,
    now: () => state.clock,
    canApply: () => state.safe,
    chunkBytes: 500_000,
    quit: () => {
      state.quits += 1;
    },
    fetchImpl: async (url, init) => {
      state.requests.push({ url, init });
      assert.equal(init.redirect, 'error');
      assert.equal(init.credentials, 'omit');
      assert.equal(init.cache, 'no-store');
      assert.ok(init.signal instanceof AbortSignal);
      const name = url.slice(FEED.length);
      if (!url.startsWith(FEED) || !Object.hasOwn(state.files, name))
        return new Response('missing', { status: 404 });
      const file = Buffer.from(state.files[name]);
      const range = /^bytes=(\d+)-(\d+)$/.exec(init.headers.range ?? '');
      assert.equal(Boolean(range), name.endsWith('.exe'), 'only the installer is read in pieces');
      let body = file;
      let answer = { status: 200 };
      if (range && !state.noRange) {
        const first = Number(range[1]);
        if (first >= file.byteLength) return new Response('range', { status: 416 });
        const last = Math.min(Number(range[2]), file.byteLength - 1);
        body = file.subarray(first, last + 1);
        answer = {
          status: 206,
          headers: { 'content-range': `bytes ${first}-${last}/${file.byteLength}` },
        };
      }
      if (range && state.cutAfter !== null) {
        // The link drops: the client gets only the first bytes of this answer.
        body = body.subarray(0, state.cutAfter);
        state.cutAfter = null;
      }
      return new Response(body, answer);
    },
    spawnImpl: (file, args, spawnOptions) => {
      state.spawned.push({ file, args, options: spawnOptions });
      const child = new EventEmitter();
      child.unref = () => {};
      setTimeout(() =>
        state.spawnFails ? child.emit('error', new Error('EACCES')) : child.emit('spawn'),
      );
      return child;
    },
  });
  const read = () => JSON.parse(readFileSync(join(directory, 'state.json'), 'utf8'));
  try {
    await run({ updater, state, directory, read });
  } finally {
    updater.stop();
    await rm(join(directory, '..'), { recursive: true, force: true });
  }
}

test('both desktop clients ship the same updater and the same feed address', () => {
  assert.equal(
    text('apps/pos-desktop/updater.mjs'),
    text('apps/kitchen-desktop/updater.mjs'),
    'updater.mjs must be identical in pos-desktop and kitchen-desktop',
  );
  for (const app of ['pos-desktop', 'kitchen-desktop']) {
    const feed = text(`apps/${app}/update-feed.json`);
    assert.equal(feed, text('apps/pos-desktop/update-feed.json'));
    // Valid, and either off or an HTTPS address: the stand address never ships.
    const value = parseFeedFile(feed);
    assert.ok(value === null || value.startsWith('https://'), 'packaged feed');
    assert.match(text(`apps/${app}/electron-builder.yml`), /^ {2}- updater\.mjs$/m);
    assert.match(text(`apps/${app}/electron-builder.yml`), /^ {2}- update-feed\.json$/m);
    // The installer names the updater expects are the ones electron-builder writes.
    const name = app === 'pos-desktop' ? 'pos' : 'kitchen';
    assert.ok(
      text(`apps/${app}/electron-builder.yml`).includes(
        `nsis:\n  artifactName: ${APPS[name]}\${version}-\${arch}.\${ext}\n`,
      ),
      `${app} installer name`,
    );
    const main = text(`apps/${app}/main.mjs`);
    assert.match(main, new RegExp(`app: '${name}',`));
    assert.match(
      main,
      /app\.isPackaged && process\.platform === 'win32' && !process\.env\.PORTABLE_EXECUTABLE_FILE/,
    );
  }
  assert.match(
    text('apps/pos-desktop/main.mjs'),
    /canApply: \(\) => !journal\.hasSession\(\) && journalsSettled\(join\(profile, 'journal-v1'\)\),/,
  );
});

test('versions compare as numbers and nothing but x.y.z is a version', () => {
  assert.ok(compareVersions('0.5.1', '0.5.0') > 0);
  assert.ok(compareVersions('0.10.0', '0.9.9') > 0);
  assert.ok(compareVersions('1.0.0', '0.99.99') > 0);
  assert.equal(compareVersions('0.5.0', '0.5.0'), 0);
  assert.ok(compareVersions('0.4.8', '0.5.0') < 0);
  for (const bad of ['0.5', '0.5.0-rc1', '00.5.0', 'v0.5.0', '', null, 5, '0.5.0.1', '0.5.00000'])
    assert.throws(() => compareVersions(bad, '0.5.0'), /UPDATE_VERSION_INVALID/);
});

test('a feed is an HTTPS directory without port, credentials, query or traversal', () => {
  assert.equal(validateFeed(null), null);
  assert.equal(validateFeed(undefined), null);
  for (const good of [
    FEED,
    'https://api.pickchick.kz/',
    'https://api.pickchick.kz/updates/v1/',
    'http://127.0.0.1:8123/',
    'http://127.0.0.1:8123/feed/',
  ])
    assert.equal(validateFeed(good), good);
  for (const bad of [
    '',
    'updates.example.kz/desktop/',
    'http://updates.example.kz/desktop/',
    'https://updates.example.kz/desktop',
    'https://updates.example.kz:8443/desktop/',
    'https://user:secret@updates.example.kz/desktop/',
    'https://updates.example.kz/desktop/?token=1',
    'https://updates.example.kz/desktop/#x',
    'https://updates.example.kz/../desktop/',
    'https://updates.example.kz/a/./b/',
    'https://updates.example.kz//desktop/',
    'https://UPDATES.example.kz/desktop/',
    'https://192.168.2.69/desktop/',
    'https://localhost/desktop/',
    'http://localhost:8123/',
    'http://127.0.0.1/',
    'http://127.0.0.2:8123/',
    'http://192.168.2.69:8123/',
    'file:///C:/updates/',
    'ftp://updates.example.kz/desktop/',
    'https://updates.example.kz/' + 'a'.repeat(200) + '/',
    42,
    {},
  ])
    assert.throws(() => validateFeed(bad), /UPDATE_FEED_INVALID/, String(bad));
  assert.equal(parseFeedFile('{ "feed": null }\n'), null);
  assert.equal(parseFeedFile(JSON.stringify({ feed: FEED })), FEED);
  for (const bad of ['', '[]', 'null', '{}', '{"feed":null,"x":1}', '{"url":"' + FEED + '"}'])
    assert.throws(() => parseFeedFile(bad), /UPDATE_FEED_INVALID/);
});

test('the profile file wins over the packaged feed and a broken file switches updates off', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pickchick-feed-'));
  const packagedPath = join(directory, 'update-feed.json');
  const overridePath = join(directory, 'update.json');
  try {
    assert.equal(readFeed({ packagedPath, overridePath }), null);
    writeFileSync(packagedPath, JSON.stringify({ feed: FEED }));
    assert.equal(readFeed({ packagedPath, overridePath }), FEED);
    writeFileSync(overridePath, JSON.stringify({ feed: 'http://127.0.0.1:8123/' }));
    assert.equal(readFeed({ packagedPath, overridePath }), 'http://127.0.0.1:8123/');
    writeFileSync(overridePath, JSON.stringify({ feed: null }));
    assert.equal(readFeed({ packagedPath, overridePath }), null, 'a device can opt out');
    writeFileSync(overridePath, '{ "feed": "http://evil.example/" }');
    assert.equal(readFeed({ packagedPath, overridePath }), null, 'never falls back silently');
    writeFileSync(overridePath, 'not json');
    assert.equal(readFeed({ packagedPath, overridePath }), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a manifest names exactly one installer of its own application', () => {
  assert.deepEqual(parseManifest(JSON.stringify(manifest()), 'pos'), {
    ...manifest(),
    apply: 'idle',
  });
  assert.equal(parseManifest(JSON.stringify(manifest({ apply: 'now' })), 'pos').apply, 'now');
  const kitchen = manifest({
    app: 'kitchen',
    version: '0.4.1',
    file: 'PickChick-Kitchen-Setup-0.4.1-x64.exe',
  });
  assert.equal(parseManifest(JSON.stringify(kitchen), 'kitchen').version, '0.4.1');
  for (const [name, bad] of [
    ['other app', kitchen],
    ['file of another version', manifest({ file: 'PickChick-POS-Setup-0.5.2-x64.exe' })],
    ['path in file', manifest({ file: '../PickChick-POS-Setup-0.5.1-x64.exe' })],
    ['url in file', manifest({ file: 'https://evil.example/PickChick-POS-Setup-0.5.1-x64.exe' })],
    ['portable', manifest({ file: 'PickChick-POS-Portable-0.5.1-x64.exe' })],
    ['uppercase hash', manifest({ sha256: sha(installer).toUpperCase() })],
    ['short hash', manifest({ sha256: 'abc' })],
    ['tiny', manifest({ bytes: 10 })],
    ['huge', manifest({ bytes: MAX_INSTALLER_BYTES + 1 })],
    ['text size', manifest({ bytes: '1200000' })],
    [
      'prerelease',
      manifest({ version: '0.5.1-rc1', file: 'PickChick-POS-Setup-0.5.1-rc1-x64.exe' }),
    ],
    ['unknown apply', manifest({ apply: 'force' })],
    ['extra key', manifest({ url: 'https://evil.example/' })],
    ['arguments', manifest({ args: ['/D=C:\\'] })],
  ])
    assert.throws(() => parseManifest(JSON.stringify(bad), 'pos'), /UPDATE_MANIFEST_INVALID/, name);
  for (const bad of ['', 'null', '[]', '"x"', 'x'.repeat(5000)])
    assert.throws(() => parseManifest(bad, 'pos'), /UPDATE_MANIFEST_INVALID/);
  assert.throws(
    () => parseManifest(JSON.stringify(manifest()), 'backoffice'),
    /UPDATE_APP_INVALID/,
  );
});

test('a newer version is downloaded, verified and installed silently, then the program closes', async () => {
  await fixture(async ({ updater, state, directory, read }) => {
    assert.equal(await updater.apply(), false, 'nothing staged yet');
    assert.equal(await updater.check(), 'staged');
    assert.deepEqual(
      state.requests.map((request) => [request.url.slice(FEED.length), request.init.headers.range]),
      [
        ['pos/latest.json', undefined],
        ['pos/PickChick-POS-Setup-0.5.1-x64.exe', 'bytes=0-499999'],
        ['pos/PickChick-POS-Setup-0.5.1-x64.exe', 'bytes=500000-999999'],
        ['pos/PickChick-POS-Setup-0.5.1-x64.exe', 'bytes=1000000-1199999'],
      ],
    );
    assert.deepEqual(readdirSync(directory).sort(), [
      'PickChick-POS-Setup-0.5.1-x64.exe',
      'state.json',
    ]);
    assert.deepEqual(read().staged, { ...manifest(), apply: 'idle', attempts: 0 });
    assert.equal(read().last.result, 'staged');
    assert.equal(read().last.current, '0.5.0');
    // Checked again: the verified file is kept, not downloaded twice.
    assert.equal(await updater.check(), 'staged');
    assert.equal(state.requests.length, 5);
    assert.equal(await updater.apply(), true);
    assert.equal(state.quits, 1);
    assert.deepEqual(state.spawned, [
      {
        file: join(directory, 'PickChick-POS-Setup-0.5.1-x64.exe'),
        args: ['--updated', '/S', '--force-run'],
        options: { detached: true, stdio: 'ignore' },
      },
    ]);
    assert.equal(read().staged.attempts, 1);
    assert.equal(read().last.result, 'installing');
  });
});

test('the same or an older published version changes nothing and recalls a staged one', async () => {
  await fixture(async ({ updater, state, directory, read }) => {
    state.files['pos/latest.json'] = JSON.stringify(
      manifest({ version: '0.5.0', file: 'PickChick-POS-Setup-0.5.0-x64.exe' }),
    );
    assert.equal(await updater.check(), 'current');
    assert.equal(state.requests.length, 1, 'no download');
    assert.equal(await updater.apply(), false);
    state.files['pos/latest.json'] = JSON.stringify(manifest());
    assert.equal(await updater.check(), 'staged');
    // The release is withdrawn before it was installed.
    state.files['pos/latest.json'] = JSON.stringify(
      manifest({ version: '0.4.8', file: 'PickChick-POS-Setup-0.4.8-x64.exe' }),
    );
    assert.equal(await updater.check(), 'current');
    assert.deepEqual(readdirSync(directory), ['state.json']);
    assert.equal(read().staged, null);
    assert.equal(await updater.apply(), false);
    assert.equal(state.spawned.length, 0);
  });
});

test('a file that differs from the manifest is never kept or started', async () => {
  for (const [name, change, code] of [
    [
      'other bytes',
      (s) => (s.files[`pos/${manifest().file}`] = Buffer.alloc(1_200_000, 8)),
      'UPDATE_FILE_MISMATCH',
    ],
    [
      'shorter',
      (s) => (s.files[`pos/${manifest().file}`] = installer.subarray(0, 1_100_000)),
      'UPDATE_FILE_MISMATCH',
    ],
    [
      'longer',
      (s) => (s.files[`pos/${manifest().file}`] = Buffer.alloc(1_300_000, 7)),
      'UPDATE_FILE_MISMATCH',
    ],
    ['missing', (s) => delete s.files[`pos/${manifest().file}`], 'UPDATE_HTTP_404'],
    ['no manifest', (s) => delete s.files['pos/latest.json'], 'UPDATE_HTTP_404'],
    [
      'bad manifest',
      (s) => (s.files['pos/latest.json'] = '{"app":"pos"}'),
      'UPDATE_MANIFEST_INVALID',
    ],
    [
      'oversized manifest',
      (s) => (s.files['pos/latest.json'] = ' '.repeat(5000)),
      'UPDATE_TOO_LARGE',
    ],
  ])
    await fixture(async ({ updater, state, directory, read }) => {
      change(state);
      assert.equal(await updater.check(), code, name);
      assert.deepEqual(readdirSync(directory), ['state.json'], name);
      assert.equal(read().staged, null, name);
      assert.equal(read().last.result, code, name);
      assert.equal(await updater.apply(), false, name);
      assert.equal(state.spawned.length, 0, name);
    });
  await fixture(async ({ updater, state, directory, read }) => {
    assert.equal(await updater.check(), 'staged');
    // Changed on disk between the download and the installation.
    writeFileSync(join(directory, manifest().file), Buffer.alloc(1_200_000, 9));
    assert.equal(await updater.apply(), false);
    assert.equal(state.spawned.length, 0);
    assert.equal(state.quits, 0);
    assert.deepEqual(readdirSync(directory), ['state.json']);
    assert.equal(read().last.result, 'UPDATE_FILE_MISMATCH');
    // The next check fetches a clean copy.
    assert.equal(await updater.check(), 'staged');
    assert.equal(await updater.apply(), true);
  });
  await fixture(async ({ updater, state }) => {
    state.requests.length = 0;
    const failing = createUpdater({
      app: 'pos',
      currentVersion: '0.5.0',
      feed: FEED,
      directory: join(tmpdir(), 'pickchick-updater-unreachable'),
      fetchImpl: async () => {
        throw new TypeError('fetch failed');
      },
      spawnImpl: () => assert.fail('never'),
      quit: () => assert.fail('never'),
    });
    assert.equal(await failing.check(), 'UPDATE_FAILED');
    assert.equal(await failing.apply(), false);
    assert.equal(await updater.apply(), false);
  });
});

test('an interrupted download continues from where it stopped, on any kind of server', async () => {
  const pieces = (state) =>
    state.requests.filter((r) => r.url.endsWith('.exe')).map((r) => r.init.headers.range);
  // The link drops in the second piece; the same check asks for the rest and finishes.
  await fixture(async ({ updater, state, directory }) => {
    state.requests.length = 0;
    const original = state.files[`pos/${manifest().file}`];
    let calls = 0;
    Object.defineProperty(state.files, `pos/${manifest().file}`, {
      get() {
        calls += 1;
        if (calls === 2) state.cutAfter = 100_000;
        return original;
      },
      enumerable: true,
    });
    assert.equal(await updater.check(), 'staged');
    assert.deepEqual(pieces(state), [
      'bytes=0-499999',
      'bytes=500000-999999',
      'bytes=600000-1099999',
      'bytes=1100000-1199999',
    ]);
    assert.deepEqual(readFileSync(join(directory, manifest().file)), installer);
  });
  // The feed goes away mid-file: the piece on disk is kept and the next check continues it.
  await fixture(async ({ updater, state, directory, read }) => {
    assert.equal(await updater.check(), 'staged');
    const first = readFileSync(join(directory, manifest().file)).subarray(0, 700_000);
    const next = Buffer.alloc(1_300_000, 5);
    const newer = manifest({
      version: '0.5.2',
      file: 'PickChick-POS-Setup-0.5.2-x64.exe',
      sha256: sha(next),
      bytes: next.byteLength,
    });
    state.files['pos/latest.json'] = JSON.stringify(newer);
    assert.equal(await updater.check(), 'UPDATE_HTTP_404', 'the installer is not uploaded yet');
    assert.deepEqual(readdirSync(directory), ['state.json'], 'the older installer is gone');
    assert.equal(read().staged.version, '0.5.1', 'recorded until the next successful check');
    assert.equal(await updater.apply(), false, 'and its missing file is never started');
    const part = sha(next).slice(0, 32) + '.part';
    writeFileSync(join(directory, part), next.subarray(0, 700_000));
    assert.equal(first.byteLength, 700_000);
    state.files['pos/PickChick-POS-Setup-0.5.2-x64.exe'] = next;
    state.requests.length = 0;
    assert.equal(await updater.check(), 'staged');
    assert.deepEqual(pieces(state), ['bytes=700000-1199999', 'bytes=1200000-1299999']);
    assert.deepEqual(readFileSync(join(directory, newer.file)), next);
    assert.deepEqual(readdirSync(directory).sort(), [newer.file, 'state.json']);
  });
  // A piece left by an interrupted run that is not the beginning of this installer.
  await fixture(async ({ updater, directory, read }) => {
    mkdirSync(directory, { recursive: true });
    const part = sha(installer).slice(0, 32) + '.part';
    writeFileSync(join(directory, part), Buffer.alloc(700_000, 1));
    assert.equal(await updater.check(), 'UPDATE_FILE_MISMATCH');
    assert.deepEqual(readdirSync(directory), ['state.json']);
    assert.equal(read().staged, null);
    assert.equal(await updater.check(), 'staged', 'the next check starts from zero');
  });
  // A server that ignores Range sends the whole file; a cut one starts again from zero.
  await fixture(async ({ updater, state, directory }) => {
    state.noRange = true;
    state.requests.length = 0;
    state.cutAfter = 300_000;
    assert.equal(await updater.check(), 'staged');
    assert.deepEqual(pieces(state), ['bytes=0-499999', 'bytes=300000-799999']);
    assert.deepEqual(readFileSync(join(directory, manifest().file)), installer);
  });
  // A link that keeps dropping gives up for this check and keeps what it has.
  await fixture(async ({ updater, state, directory, read }) => {
    const original = state.files[`pos/${manifest().file}`];
    Object.defineProperty(state.files, `pos/${manifest().file}`, {
      get() {
        state.cutAfter = 50_000;
        return original;
      },
      enumerable: true,
    });
    assert.equal(await updater.check(), 'UPDATE_INCOMPLETE');
    assert.equal(read().staged, null);
    const [part] = readdirSync(directory).filter((name) => name.endsWith('.part'));
    assert.equal(readFileSync(join(directory, part)).byteLength, 150_000);
    assert.equal(await updater.apply(), false);
    assert.equal(state.spawned.length, 0);
  });
});

test('an ordinary update waits for the start of the program or the night; an urgent one does not', async () => {
  await fixture(async ({ updater, state, read }) => {
    assert.equal(await updater.check(), 'staged');
    state.clock = NOON + STARTUP_WINDOW_MS;
    assert.equal(await updater.apply(), false, 'midday, long after the start');
    assert.equal(state.spawned.length, 0);
    assert.equal(read().staged.attempts, 0);
    state.clock = NIGHT;
    assert.equal(await updater.apply(), true, 'night window');
  });
  await fixture(async ({ updater, state }) => {
    assert.equal(await updater.check(), 'staged');
    state.clock = NOON + STARTUP_WINDOW_MS - 1;
    assert.equal(await updater.apply(), true, 'found right after the start');
  });
  await fixture(async ({ updater, state, read }) => {
    assert.equal(await updater.check(), 'staged');
    state.clock = NOON + 3 * 60 * 60 * 1000;
    assert.equal(await updater.apply(), false);
    // The publisher marks the same release urgent.
    state.files['pos/latest.json'] = JSON.stringify(manifest({ apply: 'now' }));
    assert.equal(await updater.check(), 'staged');
    assert.equal(read().staged.apply, 'now');
    assert.equal(state.requests.filter((r) => r.url.endsWith('.exe')).length, 3);
    assert.equal(await updater.apply(), true);
  });
});

test('nothing restarts while the program says it is not safe', async () => {
  await fixture(async ({ updater, state, read }) => {
    state.files['pos/latest.json'] = JSON.stringify(manifest({ apply: 'now' }));
    assert.equal(await updater.check(), 'staged');
    state.safe = false;
    for (state.clock of [NOON, NIGHT]) assert.equal(await updater.apply(), false);
    assert.equal(state.spawned.length, 0);
    assert.equal(state.quits, 0);
    assert.equal(read().last.result, 'waiting');
    assert.equal(read().staged.attempts, 0);
    state.safe = true;
    assert.equal(await updater.apply(), true);
  });
});

test('an installer that does not bring the new version up is tried twice and then left', async () => {
  await fixture(async ({ updater, state, read }) => {
    state.files['pos/latest.json'] = JSON.stringify(manifest({ apply: 'now' }));
    assert.equal(await updater.check(), 'staged');
    // The program is still 0.5.0 after each attempt.
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      assert.equal(await updater.apply(), true, `attempt ${attempt}`);
      assert.equal(read().staged.attempts, attempt);
    }
    assert.equal(await updater.apply(), false);
    assert.equal(state.spawned.length, MAX_ATTEMPTS);
    assert.equal(await updater.check(), 'gave_up');
    assert.equal(state.requests.filter((r) => r.url.endsWith('.exe')).length, 3);
    assert.equal(await updater.apply(), false);
    // A rebuilt 0.5.1 or a newer version starts again from zero.
    const next = Buffer.alloc(1_300_000, 5);
    state.files['pos/latest.json'] = JSON.stringify(
      manifest({
        version: '0.5.2',
        file: 'PickChick-POS-Setup-0.5.2-x64.exe',
        sha256: sha(next),
        bytes: next.byteLength,
        apply: 'now',
      }),
    );
    state.files['pos/PickChick-POS-Setup-0.5.2-x64.exe'] = next;
    assert.equal(await updater.check(), 'staged');
    assert.equal(read().staged.attempts, 0);
    assert.equal(await updater.apply(), true);
    assert.match(state.spawned.at(-1).file, /PickChick-POS-Setup-0\.5\.2-x64\.exe$/);
  });
  await fixture(async ({ updater, state, read }) => {
    assert.equal(await updater.check(), 'staged');
    state.spawnFails = true;
    assert.equal(await updater.apply(), false, 'the installer could not start');
    assert.equal(state.quits, 0, 'the program stays open');
    assert.equal(read().last.result, 'UPDATE_INSTALLER_FAILED');
    assert.equal(read().staged.attempts, 1);
  });
});

test('the updated program clears what the previous version left behind', async () => {
  let kept;
  await fixture(async ({ updater, directory }) => {
    assert.equal(await updater.check(), 'staged');
    assert.equal(await updater.apply(), true);
    kept = {
      state: readFileSync(join(directory, 'state.json'), 'utf8'),
      file: readFileSync(join(directory, manifest().file)),
    };
  });
  await fixture(
    async ({ updater, state, directory, read }) => {
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, 'state.json'), kept.state);
      writeFileSync(join(directory, manifest().file), kept.file);
      writeFileSync(join(directory, '.download-interrupted.tmp'), 'partial');
      assert.equal(await updater.apply(), false);
      assert.equal(state.spawned.length, 0);
      assert.deepEqual(readdirSync(directory), ['state.json']);
      assert.equal(read().staged, null);
      assert.equal(await updater.check(), 'current');
      assert.equal(state.requests.length, 1);
    },
    { currentVersion: '0.5.1' },
  );
});

test('a damaged state file is an empty state, not a reason to start anything', async () => {
  await fixture(async ({ updater, state, directory }) => {
    mkdirSync(directory, { recursive: true });
    for (const bad of [
      'not json',
      '[]',
      JSON.stringify({ staged: { ...manifest(), apply: 'idle', attempts: -1 } }),
      JSON.stringify({ staged: { ...manifest(), apply: 'idle', attempts: 0, file: 'cmd.exe' } }),
      JSON.stringify({ staged: { ...manifest({ app: 'kitchen' }), apply: 'idle', attempts: 0 } }),
    ]) {
      writeFileSync(join(directory, 'state.json'), bad);
      writeFileSync(join(directory, 'cmd.exe'), 'x');
      assert.equal(await updater.apply(), false, bad);
    }
    assert.equal(state.spawned.length, 0);
  });
});

test('background ticks check the feed after the first seconds and then every quarter of an hour', async () => {
  await fixture(async ({ updater, state }) => {
    const manifests = () => state.requests.filter((r) => r.url.endsWith('latest.json')).length;
    state.files['pos/latest.json'] = JSON.stringify(
      manifest({ version: '0.5.0', file: 'PickChick-POS-Setup-0.5.0-x64.exe' }),
    );
    assert.equal(await updater.tick(), false);
    assert.equal(manifests(), 0, 'not in the first seconds');
    state.clock += FIRST_CHECK_MS;
    assert.equal(await updater.tick(), false);
    assert.equal(manifests(), 1);
    state.clock += CHECK_INTERVAL_MS - 1;
    assert.equal(await updater.tick(), false);
    assert.equal(manifests(), 1);
    state.clock += 1;
    state.files['pos/latest.json'] = JSON.stringify(manifest({ apply: 'now' }));
    assert.equal(await updater.tick(), true, 'found, verified and started in one tick');
    assert.equal(manifests(), 2);
    assert.equal(state.quits, 1);
  });
});

test('the cash desk is restartable only without a cashier and without an unanswered command', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pickchick-settled-'));
  const id = (last) => `10000000-0000-4000-8000-${String(last).padStart(12, '0')}`;
  const journal = (pending) =>
    JSON.stringify({ version: 1, scope: 'x', draft: null, pending, known: [], selected: null });
  const name = (seed) => sha(seed) + '.json';
  try {
    assert.equal(journalsSettled(join(directory, 'absent')), true, 'no journal yet');
    assert.equal(journalsSettled(directory), true);
    writeFileSync(join(directory, name('a')), journal(null));
    writeFileSync(join(directory, '.write-leftover.tmp'), 'x');
    assert.equal(journalsSettled(directory), true);
    writeFileSync(join(directory, name('b')), journal({ key: id(9), kind: 'create' }));
    assert.equal(journalsSettled(directory), false, 'one cashier has "Проверить результат"');
    writeFileSync(join(directory, name('b')), journal(null));
    assert.equal(journalsSettled(directory), true);
    writeFileSync(join(directory, name('c')), 'damaged');
    assert.equal(journalsSettled(directory), false, 'an unreadable journal is not "empty"');
    writeFileSync(join(directory, name('c')), '{}');
    assert.equal(journalsSettled(directory), false);
    assert.throws(() => journalsSettled('relative'), /STORAGE_UNAVAILABLE/);

    let clock = Date.parse('2030-01-01T00:00:00.000Z');
    const store = createJournalStore({ directory: join(directory, 'store'), now: () => clock });
    const session = {
      session_id: id(1),
      staff_id: id(2),
      terminal_id: id(3),
      branch_id: id(4),
      role: 'cashier',
      expires_at: '2030-01-01T01:00:00.000Z',
    };
    assert.equal(store.hasSession(), false);
    store.setSession(session, id(1));
    assert.equal(store.hasSession(), true);
    clock = Date.parse('2030-01-01T01:00:00.000Z');
    assert.equal(store.hasSession(), false, 'an expired session does not hold the desk');
    clock = Date.parse('2030-01-01T00:30:00.000Z');
    store.setSession(null);
    assert.equal(store.hasSession(), false);
    assert.equal(existsSync(join(directory, 'store')), false, 'asking does not create storage');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the release script writes a feed the installed client accepts and refuses a foreign file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pickchick-feed-out-'));
  try {
    for (const [app, path] of [
      ['pos', 'apps/pos-desktop/package.json'],
      ['kitchen', 'apps/kitchen-desktop/package.json'],
    ]) {
      const { version } = JSON.parse(text(path));
      const file = `${APPS[app]}${version}-x64.exe`;
      const source = join(directory, file);
      const data = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(1_100_000, 3)]);
      writeFileSync(source, data);
      const out = join(directory, 'feed');
      const result = writeFeed({ app, installer: source, out, apply: 'now' });
      assert.deepEqual(readdirSync(join(out, app)).sort(), [file, 'latest.json']);
      const written = parseManifest(readFileSync(join(out, app, 'latest.json'), 'utf8'), app);
      assert.deepEqual(written, result.manifest);
      assert.deepEqual(written, {
        app,
        version,
        file,
        sha256: sha(data),
        bytes: data.byteLength,
        apply: 'now',
      });
      assert.deepEqual(readFileSync(join(out, app, file)), data);
      assert.equal(
        parseManifest(
          readFileSync(
            join(writeFeed({ app, installer: source, out }).directory, 'latest.json'),
            'utf8',
          ),
          app,
        ).apply,
        'idle',
      );
      const renamed = join(directory, `${APPS[app]}9.9.9-x64.exe`);
      writeFileSync(renamed, data);
      assert.throws(
        () => writeFeed({ app, installer: renamed, out }),
        /installer of this checkout/,
      );
      writeFileSync(source, Buffer.alloc(1_100_000, 3));
      assert.throws(() => writeFeed({ app, installer: source, out }), /Not a Windows executable/);
      writeFileSync(source, data);
      assert.throws(
        () => writeFeed({ app, installer: source, out, apply: 'force' }),
        /UPDATE_MANIFEST_INVALID/,
      );
    }
    assert.throws(
      () => writeFeed({ app: 'backoffice', installer: 'x', out: directory }),
      /Unknown/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
