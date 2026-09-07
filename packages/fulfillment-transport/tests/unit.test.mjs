import { ReadableStream } from 'node:stream/web';
import { TextEncoder } from 'node:util';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  cloudTransportOrigin,
  transportRequest,
  syncFulfillmentOnce,
  EdgeEventSchema,
} from '../dist/index.js';
const identity = {
  device_id: randomUUID(),
  branch_id: randomUUID(),
  token: 'a'.repeat(64),
  expires_at: '2030-01-01T00:00:00.000Z',
};
const json = (value) =>
  new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

test('disabled transport performs no DB, credentials or HTTP operation', async () => {
  assert.deepEqual(
    await syncFulfillmentOnce(
      {
        query() {
          throw Error('DB forbidden');
        },
      },
      { enabled: false, branchId: '', origin: '', identity: null },
      {
        fetch() {
          throw Error('network forbidden');
        },
      },
    ),
    { state: 'disabled' },
  );
});
test('origin rejects credential URLs, unsafe schemes, paths and cleartext nonloopback', () => {
  for (const value of [
    'file:///tmp',
    'http://example.test',
    'https://u:p@example.test',
    'https://example.test/x',
    'https://example.test/?x',
    'https://example.test/#secret',
  ])
    assert.throws(() => cloudTransportOrigin(value));
  assert.equal(
    cloudTransportOrigin('https://edge-cloud.example.test/'),
    'https://edge-cloud.example.test',
  );
  assert.equal(cloudTransportOrigin('http://127.0.0.1:3100'), 'http://127.0.0.1:3100');
});
test('one request only; device credentials only headers; immutable exact body; redirects forbidden', async () => {
  let calls = 0;
  const body = { workerId: randomUUID(), leaseSeconds: 30 };
  const result = await transportRequest('http://127.0.0.1:3100', 'pull', identity, body, {
    fetch: async (url, options) => {
      calls++;
      assert.equal(url, 'http://127.0.0.1:3100/internal/v1/edge/fulfillment/pull');
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers.Authorization, `Bearer ${identity.token}`);
      assert.equal(options.headers['X-Device-Id'], identity.device_id);
      assert.equal(options.body, JSON.stringify(body));
      assert.ok(!url.includes(identity.token));
      return json({ ok: true });
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, { ok: true });
});
test('unknown HTTP outcome has no raw error, causes or automatic resend', async () => {
  let calls = 0;
  await assert.rejects(
    transportRequest(
      'http://127.0.0.1:3100',
      'events',
      identity,
      {},
      {
        fetch: async () => {
          calls++;
          throw Error(identity.token);
        },
      },
    ),
    (error) => {
      assert.equal(error.message, 'NETWORK_UNKNOWN');
      assert.equal(error.cause, undefined);
      return true;
    },
  );
  assert.equal(calls, 1);
});
test('whole deadline includes unresolved fetch and half-read response; broken cancel never stalls', async () => {
  for (const fetcher of [
    async () => new Promise(() => {}),
    async () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode('{'));
          },
          cancel() {
            return new Promise(() => {});
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
  ]) {
    const start = Date.now();
    await assert.rejects(
      transportRequest(
        'http://127.0.0.1:3100',
        'pull',
        identity,
        {},
        { fetch: fetcher, timeoutMs: 30 },
      ),
      (e) => e.code === 'NETWORK_UNKNOWN',
    );
    assert.ok(Date.now() - start < 1000);
  }
});
test('bounded response rejects over-declared and chunked bodies, malformed JSON and wrong MIME', async () => {
  const cases = [
    () =>
      new Response('x', {
        headers: { 'content-type': 'application/json', 'content-length': '1300001' },
      }),
    () => new Response(' '.repeat(1300001), { headers: { 'content-type': 'application/json' } }),
    () => new Response('{broken', { headers: { 'content-type': 'application/json' } }),
    () => new Response('{}', { headers: { 'content-type': 'text/html' } }),
    () =>
      new Response(Buffer.from([0x22, 0xc3, 0x28, 0x22]), {
        headers: { 'content-type': 'application/json' },
      }),
  ];
  for (const make of cases)
    await assert.rejects(
      transportRequest(
        'http://127.0.0.1:3100',
        'pull',
        identity,
        {},
        { fetch: async () => make() },
      ),
      (e) => e.code === 'INVALID_RESPONSE',
    );
});
test('confirmed HTTP rejection preserves status but never raw response details', async () => {
  await assert.rejects(
    transportRequest(
      'http://127.0.0.1:3100',
      'ack',
      identity,
      {},
      {
        fetch: async () =>
          new Response(
            JSON.stringify({
              code: 'CONFLICT',
              message_key: 'errors.conflict',
              trace_id: randomUUID(),
              retryable: false,
            }),
            { status: 409, headers: { 'content-type': 'application/json' } },
          ),
      },
    ),
    (e) => e.code === 'HTTP_REJECTED' && e.status === 409 && !e.message.includes(identity.token),
  );
});
test('event schema rejects altered scope/version/type, malformed bigint and missing task snapshot', () => {
  const p = {
    orderId: randomUUID(),
    branchId: identity.branch_id,
    reservationId: randomUUID(),
    quoteId: randomUUID(),
    quoteDigest: 'a'.repeat(64),
    ownerHash: 'b'.repeat(64),
    commercialOwner: 'cloud',
    fulfillmentOwner: 'edge',
    deviceId: identity.device_id,
    version: 1,
    state: 'held',
    displayNumber: null,
    createdAt: '2026-09-08T00:00:00.000Z',
    updatedAt: '2026-09-08T00:00:00.000Z',
    routingVersion: 1,
  };
  const e = {
    schemaVersion: 1,
    eventId: randomUUID(),
    sequence: '1',
    orderId: p.orderId,
    aggregateVersion: 1,
    type: 'edge.admission_reserved',
    payload: p,
  };
  assert.equal(EdgeEventSchema.safeParse(e).success, true);
  for (const changed of [
    { ...e, sequence: '1.1' },
    { ...e, sequence: '9223372036854775808' },
    { ...e, aggregateVersion: 2 },
    { ...e, type: 'edge.task_changed' },
    { ...e, extra: 'rejected' },
    { ...e, payload: { ...p, state: 'accepted' } },
  ])
    assert.equal(EdgeEventSchema.safeParse(changed).success, false);
});

test('HTML, partial, mismatched and malformed 409 are never authoritative lease conflict', async () => {
  const cases = [
    () => new Response('<html>proxy409</html>', { status: 409 }),
    () => new Response('{', { status: 409, headers: { 'content-type': 'application/json' } }),
    () =>
      new Response(
        JSON.stringify({
          code: 'UNAUTHORIZED',
          message_key: 'errors.unauthorized',
          trace_id: randomUUID(),
          retryable: false,
        }),
        { status: 409, headers: { 'content-type': 'application/json' } },
      ),
    () =>
      new Response(JSON.stringify({ code: 'CONFLICT' }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      }),
  ];
  for (const make of cases)
    await assert.rejects(
      transportRequest('http://127.0.0.1:3100', 'ack', identity, {}, { fetch: async () => make() }),
      (e) => e.status === undefined && e.code !== 'HTTP_REJECTED',
    );
});
