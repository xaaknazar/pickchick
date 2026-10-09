import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ApiError, request } from '../dist/api.js';
import { KitchenModel } from '../dist/model.js';
import { order } from '../dist/types.js';
const memory = () => {
  const values = new Map();
  return {
    values,
    getItem: (k) => values.get(k) ?? null,
    setItem: (k, v) => values.set(k, v),
    removeItem: (k) => values.delete(k),
  };
};
function fixture() {
  const actor = {
    session_id: randomUUID(),
    branch_id: randomUUID(),
    terminal_id: randomUUID(),
    staff_id: randomUUID(),
    role: 'kitchen',
    token: 'a'.repeat(64),
    expires_at: new Date(Date.now() + 3600000).toISOString(),
  };
  const prep = randomUUID(),
    assembly = randomUUID();
  const reads = async (path) => {
    if (path === '/edge/v1/session') {
      return Object.fromEntries(Object.entries(actor).filter(([key]) => key !== 'token'));
    }
    if (path.endsWith('/config')) return { enabled: true };
    if (path.endsWith('/stations'))
      return {
        branchId: actor.branch_id,
        items: [
          { id: prep, kind: 'prep', name: 'Prep' },
          { id: assembly, kind: 'assembly', name: 'Assembly' },
        ],
      };
    if (path.includes('/kitchen?')) return { items: [], nextAfterOrderId: null };
    if (path.includes('/display?')) return { items: [], nextAfterNumber: null };
    if (path === '/edge/v1/staff/logout') throw new ApiError('CONNECTION_UNKNOWN');
    throw new Error('Unexpected synthetic path');
  };
  return { actor, prep, assembly, reads };
}

test('password verifies terminal and live session, preserves grants and never enters browser storage or journal', async () => {
  const f = fixture(),
    session = memory(),
    durable = memory();
  const password = ' Synthetic password ';
  let logins = 0;
  const api = async (path, actor, body) => {
    if (path === '/edge/v1/staff/login') {
      logins++;
      assert.equal(actor, null);
      assert.deepEqual(body, { login: 'kitchen.one', password, terminal_id: f.actor.terminal_id });
      return f.actor;
    }
    return f.reads(path);
  };
  const model = new KitchenModel(api, session, durable, async () => () => {});
  await model.signInWithPassword(' Kitchen.One ', password, undefined);
  assert.equal(model.state.error, 'TERMINAL_NOT_CONFIGURED');
  assert.equal(logins, 0);
  await model.signInWithPassword(' Kitchen.One ', password, f.actor.terminal_id);
  assert.equal(model.state.actor.staff_id, f.actor.staff_id);
  assert.equal(model.state.stations.length, 2);
  await model.selectStation(f.assembly);
  assert.equal(model.state.stationId, f.assembly);
  assert(
    !JSON.stringify([model.state, ...session.values.values(), ...durable.values.values()]).includes(
      password,
    ),
  );
  durable.setItem('synthetic-recovery', 'preserved');
  model.logout();
  assert.equal(model.state.actor, null);
  assert.equal(session.values.size, 0);
  assert.equal(durable.getItem('synthetic-recovery'), 'preserved');
});

test('rate limit and wrong-terminal credential cannot activate stations; pending login cannot revive logout', async () => {
  const f = fixture();
  let count = 0,
    finish;
  const model = new KitchenModel(
    async (path) => {
      if (path === '/edge/v1/staff/login') {
        count++;
        if (count === 1) throw new ApiError('AUTH_RATE_LIMITED', 429, false, 60);
        if (count === 2) return { ...f.actor, terminal_id: randomUUID() };
        return new Promise((resolve) => {
          finish = resolve;
        });
      }
      return f.reads(path);
    },
    memory(),
    memory(),
    async () => () => {},
  );
  await model.signInWithPassword('kitchen.one', 'Synthetic password', f.actor.terminal_id);
  await model.signInWithPassword('other.login', 'Synthetic password', f.actor.terminal_id);
  assert.equal(count, 1);
  assert(model.retryLoginAt > Date.now());
  model.retryLoginAt = 0;
  await model.signInWithPassword('kitchen.one', 'Synthetic password', f.actor.terminal_id);
  assert.equal(model.state.error, 'SCOPE_MISMATCH');
  assert.equal(model.state.actor, null);
  const pending = model.signInWithPassword(
    'kitchen.one',
    'Synthetic password',
    f.actor.terminal_id,
  );
  model.logout();
  finish(f.actor);
  await pending;
  assert.equal(model.state.actor, null);
  assert.equal(model.state.stations.length, 0);
});

test('password transport uses no bearer and generic401, honors rate delay and accepts logout204 only', async () => {
  const old = globalThis.fetch,
    f = fixture();
  try {
    globalThis.fetch = async (path, init) => {
      assert.equal(path, '/edge/v1/staff/login');
      assert.equal(init.method, 'POST');
      assert.equal(init.redirect, 'error');
      // Managed identity is an HttpOnly same-origin cookie, never a JS bearer.
      assert.equal(init.credentials, 'same-origin');
      assert.equal(init.headers.Authorization, undefined);
      return new Response('{"private":"ignored"}', { status: 401 });
    };
    await assert.rejects(
      request('/edge/v1/staff/login', null, {
        login: 'synthetic',
        password: 'Synthetic password',
        terminal_id: f.actor.terminal_id,
      }),
      (e) => e.code === 'INVALID_LOGIN',
    );
    globalThis.fetch = async () =>
      new Response('', { status: 429, headers: { 'Retry-After': '60' } });
    await assert.rejects(
      request('/edge/v1/staff/login', null, {}),
      (e) => e.code === 'AUTH_RATE_LIMITED' && e.retryAfterSeconds === 60,
    );
    globalThis.fetch = async (_path, init) => {
      assert.equal(init.method, 'POST');
      return new Response(null, { status: 204 });
    };
    assert.equal(await request('/edge/v1/staff/logout', f.actor), null);
    await assert.rejects(
      request('/edge/v1/fulfillment/orders/' + randomUUID() + '/actions', f.actor, {}),
      (e) => e.code === 'INVALID_RESPONSE',
    );
  } finally {
    globalThis.fetch = old;
  }
});

test('canonical POS task channel and100 modifiers are readable without truncation', () => {
  const f = fixture(),
    taskId = randomUUID(),
    timestamp = new Date().toISOString();
  const source = {
    orderId: randomUUID(),
    branchId: f.actor.branch_id,
    version: 1,
    state: 'accepted',
    displayNumber: '5',
    routingVersion: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    assemblyStationId: f.assembly,
    channel: 'pos',
    serviceMode: 'takeaway',
    tasks: [
      {
        taskId,
        stationId: f.prep,
        version: 1,
        state: 'queued',
        kind: 'prep',
        details: {
          lineId: randomUUID(),
          productId: randomUUID(),
          title: 'Synthetic menu item',
          parentTitle: '',
          description: '',
          quantity: 1,
          modifiers: Array.from({ length: 100 }, () => ({
            groupId: randomUUID(),
            groupTitle: { ru: 'Group', kk: '-' },
            optionId: randomUUID(),
            label: { ru: 'Option', kk: '-' },
            quantity: 2,
            linkedProductId: null,
          })),
        },
      },
    ],
  };
  const parsed = order(source, f.actor.branch_id);
  assert.equal(parsed.channel, 'pos');
  assert.equal(parsed.tasks[0].details.modifiers.length, 100);
  assert.throws(() => order({ ...source, channel: 'invented' }, f.actor.branch_id));
});
