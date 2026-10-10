import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { validateCloudConfig } from '../../infra/kitchen-portal/cloud.mjs';
import { terminalCookies } from '../../apps/kitchen/terminal-cookie.mjs';
import { call, key, leaked, setup } from './cloud-fixture.mjs';

test('cloud upstream config is validated and default off', () => {
  assert.equal(validateCloudConfig(undefined), null);
  assert.equal(validateCloudConfig({ enabled: false }), null);
  const ok = {
    enabled: true,
    apiOrigin: 'http://pickchick-api:3100',
    branchId: randomUUID(),
    keys: { prep: key(), assembly: key(), display: key() },
  };
  assert.equal(validateCloudConfig(ok).apiOrigin, 'http://pickchick-api:3100');
  for (const bad of [
    { ...ok, apiOrigin: 'http://api.pickchick.kz' },
    { ...ok, apiOrigin: 'http://8.8.8.8:3100' },
    { ...ok, apiOrigin: 'http://pickchick-api:3100/v1' },
    { ...ok, apiOrigin: 'http://user:pw@pickchick-api:3100' },
    { ...ok, keys: { ...ok.keys, display: ok.keys.prep } },
    { ...ok, keys: { prep: ok.keys.prep, assembly: ok.keys.assembly } },
    { ...ok, keys: { ...ok.keys, prep: 'pcks_short' } },
    { ...ok, branchId: 'branch' },
    { ...ok, enabled: 'yes' },
  ])
    assert.throws(() => validateCloudConfig(bad), /INVALID_PORTAL_CONFIG/);
});

test('flag off: no cloud route, no flag in config.json, health unchanged', async () => {
  const ctx = await setup({ cloud: false });
  try {
    const { headers } = ctx.staff('prep');
    const r = await call(
      ctx.port,
      'GET',
      '/kitchen-live/prep/cloud/v1/fulfillment/stations',
      headers,
    );
    assert.equal(r.status, 404);
    const health = await call(ctx.port, 'GET', '/kitchen-live/health');
    assert.deepEqual(Object.keys(health.json).sort(), ['edgeConnected', 'sourceSha']);
    const config = await call(ctx.port, 'GET', '/kitchen-live/prep/config.json');
    assert.equal(config.status, 200);
    assert.equal(config.json.cloudKitchen, undefined);
    assert.equal(ctx.world.cloudCalls.length, 0);
  } finally {
    await ctx.close();
  }
});

