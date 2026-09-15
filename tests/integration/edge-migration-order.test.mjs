import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createPool, migrate } from '@pickchick/database';
import { connection, fixture } from '../../packages/edge-fulfillment/tests/fixture.mjs';

const directory = fileURLToPath(new URL('../../db/edge/migrations/', import.meta.url));
const releaseMigration = '007_edge_release_results.sql';
// Exact SQL from canonical cancellation commit 5584542; do not rewrite applied bytes.
const releaseChecksum = '5dfe0792d97c00728e6b376b95cb453d7a164cd9dc6fb5b10fbf77ce85da5dd0';
const ledger = async (pool) =>
  (await pool.query('SELECT version, checksum, scope FROM schema_migrations ORDER BY version'))
    .rows;

async function isolated(run) {
  const schema = 'migration_order_' + randomUUID().replaceAll('-', '');
  const admin = createPool(connection, 1);
  let pool;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(connection);
    url.searchParams.set('options', `-c search_path=${schema}`);
    pool = createPool(url.toString(), 2);
    await run(pool);
  } finally {
    if (pool) await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
}

async function subset(keep, run) {
  const temporary = await mkdtemp(join(tmpdir(), 'pickchick-edge-order-'));
  try {
    for (const name of await readdir(directory)) {
      if (/^\d{3}_[a-z_]+\.sql$/.test(name) && keep(name))
        await copyFile(join(directory, name), join(temporary, name));
    }
    await run(temporary);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

test('fresh edge release includes exact canonical 007 before 008/009 without seeding data', async () => {
  const bytes = await readFile(join(directory, releaseMigration));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), releaseChecksum);
  await isolated(async (pool) => {
    const applied = await migrate(pool, directory, 'edge');
    assert.deepEqual(
      applied.filter((name) => name < '010').map((name) => name.slice(0, 3)),
      ['001', '002', '003', '004', '005', '006', '007', '008', '009'],
    );
    const before = await ledger(pool);
    assert.equal(before.find((row) => row.version === releaseMigration).checksum, releaseChecksum);
    assert.ok(before.every((row) => row.scope === 'edge'));
    assert.deepEqual(await migrate(pool, directory, 'edge'), []);
    assert.deepEqual(await ledger(pool), before);
    for (const table of [
      'branch_config',
      'local_orders',
      'fulfillment_reservations',
      'fulfillment_release_results',
      'fulfillment_outbox',
    ])
      assert.equal((await pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count, '0', table);
  });
});

test('edge 001-006 upgrades through 007 without changing existing migration checksums', async () => {
  await isolated(async (pool) =>
    subset(
      (name) => name < '007',
      async (oldDirectory) => {
        await migrate(pool, oldDirectory, 'edge');
        const before = await ledger(pool);
        const applied = await migrate(pool, directory, 'edge');
        assert.deepEqual(
          applied.filter((name) => name < '010').map((name) => name.slice(0, 3)),
          ['007', '008', '009'],
        );
        assert.deepEqual((await ledger(pool)).slice(0, before.length), before);
      },
    ),
  );
});

test('late 007 after an older gapped 008/009 install fails without rewriting schema or ledger', async () => {
  await isolated(async (pool) =>
    subset(
      (name) => name !== releaseMigration,
      async (oldDirectory) => {
        await migrate(pool, oldDirectory, 'edge');
        const before = await ledger(pool);
        await assert.rejects(migrate(pool, directory, 'edge'), /Out-of-order migration/);
        assert.deepEqual(await ledger(pool), before);
        assert.equal(
          (await pool.query("SELECT to_regclass('fulfillment_release_results') AS value")).rows[0]
            .value,
          null,
        );
        assert.equal(
          (
            await pool.query(
              "SELECT count(*) FROM pg_constraint WHERE conrelid='fulfillment_outbox'::regclass AND conname='fulfillment_outbox_order_id_aggregate_version_key'",
            )
          ).rows[0].count,
          '1',
        );
      },
    ),
  );
});

test('007 keeps state event uniqueness and immutable outbox/results while reserving command decisions', async () => {
  await fixture(async (ctx) => {
    const { order } = await ctx.accepted();
    const source = (
      await ctx.pool.query(
        'SELECT * FROM fulfillment_outbox WHERE order_id=$1 ORDER BY sequence LIMIT 1',
        [order.orderId],
      )
    ).rows[0];
    const duplicate = (eventId, eventType) =>
      ctx.pool.query(
        `INSERT INTO fulfillment_outbox(event_id,branch_id,order_id,aggregate_version,event_type,payload)
       VALUES($1,$2,$3,$4,$5,$6)`,
        [
          eventId,
          source.branch_id,
          source.order_id,
          source.aggregate_version,
          eventType,
          source.payload,
        ],
      );
    await assert.rejects(
      duplicate(randomUUID(), source.event_type),
      (error) => error.code === '23505',
    );
    await assert.rejects(
      duplicate(randomUUID(), 'edge.other_state'),
      (error) => error.code === '23505',
    );
    const resultEvent = randomUUID();
    await duplicate(resultEvent, 'edge.admission_release_result');
    await duplicate(randomUUID(), 'edge.admission_release_result');
    await ctx.pool.query(
      `INSERT INTO fulfillment_release_results(producer_id,event_id,branch_id,order_id,request_hash,result,result_event_id)
       VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [
        ctx.scope.producerId,
        randomUUID(),
        source.branch_id,
        source.order_id,
        'a'.repeat(64),
        { synthetic: true },
        resultEvent,
      ],
    );
    for (const sql of [
      'UPDATE fulfillment_release_results SET result=result',
      'DELETE FROM fulfillment_release_results',
      "UPDATE fulfillment_outbox SET payload='{}'",
      'DELETE FROM fulfillment_outbox',
    ])
      await assert.rejects(ctx.pool.query(sql), (error) => error.code === '23514');
    await ctx.pool.query('UPDATE fulfillment_outbox SET attempts=attempts+1 WHERE event_id=$1', [
      source.event_id,
    ]);
    assert.equal(
      (
        await ctx.pool.query('SELECT payload FROM fulfillment_outbox WHERE event_id=$1', [
          source.event_id,
        ])
      ).rows[0].payload.orderId,
      source.order_id,
    );
  });
});
