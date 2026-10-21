/** Exact schema058 -> 060, without activation, backfill or runtime grants. */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deployReleaseFixes } from './release-fixes-1019-owner.mjs';
import { fingerprint, runtimePrivileges, OwnerGuardError } from './unified-menu-owner.mjs';
export const MIGRATION = '060_cloud_combo_rewards.sql';
export const MIGRATION_SHA256 = '378212126f63d22d4da1ab9444b49683cd6e697b9e951e1477adf31ae15404ef';
export const TABLES = [
  'combo_reward_programs',
  'combo_reward_accruals',
  'combo_reward_redemptions',
  'combo_reward_events',
  'commerce_refund_lines',
];
const hash = (s) => createHash('sha256').update(s).digest('hex');
const guard = (ok, reason) => {
  if (!ok) throw new OwnerGuardError(reason);
};
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const numbers = [
  ...Array.from({ length: 40 }, (_, i) => i + 1),
  ...Array.from({ length: 17 }, (_, i) => i + 42),
  60,
  64,
  66,
  68,
];
export async function deployComboRewards(c, { directory, role, inspect = false, enabled = false }) {
  guard(enabled === false, 'Combo rewards must remain disabled');
  guard(/^[a-z][a-z0-9_]{0,62}$/.test(role), 'Invalid runtime role');
  const isolation = (await c.query('SHOW transaction_isolation')).rows[0].transaction_isolation;
  guard(isolation === 'repeatable read', 'Repeatable-read transaction required');
  await c.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='300s'");
  if (!inspect) await c.query('SELECT pg_advisory_xact_lock($1)', [724001]);
  const files = (await readdir(directory)).filter((n) => /^\d{3}_[a-z0-9_]+\.sql$/.test(n)).sort();
  guard(
    equal(
      files.map((n) => +n.slice(0, 3)),
      numbers,
    ),
    'Exact reviewed schema058 through068 files required',
  );
  const sql = new Map(
    await Promise.all(files.map(async (n) => [n, await readFile(join(directory, n), 'utf8')])),
  );
  guard(hash(sql.get(MIGRATION)) === MIGRATION_SHA256, 'Reviewed migration060 checksum required');
  const baseline = files.filter((n) => +n.slice(0, 3) <= 58);
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
    'Exact schema058 ledger required; no replay or partial apply',
  );
  const columns = async () =>
    Object.fromEntries(
      (
        await c.query(
          "SELECT c.relname AS name,array_agg(a.attname::text ORDER BY a.attnum) AS columns FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped WHERE n.nspname=current_schema() AND c.relkind IN ('r','p') GROUP BY c.relname ORDER BY c.relname",
        )
      ).rows.map((r) => [r.name, r.columns]),
    );
  const before = await columns();
  guard(
    TABLES.every((t) => !(t in before)),
    'Combo objects already exist',
  );
  const constraints = (
    await c.query(
      'SELECT c.relname AS name,k.conname,pg_get_constraintdef(k.oid) AS definition FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND k.conname=ANY($1) ORDER BY c.relname',
      [
        [
          'commerce_quotes_total_minor_check',
          'commerce_orders_total_minor_check',
          'commerce_payment_intents_intended_minor_check',
        ],
      ],
    )
  ).rows;
  guard(
    equal(
      constraints.map((r) => [r.name, r.definition]),
      [
        ['commerce_orders', 'CHECK ((total_minor > 0))'],
        ['commerce_payment_intents', 'CHECK ((intended_minor > 0))'],
        ['commerce_quotes', 'CHECK ((total_minor > 0))'],
      ],
    ),
    'Original positive-total constraints required',
  );
  const acl = await runtimePrivileges(c, role);
  if (inspect) return { pending: [MIGRATION], privilegesAdded: [], rewardsEnabled: false };
  const existing = Object.fromEntries(
    Object.entries(before).filter(([n]) => n !== 'schema_migrations'),
  );
  const data = await fingerprint(c, existing);
  const roles = async () =>
    (
      await c.query(
        'SELECT rolname,rolsuper,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls,rolconfig FROM pg_roles ORDER BY rolname',
      )
    ).rows;
  const rolesBefore = await roles();
  await c.query(sql.get(MIGRATION));
  const appended = { version: MIGRATION, checksum: MIGRATION_SHA256, scope: 'cloud' };
  await c.query('INSERT INTO schema_migrations(version,checksum,scope) VALUES($1,$2,$3)', [
    appended.version,
    appended.checksum,
    appended.scope,
  ]);
  const after = await columns();
  guard(
    equal(Object.keys(after).sort(), [...Object.keys(before), ...TABLES].sort()),
    'Unexpected tables',
  );
  for (const [t, cols] of Object.entries(before))
    guard(equal(after[t], cols), 'Existing columns changed');
  guard(equal(await fingerprint(c, existing), data), 'Existing rows changed');
  guard(equal(await runtimePrivileges(c, role), acl), 'Runtime privileges changed');
  guard(equal(await roles(), rolesBefore), 'Role attributes changed');
  for (const t of TABLES)
    guard(
      (await c.query(`SELECT count(*)::int n FROM ${t}`)).rows[0].n === 0,
      'Unexpected activation or backfill',
    );
  guard(
    equal(
      (await c.query('SELECT version,checksum,scope FROM schema_migrations ORDER BY version')).rows,
      [...ledger, appended],
    ),
    'Ledger changed',
  );
  return {
    applied: [MIGRATION],
    existingDataPreserved: true,
    privilegesAdded: [],
    privilegesRemoved: [],
    rewardsEnabled: false,
  };
}
async function main(argv) {
  guard(
    argv.length === 1 && ['inspect-060', 'apply-060', 'inspect-068', 'apply-068'].includes(argv[0]),
    'Use inspect-060|apply-060|inspect-068|apply-068',
  );
  const url = new URL(process.env.CLOUD_DATABASE_URL ?? '');
  guard(
    url.username === 'pickchick_owner' && url.pathname === '/pickchick_cloud',
    'Owner database required',
  );
  guard(
    process.env.CUSTOMER_COMBO_REWARDS_ENABLED === 'false',
    'Explicit disabled rewards required',
  );
  const { createPool } = await import('@pickchick/database');
  const pool = createPool(url.href),
    c = await pool.connect();
  try {
    const inspect = argv[0].startsWith('inspect-');
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ' + (inspect ? ' READ ONLY' : ''));
    if (!inspect) await c.query('SELECT pg_advisory_xact_lock($1)', [724001]);
    const operation = argv[0].endsWith('060') ? deployComboRewards : deployReleaseFixes;
    const result = await operation(c, {
      directory: fileURLToPath(new URL('../../db/cloud/migrations/', import.meta.url)),
      role: 'pickchick_app',
      inspect,
    });
    await c.query(inspect ? 'ROLLBACK' : 'COMMIT');
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
  main(process.argv.slice(2)).catch(() => {
    console.error('Combo schema transaction failed; inspect state before retry.');
    process.exitCode = 1;
  });
