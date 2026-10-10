import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPortal } from '../../infra/kitchen-portal/server.mjs';
import { validateCloudConfig, screenCookies } from '../../infra/kitchen-portal/cloud.mjs';
import { ORIGIN, call, cookieOf, key, leaked, setup } from './cloud-fixture.mjs';

const live = (mode) => `/kitchen-live/${mode}/cloud`;
const feed = (mode) => `${live(mode)}/v1/fulfillment`;
async function pair(ctx, mode, code = ctx.issueCode(mode)) {
  const r = await call(ctx.port, 'POST', live(mode) + '/pair', {}, { code });
  return { ...r, jar: cookieOf(r.cookie) };
}

test('cloud upstream config is validated, default off, and holds no keys', () => {
  assert.equal(validateCloudConfig(undefined), null);
  assert.equal(validateCloudConfig({ enabled: false }), null);
  const ok = { enabled: true, apiOrigin: 'http://pickchick-api:3100', branchId: randomUUID() };
  assert.equal(validateCloudConfig(ok).apiOrigin, 'http://pickchick-api:3100');
  for (const bad of [
    { ...ok, apiOrigin: 'http://api.pickchick.kz' },
    { ...ok, apiOrigin: 'http://8.8.8.8:3100' },
    { ...ok, apiOrigin: 'http://pickchick-api:3100/v1' },
    { ...ok, apiOrigin: 'http://user:pw@pickchick-api:3100' },
    { ...ok, keys: { prep: key() } },
    { ...ok, branchId: 'branch' },
    { ...ok, enabled: 'yes' },
  ])
    assert.throws(() => validateCloudConfig(bad), /INVALID_PORTAL_CONFIG/);
});