test('both up: cloud queue in edge shape, key only in upstream header, owner routing and idempotent replay', async () => {
  const ctx = await setup();
  try {
    const { headers } = ctx.staff('prep');
    const base = '/kitchen-live/prep/cloud/v1/fulfillment';
    const stations = await call(ctx.port, 'GET', base + '/stations', headers);
    assert.equal(stations.status, 200);
    assert.deepEqual(stations.json, {
      branchId: ctx.world.branchId,
      items: [{ id: ctx.world.prep, kind: 'prep', name: 'Горячий цех' }],
    });
    const feed = await call(
      ctx.port,
      'GET',
      `${base}/kitchen?stationId=${ctx.world.prep}&limit=100`,
      headers,
    );
    assert.equal(feed.status, 200);
    const [item] = feed.json.items;
    assert.equal(item.displayNumber, '301');
    assert.equal(item.fulfillmentOwner, 'cloud');
    assert.equal(item.tasks[0].taskId, ctx.world.order.tasks[0].id);
    assert.equal(item.tasks[0].details.modifiers[0].priceMinor, undefined);
    assert.equal(item.echo, undefined);
    assert.ok(!leaked(ctx, feed.text) && !leaked(ctx, stations.text));
    // Upstream got the prep key over the private hop, without forwarding headers.
    const upstream = ctx.world.cloudCalls.find((c) => c.path.startsWith('/v1/kitchen/kitchen'));
    assert.equal(upstream.headers.authorization, 'Bearer ' + ctx.keys.prep);
    for (const h of ['forwarded', 'x-forwarded-for', 'x-real-ip', 'cookie', 'x-staff-session-id'])
      assert.equal(upstream.headers[h], undefined);
    // Edge feed still served by the cashier as before.
    const edgeFeed = await call(
      ctx.port,
      'GET',
      `/kitchen-live/prep/edge/v1/fulfillment/kitchen?stationId=${ctx.world.prep}&limit=100`,
      headers,
    );
    assert.equal(edgeFeed.status, 200);
    // A cloud-owned order is never acted on by the cashier.
    const edgeAction = await call(
      ctx.port,
      'POST',
      `/kitchen-live/prep/edge/v1/fulfillment/orders/${item.orderId}/actions`,
      { ...headers, 'Idempotency-Key': randomUUID() },
      { action: 'ready', expectedVersion: 3 },
    );
    assert.equal(edgeAction.status, 400);
    assert.ok(!ctx.world.edgeCalls.some((c) => c.path.includes('/actions')));
    // The cloud command goes to the cloud only, with key and expectedVersion.
    const idem = randomUUID();
    const body = {
      action: 'start_task',
      expectedVersion: 3,
      taskId: item.tasks[0].taskId,
      expectedTaskVersion: 1,
    };
    const first = await call(
      ctx.port,
      'POST',
      `${base}/orders/${item.orderId}/actions`,
      { ...headers, 'Idempotency-Key': idem },
      body,
    );
    assert.equal(first.status, 200);
    assert.deepEqual(
      [first.json.orderId, first.json.version, first.json.displayNumber],
      [item.orderId, 4, '301'],
    );
    assert.ok(!leaked(ctx, first.text));
    const command = ctx.world.cloudCalls.find((c) => c.path === '/v1/kitchen/commands');
    assert.equal(command.headers['idempotency-key'], idem);
    assert.deepEqual(JSON.parse(command.body), { orderId: item.orderId, ...body });
    const replay = await call(
      ctx.port,
      'POST',
      `${base}/orders/${item.orderId}/actions`,
      { ...headers, 'Idempotency-Key': idem },
      body,
    );
    assert.equal(replay.status, 200);
    assert.equal(replay.json.version, 4);
    assert.equal(ctx.world.order.version, 4, 'replay did not apply twice');
    // Stale version: 409 CONFLICT in the shared error shape.
    const stale = await call(
      ctx.port,
      'POST',
      `${base}/orders/${item.orderId}/actions`,
      { ...headers, 'Idempotency-Key': randomUUID() },
      body,
    );
    assert.equal(stale.status, 409);
    assert.equal(stale.json.code, 'CONFLICT');
    assert.deepEqual(Object.keys(stale.json).sort(), [
      'code',
      'message_key',
      'retryable',
      'trace_id',
    ]);
    const health = await call(ctx.port, 'GET', '/kitchen-live/health');
    assert.deepEqual([health.json.edgeConnected, health.json.cloudConnected], [true, true]);
    const config = await call(ctx.port, 'GET', '/kitchen-live/prep/config.json');
    assert.equal(config.json.cloudKitchen, true);
    assert.ok(!leaked(ctx, config.text) && !config.text.includes('127.0.0.1:'));
  } finally {
    await ctx.close();
  }
});

test('cashier down: a confirmed session keeps cloud orders visible and actionable', async () => {
  const ctx = await setup();
  try {
    const known = ctx.staff('assembly'),
      unknown = ctx.staff('assembly');
    const base = '/kitchen-live/assembly/cloud/v1/fulfillment';
    assert.equal((await call(ctx.port, 'GET', base + '/stations', known.headers)).status, 200);
    await ctx.edgeDown();
    const feed = await call(
      ctx.port,
      'GET',
      `${base}/kitchen?stationId=${ctx.world.assembly}&limit=100`,
      known.headers,
    );
    assert.equal(feed.status, 200);
    assert.equal(feed.json.items[0].orderId, ctx.world.order.orderId);
    const done = await call(
      ctx.port,
      'POST',
      `${base}/orders/${ctx.world.order.orderId}/actions`,
      { ...known.headers, 'Idempotency-Key': randomUUID() },
      { action: 'ready', expectedVersion: ctx.world.order.version },
    );
    assert.equal(done.status, 200);
    const command = ctx.world.cloudCalls.find((c) => c.path === '/v1/kitchen/commands');
    assert.equal(command.headers.authorization, 'Bearer ' + ctx.keys.assembly);
    // A session the cashier never confirmed is not trusted while it is away.
    const before = ctx.world.cloudCalls.length;
    const refused = await call(ctx.port, 'GET', base + '/stations', unknown.headers);
    assert.equal(refused.status, 503);
    assert.equal(ctx.world.cloudCalls.length, before);
    // Edge stream reports its own outage; cloud health stays connected.
    const health = await call(ctx.port, 'GET', '/kitchen-live/health');
    assert.deepEqual([health.json.edgeConnected, health.json.cloudConnected], [false, true]);
  } finally {
    await ctx.close();
  }
});

