import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KDS_STATIONS, kdsStationId, provisionKdsStations } from '@pickchick/edge-fulfillment';
import { deriveRouting } from '@pickchick/menu-sync';
import {
  KDS_TABLES,
  MIGRATION,
  assertKdsRuntimePrivileges,
  assertKdsWorkerPrivileges,
  kdsRuntimeGrantSql,
  kdsTableGrantees,
  kdsWorkerGrantSql,
} from './kds-grants.mjs';
import { POS_SALES_MIGRATION, POS_SALES_SHA256 } from './pos-sales-upgrade-db.mjs';

/**
 * Edge schema026 -> 027 (cutover 19.11.2026, lane kds; contracts 3.1, 3.2, 5.9, 6.2 step 3):
 * the KDS foundation. Run by the edge owner after pos-sales-upgrade-db.mjs (026) with every edge
 * service stopped and a fresh verified schema026 backup, from the runtime package that carries
 * the KDS-2 routing rule (routing.ts with several prep stations; checked below). `inspect`
 * changes nothing; `apply` adds exactly the reviewed 027 bytes in one transaction, provisions
 * the six KDS stations with the kitchen login's station grants and the switched-off kds_settings
 * row (provisionKdsStations), grants the edge runtime RUNTIME_PRIVILEGES and every installed
 * fulfillment worker role WORKER_PRIVILEGES (CR kds-1, CR kds-3: the cloud admission reads the
 * layout), proves the exact sets and that no other role reaches the KDS tables, and that every
 * other row, sequence, table ACL and function is unchanged. The layout stays off: kds-switch.mjs
 * enables it later. A second `apply` refuses; `inspect` on 027 verifies the installed state and
 * refuses when a worker or the runtime lacks its KDS rights (cloud orders would stay on the old
 * stations). Rollback: the previous binary keeps working on 027 (it reads none of it).
 */
export const KDS_MIGRATION = MIGRATION;
/** SHA-256 of the reviewed 027 (CR kds-1, unchanged in CR kds-3/kds-5); other bytes are refused. */
export const KDS_SHA256 = '41e55b450721646e45be599cf58626fd52328113f5a8165bb8fa5edf1e3a2a97';
/** Fulfillment worker logins: the native worker and the cashier-reports default (kds-switch). */
export const KDS_UPGRADE_WORKER_ROLES = Object.freeze([
  'pickchick_fulfillment_sync',
  'pickchick_fulfillment_worker',
]);
const LEDGER_LENGTH = 27;
const DATA_TABLES = ['fulfillment_station_grants', 'fulfillment_stations'];
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const identifier = (name) => {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(name ?? '')) throw Error('Invalid identifier');
  return '"' + name + '"';
};

/**
 * KDS-2 precondition (CR kds-1 section 2, CR kds-3 section 2): with the KDS stations 5 and 6
 * (both prep) a new prep item follows the station of the existing prep routes. The routing of
 * the runtime package before KDS-2 refuses it, and every menu publication with a new item would
 * then fail with ROUTING_UNRESOLVED.
 */
export function routingSupportsKdsStations(derive = deriveRouting) {
  const prep = '00000000-0000-4000-8000-000000000001',
    kds = '00000000-0000-4000-8000-000000000002',
    assembly = '00000000-0000-4000-8000-000000000003';
  try {
    const next = derive(
      { items: [{ product_id: 'kds-probe-new', kind: 'item', kitchen: { route: 'prep' } }] },
      {
        version: 1,
        assemblyStationId: assembly,
        routes: [{ productId: 'kds-probe-old', stationId: prep, kind: 'prep' }],
      },
      [
        { id: prep, kind: 'prep' },
        { id: kds, kind: 'prep' },
        { id: assembly, kind: 'assembly' },
      ],
    );
    return next?.routes.find((route) => route.productId === 'kds-probe-new')?.stationId === prep;
  } catch {
    return false;
  }
}

async function reviewedFiles(appRoot) {
  const dir = join(appRoot, 'db/edge/migrations');
  const names = (await readdir(dir)).filter((n) => /^\d{3}_[a-z_]+\.sql$/.test(n)).sort();
  const expected = [];
  for (const name of names.slice(0, LEDGER_LENGTH))
    expected.push({
      scope: 'edge',
      version: name,
      checksum: digest(await readFile(join(dir, name))),
    });
  if (
    expected.length !== LEDGER_LENGTH ||
    names.some((name, index) => !name.startsWith(String(index + 1).padStart(3, '0') + '_')) ||
    names[LEDGER_LENGTH - 2] !== POS_SALES_MIGRATION ||
    expected[LEDGER_LENGTH - 2].checksum !== POS_SALES_SHA256 ||
    names[LEDGER_LENGTH - 1] !== KDS_MIGRATION ||
    expected[LEDGER_LENGTH - 1].checksum !== KDS_SHA256
  )
    throw Error('Expected reviewed migrations 001-026 and the reviewed migration027');
  return { dir, expected };
}

