/* global structuredClone */
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { digest, grantStation, provisionFulfillment } from '../dist/index.js';
import { fixture, errorCode } from './fixture.mjs';

async function drinkOnly(f) {
  const command = f.admission();
  command.payload.snapshot.lines[0].productId = 'drink';
  command.payload.snapshot.lines[0].title = 'Synthetic drink';
  command.payload.quoteDigest = digest(command.payload.snapshot);
  const reservation = await f.repo.acceptCloud(f.scope, command);
  return f.repo.acceptCloud(f.scope, f.authorize(command, reservation));
}

test('burger-only order appears on pinned assembly station without an assembly-item task', () =>
  fixture(async (f) => {
    const { order } = await f.accepted();
    const stored = await f.read(order.orderId);
    assert.equal(stored.tasks.length, 1);
    assert.equal(stored.tasks[0].station_id, f.prep);
    const queue = await f.repo.listKitchen(f.scope.branchId, f.packer.auth, {
      stationId: f.assembly,
    });
    assert.equal(queue.items.length, 1);
    assert.equal(queue.items[0].orderId, order.orderId);
    assert.equal(queue.items[0].assemblyStationId, f.assembly);
    const scoped = await f.repo.readOrder(f.scope.branchId, f.packer.auth, order.orderId, {
      stationId: f.assembly,
    });
    assert.equal(scoped.assemblyStationId, f.assembly);
    assert.deepEqual(scoped.tasks, stored.tasks);
    const prepQueue = await f.repo.listKitchen(f.scope.branchId, f.cook.auth, {
      stationId: f.prep,
    });
    assert.equal(prepQueue.items.length, 1);
  }));

test('station-scoped read denies unrelated kitchen order and respects manager branch/filter', () =>
  fixture(async (f) => {
    const order = await drinkOnly(f);
    await assert.rejects(
      f.repo.readOrder(f.scope.branchId, f.cook.auth, order.orderId, { stationId: f.prep }),
      errorCode('FORBIDDEN'),
    );
    await assert.rejects(
      f.repo.readOrder(f.scope.branchId, f.cook.auth, order.orderId, { stationId: f.assembly }),
      errorCode('FORBIDDEN'),
    );
    await assert.rejects(
      f.repo.readOrder(f.scope.branchId, f.cashier.auth, order.orderId, { stationId: f.assembly }),
      errorCode('FORBIDDEN'),
    );
    assert.equal(
      (await f.repo.listKitchen(f.scope.branchId, f.cook.auth, { stationId: f.prep })).items.length,
      0,
    );
    assert.equal(
      (await f.repo.readOrder(f.scope.branchId, f.manager.auth, order.orderId)).orderId,
      order.orderId,
    );
    assert.equal(
      (
        await f.repo.readOrder(f.scope.branchId, f.manager.auth, order.orderId, {
          stationId: f.assembly,
        })
      ).orderId,
      order.orderId,
    );
    await assert.rejects(
      f.repo.readOrder(f.scope.branchId, f.manager.auth, order.orderId, { stationId: f.prep }),
      errorCode('FORBIDDEN'),
    );
    await assert.rejects(
      f.repo.readOrder(randomUUID(), f.manager.auth, order.orderId, { stationId: f.assembly }),
      errorCode('UNAUTHORIZED'),
    );
    await assert.rejects(
      f.repo.readOrder(f.scope.branchId, f.manager.auth, order.orderId, { stationId: 'invalid' }),
      errorCode('INVALID'),
    );
    // Historical three-argument read remains compatible. HTTP adapters separately
    // require a station for kitchen users; this internal compatibility is intentional.
    assert.equal(
      (await f.repo.readOrder(f.scope.branchId, f.cook.auth, order.orderId)).orderId,
      order.orderId,
    );
  }));

for (const terminal of ['cancelled', 'handed_over'])
  test(`station membership remains pinned for ${terminal} orders after routing publication`, () =>
    fixture(async (f) => {
      const { order } = await f.accepted();
      const next = structuredClone(f.setup),
        nextAssembly = randomUUID();
      next.stations.push({ id: nextAssembly, kind: 'assembly', name: 'Synthetic new assembly' });
      next.routing.version = 2;
      next.routing.assemblyStationId = nextAssembly;
      await provisionFulfillment(f.pool, next);
      await grantStation(f.pool, f.scope.branchId, f.packer.staff_id, nextAssembly);
      // New routing does not move the existing order to the new assembly queue.
      assert.equal(
        (await f.repo.listKitchen(f.scope.branchId, f.packer.auth, { stationId: f.assembly })).items
          .length,
        1,
      );
      assert.equal(
        (await f.repo.listKitchen(f.scope.branchId, f.packer.auth, { stationId: nextAssembly }))
          .items.length,
        0,
      );
      let final;
      if (terminal === 'cancelled') final = await f.repo.acceptCloud(f.scope, f.cancel(order));
      else
        final = await f.act(
          await f.act(await f.complete(order), 'ready', f.packer),
          'handoff',
          f.packer,
        );
      assert.equal(final.state, terminal);
      const assemblyRead = await f.repo.readOrder(f.scope.branchId, f.packer.auth, order.orderId, {
        stationId: f.assembly,
      });
      assert.equal(assemblyRead.state, terminal);
      assert.equal(assemblyRead.assemblyStationId, f.assembly);
      assert.equal(
        (
          await f.repo.readOrder(f.scope.branchId, f.cook.auth, order.orderId, {
            stationId: f.prep,
          })
        ).state,
        terminal,
      );
      await assert.rejects(
        f.repo.readOrder(f.scope.branchId, f.packer.auth, order.orderId, {
          stationId: nextAssembly,
        }),
        errorCode('FORBIDDEN'),
      );
      assert.equal(
        (await f.repo.listKitchen(f.scope.branchId, f.packer.auth, { stationId: f.assembly })).items
          .length,
        0,
      );
      const created = await f.accepted();
      assert.equal(
        (await f.repo.listKitchen(f.scope.branchId, f.packer.auth, { stationId: nextAssembly }))
          .items[0].orderId,
        created.order.orderId,
      );
    }));
