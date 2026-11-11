// What a device can get right now: the record of the published feed
// (docs/operations/desktop-updates-published.json) against the live address, read by the real
// updater of the programs. The record changes with every publish or withdraw
// (docs/operations/desktop-updates.md); that push runs this check from outside the server.
//   node tests/desktop-update-server/published-check.mjs
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  APPS,
  compareVersions,
  parseFeedFile,
  parseManifest,
  validateFeed,
} from '../../apps/pos-desktop/updater.mjs';

const ROOT = new URL('../../', import.meta.url);
export const RECORD = new URL('docs/operations/desktop-updates-published.json', ROOT);
const NAMES = Object.keys(APPS).sort();

/** The record as an object, or an Error that names what is wrong with it. No network. */
export function readRecord(text) {
  const fail = (reason) => {
    throw new Error('PUBLISHED_RECORD_INVALID: ' + reason);
  };
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail('not JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('not an object');
  if (Object.keys(value).sort().join() !== 'feed,programs,release') fail('keys');
  const feed = validateFeed(value.feed);
  if (!feed || !feed.startsWith('https://')) fail('feed');
  const programs = value.programs;
  if (
    !programs ||
    typeof programs !== 'object' ||
    Object.keys(programs).sort().join() !== NAMES.join()
  )
    fail('programs');
  for (const app of NAMES) {
    const entry = programs[app];
    if (
      !entry ||
      typeof entry !== 'object' ||
      Object.keys(entry).sort().join() !== 'build,sha256,version'
    )
      fail(app + ' keys');
    compareVersions(entry.version, entry.version);
    if (typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256))
      fail(app + ' sha256');
    if (typeof entry.build !== 'string' || !/^[a-f0-9]{40}$/.test(entry.build))
      fail(app + ' build');
  }
  // The name the server gives a release (infra/desktop-updates/remote-deploy.py, release_name).
  if (value.release !== NAMES.map((app) => `${app}-${programs[app].version}`).join('-'))
    fail('release');
  return { feed, release: value.release, programs };
}

/** The address inside each build: null (updates off) or a feed. */
export function packagedFeeds() {
  return ['pos-desktop', 'kitchen-desktop'].map((directory) =>
    parseFeedFile(readFileSync(new URL(`apps/${directory}/update-feed.json`, ROOT), 'utf8')),
  );
}

/** One request the way the programs make them: no cache, a redirect is a failure. */
async function get(url, init = {}) {
  try {
    const response = await fetch(url, {
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
      ...init,
    });
    return {
      status: response.status,
      cacheControl: response.headers.get('cache-control'),
      text: await response.text(),
    };
  } catch (error) {
    return {
      status: `no answer (${error.cause?.code ?? error.name})`,
      cacheControl: null,
      text: '',
    };
  }
}

/** One check of the real updater in its own process (tests/desktop-update-server/feed-client.mjs). */
function client(feed, app, current, expect, sha256) {
  const args = [fileURLToPath(new URL('feed-client.mjs', import.meta.url))];
  args.push('--feed', feed, '--app', app, '--current', current, '--expect', expect);
  if (sha256) args.push('--sha256', sha256);
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      args,
      { encoding: 'utf8', timeout: 20 * 60 * 1000 },
      (error, stdout, stderr) => {
        let report;
        try {
          report = JSON.parse(stdout.trim().split('\n').at(-1));
        } catch {
          report = null;
        }
        resolve({ status: error ? (error.code ?? 1) : 0, report, stderr: stderr.slice(-400) });
      },
    );
  });
}

/**
 * Reads the feed of `record` the way the programs do and says what does not match the record.
 * `packaged` is the address inside each build (the builds of this checkout by default).
 */
export async function checkPublished(record, { packaged = packagedFeeds() } = {}) {
  const summary = { feed: record.feed, release: record.release, programs: {}, refused: {} };
  const problems = [];
  const expect = (condition, text) => {
    if (!condition) problems.push(text);
  };

  summary.builds = packaged.every((feed) => feed === record.feed)
    ? 'on'
    : packaged.every((feed) => feed === null)
      ? 'off'
      : 'other';
  expect(summary.builds !== 'other', 'the builds carry another feed address than the record');

  for (const app of NAMES) {
    const { version, sha256 } = record.programs[app];
    const entry = (summary.programs[app] = { version });
    // latest.json the way a device asks for it.
    const response = await get(`${record.feed}${app}/latest.json`);
    entry.manifest_status = response.status;
    entry.cache_control = response.cacheControl;
    let manifest = null;
    try {
      manifest = parseManifest(response.text, app);
    } catch (error) {
      entry.manifest_error = error.message;
    }
    entry.apply = manifest?.apply ?? null;
    entry.bytes = manifest?.bytes ?? null;
    expect(response.status === 200, `${app}: latest.json answers ${response.status}`);
    expect(
      /(^|,)\s*no-store\s*(,|$)/i.test(entry.cache_control ?? ''),
      `${app}: latest.json may be cached (${entry.cache_control})`,
    );
    expect(
      manifest?.version === version && manifest?.sha256 === sha256,
      `${app}: latest.json is not the recorded version and installer`,
    );
    // A program of an older version: the whole installer in pieces, verified by the updater.
    let older = null;
    for (let attempt = 1; attempt <= 3 && older?.status !== 0; attempt += 1)
      older = { attempt, ...(await client(record.feed, app, '0.0.0', version, sha256)) };
    entry.download = {
      attempt: older.attempt,
      result: older.report?.result ?? null,
      pieces: older.report?.pieces ?? null,
      sha256: older.report?.sha256 ?? null,
    };
    if (older.status !== 0) entry.download.stderr = older.stderr;
    expect(older.status === 0, `${app}: the updater did not get the recorded installer`);
    // A program that already has this version asks and downloads nothing.
    const same = await client(record.feed, app, version, 'current');
    entry.same_version = same.report?.result ?? null;
    expect(same.status === 0, `${app}: a program of the published version does not stay as it is`);
  }

  // Only the two files of each program answer (the same probes as the server step itself).
  const app = NAMES[0];
  const here = `${record.feed}${app}/`;
  const version = record.programs[app].version;
  const refused = {
    feed_without_slash: record.feed.slice(0, -1),
    feed: record.feed,
    program_directory: here,
    blockmap: `${here}${APPS[app]}${version}-x64.exe.blockmap`,
    other_version: `${here}${APPS[app]}0.0.0-x64.exe`,
    other_name: `${here}latest.json.tmp`,
    pointer: `${record.feed}current/${app}/latest.json`,
    releases: `${record.feed}releases/`,
  };
  for (const [name, url] of Object.entries(refused)) {
    const response = await get(url);
    summary.refused[name] = response.status;
    expect(response.status === 404, `${name}: answered ${response.status}, not 404`);
  }
  const write = await get(`${here}latest.json`, { method: 'POST' });
  summary.refused.post = write.status;
  expect([404, 405].includes(write.status), `POST answered ${write.status}`);

  summary.problems = problems;
  summary.ok = problems.length === 0;
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const summary = await checkPublished(readRecord(readFileSync(RECORD, 'utf8')));
  console.log(JSON.stringify(summary, null, 2));
  process.exit(summary.ok ? 0 : 1);
}
