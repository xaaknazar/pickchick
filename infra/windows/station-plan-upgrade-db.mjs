import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MENU_SYNC_ROLE,
  STATION_PLAN_PRIVILEGES,
  STATION_PLAN_SCHEMA,
  assertMenuSyncPrivileges,
  stationPlanWorkerGrants,
} from './menu-sync-worker-grants.mjs';

/**
 * Edge schema023 -> 024 (stage 2, lane cfg): station plans delivered from the back-office.
 * Run by the edge owner with every edge service stopped and a fresh verified backup, after
 * restore-fence-upgrade-db.mjs (023). `inspect` changes nothing; `apply` adds the migration in
 * one transaction, grants the schema024 privileges only to the menu-sync worker role (when that
 * role is installed) and proves its exact privilege set, that no other role can reach the new
 * tables, and that every existing row, sequence and table privilege is unchanged.
 * Rollback: the previous binary keeps working on 024 (nothing it runs reads these tables), so
 * no schema rollback is needed; EDGE_STATION_PLAN_SYNC_MODE=off stops using them.
 */
export const STATION_PLAN_MIGRATION = STATION_PLAN_SCHEMA;
const NEW_TABLES = Object.keys(STATION_PLAN_PRIVILEGES);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const identifier = (name) => {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(name ?? '')) throw Error('Invalid identifier');
  return '"' + name + '"';
};

