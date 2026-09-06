import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';
import { createPool, transaction, migrate } from '@pickchick/database';
import { loadConfig } from '@pickchick/platform';
import { fixtureIds as id, fixtureMenu } from '@pickchick/test-fixtures';

const cloud = createPool(loadConfig('api').databaseUrl);
const edge = createPool(loadConfig('edge').databaseUrl);
after(async () => {
  await cloud.end();
  await edge.end();
});
const migrationDir = fileURLToPath(new URL('../../db/cloud/migrations/', import.meta.url));

async function isolatedSchema(run) {
  const schema = `test_${randomUUID().replaceAll('-', '')}`;
  await cloud.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(loadConfig('api').databaseUrl);
  url.searchParams.set('options', `-c search_path=${schema}`);
  const pool = createPool(url.toString());
  try {
    await run(pool);
  } finally {
    await pool.end();
    await cloud.query(`DROP SCHEMA ${schema} CASCADE`);
  }
}

test('fresh migrations serialize concurrent runners and remain idempotent', async () => {
  await isolatedSchema(async (pool) => {
    const result = await Promise.all([
      migrate(pool, migrationDir, 'cloud'),
      migrate(pool, migrationDir, 'cloud'),
    ]);
    const migrationCount = (await readdir(migrationDir)).filter((file) =>
      file.endsWith('.sql'),
    ).length;
    assert.equal(result.flat().length, migrationCount);
    assert.deepEqual(await migrate(pool, migrationDir, 'cloud'), []);
    assert.equal(
      Number((await pool.query('SELECT count(*) FROM schema_migrations')).rows[0].count),
      migrationCount,
    );
    await assert.rejects(
      migrate(pool, fileURLToPath(new URL('../../db/edge/migrations/', import.meta.url)), 'edge'),
      /another scope/,
    );
  });
});

test('migration checksum drift is rejected', async () => {
  await isolatedSchema(async (pool) => {
    await migrate(pool, migrationDir, 'cloud');
    const directory = await mkdtemp(join(tmpdir(), 'pickchick-migration-'));
    try {
      for (const file of await readdir(migrationDir)) {
        const original = await readFile(join(migrationDir, file), 'utf8');
        await writeFile(join(directory, file), `${original}\n-- changed\n`);
      }
      await assert.rejects(migrate(pool, directory, 'cloud'), /Changed migration/);
    } finally {
      await rm(directory, { recursive: true });
    }
  });
});

test('failed DDL rolls back schema and migration ledger together', async () => {
  await isolatedSchema(async (pool) => {
    const directory = await mkdtemp(join(tmpdir(), 'pickchick-broken-migration-'));
    try {
      await writeFile(
        join(directory, '001_broken.sql'),
        'CREATE TABLE should_rollback(id int); SELECT * FROM missing_table;',
      );
      await assert.rejects(migrate(pool, directory, 'cloud'));
      const { rows } = await pool.query(
        "SELECT to_regclass('should_rollback') AS created, to_regclass('schema_migrations') AS ledger",
      );
      assert.equal(rows[0].created, null);
      assert.equal(rows[0].ledger, null);
    } finally {
      await rm(directory, { recursive: true });
    }
  });
});

test('transaction rolls back the business row when a later operation fails', async () => {
  const orgId = randomUUID();
  await assert.rejects(
    transaction(cloud, async (client) => {
      await client.query('INSERT INTO organizations(id, name) VALUES ($1, $2)', [
        orgId,
        'rollback test',
      ]);
      throw new Error('simulated failure before commit');
    }),
  );
  assert.equal(
    (await cloud.query('SELECT 1 FROM organizations WHERE id = $1', [orgId])).rowCount,
    0,
  );
});

test('branch and device cannot cross organization boundaries', async () => {
  await assert.rejects(
    transaction(cloud, async (client) => {
      const orgId = randomUUID();
      await client.query('INSERT INTO organizations(id, name) VALUES ($1, $2)', [
        orgId,
        'different organization',
      ]);
      await client.query(
        'INSERT INTO branches(id, organization_id, legal_entity_id, code, name) VALUES ($1, $2, $3, $4, $5)',
        [randomUUID(), orgId, id.legalEntity, 'OTHER', 'Cross-organization test'],
      );
    }),
    (error) => error.code === '23503',
  );
  await assert.rejects(
    transaction(cloud, async (client) => {
      await client.query(
        'INSERT INTO devices(id, branch_id, organization_id, kind, name) VALUES ($1, $2, $3, $4, $5)',
        [randomUUID(), id.branch, randomUUID(), 'pos', 'Wrong organization'],
      );
    }),
    (error) => error.code === '23503',
  );
});

test('database rejects negative money and non-KZT prices', async () => {
  for (const [column, value] of [
    ['price_minor', '-1'],
    ['currency', 'USD'],
  ]) {
    await assert.rejects(
      transaction(cloud, (client) =>
        client.query(`UPDATE branch_prices SET ${column} = $1 WHERE branch_id = $2`, [
          value,
          id.branch,
        ]),
      ),
      (error) => error.code === '23514',
    );
  }
});

test('published cloud and edge menu snapshots cannot be rewritten', async () => {
  for (const [pool, table] of [
    [cloud, 'menu_releases'],
    [edge, 'menu_snapshots'],
  ]) {
    await assert.rejects(
      transaction(pool, (client) =>
        client.query(`UPDATE ${table} SET version = 2 WHERE id = $1`, [id.release]),
      ),
      (error) => error.code === '23514',
    );
  }
});

test('edge cannot accidentally host a second branch', async () => {
  await assert.rejects(
    transaction(edge, (client) =>
      client.query(
        "INSERT INTO branch_config(id, code, name, timezone) VALUES ($1, 'SECOND', 'Second', 'Asia/Almaty')",
        [randomUUID()],
      ),
    ),
    (error) => error.code === '23505',
  );
});

test('inbox deduplicates incoming event identity in the database', async () => {
  await assert.rejects(
    transaction(edge, async (client) => {
      const event = randomUUID();
      const sql =
        'INSERT INTO inbox_messages(producer_id, event_id, branch_id, payload_hash, result) VALUES ($1, $2, $3, $4, $5)';
      const args = [id.device, event, id.branch, 'a'.repeat(64), '{}'];
      await client.query(sql, args);
      await client.query(sql, args);
    }),
    (error) => error.code === '23505',
  );
});

test('JSON null cannot bypass snapshot identity constraints', async () => {
  for (const [pool, table] of [
    [cloud, 'menu_releases'],
    [edge, 'menu_snapshots'],
  ]) {
    for (const field of ['release_id', 'branch_id', 'version', 'schema_version']) {
      const release = randomUUID();
      const payload = { ...fixtureMenu, release_id: release, version: 2, [field]: null };
      await assert.rejects(
        transaction(pool, async (client) => {
          await client.query(
            `INSERT INTO ${table}(id, branch_id, version, schema_version, payload, checksum, published_at) VALUES ($1, $2, 2, 1, $3, $4, $5)`,
            [release, id.branch, payload, 'b'.repeat(64), fixtureMenu.published_at],
          );
          throw new Error('Snapshot guard was not enforced');
        }),
        (error) => error.code === '23514',
      );
    }
  }
});
