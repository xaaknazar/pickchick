// Self-update of an installed PickChick desktop client (docs/operations/desktop-updates.md).
// The same file, byte for byte, ships in apps/pos-desktop and apps/kitchen-desktop
// (tests/unit/desktop-updater.test.mjs). No Electron import: main.mjs passes what it needs.
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { clearInterval, setInterval, setTimeout } from 'node:timers';

/** Installer name prefix per application; the rest is `<version>-x64.exe` of electron-builder. */
export const APPS = Object.freeze({
  pos: 'PickChick-POS-Setup-',
  kitchen: 'PickChick-Kitchen-Setup-',
});
export const MAX_MANIFEST_BYTES = 4096;
export const MIN_INSTALLER_BYTES = 1_000_000;
export const MAX_INSTALLER_BYTES = 400 * 1024 * 1024;
/** A version whose installer did not bring the new version up twice is left alone. */
export const MAX_ATTEMPTS = 2;
export const CHECK_INTERVAL_MS = 15 * 60 * 1000;
export const FIRST_CHECK_MS = 20 * 1000;
export const TICK_MS = 60 * 1000;
/** An update found right after the program started is installed without waiting for the night. */
export const STARTUP_WINDOW_MS = 10 * 60 * 1000;
export const NIGHT_HOURS = Object.freeze([3, 4, 5]);
/** The installer is fetched in pieces: a slow link or a gateway that ends long responses still gets it through. */
export const CHUNK_BYTES = 4 * 1024 * 1024;
const MANIFEST_TIMEOUT_MS = 20 * 1000;
const CHUNK_TIMEOUT_MS = 60 * 1000;
const CHUNK_ATTEMPTS = 3;
const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;
const VERSION = /^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})$/;
const HOST = /^(?=.{4,100}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;

function fail(code) {
  throw new Error(code);
}

/** Negative, zero or positive as `a` is older than, equal to or newer than `b` (x.y.z only). */
export function compareVersions(a, b) {
  const [x, y] = [a, b].map((value) => {
    const match = typeof value === 'string' ? VERSION.exec(value) : null;
    if (!match) fail('UPDATE_VERSION_INVALID');
    return match.slice(1).map(Number);
  });
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

/**
 * The address updates are read from, or null (updates off). Only `https://host/dir/` without
 * port, credentials, query or fragment; `http://127.0.0.1:port/dir/` exists for stand tests.
 */
export function validateFeed(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.length > 200) fail('UPDATE_FEED_INVALID');
  let url;
  try {
    url = new URL(value);
  } catch {
    fail('UPDATE_FEED_INVALID');
  }
  const remote = url.protocol === 'https:' && url.port === '' && HOST.test(url.hostname);
  const stand =
    url.protocol === 'http:' && url.hostname === '127.0.0.1' && /^[1-9]\d{1,4}$/.test(url.port);
  if (
    (!remote && !stand) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/(?:[A-Za-z0-9_-][A-Za-z0-9._-]{0,40}\/){0,4}$/.test(url.pathname) ||
    url.href !== value
  )
    fail('UPDATE_FEED_INVALID');
  return url.href;
}

/** `update-feed.json` of the package or `update.json` of the profile: exactly `{ "feed": ... }`. */
export function parseFeedFile(text) {
  if (typeof text !== 'string' || text.length > 1000) fail('UPDATE_FEED_INVALID');
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail('UPDATE_FEED_INVALID');
  }
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).join() !== 'feed'
  )
    fail('UPDATE_FEED_INVALID');
  return validateFeed(value.feed);
}

/**
 * The feed of this installation. `update.json` in the profile wins over the packaged
 * `update-feed.json` (a feed, or null to switch updates off on this device). An unreadable or
 * invalid file means "no updates"; it never stops the program from opening.
 */
