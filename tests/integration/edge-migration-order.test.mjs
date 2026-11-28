import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, copyFile, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
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

// Cutover 19.11 (contracts 3.1, 3.2): the reviewed bytes of the edge migrations 026+ and their
// order on top of the installed 025. Integration pins each hash from the owning lane's CR.
const CUTOVER_EDGE = {
  '026_edge_pos_sales.sql': '921c526320f6b878f592949d7ca2ebc71e28a1ceb14881c74909314ed46d057c',
  '027_edge_kds_foundation.sql': '41e55b450721646e45be599cf58626fd52328113f5a8165bb8fa5edf1e3a2a97',
  // CR pos-7 (lead decision 07.11 (1)): the desk number, applied only after 027.
  '028_edge_pos_desk_number.sql':
    '684ffa9c5265d32fd3c33e6190ca3126c83c5cb47974aa274cf198fc905d0abf',
  // ADR-0017: the Kaspi Smart POS link and attempts, applied only after 028.
  '029_edge_kaspi_pos.sql': 'edf0f0cbce196dc6601c5bcb2d9457ac2d43e12a51916d52d5cd6824f5339784',
  // Owner decision 28.11.2026: a paid terminal sale at a closed branch and the release of a paid
  // attempt without an order, applied only after 029.
  '030_edge_kaspi_pos_release.sql':
    '5dfc739e56991d170624b47eb4ac2d6846e598ac14fe8a23703fca191018022a',
};

test('cutover edge migrations upgrade a 025 edge in order with their reviewed bytes, earlier ledger unchanged', async () => {
  const files = (await readdir(directory)).filter((name) => /^\d{3}_[a-z_]+\.sql$/.test(name));
  const cutover = files.filter((name) => name >= '026').sort();
  assert.deepEqual(cutover, Object.keys(CUTOVER_EDGE).sort());
  for (const [name, checksum] of Object.entries(CUTOVER_EDGE))
    assert.equal(
      createHash('sha256')
        .update(await readFile(join(directory, name)))
        .digest('hex'),
      checksum,
      name,
    );
  await isolated(async (pool) =>
    subset(
      (name) => name < '026',
      async (installed) => {
        assert.equal(
          (await migrate(pool, installed, 'edge')).at(-1),
          '025_edge_kitchen_restore_review.sql',
        );
        const before = await ledger(pool);
        assert.deepEqual(await migrate(pool, directory, 'edge'), cutover);
        const after = await ledger(pool);
        assert.deepEqual(after.slice(0, before.length), before);
        assert.deepEqual(
          after.slice(before.length).map(({ version, checksum }) => [version, checksum]),
          cutover.map((name) => [name, CUTOVER_EDGE[name]]),
        );
        assert.deepEqual(await migrate(pool, directory, 'edge'), []);
        // An edge on 026+ never runs on a package without its files (older runtime package).
        await assert.rejects(migrate(pool, installed, 'edge'), /unsupported schema/);
        assert.deepEqual(await ledger(pool), after);
      },
    ),
  );
});

test('cutover edge 030 follows 029: a 029 edge gets only 030, the ledger before it is unchanged, a second run does nothing', async () => {
  await isolated(async (pool) => {
    await subset(
      (name) => name < '030',
      async (installed) => {
        assert.equal((await migrate(pool, installed, 'edge')).at(-1), '029_edge_kaspi_pos.sql');
      },
    );
    const before = await ledger(pool);
    assert.equal(before.at(-1).version, '029_edge_kaspi_pos.sql');
    assert.deepEqual(await migrate(pool, directory, 'edge'), ['030_edge_kaspi_pos_release.sql']);
    const after = await ledger(pool);
    assert.deepEqual(after.slice(0, before.length), before);
    assert.deepEqual(
      after.slice(before.length).map(({ version, checksum }) => [version, checksum]),
      [['030_edge_kaspi_pos_release.sql', CUTOVER_EDGE['030_edge_kaspi_pos_release.sql']]],
    );
    assert.deepEqual(await migrate(pool, directory, 'edge'), []);
    assert.deepEqual(await ledger(pool), after);
    // 026 pinned the approval actions in an unnamed CHECK: it is recreated under its usual name.
    const checks = (
      await pool.query(
        `SELECT conname FROM pg_constraint WHERE conrelid='local_manager_approvals'::regclass
         AND contype='c' AND pg_get_constraintdef(oid) LIKE '%terminal_release%'`,
      )
    ).rows;
    assert.deepEqual(checks, [{ conname: 'local_manager_approvals_action_check' }]);
  });
});

