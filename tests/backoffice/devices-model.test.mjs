import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DevicesModel, deviceStatus } from '../../apps/backoffice/dist/devices-model.js';
import { ApiError, allowedPath } from '../../apps/backoffice/dist/api.js';
const snapshot = (branch) => ({
  branch_id: branch,
  role: 'manager',
  devices: [],
  as_of: new Date().toISOString(),
});
test('late scope response cannot show another branch code or mutate fresh state', async () => {
  const branch = randomUUID(),
    other = randomUUID(),
    actor = randomUUID();
  let complete;
  const model = new DevicesModel(
    async (path, req) =>
      req
        ? new Promise((r) => {
            complete = r;
          })
        : snapshot(path.split('/')[1]),
    () => {},
  );
  await model.load(actor, branch);
  const pending = model.issue({ name: 'Board', mode: 'display', reason: 'Synthetic' });
  await model.load(actor, other);
  complete({
    code: 'a'.repeat(32).match(/.{4}/g).join('-'),
    device_id: randomUUID(),
    command_id: randomUUID(),
    expires_at: new Date(Date.now() + 600000).toISOString(),
  });
  assert.equal(await pending, false);
  assert.equal(model.code, null);
  assert.equal(model.branch, other);
  assert.equal(model.busy, false);
});
test('an unknown issue outcome sends exactly once and keeps no plaintext in persisted state', async () => {
  const branch = randomUUID();
  let sends = 0;
  const model = new DevicesModel(
    async (path, req) => {
      if (!req) return snapshot(branch);
      sends++;
      throw new ApiError('NETWORK');
    },
    () => {},
  );
  await model.load(randomUUID(), branch);
  assert.equal(await model.issue({ name: 'Board', mode: 'display', reason: 'Synthetic' }), false);
  assert.equal(sends, 1);
  assert.equal(model.uncertain, true);
  assert.equal(model.code, null);
  await model.load(model.actor, branch);
  assert.equal(sends, 1);
});
test('read-only actor cannot send; branch route allowlist stays exact', async () => {
  let sends = 0;
  const branch = randomUUID(),
    m = new DevicesModel(
      async () => {
        sends++;
        return { ...snapshot(branch), role: 'analyst' };
      },
      () => {},
    );
  await m.load(randomUUID(), branch);
  await assert.rejects(m.issue({}), { code: 'FORBIDDEN' });
  assert.equal(sends, 1);
  for (const path of [
    'devices',
    'devices/pairing-codes',
    'devices/revoke',
    'devices/' + randomUUID() + '/events',
  ])
    assert.equal(allowedPath(`operations/branches/${branch}/${path}`), true);
  for (const path of [
    'devices/credentials',
    'devices/../commands',
    'devices/pairing-codes?code=secret',
  ])
    assert.equal(allowedPath(`operations/branches/${branch}/${path}`), false);
});
test('edge availability is not misrepresented as browser online status', () => {
  const d = {
    kind: 'display',
    mode: 'display',
    status: 'active',
    paired_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString(),
    command_state: 'paired',
  };
  assert.equal(deviceStatus(d), 'Подключено');
  assert.equal(
    deviceStatus({ ...d, command_action: 'revoke', command_state: 'delivered' }),
    'Отключение ждёт кассу',
  );
});
