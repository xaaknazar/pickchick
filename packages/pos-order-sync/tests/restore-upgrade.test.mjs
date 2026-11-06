import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readdir, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from '@pickchick/database';
import { applyMenu, publishMenu, provisionDevice } from '@pickchick/menu-sync';
import {
  provisionStaff,
  openCashShift,
  setOrdering,
  createQuote,
  createLocalOrder,
  fenceRestoredEdge,
} from '@pickchick/local-orders';
import {
  provisionFulfillment,
  localUnpaidExecution,
  EdgeFulfillment,
} from '@pickchick/edge-fulfillment';
import { provisionEdgePosSync, syncPosKitchenOnce } from '../dist/index.js';
import { withSyncDatabases } from '../../../tests/helpers/sync.mjs';
import { staffAuth } from '../../../tests/helpers/orders.mjs';

test('279: upgrading a pre025 backup before fencing marks live tickets without rewriting pending bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'restore-upgrade-'));
  const old = join(root, 'edge');
  // The reviewed 024 -> 025 step alone: later migrations (026+) have their own upgrade tests.
  const upgrade = join(root, 'edge-025');
  const migrations = fileURLToPath(new URL('../../../db/edge/migrations/', import.meta.url));
  try {
    await mkdir(old);
    await mkdir(upgrade);
    for (const name of await readdir(migrations)) {
      if (/^\d{3}_[a-z_]+\.sql$/.test(name) && name < '025')
        await copyFile(join(migrations, name), join(old, name));
      if (/^\d{3}_[a-z_]+\.sql$/.test(name) && name < '026')
        await copyFile(join(migrations, name), join(upgrade, name));
    }
    await withSyncDatabases(
      async (ctx) => {
        const p = ctx.edge.pool;
        const release = ctx.menu();
        await applyMenu(p, ctx.branch, await publishMenu(ctx.cloud.pool, release));
        const manager = await provisionStaff(p, ctx.branch, {
          staff_id: randomUUID(),
          terminal_id: randomUUID(),
          name: 'Synthetic legacy manager',
          role: 'shift_manager',
        });
        await openCashShift(p, ctx.branch, staffAuth(manager), randomUUID(), {
          opening_cash_minor: '0',
        });
        await setOrdering(p, ctx.branch, staffAuth(manager), randomUUID(), true, {
          expected_version: 1,
        });
        await p.query("UPDATE branch_config SET pos_service_mode='unpaid_service' WHERE id=$1", [
          ctx.branch,
        ]);
        const assembly = randomUUID();
        await provisionFulfillment(p, {
          organizationId: ctx.org,
          branchId: ctx.branch,
          deviceId: ctx.device,
          producerId: randomUUID(),
          stations: [{ id: assembly, kind: 'assembly', name: 'Synthetic assembly' }],
          routing: {
            version: 1,
            assemblyStationId: assembly,
            routes: [
              {
                productId: release.items[0].product_id,
                stationId: assembly,
                kind: 'assembly_item',
              },
            ],
          },
        });
        await provisionEdgePosSync(p, {
          organizationId: ctx.org,
          branchId: ctx.branch,
          deviceId: ctx.device,
        });
        const q = await createQuote(p, ctx.branch, staffAuth(manager), {
          release_id: release.release_id,
          service_mode: 'takeaway',
          items: [{ variant_id: release.items[0].variant_id, quantity: 1 }],
        });
        const o = await createLocalOrder(
          p,
          ctx.branch,
          staffAuth(manager),
          randomUUID(),
          { quote_id: q.quote_id, kitchen_admission: 'unpaid' },
          localUnpaidExecution({ enabled: true, deviceId: ctx.device }),
        );
        // Transport failure saves the exact original envelope before any restore marker exists.
        await syncPosKitchenOnce(
          p,
          {
            enabled: true,
            branchId: ctx.branch,
            origin: 'http://127.0.0.1:1',
            identity: await provisionDevice(ctx.cloud.pool, ctx.device),
          },
          {
            fetch: async () => {
              throw new Error('Synthetic offline');
            },
          },
        );
        const pending = async () =>
          (
            await p.query(
              'SELECT pending_event_id,pending_envelope,pending_hash FROM pos_kitchen_sync_state',
            )
          ).rows;
        const before = await pending();
        assert.ok(before[0].pending_event_id);
        assert.equal(before[0].pending_envelope.payload.restoreContext, undefined);
        const events = (await p.query('SELECT * FROM fulfillment_outbox ORDER BY sequence')).rows;
        assert.deepEqual(await migrate(p, upgrade, 'edge'), [
          '025_edge_kitchen_restore_review.sql',
        ]);
        await fenceRestoredEdge(p, true);
        assert.deepEqual(await pending(), before);
        assert.deepEqual(
          (await p.query('SELECT * FROM fulfillment_outbox ORDER BY sequence')).rows,
          events,
        );
        const repo = new EdgeFulfillment(p);
        const ticket = await repo.readOrder(ctx.branch, staffAuth(manager), o.order_id);
        assert.equal(ticket.restoreReview.status, 'pending');
        assert.deepEqual((await repo.readDisplay(ctx.branch)).items, []);
        await repo.reviewRestore(ctx.branch, staffAuth(manager), {
          commandId: randomUUID(),
          orderId: o.order_id,
          epoch: ticket.restoreReview.epoch,
          expectedVersion: ticket.version,
          decision: 'retire',
          reason: 'Compared old backup with server and physical kitchen',
        });
        assert.deepEqual((await repo.listKitchen(ctx.branch, staffAuth(manager))).items, []);
        assert.deepEqual(await pending(), before);
      },
      { edgeMigrationDirectory: old },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
