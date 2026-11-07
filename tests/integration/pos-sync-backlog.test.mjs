// #312 step 4: read-only backlog report before the first PickChickPosSync Install.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  createQuote,
  createLocalOrder,
  cancelLocalOrder,
  openCashShift,
  provisionStaff,
} from '@pickchick/local-orders';
import { applyMenu, hashJson } from '@pickchick/menu-sync';
import { fixtureMenu } from '@pickchick/test-fixtures';
import { fixture } from '../../packages/edge-fulfillment/tests/fixture.mjs';
import { backlogConfig, posSyncBacklog } from '../../infra/windows/pos-sync-backlog.mjs';

const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

async function publishMenu(ctx) {
  const menu = { ...fixtureMenu, release_id: randomUUID(), branch_id: ctx.scope.branchId };
  await applyMenu(ctx.pool, ctx.scope.branchId, {
    event_id: randomUUID(),
    producer_id: randomUUID(),
    producer_sequence: '1',
    branch_id: ctx.scope.branchId,
    aggregate_type: 'menu_release',
    aggregate_id: menu.release_id,
    aggregate_version: 1,
    schema_version: 1,
    event_type: 'menu.published',
    payload: { menu, checksum: hashJson(menu) },
    occurred_at: new Date().toISOString(),
    correlation_id: randomUUID(),
    causation_id: null,
  });
  return menu;
}

test('backlog report counts what the first POS sync Install would send and changes nothing', () =>
  fixture(async (ctx) => {
    const branch = ctx.scope.branchId;
    const empty = await posSyncBacklog(ctx.pool, branch);
    assert.equal(empty.order_sync.bound, false);
    assert.equal(empty.changed, false);
    const menu = await publishMenu(ctx);
    const manager = await provisionStaff(ctx.pool, branch, {
      staff_id: randomUUID(),
      terminal_id: ctx.cashier.terminal_id,
      name: 'Synthetic register manager',
      role: 'shift_manager',
    });
    await openCashShift(
      ctx.pool,
      branch,
      { sessionId: manager.session_id, token: manager.token },
      randomUUID(),
      { opening_cash_minor: '0' },
    );
    const orders = [];
    for (let i = 0; i < 2; i += 1) {
      const quote = await createQuote(ctx.pool, branch, ctx.cashier.auth, {
        release_id: menu.release_id,
        service_mode: 'takeaway',
        items: [{ variant_id: menu.items[0].variant_id, quantity: 1 }],
      });
      orders.push(
        await createLocalOrder(ctx.pool, branch, ctx.cashier.auth, randomUUID(), {
          quote_id: quote.quote_id,
        }),
      );
    }
    await cancelLocalOrder(ctx.pool, branch, ctx.cashier.auth, randomUUID(), orders[0].order_id, {
      expected_version: 1,
      reason: 'Synthetic backlog order',
    });
    const before = await ctx.pool.query(
      "SELECT md5(string_agg(to_jsonb(o)::text, ',' ORDER BY event_id)) AS h FROM outbox_events o",
    );
    const report = await posSyncBacklog(ctx.pool, branch);
    assert.equal(report.local_orders.total, 2);
    assert.equal(report.local_orders.cancelled, 1);
    assert.equal(report.local_orders.awaiting_payment, 1);
    assert.equal(report.order_events.created, 2);
    assert.equal(report.order_events.cancelled, 1);
    assert.equal(report.order_events.unacknowledged, 3);
    assert.equal(report.order_events.foreign_producer, 0);
    assert.ok(report.would_send_on_install >= 3);
    assert.equal(report.decision_required, true);
    assert.ok(report.order_events.first_at <= report.order_events.last_at);
    // Counts, sums and times only: no order, event, producer or device identifier.
    assert.doesNotMatch(JSON.stringify(report), uuid);
    const after = await ctx.pool.query(
      "SELECT md5(string_agg(to_jsonb(o)::text, ',' ORDER BY event_id)) AS h FROM outbox_events o",
    );
    assert.equal(after.rows[0].h, before.rows[0].h);
    // An acknowledged event no longer counts as backlog.
    await ctx.pool.query(
      `UPDATE outbox_events SET acknowledged_at=now() WHERE event_id=(SELECT event_id FROM outbox_events
        WHERE aggregate_type='order_commercial' ORDER BY producer_sequence LIMIT 1)`,
    );
    const acked = await posSyncBacklog(ctx.pool, branch);
    assert.equal(acked.order_events.unacknowledged, 2);
    assert.equal(acked.order_events.acknowledged, 1);
  }));

test('backlog report runs read-only and only against the local point database', () => {
  const env = {
    APP_ENV: 'local',
    EDGE_BRANCH_ID: randomUUID(),
    EDGE_DATABASE_URL: 'postgresql://pickchick_edge_owner:secret@127.0.0.1:55433/pickchick_edge',
  };
  assert.equal(backlogConfig(env).databaseUrl, env.EDGE_DATABASE_URL);
  for (const url of [
    'postgresql://pickchick_edge_owner:secret@10.0.0.5:55433/pickchick_edge',
    'postgresql://pickchick_edge_owner:secret@127.0.0.1:5432/pickchick_edge',
    'postgresql://pickchick_edge_owner:secret@127.0.0.1:55433/other',
  ])
    assert.throws(() => backlogConfig({ ...env, EDGE_DATABASE_URL: url }));
});
