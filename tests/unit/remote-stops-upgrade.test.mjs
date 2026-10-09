import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { edgeRuntimeGrantSql } from '../../infra/windows/edge-runtime-grants.mjs';
import { fulfillmentWorkerGrants } from '../../infra/windows/fulfillment-worker-grants.mjs';
import {
  REMOTE_STOPS_RUNTIME_ROLE,
  REMOTE_STOPS_WORKER_ROLE,
  readRemoteStopMigrations,
  remoteStopAclEntries,
  remoteStopGrantSql,
  upgradeRemoteStops,
  verifyBackupArchive,
} from '../../infra/windows/remote-stops-upgrade-db.mjs';

const appRoot = fileURLToPath(new URL('../../', import.meta.url));
const script = fileURLToPath(
  new URL('../../infra/windows/remote-stops-upgrade-db.mjs', import.meta.url),
);
const branchId = '7a6f6d98-395d-4462-b5e4-b0364a4a8ec1';
/** Statement set, whitespace and identifier quoting normalized. */
const statements = (sql) =>
  sql
    .split('\n')
    .map((line) => line.replaceAll('"', '').replaceAll(' ', ''))
    .filter(Boolean)
    .sort();
const delta = (withStops, without) => {
  const base = new Set(statements(without));
  return statements(withStops).filter((line) => !base.has(line));
};

test('runtime grants equal the remoteStops delta of the edge runtime grant reset', () => {
  const sql = remoteStopGrantSql({ runtimeRole: 'edge_runtime', workerRole: 'worker' });
  const runtime = statements(sql).filter((line) => line.endsWith('TOedge_runtime;'));
  assert.deepEqual(
    runtime,
    delta(
      edgeRuntimeGrantSql('edge_runtime', { remoteStops: true }),
      edgeRuntimeGrantSql('edge_runtime'),
    ),
  );
  // With every other capability on, the remote-stop delta is the same.
  const all = { fulfillment: true, cashierReports: true, menuMedia: true };
  assert.deepEqual(
    runtime,
    delta(
      edgeRuntimeGrantSql('edge_runtime', { ...all, remoteStops: true }),
      edgeRuntimeGrantSql('edge_runtime', all),
    ),
  );
});

test('worker grants equal the remoteStops delta of the fulfillment worker grants', () => {
  const sql = remoteStopGrantSql({ runtimeRole: 'edge_runtime', workerRole: 'worker' });
  assert.deepEqual(
    statements(sql).filter((line) => line.endsWith('TOworker;')),
    delta(
      fulfillmentWorkerGrants('worker', 'public', { remoteStops: true }),
      fulfillmentWorkerGrants('worker', 'public'),
    ),
  );
  // Least privilege: the worker never writes stops, verdicts or history; the runtime never
  // fills the inbox nor marks reports.
  assert.doesNotMatch(
    sql,
    /DELETE|TRUNCATE|ALL|local_stop_events" TO "worker"|INSERT ON "public"\."local_stops"|UPDATE\("state"[^)]*\) ON "public"\."remote_stop_commands" TO "worker"/,
  );
  assert.doesNotMatch(
    sql,
    /reported_at[^\n]*TO "edge_runtime"|INSERT[^\n]*remote_stop_commands[^\n]*TO "edge_runtime"/,
  );
  assert.equal(sql.split('\n').length, 8);
});

test('ACL entries cover every column grant and default to the cashier roles', () => {
  const entries = remoteStopAclEntries();
  assert.equal(REMOTE_STOPS_RUNTIME_ROLE, 'pickchick_edge_runtime');
  assert.equal(REMOTE_STOPS_WORKER_ROLE, 'pickchick_fulfillment_sync');
  assert.ok(entries.includes('pickchick_edge_runtime|local_stops|source|UPDATE'));
  assert.ok(entries.includes('pickchick_edge_runtime|remote_stop_commands||SELECT'));
  assert.ok(entries.includes('pickchick_edge_runtime|local_stop_events||INSERT'));
  assert.ok(entries.includes('pickchick_fulfillment_sync|remote_stop_commands|reported_at|UPDATE'));
  assert.ok(entries.includes('pickchick_fulfillment_sync|remote_stop_commands|issued_at|INSERT'));
  assert.ok(
    !entries.some((entry) => entry.startsWith('pickchick_fulfillment_sync|local_stop_events')),
  );
  assert.equal(entries.length, 1 + 1 + 3 + 1 + 3 + 6 + 9 + 1);
  assert.throws(() => remoteStopGrantSql({ runtimeRole: 'same', workerRole: 'same' }), /Separate/);
  assert.throws(() => remoteStopGrantSql({ workerRole: 'Bad"role' }), /Invalid identifier/);
  assert.throws(() => remoteStopGrantSql({ schema: 'public;drop' }), /Invalid identifier/);
});