export function readFeed({ packagedPath, overridePath, fsImpl = fs }) {
  const read = (path) => {
    try {
      return fsImpl.readFileSync(path, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    }
  };
  try {
    const override = read(overridePath);
    if (override !== undefined) return parseFeedFile(override);
    const packaged = read(packagedPath);
    return packaged === undefined ? null : parseFeedFile(packaged);
  } catch {
    return null;
  }
}

/** `latest.json` of one application. Unknown keys, other applications and other file names fail. */
export function parseManifest(text, app) {
  if (!Object.hasOwn(APPS, app)) fail('UPDATE_APP_INVALID');
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_MANIFEST_BYTES)
    fail('UPDATE_MANIFEST_INVALID');
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail('UPDATE_MANIFEST_INVALID');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('UPDATE_MANIFEST_INVALID');
  const keys = Object.keys(value).sort().join();
  if (keys !== 'app,bytes,file,sha256,version' && keys !== 'app,apply,bytes,file,sha256,version')
    fail('UPDATE_MANIFEST_INVALID');
  const { version, file, sha256, bytes } = value;
  const apply = value.apply ?? 'idle';
  if (
    value.app !== app ||
    typeof version !== 'string' ||
    !VERSION.test(version) ||
    file !== `${APPS[app]}${version}-x64.exe` ||
    typeof sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(sha256) ||
    !Number.isSafeInteger(bytes) ||
    bytes < MIN_INSTALLER_BYTES ||
    bytes > MAX_INSTALLER_BYTES ||
    !['idle', 'now'].includes(apply)
  )
    fail('UPDATE_MANIFEST_INVALID');
  return { app, version, file, sha256, bytes, apply };
}

