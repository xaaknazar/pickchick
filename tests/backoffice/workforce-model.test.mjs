import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { WorkforceModel } from '../../apps/backoffice/dist/workforce-model.js';
import { ApiError } from '../../apps/backoffice/dist/api.js';
const storage = () => {
  const values = new Map();
  return {
    getItem: (k) => values.get(k) ?? null,
    setItem: (k, v) => values.set(k, v),
    removeItem: (k) => values.delete(k),
  };
};
const snapshot = (branch, month, role = 'manager') => ({
  branch_id: branch,
  month,
  role,
  records: [],
  employees: [],
  audit: [],
  calculation: { lines: [], issues: [], total_minor: '0' },
  period: { closed: false, revision: 0, snapshot: null },
});

test('unknown command result survives reload and replays the same ID; no second command', async () => {
  const branch = randomUUID(),
    actor = randomUUID(),
    store = storage(),
    calls = [];
  let lost = true;
  const api = async (path, request) => {
    if (!request) return snapshot(branch, '2026-09-01');
    calls.push(request.body);
    if (lost) throw new ApiError('NETWORK_ERROR');
    return { id: request.body.command.id, revision: 1 };
  };
  const model = new WorkforceModel(api, store, () => {});
  model.month = '2026-09-01';
  await model.scope(actor, branch);
  const command = {
    type: 'save',
    kind: 'time',
    id: randomUUID(),
    expected_revision: 0,
    payload: {},
  };
  assert.equal(await model.send(command, 'Проверка потерянного ответа'), false);
  assert.ok(model.pending);
  assert.equal(model.writable, false);
  await model.send(command, 'Нельзя отправить второй запрос');
  assert.equal(calls.length, 1);
  const restored = new WorkforceModel(api, store, () => {});
  restored.month = '2026-09-01';
  await restored.scope(actor, branch);
  lost = false;
  assert.equal(await restored.recover(), true);
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(restored.pending, null);
  assert.equal(restored.writable, true);
});

test('stale revision errors permit correction; permission/network errors retain uncertain result', async () => {
  const branch = randomUUID(),
    actor = randomUUID();
  let error = new ApiError('CONFLICT', 409);
  const model = new WorkforceModel(
    async (_p, r) => {
      if (r) throw error;
      return snapshot(branch, '2026-09-01');
    },
    storage(),
    () => {},
  );
  model.month = '2026-09-01';
  await model.scope(actor, branch);
  await model.send({ type: 'save' }, 'Исправление записи');
  assert.equal(model.pending, null);
  error = new ApiError('FORBIDDEN', 403);
  await model.send({ type: 'save' }, 'Повторная проверка');
  assert.ok(model.pending);
  await model.scope(actor, randomUUID());
  assert.equal(model.branch, branch);
});

test('read-only actor and broken storage cannot write; wrong month is not accepted', async () => {
  const branch = randomUUID();
  let posts = 0;
  const api = async (_p, r) => {
    if (r) posts++;
    return snapshot(branch, '2026-09-01', 'analyst');
  };
  const model = new WorkforceModel(api, storage(), () => {});
  model.month = '2026-09-01';
  await model.scope(randomUUID(), branch);
  await model.send({}, 'Запрещённая запись');
  assert.equal(posts, 0);
  assert.equal(model.writable, false);
  model.month = '2026-10-01';
  await model.load();
  assert.equal(model.data, null);
  const broken = new WorkforceModel(
    async () => snapshot(branch, '2026-09-01'),
    {
      getItem: () => null,
      setItem: () => {
        throw Error('storage blocked');
      },
      removeItem: () => {},
    },
    () => {},
  );
  broken.month = '2026-09-01';
  await broken.scope(randomUUID(), branch);
  assert.equal(await broken.send({}, 'Не отправлять без журнала'), false);
  assert.equal(broken.writable, false);
});

test('employee edit uses existing employee command with stable receipt', async () => {
  const branch = randomUUID(),
    calls = [];
  const model = new WorkforceModel(
    async (path, r) => {
      if (!r) return snapshot(branch, '2026-09-01');
      calls.push({ path, body: r.body });
      return { id: r.body.command.id };
    },
    storage(),
    () => {},
  );
  model.month = '2026-09-01';
  await model.scope(randomUUID(), branch);
  await model.send(
    { type: 'employee', id: randomUUID(), expected_revision: 0, payload: { name: 'Synthetic' } },
    'Новый сотрудник',
  );
  assert.equal(calls[0].path, `branches/${branch}/commands`);
  assert.equal(calls[0].body.command.type, 'save');
  assert.equal(calls[0].body.command.kind, 'employee');
});
