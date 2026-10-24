// Offline stand finding (stage 2, 24.10): the cashier header tells "no internet" apart from
// "no connection to the cashier server". An edge without the route keeps the old header.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { PosController, connectionLabel, CLOUD_LINK_POLL_MS } from '../../apps/pos/dist/model.js';
import { ApiError } from '../../apps/pos/dist/api.js';
import { createPosServer } from '../../apps/pos/server.mjs';

const memory = () => {
  const data = new Map();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => data.set(k, v),
    removeItem: (k) => data.delete(k),
  };
};
const actor = {
  staff_id: randomUUID(),
  terminal_id: randomUUID(),
  branch_id: randomUUID(),
  role: 'cashier',
  expires_at: new Date(Date.now() + 3600000).toISOString(),
};
const link = (state) => ({
  state,
  last_contact_at: state === 'unknown' ? null : new Date().toISOString(),
  checked_at: new Date().toISOString(),
});

test('header line: no actor, LAN down, internet down, all fine', () => {
  const base = { actor, operationsAvailable: true, operationsError: null, cloudLink: null };
  assert.deepEqual(connectionLabel({ ...base, actor: null, operationsAvailable: false }), {
    label: 'Вход по личному PIN',
    tone: 'down',
  });
  assert.deepEqual(connectionLabel(base), { label: 'Локальная сеть', tone: 'ok' });
  assert.deepEqual(connectionLabel({ ...base, cloudLink: link('online') }), {
    label: 'Локальная сеть',
    tone: 'ok',
  });
  assert.deepEqual(connectionLabel({ ...base, cloudLink: link('unknown') }), {
    label: 'Локальная сеть',
    tone: 'ok',
  });
  assert.deepEqual(connectionLabel({ ...base, cloudLink: link('offline') }), {
    label: 'Нет интернета · касса работает',
    tone: 'warn',
  });
  // No local connection wins: the cloud state the edge reported earlier is stale then.
  assert.deepEqual(
    connectionLabel({
      ...base,
      operationsError: new ApiError('EDGE_UNREACHABLE'),
      cloudLink: link('offline'),
    }),
    { label: 'Нет связи с кассой', tone: 'down' },
  );
});

test('the model reads the cloud link with the operations refresh, throttled; an old edge (404) is not asked again', async () => {
  let state = 'offline',
    calls = 0,
    missing = false;
  const api = async (path) => {
    if (path === 'cloud-link') {
      calls++;
      if (missing) throw new ApiError('NOT_FOUND', 404);
      return link(state);
    }
    if (path === 'session') return actor;
    if (path === 'cash-shifts/current')
      return { shift: null, server_time: new Date().toISOString() };
    if (path === 'cash-shifts') return { shifts: [], server_time: new Date().toISOString() };
    if (path === 'orders') return { orders: [], server_time: new Date().toISOString() };
    throw new ApiError('NOT_FOUND', 404);
  };
  let now = 1_000_000;
  const controller = new PosController(
    api,
    memory(),
    memory(),
    randomUUID,
    undefined,
    undefined,
    () => now,
  );
  controller.state.actor = actor;
  controller['credential'] = { ...actor, session_id: randomUUID(), token: 'a'.repeat(64) };
  await controller.refreshOperations();
  assert.equal(controller.state.operationsAvailable, true);
  assert.equal(controller.state.cloudLink.state, 'offline');
  assert.equal(calls, 1);
  state = 'online';
  await controller.refreshOperations();
  assert.equal(calls, 1, 'throttled');
  now += CLOUD_LINK_POLL_MS;
  await controller.refreshOperations();
  assert.equal(controller.state.cloudLink.state, 'online');
  missing = true;
  now += CLOUD_LINK_POLL_MS;
  await controller.refreshOperations();
  assert.equal(controller.state.cloudLink, null);
  assert.equal(controller.state.operationsAvailable, true, 'an old edge keeps working');
  now += CLOUD_LINK_POLL_MS;
  await controller.refreshOperations();
  assert.equal(calls, 3, 'an edge without the route is not asked every poll');
});

test('the loopback POS server forwards GET cloud-link and nothing else on that path', async () => {
  const seen = [];
  const edge = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(link('online')));
  });
  await new Promise((resolve) => edge.listen(0, '127.0.0.1', resolve));
  const proxy = createPosServer({ edgePort: edge.address().port });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${proxy.address().port}`;
  try {
    const headers = {
      Authorization: 'Bearer ' + 'a'.repeat(64),
      'X-Staff-Session-Id': randomUUID(),
    };
    const response = await fetch(`${url}/edge/v1/cloud-link`, { headers });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).state, 'online');
    const post = await fetch(`${url}/edge/v1/cloud-link`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(post.status, 404);
    assert.deepEqual(seen, ['GET /edge/v1/cloud-link']);
  } finally {
    await new Promise((resolve) => proxy.close(resolve));
    await new Promise((resolve) => edge.close(resolve));
  }
});
