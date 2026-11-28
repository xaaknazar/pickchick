import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

// The cloud receipt worker (services/api/src/webkassa-worker.ts) without an explicit test/live mode
// equal to the account host (owner 28.11.2026). The environment holds no database settings at all:
// a run that reached the database or Webkassa could not even start, so the blocked branch issues
// nothing and leaves every queued document where it is.
const worker = fileURLToPath(
  new URL('../../services/api/dist/webkassa-worker.js', import.meta.url),
);
const dir = mkdtempSync(join(tmpdir(), 'wk-worker-'));
const account = (name, baseUrl) => {
  const file = join(dir, name);
  writeFileSync(
    file,
    JSON.stringify({
      baseUrl,
      apiKey: 'synthetic-key-1',
      login: 'synthetic@example.com',
      password: 'synthetic-pass',
      cashboxUniqueNumber: 'SWK00000002',
    }),
  );
  return file;
};
const run = (extra) =>
  spawnSync(process.execPath, [worker, '--once'], {
    env: { PATH: process.env.PATH, WEBKASSA_FISCAL_ACCOUNT_ID: randomUUID(), ...extra },
    encoding: 'utf8',
    timeout: 20_000,
  });

test('blocked cloud worker: one event, exit code 1 with --once, nothing issued, no secrets', () => {
  const dev = account('dev.json', 'https://devkkm.webkassa.kz');
  const live = account('live.json', 'https://kkm.webkassa.kz');
  for (const [extra, reason, more] of [
    [{ WEBKASSA_ACCOUNT_FILE: dev }, 'environment_not_set', { host: 'test' }],
    [
      { WEBKASSA_ACCOUNT_FILE: dev, WEBKASSA_REQUIRE_LIVE: 'false' },
      'environment_not_set',
      { host: 'test' },
    ],
    [
      { WEBKASSA_ACCOUNT_FILE: dev, WEBKASSA_ENVIRONMENT: 'live' },
      'environment_mismatch',
      { declared: 'live', host: 'test' },
    ],
    [
      { WEBKASSA_ACCOUNT_FILE: live, WEBKASSA_ENVIRONMENT: 'test' },
      'environment_mismatch',
      { declared: 'test', host: 'live' },
    ],
    [
      { WEBKASSA_ACCOUNT_FILE: live, WEBKASSA_ENVIRONMENT: 'Live' },
      'environment_invalid',
      { expected: 'live|test' },
    ],
    [
      { WEBKASSA_ACCOUNT_FILE: live, WEBKASSA_ENVIRONMENT: 'test', WEBKASSA_REQUIRE_LIVE: 'true' },
      'environment_conflict',
      { expected: 'live|test' },
    ],
  ]) {
    const label = JSON.stringify(extra);
    const r = run(extra);
    assert.equal(r.status, 1, label + r.stderr);
    const events = r.stderr
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(events.length, 1, label);
    assert.equal(events[0].event, 'webkassa_cloud_mode_blocked', label);
    assert.equal(events[0].reason, reason, label);
    for (const [key, value] of Object.entries(more)) assert.equal(events[0][key], value, label);
    assert.equal(r.stdout, '', 'nothing issued: no tick output');
    assert.ok(!r.stderr.includes('synthetic') && !r.stderr.includes(dir), 'no secret or path');
  }
});

test('a matching mode is not blocked; an absent configuration stays plainly disabled', () => {
  const off = spawnSync(process.execPath, [worker, '--once'], {
    env: { PATH: process.env.PATH },
    encoding: 'utf8',
    timeout: 20_000,
  });
  assert.equal(off.status, 0);
  assert.match(off.stdout, /"state":"disabled"/);
  assert.equal(off.stderr, '');
  // devkkm + test passes the mode gate and then needs the database, which this run does not have.
  const ok = run({
    WEBKASSA_ACCOUNT_FILE: account('dev2.json', 'https://devkkm.webkassa.kz'),
    WEBKASSA_ENVIRONMENT: 'test',
  });
  assert.ok(!ok.stderr.includes('webkassa_cloud_mode_blocked'));
});
