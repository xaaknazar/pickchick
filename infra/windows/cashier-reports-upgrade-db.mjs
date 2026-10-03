import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fulfillmentWorkerGrants } from './fulfillment-worker-grants.mjs';

const hash = (v) => createHash('sha256').update(v).digest('hex');
const ident = (v) => {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(v)) throw Error('Invalid identifier');
  return '"' + v + '"';
};

/** Atomic additive migration. No business row restore, no credential or service changes. */
export async function upgradeCashierReports(
  client,
  {
    mode,
    appRoot,
    branchId,
    schema = 'public',
    posRole = 'pickchick_edge_runtime',
    workerRole = 'pickchick_fulfillment_worker',
  },
) {
  if (!['inspect', 'apply'].includes(mode) || !/^[a-f0-9-]{36}$/i.test(branchId))
    throw Error('Invalid upgrade scope');
  const ns = ident(schema),
    pos = ident(posRole);
  ident(workerRole);
  if (posRole === workerRole) throw Error('Separate runtime roles required');
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query('SET LOCAL search_path TO ' + ns);
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('pickchick-cashier-reports-016',0))",
    );
    const dir = join(appRoot, 'db/edge/migrations');
    const names = (await readdir(dir)).filter((n) => n.endsWith('.sql')).sort();
    if (
      names.length !== 16 ||
      names[15] !== '016_edge_cashier_reports.sql' ||
      names.some((n, i) => !n.startsWith(String(i + 1).padStart(3, '0') + '_'))
    )
      throw Error('Expected reviewed migrations 001-016');
    const expected = await Promise.all(
      names.map(async (version) => ({
        scope: 'edge',
        version,
        checksum: hash(await readFile(join(dir, version))),
      })),
    );
    const tables = (
      await client.query('SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename', [
        schema,
      ])
    ).rows.map((r) => r.tablename);
    if (!tables.length) throw Error('Missing edge schema');
    await client.query(
      'LOCK TABLE ' +
        tables.map((t) => ns + '.' + ident(t)).join(',') +
        ' IN ACCESS EXCLUSIVE MODE',
    );
    const ledger = (
      await client.query('SELECT scope,version,checksum FROM schema_migrations ORDER BY version')
    ).rows;
    if (
      ![15, 16].includes(ledger.length) ||
      JSON.stringify(ledger) !== JSON.stringify(expected.slice(0, ledger.length))
    )
      throw Error('Migration ledger differs');
    const branches = (await client.query('SELECT id FROM branch_config')).rows;
    if (branches.length !== 1 || branches[0].id !== branchId) throw Error('Branch differs');
    const roles = (
      await client.query(
        'SELECT rolname,rolsuper,rolcreaterole,rolcreatedb,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=ANY($1)',
        [[posRole, workerRole]],
      )
    ).rows;
    if (
      roles.length !== 2 ||
      roles.some(
        (r) => r.rolsuper || r.rolcreaterole || r.rolcreatedb || r.rolreplication || r.rolbypassrls,
      )
    )
      throw Error('Restricted existing roles required');
    const legacy = tables.filter(
      (t) => !['schema_migrations', 'cashier_report_outbox'].includes(t),
    );
    const snapshot = async () => {
      const rows = {};
      for (const t of legacy)
        rows[t] = (
          await client.query(
            `SELECT count(*)::text count,md5(COALESCE(string_agg(h,'' ORDER BY h),'')) hash FROM (SELECT md5(to_jsonb(t)::text) h FROM ${ns}.${ident(t)} t) r`,
          )
        ).rows[0];
      rows.sequences = (
        await client.query(
          "SELECT sequencename,last_value FROM pg_sequences WHERE schemaname=$1 AND sequencename <> 'cashier_report_outbox_sequence_seq' ORDER BY sequencename",
          [schema],
        )
      ).rows;
      return JSON.stringify(rows);
    };
    const before = await snapshot();
    const resumed = ledger.length === 16;
    if (mode === 'apply') {
      if (!resumed) {
        await client.query(await readFile(join(dir, names[15]), 'utf8'));
        await client.query(
          'INSERT INTO schema_migrations(scope,version,checksum) VALUES($1,$2,$3)',
          ['edge', names[15], expected[15].checksum],
        );
      }
      // Keep these grants on rollback: old POS still executes schema016 invoker triggers.
      await client.query(
        `GRANT INSERT ON ${ns}.cashier_report_outbox TO ${pos}; GRANT USAGE ON SEQUENCE ${ns}.cashier_report_outbox_sequence_seq TO ${pos};`,
      );
      await client.query(fulfillmentWorkerGrants(workerRole, schema));
      if ((await snapshot()) !== before) throw Error('Existing business rows or sequence changed');
      const forbidden = (
        await client.query(
          `SELECT has_table_privilege($1,'local_cash_movements','INSERT') movement_write,has_table_privilege($1,'local_staff_pins','SELECT') pin_read,has_table_privilege($1,'local_orders','UPDATE') order_write,has_table_privilege($2,'cashier_report_outbox','DELETE') report_delete`,
          [workerRole, posRole],
        )
      ).rows[0];
      if (Object.values(forbidden).some(Boolean))
        throw Error('Runtime authority exceeds report scope');
    }
    const result = {
      mode,
      resumed,
      migrations: mode === 'apply' ? 16 : ledger.length,
      existingDataPreserved: true,
      fingerprint: hash(before),
    };
    await client.query(mode === 'apply' ? 'COMMIT' : 'ROLLBACK');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  }
}

async function main() {
  const [mode, toolsRoot, appRoot, branchId, ...extra] = process.argv.slice(2);
  if (extra.length || !toolsRoot || !appRoot) throw Error('Invalid invocation');
  const url = new URL(process.env.EDGE_DATABASE_URL ?? '');
  if (
    url.protocol !== 'postgresql:' ||
    url.hostname !== '127.0.0.1' ||
    url.port !== '55433' ||
    url.pathname !== '/pickchick_edge' ||
    url.username !== 'pickchick_edge_owner' ||
    !url.password ||
    url.search ||
    url.hash ||
    process.env.EDGE_BRANCH_ID !== branchId
  )
    throw Error('Protected local owner environment required');
  const { Client } = createRequire(join(resolve(toolsRoot), 'package.json'))('pg');
  const client = new Client({
    connectionString: url.href,
    connectionTimeoutMillis: 3000,
    statement_timeout: 60000,
  });
  client.on('error', () => {});
  try {
    await client.connect();
    console.log(JSON.stringify(await upgradeCashierReports(client, { mode, appRoot, branchId })));
  } finally {
    await client.end();
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(() => {
    console.error('Cashier report upgrade stopped; inspect protected state.');
    process.exitCode = 1;
  });
