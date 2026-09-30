import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { CustomerIdentity } from '../../packages/customer-identity/dist/index.js';
import {
  TestOrderFlow,
  TEST_BRANCH_ID,
  provisionTestActor,
} from '../../packages/test-order-flow/dist/index.js';
import { createPool } from '@pickchick/database';
import { createApi } from '@pickchick/api';
import { customerAuthGrants } from '../../infra/staging/customer-auth-grants.mjs';
import { running } from '../helpers/sync.mjs';
import { withSyncDatabases } from '../helpers/sync.mjs';

const config = { enabled: true, environment: 'test', customerAuthEnabled: true };
const cart = {
  catalog_version: 'mockup-v0.2',
  service_mode: 'takeaway',
  items: [{ product_id: 'pick-combo', quantity: 1 }],
};
const code = (expected) => (error) => error.code === expected;
async function fixture(run) {
  await withSyncDatabases(async (ctx) => {
    const pool = ctx.cloud.pool;
    await pool.query(
      "INSERT INTO branches(id,organization_id,legal_entity_id,code,name) VALUES($1,$2,$3,'TEST-ALMATY-01','Pilot fixture')",
      [TEST_BRANCH_ID, ctx.org, ctx.legal],
    );
    let otp;
    const identity = new CustomerIdentity(
      pool,
      {
        enabled: true,
        consentVersion: 'pilot-test',
        termsUrl: 'https://example.test/terms',
        privacyUrl: 'https://example.test/privacy',
        dailySmsBudget: 1000,
        lookupKey: randomBytes(32),
        otpKey: randomBytes(32),
        piiKey: randomBytes(32),
        receiptKey: randomBytes(32),
      },
      {
        provider: 'mobizon',
        async sendCode(input) {
          otp = input.code;
          return {
            kind: 'submitted',
            provider: 'mobizon',
            submission: 'accepted',
            messageId: randomUUID(),
            campaignId: '1',
          };
        },
      },
    );
    const login = async (phone) => {
      await pool.query(
        "UPDATE identity_otp_challenges SET created_at=created_at-interval '61 seconds'",
      );
      const device_id = randomUUID();
      const sent = await identity.requestOtp(
        {
          phone,
          device_id,
          request_id: randomUUID(),
          delivery_consent: { privacy_version: 'pilot-test', accepted: true },
        },
        '192.0.2.10',
      );
      return identity.verifyOtp({
        challenge_id: sent.challenge_id,
        device_id,
        request_id: randomUUID(),
        code: otp,
        consents: {
          terms_version: 'pilot-test',
          privacy_version: 'pilot-test',
          marketing_opt_in: false,
        },
      });
    };
    await run({ ctx, pool, identity, login, flow: new TestOrderFlow(pool, config) });
  });
}
test('verified customers have isolated durable actors, anonymous history is never adopted, kitchen and feedback retain ownership', async () =>
  fixture(async ({ pool, identity, login, flow }) => {
    const oldFlow = new TestOrderFlow(pool, { enabled: true, environment: 'test' });
    const legacy = await oldFlow.issueSession({ channel: 'mobile' });
    const a = await login('+77010000001'),
      b = await login('+77010000002');
    await assert.rejects(flow.issueSession({ channel: 'mobile' }), code('UNAUTHORIZED'));
    const [actor, repeated] = await Promise.all([
      flow.issueSession({ channel: 'mobile' }, a.access_token),
      flow.issueSession({ channel: 'mobile' }, a.access_token),
    ]);
    assert.equal(actor.session_id, repeated.session_id);
    assert.notEqual(actor.session_id, legacy.session_id);
    const other = await flow.issueSession({ channel: 'mobile' }, b.access_token);
    assert.notEqual(actor.session_id, other.session_id);
    await assert.rejects(flow.quote(legacy.token, randomUUID(), cart), code('UNAUTHORIZED'));
    await assert.rejects(flow.continueSession(legacy.token, {}), code('UNAUTHORIZED'));
    const quote = await flow.quote(a.access_token, randomUUID(), cart);
    const key = randomUUID();
    const body = { quote_id: quote.quote_id, execution_mode: 'unpaid_test' };
    let order = await flow.createOrder(a.access_token, key, body);
    assert.equal(order.payment_state, 'not_started');
    assert.equal(order.fiscal_state, 'not_applicable');
    assert.equal((await flow.createOrder(a.access_token, key, body)).order_id, order.order_id);
    await assert.rejects(flow.readOrder(b.access_token, order.order_id), code('NOT_FOUND'));
    await assert.rejects(flow.feedback(b.access_token, order.order_id), code('NOT_FOUND'));
    const prep = await provisionTestActor(pool, config, 'prep'),
      assembly = await provisionTestActor(pool, config, 'assembly'),
      display = await provisionTestActor(pool, config, 'display');
    assert.equal((await flow.kitchen(prep.token)).orders.length, 1);
    for (const station of ['prep', 'assembly']) {
      for (const task of order.tasks.filter((t) => t.station === station && t.state === 'pending'))
        order = await flow.completeTask(
          station === 'prep' ? prep.token : assembly.token,
          randomUUID(),
          order.order_id,
          task.task_id,
          { expected_version: order.version },
        );
    }
    assert.equal(order.state, 'ready');
    assert.equal((await flow.display(display.token)).ready.length, 1);
    order = await flow.handoff(assembly.token, randomUUID(), order.order_id, {
      expected_version: order.version,
    });
    assert.equal(order.state, 'fulfilled');
    await identity.logout(a.access_token);
    await assert.rejects(flow.readOrder(a.access_token, order.order_id), code('UNAUTHORIZED'));
    const relogin = await login('+77010000001');
    assert.equal(
      (
        await new TestOrderFlow(pool, config).issueSession(
          { channel: 'mobile' },
          relogin.access_token,
        )
      ).session_id,
      actor.session_id,
    );
    assert.equal((await flow.readOrder(relogin.access_token, order.order_id)).state, 'fulfilled');
    const kiosk = await flow.issueSession({ channel: 'kiosk' });
    assert.equal(kiosk.channel, 'kiosk');
    await identity.deleteMe(relogin.access_token);
    await assert.rejects(
      flow.readOrder(relogin.access_token, order.order_id),
      code('UNAUTHORIZED'),
    );
    const recycled = await login('+77010000001');
    assert.notEqual(
      (await flow.issueSession({ channel: 'mobile' }, recycled.access_token)).session_id,
      actor.session_id,
    );
    await assert.rejects(flow.readOrder(recycled.access_token, order.order_id), code('NOT_FOUND'));
  }));

