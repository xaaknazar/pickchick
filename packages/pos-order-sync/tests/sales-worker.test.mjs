import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  POS_SALES_REQUEST_TIMEOUT_MS,
  PosSalesHttpError,
  createPosSalesSchedule,
  posRetryDelayMs,
  sendPosSales,
  syncPosSalesOnce,
} from '../dist/index.js';
import { runPosSalesLoop } from '../../../infra/windows/native-pos-sync-worker.mjs';

// Edge sender of posSales (contracts 5.6, CC-4) without PostgreSQL: the HTTP request, the cheap
// schedule states and the separate loop of the Windows POS sync worker. The database behaviour
// is in sales-worker-integration.test.mjs.
const identity = {
  device_id: randomUUID(),
  branch_id: randomUUID(),
  token: 'c'.repeat(64),
  expires_at: '2030-01-01T00:00:00.000Z',
};
const json = (value, init = {}) =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
const rejectsWith = (code, status) => (error) =>
  error instanceof PosSalesHttpError &&
  error.code === code &&
  error.status === status &&
  !error.message.includes(identity.token);

test('one POST to the posSales path with the device identity, no redirect and the exact batch', async () => {
  let request;
  const result = await sendPosSales(
    'http://127.0.0.1:43100',
    identity,
    { events: [] },
    {
      fetch: async (url, options) => {
        request = { url, options };
        return json({ receipts: [] });
      },
    },
  );
  assert.deepEqual(result, { receipts: [] });
  assert.equal(request.url, 'http://127.0.0.1:43100/internal/v1/edge/pos-orders/sales');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.redirect, 'error');
  assert.equal(request.options.body, '{"events":[]}');
  assert.deepEqual(request.options.headers, {
    Authorization: `Bearer ${identity.token}`,
    'X-Device-Id': identity.device_id,
    'Content-Type': 'application/json',
  });
  assert.equal(POS_SALES_REQUEST_TIMEOUT_MS, 15000);
});

test('404 and 503 mean "the cloud does not support posSales" whatever the body; other answers are failures', async () => {
  const send = (response, io = {}) =>
    sendPosSales(
      'https://cloud.example.test',
      identity,
      { events: [] },
      {
        fetch: async () => response(),
        ...io,
      },
    );
  for (const status of [404, 503])
    for (const body of ['not json', JSON.stringify({ code: 'NOT_FOUND' }), ''])
      await assert.rejects(
        send(() => new Response(body, { status })),
        rejectsWith('UNSUPPORTED', status),
      );
  for (const status of [201, 400, 401, 403, 409, 413, 429, 500, 502])
    await assert.rejects(
      send(() => json({ code: 'X' }, { status })),
      rejectsWith('HTTP_REJECTED', status),
    );
  await assert.rejects(
    send(() => new Response(null, { status: 204 })),
    rejectsWith('HTTP_REJECTED', 204),
  );
  for (const response of [
    () => new Response('{"receipts":[]}', { headers: { 'content-type': 'text/plain' } }),
    () => json({ receipts: [], extra: true }),
    () => json({ receipts: [{ event_id: 'x' }] }),
    () => new Response('{"receipts":', { headers: { 'content-type': 'application/json' } }),
    () =>
      new Response('{}', {
        headers: { 'content-type': 'application/json', 'content-length': String(65 * 1024) },
      }),
    () =>
      new Response(`{"receipts":[],"pad":"${'x'.repeat(70 * 1024)}"}`, {
        headers: { 'content-type': 'application/json' },
      }),
  ])
    await assert.rejects(send(response), rejectsWith('INVALID_RESPONSE', undefined));
  await assert.rejects(
    send(() => {
      throw new TypeError(`fetch failed ${identity.token}`);
    }),
    rejectsWith('NETWORK_UNKNOWN', undefined),
  );
  await assert.rejects(
    sendPosSales(
      'https://cloud.example.test',
      identity,
      { events: [] },
      {
        timeoutMs: 20,
        fetch: (_, options) =>
          new Promise((_, reject) =>
            options.signal.addEventListener('abort', () => reject(new Error('aborted'))),
          ),
      },
    ),
    rejectsWith('NETWORK_UNKNOWN', undefined),
  );
  // Plain HTTP only to loopback; the timeout is bounded.
  await assert.rejects(sendPosSales('http://cloud.example.test', identity, { events: [] }));
  await assert.rejects(
    sendPosSales('https://cloud.example.test', identity, { events: [] }, { timeoutMs: 60000 }),
    rejectsWith('INVALID_RESPONSE', undefined),
  );
});

