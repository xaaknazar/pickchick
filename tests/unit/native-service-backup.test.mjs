import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  SERVICE_BACKUP_SCHEMAS,
  expectedServiceLedger,
  verifyServiceSnapshot,
} from '../../infra/windows/backup-native-service.mjs';

const pinned = JSON.parse(
  await readFile(new URL('../../infra/windows/native-edge-backup-ledger.json', import.meta.url)),
);
const ledger = expectedServiceLedger(pinned);
const branchId = '11111111-1111-4111-8111-111111111111';
const branch = [{ id: branchId, ordering_enabled: true, pos_service_mode: 'unpaid_service' }];
const script = fileURLToPath(
  new URL('../../infra/windows/backup-native-service.mjs', import.meta.url),
);

test('backup accepts the reviewed active schema014 without closing ordering', () => {
  assert.equal(ledger.length, 14);
  assert.doesNotThrow(() => verifyServiceSnapshot(branch, ledger, branchId, ledger));
  assert.equal(branch[0].ordering_enabled, true);
});

test('backup rejects foreign branch, different service mode and changed migration', () => {
  assert.throws(() =>
    verifyServiceSnapshot(branch, ledger, '22222222-2222-4222-8222-222222222222', ledger),
  );
  assert.throws(() =>
    verifyServiceSnapshot(
      [{ ...branch[0], pos_service_mode: 'payment_required' }],
      ledger,
      branchId,
      ledger,
    ),
  );
  assert.throws(() => verifyServiceSnapshot(branch, ledger.slice(0, 9), branchId, ledger));
  const changed = ledger.map((row) => ({ ...row }));
  changed[13].checksum = '0'.repeat(64);
  assert.throws(() => verifyServiceSnapshot(branch, changed, branchId, ledger));
});

test('pinned ledger is exactly the reviewed edge migrations 001-020 of this repository', async () => {
  const dir = fileURLToPath(new URL('../../db/edge/migrations/', import.meta.url));
  // A later migration (021+) needs its own reviewed allowlist entry; it is not accepted here.
  const names = (await readdir(dir))
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .slice(0, 20);
  assert.equal(names.length, 20);
  assert.deepEqual(
    pinned,
    await Promise.all(
      names.map(async (version) => ({
        version,
        checksum: createHash('sha256')
          .update(await readFile(join(dir, version)))
          .digest('hex'),
        scope: 'edge',
      })),
    ),
  );
  // The schema014/015 pins of the original allowlist are unchanged.
  assert.equal(pinned[13].version, '014_pos_workspace.sql');
  assert.equal(
    pinned[13].checksum,
    '989f6cd9bd40ad74b054cfa0aea63e71d5676c98f5df38a340714a3b01f10b0d',
  );
  assert.equal(pinned[14].version, '015_edge_reserved_order_number.sql');
  assert.equal(
    pinned[14].checksum,
    '7c947122a370bf59e304404a4ef66e84a0e7aa7609621b9a110a3492113bbf8f',
  );
  assert.equal(pinned[17].version, '018_edge_menu_publication.sql');
  assert.equal(pinned[18].version, '019_edge_remote_stops.sql');
});

test('each reviewed schema014-020 accepts only its own exact ledger', () => {
  assert.deepEqual(Object.keys(SERVICE_BACKUP_SCHEMAS), [
    'schema014',
    'schema015',
    'schema016',
    'schema017',
    'schema018',
    'schema019',
    'schema020',
  ]);
  for (const [mode, length] of Object.entries(SERVICE_BACKUP_SCHEMAS)) {
    const expected = expectedServiceLedger(pinned, mode);
    assert.equal(expected.length, length);
    assert.equal(expected.at(-1).version.slice(0, 3), mode.slice(-3));
    assert.doesNotThrow(() => verifyServiceSnapshot(branch, expected, branchId, expected));
    // A cashier one schema behind or ahead of the named schema is refused.
    assert.throws(() =>
      verifyServiceSnapshot(branch, pinned.slice(0, length - 1), branchId, expected),
    );
    if (length < pinned.length)
      assert.throws(() =>
        verifyServiceSnapshot(branch, pinned.slice(0, length + 1), branchId, expected),
      );
    // Every migration is pinned by name and checksum.
    for (let index = 0; index < length; index += 1) {
      const checksum = expected.map((row) => ({ ...row }));
      checksum[index].checksum = 'f'.repeat(64);
      assert.throws(() => verifyServiceSnapshot(branch, checksum, branchId, expected));
      const renamed = expected.map((row) => ({ ...row }));
      renamed[index].version = renamed[index].version.replace('.sql', '_x.sql');
      assert.throws(() => verifyServiceSnapshot(branch, renamed, branchId, expected));
    }
  }
});

test('unknown schemas and a tampered pinned ledger fail closed', () => {
  for (const mode of [
    'schema013',
    'schema021',
    'SCHEMA019',
    '019',
    '',
    'toString',
    '__proto__',
    'constructor',
    null,
    19,
  ])
    assert.throws(() => expectedServiceLedger(pinned, mode), /Unreviewed edge schema/);
  // Even a caller-supplied ledger outside 14-20 entries is rejected.
  const thirteen = pinned.slice(0, 13);
  assert.throws(() => verifyServiceSnapshot(branch, thirteen, branchId, thirteen));
  const twenty = [...pinned, { version: '021_x.sql', checksum: 'a'.repeat(64), scope: 'edge' }];
  assert.throws(() => verifyServiceSnapshot(branch, twenty, branchId, twenty));
  for (const tampered of [
    pinned.slice(0, 18),
    [...pinned, { ...pinned[0] }],
    pinned.map((row, index) => (index === 3 ? { ...row, scope: 'cloud' } : row)),
    pinned.map((row, index) => (index === 3 ? { ...row, checksum: 'A'.repeat(64) } : row)),
    pinned.map((row, index) => (index === 3 ? { ...row, extra: true } : row)),
    pinned.map((row, index) => (index === 3 ? pinned[4] : row)),
    'not a ledger',
  ])
    assert.throws(() => expectedServiceLedger(tampered, 'schema019'), /Pinned service backup/);
});

test('backup CLI refuses an unreviewed schema before touching any file or database', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pickchick-backup-cli-'));
  try {
    for (const mode of ['schema021', 'schema013', 'toString'])
      await assert.rejects(
        promisify(execFile)(process.execPath, [script, root, root, root, branchId, mode]),
        (error) =>
          error.code === 1 &&
          error.stderr.includes('native_backup_failed') &&
          !error.stdout.includes('native_backup_verified'),
      );
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
