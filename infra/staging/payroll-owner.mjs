/** Exact schema052 -> 057. Prerequisite channel schemas remain dormant; no grants or flags. */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fingerprint, runtimePrivileges, OwnerGuardError } from './unified-menu-owner.mjs';
export const MIGRATIONS = [
  '053_cloud_channel_numbers.sql',
  '054_cloud_kitchen_fulfillment.sql',
  '055_cloud_channel_stops.sql',
  '056_cloud_kitchen_screens.sql',
  '057_cloud_workforce_payroll.sql',
];
const hash = (s) => createHash('sha256').update(s).digest('hex');
const guard = (ok, message) => {
  if (!ok) throw new OwnerGuardError(message);
};
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
async function columns(c) {
  return Object.fromEntries(
    (
      await c.query(
        `SELECT c.relname AS name,array_agg(a.attname::text ORDER BY a.attnum) AS columns FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped WHERE n.nspname=current_schema() AND c.relkind IN ('r','p') GROUP BY c.relname ORDER BY c.relname`,
      )
    ).rows.map((r) => [r.name, r.columns]),
  );
}
export async function deployPayroll(c, { directory, role, inspect = false }) {
  guard(/^[a-z][a-z0-9_]{0,62}$/.test(role), 'Invalid runtime role');
  await c.query("SET LOCAL lock_timeout='5s';SET LOCAL statement_timeout='120s'");
  if (!inspect) await c.query('SELECT pg_advisory_xact_lock($1)', [724001]);
  const files = (await readdir(directory)).filter((n) => /^\d{3}_[a-z0-9_]+\.sql$/.test(n)).sort();
  guard(equal(files.slice(-5), MIGRATIONS), 'Candidate must end at schema057');
  guard(
    equal(
      files.slice(0, -5).map((n) => +n.slice(0, 3)),
      [
        ...Array.from({ length: 40 }, (_, i) => i + 1),
        ...Array.from({ length: 11 }, (_, i) => i + 42),
      ],
    ),
    'Exact schema052 baseline required',
  );
  const sql = new Map(
    await Promise.all(files.map(async (n) => [n, await readFile(join(directory, n), 'utf8')])),
  );
  const ledger = (
    await c.query('SELECT version,checksum,scope FROM schema_migrations ORDER BY version')
  ).rows;
  guard(
    ledger.length === files.length - 5 &&
      ledger.every(
        (r, i) =>
          r.version === files[i] && r.scope === 'cloud' && r.checksum === hash(sql.get(r.version)),
      ),
    'Exact schema052 ledger required; no partial replay',
  );
  if (inspect) return { pending: MIGRATIONS, privilegesAdded: [] };
  const before = await columns(c),
    existing = Object.fromEntries(
      Object.entries(before).filter(([n]) => n !== 'schema_migrations'),
    );
  const data = await fingerprint(c, existing),
    acl = await runtimePrivileges(c, role);
  const roles = async () =>
    (
      await c.query(
        'SELECT rolname,rolsuper,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls,rolconfig FROM pg_roles ORDER BY rolname',
      )
    ).rows;
  const rolesBefore = await roles();
  const tables = MIGRATIONS.flatMap((n) =>
    [...sql.get(n).matchAll(/^CREATE TABLE ([a-z_]+) /gm)].map((m) => m[1]),
  ).sort();
  guard(
    tables.every((t) => !(t in before)),
    'Prerequisite tables already exist',
  );
  const appended = [];
  for (const name of MIGRATIONS) {
    await c.query(sql.get(name));
    const row = { version: name, checksum: hash(sql.get(name)), scope: 'cloud' };
    await c.query('INSERT INTO schema_migrations(version,checksum,scope) VALUES($1,$2,$3)', [
      row.version,
      row.checksum,
      row.scope,
    ]);
    appended.push(row);
  }
  const after = await columns(c);
  guard(
    equal(Object.keys(after).sort(), [...Object.keys(before), ...tables].sort()),
    'Unexpected table delta',
  );
  for (const [table, cols] of Object.entries(before))
    guard(
      equal(after[table], table === 'cloud_stop_commands' ? [...cols, 'delivery_policy'] : cols),
      'Unexpected column delta',
    );
  guard(equal(await fingerprint(c, existing), data), 'Existing rows changed');
  guard(equal(await runtimePrivileges(c, role), acl), 'Runtime grants changed');
  guard(equal(await roles(), rolesBefore), 'Roles changed');
  guard(
    equal(
      (await c.query('SELECT version,checksum,scope FROM schema_migrations ORDER BY version')).rows,
      [...ledger, ...appended],
    ),
    'Ledger changed',
  );
  for (const t of tables) {
    guard(
      (await c.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n ===
        (t === 'channel_number_ranges' ? 2 : 0),
      'New channels must remain dormant',
    );
  }
  guard(
    (
      await c.query(
        "SELECT count(*)::int AS n FROM cloud_stop_commands WHERE delivery_policy<>'ttl'",
      )
    ).rows[0].n === 0,
    'Existing stop policy changed',
  );
  return {
    applied: MIGRATIONS,
    existingDataPreserved: true,
    privilegesAdded: [],
    privilegesRemoved: [],
    channelsDormant: true,
  };
}
async function main(argv) {
  guard(argv.length === 1 && ['inspect', 'deploy'].includes(argv[0]), 'Use inspect|deploy');
  const url = new URL(process.env.CLOUD_DATABASE_URL ?? '');
  guard(
    url.username === 'pickchick_owner' && url.pathname === '/pickchick_cloud',
    'Owner database required',
  );
  const { createPool } = await import('@pickchick/database');
  const pool = createPool(url.href),
    c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const result = await deployPayroll(c, {
      directory: fileURLToPath(new URL('../../db/cloud/migrations/', import.meta.url)),
      role: 'pickchick_app',
      inspect: argv[0] === 'inspect',
    });
    await c.query(argv[0] === 'inspect' ? 'ROLLBACK' : 'COMMIT');
    console.log(JSON.stringify(result));
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
    await pool.end();
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  main(process.argv.slice(2)).catch((e) => {
    console.error(
      e instanceof OwnerGuardError ? e.message : `Payroll owner failed (${e?.code ?? 'error'})`,
    );
    process.exitCode = 1;
  });
