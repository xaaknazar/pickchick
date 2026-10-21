import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import {
  Admission,
  admissionClientKey,
  EdgeDeviceRoute,
  LongPollRoute,
  loadConfig,
  longPollMayWait,
} from '@pickchick/platform';
import { fixtureIds } from '@pickchick/test-fixtures';

const require = createRequire(new URL('../../packages/platform/package.json', import.meta.url));
const { Subject, defer, firstValueFrom } = require('rxjs');

// Handler identity carries the admission class, exactly like a decorated controller method.
class PublicController {}
class EdgeController {}
EdgeDeviceRoute()(EdgeController);
function ordinary() {}
function availability() {}
function kioskAvailability() {}
function watch() {}
function edgeMedia() {}
function ready() {}
function live() {}
LongPollRoute('after')(availability);
LongPollRoute()(watch);
LongPollRoute('after', { perClient: false })(kioskAvailability);
EdgeDeviceRoute()(edgeMedia);
const HealthController = { name: 'HealthController' };
const TestOrderController = { name: 'TestOrderController' };

/** One in-flight HTTP request against an interceptor; `done()` completes the handler. */
function call(admission, { handler = ordinary, cls = PublicController, ip, query = {} } = {}) {
  const request = { ip, query };
  const headers = {};
  const response = { setHeader: (name, value) => (headers[name] = value) };
  const context = {
    getClass: () => cls,
    getHandler: () => handler,
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
  };
  const result = new Subject();
  const state = { request, headers, ran: 0, mayWait: undefined, status: 'pending', error: null };
  const next = {
    handle: () =>
      defer(() => {
        state.ran += 1;
        state.mayWait = longPollMayWait(request);
        return result;
      }),
  };
  try {
    state.promise = firstValueFrom(admission.intercept(context, next)).then(
      () => (state.status = 'ok'),
      (error) => {
        state.status = 'error';
        state.error = error;
      },
    );
  } catch (error) {
    state.status = 'error';
    state.error = error;
  }
  state.done = async (value = 'ok') => {
    result.next(value);
    result.complete();
    await state.promise;
  };
  state.fail = async () => {
    result.error(new Error('handler failed'));
    await state.promise;
  };
  return state;
}
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const statusOf = (state) => state.error?.getStatus?.();
/** Status of a request that admission refuses (the rejection settles asynchronously). */
const refused = async (state) => {
  await state.promise;
  return statusOf(state);
};

test('legacy numeric construction and option bounds stay strict', () => {
  const legacy = new Admission(7);
  assert.equal(legacy.limit, 7);
  assert.equal(legacy.longPollLimit, 64);
  assert.equal(legacy.longPollPerClient, 16);
  assert.equal(legacy.edgeLimit, 16);
  assert.equal(legacy.overflowDelayMs, 5000);
  assert.equal(legacy.perClient, false);
  for (const options of [
    0,
    1025,
    1.5,
    { longPollLimit: 0 },
    { longPollLimit: 1025 },
    { longPollPerClient: 0 },
    { edgeLimit: 257 },
    { overflowDelayMs: -1 },
    { overflowDelayMs: 30_001 },
  ])
    assert.throws(() => new Admission(options), /Invalid HTTP admission/);
});

test('waiting long-polls use their own budget and never block ordinary requests', async () => {
  const admission = new Admission({ limit: 1, longPollLimit: 3, overflowDelayMs: 20 });
  const polls = [0, 1, 2].map(() =>
    call(admission, { handler: availability, query: { after: 'a'.repeat(64) } }),
  );
  polls.push(call(admission, { handler: watch }));
  await tick();
  assert.equal(admission.longPolls, 3);
  assert.equal(admission.active, 0);
  assert.equal(admission.paced, 1);
  assert.equal(polls[3].ran, 0);
  assert.ok(polls.slice(0, 3).every((poll) => poll.ran === 1 && poll.mayWait === true));
  // The fourth is an overflow: it does not wait, and its single read is an ordinary request.
  await tick(40);
  assert.equal(polls[3].mayWait, false);
  assert.equal(admission.active, 1);
  assert.equal(admission.paced, 1);
  assert.equal(await refused(call(admission)), 503, 'the overflow read is an ordinary request');
  await polls[3].done();
  assert.equal(admission.active, 0);
  assert.equal(admission.paced, 0);
  const payment = call(admission);
  await tick();
  assert.equal(payment.ran, 1, 'ordinary capacity is free while three long-polls wait');
  await payment.done();
  // Without `after` the availability handler is a plain read in the ordinary budget.
  const plain = call(admission, { handler: availability });
  await tick();
  assert.equal(admission.active, 1);
  assert.equal(admission.longPolls, 3);
  assert.equal(plain.mayWait, true);
  await plain.done();
  await polls[0].fail();
  for (const poll of polls.slice(1, 3)) await poll.done();
  assert.deepEqual(
    [admission.active, admission.longPolls, admission.paced],
    [0, 0, 0],
    'success and failure paths release every budget',
  );
  assert.equal(admission.pacedTotal, 1);
  assert.equal(admission.rejected, 1);
});

