// What an installed program does with a feed, without Electron: one check with the real updater.
// node tests/desktop-update-server/feed-client.mjs --feed <url> --app pos|kitchen --current <x.y.z>
//      --expect current|<x.y.z> [--sha256 <hex of the installer>]
// Used by tests/desktop-update-server/server-rehearsal.py against the real gateway route.
import { createHash } from 'node:crypto';
import { createReadStream, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APPS, createUpdater, validateFeed } from '../../apps/pos-desktop/updater.mjs';

const args = {};
for (let i = 2; i < process.argv.length; i += 2)
  args[process.argv[i].slice(2)] = process.argv[i + 1];
const { feed, app, current, expect, sha256 } = args;
if (!feed || !Object.hasOwn(APPS, app ?? '') || !current || !expect) {
  console.error('Usage: --feed <url> --app pos|kitchen --current <x.y.z> --expect current|<x.y.z>');
  process.exit(2);
}

const directory = mkdtempSync(join(tmpdir(), 'pickchick-feed-client-'));
const requests = [];
const updater = createUpdater({
  app,
  currentVersion: current,
  feed: validateFeed(feed),
  directory,
  fetchImpl: async (url, init) => {
    const response = await fetch(url, init);
    requests.push(`${new URL(url).pathname} ${init.headers?.range ?? '-'} ${response.status}`);
    return response;
  },
  spawnImpl: () => {
    throw new Error('This check never starts an installer');
  },
  quit: () => {},
});

function hash(path) {
  return new Promise((resolve, reject) => {
    const digest = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => digest.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(digest.digest('hex')));
  });
}

let ok;
const report = { app, current, expect };
try {
  report.result = await updater.check();
  report.requests = requests.length;
  report.pieces = requests.filter((line) => line.endsWith(' 206')).length;
  if (expect === 'current') {
    ok = report.result === 'current' && report.pieces === 0;
  } else {
    const file = `${APPS[app]}${expect}-x64.exe`;
    report.files = readdirSync(directory).filter((name) => name.endsWith('.exe'));
    report.sha256 = report.files.includes(file) ? await hash(join(directory, file)) : null;
    ok =
      report.result === 'staged' &&
      report.files.length === 1 &&
      report.pieces > 0 &&
      (!sha256 || report.sha256 === sha256);
  }
} finally {
  updater.stop?.();
  rmSync(directory, { recursive: true, force: true });
}
console.log(JSON.stringify({ ...report, ok }));
process.exit(ok ? 0 : 1);
