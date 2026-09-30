import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { verifyServiceSnapshot } from '../../infra/windows/backup-native-service.mjs';

const ledger = JSON.parse(
  await readFile(new URL('../../infra/windows/native-service-backup-ledger.json', import.meta.url)),
);
const branchId = '11111111-1111-4111-8111-111111111111';
const branch = [{ id: branchId, ordering_enabled: true, pos_service_mode: 'unpaid_service' }];

test('backup accepts the reviewed active schema014 without closing ordering', () => {
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