test('overflow pauses without any slot, then reads once; full overflow is a 503', async () => {
  const admission = new Admission({
    limit: 1,
    longPollLimit: 1,
    overflowDelayMs: 60,
    random: () => 0.5,
  });
  const waiting = call(admission, { handler: watch });
  await tick();
  const started = Date.now();
  const paced = call(admission, { handler: watch });
  const blocker = call(admission);
  await tick(20);
  assert.equal(paced.ran, 0, 'no handler work and no slot during the pause');
  assert.equal(admission.paced, 1);
  assert.equal(admission.active, 1);
  const full = call(admission, { handler: watch });
  assert.equal(await refused(full), 503);
  assert.equal(full.headers['Retry-After'], '1');
  // The ordinary budget is still busy when the pause ends: the overflow answers 503 too.
  await tick(80);
  assert.equal(statusOf(paced), 503);
  assert.ok(Date.now() - started >= 55);
  assert.equal(admission.paced, 0);
  await blocker.done();
  const again = call(admission, { handler: watch });
  await tick(90);
  assert.equal(again.ran, 1);
  assert.equal(again.mayWait, false);
  await again.done();
  await waiting.done();
  assert.deepEqual([admission.active, admission.longPolls, admission.paced], [0, 0, 0]);
});

test('per-client cap: own share of waits, own share of paced answers, then 429', async () => {
  const admission = new Admission({
    longPollLimit: 10,
    longPollPerClient: 2,
    overflowDelayMs: 1000,
    perClient: true,
  });
  const a = '203.0.113.7';
  const waiting = [
    call(admission, { handler: watch, ip: a }),
    call(admission, { handler: watch, ip: `::ffff:${a}` }),
  ];
  await tick();
  assert.equal(admission.longPolls, 2);
  const paced = [
    call(admission, { handler: watch, ip: a }),
    call(admission, { handler: watch, ip: a }),
  ];
  assert.equal(admission.paced, 2);
  const rejected = call(admission, { handler: watch, ip: a });
  assert.equal(await refused(rejected), 429);
  assert.equal(rejected.error.getResponse().code, 'RATE_LIMITED');
  assert.equal(rejected.headers['Retry-After'], '1');
  assert.equal(admission.clientRejected, 1);
  // Another address still waits normally: one client cannot take the whole pool.
  const other = call(admission, { handler: watch, ip: '198.51.100.4' });
  await tick();
  assert.equal(other.mayWait, true);
  assert.equal(admission.longPolls, 3);
  assert.equal(admission.longPollClients, 2);
  // Ordinary and edge routes are not subject to the per-client cap.
  const quote = call(admission, { ip: a });
  const edge = call(admission, { cls: EdgeController, ip: a });
  await tick();
  assert.equal(quote.ran + edge.ran, 2);
  for (const state of [...waiting, other, quote, edge]) await state.done();
  await tick(1300);
  for (const state of paced) {
    assert.equal(state.ran, 1);
    await state.done();
  }
  assert.equal(admission.longPollClients, 0, 'idle client entries are forgotten');
  assert.deepEqual([admission.active, admission.longPolls, admission.paced], [0, 0, 0]);
});

