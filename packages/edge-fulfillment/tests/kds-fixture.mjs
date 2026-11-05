// Shared by the KDS lane database tests (tests/integration/kds-*.test.mjs): an isolated schema
// migrated from an explicit list of edge migrations, on a local development database only.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool, migrate } from '@pickchick/database';

export const repoMigrations = fileURLToPath(
  new URL('../../../db/edge/migrations/', import.meta.url),
);
export const KDS_MIGRATION = '027_edge_kds_foundation.sql';

export function edgeTestUrl(env = process.env) {
  const value =
    env.EDGE_FULFILLMENT_TEST_DATABASE_URL ??
    env.EDGE_DATABASE_URL ??
    'postgresql://pickchick_local:pickchick_local_only@127.0.0.1:55433/pickchick_edge';
  const url = new URL(value);
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Local PostgreSQL only');
  assert.match(url.pathname, /^\/pickchick_(edge|test)(_[a-z0-9]+)?$/, 'Development database only');
  assert.equal(url.search, '', 'Connection overrides may not select another host/schema');
  return value;
}

export async function edgeMigrationNames() {
  return (await readdir(repoMigrations)).filter((n) => /^\d{3}_[a-z_]+\.sql$/.test(n)).sort();
}

/**
 * Synthetic stand-in for the pos lane's 026 while this branch does not carry it: same file
 * name, additive DDL on objects the real 026 also extends (contracts section 3.3). The tests
 * use the real file instead as soon as the repository has one.
 */
export const POS_026_STANDIN = `-- Test-only stand-in for 026_edge_pos_sales.sql (lane pos).
ALTER TABLE local_cash_shifts ADD COLUMN sales_mode boolean NOT NULL DEFAULT false;
CREATE TABLE pos_payment_methods (
  branch_id uuid NOT NULL REFERENCES branch_config(id),
  code text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  PRIMARY KEY (branch_id, code)
);
`;

/** Writes a migration directory: repo files below `below` (e.g. '026'), optional 026, optional 027. */
export async function migrationDirectory(dir, { below, with026 = false, with027 = false }) {
  const names = await edgeMigrationNames();
  for (const name of names.filter((n) => n < below))
    await copyFile(join(repoMigrations, name), join(dir, name));
  const real026 = names.find((n) => n.startsWith('026_'));
  if (with026) {
    if (real026) await copyFile(join(repoMigrations, real026), join(dir, real026));
    else await writeFile(join(dir, '026_edge_pos_sales.sql'), POS_026_STANDIN);
  }
  if (with027) await copyFile(join(repoMigrations, KDS_MIGRATION), join(dir, KDS_MIGRATION));
  return { real026: Boolean(real026) };
}

/** Runs `run` with a pool on a fresh, empty schema; migrateWith() applies a migration set. */
export async function withEdgeSchema(run) {
  const connection = edgeTestUrl();
  const schema = 'kds_' + randomUUID().replaceAll('-', '');
  const admin = createPool(connection, 2);
  const root = await mkdtemp(join(tmpdir(), 'pickchick-kds-'));
  let pool;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(connection);
    url.searchParams.set('options', `-c search_path=${schema}`);
    pool = createPool(url.toString(), 4);
    let step = 0;
    const migrateWith = async (options) => {
      const dir = join(root, String(step++));
      await mkdir(dir);
      const info = await migrationDirectory(dir, options);
      return { applied: await migrate(pool, dir, 'edge'), ...info };
    };
    await run({ pool, admin, schema, url, migrateWith });
  } finally {
    await pool?.end();
    const cleanup = await admin.connect();
    try {
      await cleanup.query('SET statement_timeout = 0');
      await cleanup.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally {
      cleanup.release();
    }
    await admin.end();
    await rm(root, { recursive: true, force: true });
  }
}

/** Minimal synthetic edge: branch, fulfillment with the two old stations, staff and terminals. */
export async function seedEdge(pool, { provisionFulfillment, kitchenLogin = true } = {}) {
  const scope = {
    organizationId: randomUUID(),
    branchId: randomUUID(),
    deviceId: randomUUID(),
    producerId: randomUUID(),
  };
  await pool.query(
    "INSERT INTO branch_config(id,code,name,timezone) VALUES($1,'KDS-TEST','Synthetic KDS edge','Asia/Almaty')",
    [scope.branchId],
  );
  const prep = randomUUID(),
    assembly = randomUUID();
  await provisionFulfillment(pool, {
    ...scope,
    stations: [
      { id: prep, kind: 'prep', name: 'Приготовление' },
      { id: assembly, kind: 'assembly', name: 'Сборка и выдача' },
    ],
    routing: {
      version: 1,
      assemblyStationId: assembly,
      routes: [{ productId: 'synthetic-burger', stationId: prep, kind: 'prep' }],
    },
  });
  const kitchen = randomUUID();
  await pool.query(
    "INSERT INTO local_staff(id,branch_id,name,role,access_expires_at) VALUES($1,$2,'Synthetic kitchen','kitchen',clock_timestamp()+interval '8 hours')",
    [kitchen, scope.branchId],
  );
  if (kitchenLogin)
    await pool.query(
      "INSERT INTO local_staff_passwords(staff_id,branch_id,login,salt,verifier) VALUES($1,$2,'kitchen',$3,$4)",
      [kitchen, scope.branchId, 'a'.repeat(64), 'b'.repeat(64)],
    );
  await pool.query(
    'INSERT INTO fulfillment_station_grants(branch_id,staff_id,station_id) VALUES($1,$2,$3),($1,$2,$4)',
    [scope.branchId, kitchen, prep, assembly],
  );
  return { scope, prep, assembly, kitchen };
}

/** Rows (as JSON) and table ACLs of every table, to prove an upgrade changed nothing. */
export async function tableFingerprint(client, schema) {
  const tables = (
    await client.query('SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename', [
      schema,
    ])
  ).rows.map((row) => row.tablename);
  const result = {};
  for (const table of tables)
    result[table] = (
      await client.query(
        `SELECT count(*)::int AS count, md5(COALESCE(string_agg(h,'' ORDER BY h),'')) AS hash
         FROM (SELECT md5(to_jsonb(t)::text) h FROM "${schema}"."${table}" t) r`,
      )
    ).rows[0];
  result.acl = (
    await client.query(
      "SELECT relname, relacl::text FROM pg_class WHERE relnamespace=$1::regnamespace AND relkind IN ('r','S') ORDER BY relname",
      [schema],
    )
  ).rows;
  return result;
}
