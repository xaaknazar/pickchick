import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { provisionStaff } from '@pickchick/local-orders';
import { withOrderDesk } from '../helpers/orders.mjs';
import {
  localPosServiceInput,
  localPosServiceConfig,
  configureLocalPosService,
} from '../../scripts/local-pos-service.mjs';

async function inputFor(ctx) {
  const prep = randomUUID(),
    assembly = randomUUID(),
    cook = await provisionStaff(ctx.edge.pool, ctx.branch, ctx.setup('kitchen'));
  return {
    format: 'pickchick-local-pos-service-v1',
    confirmation: 'owner_authorized_unpaid_service',
    branch_id: ctx.branch,
    menu_release_id: ctx.release.release_id,
    operator_staff_id: ctx.manager.staff_id,
    expected_ordering_version: 1,
    fulfillment: {
      organizationId: ctx.org,
      branchId: ctx.branch,
      deviceId: ctx.device,
      producerId: randomUUID(),
      stations: [
        { id: prep, kind: 'prep', name: 'Synthetic prep' },
        { id: assembly, kind: 'assembly', name: 'Synthetic assembly' },
      ],
      routing: {
        version: 1,
        assemblyStationId: assembly,
        routes: [{ productId: ctx.release.items[0].product_id, stationId: prep, kind: 'prep' }],
      },
    },
    station_grants: [
      { staff_id: cook.staff_id, station_id: prep },
      { staff_id: cook.staff_id, station_id: assembly },
    ],
  };
}
test('owner preparation is atomic, remains closed, and explicit enable replays without reopening later closed service', async () => {
  await withOrderDesk(async (ctx) => {
    const input = await inputFor(ctx);
    await assert.rejects(configureLocalPosService(ctx.edge.pool, 'enable', input), /prepare/);
    const bad = globalThis.structuredClone(input);
    bad.station_grants[1].staff_id = ctx.cashier.staff_id;
    await assert.rejects(configureLocalPosService(ctx.edge.pool, 'prepare', bad));
    for (const table of [
      'fulfillment_config',
      'fulfillment_stations',
      'fulfillment_routing',
      'fulfillment_station_grants',
      'local_pos_service_setup',
    ])
      assert.equal((await ctx.edge.pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count, '0');
    const prepared = await configureLocalPosService(ctx.edge.pool, 'prepare', input);
    assert.equal(prepared.ordering_enabled, false);
    assert.equal(prepared.stage, 'prepared');
    assert.equal(
      (await ctx.edge.pool.query('SELECT pos_service_mode FROM branch_config')).rows[0]
        .pos_service_mode,
      'payment_required',
    );
    assert.equal((await configureLocalPosService(ctx.edge.pool, 'prepare', input)).replayed, true);
    const changed = globalThis.structuredClone(input);
    changed.fulfillment.stations[0].name = 'Changed';
    await assert.rejects(configureLocalPosService(ctx.edge.pool, 'prepare', changed), /different/);
    const enabled = await configureLocalPosService(ctx.edge.pool, 'enable', input);
    assert.equal(enabled.ordering_enabled, true);
    assert.equal(enabled.stage, 'enabled');
    assert.equal((await configureLocalPosService(ctx.edge.pool, 'enable', input)).replayed, true);
    assert.equal(
      (
        await ctx.edge.pool.query(
          "SELECT count(*) FROM local_audit WHERE action LIKE 'local.unpaid_service_%'",
        )
      ).rows[0].count,
      '2',
    );
    assert.equal(
      (await ctx.edge.pool.query('SELECT count(*) FROM checkout_quotes')).rows[0].count,
      '0',
    );
    assert.equal(
      (await ctx.edge.pool.query('SELECT count(*) FROM local_orders')).rows[0].count,
      '0',
    );
    await ctx.edge.pool.query(
      'UPDATE branch_config SET ordering_enabled=false,ordering_version=ordering_version+1',
    );
    await assert.rejects(configureLocalPosService(ctx.edge.pool, 'enable', input), /do not reopen/);
    assert.equal(
      (await ctx.edge.pool.query('SELECT ordering_enabled FROM branch_config')).rows[0]
        .ordering_enabled,
      false,
    );
  }, false);
});
test('owner setup rejects incomplete routes, stale menu/branch, revoked kitchen and unsafe CLI connection', async () => {
  await withOrderDesk(async (ctx) => {
    const input = await inputFor(ctx);
    for (const change of [
      (p) => {
        p.branch_id = randomUUID();
      },
      (p) => {
        p.menu_release_id = randomUUID();
      },
      (p) => {
        p.fulfillment.routing.routes[0].productId = randomUUID();
      },
      (p) => {
        p.operator_staff_id = ctx.cashier.staff_id;
      },
      (p) => {
        p.expected_ordering_version = 2;
      },
    ]) {
      const bad = globalThis.structuredClone(input);
      change(bad);
      await assert.rejects(configureLocalPosService(ctx.edge.pool, 'prepare', bad));
    }
    const missing = globalThis.structuredClone(input);
    missing.station_grants.pop();
    assert.throws(() => localPosServiceInput(missing));
    const injected = { ...input, password: 'not-accepted' };
    assert.throws(() => localPosServiceInput(injected));
    await configureLocalPosService(ctx.edge.pool, 'prepare', input);
    await ctx.edge.pool.query('UPDATE local_staff SET active=false WHERE id=$1', [
      input.station_grants[0].staff_id,
    ]);
    await assert.rejects(configureLocalPosService(ctx.edge.pool, 'enable', input), /staff/);
    assert.equal(
      (await ctx.edge.pool.query('SELECT ordering_enabled FROM branch_config')).rows[0]
        .ordering_enabled,
      false,
    );
    const env = {
      APP_ENV: 'local',
      EDGE_DATABASE_URL:
        'postgresql://pickchick_edge_owner:synthetic@127.0.0.1:55433/pickchick_edge',
      EDGE_BRANCH_ID: ctx.branch,
    };
    assert.equal(localPosServiceConfig(env).branchId, ctx.branch);
    assert.throws(() => localPosServiceConfig(env, 'enable'));
    for (const url of [
      'postgresql://pickchick_edge_runtime:synthetic@127.0.0.1:55433/pickchick_edge',
      'postgresql://pickchick_edge_owner:synthetic@192.0.2.1:55433/pickchick_edge',
      'postgresql://pickchick_edge_owner:synthetic@127.0.0.1:55433/pickchick_edge?sslmode=disable',
    ])
      assert.throws(() => localPosServiceConfig({ ...env, EDGE_DATABASE_URL: url }));
  }, false);
});
