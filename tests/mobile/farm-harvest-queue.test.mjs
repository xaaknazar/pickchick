import test from 'node:test';
import assert from 'node:assert/strict';
import { HarvestQueue } from '../../apps/mobile/src/games/pick-farm/harvest-queue.ts';
const harvest = (plotId) => ({ type: 'harvest', plotId, destination: 'sell' });
test('rapid taps serialize separate beds and deduplicate the same bed in flight', async () => {
  const calls = [],
    completions = [];
  const queue = new HarvestQueue((command) => {
    calls.push(command);
    return new Promise((resolve) => completions.push(resolve));
  });
  const first = queue.enqueue(harvest(1));
  assert.equal(queue.enqueue(harvest(1)), first);
  const second = queue.enqueue(harvest(2));
  assert.deepEqual(calls, [harvest(1)]);
  completions.shift()(true);
  assert.equal(await first, true);
  assert.deepEqual(calls, [harvest(1), harvest(2)]);
  completions.shift()(true);
  assert.equal(await second, true);
});
test('an unknown or rejected harvest stops queued taps rather than replaying them later', async () => {
  let resolve;
  const calls = [];
  const queue = new HarvestQueue((command) => {
    calls.push(command);
    return new Promise((done) => (resolve = done));
  });
  const first = queue.enqueue(harvest(1)),
    second = queue.enqueue(harvest(2));
  resolve(false);
  assert.deepEqual(await Promise.all([first, second]), [false, false]);
  assert.equal(calls.length, 1);
});
test('leaving a farm cancels queued taps without sending another command', async () => {
  let resolve;
  const calls = [];
  const queue = new HarvestQueue((command) => {
    calls.push(command);
    return new Promise((done) => (resolve = done));
  });
  const first = queue.enqueue(harvest(1)),
    second = queue.enqueue(harvest(2));
  queue.dispose();
  resolve(true);
  assert.deepEqual(await Promise.all([first, second]), [false, false]);
  assert.equal(await queue.enqueue(harvest(3)), false);
  assert.equal(calls.length, 1);
});