test('a route without a forwarded client address is exempt from the per-client cap', async () => {
  const admission = new Admission({
    longPollLimit: 3,
    longPollPerClient: 1,
    overflowDelayMs: 0,
    perClient: true,
  });
  // Every kiosk reaches the API with the front proxy address; they must not share one key.
  const polls = [1, 2, 3].map(() =>
    call(admission, { handler: kioskAvailability, ip: '172.18.0.9', query: { after: 'x' } }),
  );
  await tick();
  assert.equal(admission.longPolls, 3);
  assert.equal(admission.paced, 0);
  assert.equal(admission.longPollClients, 0);
  // The same address on a capped route is still limited.
  const capped = call(admission, { handler: watch, ip: '172.18.0.9' });
  await tick();
  assert.equal(admission.paced, 1, 'pool full: paced, not refused');
  for (const poll of [...polls, capped]) await poll.done();
});

test('without a trusted proxy the per-client cap stays off (all clients share the gateway)', async () => {
  const admission = new Admission({ longPollLimit: 3, longPollPerClient: 1, overflowDelayMs: 0 });
  const polls = [1, 2, 3].map(() => call(admission, { handler: watch, ip: '172.18.0.2' }));
  await tick();
  assert.equal(admission.longPolls, 3);
  assert.equal(admission.longPollClients, 0);
  for (const poll of polls) await poll.done();
});

test('edge transport has a reserved budget and borrows ordinary capacity only when free', async () => {
  const admission = new Admission({ limit: 1, edgeLimit: 2 });
  const publicRequest = call(admission);
  await tick();
  const edge = [call(admission, { cls: EdgeController }), call(admission, { handler: edgeMedia })];
  await tick();
  assert.equal(admission.edge, 2);
  assert.ok(
    edge.every((state) => state.ran === 1),
    'public saturation never blocks the edge',
  );
  assert.equal(await refused(call(admission, { cls: EdgeController })), 503);
  assert.equal(await refused(call(admission)), 503, 'public traffic cannot use the reservation');
  await publicRequest.done();
  const borrowed = call(admission, { cls: EdgeController });
  await tick();
  assert.equal(admission.edgeBorrowed, 1);
  assert.equal(admission.active, 1);
  await borrowed.fail();
  for (const state of edge) await state.done();
  assert.deepEqual([admission.active, admission.edge, admission.edgeBorrowed], [0, 0, 0]);
});

test('readiness probes and TEST order watches keep their previous separate budgets', async () => {
  const admission = new Admission({ limit: 1 });
  const probes = [1, 2, 3, 4].map(() => call(admission, { cls: HealthController, handler: ready }));
  await tick();
  assert.equal(admission.probes, 4);
  assert.equal(await refused(call(admission, { cls: HealthController, handler: ready })), 503);
  const liveness = call(admission, { cls: HealthController, handler: live });
  await tick();
  assert.equal(liveness.ran, 1);
  const watches = Array.from({ length: 32 }, () =>
    call(admission, { cls: TestOrderController, handler: watch }),
  );
  await tick();
  assert.equal(admission.watches, 32);
  assert.equal(admission.longPolls, 0);
  assert.equal(await refused(call(admission, { cls: TestOrderController, handler: watch })), 503);
  for (const state of [...probes, liveness, ...watches]) await state.done();
  assert.deepEqual([admission.probes, admission.watches, admission.active], [0, 0, 0]);
});

test('256 public menu watches keep their separate bucket, leaving command capacity free', async () => {
  // Installed mobile apps were released against this bucket; it is not the long-poll budget.
  const CustomerCheckoutController = { name: 'CustomerCheckoutController' };
  const admission = new Admission({ limit: 1, longPollLimit: 1 });
  const menu = Array.from({ length: 256 }, (_, index) =>
    call(admission, {
      cls: CustomerCheckoutController,
      handler: availability,
      query: index % 2 ? { after: 'a'.repeat(64) } : {},
    }),
  );
  await tick();
  assert.equal(admission.catalogWatches, 256);
  assert.deepEqual([admission.active, admission.longPolls, admission.paced], [0, 0, 0]);
  assert.ok(menu.every((state) => state.ran === 1 && state.mayWait === true));
  assert.equal(
    await refused(call(admission, { cls: CustomerCheckoutController, handler: availability })),
    503,
  );
  const command = call(admission, { cls: CustomerCheckoutController, handler: ordinary });
  await tick();
  assert.equal(admission.active, 1);
  await command.done();
  for (const state of menu) await state.done();
  assert.deepEqual([admission.active, admission.catalogWatches], [0, 0]);
});

