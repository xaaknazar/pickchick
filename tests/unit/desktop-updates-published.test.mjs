import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { APPS, compareVersions } from '../../apps/pos-desktop/updater.mjs';
import {
  RECORD,
  checkPublished,
  packagedFeeds,
  readRecord,
} from '../desktop-update-server/published-check.mjs';

const sha = (data) => createHash('sha256').update(data).digest('hex');
const INSTALLERS = { kitchen: Buffer.alloc(1_100_000, 9), pos: Buffer.alloc(1_200_000, 7) };
const VERSIONS = { kitchen: '0.4.0', pos: '0.5.0' };

/** A feed on 127.0.0.1 that answers like the gateway route; `faults` break one property each. */
async function stand(run, faults = {}) {
  const files = {};
  for (const app of Object.keys(APPS)) {
    const version = faults.version?.[app] ?? VERSIONS[app];
    const file = `${APPS[app]}${version}-x64.exe`;
    files[`/desktop-updates/${app}/latest.json`] = Buffer.from(
      JSON.stringify({
        app,
        version,
        file,
        sha256: sha(INSTALLERS[app]),
        bytes: INSTALLERS[app].byteLength,
      }),
    );
    files[`/desktop-updates/${app}/${file}`] = INSTALLERS[app];
  }
  const server = createServer((request, response) => {
    const path = new URL(request.url, 'http://127.0.0.1').pathname;
    const file = files[path];
    if (faults.listing && path === '/desktop-updates/') return response.end('pos/\nkitchen/\n');
    if (!file || !['GET', 'HEAD'].includes(request.method))
      return response.writeHead(404, { 'cache-control': 'no-store' }).end('{"error":"NOT_FOUND"}');
    const headers = path.endsWith('.json') && !faults.cached ? { 'cache-control': 'no-store' } : {};
    const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? '');
    if (!range) return response.writeHead(200, headers).end(file);
    const first = Number(range[1]);
    const last = Math.min(Number(range[2]), file.byteLength - 1);
    if (first >= file.byteLength) return response.writeHead(416).end();
    response
      .writeHead(206, { ...headers, 'content-range': `bytes ${first}-${last}/${file.byteLength}` })
      .end(file.subarray(first, last + 1));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const feed = `http://127.0.0.1:${server.address().port}/desktop-updates/`;
  const record = {
    feed,
    release: `kitchen-${VERSIONS.kitchen}-pos-${VERSIONS.pos}`,
    programs: Object.fromEntries(
      Object.keys(APPS).map((app) => [
        app,
        { version: VERSIONS[app], sha256: sha(INSTALLERS[app]), build: 'a'.repeat(40) },
      ]),
    ),
  };
  try {
    await run(record);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

test('the record of the published feed is well formed and names the address of the builds', () => {
  const record = readRecord(readFileSync(RECORD, 'utf8'));
  // Builds either stay off or ask exactly the published address.
  for (const feed of packagedFeeds()) assert.ok(feed === null || feed === record.feed);
  // A build of these sources is never offered an older build or a build of another line: what
  // is published is not above the version in the sources (the version is raised and merged
  // before a publish, docs/operations/desktop-updates.md).
  for (const [app, directory] of [
    ['pos', 'pos-desktop'],
    ['kitchen', 'kitchen-desktop'],
  ]) {
    const { version } = JSON.parse(
      readFileSync(new URL(`../../apps/${directory}/package.json`, import.meta.url), 'utf8'),
    );
    assert.ok(
      compareVersions(version, record.programs[app].version) >= 0,
      `${app}: the published ${record.programs[app].version} is above the sources (${version})`,
    );
  }
  const text = JSON.stringify(record);
  for (const bad of [
    '',
    '[]',
    '{}',
    text.replace('https://', 'http://'),
    text.replace(record.release, record.release + '-x'),
    text.replace(record.programs.pos.sha256, record.programs.pos.sha256.toUpperCase()),
    text.replace(`"version":"${record.programs.pos.version}"`, '"version":"0.5"'),
    text.replace('"kitchen":', '"server":'),
    text.replace('{"feed":', '{"apply":"now","feed":'),
  ])
    assert.throws(() => readRecord(bad), /PUBLISHED_RECORD_INVALID|UPDATE_/, bad.slice(0, 60));
});

test('the outside check reads a correct feed with the updater of the programs', async () => {
  await stand(async (record) => {
    const summary = await checkPublished(record, { packaged: [record.feed, record.feed] });
    assert.deepEqual(summary.problems, []);
    assert.equal(summary.ok, true);
    assert.equal(summary.builds, 'on');
    for (const app of Object.keys(APPS)) {
      const entry = summary.programs[app];
      assert.equal(entry.manifest_status, 200);
      assert.equal(entry.apply, 'idle');
      assert.equal(entry.download.result, 'staged');
      assert.equal(entry.download.sha256, record.programs[app].sha256);
      assert.ok(entry.download.pieces >= 1);
      assert.equal(entry.same_version, 'current');
    }
    assert.ok(Object.values(summary.refused).every((status) => status === 404));
    // Builds that are still off are not a fault of the feed.
    const off = await checkPublished(record, { packaged: [null, null] });
    assert.equal(off.builds, 'off');
    assert.equal(off.ok, true);
  });
});

test('the outside check names what a device would not get', async () => {
  // The feed holds another version than the record says.
  await stand(
    async (record) => {
      const summary = await checkPublished(record, { packaged: [record.feed, record.feed] });
      assert.equal(summary.ok, false);
      assert.ok(
        summary.problems.includes('pos: latest.json is not the recorded version and installer'),
      );
      assert.ok(summary.problems.includes('pos: the updater did not get the recorded installer'));
      assert.ok(!summary.problems.some((problem) => problem.startsWith('kitchen')));
    },
    { version: { pos: '0.5.1' } },
  );
  // latest.json may be cached, and the directory lists its content.
  await stand(
    async (record) => {
      const summary = await checkPublished(record, {
        packaged: [record.feed, 'https://other.example.kz/desktop/'],
      });
      assert.equal(summary.ok, false);
      assert.equal(summary.builds, 'other');
      assert.ok(summary.problems.includes('the builds carry another feed address than the record'));
      assert.ok(
        summary.problems.some((problem) => /^pos: latest\.json may be cached/.test(problem)),
      );
      assert.ok(summary.problems.includes('feed: answered 200, not 404'));
    },
    { cached: true, listing: true },
  );
  // Nothing answers at the address.
  const summary = await checkPublished(
    {
      feed: 'http://127.0.0.1:9/desktop-updates/',
      release: 'kitchen-0.4.0-pos-0.5.0',
      programs: {
        kitchen: { version: '0.4.0', sha256: 'a'.repeat(64), build: 'a'.repeat(40) },
        pos: { version: '0.5.0', sha256: 'b'.repeat(64), build: 'a'.repeat(40) },
      },
    },
    { packaged: [null, null] },
  );
  assert.equal(summary.ok, false);
  assert.match(String(summary.programs.pos.manifest_status), /^no answer/);
});
