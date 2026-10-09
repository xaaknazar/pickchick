import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { assertDeviceRevocation } from '../../packages/backoffice-core/dist/device-access.js';
import { Command } from '../../packages/backoffice-core/dist/model.js';
import {
  DeviceAccessCommandSchema,
  DeviceAccessExchangeSchema,
  TerminalPairRequestSchema,
} from '../../packages/contracts/dist/index.js';
import {
  hashDeviceCode,
  deviceAccessEnabled,
} from '../../packages/backoffice-core/dist/device-registry.js';

test('edge revocation is rejected independently of name/status and forged client kinds', () => {
  for (const status of ['pending', 'active', 'revoked'])
    assert.throws(
      () => assertDeviceRevocation({ kind: 'edge', status, name: 'Cashier' }, 'Cashier'),
      { code: 'CONFLICT', reason: 'EDGE_REVOKE_REQUIRES_REPLACEMENT_PROTOCOL' },
    );
  assert.equal(
    Command.safeParse({
      type: 'revoke_device',
      id: randomUUID(),
      confirm_name: 'Screen',
      kind: 'display',
    }).success,
    false,
  );
});
test('kiosk identity cannot be half-revoked through the generic cloud devices command', () => {
  assert.throws(
    () => assertDeviceRevocation({ kind: 'kiosk', status: 'active', name: 'iPad' }, 'iPad'),
    { reason: 'KIOSK_REVOKE_REQUIRES_SESSION_PROTOCOL' },
  );
});
test('revocation requires explicit exact name; command cannot omit confirmation', () => {
  assert.throws(
    () => assertDeviceRevocation({ kind: 'display', status: 'active', name: 'Kitchen' }, 'Other'),
    { reason: 'DEVICE_NAME_CONFIRMATION_REQUIRED' },
  );
  assert.doesNotThrow(() =>
    assertDeviceRevocation({ kind: 'display', status: 'active', name: 'Kitchen' }, 'Kitchen'),
  );
  assert.equal(Command.safeParse({ type: 'revoke_device', id: randomUUID() }).success, false);
});
test('pair code normalizes only separators/case, preserves entropy; access flag is fail closed', () => {
  const code = 'a'.repeat(32);
  assert.equal(
    TerminalPairRequestSchema.parse({ code: code.match(/.{4}/g).join('-').toUpperCase() }).code,
    code,
  );
  for (const code of ['123456', 'a'.repeat(31), 'g'.repeat(32), 'a'.repeat(64)])
    assert.equal(TerminalPairRequestSchema.safeParse({ code }).success, false);
  assert.equal(hashDeviceCode(code).length, 64);
  assert.notEqual(hashDeviceCode(code), code);
  assert.equal(deviceAccessEnabled({}), false);
  assert.throws(() => deviceAccessEnabled({ BACKOFFICE_DEVICE_ACCESS_ENABLED: 'yes' }));
});
test('mailbox rejects arbitrary roles, money actions, cross protocol fields and unbounded lifetime', () => {
  const cmd = {
    commandId: randomUUID(),
    branchId: randomUUID(),
    edgeDeviceId: randomUUID(),
    terminalId: randomUUID(),
    mode: 'display',
    name: 'Board',
    generation: 1,
    action: 'pair',
    codeHash: 'a'.repeat(64),
    issuedAt: '2026-10-09T10:00:00.000Z',
    expiresAt: '2026-10-09T10:10:00.000Z',
  };
  assert.equal(DeviceAccessCommandSchema.safeParse(cmd).success, true);
  for (const change of [
    { mode: 'pos' },
    { action: 'payment' },
    { codeHash: null },
    { generation: 0 },
    { expiresAt: '2026-10-09T10:10:01.000Z' },
  ])
    assert.equal(DeviceAccessCommandSchema.safeParse({ ...cmd, ...change }).success, false);
  assert.equal(
    DeviceAccessExchangeSchema.safeParse({ protocolVersion: 1, receipts: [], orders: [] }).success,
    false,
  );
});