test('client keys normalize mapped IPv4 and group IPv6 by /64', () => {
  assert.equal(admissionClientKey('203.0.113.7'), '203.0.113.7');
  assert.equal(admissionClientKey('::ffff:203.0.113.7'), '203.0.113.7');
  assert.equal(admissionClientKey('2001:db8:1:2:3:4:5:6'), '2001:db8:1:2::/64');
  assert.equal(admissionClientKey('2001:DB8:1:2::9'), '2001:db8:1:2::/64');
  assert.equal(admissionClientKey('2001:db8::'), '2001:db8:0:0::/64');
  assert.equal(admissionClientKey('::1'), '0:0:0:0::/64');
  assert.equal(admissionClientKey('fe80::1%eth0'), 'fe80:0:0:0::/64');
  assert.equal(admissionClientKey('64:ff9b::192.0.2.1'), '64:ff9b:0:0::/64');
  for (const value of [undefined, '', 'not-an-ip', '203.0.113.7, 10.0.0.1'])
    assert.equal(admissionClientKey(value), 'unknown');
});

test('long-poll and edge budgets default safely and reject invalid configuration', () => {
  const env = {
    APP_ENV: 'test',
    CLOUD_DATABASE_URL: 'postgresql://localhost/pickchick_cloud',
    EDGE_DATABASE_URL: 'postgresql://localhost/pickchick_edge',
    EDGE_BRANCH_ID: fixtureIds.branch,
    REDIS_URL: 'redis://localhost:6379',
  };
  const config = loadConfig('api', env);
  assert.equal(config.httpMaxLongPoll, 64);
  assert.equal(config.httpMaxLongPollPerIp, 16);
  assert.equal(config.httpMaxEdgeInFlight, 16);
  assert.equal(config.httpLongPollOverflowDelayMs, 5000);
  // The per-IP cap is a new 429 path: off by default, and only with trusted proxy hops.
  assert.equal(config.httpLongPollPerIpEnabled, undefined);
  assert.equal(
    loadConfig('api', { ...env, TRUSTED_PROXY_IPS: '172.18.0.5' }).httpLongPollPerIpEnabled,
    undefined,
  );
  assert.equal(
    loadConfig('api', {
      ...env,
      TRUSTED_PROXY_IPS: '172.18.0.5',
      HTTP_LONG_POLL_PER_IP_ENABLED: 'true',
    }).httpLongPollPerIpEnabled,
    true,
  );
  for (const extra of [
    { HTTP_LONG_POLL_PER_IP_ENABLED: 'true' },
    { HTTP_LONG_POLL_PER_IP_ENABLED: 'yes', TRUSTED_PROXY_IPS: '172.18.0.5' },
  ])
    assert.throws(
      () => loadConfig('api', { ...env, ...extra }),
      /HTTP_LONG_POLL_PER_IP_ENABLED is invalid or lacks TRUSTED_PROXY_IPS/,
    );
  const custom = loadConfig('api', {
    ...env,
    HTTP_MAX_LONG_POLL: '200',
    HTTP_MAX_LONG_POLL_PER_IP: '8',
    HTTP_MAX_EDGE_IN_FLIGHT: '24',
    HTTP_LONG_POLL_OVERFLOW_DELAY_MS: '1000',
  });
  assert.deepEqual(
    [
      custom.httpMaxLongPoll,
      custom.httpMaxLongPollPerIp,
      custom.httpMaxEdgeInFlight,
      custom.httpLongPollOverflowDelayMs,
    ],
    [200, 8, 24, 1000],
  );
  for (const [key, invalid] of [
    ['HTTP_MAX_LONG_POLL', ['0', '1025', '-1', '1.5', ' 64', 'secret-do-not-print']],
    ['HTTP_MAX_LONG_POLL_PER_IP', ['0', '1025', '', 'secret-do-not-print']],
    ['HTTP_MAX_EDGE_IN_FLIGHT', ['0', '257', '1e2', 'secret-do-not-print']],
    ['HTTP_LONG_POLL_OVERFLOW_DELAY_MS', ['0', '999', '20001', 'secret-do-not-print']],
  ])
    for (const value of invalid)
      assert.throws(
        () => loadConfig('api', { ...env, [key]: value }),
        (error) => {
          assert.equal(error.message, `Invalid configuration: ${key}`);
          return true;
        },
      );
});
