import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as flush } from 'node:timers/promises';
import { createCatalogRecovery } from '../../apps/mobile/src/catalog-recovery.ts';

const transient = new Error('Temporary public GET failure');
function harness(t, load) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const successes = [];
  const failures = [];
  let loading = 0;
  const recovery = createCatalogRecovery({
    load,
    random: () => 1,
    isRetryable: (error) => error === transient,
    onLoading: () => loading++,
    onSuccess: (catalog) => successes.push(catalog),
    onFailure: (error) => failures.push(error),
  });
  t.after(() => recovery.stop());
  const advance = async (ms) => {
    t.mock.timers.tick(ms);
    await flush();
  };
  return { recovery, successes, failures, advance, loading: () => loading };
}

test('cold-start transport failure recovers using only the eventual server response', async (t) => {
  const catalog = { id: 'only-server-response' };
  let calls = 0;
  const h = harness(t, async () => {
    if (++calls === 1) throw transient;
    return catalog;
  });
  h.recovery.setActive(true);
  await flush();
  assert.equal(calls, 1);
  assert.deepEqual(h.successes, []);
  await h.advance(1999);
  assert.equal(calls, 1);
  await h.advance(1);
  assert.deepEqual(h.successes, [catalog]);
  await h.advance(60_000);
  assert.equal(calls, 2, 'success stops the retry loop');
});

test('long outages keep retrying at a capped delay and recover without a foreground event', async (t) => {
  let calls = 0;
  let offline = true;
  const h = harness(t, async () => {
    calls++;
    if (offline) throw transient;
    return 'fresh';
  });
  h.recovery.setActive(true);
  await flush();
  for (const delay of [2000, 5000, 15000, 30000, 30000, 30000]) await h.advance(delay);
  assert.equal(calls, 7);
  offline = false;
  await h.advance(30000);
  assert.deepEqual(h.successes, ['fresh']);
  await h.advance(30000);
  assert.equal(calls, 8);
});

test('schema errors never retry automatically; foreground explicitly checks again', async (t) => {
  let calls = 0;
  const schemaError = new Error('Unsupported ordering');
  const h = harness(t, async () => {
    calls++;
    throw schemaError;
  });
  h.recovery.setActive(true);
  await flush();
  await h.advance(60_000);
  assert.equal(calls, 1);
  h.recovery.setActive(true);
  await flush();
  assert.equal(calls, 1, 'duplicate active events do not create requests');
  h.recovery.setActive(false);
  h.recovery.setActive(true);
  await flush();
  assert.equal(calls, 2);
  assert.deepEqual(h.failures, [schemaError, schemaError]);
});

test('background suspends timers and foreground renews the retry budget', async (t) => {
  let calls = 0;
  const h = harness(t, async () => {
    calls++;
    throw transient;
  });
  await h.advance(60_000);
  assert.equal(calls, 0, 'no initial fetch while inactive');
  h.recovery.setActive(true);
  await flush();
  h.recovery.setActive(false);
  await h.advance(60_000);
  assert.equal(calls, 1);
  h.recovery.setActive(true);
  await flush();
  assert.equal(calls, 2);
  await h.advance(2000);
  assert.equal(calls, 3);
});

test('rapid foreground waits for cancellation and never applies the late result', async (t) => {
  const pending = [];
  let active = 0;
  let maximumActive = 0;
  const h = harness(t, (signal) => {
    maximumActive = Math.max(maximumActive, ++active);
    return new Promise((resolve) =>
      pending.push({
        signal,
        resolve: (value) => {
          active--;
          resolve(value);
        },
      }),
    );
  });
  h.recovery.setActive(true);
  h.recovery.setActive(false);
  assert.equal(pending[0].signal.aborted, true);
  h.recovery.setActive(true);
  h.recovery.setActive(true);
  await h.advance(60_000);
  assert.equal(pending.length, 1, 'old fetch has not settled yet');
  pending[0].resolve('obsolete');
  await flush();
  assert.equal(pending.length, 2);
  assert.deepEqual(h.successes, []);
  pending[1].resolve('fresh');
  await flush();
  assert.deepEqual(h.successes, ['fresh']);
  assert.equal(maximumActive, 1);
});

test('stopping a branch/unmounted loader aborts reads and ignores completion', async (t) => {
  let finish;
  let requestSignal;
  const h = harness(t, (signal) => {
    requestSignal = signal;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  h.recovery.setActive(true);
  h.recovery.stop();
  assert.equal(requestSignal.aborted, true);
  finish('wrong-branch-or-unmounted');
  await flush();
  h.recovery.setActive(true);
  await h.advance(60_000);
  assert.deepEqual(h.successes, []);
  assert.deepEqual(h.failures, []);
  assert.equal(h.loading(), 1);
});

test('stopping during backoff prevents any further public request', async (t) => {
  let calls = 0;
  const h = harness(t, async () => {
    calls++;
    throw transient;
  });
  h.recovery.setActive(true);
  await flush();
  h.recovery.stop();
  await h.advance(60_000);
  assert.equal(calls, 1);
});

test('explicit refresh resolves only after the queued newer read is applied', async (t) => {
  let finish;
  let count = 0;
  const h = harness(t, () =>
    ++count === 1
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : Promise.resolve('new'),
  );
  h.recovery.setActive(true);
  let result;
  const next = h.recovery.refresh().then((value) => {
    result = value;
  });
  finish('old');
  await next;
  assert.equal(result, true);
  assert.deepEqual(h.successes, ['old', 'new']);
  h.recovery.setActive(false);
  assert.equal(await h.recovery.refresh(), false);
});