test('candidate migrations must contain the reviewed 018 and 019 in order', async () => {
  const expected = await readRemoteStopMigrations(appRoot);
  assert.equal(expected[17].version, '018_edge_menu_publication.sql');
  assert.equal(expected[18].version, '019_edge_remote_stops.sql');
  assert.equal(
    expected[18].checksum,
    '3aa628b93a642f62f50b551510a1c39c14ff278e9c47f7ba288c93ddc409f98d',
  );
  const root = await mkdtemp(join(tmpdir(), 'pickchick-remote-stops-app-'));
  try {
    const dir = join(root, 'db', 'edge', 'migrations');
    await mkdir(dir, { recursive: true });
    const source = join(appRoot, 'db', 'edge', 'migrations');
    for (const name of (await readdir(source)).filter((n) => n < '019'))
      await copyFile(join(source, name), join(dir, name));
    await assert.rejects(readRemoteStopMigrations(root), /including 018 and 019/);
    await writeFile(join(dir, '020_edge_remote_stops.sql'), 'SELECT 1;');
    await assert.rejects(readRemoteStopMigrations(root), /including 018 and 019/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('upgrade scope is validated before any database statement', async () => {
  const queries = [];
  const client = { query: async (sql) => queries.push(sql) };
  const base = { mode: 'inspect', appRoot, branchId, backup: {} };
  for (const patch of [
    { mode: 'reset' },
    { branchId: 'not-a-branch' },
    { runtimeRole: 'pickchick_fulfillment_sync' },
  ])
    await assert.rejects(upgradeRemoteStops(client, { ...base, ...patch }), /Invalid remote stop/);
  await assert.rejects(
    upgradeRemoteStops(client, { ...base, schema: 'Public' }),
    /Invalid identifier/,
  );
  assert.deepEqual(queries, []);
});

test('backup archive must match its manifest size, hash and cluster', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pickchick-remote-stops-backup-'));
  try {
    const bytes = Buffer.from('synthetic custom-format archive');
    await writeFile(join(root, 'pickchick_edge.dump'), bytes);
    const manifestPath = join(root, 'backup-manifest.json');
    const manifest = {
      sha256: createHash('sha256').update(bytes).digest('hex'),
      archiveBytes: bytes.length,
      systemIdentifier: '7390000000000000001',
    };
    const state = { systemIdentifier: '7390000000000000001' };
    await verifyBackupArchive(manifestPath, manifest, state);
    for (const [patch, foundation] of [
      [{ sha256: 'a'.repeat(64) }, state],
      [{ archiveBytes: bytes.length + 1 }, state],
      [{ systemIdentifier: '7390000000000000002' }, state],
      [{}, { systemIdentifier: '7390000000000000002' }],
      [{ systemIdentifier: undefined }, { systemIdentifier: undefined }],
    ])
      await assert.rejects(
        verifyBackupArchive(manifestPath, { ...manifest, ...patch }, foundation),
        /differs from its manifest/,
      );
    const linked = join(root, 'linked');
    await mkdir(linked);
    await symlink(join(root, 'pickchick_edge.dump'), join(linked, 'pickchick_edge.dump'));
    await assert.rejects(
      verifyBackupArchive(join(linked, 'backup-manifest.json'), manifest, state),
      /differs from its manifest/,
    );
    await assert.rejects(
      verifyBackupArchive(join(tmpdir(), 'missing', 'backup-manifest.json'), manifest, state),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI refuses unsafe invocations with a sanitized message', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pickchick-remote-stops-cli-'));
  const manifest = join(root, 'backup-manifest.json');
  try {
    for (const args of [
      [],
      ['apply', root, root, branchId],
      ['reset', root, root, branchId, manifest],
      ['apply', 'relative', root, branchId, manifest],
      ['apply', root, root, 'not-a-branch', manifest],
      ['apply', root, root, branchId, join(root, 'other.json')],
      ['apply', root, root, branchId, manifest, '--force'],
      // Valid shape, but no protected foundation credentials exist here.
      ['inspect', root, root, branchId, manifest],
    ])
      await assert.rejects(
        promisify(execFile)(process.execPath, [script, ...args]),
        (error) =>
          error.code === 1 &&
          error.stdout === '' &&
          JSON.parse(error.stderr).event === 'remote_stops_upgrade_failed',
      );
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