export async function stationPlanMigration(
  client,
  {
    mode,
    appRoot,
    branchId,
    schema = 'public',
    workerRole = MENU_SYNC_ROLE,
    databaseDefaultsRevoked = true,
  },
) {
  if (!['inspect', 'apply'].includes(mode)) throw Error('Invalid mode');
  const ns = identifier(schema);
  identifier(workerRole);
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query('SET LOCAL search_path TO ' + ns);
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('pickchick-station-plans-024',0))",
    );
    const tables = (
      await client.query('SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename', [
        schema,
      ])
    ).rows.map((r) => r.tablename);
    await client.query(
      'LOCK TABLE ' +
        tables.map((n) => ns + '.' + identifier(n)).join(',') +
        ' IN ACCESS EXCLUSIVE MODE',
    );
    const ledger = (
      await client.query('SELECT scope,version,checksum FROM schema_migrations ORDER BY version')
    ).rows;
    const dir = join(appRoot, 'db/edge/migrations');
    const names = (await readdir(dir)).filter((n) => /^\d{3}_[a-z_]+\.sql$/.test(n)).sort();
    const expected = [];
    for (const name of names.slice(0, 24))
      expected.push({
        scope: 'edge',
        version: name,
        checksum: digest(await readFile(join(dir, name))),
      });
    if (
      expected.length !== 24 ||
      names[23] !== STATION_PLAN_MIGRATION ||
      JSON.stringify(ledger) !== JSON.stringify(expected.slice(0, 23))
    )
      throw Error('Expected unchanged schema023 and only reviewed migration024');
    if (NEW_TABLES.some((table) => tables.includes(table)))
      throw Error('Station plan objects already exist');
    const branches = (await client.query('SELECT id FROM branch_config')).rows;
    if (branches.length !== 1 || branches[0].id !== branchId) throw Error('Branch differs');
    const columns = Object.fromEntries(
      (
        await client.query(
          `SELECT table_name AS name, array_agg(column_name::text ORDER BY ordinal_position) AS columns
             FROM information_schema.columns WHERE table_schema=$1 GROUP BY table_name`,
          [schema],
        )
      ).rows.map((r) => [r.name, r.columns]),
    );
    const snapshot = async () => {
      const result = {};
      for (const table of tables.filter((t) => t !== 'schema_migrations')) {
        const projection = `jsonb_build_object(${columns[table]
          .map((c) => `'${c}',t.${identifier(c)}`)
          .join(',')})`;
        result[table] = (
          await client.query(
            `SELECT count(*)::text AS count, md5(COALESCE(string_agg(h,'' ORDER BY h),'')) AS hash FROM (SELECT md5((${projection})::text) h FROM ${ns}.${identifier(table)} t) r`,
          )
        ).rows[0];
      }
      result.sequences = (
        await client.query(
          'SELECT sequencename,last_value FROM pg_sequences WHERE schemaname=$1 ORDER BY sequencename',
          [schema],
        )
      ).rows;
      result.acl = (
        await client.query(
          "SELECT relname,relacl FROM pg_class WHERE relnamespace=$1::regnamespace AND relkind IN ('r','S') AND relname=ANY($2) ORDER BY relname",
          [schema, tables],
        )
      ).rows;
      return JSON.stringify(result);
    };
    const before = await snapshot();
    const worker = (
      await client.query('SELECT rolname FROM pg_roles WHERE rolname=$1', [workerRole])
    ).rows[0];
    if (mode === 'apply') {
      await client.query(await readFile(join(dir, STATION_PLAN_MIGRATION), 'utf8'));
      await client.query('INSERT INTO schema_migrations(scope,version,checksum) VALUES($1,$2,$3)', [
        'edge',
        STATION_PLAN_MIGRATION,
        expected[23].checksum,
      ]);
      if (worker) {
        await client.query(stationPlanWorkerGrants(workerRole, schema));
        await assertMenuSyncPrivileges(client, workerRole, schema, {
          databaseDefaultsRevoked,
          stationPlans: true,
        });
      }
      // Only the menu-sync worker may reach the new tables; the owner keeps its own rights.
      const reach = (
        await client.query(
          `SELECT DISTINCT COALESCE(r.rolname,'PUBLIC') AS grantee FROM pg_class c
           CROSS JOIN LATERAL aclexplode(c.relacl) x LEFT JOIN pg_roles r ON r.oid=x.grantee
           WHERE c.relnamespace=$1::regnamespace AND c.relname=ANY($2) AND x.grantee<>c.relowner
           ORDER BY 1`,
          [schema, NEW_TABLES],
        )
      ).rows.map((r) => r.grantee);
      if (JSON.stringify(reach) !== JSON.stringify(worker ? [workerRole] : []))
        throw Error('Unexpected role can reach station plan tables');
      if ((await snapshot()) !== before)
        throw Error('Data, sequence or permission changed during migration');
    }
    await client.query(mode === 'apply' ? 'COMMIT' : 'ROLLBACK');
    return {
      mode,
      migrations: mode === 'apply' ? 24 : 23,
      stationPlanGrantedTo: mode === 'apply' && worker ? [workerRole] : [],
      workerRolePresent: Boolean(worker),
      dataPreserved: true,
      fingerprint: digest(before),
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

async function main() {
  const [mode, toolsRoot, appRoot, branchId, ...extra] = process.argv.slice(2);
  if (
    !['inspect', 'apply'].includes(mode) ||
    extra.length ||
    !toolsRoot ||
    !appRoot ||
    !/^[a-f0-9-]{36}$/.test(branchId ?? '')
  )
    throw Error('Invalid station plan migration invocation');
  const url = new URL(process.env.EDGE_DATABASE_URL ?? '');
  if (
    url.hostname !== '127.0.0.1' ||
    url.port !== '55433' ||
    url.pathname !== '/pickchick_edge' ||
    url.username !== 'pickchick_edge_owner'
  )
    throw Error('Expected local edge owner');
  const { Client } = createRequire(join(resolve(toolsRoot), 'package.json'))('pg');
  const client = new Client({
    connectionString: url.href,
    connectionTimeoutMillis: 3000,
    statement_timeout: 30000,
  });
  client.on('error', () => {});
  await client.connect();
  try {
    console.log(JSON.stringify(await stationPlanMigration(client, { mode, appRoot, branchId })));
  } finally {
    await client.end();
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(() => {
    console.error('Station plan migration stopped; inspect protected state.');
    process.exitCode = 1;
  });
