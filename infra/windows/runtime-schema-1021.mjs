import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const hash = (v) => createHash('sha256').update(v).digest('hex');
const id = (v) => {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(v ?? '')) throw Error('Invalid identifier');
  return '"' + v + '"';
};
export async function upgradeRuntimeSchema(
  client,
  {
    mode,
    appRoot,
    branchId,
    schema = 'public',
    runtimeRole = 'pickchick_edge_runtime',
    workerRole = 'pickchick_fulfillment_sync',
    deviceRole = 'pickchick_device_access_sync',
  },
) {
  if (!['inspect', 'apply'].includes(mode)) throw Error('Invalid mode');
  const ns = id(schema),
    roles = [runtimeRole, workerRole, deviceRole];
  roles.forEach(id);
  if (new Set(roles).size !== 3) throw Error('Separate restricted roles required');
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query('SET LOCAL search_path TO ' + ns);
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('pickchick-runtime-schema-1021',0))",
    );
    const tables = (
      await client.query('SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename', [
        schema,
      ])
    ).rows.map((r) => r.tablename);
    await client.query(
      'LOCK TABLE ' + tables.map((t) => ns + '.' + id(t)).join(',') + ' IN ACCESS EXCLUSIVE MODE',
    );
    const dir = join(appRoot, 'db/edge/migrations');
    const names = (await readdir(dir)).filter((n) => /^\d{3}_[a-z_]+\.sql$/.test(n)).sort();
    if (
      names.length !== 23 ||
      names.some((n, i) => !n.startsWith(String(i + 1).padStart(3, '0') + '_')) ||
      names.slice(20).join(',') !==
        '021_edge_device_presence.sql,022_edge_display_numbers.sql,023_edge_restore_fence.sql'
    )
      throw Error('Exact reviewed schema023 files required');
    const expected = [];
    for (const version of names)
      expected.push({ scope: 'edge', version, checksum: hash(await readFile(join(dir, version))) });
    const ledger = (
      await client.query('SELECT scope,version,checksum FROM schema_migrations ORDER BY version')
    ).rows;
    if (JSON.stringify(ledger) !== JSON.stringify(expected.slice(0, 20)))
      throw Error('Exact unchanged schema020 required; no replay');
    const branches = (await client.query('SELECT id FROM branch_config')).rows;
    if (branches.length !== 1 || branches[0].id !== branchId) throw Error('Branch differs');
    const actualRoles = (
      await client.query(
        `SELECT rolname,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,
      EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid OR m.roleid=r.oid) member
      FROM pg_roles r WHERE rolname=ANY($1) ORDER BY rolname`,
        [roles],
      )
    ).rows;
    if (
      actualRoles.length !== 3 ||
      actualRoles.some(
        (r) =>
          r.rolsuper ||
          r.rolcreatedb ||
          r.rolcreaterole ||
          r.rolreplication ||
          r.rolbypassrls ||
          r.member,
      )
    )
      throw Error('Existing restricted roles required');
    if (
      !(
        await client.query(
          "SELECT has_function_privilege(current_user,'pg_catalog.pg_control_system()','EXECUTE') allowed",
        )
      ).rows[0].allowed
    )
      throw Error('Operator cannot read database identity');
    // Hash only pre-upgrade columns so the additive NULL column does not hide a data change.
    const columns = {};
    for (const table of tables.filter((t) => t !== 'schema_migrations'))
      columns[table] = (
        await client.query(
          'SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position',
          [schema, table],
        )
      ).rows.map((r) => r.column_name);
    const snapshot = async () => {
      const result = {};
      for (const [table, fields] of Object.entries(columns))
        result[table] = (
          await client.query(
            `SELECT count(*)::text count,md5(COALESCE(string_agg(h,'' ORDER BY h),'')) hash FROM
        (SELECT md5(row_to_json(v)::text) h FROM (SELECT ${fields.map(id).join(',')} FROM ${ns}.${id(table)}) v) t`,
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
      return JSON.stringify(result);
    };
    const before = await snapshot();
    if (mode === 'apply') {
      for (const entry of expected.slice(20)) {
        await client.query(await readFile(join(dir, entry.version), 'utf8'));
        await client.query(
          'INSERT INTO schema_migrations(scope,version,checksum) VALUES($1,$2,$3)',
          [entry.scope, entry.version, entry.checksum],
        );
      }
      await client.query(
        `GRANT SELECT,INSERT,UPDATE ON ${ns}.terminal_presence TO ${id(runtimeRole)}`,
      );
      await client.query(`GRANT SELECT ON ${ns}.terminal_presence TO ${id(deviceRole)}`);
      for (const role of [runtimeRole, workerRole])
        for (const fn of ['fulfillment_display_allocate(uuid)', 'edge_restore_fence(boolean)'])
          await client.query(`GRANT EXECUTE ON FUNCTION ${ns}.${fn} TO ${id(role)}`);
      if ((await snapshot()) !== before)
        throw Error('Existing data, sequences or privileges changed');
      const epochs = (
        await client.query(
          'SELECT epoch,reason,sequence_gap::text FROM edge_database_epochs ORDER BY epoch',
        )
      ).rows;
      if (
        JSON.stringify(epochs) !==
        JSON.stringify([{ epoch: 1, reason: 'initial', sequence_gap: '0' }])
      )
        throw Error('Unexpected restore fencing');
      if ((await client.query('SELECT count(*)::int n FROM terminal_presence')).rows[0].n !== 0)
        throw Error('Presence unexpectedly populated');
    }
    await client.query(mode === 'apply' ? 'COMMIT' : 'ROLLBACK');
    return {
      mode,
      migrations: mode === 'apply' ? 23 : 20,
      dataPreserved: true,
      existingPrivilegesPreserved: true,
      fingerprint: hash(before),
      ledger: mode === 'apply' ? expected : ledger,
    };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  }
}

async function main() {
  const [mode, toolsRoot, appRoot, branchId, ...extra] = process.argv.slice(2);
  if (extra.length || !toolsRoot || !appRoot || !/^[a-f0-9-]{36}$/.test(branchId ?? ''))
    throw Error('Invalid invocation');
  const url = new URL(process.env.EDGE_DATABASE_URL ?? '');
  if (
    url.hostname !== '127.0.0.1' ||
    url.port !== '55433' ||
    url.pathname !== '/pickchick_edge' ||
    url.username !== 'pickchick_edge_owner'
  )
    throw Error('Local edge owner required');
  const { Client } = createRequire(join(resolve(toolsRoot), 'package.json'))('pg');
  const c = new Client({
    connectionString: url.href,
    connectionTimeoutMillis: 3000,
    statement_timeout: 60000,
  });
  c.on('error', () => {});
  await c.connect();
  try {
    console.log(JSON.stringify(await upgradeRuntimeSchema(c, { mode, appRoot, branchId })));
  } finally {
    await c.end();
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(() => {
    console.error('Runtime schema upgrade stopped; inspect protected evidence.');
    process.exitCode = 1;
  });
