import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertCommittedInspection,
  recoveredResult,
  verifyWorkerLogin,
} from '../../infra/windows/device-access-recovery.mjs';
const inspected = () => ({
  mode: 'inspect',
  migrations: 20,
  migrationPending: false,
  migrationApplied: false,
  grantsVerified: true,
  roleExists: true,
  existingDataPreserved: true,
  managedTerminals: 0,
  fingerprint: 'a'.repeat(64),
  backupSha256: 'b'.repeat(64),
});
test('recovery accepts current committed020 and records its limited provenance', () => {
  const result = recoveredResult(inspected(), inspected(), {
    loginVerified: true,
    mailboxEmpty: true,
  });
  assert.equal(result.mode, 'inspect');
  assert.equal(result.migrationApplied, false);
  assert.equal(result.originalPreparationReceiptAvailable, false);
  assert.equal(result.recoveryVerification, 'read-only-current-state');
});
test('incomplete, pending, applied, unverified or already enrolled state cannot recover', () => {
  for (const [key, value] of Object.entries({
    mode: 'apply',
    migrations: 19,
    migrationPending: true,
    migrationApplied: true,
    grantsVerified: false,
    roleExists: false,
    existingDataPreserved: false,
    managedTerminals: 1,
    fingerprint: '',
    backupSha256: '',
  })) {
    assert.throws(() => assertCommittedInspection({ ...inspected(), [key]: value }));
  }
  assert.throws(() =>
    recoveredResult(
      inspected(),
      { ...inspected(), fingerprint: 'c'.repeat(64) },
      { loginVerified: true, mailboxEmpty: true },
    ),
  );
  assert.throws(() =>
    recoveredResult(inspected(), inspected(), { loginVerified: false, mailboxEmpty: true }),
  );
  assert.throws(() =>
    recoveredResult(inspected(), inspected(), { loginVerified: true, mailboxEmpty: false }),
  );
});
function mockClient(role = 'pickchick_device_access_sync', count = 0) {
  const calls = [];
  return {
    calls,
    async query(sql) {
      calls.push(sql);
      if (sql === 'SELECT current_user role') return { rows: [{ role }] };
      if (sql.startsWith('SELECT count')) return { rows: [{ count }] };
      return { rows: [] };
    },
  };
}
test('real login check is read-only, checks all mailboxes and always rolls back', async () => {
  const client = mockClient();
  assert.deepEqual(await verifyWorkerLogin(client), { loginVerified: true, mailboxEmpty: true });
  assert.equal(client.calls[0], 'BEGIN READ ONLY');
  assert.equal(client.calls.at(-1), 'ROLLBACK');
  assert.equal(client.calls.filter((s) => s.startsWith('SELECT count')).length, 3);
  for (const bad of [mockClient('pickchick_bootstrap'), mockClient(undefined, 1)]) {
    await assert.rejects(verifyWorkerLogin(bad));
    assert.equal(bad.calls.at(-1), 'ROLLBACK');
  }
});
