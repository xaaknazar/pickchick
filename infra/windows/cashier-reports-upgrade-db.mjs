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

export const CASHIER_REPORTS_MIGRATION = '016_edge_cashier_reports.sql';
/** Ledger length after the cashier-report migration (edge schema016). */
const CASHIER_REPORTS_LEDGER_LENGTH = 16;
const migrationName = /^\d{3}_[a-z0-9_]+\.sql$/;
const ordinal = (index) => String(index + 1).padStart(3, '0') + '_';
const ledgerText = (rows) =>
  JSON.stringify(
    rows.map((row) => ({ scope: row.scope, version: row.version, checksum: row.checksum })),
  );

/**
 * The reviewed edge ledger 001-016 this upgrade needs, taken from the pinned shared ledger
 * (native-edge-backup-ledger.json: migration file name, SHA-256 and scope) after validating
 * its shape. Pinned entries after 016 are not part of this upgrade.
 */
export function reviewedCashierLedger(pinned) {
  if (
    !Array.isArray(pinned) ||
    pinned.length < CASHIER_REPORTS_LEDGER_LENGTH ||
    pinned.some(
      (row, index) =>
        !row ||
        typeof row !== 'object' ||
        Object.keys(row).sort().join(',') !== 'checksum,scope,version' ||
        row.scope !== 'edge' ||
        typeof row.version !== 'string' ||
        !migrationName.test(row.version) ||
        !row.version.startsWith(ordinal(index)) ||
        typeof row.checksum !== 'string' ||
        !/^[a-f0-9]{64}$/.test(row.checksum),
    ) ||
    pinned[CASHIER_REPORTS_LEDGER_LENGTH - 1].version !== CASHIER_REPORTS_MIGRATION
  )
    throw Error('Pinned edge migration ledger is invalid');
  return pinned
    .slice(0, CASHIER_REPORTS_LEDGER_LENGTH)
    .map(({ scope, version, checksum }) => ({ scope, version, checksum }));
}

/**
 * Candidate edge migrations 001-016 in ledger form, each equal by file name and SHA-256 to the
 * pinned reviewed ledger, plus the exact bytes of 016 that apply executes. Later migration files
 * of a newer candidate (017 and up) may be present: they must be well named and continue the
 * sequence without gaps, and they are never read or applied by this upgrade.
 */
export async function readCashierReportMigrations(appRoot) {
  const expected = reviewedCashierLedger(
    JSON.parse(
      await readFile(new URL('./native-edge-backup-ledger.json', import.meta.url), 'utf8'),
    ),
  );
  const dir = join(appRoot, 'db', 'edge', 'migrations');
  const names = (await readdir(dir)).filter((n) => n.endsWith('.sql')).sort();
  if (
    names.length < CASHIER_REPORTS_LEDGER_LENGTH ||
    names.some((name, index) => !migrationName.test(name) || !name.startsWith(ordinal(index)))
  )
    throw Error('Expected reviewed migrations 001-016');
  const files = await Promise.all(
    names.slice(0, CASHIER_REPORTS_LEDGER_LENGTH).map((name) => readFile(join(dir, name))),
  );
  const found = files.map((bytes, index) => ({
    scope: 'edge',
    version: names[index],
    checksum: hash(bytes),
  }));
  if (ledgerText(found) !== ledgerText(expected))
    throw Error('Expected reviewed migrations 001-016');
  return { expected, migrationSql: files[CASHIER_REPORTS_LEDGER_LENGTH - 1].toString('utf8') };
}

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
  const { expected, migrationSql } = await readCashierReportMigrations(appRoot);
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query('SET LOCAL search_path TO ' + ns);
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('pickchick-cashier-reports-016',0))",
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
    // Exactly the reviewed 001-015 or 001-016 prefix; a later candidate migration in the
    // database ledger means this upgrade is not the reviewed next step.
    if (
      ![CASHIER_REPORTS_LEDGER_LENGTH - 1, CASHIER_REPORTS_LEDGER_LENGTH].includes(ledger.length) ||
      ledgerText(ledger) !== ledgerText(expected.slice(0, ledger.length))
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
    const resumed = ledger.length === CASHIER_REPORTS_LEDGER_LENGTH;
    if (mode === 'apply') {
      if (!resumed) {
        // Only 016, from the bytes checked against the pinned ledger; later files never run here.
        await client.query(migrationSql);
        await client.query(
          'INSERT INTO schema_migrations(scope,version,checksum) VALUES($1,$2,$3)',
          ['edge', CASHIER_REPORTS_MIGRATION, expected[CASHIER_REPORTS_LEDGER_LENGTH - 1].checksum],
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
      migrations: mode === 'apply' ? CASHIER_REPORTS_LEDGER_LENGTH : ledger.length,
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
