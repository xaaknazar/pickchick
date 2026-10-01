import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [mode, toolsRoot, appRoot, branchId, ...extra] = process.argv.slice(2);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const identifier = (name) => '"' + name.replaceAll('"', '""') + '"';
async function main() {
  if (
    !['inspect', 'apply'].includes(mode) ||
    extra.length ||
    !toolsRoot ||
    !appRoot ||
    !/^[a-f0-9-]{36}$/.test(branchId ?? '')
  )
    throw Error('Invalid reservation migration invocation');
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
    console.log(JSON.stringify(await grantStopAvailability(client, { mode, appRoot, branchId })));
  } finally {
    await client.end();
  }
}

export async function grantStopAvailability(
  client,
  { mode, appRoot, branchId, schema = 'public', role = 'pickchick_fulfillment_sync' },
) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(role) || !['inspect', 'apply'].includes(mode))
    throw Error('Invalid mode');
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('pickchick-stop-availability-015',0))",
    );
    const tables = (
      await client.query('SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename', [
        schema,
      ])
    ).rows.map((r) => r.tablename);
    await client.query(
      'LOCK TABLE ' +
        tables.map((n) => identifier(schema) + '.' + identifier(n)).join(',') +
        ' IN ACCESS EXCLUSIVE MODE',
    );
    const ledger = (
      await client.query('SELECT scope,version,checksum FROM schema_migrations ORDER BY version')
    ).rows;
    const dir = join(appRoot, 'db/edge/migrations');
    const names = (await readdir(dir)).filter((n) => n.endsWith('.sql')).sort();
    const expected = [];
    for (const name of names)
      expected.push({
        scope: 'edge',
        version: name,
        checksum: digest(await readFile(join(dir, name))),
      });
    if (
      expected.length !== 15 ||
      names[14] !== '015_edge_reserved_order_number.sql' ||
      JSON.stringify(ledger) !== JSON.stringify(expected)
    )
      throw Error('Expected unchanged schema015');
    const branches = (await client.query('SELECT id FROM branch_config')).rows;
    if (branches.length !== 1 || branches[0].id !== branchId) throw Error('Branch differs');
    const snapshot = async () => {
      const result = {};
      for (const table of tables) {
        result[table] = (
          await client.query(
            `SELECT count(*)::text AS count, md5(COALESCE(string_agg(h,'' ORDER BY h),'')) AS hash FROM (SELECT md5(to_jsonb(t)::text) h FROM ${identifier(schema)}.${identifier(table)} t) r`,
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
          "SELECT relname,relacl FROM pg_class WHERE relnamespace=$1::regnamespace AND relkind IN ('r','S') ORDER BY relname",
          [schema],
        )
      ).rows;
      return JSON.stringify(result);
    };
    const before = await snapshot();
    if (mode === 'apply') {
      const allowed = {
        local_stops: ['branch_id', 'variant_id', 'stopped', 'expires_at', 'expires_shift_id'],
        local_cash_shifts: ['id', 'state'],
      };
      const acl = async () =>
        (
          await client.query(
            `SELECT c.relname,a.attname,r.rolname,x.privilege_type,x.is_grantable FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid CROSS JOIN LATERAL aclexplode(a.attacl) x JOIN pg_roles r ON r.oid=x.grantee WHERE c.relnamespace=$1::regnamespace AND a.attnum>0 ORDER BY c.relname,a.attname,r.rolname,x.privilege_type`,
            [schema],
          )
        ).rows;
      const beforeAcl = await acl();
      const additions = Object.entries(allowed).flatMap(([table, columns]) =>
        columns.map((column) => ({
          relname: table,
          attname: column,
          rolname: role,
          privilege_type: 'SELECT',
          is_grantable: false,
        })),
      );
      for (const [table, columns] of Object.entries(allowed))
        await client.query(
          `GRANT SELECT(${columns.map(identifier).join(',')}) ON ${identifier(schema)}.${identifier(table)} TO ${identifier(role)}`,
        );
      const normalize = (rows) => [...new Set(rows.map((r) => JSON.stringify(r)))].sort();
      if (
        JSON.stringify(normalize(await acl())) !==
        JSON.stringify(normalize([...beforeAcl, ...additions]))
      )
        throw Error('Unexpected column ACL delta');
      if ((await snapshot()) !== before)
        throw Error('Existing data, sequence or table permission changed');
    }
    await client.query(mode === 'apply' ? 'COMMIT' : 'ROLLBACK');
    return {
      mode,
      migrations: 15,
      dataPreserved: true,
      fingerprint: digest(before),
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(() => {
    console.error('Stop availability grant stopped; inspect protected state.');
    process.exitCode = 1;
  });
