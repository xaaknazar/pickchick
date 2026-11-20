import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  KASPI_POS_TABLES,
  MIGRATION,
  assertKaspiPosRuntimePrivileges,
  kaspiPosRuntimeGrantSql,
} from './kaspi-pos-grants.mjs';

/**
 * Edge schema028 -> 029 (ADR-0017, Kaspi Smart POS adapter). Run by the edge owner with every
 * edge service stopped and a fresh verified schema028 backup (the backup tool of this release
 * already knows schema029). `inspect` changes nothing; `apply` adds exactly the reviewed 029 bytes
 * and its ledger row in one transaction, grants the runtime its reviewed 029 privileges (when its
 * role is installed) and proves them, and proves that the row count of every existing table is
 * unchanged and both new tables are empty. Everything stays off: no cash desk has a terminal
 * until the owner tool scripts/kaspi-terminal-setup.mjs registers one. A second `apply` refuses.
 * Rollback: the previous runtime never names the new relations, so it keeps working on 029.
 */
export const KASPI_POS_MIGRATION = MIGRATION;
/** SHA-256 of the reviewed 029; any other 029 bytes are refused. */
export const KASPI_POS_SHA256 = 'edf0f0cbce196dc6601c5bcb2d9457ac2d43e12a51916d52d5cd6824f5339784';
const PREVIOUS_LENGTH = 28;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const refused = (message) => Object.assign(new Error(message), { refusal: true });
const identifier = (value) => {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(value))
    throw refused('Invalid identifier');
  return '"' + value + '"';
};
export function operatorMessage(error) {
  const message = typeof error?.message === 'string' ? error.message : '';
  if (error?.refusal === true) return message;
  if (/^Kaspi POS [A-Za-z0-9 ,:._-]{3,160}$/.test(message)) return message;
  return '';
}

export async function kaspiPosMigration(
  client,
  { mode, appRoot, branchId, schema = 'public', runtimeRole = 'pickchick_edge_runtime' },
) {
  if (!['inspect', 'apply'].includes(mode)) throw refused('Invalid mode');
  const ns = identifier(schema);
  identifier(runtimeRole);
  const pinned = JSON.parse(
    await readFile(join(appRoot, 'infra/windows/native-edge-backup-ledger.json'), 'utf8'),
  );
  const file = await readFile(join(appRoot, 'db/edge/migrations', KASPI_POS_MIGRATION));
  if (
    digest(file) !== KASPI_POS_SHA256 ||
    pinned.length !== PREVIOUS_LENGTH + 1 ||
    pinned[PREVIOUS_LENGTH].version !== KASPI_POS_MIGRATION ||
    pinned[PREVIOUS_LENGTH].checksum !== KASPI_POS_SHA256
  )
    throw refused('Expected the reviewed migration029 and its ledger');
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query('SET LOCAL search_path TO ' + ns);
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('pickchick-kaspi-pos-029',0))",
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
    const installed =
      ledger.length === PREVIOUS_LENGTH + 1 && JSON.stringify(ledger) === JSON.stringify(pinned);
    if (installed) {
      if (mode === 'apply') throw refused('Migration029 is already applied; nothing changed');
    } else if (JSON.stringify(ledger) !== JSON.stringify(pinned.slice(0, PREVIOUS_LENGTH)))
      throw refused('Expected unchanged schema028 and only reviewed migration029');
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
    const before = await counts(tables.filter((t) => t !== 'schema_migrations'));
    const runtime =
      (await client.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [runtimeRole])).rowCount === 1;
    if (!installed) {
      if (tables.some((t) => KASPI_POS_TABLES.includes(t)))
        throw refused('Kaspi POS objects already exist');
      await client.query(file.toString('utf8'));
      await client.query('INSERT INTO schema_migrations(scope,version,checksum) VALUES($1,$2,$3)', [
        'edge',
        KASPI_POS_MIGRATION,
        KASPI_POS_SHA256,
      ]);
      if (runtime) await client.query(kaspiPosRuntimeGrantSql(runtimeRole, schema));
    }
    const after = await counts(tables.filter((t) => t !== 'schema_migrations'));
    if (JSON.stringify(after) !== JSON.stringify(before))
      throw refused('Data changed during migration');
    const added = await counts(KASPI_POS_TABLES);
    const linked = Number(added.kaspi_pos_devices);
    if (!installed && (linked !== 0 || Number(added.kaspi_pos_attempts) !== 0))
      throw refused('New Kaspi POS tables must be empty');
    if (runtime) await assertKaspiPosRuntimePrivileges(client, runtimeRole, schema);
    await client.query(mode === 'apply' ? 'COMMIT' : 'ROLLBACK');
    return {
      mode,
      migration: KASPI_POS_MIGRATION,
      migrations: installed || mode === 'apply' ? PREVIOUS_LENGTH + 1 : PREVIOUS_LENGTH,
      applied: mode === 'apply',
      alreadyInstalled: installed,
      runtimeRolePresent: runtime,
      linkedTerminals: linked,
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
    throw refused('Invalid Kaspi POS migration invocation');
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
    console.log(JSON.stringify(await kaspiPosMigration(client, { mode, appRoot, branchId })));
  } finally {
    await client.end();
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    const reason = operatorMessage(error);
    console.error(
      `Kaspi POS migration stopped${reason ? ': ' + reason : ''}; inspect protected state.`,
    );
    process.exitCode = 1;
  });
