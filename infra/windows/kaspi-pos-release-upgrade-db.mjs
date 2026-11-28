import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KASPI_POS_MIGRATION, KASPI_POS_SHA256, operatorMessage } from './kaspi-pos-upgrade-db.mjs';
import {
  KASPI_POS_RELEASE_TABLES,
  MIGRATION,
  assertKaspiPosReleaseRuntimePrivileges,
  kaspiPosReleaseRuntimeGrantSql,
} from './kaspi-pos-release-grants.mjs';
import { KASPI_POS_TABLES, assertKaspiPosRuntimePrivileges } from './kaspi-pos-grants.mjs';

/**
 * Edge schema029 -> 030 (audit 28.11 P0-1, CR pos-8: a sale paid on the Kaspi terminal is made on a
 * closed branch, and a payment without an order is released by the shift manager). Run by the
 * edge owner with every edge service stopped and a fresh verified schema029 backup (the backup
 * tool of this release already knows schema030). `inspect` changes nothing; `apply` adds exactly
 * the reviewed 030 bytes and its ledger row in one transaction, grants the runtime its reviewed 030
 * privileges (SELECT and INSERT on the releases table, when its role is installed) in that same
 * transaction, proves them and the unchanged 029 privileges again, and proves that the row count of
 * every existing table is unchanged and the new table is empty. A second `apply` refuses; `inspect`
 * on an upgraded edge reports it installed and proves both privilege sets.
 *
 * Both modes report the paid terminal payments that have no order yet (state success, no order).
 * After 030 they block closing the sales shift of their own desk until they are sold or released
 * with the shift manager's PIN (docs/collaboration/cutover-cr/pos-8.md, section 4.1): this is a
 * warning to the operator, not a refusal.
 *
 * Rollback: a previous runtime never names the new table and keeps working on 030; the schema
 * itself is not rolled back (restore the schema029 copy taken before the window).
 */
export const KASPI_POS_RELEASE_MIGRATION = MIGRATION;
/** SHA-256 of the reviewed 030; any other 030 bytes are refused. */
export const KASPI_POS_RELEASE_SHA256 =
  '5dfc739e56991d170624b47eb4ac2d6846e598ac14fe8a23703fca191018022a';
const PREVIOUS_LENGTH = 29;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const refused = (message) => Object.assign(new Error(message), { refusal: true });
const identifier = (value) => {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(value))
    throw refused('Invalid identifier');
  return '"' + value + '"';
};
export { operatorMessage };

/** The operator-facing warning for paid terminal payments without an order, or null when none. */
export function unsoldPaymentsWarning(unsold) {
  if (!unsold || unsold.count === 0) return null;
  return (
    `${unsold.count} paid Kaspi terminal payment(s) without an order, ${unsold.amountMinor} minor units: ` +
    'with migration030 they block closing the sales shift of their desk until they are sold or ' +
    "released with the shift manager's PIN"
  );
}

