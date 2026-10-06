import test from 'node:test';
import assert from 'node:assert/strict';
import { createFarm, applyFarmCommand } from '../../packages/farm-game/dist/index.js';
import { FarmPipeline } from '../../apps/mobile/src/games/pick-farm/pipeline.ts';

const HOUR = 3600000;
function garden(beds = 4) {
  let state = { ...createFarm(0), coins: 5000 };
  for (let i = 0; i < beds; i++)
    state = applyFarmCommand(state, { type: 'buyPlot', x: 28 + i, y: 28 }, 0);
  return state;
}
/** Fake Farm API: real engine, manual completion, optional old protocol (no new rules). */
function server(state, { legacy = false } = {}) {
  const sent = [];
  const waiting = [];
  let snapshot = { state, serverNow: HOUR };
  const lane = {
    sent,
    waiting,
    current: () => snapshot,
    refresh: async () => snapshot,
    send: (command) =>
      new Promise((resolve, reject) => {
        sent.push(command);
        waiting.push(() => {
          if (legacy && ['water', 'waterMany', 'harvestMany', 'plantMany'].includes(command.type))
            return reject(
              Object.assign(new Error('INVALID_REQUEST'), { code: 'INVALID_REQUEST', status: 400 }),
            );
          try {
            snapshot = {
              state: applyFarmCommand(snapshot.state, command, snapshot.serverNow),
              serverNow: snapshot.serverNow,
            };
            resolve(snapshot);
          } catch (error) {
            reject(Object.assign(error, { status: 400 }));
          }
        });
      }),
    async flush() {
      while (waiting.length) {
        waiting.shift()();
        await new Promise((r) => setTimeout(r, 0));
      }
    },
  };
  return lane;
}
async function ready(lane) {
  const pipeline = new FarmPipeline(
    lane,
    () => HOUR,
    () => undefined,
  );
  await pipeline.refresh();
  return pipeline;
}

test('actions appear at once, coins stay confirmed, and a sweep becomes one request', async () => {
  const lane = server(garden());
  const pipeline = await ready(lane);
  const results = [0, 1, 2, 3].map((plotId) =>
    pipeline.act({ type: 'plant', plotId, cropId: 'carrot' }),
  );
  // First tap is in flight; the rest wait and are already visible as planted.
  assert.equal(lane.sent.length, 1);
  assert.equal(pipeline.predicted().plots.filter((p) => p.cropId === 'carrot').length, 4);
  assert.equal(pipeline.confirmed.state.coins, garden().coins, 'nothing charged yet');
  await lane.flush();
  assert.deepEqual(
    lane.sent.map((c) => c.type),
    ['plant', 'plantMany'],
  );
  assert.deepEqual(lane.sent[1].plotIds, [1, 2, 3]);
  assert.ok((await Promise.all(results)).every((r) => r.ok));
  assert.equal(pipeline.pending, 0);
  assert.deepEqual(pipeline.predicted(), pipeline.confirmed.state);
});

test('invalid actions are rejected locally without a request', async () => {
  const lane = server(garden(1));
  const pipeline = await ready(lane);
  const first = pipeline.act({ type: 'plant', plotId: 0, cropId: 'carrot' });
  const duplicate = await pipeline.act({ type: 'plant', plotId: 0, cropId: 'tomato' });
  assert.deepEqual(duplicate, { ok: false, code: 'PLOT_OCCUPIED', local: true });
  const early = await pipeline.act({ type: 'harvest', plotId: 0, destination: 'sell' });
  assert.equal(early.code, 'CROP_NOT_READY');
  await lane.flush();
  assert.equal((await first).ok, true);
  assert.equal(lane.sent.length, 1);
});

test('older Farm API: batches fall back to single commands and watering switches off', async () => {
  const lane = server(garden(3), { legacy: true });
  const pipeline = await ready(lane);
  const planted = [0, 1, 2].map((plotId) =>
    pipeline.act({ type: 'plant', plotId, cropId: 'tomato' }),
  );
  await lane.flush();
  assert.ok((await Promise.all(planted)).every((r) => r.ok));
  assert.equal(pipeline.batching, false);
  assert.deepEqual(
    lane.sent.map((c) => c.type),
    ['plant', 'plantMany', 'plant', 'plant'],
  );
  const water = pipeline.act({ type: 'water', plotId: 0 });
  const queued = pipeline.act({ type: 'water', plotId: 1 });
  await lane.flush();
  assert.deepEqual(await water, { ok: false, code: 'WATER_UNAVAILABLE', local: false });
  assert.equal((await queued).code, 'WATER_UNAVAILABLE');
  assert.equal(pipeline.watering, false);
  assert.equal((await pipeline.act({ type: 'water', plotId: 2 })).code, 'WATER_UNAVAILABLE');
  assert.equal(
    pipeline.predicted().plots.every((p) => p.timing.harvestWindowSeconds === 129600),
    true,
  );
});

test('a server rejection drops remaining predictions and restores the confirmed field', async () => {
  const lane = server(garden(3));
  const failures = [];
  const pipeline = new FarmPipeline(
    lane,
    () => HOUR,
    () => undefined,
    (e) => failures.push(e.code),
  );
  await pipeline.refresh();
  const a = pipeline.act({ type: 'plant', plotId: 0, cropId: 'carrot' });
  const b = pipeline.act({ type: 'buyPlot', x: 30, y: 30 });
  const c = pipeline.act({ type: 'plant', plotId: 1, cropId: 'carrot' });
  // Another device spent the money meanwhile: the in-flight purchase is rejected.
  lane.waiting.shift()();
  await new Promise((r) => setTimeout(r, 0));
  const snapshot = lane.current();
  snapshot.state = { ...snapshot.state, coins: 10 };
  await lane.flush();
  assert.equal((await a).ok, true);
  assert.equal((await b).code, 'INSUFFICIENT_COINS');
  assert.deepEqual(await c, { ok: false, code: 'CANCELLED', local: true });
  assert.deepEqual(failures, ['INSUFFICIENT_COINS']);
  assert.equal(pipeline.pending, 0);
  assert.equal(pipeline.predicted().plots[1].cropId, null);
});

test('watering and harvesting sweeps batch per destination and keep order', async () => {
  let state = garden(4);
  for (let plotId = 0; plotId < 4; plotId++)
    state = applyFarmCommand(state, { type: 'plant', plotId, cropId: 'strawberry' }, HOUR - 60000);
  const lane = server(state);
  const pipeline = await ready(lane);
  const waters = [0, 1, 2, 3].map((plotId) => pipeline.act({ type: 'water', plotId }));
  assert.equal(pipeline.predicted().xp, state.xp + 4);
  await lane.flush();
  assert.ok((await Promise.all(waters)).every((r) => r.ok));
  assert.deepEqual(
    lane.sent.map((c) => c.type),
    ['water', 'waterMany'],
  );
});

test('a server answer that moves the clock back never invalidates queued plantings', async () => {
  const lane = server(garden(3));
  let clock = HOUR + 30000;
  const pipeline = new FarmPipeline(
    lane,
    () => clock,
    () => undefined,
  );
  await pipeline.refresh();
  const first = pipeline.act({ type: 'plant', plotId: 0, cropId: 'carrot' });
  // The confirmation re-anchors the client clock to the (earlier) server time.
  clock = HOUR;
  const second = pipeline.act({ type: 'plant', plotId: 1, cropId: 'carrot' });
  await lane.flush();
  assert.equal((await first).ok, true);
  assert.equal((await second).ok, true);
});
