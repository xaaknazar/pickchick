import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Edge schema021 -> 022 (release fixes 2026-10-19, audit 1.4): cashier display numbers 1-299 per
 * shift. Run by the edge owner with every edge service stopped and a fresh verified backup.
 * `inspect` changes nothing; `apply` adds the migration in one transaction, grants EXECUTE on the
 * allocator to the runtime and transport roles, and proves every existing row, sequence and table
 * privilege unchanged. Rollback: the previous binary keeps working on 022 (it never calls the
 * allocator and still uses the legacy sequence), so no schema rollback is needed.
 */
export const DISPLAY_NUMBERS_MIGRATION = '022_edge_display_numbers.sql';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const identifier = (name) => {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(name ?? '')) throw Error('Invalid identifier');
  return '"' + name + '"';
};

export async function displayNumbersMigration(
  client,
  {
    mode,
    appRoot,
    branchId,
    schema = 'public',
    runtimeRole = 'pickchick_edge_runtime',
    workerRole = 'pickchick_fulfillment_sync',
  },
) {
  if (!['inspect', 'apply'].includes(mode)) throw Error('Invalid mode');
  const ns = identifier(schema);
  identifier(runtimeRole);
  identifier(workerRole);
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query('SET LOCAL search_path TO ' + ns);
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('pickchick-display-numbers-022',0))",
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
    for (const name of names.slice(0, 22))
      expected.push({
        scope: 'edge',
        version: name,
        checksum: digest(await readFile(join(dir, name))),
      });
    if (
      expected.length !== 22 ||
      names[21] !== DISPLAY_NUMBERS_MIGRATION ||
      JSON.stringify(ledger) !== JSON.stringify(expected.slice(0, 21))
    )
      throw Error('Expected unchanged schema021 and only reviewed migration022');
    const branches = (await client.query('SELECT id FROM branch_config')).rows;
    if (branches.length !== 1 || branches[0].id !== branchId) throw Error('Branch differs');
    const snapshot = async () => {
      const result = {};
      for (const table of tables.filter((t) => t !== 'schema_migrations'))
        result[table] = (
          await client.query(
            `SELECT count(*)::text AS count, md5(COALESCE(string_agg(h,'' ORDER BY h),'')) AS hash FROM (SELECT md5(to_jsonb(t)::text) h FROM ${ns}.${identifier(table)} t) r`,
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
    const roles = (
      await client.query('SELECT rolname FROM pg_roles WHERE rolname=ANY($1) ORDER BY rolname', [
        [runtimeRole, workerRole],
      ])
    ).rows.map((r) => r.rolname);
    if (mode === 'apply') {
      await client.query(await readFile(join(dir, DISPLAY_NUMBERS_MIGRATION), 'utf8'));
      await client.query('INSERT INTO schema_migrations(scope,version,checksum) VALUES($1,$2,$3)', [
        'edge',
        DISPLAY_NUMBERS_MIGRATION,
        expected[21].checksum,
      ]);
      for (const role of roles)
        await client.query(
          `GRANT EXECUTE ON FUNCTION ${ns}.fulfillment_display_allocate(uuid) TO ${identifier(role)}`,
        );
      if ((await snapshot()) !== before)
        throw Error('Data, sequence or permission changed during migration');
    }
    await client.query(mode === 'apply' ? 'COMMIT' : 'ROLLBACK');
    return {
      mode,
      migrations: mode === 'apply' ? 22 : 21,
      allocatorGrantedTo: mode === 'apply' ? roles : [],
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
    throw Error('Invalid display number migration invocation');
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
    console.log(JSON.stringify(await displayNumbersMigration(client, { mode, appRoot, branchId })));
  } finally {
    await client.end();
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(() => {
    console.error('Display number migration stopped; inspect protected state.');
    process.exitCode = 1;
  });