test('disabled, busy and waiting steps touch neither the database nor the network', async () => {
  const input = { enabled: true, branchId: identity.branch_id, origin: 'x', identity };
  assert.deepEqual(await syncPosSalesOnce(null, { enabled: false }), { state: 'disabled' });
  const schedule = createPosSalesSchedule();
  assert.deepEqual(schedule, {
    nextAttemptAt: 0,
    failures: 0,
    lastSupportedAt: null,
    running: false,
  });
  schedule.running = true;
  assert.deepEqual(await syncPosSalesOnce(null, input, schedule), { state: 'busy' });
  schedule.running = false;
  schedule.nextAttemptAt = 5000;
  assert.deepEqual(await syncPosSalesOnce(null, input, schedule, { now: () => 4999 }), {
    state: 'waiting',
    retryAt: 5000,
  });
  // A foreign identity is refused before any database access.
  await assert.rejects(
    syncPosSalesOnce(
      null,
      { ...input, origin: 'http://127.0.0.1:43100', branchId: randomUUID() },
      createPosSalesSchedule(),
    ),
    /FORBIDDEN/,
  );
});

test('the Windows worker runs posSales as its own loop: errors stay in it and it backs off', async () => {
  const lines = { log: [], fail: [] };
  const base = {
    pool: {},
    branchId: identity.branch_id,
    origin: 'http://127.0.0.1:43100',
    log: (line) => lines.log.push(JSON.parse(line)),
    fail: (line) => lines.fail.push(JSON.parse(line)),
  };
  // An older package without the sender: the loop does not start.
  await runPosSalesLoop({
    ...base,
    sync: {},
    identity: () => assert.fail('no identity read'),
    once: false,
    signal: new AbortController().signal,
  });
  // --once: exactly one step; its state is logged, never the identity or bodies.
  const calls = [];
  const sync = {
    createPosSalesSchedule,
    posRetryDelayMs,
    syncPosSalesOnce: async (pool, input, schedule) => {
      calls.push({ input, schedule });
      return { state: 'probed' };
    },
  };
  const exitCode = process.exitCode;
  await runPosSalesLoop({
    ...base,
    sync,
    identity: async () => identity,
    once: true,
    signal: new AbortController().signal,
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].input, {
    enabled: true,
    branchId: identity.branch_id,
    origin: 'http://127.0.0.1:43100',
    identity,
  });
  assert.deepEqual(lines.log, [{ event: 'pos_sales_sync', state: 'probed' }]);
  // A thrown step and an unreadable identity are logged by this loop and never rethrown.
  const stop = new AbortController();
  let step = 0,
    reads = 0,
    schedule;
  await runPosSalesLoop({
    ...base,
    sync: {
      ...sync,
      createPosSalesSchedule: () => (schedule = createPosSalesSchedule()),
      syncPosSalesOnce: async () => {
        step += 1;
        if (step === 1) throw new Error(`driver text ${identity.token}`);
        return { state: 'delivered', count: 50, more: true };
      },
    },
    identity: async () => {
      reads += 1;
      if (reads === 3) throw new Error('expired identity');
      return identity;
    },
    once: false,
    signal: stop.signal,
    // Stop once the unreadable identity was seen (the third read).
    pause: async () => {
      if (reads >= 3) stop.abort();
    },
  });
  // The identity failure moved this loop's own schedule (2 s), nothing else.
  assert.equal(schedule.failures, 1);
  assert.ok(schedule.nextAttemptAt > Date.now() + 1000);
  assert.equal(step, 2);
  assert.equal(reads, 3);
  assert.deepEqual(lines.fail, [
    { event: 'pos_sales_sync_failed', retrying: true },
    { event: 'pos_sales_sync_failed', retrying: true },
  ]);
  assert.ok(lines.log.some((line) => line.state === 'delivered'));
  assert.ok(!JSON.stringify(lines).includes(identity.token));
  process.exitCode = exitCode;
});
