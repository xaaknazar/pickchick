import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { EdgeBackupAttentionSchema } from '@pickchick/fulfillment-transport';
import { backupStatus } from '../../infra/windows/edge-backup-lib.mjs';
import {
  backupAttention,
  readBackupAttention,
} from '../../infra/windows/native-fulfillment-worker.mjs';

const now = Date.parse('2026-10-24T12:00:00.000Z');
const record = (change = {}) => ({
  format: 'pickchick-edge-backup-status-v1',
  state: 'ok',
  error: null,
  warning: null,
  lastAttemptAt: '2026-10-24T11:37:00.000Z',
  lastSuccessAt: '2026-10-24T11:37:40.000Z',
  schema: 'schema020',
  copies: 12,
  archiveBytes: 1234,
  durationMs: 40000,
  keyId: '0123456789abcdef',
  maxAgeMinutes: 120,
  reportInHeartbeat: true,
  ...change,
});

test('heartbeat attention only while the last verified copy is older than its limit', () => {
  assert.equal(backupAttention(record(), now), null);
  // A single failed run after a fresh copy is not yet an alarm.
  assert.equal(backupAttention(record({ state: 'failed', error: 'DUMP_FAILED' }), now), null);
  assert.deepEqual(backupAttention(record({ lastSuccessAt: '2026-10-24T09:00:00.000Z' }), now), {
    state: 'stale',
    ageMinutes: 180,
    maxAgeMinutes: 120,
    error: null,
  });
  assert.deepEqual(
    backupAttention(
      record({
        state: 'failed',
        error: 'DESTINATION_UNAVAILABLE',
        lastSuccessAt: '2026-10-24T09:59:00.000Z',
      }),
      now,
    ),
    { state: 'failed', ageMinutes: 121, maxAgeMinutes: 120, error: 'DESTINATION_UNAVAILABLE' },
  );
  // Never succeeded (for example an unreviewed schema after a release).
  assert.deepEqual(
    backupAttention(
      record({ state: 'failed', error: 'UNREVIEWED_SCHEMA', lastSuccessAt: null }),
      now,
    ),
    { state: 'failed', ageMinutes: null, maxAgeMinutes: 120, error: 'UNREVIEWED_SCHEMA' },
  );
  // Skipped runs (maintenance) count as stale once the copy is too old.
  assert.equal(
    backupAttention(
      record({ state: 'skipped', error: 'MAINTENANCE', lastSuccessAt: '2026-10-23T12:00:00.000Z' }),
      now,
    ).state,
    'stale',
  );
  // Reporting is the owner's choice at install time; off means nothing is sent.
  assert.equal(
    backupAttention(record({ reportInHeartbeat: false, lastSuccessAt: null }), now),
    null,
  );
  for (const broken of [
    null,
    'text',
    record({ format: 'other', lastSuccessAt: null }),
    record({ maxAgeMinutes: 10, lastSuccessAt: null }),
    record({ maxAgeMinutes: '120', lastSuccessAt: null }),
  ])
    assert.equal(backupAttention(broken, now), null);
  // Free text never leaves the cashier; a clock behind the record never yields a negative age.
  assert.equal(
    backupAttention(
      record({ state: 'failed', error: 'secret path C:\\x', lastSuccessAt: null }),
      now,
    ).error,
    null,
  );
  assert.equal(backupAttention(record({ lastSuccessAt: '2026-10-24T13:00:00.000Z' }), now), null);
});

test('every attention the worker can build is accepted by the transport contract', () => {
  const config = { maxAgeMinutes: 120, reportInHeartbeat: true };
  for (const [state, error] of [
    ['failed', 'DUMP_FAILED'],
    ['failed', 'UNREVIEWED_SCHEMA'],
    ['skipped', 'MAINTENANCE'],
    ['ok', null],
  ]) {
    const status = backupStatus({
      state,
      error,
      startedAt: new Date(now - 10 * 3600_000),
      finishedAt: new Date(now - 10 * 3600_000 + 5000),
      config,
    });
    const attention = backupAttention(status, now);
    assert.ok(attention, state);
    assert.equal(EdgeBackupAttentionSchema.safeParse(attention).success, true, state);
  }
});

test('the health record is read defensively from its fixed file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pickchick-backup-health-'));
  try {
    const file = join(dir, 'status.json');
    assert.equal(await readBackupAttention(file, now), null); // backup not installed
    await writeFile(file, JSON.stringify(record({ lastSuccessAt: null })));
    assert.equal((await readBackupAttention(file, now)).ageMinutes, null);
    await writeFile(file, '{not json');
    assert.equal(await readBackupAttention(file, now), null);
    await writeFile(file, JSON.stringify(record({ lastSuccessAt: null, pad: 'x'.repeat(9000) })));
    assert.equal(await readBackupAttention(file, now), null);
    const link = join(dir, 'link.json');
    await writeFile(join(dir, 'target.json'), JSON.stringify(record({ lastSuccessAt: null })));
    await symlink(join(dir, 'target.json'), link);
    assert.equal(await readBackupAttention(link, now), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
