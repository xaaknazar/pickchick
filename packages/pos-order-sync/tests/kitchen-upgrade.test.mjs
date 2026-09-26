import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from '@pickchick/database';
import { QuoteSchema } from '@pickchick/contracts';
import { applyMenu, publishMenu, hashJson, provisionDevice } from '@pickchick/menu-sync';
import { provisionStaff, setOrdering, priceCart } from '@pickchick/local-orders';
import { provisionCloudPosSync, parseEvent } from '../dist/index.js';
import { withSyncDatabases } from '../../../tests/helpers/sync.mjs';
import { staffAuth } from '../../../tests/helpers/orders.mjs';

test('013-014/018 preserve old unacknowledged commercial bytes and observed totals without enabling kitchen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pickchick-kitchen-upgrade-')),
    cloudOld = join(directory, 'cloud'),
    edgeOld = join(directory, 'edge');
  const { mkdir } = await import('node:fs/promises');
  try {
    await mkdir(cloudOld);
    await mkdir(edgeOld);
    const paths = {
      cloud: fileURLToPath(new URL('../../../db/cloud/migrations/', import.meta.url)),
      edge: fileURLToPath(new URL('../../../db/edge/migrations/', import.meta.url)),
    };
    for (const [scope, target, maximum] of [
      ['cloud', cloudOld, '018'],
      ['edge', edgeOld, '013'],
    ])
      for (const name of await readdir(paths[scope]))
        if (/^\d{3}_[a-z_]+\.sql$/.test(name) && name < maximum)
          await copyFile(join(paths[scope], name), join(target, name));
    await withSyncDatabases(
      async (ctx) => {
        const menu = ctx.menu();
        await applyMenu(ctx.edge.pool, ctx.branch, await publishMenu(ctx.cloud.pool, menu));
        const actor = await provisionStaff(ctx.edge.pool, ctx.branch, {
          staff_id: randomUUID(),
          terminal_id: randomUUID(),
          name: 'Synthetic legacy POS',
          role: 'shift_manager',
        });
        const auth = staffAuth(actor);
        // Seed historical rows with schema012 SQL, never newer shift/stop APIs.
        const shiftId = randomUUID();
        await ctx.edge.pool.query(
          'INSERT INTO local_cash_shifts(id,branch_id,terminal_id,staff_id,opening_cash_minor) VALUES($1,$2,$3,$4,0)',
          [shiftId, ctx.branch, actor.terminal_id, actor.staff_id],
        );
        await setOrdering(ctx.edge.pool, ctx.branch, auth, randomUUID(), true, {
          expected_version: 1,
        });
        const cart = {
          release_id: menu.release_id,
          service_mode: 'takeaway',
          items: [{ variant_id: menu.items[0].variant_id, quantity: 1 }],
        };
        const time = new Date();
        const q = QuoteSchema.parse({
          quote_id: randomUUID(),
          branch_id: ctx.branch,
          release_id: menu.release_id,
          menu_version: menu.version,
          service_mode: 'takeaway',
          channel: 'pos',
          ...priceCart(menu, cart),
          created_at: time.toISOString(),
          expires_at: new Date(time.getTime() + 300000).toISOString(),
        });
        await ctx.edge.pool.query(
          'INSERT INTO checkout_quotes(id,branch_id,staff_id,terminal_id,release_id,total_minor,snapshot,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          [
            q.quote_id,
            ctx.branch,
            actor.staff_id,
            actor.terminal_id,
            menu.release_id,
            q.total_minor,
            q,
            q.created_at,
            q.expires_at,
          ],
        );
        const order = { order_id: randomUUID() };
        await ctx.edge.pool.query(
          'INSERT INTO local_orders(id,branch_id,quote_id,total_minor,cash_shift_id) VALUES($1,$2,$3,$4,$5)',
          [order.order_id, ctx.branch, q.quote_id, q.total_minor, shiftId],
        );
        const event = parseEvent({
          event_id: randomUUID(),
          producer_id: randomUUID(),
          producer_sequence: '1',
          aggregate_type: 'order_commercial',
          aggregate_id: order.order_id,
          aggregate_version: 1,
          event_type: 'order.created',
          schema_version: 1,
          branch_id: ctx.branch,
          occurred_at: time.toISOString(),
          correlation_id: order.order_id,
          causation_id: null,
          payload: {
            order_id: order.order_id,
            quote_id: q.quote_id,
            state: 'awaiting_payment',
            payment_state: 'not_started',
            fulfillment_state: 'blocked',
            total_minor: q.total_minor,
            currency: 'KZT',
            channel: 'pos',
            service_mode: 'takeaway',
            snapshot: q,
          },
        });
        await ctx.edge.pool.query(
          'INSERT INTO local_order_streams(branch_id,producer_id,last_sequence) VALUES($1,$2,1)',
          [ctx.branch, event.producer_id],
        );
        await ctx.edge.pool.query(
          'INSERT INTO outbox_events(event_id,producer_id,producer_sequence,branch_id,aggregate_type,aggregate_id,aggregate_version,schema_version,event_type,payload,occurred_at,correlation_id) VALUES($1,$2,1,$3,$4,$5,1,1,$6,$7,$8,$5)',
          [
            event.event_id,
            event.producer_id,
            ctx.branch,
            event.aggregate_type,
            order.order_id,
            event.event_type,
            event.payload,
            event.occurred_at,
          ],
        );
        assert.equal(Object.hasOwn(event.payload, 'execution_mode'), false);
        const scope = {
          organizationId: ctx.org,
          branchId: ctx.branch,
          deviceId: ctx.device,
          producerId: event.producer_id,
        };
        await ctx.edge.pool.query(
          'INSERT INTO pos_order_sync_state(branch_id,organization_id,device_id,producer_id,pending_event_id,pending_envelope,pending_hash) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [
            ctx.branch,
            ctx.org,
            ctx.device,
            event.producer_id,
            event.event_id,
            event,
            hashJson(event),
          ],
        );
        await provisionDevice(ctx.cloud.pool, ctx.device);
        await provisionCloudPosSync(ctx.cloud.pool, scope);
        await ctx.cloud.pool.query(
          'INSERT INTO pos_order_sync_inbox(event_id,branch_id,device_id,producer_id,producer_sequence,order_id,aggregate_version,payload_hash,envelope) VALUES($1,$2,$3,$4,$5,$6,1,$7,$8)',
          [
            event.event_id,
            ctx.branch,
            ctx.device,
            event.producer_id,
            event.producer_sequence,
            order.order_id,
            hashJson(event),
            event,
          ],
        );
        await ctx.cloud.pool.query(
          "INSERT INTO pos_order_sync_projection(order_id,branch_id,device_id,producer_id,quote_id,snapshot,snapshot_hash,total_minor,version,state,last_event_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,1,'awaiting_payment',$9)",
          [
            order.order_id,
            ctx.branch,
            ctx.device,
            event.producer_id,
            q.quote_id,
            q,
            hashJson(q),
            q.total_minor,
            event.event_id,
          ],
        );
        const tables = {
          edge: [
            'pos_order_sync_state',
            'outbox_events',
            'local_orders',
            'local_cash_shifts',
            'local_staff',
            'staff_sessions',
          ],
          cloud: ['pos_order_sync_inbox', 'pos_order_sync_projection'],
        };
        const before = new Map();
        for (const side of ['edge', 'cloud'])
          for (const table of tables[side])
            before.set(
              table,
              (await ctx[side].pool.query('SELECT row_to_json(t) r FROM ' + table + ' t')).rows,
            );
        for (const side of ['edge', 'cloud']) {
          // Pin this historical transition; unrelated future migrations must not change its scope.
          const target = side === 'edge' ? edgeOld : cloudOld;
          const maximum = side === 'edge' ? '015' : '022';
          for (const name of await readdir(paths[side]))
            if (/^\d{3}_[a-z_]+\.sql$/.test(name) && name < maximum)
              await copyFile(join(paths[side], name), join(target, name));
          const changed = await migrate(ctx[side].pool, target, side);
          assert.deepEqual(
            changed,
            side === 'edge'
              ? ['013_pos_kitchen_sync.sql', '014_pos_workspace.sql']
              : [
                  '018_pos_kitchen_sync.sql',
                  '019_cloud_unpaid_test_orders.sql',
                  '020_cloud_daily_test_numbers.sql',
                  '021_cloud_test_service_shifts.sql',
                ],
          );
          assert.deepEqual(await migrate(ctx[side].pool, target, side), []);
        }
        for (const side of ['edge', 'cloud'])
          for (const table of tables[side]) {
            const after = (
              await ctx[side].pool.query('SELECT row_to_json(t) r FROM ' + table + ' t')
            ).rows;
            if (table === 'pos_order_sync_projection') {
              assert.equal(after[0].r.execution_mode, null);
              delete after[0].r.execution_mode;
            }
            assert.deepEqual(after, before.get(table), table);
          }
        assert.equal(
          (await ctx.edge.pool.query('SELECT pending_event_id FROM pos_kitchen_sync_state')).rows[0]
            .pending_event_id,
          null,
        );
        for (const table of ['pos_kitchen_sync_inbox', 'pos_kitchen_sync_projection'])
          assert.equal(
            (await ctx.cloud.pool.query('SELECT count(*)::int n FROM ' + table)).rows[0].n,
            0,
          );
        assert.equal(
          (await ctx.edge.pool.query('SELECT pos_service_mode FROM branch_config')).rows[0]
            .pos_service_mode,
          'payment_required',
        );
      },
      { cloudMigrationDirectory: cloudOld, edgeMigrationDirectory: edgeOld },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