async function readLimited(response, limit, onChunk) {
  const reader = response.body.getReader();
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return total;
      total += value.byteLength;
      if (total > limit) fail('UPDATE_TOO_LARGE');
      await onChunk(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/**
 * Checks the feed, keeps one verified installer in `directory` and starts it when the program
 * may restart. Every failure is recorded in `state.json` and leaves the program running.
 *
 * `fetchImpl(url, init)` answers like fetch; `spawnImpl(file, args, options)` like
 * child_process.spawn; `canApply()` says whether a restart is harmless right now; `quit()`
 * closes the program after the installer has started.
 */
export function createUpdater({
  app,
  currentVersion,
  feed,
  directory,
  fetchImpl,
  spawnImpl,
  quit,
  canApply = () => true,
  now = Date.now,
  fsImpl = fs,
  chunkBytes = CHUNK_BYTES,
}) {
  if (!Object.hasOwn(APPS, app)) fail('UPDATE_APP_INVALID');
  compareVersions(currentVersion, currentVersion);
  const base = validateFeed(feed);
  if (!base) fail('UPDATE_FEED_INVALID');
  if (typeof directory !== 'string' || !isAbsolute(directory)) fail('UPDATE_DIRECTORY_INVALID');
  const startedAt = now();
  const statePath = join(directory, 'state.json');
  let busy = false;
  let lastCheckAt = null;
  let timer = null;

  function ensureDirectory() {
    fsImpl.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = fsImpl.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('UPDATE_DIRECTORY_INVALID');
  }
  /** `{ staged, last }`; anything unreadable is an empty state (the installer is fetched again). */
  function readState() {
    try {
      if (fsImpl.lstatSync(statePath).size > 4096) return { staged: null, last: null };
      const state = JSON.parse(fsImpl.readFileSync(statePath, 'utf8'));
      const staged = state?.staged ?? null;
      if (staged !== null) {
        const parsed = parseManifest(
          JSON.stringify({
            app,
            version: staged.version,
            file: staged.file,
            sha256: staged.sha256,
            bytes: staged.bytes,
            apply: staged.apply,
          }),
          app,
        );
        if (!Number.isSafeInteger(staged.attempts) || staged.attempts < 0 || staged.attempts > 99)
          fail('UPDATE_STATE_INVALID');
        return { staged: { ...parsed, attempts: staged.attempts }, last: state.last ?? null };
      }
      return { staged: null, last: state?.last ?? null };
    } catch {
      return { staged: null, last: null };
    }
  }
  function writeState(state) {
    ensureDirectory();
    const temporary = join(directory, `.state-${randomUUID()}.tmp`);
    try {
      fsImpl.writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n', {
        flag: 'wx',
        mode: 0o600,
      });
      fsImpl.renameSync(temporary, statePath);
    } finally {
      try {
        fsImpl.unlinkSync(temporary);
      } catch {
        /* Renamed already. */
      }
    }
  }
  function record(result, staged) {
    writeState({
      staged,
      last: { at: new Date(now()).toISOString(), current: currentVersion, result },
    });
    return result;
  }
  /** Removes every file of the directory except the state and `keep` (an unfinished download). */
  function sweep(keep) {
    let names;
    try {
      names = fsImpl.readdirSync(directory);
    } catch {
      return;
    }
    for (const name of names) {
      if (name === 'state.json' || name === keep) continue;
      try {
        fsImpl.unlinkSync(join(directory, name));
      } catch {
        /* A file in use stays until the next sweep. */
      }
    }
  }
  async function hashFile(path, bytes) {
    const stat = fsImpl.lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== bytes) return null;
    const hash = createHash('sha256');
    for await (const chunk of fsImpl.createReadStream(path, { highWaterMark: 1024 * 1024 }))
      hash.update(chunk);
    return hash.digest('hex');
  }
  async function verified(staged) {
    try {
      return (await hashFile(join(directory, staged.file), staged.bytes)) === staged.sha256;
    } catch {
      return false;
    }
  }
  async function request(path, timeout, range) {
    const response = await fetchImpl(base + app + '/' + path, {
      method: 'GET',
      redirect: 'error',
      cache: 'no-store',
      credentials: 'omit',
      headers: { 'cache-control': 'no-cache', ...(range ? { range } : {}) },
      signal: AbortSignal.timeout(timeout),
    });
    if (!(range ? [200, 206] : [200]).includes(response.status) || !response.body) {
      await response.body?.cancel().catch(() => {});
      fail('UPDATE_HTTP_' + response.status);
    }
    return response;
  }
  /**
   * Fetches the installer piece by piece into `<hash>.part` and continues an interrupted file
   * of the same hash instead of starting again. Only the whole file with the hash of the
   * manifest gets the installer name.
   */
  async function download(manifest) {
    ensureDirectory();
    const partialName = manifest.sha256.slice(0, 32) + '.part';
    const partial = join(directory, partialName);
    sweep(partialName);
    const size = () => {
      try {
        const stat = fsImpl.lstatSync(partial);
        if (!stat.isFile() || stat.isSymbolicLink()) fail('UPDATE_DIRECTORY_INVALID');
        return stat.size;
      } catch (error) {
        if (error.code === 'ENOENT') return 0;
        throw error;
      }
    };
    const discard = () => {
      try {
        fsImpl.unlinkSync(partial);
      } catch {
        /* Nothing to remove. */
      }
    };
    const deadline = Date.now() + DOWNLOAD_TIMEOUT_MS;
    let failures = 0;
    let offset = size();
    if (offset > manifest.bytes) {
      discard();
      offset = 0;
    }
    while (offset < manifest.bytes) {
      if (Date.now() > deadline) fail('UPDATE_DOWNLOAD_TIMEOUT');
      const last = Math.min(offset + chunkBytes, manifest.bytes) - 1;
      let fd;
      let failure = null;
      try {
        const response = await request(manifest.file, CHUNK_TIMEOUT_MS, `bytes=${offset}-${last}`);
        let expected = last - offset + 1;
        if (response.status === 200) {
          // A server without ranges sends the whole file, which can only start from zero.
          discard();
          expected = manifest.bytes;
        } else if (
          response.headers.get('content-range') !== `bytes ${offset}-${last}/${manifest.bytes}`
        ) {
          await response.body.cancel().catch(() => {});
          fail('UPDATE_FILE_MISMATCH');
        }
        fd = fsImpl.openSync(partial, 'a', 0o600);
        const received = await readLimited(response, expected, (chunk) => {
          fsImpl.writeSync(fd, chunk);
        });
        if (received !== expected) fail('UPDATE_INCOMPLETE');
        fsImpl.fsyncSync(fd);
      } catch (error) {
        failure = error;
      } finally {
        if (fd !== undefined) fsImpl.closeSync(fd);
      }
      if (failure) {
        const code = failure?.message;
        if (code === 'UPDATE_FILE_MISMATCH' || code === 'UPDATE_TOO_LARGE') {
          discard();
          throw failure;
        }
        // The server refuses (4xx): asking again changes nothing. Anything else is the link.
        failures += 1;
        if (/^UPDATE_HTTP_4\d\d$/.test(code) || failures >= CHUNK_ATTEMPTS) throw failure;
      } else failures = 0;
      offset = size();
    }
    if ((await hashFile(partial, manifest.bytes)) !== manifest.sha256) {
      discard();
      fail('UPDATE_FILE_MISMATCH');
    }
    fsImpl.renameSync(partial, join(directory, manifest.file));
  }

  /** Reads the feed; downloads and verifies a newer installer. Returns the recorded result. */
  async function check() {
    lastCheckAt = now();
    let { staged } = readState();
    try {
      if (staged && compareVersions(staged.version, currentVersion) <= 0) {
        staged = null;
        sweep(null);
      }
      const response = await request('latest.json', MANIFEST_TIMEOUT_MS);
      const chunks = [];
      await readLimited(response, MAX_MANIFEST_BYTES, (chunk) => chunks.push(Buffer.from(chunk)));
      const manifest = parseManifest(Buffer.concat(chunks).toString('utf8'), app);
      if (compareVersions(manifest.version, currentVersion) <= 0) {
        sweep(null);
        return record('current', null);
      }
      if (staged && staged.version === manifest.version && staged.sha256 === manifest.sha256) {
        if (staged.attempts >= MAX_ATTEMPTS) return record('gave_up', staged);
        if (await verified(staged)) return record('staged', { ...staged, apply: manifest.apply });
      }
      await download(manifest);
      return record('staged', { ...manifest, attempts: 0 });
    } catch (error) {
      const code = /^UPDATE_[A-Z0-9_]+$/.test(error?.message) ? error.message : 'UPDATE_FAILED';
      try {
        return record(code, staged);
      } catch {
        return code;
      }
    }
  }

  /** Starts the staged installer when it is due and harmless. True: the program is closing. */
  async function apply() {
    const { staged } = readState();
    if (!staged) return false;
    if (compareVersions(staged.version, currentVersion) <= 0) {
      sweep(null);
      record('current', null);
      return false;
    }
    if (staged.attempts >= MAX_ATTEMPTS) return false;
    const due =
      staged.apply === 'now' ||
      now() - startedAt < STARTUP_WINDOW_MS ||
      NIGHT_HOURS.includes(new Date(now()).getHours());
    if (!due) return false;
    if (!(await canApply())) {
      record('waiting', staged);
      return false;
    }
    if (!(await verified(staged))) {
      sweep(null);
      record('UPDATE_FILE_MISMATCH', null);
      return false;
    }
    // Counted before the installer starts: a failed installer is tried once more, then left.
    const attempted = { ...staged, attempts: staged.attempts + 1 };
    record('installing', attempted);
    try {
      // The assisted NSIS installer of electron-builder: silent, replaces this per-user
      // installation, then opens the new version.
      const child = spawnImpl(join(directory, staged.file), ['--updated', '/S', '--force-run'], {
        detached: true,
        stdio: 'ignore',
      });
      await new Promise((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
      child.unref();
    } catch {
      record('UPDATE_INSTALLER_FAILED', attempted);
      return false;
    }
    quit();
    return true;
  }

  async function tick() {
    if (busy) return false;
    busy = true;
    try {
      const sinceCheck = lastCheckAt === null ? now() - startedAt : now() - lastCheckAt;
      if (sinceCheck >= (lastCheckAt === null ? FIRST_CHECK_MS : CHECK_INTERVAL_MS)) await check();
      return await apply();
    } catch {
      return false;
    } finally {
      busy = false;
    }
  }

  return {
    check,
    apply,
    tick,
    /** Background checks for as long as the program runs. */
    start() {
      if (timer) return;
      const run = () => {
        void tick().then((closing) => {
          if (closing) clearInterval(timer);
        });
      };
      const first = setTimeout(run, FIRST_CHECK_MS);
      first.unref?.();
      timer = setInterval(run, TICK_MS);
      timer.unref?.();
    },
    stop() {
      clearInterval(timer);
      timer = null;
    },
  };
}
