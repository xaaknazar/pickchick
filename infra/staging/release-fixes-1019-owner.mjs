/**
 * Exact cloud baseline -> 064, 066, 068 (release fixes 2026-10-19, README step 1).
 * The baseline is every other reviewed cloud file, 060 included: apply 060 first by its own
 * release (docs/operations/mobile-combo-rewards.md). Only identity_otp_failures is granted, and
 * only when customer login grants are already on; edge identity rotation stays revoked (066 flag
 * off, provision.mjs grants it when CLOUD_EDGE_IDENTITY_ROTATION_ENABLED=true).
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fingerprint, runtimePrivileges, OwnerGuardError } from './unified-menu-owner.mjs';
export const MIGRATIONS = [
  '064_cloud_cashier_ordering_state.sql',
  '066_cloud_edge_identity_rotation.sql',
  '068_cloud_identity_abuse_limits.sql',
];
export const TABLES = ['device_identity_rotations', 'identity_otp_failures'];
export const COLUMNS = {
  cloud_branch_availability: ['ordering_closed'],
  device_credentials: ['previous_token_hash', 'previous_expires_at'],
  identity_otp_challenges: ['ip_net_hash'],
  identity_sms_daily_budget: ['new_phone_reservations'],
  identity_sessions: ['retired_refresh_hashes'],
};
export const REQUIRED_BASELINE = '060_cloud_combo_rewards.sql';
export const OTP_FAILURE_PRIVILEGES = ['DELETE', 'INSERT', 'SELECT', 'UPDATE'].map(
  (p) => `identity_otp_failures||${p}`,
);
const hash = (s) => createHash('sha256').update(s).digest('hex');
const guard = (ok, message) => {
  if (!ok) throw new OwnerGuardError(message);
};
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export async function deployReleaseFixes(c, { directory, role, inspect = false }) {
  guard(/^[a-z][a-z0-9_]{0,62}$/.test(role), 'Invalid runtime role');
  await c.query("SET LOCAL lock_timeout='5s';SET LOCAL statement_timeout='300s'");
  if (!inspect) await c.query('SELECT pg_advisory_xact_lock($1)', [724019]);
  const files = (await readdir(directory)).filter((n) => /^\d{3}_[a-z0-9_]+\.sql$/.test(n)).sort();
  const baseline = files.filter((n) => !MIGRATIONS.includes(n));
  guard(
    equal(files.slice(-MIGRATIONS.length), MIGRATIONS) && baseline.at(-1) === REQUIRED_BASELINE,
    'Exact schema060 baseline and 064/066/068 candidate required',
  );
  const sql = new Map(
    await Promise.all(files.map(async (n) => [n, await readFile(join(directory, n), 'utf8')])),
  );
  const ledger = (
    await c.query('SELECT version,checksum,scope FROM schema_migrations ORDER BY version')
  ).rows;
  guard(
    ledger.length === baseline.length &&
      ledger.every(
        (r, i) =>
          r.version === baseline[i] &&
          r.scope === 'cloud' &&
          r.checksum === hash(sql.get(r.version)),
      ),
    'Exact schema060 ledger required; do not replay partial apply',
  );
  const columns = async () =>
    Object.fromEntries(
      (
        await c.query(
          "SELECT c.relname AS name,array_agg(a.attname::text ORDER BY a.attnum) AS columns FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped WHERE n.nspname=current_schema() AND c.relkind IN ('r','p') GROUP BY c.relname ORDER BY c.relname",
        )
      ).rows.map((r) => [r.name, r.columns]),
    );
  const before = await columns(),
    existing = Object.fromEntries(
      Object.entries(before).filter(([n]) => n !== 'schema_migrations'),
    );
  guard(
    TABLES.every((t) => !(t in before)) &&
      Object.entries(COLUMNS).every(
        ([t, cols]) => t in before && cols.every((col) => !before[t].includes(col)),
      ),
    'Release fixes objects already exist or a baseline table is missing',
  );
  const acl = await runtimePrivileges(c, role);
  const customerAuth = acl.includes('identity_customers||SELECT');
  const expected = customerAuth ? OTP_FAILURE_PRIVILEGES : [];
  if (inspect)
    return { pending: MIGRATIONS, privilegesAdded: expected, edgeIdentityRotationEnabled: false };
  const data = await fingerprint(c, existing);
  const roles = async () =>
    (
      await c.query(
        'SELECT rolname,rolsuper,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls,rolconfig FROM pg_roles ORDER BY rolname',
      )
    ).rows;
  const rolesBefore = await roles();
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
  if (customerAuth)
    await c.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON identity_otp_failures TO ${role}`);
  const after = await columns();
  guard(
    equal(Object.keys(after).sort(), [...Object.keys(before), ...TABLES].sort()),
    'Unexpected tables',
  );
  for (const [t, cols] of Object.entries(before))
    guard(equal(after[t], [...cols, ...(COLUMNS[t] ?? [])]), 'Unexpected column change');
  guard(equal(await fingerprint(c, existing), data), 'Existing rows changed');
  guard(equal(await roles(), rolesBefore), 'Role attributes changed');
  guard(
    equal(await runtimePrivileges(c, role), [...new Set([...acl, ...expected])].sort()),
    'Unexpected privilege delta',
  );
  guard(
    equal(
      (await c.query('SELECT version,checksum,scope FROM schema_migrations ORDER BY version')).rows,
      [...ledger, ...appended],
    ),
    'Ledger changed',
  );
  return {
    applied: MIGRATIONS,
    existingDataPreserved: true,
    privilegesAdded: expected,
    privilegesRemoved: [],
    edgeIdentityRotationEnabled: false,
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
    const result = await deployReleaseFixes(c, {
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
      e instanceof OwnerGuardError
        ? `Release fixes owner guard: ${e.message}`
        : 'Release fixes owner transaction failed; inspect state before retry.',
    );
    process.exitCode = 1;
  });
