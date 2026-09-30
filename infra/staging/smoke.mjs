import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPool } from '@pickchick/database';
import { loadConfig } from '@pickchick/platform';
import { provisionDevice } from '@pickchick/menu-sync';
import { fixtureIds } from '@pickchick/test-fixtures';
import {
  provisionTestActor,
  revokeTestActor,
  TEST_ACCESS_NO_EXPIRY,
} from '@pickchick/test-order-flow';

async function testOrderFlowSmoke(config, owner, runtime, request) {
  const flowConfig = { enabled: true, environment: config.environment };
  const actors = [];
  let customerId;
  const tokenFor = (role) => actors.find((actor) => actor.role === role).token;
  const send = async (path, token, body, key) => {
    const response = await request(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(key ? { 'Idempotency-Key': key } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert.ok([200, 201].includes(response.status), `TEST runtime HTTP failed: ${path}`);
    const result = await response.json();
    if (path.startsWith('/v1/test/')) {
      assert.equal(result.synthetic, true);
      assert.equal(result.namespace, 'pickchick-test');
    }
    return result;
  };
  const command = (path, token, body, key = randomUUID()) =>
    send(`/v1/test/${path}`, token, body, key);
  try {
    for (const role of ['prep', 'assembly', 'display', 'manager']) {
      actors.push(await provisionTestActor(owner, flowConfig, role));
      assert.equal(actors.at(-1).expires_at, TEST_ACCESS_NO_EXPIRY);
    }
    const capabilities = await send('/v1/capabilities');
    assert.equal(capabilities.features.test_order_flow, true);
    assert.equal(capabilities.ordering_enabled, false);
    for (const feature of ['phone_auth', 'checkout', 'payments', 'fiscal', 'loyalty']) {
      assert.equal(capabilities.features[feature], false);
    }
    const catalog = await send('/v1/test/catalog');
    const product = catalog.products.find((item) => item.prep_required);
    assert.ok(product);
    const session = await command('sessions', undefined, { channel: 'mobile' });
    customerId = session.session_id;
    assert.equal(session.expires_at, TEST_ACCESS_NO_EXPIRY);
    assert.equal(
      (await owner.query('SELECT expires_at FROM test_actors WHERE id=$1', [customerId])).rows[0]
        .expires_at,
      Infinity,
    );
    const quote = await command('quotes', session.token, {
      catalog_version: catalog.catalog_version,
      service_mode: 'takeaway',
      items: [{ product_id: product.id, quantity: 1 }],
    });
    const createKey = randomUUID();
    let order = await command('orders', session.token, { quote_id: quote.quote_id }, createKey);
    assert.deepEqual(
      await command('orders', session.token, { quote_id: quote.quote_id }, createKey),
      order,
    );
    assert.equal(order.state, 'awaiting_test_payment');
    const daily = await send(
      `/v1/test/orders/${order.order_id}?number_format=daily`,
      session.token,
    );
    assert.match(daily.number, /^[1-9]\d*$/);
    assert.deepEqual({ ...daily, number: order.number }, order);
    const path = `orders/${order.order_id}`;
    order = await command(`${path}/simulated-payment`, session.token, {
      expected_version: order.version,
      outcome: 'approved',
    });
    assert.equal(order.state, 'preparing');
    // Refresh legacy cached metadata while an order is cooking; nothing is reset.
    assert.deepEqual(await command('sessions/continue', session.token, {}), session);
    assert.equal((await send(`/v1/test/${path}`, session.token)).state, 'preparing');
    const kitchen = await send('/v1/test/kitchen', tokenFor('prep'));
    assert.ok(kitchen.orders.some((row) => row.order_id === order.order_id));
    for (const task of order.tasks.filter((task) => task.station === 'prep')) {
      order = await command(`${path}/tasks/${task.task_id}/complete`, tokenFor('prep'), {
        expected_version: order.version,
      });
    }
    const assembly = order.tasks.find((task) => task.station === 'assembly');
    assert.ok(assembly);
    order = await command(`${path}/tasks/${assembly.task_id}/complete`, tokenFor('assembly'), {
      expected_version: order.version,
    });
    assert.equal(order.state, 'ready');
    const display = await send('/v1/test/display', tokenFor('display'));
    assert.ok(display.ready.some((row) => row.number === order.number));
    order = await command(`${path}/handoff`, tokenFor('assembly'), {
      expected_version: order.version,
    });
    assert.equal(order.state, 'fulfilled');
    assert.equal(order.payment_state, 'simulated_approved');
    assert.equal(order.fiscal_state, 'not_applicable');
    const manager = await send('/v1/test/manager/orders', tokenFor('manager'));
    assert.ok(manager.orders.some((row) => row.order_id === order.order_id));
    assert.equal((await send(`/v1/test/${path}`, session.token)).state, 'fulfilled');
    // The next-day client must explicitly recover the same completed session;
    // this exercises the only additional runtime column grant.
    await owner.query(
      "UPDATE test_actors SET created_at=created_at-interval '3 hours', expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [session.session_id],
    );
    const continued = await command('sessions/continue', session.token, {});
    assert.equal(continued.session_id, session.session_id);
    assert.equal(continued.token, session.token);
    assert.equal(continued.expires_at, TEST_ACCESS_NO_EXPIRY);
    const repeatedContinuation = await command('sessions/continue', session.token, {});
    assert.equal(repeatedContinuation.expires_at, continued.expires_at);
    assert.equal((await send(`/v1/test/${path}`, session.token)).state, 'fulfilled');
    for (const sql of [
      'UPDATE test_actors SET role=role',
      'UPDATE test_actors SET revoked_at=revoked_at',
      'UPDATE test_quotes SET total_minor=total_minor',
      'UPDATE test_outbox SET event_type=event_type',
      'UPDATE branches SET ordering_enabled=ordering_enabled',
    ]) {
      await assert.rejects(runtime.query(sql), { code: '42501' });
    }
    await revokeTestActor(owner, flowConfig, session.session_id);
    const revokedResponse = await request(`/v1/test/${path}`, {
      headers: { Authorization: `Bearer ${session.token}` },
    });
    assert.equal(revokedResponse.status, 401);
  } finally {
    if (customerId) await revokeTestActor(owner, flowConfig, customerId);
    for (const actor of actors) await revokeTestActor(owner, flowConfig, actor.actor_id);
  }
}

async function smoke() {
  const config = loadConfig('api');
  assert.equal(config.environment, 'staging');
  const owner = createPool(config.databaseUrl);
  const url = new URL(config.databaseUrl);
  url.username = 'pickchick_app';
  url.password = process.env.DB_APP_PASSWORD;
  const runtime = createPool(url.href);
  const request = (path, options) =>
    fetch(`http://api:3100${path}`, {
      ...options,
      signal: AbortSignal.timeout(3000),
      redirect: 'error',
    });
  try {
    const ready = await request('/health/ready');
    assert.equal(ready.status, 200);
    assert.equal((await ready.json()).degraded, false);
    const branches = await (await request('/v1/branches')).json();
    assert.equal(branches.branches.find((b) => b.id === fixtureIds.branch).ordering_enabled, false);
    assert.equal((await request('/internal/v1/edge/sync/pull')).status, 401);
    await assert.rejects(runtime.query('CREATE TABLE runtime_forbidden (id integer)'), {
      code: '42501',
    });
    await assert.rejects(runtime.query('UPDATE devices SET status = status'), { code: '42501' });
    await assert.rejects(runtime.query('DELETE FROM schema_migrations'), { code: '42501' });
    const device = await owner.query('SELECT status FROM devices WHERE id=$1', [fixtureIds.device]);
    const identity = await provisionDevice(
      owner,
      fixtureIds.device,
      device.rows[0].status === 'active',
    );
    const pull = await request('/internal/v1/edge/sync/pull', {
      headers: {
        Authorization: `Bearer ${identity.token}`,
        'X-Device-Id': identity.device_id,
      },
    });
    assert.equal(pull.status, 200); // Includes row locks with the restricted runtime DB role.
    if (config.testOrderFlowEnabled) {
      await testOrderFlowSmoke(config, owner, runtime, request);
    }
    console.log(
      JSON.stringify({
        event: 'staging_smoke_passed',
        checks: [
          'readiness',
          'synthetic_branch_closed',
          'unauthorized_401',
          'runtime_ddl_denied',
          'device_mutation_denied',
          'migration_mutation_denied',
          'authorized_pull',
          ...(config.testOrderFlowEnabled
            ? ['test_flow_runtime_journey', 'test_flow_replay', 'test_flow_privilege_denial']
            : []),
        ],
      }),
    );
  } finally {
    await runtime.end();
    await owner.end();
  }
}
try {
  await smoke();
} catch {
  console.error(JSON.stringify({ event: 'staging_smoke_failed' }));
  process.exitCode = 1;
}
