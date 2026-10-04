import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createPool } from '@pickchick/database';
import { FarmPersistence } from '../dist/index.js';
import { farmGrants } from '../../../infra/staging/farm-grants.mjs';

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
      command: { type: 'plant', plotId: 0, cropId: 'carrot' },
    };
    const results = await Promise.all([farm.command(a, command), farm.command(a, command)]);
    assert.equal(results[0].state.revision, 1);
    assert.equal(results[1].state.revision, 1);
    assert.equal(results[0].state.plots[0].plantedAt, results[0].serverNow);
    assert.equal(results[0].state.coins, 96);
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
          command: { type: 'plant', plotId: plotId + 1, cropId: 'carrot' },
        }),
      ),
    );
    assert.equal(competing.filter((x) => x.status === 'fulfilled').length, 1);
    assert.equal(competing.find((x) => x.status === 'rejected').reason.code, 'STALE_STATE');
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
        command: { type: 'plant', plotId: 3, cropId: 'carrot' },
      }),
    );
    assert.equal((await farm.get(a)).state.revision, 2, 'state update rolls back with receipt');
    await scoped.query('DROP TRIGGER receipt_failure ON customer_farm_commands');
    await scoped.query(
      "INSERT INTO customer_farm_commands(customer_id,command_id,request_hash,revision) SELECT $1,gen_random_uuid(),repeat('e',64),0 FROM generate_series(1,120)",
      [b],
    );
    await assert.rejects(
      farm.command(b, {
        commandId: randomUUID(),
        expectedRevision: 0,
        command: { type: 'plant', plotId: 0, cropId: 'carrot' },
      }),
      (e) => e.code === 'RATE_LIMITED',
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
            command: { type: 'plant', plotId: 3, cropId: 'carrot' },
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
