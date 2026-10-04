import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createFarm, applyFarmCommand } from '../../packages/farm-game/dist/index.js';
import {
  FarmClient,
  FarmClientError,
  farmRequest,
} from '../../apps/mobile/src/games/pick-farm/api.ts';

const plant = { type: 'plant', plotId: 0, cropId: 'carrot' };
function fixture() {
  let raw = null;
  let state = applyFarmCommand(createFarm(1000), { type: 'buyPlot', x: 31, y: 31 }, 1000);
  let lose = false;
  let reject = false;
  let failWrite = false;
  const receipts = new Set();
  const sent = [];
  const io = {
    read: async () => raw,
    write: async (value) => {
      if (failWrite) throw Error('storage');
      raw = value;
    },
    randomId: randomUUID,
    request: async (intent) => {
      if (intent) {
        assert.ok(raw, 'intent must be durable before POST');
        sent.push(intent);
        if (reject) throw new FarmClientError('STALE_STATE', 409);
        if (!receipts.has(intent.commandId)) {
          state = applyFarmCommand(state, intent.command, 1000);
          receipts.add(intent.commandId);
        }
        if (lose) {
          lose = false;
          throw new FarmClientError('NETWORK_UNAVAILABLE');
        }
      }
      return { state, serverNow: 1000 };
    },
  };
  return {
    io,
    sent,
    get raw() {
      return raw;
    },
    get state() {
      return state;
    },
    lose: () => {
      lose = true;
    },
    reject: () => {
      reject = true;
    },
    failWrite: () => {
      failWrite = true;
    },
    advance: () => {
      state = applyFarmCommand(state, { type: 'movePlot', plotId: 0, x: 33, y: 33 }, 1000);
    },
  };
}
test('lost response survives restart and retries one immutable intent without another effect', async () => {
  const f = fixture();
  const first = new FarmClient(f.io);
  await first.refresh();
  f.lose();
  await assert.rejects(first.send(plant), { code: 'NETWORK_UNAVAILABLE' });
  await assert.rejects(first.send({ ...plant, plotId: 1 }), { code: 'PENDING_RECOVERY' });
  const saved = JSON.parse(f.raw);
  const coins = f.state.coins;
  f.advance(); // Another device has moved canonical state on after the lost response.
  const restarted = new FarmClient(f.io);
  const recovered = await restarted.refresh();
  assert.equal(f.sent.length, 2);
  assert.deepEqual(f.sent[1], saved);
  assert.equal(recovered.state.revision, 3);
  assert.equal(recovered.state.coins, coins);
  assert.equal(f.raw, null);
});
test('definite conflict discards rejected intent and refreshes without retrying new action', async () => {
  const f = fixture();
  const client = new FarmClient(f.io);
  await client.refresh();
  f.reject();
  await assert.rejects(client.send(plant), { code: 'STALE_STATE' });
  assert.equal(f.raw, null);
  assert.equal(client.snapshot.state.revision, 1);
  assert.equal(f.sent.length, 1);
});
test('failed durable write never sends a command', async () => {
  const f = fixture();
  const client = new FarmClient(f.io);
  await client.refresh();
  f.failWrite();
  await assert.rejects(client.send(plant));
  assert.equal(f.sent.length, 0);
});
test('concurrent gestures cannot overwrite an in-flight intent', async () => {
  const f = fixture();
  let release;
  const wait = new Promise((resolve) => {
    release = resolve;
  });
  const client = new FarmClient({
    ...f.io,
    request: async (intent) => {
      if (intent) await wait;
      return f.io.request(intent);
    },
  });
  await client.refresh();
  const running = client.send(plant);
  await assert.rejects(client.send({ ...plant, plotId: 1 }), { code: 'BUSY' });
  release();
  await running;
  assert.equal(f.sent.length, 1);
});
test('corrupt pending state does not silently reset or send a new action', async () => {
  const f = fixture();
  const client = new FarmClient({ ...f.io, read: async () => '{broken' });
  await assert.rejects(client.refresh(), { code: 'RECOVERY_REQUIRED' });
  assert.equal(f.sent.length, 0);
});
test('HTTPS transport validates response, uses bearer header and preserves auth failure status', async () => {
  for (const url of [
    'http://example.test',
    'https://user:pass@example.test',
    'https://example.test/else',
  ])
    assert.throws(() => farmRequest(url), { code: 'INVALID_API_URL' });
  const f = fixture();
  let request;
  const send = farmRequest('https://example.test', async (url, init) => {
    request = { url, ...init };
    return Response.json({ state: f.state, serverNow: 1000 });
  });
  assert.equal((await send('synthetic-token')).state.coins, 350);
  assert.equal(request.headers.Authorization, 'Bearer synthetic-token');
  assert.equal(request.redirect, 'error');
  assert.equal(request.cache, 'no-store');
  assert.equal(request.url, 'https://example.test/v1/customer-farm');
  await assert.rejects(
    farmRequest('https://example.test', async () =>
      Response.json({ code: 'UNAUTHORIZED' }, { status: 401 }),
    )('test'),
    { status: 401 },
  );
  await assert.rejects(
    farmRequest('https://example.test', async () => Response.json({ state: {}, serverNow: 1000 }))(
      'test',
    ),
    { code: 'INVALID_RESPONSE' },
  );
  await assert.rejects(
    farmRequest('https://example.test', async () => Response.json('x'.repeat(1048577)))('test'),
    { code: 'INVALID_RESPONSE' },
  );
});
