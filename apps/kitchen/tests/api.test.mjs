import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request, ApiError, configRetryDelayMs, loadConfig } from '../dist/api.js';
import { KitchenModel, allowedActions, journalKey } from '../dist/model.js';
const id = randomUUID;
class Store {
  map = new Map();
  getItem(k) {
    return this.map.get(k) ?? null;
  }
  setItem(k, v) {
    this.map.set(k, v);
  }
  removeItem(k) {
    this.map.delete(k);
  }
}
const standard = (code) =>
  JSON.stringify({ code, message_key: 'synthetic.error', trace_id: id(), retryable: false });
for (const [name, status, body, known] of [
  ['HTML401', 401, '<html>login</html>', false],
  ['malformedJSON401', 401, '{"code":', false],
  ['partial401', 401, '{"code":"UNAUTHORIZED"}', false],
  ['wrong-code403', 403, standard('WHATEVER'), false],
  ['wrong-pair403', 403, standard('CONFLICT'), false],
  ['invalid409', 409, '{"code":"CONFLICT"}', false],
  ['wrong-pair409', 409, standard('UNAUTHORIZED'), false],
  ['actualUNAUTHORIZED', 401, standard('UNAUTHORIZED'), true],
  ['actualFORBIDDEN', 403, standard('FORBIDDEN'), true],
  ['actualCONFLICT', 409, standard('CONFLICT'), true],
])
  test(`${name}: only validated schema/code/status may revoke or resolve conflict`, async () => {
    const old = globalThis.fetch;
    globalThis.fetch = async () =>
      new globalThis.Response(body, {
        status,
        headers: { 'Content-Type': name === 'HTML401' ? 'text/html' : 'application/json' },
      });
    try {
      let error;
      try {
        await request('/edge/v1/fulfillment/config', null);
      } catch (e) {
        error = e;
      }
      assert.ok(error instanceof ApiError);
      assert.equal(error.validated, known);
      assert.equal(error.status, known ? status : 0);
      const station = id(),
        branch = id(),
        actor = {
          session_id: id(),
          staff_id: id(),
          terminal_id: id(),
          branch_id: branch,
          role: 'kitchen',
          token: 'a'.repeat(64),
          expires_at: new Date(Date.now() + 100000).toISOString(),
        };
      const order = {
        orderId: id(),
        branchId: branch,
        version: 1,
        state: 'accepted',
        displayNumber: '1',
        routingVersion: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        assemblyStationId: id(),
        channel: 'mobile',
        serviceMode: 'takeaway',
        tasks: [
          {
            taskId: id(),
            stationId: station,
            version: 1,
            state: 'queued',
            kind: 'prep',
            details: {
              lineId: id(),
              productId: 'burger',
              title: 'Burger',
              parentTitle: '',
              description: '',
              quantity: 1,
              modifiers: [],
            },
          },
        ],
      };
      const session = new Store(),
        durable = new Store();
      const m = new KitchenModel(
        async (path, c, body) => {
          if (body) throw error;
          if (path.endsWith('/config')) return { enabled: true };
          if (path.endsWith('/stations'))
            return { branchId: branch, items: [{ id: station, kind: 'prep', name: 'Prep' }] };
          if (path.includes('/kitchen?')) return { items: [order], nextAfterOrderId: null };
          return order;
        },
        session,
        durable,
        async () => () => {},
      );
      await m.importCredential(JSON.stringify(actor));
      await m.command(m.state.orders[0], allowedActions(m.state.orders[0], station)[0]);
      assert.ok(durable.getItem(journalKey(actor)));
      assert.equal(m.state.actor === null, known && status !== 409);
      assert.equal(m.state.conflict, known && status === 409);
    } finally {
      globalThis.fetch = old;
    }
  });

test('config.json: a failing or slow gateway is waited for, never taken for the local default', async () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 60].map(configRetryDelayMs),
    [1000, 2000, 4000, 8000, 15000, 15000, 15000],
  );
  const cloud = {
    cloudKitchen: true,
    cloudPaired: true,
    terminalId: id(),
    branchLabel: 'PickChick',
  };
  const json = (value, status = 200) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const read = async (answers) => {
    const calls = [],
      waits = [],
      failures = [];
    const config = await loadConfig({
      fetch: async (url, init) => {
        calls.push({ url, init });
        const answer = answers.shift();
        if (answer instanceof Error) throw answer;
        return answer;
      },
      wait: async (milliseconds) => void waits.push(milliseconds),
      onFailure: (count) => failures.push(count),
    });
    return { config, calls, waits, failures };
  };
  // The first answer is used as it is; the request never follows a redirect.
  const first = await read([json(cloud)]);
  assert.deepEqual(first.config, cloud);
  assert.deepEqual(first.waits, []);
  assert.equal(first.calls[0].url, '/config.json');
  assert.equal(first.calls[0].init.redirect, 'error');
  assert.equal(first.calls[0].init.credentials, 'same-origin');
  // 5xx, a timeout, HTML from a proxy and a non-object body: all repeated with a growing pause.
  const slow = await read([
    json({ code: 'SERVICE_UNAVAILABLE' }, 503),
    Object.assign(new Error('timeout'), { name: 'TimeoutError' }),
    new Response('<html>Bad gateway</html>', { status: 502 }),
    new Response('<html>login</html>', { status: 200 }),
    json([cloud]),
    json(null),
    json(cloud),
  ]);
  assert.deepEqual(slow.config, cloud, 'a cloud screen stays a cloud screen');
  assert.deepEqual(slow.failures, [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(slow.waits, [1000, 2000, 4000, 8000, 15000, 15000]);
  // A file that does not exist on this install is the local default, at once.
  for (const missing of [
    json({ code: 'NOT_FOUND' }, 404),
    new Response('Not found', { status: 404 }),
  ]) {
    const local = await read([missing]);
    assert.deepEqual(local.config, {});
    assert.deepEqual(local.failures, []);
    assert.equal(local.calls.length, 1);
  }
});