test('portal session gate: revoked, missing or foreign-terminal sessions never reach the cloud', async () => {
  const ctx = await setup();
  try {
    const base = '/kitchen-live/prep/cloud/v1/fulfillment';
    const s = ctx.staff('prep');
    ctx.world.revoked.add(s.session.session_id);
    const revoked = await call(ctx.port, 'GET', base + '/stations', s.headers);
    assert.equal(revoked.status, 401);
    assert.equal(revoked.json.code, 'UNAUTHORIZED');
    assert.equal((await call(ctx.port, 'GET', base + '/stations')).status, 401);
    const other = ctx.staff('assembly');
    assert.equal((await call(ctx.port, 'GET', base + '/stations', other.headers)).status, 401);
    // Cross-site POST is refused before any session or cloud work.
    const ok = ctx.staff('prep');
    const cross = await call(
      ctx.port,
      'POST',
      `${base}/orders/${ctx.world.order.orderId}/actions`,
      { ...ok.headers, Origin: 'https://evil.example', 'Idempotency-Key': randomUUID() },
      { action: 'ready', expectedVersion: 3 },
    );
    assert.equal(cross.status, 403);
    assert.equal(ctx.world.cloudCalls.length, 0);
  } finally {
    await ctx.close();
  }
});

test('display role uses the display key; revoked cloud key is an outage, not a sign-out', async () => {
  const ctx = await setup();
  try {
    const d = ctx.staff('display');
    const board = await call(
      ctx.port,
      'GET',
      '/kitchen-live/display/cloud/v1/fulfillment/display?limit=100',
      d.headers,
    );
    assert.equal(board.status, 200);
    assert.deepEqual(board.json, {
      items: [{ number: '301', state: 'ready' }],
      nextAfterNumber: null,
    });
    assert.equal(ctx.world.cloudCalls.at(-1).headers.authorization, 'Bearer ' + ctx.keys.display);
    const action = await call(
      ctx.port,
      'POST',
      `/kitchen-live/display/cloud/v1/fulfillment/orders/${ctx.world.order.orderId}/actions`,
      { ...d.headers, 'Idempotency-Key': randomUUID() },
      { action: 'ready', expectedVersion: 3 },
    );
    assert.equal(action.status, 404);
    assert.ok(!ctx.world.cloudCalls.some((c) => c.path === '/v1/kitchen/commands'));
    // A station outside the role key: empty, no feed poll (no false heartbeat, no 403).
    const p = ctx.staff('prep');
    const before = ctx.world.cloudCalls.filter((c) => c.path.startsWith('/v1/kitchen/kitchen'));
    const foreign = await call(
      ctx.port,
      'GET',
      `/kitchen-live/prep/cloud/v1/fulfillment/kitchen?stationId=${ctx.world.assembly}&limit=100`,
      p.headers,
    );
    assert.deepEqual(foreign.json, { items: [], nextAfterOrderId: null });
    assert.equal(
      ctx.world.cloudCalls.filter((c) => c.path.startsWith('/v1/kitchen/kitchen')).length,
      before.length,
    );
    ctx.world.cloudRevoked = true;
    const outage = await call(
      ctx.port,
      'GET',
      '/kitchen-live/prep/cloud/v1/fulfillment/stations',
      p.headers,
    );
    assert.equal(outage.status, 503);
    assert.equal(outage.json.code, 'SERVICE_UNAVAILABLE');
    const bad = await call(
      ctx.port,
      'GET',
      '/kitchen-live/prep/cloud/v1/fulfillment/kitchen?stationId=x',
      p.headers,
    );
    assert.equal(bad.status, 404);
  } finally {
    await ctx.close();
  }
});

test('paired customer display reads cloud numbers by its device cookie, other branches refused', async () => {
  const ctx = await setup({ terminalAccess: true });
  try {
    const seal = (branchId, mode = 'display') =>
      terminalCookies({ key: 'a'.repeat(64), mode, path: `/kitchen-live/${mode}/` })
        .seal({
          terminalId: randomUUID(),
          branchId,
          mode,
          generation: 1,
          terminalKey: 'b'.repeat(64),
        })
        .split(';')[0];
    const path = '/kitchen-live/display/cloud/v1/fulfillment/display?limit=100';
    assert.equal((await call(ctx.port, 'GET', path)).status, 401);
    const board = await call(ctx.port, 'GET', path, { Cookie: seal(ctx.world.branchId) });
    assert.equal(board.status, 200);
    assert.equal(board.json.items[0].number, '301');
    const foreign = await call(ctx.port, 'GET', path, { Cookie: seal(randomUUID()) });
    assert.equal(foreign.status, 503);
    // Paired kitchen pages still need a confirmed staff session for cloud work.
    const prep = await call(ctx.port, 'GET', '/kitchen-live/prep/cloud/v1/fulfillment/stations', {
      Cookie: seal(ctx.world.branchId, 'prep'),
    });
    assert.equal(prep.status, 401);
  } finally {
    await ctx.close();
  }
});
