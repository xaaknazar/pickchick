import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createPool } from '@pickchick/database';
import { FarmPersistence } from '../dist/index.js';
import { farmGrants } from '../../../infra/staging/farm-grants.mjs';

function assertFirstPlanting(result, cropId) {
  assert.equal(result.state.plots[0].cropId, cropId);
  assert.equal(result.state.plots[0].plantedAt, result.serverNow);
  assert.equal(result.state.plots[0].timing.growSeconds, cropId === 'carrot' ? 45 : 10800);
  assert.equal(result.state.progression.tutorialPlantings, cropId === 'carrot' ? 1 : 0);
}

// Explicit opt-in local test database. Isolated schema; no shared migration ledger.
test('durable farm: concurrency, replay, collision, rollback, clock and isolation', async () => {
  const url = process.env.FARM_TEST_DATABASE_URL;
  assert.ok(url, 'FARM_TEST_DATABASE_URL required');
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname));
  const pool = createPool(url);
  const schema = 'farm_test_' + randomUUID().replaceAll('-', '');
  const db = await pool.connect();
  try {
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET search_path TO ${schema}`);
    await db.query('CREATE TABLE identity_customers(id uuid PRIMARY KEY, deleted_at timestamptz)');
    await db.query(
      await readFile(
        new URL('../../../db/cloud/migrations/037_cloud_farm.sql', import.meta.url),
        'utf8',
      ),
    );
    await db.query(
      await readFile(
        new URL('../../../db/cloud/migrations/038_cloud_farm_field_capacity.sql', import.meta.url),
        'utf8',
      ),
    );
  } finally {
    db.release();
  }
  const scopedUrl = new URL(url);
  scopedUrl.searchParams.set('options', `-c search_path=${schema}`);
  const scoped = createPool(scopedUrl.href);
  const farm = new FarmPersistence(scoped, true);
  const a = randomUUID(),
    b = randomUUID();
  try {
    await scoped.query('INSERT INTO identity_customers(id) VALUES($1),($2)', [a, b]);
    assert.equal(
      (await new FarmPersistence(scoped).get(a).catch((e) => e)).code,
      'FARM_UNAVAILABLE',
    );
    const first = await farm.get(a);
    assert.equal(first.state.revision, 0);
    const command = {
      commandId: randomUUID(),
      expectedRevision: 0,
      command: { type: 'buyPlot', x: 31, y: 31 },
    };
    const results = await Promise.all([farm.command(a, command), farm.command(a, command)]);
    assert.equal(results[0].state.revision, 1);
    assert.equal(results[1].state.revision, 1);
    assert.equal(results[0].state.plots[0].plantedAt, null);
    assert.equal(results[0].state.plots[0].x, 31);
    assert.equal(results[0].state.coins, 350);
    assert.equal((await farm.get(b)).state.revision, 0);
    await assert.rejects(
      farm.command(a, { ...command, command: { type: 'expand' } }),
      (e) => e.code === 'COMMAND_ID_CONFLICT',
    );
    await assert.rejects(
      farm.command(a, { ...command, commandId: randomUUID() }),
      (e) => e.code === 'STALE_STATE' && e.state.revision === 1,
    );
    const competing = await Promise.allSettled(
      [0, 1].map((plotId) =>
        farm.command(a, {
          commandId: randomUUID(),
          expectedRevision: 1,
          command: { type: 'plant', plotId: 0, cropId: plotId === 0 ? 'carrot' : 'tomato' },
        }),
      ),
    );
    assert.equal(competing.filter((x) => x.status === 'fulfilled').length, 1);
    assert.equal(competing.find((x) => x.status === 'rejected').reason.code, 'STALE_STATE');
    const planting = competing.find((x) => x.status === 'fulfilled').value;
    const winningCrop = competing[0].status === 'fulfilled' ? 'carrot' : 'tomato';
    assertFirstPlanting(planting, winningCrop);
    assert.deepEqual(
      (await scoped.query('SELECT state FROM customer_farms WHERE customer_id=$1', [a])).rows[0]
        .state,
      planting.state,
    );
    // Exercise both valid race outcomes deterministically, irrespective of which
    // connection acquired the row lock first in the concurrent case above.
    for (const cropId of ['carrot', 'tomato']) {
      const customer = randomUUID();
      await scoped.query('INSERT INTO identity_customers(id) VALUES($1)', [customer]);
      await farm.get(customer);
      await farm.command(customer, {
        commandId: randomUUID(),
        expectedRevision: 0,
        command: { type: 'buyPlot', x: 31, y: 31 },
      });
      const planted = await farm.command(customer, {
        commandId: randomUUID(),
        expectedRevision: 1,
        command: { type: 'plant', plotId: 0, cropId },
      });
      assertFirstPlanting(planted, cropId);
      assert.deepEqual((await farm.get(customer)).state, planted.state);
    }
    assert.equal(
      (await farm.command(a, command)).state.revision,
      2,
      'replay returns latest canonical state',
    );
    const harvest = {
      commandId: randomUUID(),
      expectedRevision: 2,
      command: { type: 'harvest', plotId: 0 },
    };
    await assert.rejects(farm.command(a, harvest), (e) => e.code === 'CROP_NOT_READY');
    assert.equal((await farm.get(a)).state.revision, 2);
    assert.equal(
      (
        await scoped.query(
          'SELECT count(*)::int n FROM customer_farm_commands WHERE command_id=$1',
          [harvest.commandId],
        )
      ).rows[0].n,
      0,
    );
    await assert.rejects(
      farm.command(a, { ...harvest, now: Date.now() + 999999 }),
      (e) => e.code === 'INVALID_REQUEST',
    );
    await scoped.query(
      `CREATE FUNCTION reject_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test rollback'; END $$`,
    );
    await scoped.query(
      'CREATE TRIGGER receipt_failure BEFORE INSERT ON customer_farm_commands FOR EACH ROW EXECUTE FUNCTION reject_receipt()',
    );
    await assert.rejects(
      farm.command(a, {
        commandId: randomUUID(),
        expectedRevision: 2,
        command: { type: 'movePlot', plotId: 0, x: 30, y: 31 },
      }),
    );
    assert.equal((await farm.get(a)).state.revision, 2, 'state update rolls back with receipt');
    assert.equal(
      (await farm.get(a)).state.plots[0].x,
      31,
      'valid movement rolls back with failed receipt',
    );
    await scoped.query('DROP TRIGGER receipt_failure ON customer_farm_commands');
    await scoped.query(
      "INSERT INTO customer_farm_commands(customer_id,command_id,request_hash,revision) SELECT $1,gen_random_uuid(),repeat('e',64),0 FROM generate_series(1,120)",
      [b],
    );
    await assert.rejects(
      farm.command(b, {
        commandId: randomUUID(),
        expectedRevision: 0,
        command: { type: 'buyPlot', x: 31, y: 31 },
      }),
      (e) => e.code === 'RATE_LIMITED',
    );
    // Progression effects and their receipts share the same durable transaction.
    const progressionCustomer = randomUUID();
    await scoped.query('INSERT INTO identity_customers(id) VALUES($1)', [progressionCustomer]);
    let progression = (await farm.get(progressionCustomer)).state;
    progression = {
      ...progression,
      coins: 10000,
      xp: 10000,
      inventory: { ...progression.inventory, strawberry: 9 },
    };
    await scoped.query('UPDATE customer_farms SET state=$2 WHERE customer_id=$1', [
      progressionCustomer,
      progression,
    ]);
    async function run(command) {
      const input = { commandId: randomUUID(), expectedRevision: progression.revision, command };
      const result = await farm.command(progressionCustomer, input);
      progression = result.state;
      return { input, result };
    }
    const decoration = await run({ type: 'buyDecoration', decorationId: 'path', x: 27, y: 27 });
    const duplicate = await farm.command(progressionCustomer, decoration.input);
    assert.deepEqual(duplicate.state, progression);
    assert.equal(progression.progression.decorations.length, 1);
    await run({ type: 'storeDecoration', instanceId: 0 });
    await run({ type: 'placeDecoration', instanceId: 0, x: 28, y: 28 });
    await run({ type: 'moveDecoration', instanceId: 0, x: 29, y: 29 });
    await run({ type: 'setHouseStyle', style: 'mint' });
    await run({ type: 'buyStation', stationId: 'kitchen' });
    const production = await run({ type: 'startProduction', recipeId: 'jam' });
    assert.equal(progression.inventory.strawberry, 6);
    assert.deepEqual(
      (await farm.command(progressionCustomer, production.input)).state,
      progression,
    );
    assert.equal(progression.progression.stations[0].queue.length, 1);
    const job = progression.progression.stations[0].queue[0];
    assert.ok(job.readyAt >= production.result.serverNow + 900000);
    const collectInput = {
      commandId: randomUUID(),
      expectedRevision: progression.revision,
      command: { type: 'collectProduction', stationId: 'kitchen', jobId: job.id },
    };
    await assert.rejects(
      farm.command(progressionCustomer, collectInput),
      (e) => e.code === 'PRODUCTION_NOT_READY',
    );
    assert.deepEqual(
      (await farm.get(progressionCustomer)).state,
      progression,
      'early collection has no financial effect',
    );
    // Advance only this isolated fixture; production readiness still uses the DB clock.
    job.readyAt = production.result.serverNow - 1;
    progression.progression.harvested = 1;
    await scoped.query('UPDATE customer_farms SET state=$2 WHERE customer_id=$1', [
      progressionCustomer,
      progression,
    ]);
    progression = (await farm.command(progressionCustomer, collectInput)).state;
    assert.equal(progression.progression.products.jam, 1);
    assert.equal(
      (await farm.command(progressionCustomer, collectInput)).state.progression.products.jam,
      1,
    );
    const quest = await run({ type: 'claimQuest', questId: 'first-harvest' });
    const questCoins = progression.coins;
    assert.equal((await farm.command(progressionCustomer, quest.input)).state.coins, questCoins);
    await assert.rejects(
      farm.command(progressionCustomer, {
        ...quest.input,
        commandId: randomUUID(),
        expectedRevision: progression.revision,
      }),
      (e) => e.code === 'REWARD_CLAIMED',
    );
    assert.equal((await farm.get(progressionCustomer)).state.coins, questCoins);
    await run({ type: 'sellProduct', recipeId: 'jam', quantity: 1 });
    assert.equal(progression.progression.products.jam, 0);
    assert.equal(progression.coins, questCoins + 30);
    const legacy = {
      version: 1,
      revision: 7,
      coins: 17,
      xp: 10,
      completedOrders: 1,
      plots: Array.from({ length: 12 }, (_, id) => ({
        id,
        cropId: id === 0 ? 'carrot' : null,
        plantedAt: id === 0 ? 1000 : null,
        harvests: 0,
      })),
      inventory: { carrot: 3, tomato: 0, strawberry: 0, sunflower: 0, tulip: 0, apple: 0 },
    };
    const c = randomUUID();
    await scoped.query('INSERT INTO identity_customers(id) VALUES($1)', [c]);
    await scoped.query('INSERT INTO customer_farms(customer_id,state) VALUES($1,$2)', [c, legacy]);
    const oldExpand = { commandId: randomUUID(), expectedRevision: 6, command: { type: 'expand' } };
    const oldHash = createHash('sha256')
      .update(
        JSON.stringify({
          command: oldExpand.command,
          commandId: oldExpand.commandId,
          expectedRevision: 6,
        }),
      )
      .digest('hex');
    await scoped.query(
      'INSERT INTO customer_farm_commands(customer_id,command_id,request_hash,revision) VALUES($1,$2,$3,7)',
      [c, oldExpand.commandId, oldHash],
    );
    const replayUpgrade = await farm.command(c, oldExpand);
    assert.equal(replayUpgrade.state.version, 2);
    assert.equal(replayUpgrade.state.revision, 7, 'legacy receipt survives lazy upgrade');
    const migrated = await farm.get(c);
    assert.equal(migrated.state.version, 2);
    assert.equal(migrated.state.coins, 17);
    assert.equal(migrated.state.revision, 7);
    assert.equal(migrated.state.inventory.carrot, 3);
    assert.equal(migrated.state.plots[0].plantedAt, 1000);
    await assert.rejects(
      farm.command(c, {
        commandId: randomUUID(),
        expectedRevision: 7,
        command: { type: 'harvest', plotId: 0 },
      }),
      (e) => e.code === 'CROP_WITHERED',
    );
    const cleared = await farm.command(c, {
      commandId: randomUUID(),
      expectedRevision: 7,
      command: { type: 'clear', plotId: 0 },
    });
    assert.equal(cleared.state.inventory.carrot, 3);
    assert.equal(cleared.state.plots[0].cropId, null);
    const mature = {
      ...cleared.state,
      plots: cleared.state.plots.map((plot, id) =>
        id === 0 ? { ...plot, cropId: 'carrot', plantedAt: cleared.serverNow - 3600100 } : plot,
      ),
    };
    await scoped.query('UPDATE customer_farms SET state=$2 WHERE customer_id=$1', [c, mature]);
    const collect = {
      commandId: randomUUID(),
      expectedRevision: mature.revision,
      command: { type: 'harvest', plotId: 0 },
    };
    const collected = await farm.command(c, collect);
    assert.equal(collected.state.inventory.carrot, 6);
    const later = {
      ...collected.state,
      plots: collected.state.plots.map((plot, id) =>
        id === 0 ? { ...plot, cropId: 'carrot', plantedAt: 1000 } : plot,
      ),
    };
    await scoped.query('UPDATE customer_farms SET state=$2 WHERE customer_id=$1', [c, later]);
    const replayHarvest = await farm.command(c, collect);
    assert.equal(
      replayHarvest.state.inventory.carrot,
      6,
      'successful harvest replay after window never doubles reward',
    );
    assert.equal(
      replayHarvest.state.plots[0].plantedAt,
      1000,
      'replay leaves later crop unchanged',
    );
    const full = {
      ...cleared.state,
      nextPlotId: 4095,
      plots: Array.from({ length: 4096 }, (_, id) => ({
        id,
        x: id % 64,
        y: Math.floor(id / 64),
        kind: 'bed',
        cropId: null,
        plantedAt: null,
        harvests: 0,
      }))
        .filter((p) => !(p.x === 32 && p.y === 28))
        .map((p, id) => ({ ...p, id })),
    };
    await scoped.query('UPDATE customer_farms SET state=$2 WHERE customer_id=$1', [c, full]);
    assert.equal(
      (await farm.get(c)).state.plots.length,
      4095,
      'large free field fits persisted JSON bound',
    );
    // Removal/recovery receipts survive retry and restart; IDs cannot target replacement beds.
    const d = randomUUID();
    await scoped.query('INSERT INTO identity_customers(id) VALUES($1)', [d]);
    const fresh = await farm.get(d);
    const buy = await farm.command(d, {
      commandId: randomUUID(),
      expectedRevision: fresh.state.revision,
      command: { type: 'buyPlot', x: 32, y: 30 },
    });
    const remove = {
      commandId: randomUUID(),
      expectedRevision: buy.state.revision,
      command: { type: 'removePlot', plotId: buy.state.plots[0].id },
    };
    const removed = await farm.command(d, remove);
    assert.equal(removed.state.plots.length, 0);
    assert.equal(removed.state.coins, buy.state.coins);
    const replacement = await farm.command(d, {
      commandId: randomUUID(),
      expectedRevision: removed.state.revision,
      command: { type: 'buyPlot', x: 32, y: 30 },
    });
    assert.notEqual(replacement.state.plots[0].id, buy.state.plots[0].id);
    const reconnected = new FarmPersistence(scoped, true);
    assert.deepEqual((await reconnected.command(d, remove)).state, replacement.state);
    await assert.rejects(
      reconnected.command(d, {
        commandId: randomUUID(),
        expectedRevision: replacement.state.revision,
        command: remove.command,
      }),
      (e) => e.code === 'PLOT_NOT_FOUND',
    );
    await scoped.query('UPDATE customer_farms SET state=$2 WHERE customer_id=$1', [
      d,
      { ...replacement.state, coins: 0 },
    ]);
    const recovery = {
      commandId: randomUUID(),
      expectedRevision: replacement.state.revision,
      command: { type: 'recover' },
    };
    const rescued = await reconnected.command(d, recovery);
    assert.equal(rescued.state.plots[0].cropId, 'carrot');
    assert.equal(rescued.state.coins, 0);
    assert.equal(rescued.state.xp, 0);
    assert.equal(rescued.state.plots[0].plantedAt, rescued.serverNow);
    assert.deepEqual((await reconnected.command(d, recovery)).state, rescued.state);
    await assert.rejects(
      reconnected.command(d, {
        ...recovery,
        commandId: randomUUID(),
        expectedRevision: rescued.state.revision,
      }),
      (e) => e.code === 'RECOVERY_NOT_AVAILABLE',
    );
    // Selling during harvest is one durable effect, including receipt failure and replay.
    const e = randomUUID();
    await scoped.query('INSERT INTO identity_customers(id) VALUES($1)', [e]);
    const saleInitial = await farm.get(e);
    const saleReady = {
      ...saleInitial.state,
      nextPlotId: 1,
      coins: 0,
      plots: [
        {
          id: 0,
          x: 32,
          y: 30,
          kind: 'bed',
          cropId: 'carrot',
          plantedAt: saleInitial.serverNow - 3600100,
          harvests: 0,
        },
      ],
    };
    await scoped.query('UPDATE customer_farms SET state=$2 WHERE customer_id=$1', [e, saleReady]);
    const autoSale = {
      commandId: randomUUID(),
      expectedRevision: 0,
      command: { type: 'harvest', plotId: 0, destination: 'sell' },
    };
    await scoped.query(
      'CREATE TRIGGER receipt_failure BEFORE INSERT ON customer_farm_commands FOR EACH ROW EXECUTE FUNCTION reject_receipt()',
    );
    await assert.rejects(farm.command(e, autoSale));
    assert.deepEqual(
      (await farm.get(e)).state,
      saleReady,
      'failed receipt rolls back coins, XP and crop',
    );
    await scoped.query('DROP TRIGGER receipt_failure ON customer_farm_commands');
    const sales = await Promise.all([farm.command(e, autoSale), farm.command(e, autoSale)]);
    assert.equal(sales[0].state.coins, 12);
    assert.equal(sales[0].state.inventory.carrot, 0);
    assert.equal(sales[0].state.xp, 10);
    assert.deepEqual(sales[0].state, sales[1].state);
    assert.deepEqual(
      (await new FarmPersistence(scoped, true).command(e, autoSale)).state,
      sales[0].state,
    );
    await assert.rejects(
      farm.command(e, {
        ...autoSale,
        command: { ...autoSale.command, destination: 'storage' },
      }),
      (error) => error.code === 'COMMAND_ID_CONFLICT',
    );
    await assert.rejects(
      farm.command(e, {
        ...autoSale,
        commandId: randomUUID(),
        expectedRevision: 1,
      }),
      (error) => error.code === 'PLOT_EMPTY',
    );
    const role = 'farm_role_' + randomUUID().replaceAll('-', '');
    let restricted;
    try {
      await scoped.query(`CREATE ROLE ${role}`);
      await scoped.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
      await scoped.query(farmGrants(role, true));
      const roleUrl = new URL(scopedUrl);
      roleUrl.searchParams.set('options', `-c search_path=${schema} -c role=${role}`);
      restricted = createPool(roleUrl.href);
      const restrictedFarm = new FarmPersistence(restricted, true);
      assert.equal((await restrictedFarm.get(a)).state.revision, 2);
      assert.equal(
        (
          await restrictedFarm.command(a, {
            commandId: randomUUID(),
            expectedRevision: 2,
            command: { type: 'movePlot', plotId: 0, x: 30, y: 31 },
          })
        ).state.revision,
        3,
      );
      await assert.rejects(
        restricted.query('DELETE FROM customer_farm_commands'),
        (e) => e.code === '42501',
      );
    } finally {
      if (restricted) await restricted.end();
      await scoped.query(`DROP OWNED BY ${role}`);
      await scoped.query(`DROP ROLE ${role}`);
    }
    await scoped.query('UPDATE identity_customers SET deleted_at=clock_timestamp() WHERE id=$1', [
      a,
    ]);
    await assert.rejects(farm.get(a), (e) => e.code === 'UNAUTHORIZED');
  } finally {
    await scoped.end();
    await pool.query(`DROP SCHEMA ${schema} CASCADE`);
    await pool.end();
  }
});