export async function kaspiPosReleaseMigration(
  client,
  { mode, appRoot, branchId, schema = 'public', runtimeRole = 'pickchick_edge_runtime' },
) {
  if (!['inspect', 'apply'].includes(mode)) throw refused('Invalid mode');
  const ns = identifier(schema);
  identifier(runtimeRole);
  const pinned = JSON.parse(
    await readFile(join(appRoot, 'infra/windows/native-edge-backup-ledger.json'), 'utf8'),
  );
  const file = await readFile(join(appRoot, 'db/edge/migrations', KASPI_POS_RELEASE_MIGRATION));
  // The pinned file may carry later reviewed rows: this tool takes its first 30 rows, and the 029
  // row of them must be the one the 029 tool reviewed.
  if (
    digest(file) !== KASPI_POS_RELEASE_SHA256 ||
    !Array.isArray(pinned) ||
    pinned.length < PREVIOUS_LENGTH + 1 ||
    pinned[PREVIOUS_LENGTH - 1].version !== KASPI_POS_MIGRATION ||
    pinned[PREVIOUS_LENGTH - 1].checksum !== KASPI_POS_SHA256 ||
    pinned[PREVIOUS_LENGTH].version !== KASPI_POS_RELEASE_MIGRATION ||
    pinned[PREVIOUS_LENGTH].checksum !== KASPI_POS_RELEASE_SHA256
  )
    throw refused('Expected the reviewed migration030 and its ledger');
  const expected = pinned.slice(0, PREVIOUS_LENGTH + 1);
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query('SET LOCAL search_path TO ' + ns);
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('pickchick-kaspi-pos-release-030',0))",
    );
    const others = (
      await client.query(
        `SELECT DISTINCT usename::text AS role FROM pg_stat_activity
         WHERE datname=current_database() AND pid<>pg_backend_pid()
           AND backend_type='client backend' AND usename IS DISTINCT FROM current_user ORDER BY 1`,
      )
    ).rows;
    if (others.length) throw refused('Edge services must be stopped');
    const branches = (await client.query('SELECT id FROM branch_config')).rows;
    if (branches.length !== 1 || branches[0].id !== branchId) throw refused('Branch differs');
    const ledger = (
      await client.query('SELECT scope,version,checksum FROM schema_migrations ORDER BY version')
    ).rows.map(({ scope, version, checksum }) => ({ version, checksum, scope }));
    // Already on the reviewed 030 (later reviewed migrations may follow): inspect verifies it.
    const installed =
      JSON.stringify(ledger.slice(0, PREVIOUS_LENGTH + 1)) === JSON.stringify(expected);
    if (installed) {
      if (mode === 'apply') throw refused('Migration030 is already applied; nothing changed');
    } else if (JSON.stringify(ledger) !== JSON.stringify(expected.slice(0, PREVIOUS_LENGTH)))
      throw refused('Expected unchanged schema029 and only reviewed migration030');
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
    const counts = async (names) => {
      const result = {};
      for (const name of names)
        result[name] = (
          await client.query(`SELECT count(*)::text AS n FROM ${ns}.${identifier(name)}`)
        ).rows[0].n;
      return result;
    };
    // Paid and not yet sold: after 030 these hold the shift close of their desk. On an upgraded
    // edge the released ones no longer do.
    const unsoldRow = (
      await client.query(
        `SELECT count(*)::text AS n, coalesce(sum(a.amount_minor),0)::text AS amount
           FROM ${ns}.kaspi_pos_attempts a WHERE a.state='success' AND a.order_id IS NULL` +
          (installed
            ? ` AND NOT EXISTS(SELECT 1 FROM ${ns}.${identifier(KASPI_POS_RELEASE_TABLES[0])} r
                 WHERE r.attempt_id=a.id)`
            : ''),
      )
    ).rows[0];
    const unsoldPayments = { count: Number(unsoldRow.n), amountMinor: unsoldRow.amount };
    const before = await counts(tables.filter((t) => t !== 'schema_migrations'));
    const runtime =
      (await client.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [runtimeRole])).rowCount === 1;
    if (!installed) {
      if (tables.some((t) => KASPI_POS_RELEASE_TABLES.includes(t)))
        throw refused('Kaspi POS release objects already exist');
      if (!KASPI_POS_TABLES.every((t) => tables.includes(t)))
        throw refused('Kaspi POS 029 tables are missing');
      await client.query(file.toString('utf8'));
      await client.query('INSERT INTO schema_migrations(scope,version,checksum) VALUES($1,$2,$3)', [
        'edge',
        KASPI_POS_RELEASE_MIGRATION,
        KASPI_POS_RELEASE_SHA256,
      ]);
      if (runtime) await client.query(kaspiPosReleaseRuntimeGrantSql(runtimeRole, schema));
    }
    const after = await counts(tables.filter((t) => t !== 'schema_migrations'));
    if (JSON.stringify(after) !== JSON.stringify(before))
      throw refused('Data changed during migration');
    const added = await counts(KASPI_POS_RELEASE_TABLES);
    const releases = Number(added.kaspi_pos_attempt_releases);
    if (!installed && releases !== 0) throw refused('New Kaspi POS release table must be empty');
    // The runtime role is proven for both reviewed sets: 030 (just granted) and 029 (untouched).
    // Before 030 only the 029 set exists to prove.
    if (runtime) {
      await assertKaspiPosRuntimePrivileges(client, runtimeRole, schema);
      if (installed || mode === 'apply')
        await assertKaspiPosReleaseRuntimePrivileges(client, runtimeRole, schema);
    }
    await client.query(mode === 'apply' ? 'COMMIT' : 'ROLLBACK');
    return {
      mode,
      migration: KASPI_POS_RELEASE_MIGRATION,
      migrations: installed
        ? ledger.length
        : mode === 'apply'
          ? PREVIOUS_LENGTH + 1
          : ledger.length,
      applied: mode === 'apply',
      alreadyInstalled: installed,
      runtimeRolePresent: runtime,
      runtimeGrantsVerified: runtime && (installed || mode === 'apply'),
      releases,
      unsoldPayments,
      unsoldPaymentsWarning: unsoldPaymentsWarning(unsoldPayments),
      dataPreserved: true,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

async function main() {
  const [mode, toolsRoot, appRoot, branchId, ...extra] = process.argv.slice(2);
  if (
    !['inspect', 'apply'].includes(mode ?? '') ||
    extra.length ||
    !toolsRoot ||
    !appRoot ||
    !/^[a-f0-9-]{36}$/.test(branchId ?? '')
  )
    throw refused('Invalid Kaspi POS release migration invocation');
  const url = new URL(process.env.EDGE_DATABASE_URL ?? '');
  if (
    url.hostname !== '127.0.0.1' ||
    url.port !== '55433' ||
    url.pathname !== '/pickchick_edge' ||
    url.username !== 'pickchick_edge_owner'
  )
    throw refused('Expected local edge owner');
  const { Client } = createRequire(join(resolve(toolsRoot), 'package.json'))('pg');
  const client = new Client({
    connectionString: url.href,
    connectionTimeoutMillis: 3000,
    statement_timeout: 120000,
  });
  client.on('error', () => {});
  await client.connect();
  try {
    const result = await kaspiPosReleaseMigration(client, { mode, appRoot, branchId });
    if (result.unsoldPaymentsWarning) console.error('WARNING: ' + result.unsoldPaymentsWarning);
    console.log(JSON.stringify(result));
  } finally {
    await client.end();
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    const reason = operatorMessage(error);
    console.error(
      `Kaspi POS release migration stopped${reason ? ': ' + reason : ''}; inspect protected state.`,
    );
    process.exitCode = 1;
  });