export async function kdsMigration(
  client,
  {
    mode,
    appRoot,
    branchId,
    schema = 'public',
    runtimeRole = 'pickchick_edge_runtime',
    workerRoles = KDS_UPGRADE_WORKER_ROLES,
    derive = deriveRouting,
  },
) {
  if (!['inspect', 'apply'].includes(mode)) throw Error('Invalid mode');
  const ns = identifier(schema);
  identifier(runtimeRole);
  if (!Array.isArray(workerRoles) || workerRoles.some((role) => role === runtimeRole))
    throw Error('Invalid worker roles');
  workerRoles.forEach(identifier);
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query('SET LOCAL search_path TO ' + ns);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('pickchick-kds-027',0))");
    const others = (
      await client.query(
        `SELECT DISTINCT usename::text AS role FROM pg_stat_activity
         WHERE datname=current_database() AND pid<>pg_backend_pid()
           AND backend_type='client backend' AND usename IS DISTINCT FROM current_user ORDER BY 1`,
      )
    ).rows.map((r) => r.role);
    if (others.length) throw Error('Edge services must be stopped');
    if (!routingSupportsKdsStations(derive))
      throw Error('Runtime package lacks the KDS-2 routing rule');
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
    const { dir, expected } = await reviewedFiles(appRoot);
    const branches = (await client.query('SELECT id FROM branch_config')).rows;
    if (branches.length !== 1 || branches[0].id !== branchId) throw Error('Branch differs');
    const present = (
      await client.query('SELECT rolname FROM pg_roles WHERE rolname=ANY($1) ORDER BY rolname', [
        [runtimeRole, ...workerRoles],
      ])
    ).rows.map((r) => r.rolname);
    const runtime = present.includes(runtimeRole);
    const workers = workerRoles.filter((role) => present.includes(role));
    const verifyGrants = async () => {
      if (runtime) await assertKdsRuntimePrivileges(client, runtimeRole, schema);
      for (const role of workers) await assertKdsWorkerPrivileges(client, role, schema);
      const grantees = (await kdsTableGrantees(client, schema)).sort();
      if (JSON.stringify(grantees) !== JSON.stringify([...present].sort()))
        throw Error('Unexpected role can reach KDS tables');
    };
    const kdsState = async () =>
      (
        await client.query(
          `SELECT (SELECT count(*)::int FROM fulfillment_stations WHERE branch_id=$1 AND id=ANY($2)) AS stations,
             (SELECT layout_enabled FROM kds_settings WHERE branch_id=$1) AS enabled`,
          [branchId, KDS_STATIONS.map((station) => kdsStationId(branchId, station.function))],
        )
      ).rows[0];
    // Already on the reviewed 027 (later reviewed migrations may follow): inspect verifies it.
    if (JSON.stringify(ledger.slice(0, LEDGER_LENGTH)) === JSON.stringify(expected)) {
      if (mode === 'apply') throw Error('Migration027 is already applied; nothing changed');
      await verifyGrants();
      const state = await kdsState();
      if (state.stations !== KDS_STATIONS.length || state.enabled === null)
        throw Error('KDS stations or settings are missing');
      await client.query('ROLLBACK');
      return {
        mode,
        migrations: LEDGER_LENGTH,
        applied: true,
        kdsGrantedTo: [...present].sort(),
        runtimeRolePresent: runtime,
        workerRolesPresent: workers,
        stations: state.stations,
        layoutEnabled: state.enabled,
        dataPreserved: true,
        fingerprint: null,
      };
    }
    if (JSON.stringify(ledger) !== JSON.stringify(expected.slice(0, LEDGER_LENGTH - 1)))
      throw Error('Expected unchanged schema026 and only reviewed migration027');
    if (KDS_TABLES.some((name) => tables.includes(name))) throw Error('KDS objects already exist');
    if (
      !(await client.query('SELECT 1 FROM fulfillment_config WHERE branch_id=$1', [branchId]))
        .rowCount
    )
      throw Error('Fulfillment is not provisioned on this edge');
    const columns = Object.fromEntries(
      (
        await client.query(
          `SELECT table_name AS name, array_agg(column_name::text ORDER BY ordinal_position) AS columns
             FROM information_schema.columns WHERE table_schema=$1 GROUP BY table_name`,
          [schema],
        )
      ).rows.map((r) => [r.name, r.columns]),
    );
    const rowHashes = async (table) =>
      (
        await client.query(
          `SELECT md5((jsonb_build_object(${columns[table]
            .map((c) => `'${c}',t.${identifier(c)}`)
            .join(',')}))::text) AS h FROM ${ns}.${identifier(table)} t ORDER BY 1`,
        )
      ).rows.map((r) => r.h);
    // Every row (the two station tables may only gain rows), sequences, table ACLs and functions.
    const snapshot = async () => {
      const result = {};
      for (const table of tables.filter(
        (t) => t !== 'schema_migrations' && !DATA_TABLES.includes(t),
      ))
        result[table] = (
          await client.query(
            `SELECT count(*)::text AS count, md5(COALESCE(string_agg(h,'' ORDER BY h),'')) AS hash FROM (SELECT md5((jsonb_build_object(${columns[
              table
            ]
              .map((c) => `'${c}',t.${identifier(c)}`)
              .join(',')}))::text) h FROM ${ns}.${identifier(table)} t) r`,
          )
        ).rows[0];
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
      result.functions = (
        await client.query(
          `SELECT p.oid::regprocedure::text AS name, pg_get_userbyid(p.proowner) AS owner,
             p.proacl::text AS acl, p.proconfig::text AS config, p.prosecdef AS definer,
             pg_get_functiondef(p.oid) AS definition
           FROM pg_proc p WHERE p.pronamespace=$1::regnamespace AND p.prokind='f'
             AND NOT (p.proname=ANY($2)) ORDER BY 1`,
          [schema, ['reject_kds_history_mutation', 'guard_kds_journal', 'guard_kds_settings']],
        )
      ).rows;
      return JSON.stringify(result);
    };
    const before = await snapshot();
    const data = {};
    for (const table of DATA_TABLES) data[table] = await rowHashes(table);
    let provisioned = null;
    if (mode === 'apply') {
      await client.query(await readFile(join(dir, KDS_MIGRATION), 'utf8'));
      await client.query('INSERT INTO schema_migrations(scope,version,checksum) VALUES($1,$2,$3)', [
        'edge',
        KDS_MIGRATION,
        KDS_SHA256,
      ]);
      provisioned = await provisionKdsStations(client, branchId);
      if (runtime) await client.query(kdsRuntimeGrantSql(runtimeRole, schema));
      for (const role of workers) await client.query(kdsWorkerGrantSql(role, schema));
      await verifyGrants();
      // Only the KDS stations and the kitchen login's grants on them are new rows.
      const added = {
        fulfillment_stations: provisioned.stationsAdded,
        fulfillment_station_grants: provisioned.grantsAdded,
      };
      for (const table of DATA_TABLES) {
        const after = await rowHashes(table);
        const kept = new Set(after);
        if (
          data[table].some((hash) => !kept.has(hash)) ||
          after.length !== data[table].length + added[table]
        )
          throw Error('Unexpected change of ' + table);
      }
      const state = await kdsState();
      if (state.stations !== KDS_STATIONS.length || state.enabled !== false)
        throw Error('KDS must stay off after migration027');
      if ((await snapshot()) !== before)
        throw Error('Data, sequence or permission changed during migration');
    }
    await client.query(mode === 'apply' ? 'COMMIT' : 'ROLLBACK');
    return {
      mode,
      migrations: mode === 'apply' ? LEDGER_LENGTH : LEDGER_LENGTH - 1,
      applied: mode === 'apply',
      kdsGrantedTo: mode === 'apply' ? [...present].sort() : [],
      runtimeRolePresent: runtime,
      workerRolesPresent: workers,
      stations: provisioned ? provisioned.stations.length : 0,
      stationsAdded: provisioned?.stationsAdded ?? 0,
      kitchenGrantsAdded: provisioned?.grantsAdded ?? 0,
      // null: no active kitchen login yet; kds-switch enable refuses until it exists and this
      // provisioning is repeated (provisionKdsStations is idempotent).
      kitchenStaffId: provisioned?.kitchenStaffId ?? null,
      layoutEnabled: false,
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
    throw Error('Invalid KDS migration invocation');
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
    console.log(JSON.stringify(await kdsMigration(client, { mode, appRoot, branchId })));
  } finally {
    await client.end();
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(() => {
    console.error('KDS migration stopped; inspect protected state.');
    process.exitCode = 1;
  });