test('restricted runtime binds verified actors and HTTP rejects anonymous mobile sessions', async () =>
  fixture(async ({ ctx, pool, login }) => {
    const user = await login('+77010000001');
    const role = 'pilot_runtime_' + randomUUID().replaceAll('-', '');
    await ctx.cloud.admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE`);
    let runtime;
    let api;
    const env = {
      CUSTOMER_AUTH_CONSENT_VERSION: 'pilot-test',
      CUSTOMER_AUTH_TERMS_URL: 'https://example.test/terms',
      CUSTOMER_AUTH_PRIVACY_URL: 'https://example.test/privacy',
      CUSTOMER_AUTH_DAILY_SMS_BUDGET: '1000',
      PHONE_DELIVERY_PROVIDER: 'telegram_gateway',
      TELEGRAM_GATEWAY_TOKEN: 'synthetic-token-never-sent',
      PHONE_SMS_FALLBACK_ENABLED: 'false',
    };
    for (const key of ['LOOKUP', 'OTP', 'PII', 'RECEIPT'])
      env['CUSTOMER_AUTH_' + key + '_KEY'] = randomBytes(32).toString('hex');
    const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
    try {
      await pool.query(`GRANT USAGE ON SCHEMA ${ctx.cloud.schema} TO ${role}`);
      await pool.query(customerAuthGrants(role, true));
      await pool.query(
        `GRANT SELECT ON branches,test_flow_lock,test_actors,test_orders,test_kitchen_tasks,test_combo_stamps TO ${role}; GRANT UPDATE(id) ON test_flow_lock TO ${role}; GRANT INSERT ON test_actors TO ${role}`,
      );
      const url = new URL(ctx.cloud.config.databaseUrl);
      url.searchParams.set('options', `-c search_path=${ctx.cloud.schema} -c role=${role}`);
      runtime = createPool(url.toString(), 2);
      const restricted = new TestOrderFlow(runtime, config);
      const actor = await restricted.issueSession({ channel: 'mobile' }, user.access_token);
      assert.ok(actor.session_id);
      assert.deepEqual((await restricted.ownOrders(user.access_token)).orders, []);
      await assert.rejects(
        runtime.query('DELETE FROM identity_customer_test_actors'),
        (error) => error.code === '42501',
      );
      Object.assign(process.env, env);
      api = await running(createApi, {
        ...ctx.cloud.config,
        testOrderFlowEnabled: true,
        customerAuthEnabled: true,
      });
      const caps = await (await fetch(api.url + '/v1/capabilities')).json();
      assert.equal(caps.data_mode, 'pilot');
      assert.equal(caps.features.phone_auth, true);
      assert.equal(caps.features.payments, false);
      assert.equal((await fetch(api.url + '/health/ready')).status, 200);
      const progressReply = await fetch(api.url + '/v1/test/combo-progress', {
        headers: { Authorization: 'Bearer ' + user.access_token },
      });
      assert.equal(progressReply.status, 200);
      assert.equal((await progressReply.json()).redeemable, false);
      assert.equal((await fetch(api.url + '/v1/test/combo-progress')).status, 401);

      for (const [token, status] of [
        ['', 401],
        [user.access_token, 201],
      ]) {
        const reply = await fetch(api.url + '/v1/test/sessions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: 'Bearer ' + token } : {}),
          },
          body: JSON.stringify({ channel: 'mobile' }),
        });
        assert.equal(reply.status, status);
        if (status === 201) assert.equal((await reply.json()).session_id, actor.session_id);
      }
    } finally {
      await api?.app.close();
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await runtime?.end();
      await pool.query(`DROP OWNED BY ${role}`);
      await ctx.cloud.admin.query(`DROP ROLE ${role}`);
    }
  }));

test('practice combo journal is atomic, quantity-based, idempotent and isolated by verified customer', async () =>
  fixture(async ({ pool, ctx, login, flow }) => {
    const a = await login('+77010000001');
    const b = await login('+77010000002');
    await flow.issueSession({ channel: 'mobile' }, a.access_token);
    await flow.issueSession({ channel: 'mobile' }, b.access_token);
    const manager = await provisionTestActor(pool, config, 'manager');
    const make = async (quantity, product = 'pick-combo') => {
      const quote = await flow.quote(a.access_token, randomUUID(), {
        ...cart,
        items: [{ product_id: product, quantity }],
      });
      return flow.createOrder(a.access_token, randomUUID(), {
        quote_id: quote.quote_id,
        execution_mode: 'unpaid_test',
      });
    };
    const ready = async (order) => {
      for (const station of ['prep', 'assembly']) {
        const task = order.tasks.find((t) => t.station === station && t.state === 'pending');
        if (task)
          order = await flow.completeTask(
            manager.token,
            randomUUID(),
            order.order_id,
            task.task_id,
            { expected_version: order.version, complete_station: true },
          );
      }
      return order;
    };
    assert.equal((await flow.comboProgress(a.access_token)).earned_units, 0);
    let order = await ready(await make(7));
    assert.equal(
      (await flow.comboProgress(a.access_token)).earned_units,
      0,
      'ready is not handed out',
    );
    const role = 'combo_runtime_' + randomUUID().replaceAll('-', '');
    await ctx.cloud.admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE`);
    let runtime;
    try {
      await pool.query(`GRANT USAGE ON SCHEMA ${ctx.cloud.schema} TO ${role}`);
      await pool.query(customerAuthGrants(role, true));
      await pool.query(`GRANT SELECT ON branches,test_flow_lock,test_actors,test_orders,test_kitchen_tasks,test_command_results,test_combo_stamps TO ${role};
        GRANT UPDATE(id) ON test_flow_lock TO ${role};
        GRANT UPDATE(state,version,updated_at) ON test_orders TO ${role};
        GRANT INSERT ON test_command_results,test_outbox TO ${role}`);
      const url = new URL(ctx.cloud.config.databaseUrl);
      url.searchParams.set('options', `-c search_path=${ctx.cloud.schema} -c role=${role}`);
      runtime = createPool(url.toString());
      const runtimeFlow = new TestOrderFlow(runtime, config);
      const key = randomUUID();
      const input = { expected_version: order.version };
      await assert.rejects(
        runtimeFlow.handoff(manager.token, key, order.order_id, input),
        (error) => error.code === '42501' && error.message.includes('test_combo_stamps'),
      );
      assert.equal(
        (await flow.readOrder(a.access_token, order.order_id)).state,
        'ready',
        'stamp failure rolls back handoff',
      );
      await pool.query(`GRANT INSERT ON test_combo_stamps TO ${role}`);
      const [first, repeated] = await Promise.all([
        runtimeFlow.handoff(manager.token, key, order.order_id, input),
        runtimeFlow.handoff(manager.token, key, order.order_id, input),
      ]);
      assert.equal(first.version, repeated.version);
      await assert.rejects(
        runtimeFlow.handoff(manager.token, randomUUID(), order.order_id, input),
        code('CONFLICT'),
      );
      const progress = await runtimeFlow.comboProgress(a.access_token);
      assert.deepEqual(
        [
          progress.earned_units,
          progress.completed_cycles,
          progress.current_stamps,
          progress.redeemable,
        ],
        [7, 1, 0, false],
      );
      assert.equal((await flow.comboProgress(b.access_token)).earned_units, 0);
      await assert.rejects(flow.comboProgress(manager.token), code('FORBIDDEN'));
      await assert.rejects(flow.comboProgress(''), code('UNAUTHORIZED'));
      assert.equal((await pool.query('SELECT count(*) FROM test_combo_stamps')).rows[0].count, '1');
      await assert.rejects(
        runtime.query('UPDATE test_combo_stamps SET units=1'),
        (error) => error.code === '42501',
      );
    } finally {
      await runtime?.end();
      await pool.query(`DROP OWNED BY ${role}`);
      await ctx.cloud.admin.query(`DROP ROLE ${role}`);
    }
    order = await ready(await make(1));
    await flow.handoff(manager.token, randomUUID(), order.order_id, {
      expected_version: order.version,
    });
    let progress = await flow.comboProgress(a.access_token);
    assert.equal(progress.current_stamps, 1);
    assert.equal(progress.completed_cycles, 1);
    order = await make(2);
    await flow.cancel(a.access_token, randomUUID(), order.order_id, {
      expected_version: order.version,
      reason: 'Changed mind',
    });
    order = await ready(await make(1, 'cola'));
    await flow.handoff(manager.token, randomUUID(), order.order_id, {
      expected_version: order.version,
    });
    progress = await flow.comboProgress(a.access_token);
    assert.equal(progress.earned_units, 8, 'cancelled orders and drinks add nothing');
    const otherDevice = await login('+77010000001');
    assert.deepEqual(
      await new TestOrderFlow(pool, config).comboProgress(otherDevice.access_token),
      progress,
    );
  }));
