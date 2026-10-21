import test from 'node:test';
import assert from 'node:assert/strict';
import { watchCheckoutOrder } from '../../packages/commerce-core/dist/index.js';

// Audit 2.8: an idle order watch must not repeat the full (locking, ~20 statement) read.
function harness({ changeAt = Infinity, deadline = 20_000, stopAt = Infinity } = {}) {
  let clock = 0;
  const calls = [];
  const revision = () => (clock >= changeAt ? 'b'.repeat(64) : 'a'.repeat(64));
  return {
    calls,
    run: () =>
      watchCheckoutOrder({
        after: 'a'.repeat(64),
        deadline,
        now: () => clock,
        sleep: async (ms) => {
          calls.push(['sleep', ms]);
          clock += ms;
        },
        stopped: () => clock >= stopAt,
        mark: async () => {
          calls.push(['mark', clock]);
          return clock >= changeAt ? 'changed' : 'same';
        },
        read: async () => {
          calls.push(['read', clock]);
          return { revision: revision() };
        },
      }),
  };
}

test('idle watch reads the full order once, then only compares marks at least 1 s apart', async () => {
  const h = harness();
  const order = await h.run();
  assert.equal(order.revision, 'a'.repeat(64));
  const reads = h.calls.filter(([kind]) => kind === 'read');
  const marks = h.calls.filter(([kind]) => kind === 'mark');
  assert.equal(reads.length, 1);
  assert.equal(marks.length, 21);
  assert.ok(h.calls.filter(([kind]) => kind === 'sleep').every(([, ms]) => ms >= 1000));
  // The first mark precedes the first read: a change between them cannot be missed.
  assert.deepEqual(h.calls.slice(0, 2), [
    ['mark', 0],
    ['read', 0],
  ]);
});

test('a moved mark triggers one full read and returns the changed order', async () => {
  const h = harness({ changeAt: 3500 });
  const order = await h.run();
  assert.equal(order.revision, 'b'.repeat(64));
  assert.deepEqual(
    h.calls.filter(([kind]) => kind === 'read'),
    [
      ['read', 0],
      ['read', 4000],
    ],
  );
});

test('an already changed order returns at once; a closed client stops polling', async () => {
  const changed = harness({ changeAt: 0 });
  assert.equal((await changed.run()).revision, 'b'.repeat(64));
  assert.equal(changed.calls.filter(([kind]) => kind === 'sleep').length, 0);
  const closed = harness({ stopAt: 2000 });
  await closed.run();
  assert.equal(closed.calls.filter(([kind]) => kind === 'mark').length, 2);
});