test('a failure inside 030 rolls the whole migration back: no table, old checks and functions, ledger unchanged', async () => {
  await isolated(async (pool) => {
    await subset(
      (name) => name < '030',
      async (installed) => migrate(pool, installed, 'edge'),
    );
    const before = await ledger(pool);
    const functions = async () =>
      (
        await pool.query(
          `SELECT proname,md5(prosrc) AS body,prosecdef FROM pg_proc
           WHERE pronamespace=current_schema()::regnamespace AND proname IN
           ('guard_local_execution_mode','pos_sale_assert_complete','guard_kaspi_pos_attempt_released')
           ORDER BY proname`,
        )
      ).rows;
    const oldFunctions = await functions();
    await subset(
      () => true,
      async (broken) => {
        // The statements of 030 run first, then the last one fails.
        await appendFile(join(broken, '030_edge_kaspi_pos_release.sql'), '\nSELECT 1/0;\n');
        await assert.rejects(migrate(pool, broken, 'edge'), /division by zero/);
      },
    );
    assert.deepEqual(await ledger(pool), before);
    assert.deepEqual(await functions(), oldFunctions);
    for (const relation of ['kaspi_pos_attempt_releases', 'kaspi_pos_attempts_unsold_idx'])
      assert.equal(
        (await pool.query('SELECT to_regclass($1) AS r', [relation])).rows[0].r,
        null,
        relation,
      );
    assert.equal(
      (
        await pool.query(
          `SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid='local_manager_approvals'::regclass
           AND pg_get_constraintdef(oid) LIKE '%terminal_release%'`,
        )
      ).rows[0].n,
      0,
    );
    // The real 030 still applies afterwards, and its function with owner rights has a pinned path.
    assert.deepEqual(await migrate(pool, directory, 'edge'), ['030_edge_kaspi_pos_release.sql']);
    const definer = (
      await pool.query(
        `SELECT prosecdef,proconfig FROM pg_proc WHERE proname='guard_kaspi_pos_attempt_released'
         AND pronamespace=current_schema()::regnamespace`,
      )
    ).rows[0];
    assert.equal(definer.prosecdef, true);
    assert.ok(definer.proconfig.some((item) => item.startsWith('search_path=pg_catalog')));
    // Every other function of 030 runs with the caller's rights.
    assert.deepEqual(
      (
        await pool.query(
          `SELECT proname FROM pg_proc WHERE pronamespace=current_schema()::regnamespace AND prosecdef
           AND proname LIKE '%kaspi_pos_attempt%' ORDER BY proname`,
        )
      ).rows,
      [{ proname: 'guard_kaspi_pos_attempt_released' }],
    );
  });
});

test('cutover edge 027 is never applied before 026: a gapped install refuses 026 later without changes', async () => {
  await isolated(async (pool) =>
    subset(
      // 028 builds on the 026 audit table: without 026 it is never applied at all.
      (name) => name !== '026_edge_pos_sales.sql' && name < '028',
      async (gapped) => {
        // migrate() itself does not require contiguous numbers; the guarded tools do (3.2 p.1).
        await migrate(pool, gapped, 'edge');
        const before = await ledger(pool);
        assert.ok(before.some((row) => row.version === '027_edge_kds_foundation.sql'));
        await assert.rejects(migrate(pool, directory, 'edge'), /Out-of-order migration/);
        assert.deepEqual(await ledger(pool), before);
        assert.equal((await pool.query("SELECT to_regclass('pos_sales') AS r")).rows[0].r, null);
      },
    ),
  );
});

test('cutover edge 028 is never followed by 027: a gapped install without 027 refuses 027 later without changes', async () => {
  await isolated(async (pool) =>
    subset(
      (name) => name !== '027_edge_kds_foundation.sql' && name < '029',
      async (gapped) => {
        await migrate(pool, gapped, 'edge');
        const before = await ledger(pool);
        assert.equal(before.at(-1).version, '028_edge_pos_desk_number.sql');
        await assert.rejects(migrate(pool, directory, 'edge'), /Out-of-order migration/);
        assert.deepEqual(await ledger(pool), before);
        assert.equal((await pool.query("SELECT to_regclass('kds_settings') AS r")).rows[0].r, null);
      },
    ),
  );
});