test('flag off: no cloud route, no flags in config.json, health unchanged', async () => {
  const ctx = await setup({ cloud: false });
  try {
    const r = await call(ctx.port, 'POST', live('prep') + '/pair', {}, { code: 'AB12-CD34EF' });
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

test('cashier down, fresh browser: code -> screen cookie -> cloud queue and actions, no cook', async () => {
  const ctx = await setup();
  try {
    await ctx.edgeDown();
    const before = await call(ctx.port, 'GET', '/kitchen-live/prep/config.json');
    assert.deepEqual([before.json.cloudKitchen, before.json.cloudPaired], [true, false]);
    const paired = await pair(ctx, 'prep');
    assert.equal(paired.status, 200);
    assert.match(
      paired.cookie,
      /^pickchick_cloud_screen_prep=[A-Za-z0-9_-]+; Max-Age=31536000; Path=\/kitchen-live\/prep\/; HttpOnly; SameSite=Strict; Secure$/,
    );
    const [screenKey] = ctx.world.screens.keys();
    assert.ok(!paired.text.includes(screenKey) && !paired.cookie.includes(screenKey));
    assert.deepEqual(Object.keys(paired.json).sort(), [
      'branchId',
      'role',
      'screenId',
      'stationIds',
    ]);
    const jar = { Cookie: paired.jar };
    const config = await call(ctx.port, 'GET', '/kitchen-live/prep/config.json', jar);
    assert.equal(config.json.cloudPaired, true);
    const queue = await call(
      ctx.port,
      'GET',
      `${feed('prep')}/kitchen?stationId=${ctx.world.prep}&limit=100`,
      jar,
    );
    assert.equal(queue.status, 200);
    const [item] = queue.json.items;
    assert.equal(item.displayNumber, '301');
    assert.equal(item.tasks[0].taskId, ctx.world.order.tasks[0].id);
    assert.equal(item.tasks[0].details.modifiers[0].priceMinor, undefined);
    assert.equal(item.echo, undefined);
    assert.ok(!leaked(ctx, queue.text));
    const upstream = ctx.world.cloudCalls.find((c) => c.path.startsWith('/v1/kitchen/kitchen'));
    assert.equal(upstream.headers.authorization, 'Bearer ' + screenKey);
    for (const h of ['forwarded', 'x-forwarded-for', 'x-real-ip', 'cookie', 'x-staff-session-id'])
      assert.equal(upstream.headers[h], undefined);
    const idem = randomUUID();
    const body = {
      action: 'start_task',
      expectedVersion: 3,
      taskId: item.tasks[0].taskId,
      expectedTaskVersion: 1,
    };
    const path = `${feed('prep')}/orders/${item.orderId}/actions`;
    const first = await call(ctx.port, 'POST', path, { ...jar, 'Idempotency-Key': idem }, body);
    assert.equal(first.status, 200);
    assert.deepEqual([first.json.version, first.json.displayNumber], [4, '301']);
    assert.ok(!leaked(ctx, first.text));
    const command = ctx.world.cloudCalls.find((c) => c.path === '/v1/kitchen/commands');
    assert.equal(command.headers.authorization, 'Bearer ' + screenKey, 'attributed to the screen');
    assert.equal(command.headers['idempotency-key'], idem);
    assert.deepEqual(JSON.parse(command.body), { orderId: item.orderId, ...body });
    const replay = await call(ctx.port, 'POST', path, { ...jar, 'Idempotency-Key': idem }, body);
    assert.equal(replay.json.version, 4);
    assert.equal(ctx.world.order.version, 4, 'replay did not apply twice');
    const stale = await call(
      ctx.port,
      'POST',
      path,
      { ...jar, 'Idempotency-Key': randomUUID() },
      body,
    );
    assert.equal(stale.status, 409);
    assert.deepEqual(Object.keys(stale.json).sort(), [
      'code',
      'message_key',
      'retryable',
      'trace_id',
    ]);
    // The cashier path for a cloud order is refused, and still needs a cook anyway.
    const edgeAction = await call(
      ctx.port,
      'POST',
      `/kitchen-live/prep/edge/v1/fulfillment/orders/${item.orderId}/actions`,
      { ...jar, 'Idempotency-Key': randomUUID() },
      { action: 'ready', expectedVersion: 4 },
    );
    assert.ok([400, 401].includes(edgeAction.status));
    assert.ok(!ctx.world.edgeCalls.some((c) => c.path.includes('/actions')));
    const health = await call(ctx.port, 'GET', '/kitchen-live/health');
    assert.deepEqual([health.json.edgeConnected, health.json.cloudConnected], [false, true]);
  } finally {
    await ctx.close();
  }
});

test('portal restart: the cookie alone (checked by the cloud) keeps the screen bound', async () => {
  const ctx = await setup();
  let second;
  try {
    const { jar } = await pair(ctx, 'assembly');
    second = await createPortal({
      origin: ORIGIN,
      key: 'a'.repeat(64),
      terminals: ctx.terminals,
      branchLabel: 'Synthetic',
      cloudKitchen: { enabled: true, apiOrigin: ctx.apiOrigin, branchId: ctx.world.branchId },
    });
    await new Promise((r) => second.server.listen(0, '127.0.0.1', r));
    const session = await call(second.server.address().port, 'GET', live('assembly') + '/session', {
      Cookie: jar,
    });
    assert.equal(session.status, 200);
    assert.equal(session.json.role, 'assembly');
    assert.deepEqual(session.json.stationIds, [ctx.world.assembly]);
  } finally {
    await second?.close();
    await ctx.close();
  }
});

test('revoke: next poll is 401, cookie cleared; foreign, forged and cross-role cookies refused', async () => {
  const ctx = await setup();
  try {
    const { jar } = await pair(ctx, 'prep');
    const url = `${feed('prep')}/kitchen?stationId=${ctx.world.prep}&limit=100`;
    assert.equal((await call(ctx.port, 'GET', url, { Cookie: jar })).status, 200);
    // A prep cookie means nothing on the assembly page (name, path and key derivation).
    const cross = await call(ctx.port, 'GET', live('assembly') + '/session', {
      Cookie: jar.replace('_prep=', '_assembly='),
    });
    assert.equal(cross.status, 401);
    const value = jar.split('=')[1];
    const forged = value.slice(0, -2) + (value.endsWith('AA') ? 'BB' : 'AA');
    assert.equal(
      (await call(ctx.port, 'GET', url, { Cookie: 'pickchick_cloud_screen_prep=' + forged }))
        .status,
      401,
    );
    // A cookie sealed by another portal secret is unreadable here.
    const other = screenCookies({ key: 'b'.repeat(64), mode: 'prep' }).seal({
      screenId: randomUUID(),
      branchId: ctx.world.branchId,
      role: 'prep',
      generation: 1,
      screenKey: [...ctx.world.screens.keys()][0],
    });
    assert.equal((await call(ctx.port, 'GET', url, { Cookie: cookieOf(other) })).status, 401);
    const calls = ctx.world.cloudCalls.length;
    assert.equal((await call(ctx.port, 'GET', url)).status, 401);
    assert.equal(ctx.world.cloudCalls.length, calls, 'no cookie, no cloud call');
    ctx.revokeAll();
    const revoked = await call(ctx.port, 'GET', url, { Cookie: jar });
    assert.equal(revoked.status, 401);
    assert.equal(revoked.json.code, 'UNAUTHORIZED');
    assert.match(
      revoked.cookie,
      /^pickchick_cloud_screen_prep=; Max-Age=0; Path=\/kitchen-live\/prep\//,
    );
    // Cloud outage is not a revocation: no cookie change.
    const fresh = await pair(ctx, 'prep');
    ctx.world.cloudDown = true;
    const outage = await call(ctx.port, 'GET', url, { Cookie: fresh.jar });
    assert.equal(outage.status, 503);
    assert.equal(outage.cookie, undefined);
  } finally {
    await ctx.close();
  }
});

test('pairing guards: wrong role/branch, bad and malformed codes, cross-site, rate limit', async () => {
  const ctx = await setup();
  try {
    const wrong = await pair(ctx, 'prep', ctx.issueCode('assembly'));
    assert.equal(wrong.status, 409);
    assert.equal(wrong.cookie, undefined);
    const foreign = await pair(ctx, 'prep', ctx.issueCode('prep', randomUUID()));
    assert.equal(foreign.status, 409);
    const bad = await pair(ctx, 'prep', 'ZZZZ-ZZZZZZ');
    assert.equal(bad.status, 401);
    assert.equal(bad.cookie, undefined);
    const calls = ctx.world.cloudCalls.length;
    assert.equal((await pair(ctx, 'prep', 'short')).status, 400);
    assert.equal(ctx.world.cloudCalls.length, calls);
    const cross = await call(
      ctx.port,
      'POST',
      live('prep') + '/pair',
      { Origin: 'https://evil.example' },
      { code: ctx.issueCode('prep') },
    );
    assert.equal(cross.status, 403);
    let limited;
    for (let i = 0; i < 12 && !limited; i++) {
      const r = await pair(ctx, 'prep', 'ZZZZ-ZZZZZZ');
      if (r.status === 429) limited = r;
    }
    assert.ok(limited, 'code attempts are rate limited per client');
    assert.equal(limited.json.code, 'RATE_LIMITED');
  } finally {
    await ctx.close();
  }
});

test('display screen reads merged-ready numbers only; cashier routes keep cook rules', async () => {
  const ctx = await setup();
  try {
    const { jar } = await pair(ctx, 'display');
    const board = await call(ctx.port, 'GET', `${feed('display')}/display?limit=100`, {
      Cookie: jar,
    });
    assert.equal(board.status, 200);
    assert.deepEqual(board.json, {
      items: [{ number: '301', state: 'ready' }],
      nextAfterNumber: null,
    });
    const action = await call(
      ctx.port,
      'POST',
      `${feed('display')}/orders/${ctx.world.order.orderId}/actions`,
      { Cookie: jar, 'Idempotency-Key': randomUUID() },
      { action: 'ready', expectedVersion: 3 },
    );
    assert.equal(action.status, 404);
    assert.ok(!ctx.world.cloudCalls.some((c) => c.path === '/v1/kitchen/commands'));
    // A prep screen never polls a station it does not serve (no false heartbeat, no 403).
    const prep = await pair(ctx, 'prep');
    const polls = () =>
      ctx.world.cloudCalls.filter((c) => c.path.startsWith('/v1/kitchen/kitchen'));
    const n = polls().length;
    const foreign = await call(
      ctx.port,
      'GET',
      `${feed('prep')}/kitchen?stationId=${ctx.world.assembly}&limit=100`,
      { Cookie: prep.jar },
    );
    assert.deepEqual(foreign.json, { items: [], nextAfterOrderId: null });
    assert.equal(polls().length, n);
    // Edge stream unchanged: a screen cookie is not a cook session.
    const edge = await call(
      ctx.port,
      'GET',
      `/kitchen-live/prep/edge/v1/fulfillment/kitchen?stationId=${ctx.world.prep}&limit=100`,
      { Cookie: prep.jar },
    );
    assert.equal(edge.status, 401);
    const cook = ctx.staff('prep');
    const withCook = await call(
      ctx.port,
      'GET',
      `/kitchen-live/prep/edge/v1/fulfillment/kitchen?stationId=${ctx.world.prep}&limit=100`,
      cook.headers,
    );
    assert.equal(withCook.status, 200);
  } finally {
    await ctx.close();
  }
});
