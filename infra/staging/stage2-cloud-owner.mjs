/**
 * Stage 2 (24.10.2026) owner database step: cloud 070 (station plans, lane cfg) and 071 (daily
 * payment reconciliation, lane rec), with every stage 2 flag off, in ONE repeatable-read owner
 * transaction. Runs inside the candidate API image as the owner role, never as the runtime role:
 *
 *   node infra/staging/stage2-cloud-owner.mjs inspect [--with-069]
 *   node infra/staging/stage2-cloud-owner.mjs deploy [--with-069]
 *   node infra/staging/stage2-cloud-owner.mjs flag <station-plan-delivery|reconciliation> <true|false>
 *
 * Cloud 069 (push, PR #264) was NOT applied on the VPS on 21.10 (deployments/2026-10-21-*).
 * 070/071 use none of its objects, but the ledger is ordered: migrate() refuses a file older than
 * an applied one ("Out-of-order migration", packages/database), and every guarded owner step
 * compares the ledger with the exact file prefix. Applying 070/071 on schema068 would make 069
 * impossible to apply later. So `deploy` requires exact schema069; only the explicit
 * `--with-069` applies 069 too (its DDL only: no grants, push stays off), and only on exact
 * schema068. The output always names every applied file.
 *
 * `flag` changes only the runtime grants of one stage 2 flag (the API environment is written by
 * the guarded API release, docs/operations/stage2-2026-10-24/README.md): enable = grants first,
 * then the environment; disable = environment first, then the grants. Full provision.mjs is
 * never run: it rewrites unrelated runtime ACL. Output is names and booleans, never row data.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fingerprint, runtimePrivileges, OwnerGuardError } from './unified-menu-owner.mjs';
import { stationPlanGrants } from './station-plan-grants.mjs';
import { reconciliationGrants } from './reconciliation-grants.mjs';

export const BASELINE = '068_cloud_identity_abuse_limits.sql';
export const PUSH_MIGRATION = '069_cloud_customer_notifications.sql';
export const MIGRATIONS = ['070_cloud_station_plans.sql', '071_cloud_daily_reconciliation.sql'];
/** Reviewed bytes (SHA-256) of every file this step may apply. */
export const CHECKSUMS = Object.freeze({
  '069_cloud_customer_notifications.sql':
    '1c1e28fe37dbe96b049f7ea0bec85f493a4d57eec8558492c8c205a804ed92ca',
  '070_cloud_station_plans.sql': '794f90d8fbf043c5eee8747c39f1a9bc29cece8953a90ce1f86228550f67ef0c',
  '071_cloud_daily_reconciliation.sql':
    '5ca00336b7827de5fc6f70a80f80c37e0f4af4ff47753209c265e46edf63befc',
});
export const PUSH_TABLES = [
  'customer_notification_consents',
  'customer_notification_preferences',
  'customer_notifications',
  'customer_push_deliveries',
  'customer_push_devices',
];
export const STATION_PLAN_TABLES = [
  'bo_station_plan_deliveries',
  'bo_station_plan_edge_state',
  'bo_station_plan_receipts',
  'bo_station_plans',
];
export const RECONCILIATION_TABLES = [
  'bo_rec_accountants',
  'bo_rec_commands',
  'bo_rec_days',
  'bo_rec_import_voids',
  'bo_rec_imports',
  'bo_rec_items',
  'bo_rec_lines',
  'bo_rec_profiles',
  'bo_rec_total_voids',
  'bo_rec_totals',
];
export const FLAGS = ['station-plan-delivery', 'reconciliation'];
/** Back-office grants on (backofficeGrants(role, true)): the only state in which 070 is readable. */
const BACKOFFICE_MARKER = 'bo_commands||INSERT';
const LOCK = 724001; // Same advisory lock as @pickchick/database migrate().
const ROLE = /^[a-z][a-z0-9_]{0,62}$/;
const p = (table, column, privilege) => `${table}|${column}|${privilege}`;
/** SELECT of the four plan tables: back-office on, delivery off (what provision.mjs grants). */
export const STATION_PLAN_READ = STATION_PLAN_TABLES.map((t) => p(t, '', 'SELECT')).sort();
/** Added by BACKOFFICE_STATION_PLAN_DELIVERY_ENABLED=true (station-plan-grants.mjs). */
export const STATION_PLAN_WRITE = [
  ...STATION_PLAN_TABLES.map((t) => p(t, '', 'INSERT')),
  ...['device_id', 'last_delivered_at', 'deliveries'].map((c) =>
    p('bo_station_plan_deliveries', c, 'UPDATE'),
  ),
  ...['device_id', 'active_plan_id', 'active_version', 'stations', 'observed_at'].map((c) =>
    p('bo_station_plan_edge_state', c, 'UPDATE'),
  ),
].sort();
/** Added by BACKOFFICE_RECONCILIATION_ENABLED=true (reconciliation-grants.mjs). */
export function reconciliationPrivileges(tiptoppayTestTable = true) {
  return [
    ...RECONCILIATION_TABLES.map((t) => p(t, '', 'SELECT')),
    ...RECONCILIATION_TABLES.filter((t) => t !== 'bo_rec_accountants').map((t) =>
      p(t, '', 'INSERT'),
    ),
    ...['revision', 'name', 'mapping', 'archived', 'actor_id', 'updated_at'].map((c) =>
      p('bo_rec_profiles', c, 'UPDATE'),
    ),
    ...[
      'revision',
      'state',
      'amount_minor',
      'status',
      'assignee_id',
      'comment',
      'actor_id',
      'updated_at',
    ].map((c) => p('bo_rec_items', c, 'UPDATE')),
    ...['attempt_id', 'reference', 'operation_id'].map((c) =>
      p('commerce_kaspi_invoices', c, 'SELECT'),
    ),
    ...(tiptoppayTestTable
      ? ['branch_id', 'amount_minor', 'state', 'updated_at'].map((c) =>
          p('commerce_tiptoppay_test_payments', c, 'SELECT'),
        )
      : []),
  ].sort();
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const guard = (ok, message) => {
  if (!ok) throw new OwnerGuardError(message);
};
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const union = (a, b) => [...new Set([...a, ...b])].sort();
const minus = (a, b) => a.filter((x) => !b.includes(x));

async function columns(c) {
  return Object.fromEntries(
    (
      await c.query(
        "SELECT c.relname AS name,array_agg(a.attname::text ORDER BY a.attnum) AS columns FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped WHERE n.nspname=current_schema() AND c.relkind IN ('r','p') GROUP BY c.relname ORDER BY c.relname",
      )
    ).rows.map((r) => [r.name, r.columns]),
  );
}
async function roles(c) {
  return (
    await c.query(
      'SELECT rolname,rolsuper,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls,rolconfig FROM pg_roles ORDER BY rolname',
    )
  ).rows;
}
const ledgerOf = async (c) =>
  (await c.query('SELECT version,checksum,scope FROM schema_migrations ORDER BY version')).rows;

/** Candidate files: exactly ...068, 069, 070, 071 with the reviewed bytes of 069-071. */
async function candidate(directory) {
  const files = (await readdir(directory)).filter((n) => /^\d{3}_[a-z0-9_]+\.sql$/.test(n)).sort();
  guard(
    equal(files.slice(-4), [BASELINE, PUSH_MIGRATION, ...MIGRATIONS]),
    'Exact schema068 baseline with 069 and the 070/071 candidate required',
  );
  const sql = new Map(
    await Promise.all(files.map(async (n) => [n, await readFile(join(directory, n), 'utf8')])),
  );
  for (const [name, checksum] of Object.entries(CHECKSUMS))
    guard(sha256(sql.get(name)) === checksum, 'Reviewed migration bytes differ: ' + name);
  return { files, sql };
}

export async function deployStage2(c, { directory, role, inspect = false, with069 = false }) {
  guard(ROLE.test(role), 'Invalid runtime role');
  guard(typeof with069 === 'boolean', 'Invalid 069 choice');
  await c.query("SET LOCAL lock_timeout='5s';SET LOCAL statement_timeout='300s'");
  if (!inspect) await c.query('SELECT pg_advisory_xact_lock($1)', [LOCK]);
  const { files, sql } = await candidate(directory);
  const ledger = await ledgerOf(c);
  const exactPrefix = (count) =>
    ledger.length === count &&
    ledger.every(
      (r, i) =>
        r.version === files[i] && r.scope === 'cloud' && r.checksum === sha256(sql.get(r.version)),
    );
  const at069 = exactPrefix(files.length - MIGRATIONS.length);
  const at068 = exactPrefix(files.length - MIGRATIONS.length - 1);
  guard(
    at069 || at068,
    'Exact schema069 (or schema068 with --with-069) ledger required; do not replay partial apply',
  );
  const pending = at069 ? [...MIGRATIONS] : [PUSH_MIGRATION, ...MIGRATIONS];
  const before = await columns(c);
  const acl = await runtimePrivileges(c, role);
  const backoffice = acl.includes(BACKOFFICE_MARKER);
  const expected = backoffice ? STATION_PLAN_READ : [];
  if (inspect)
    return {
      ledger: at069 ? 'schema069' : 'schema068',
      requires069: at068,
      pending,
      backofficeGrants: backoffice,
      privilegesAdded: expected,
      flags: { stationPlanDelivery: false, reconciliation: false, push: false },
    };
  guard(
    at068 === with069,
    at068
      ? 'Cloud 069 is not applied: apply it by its own release first, or run deploy --with-069 (069 DDL only, push stays off)'
      : 'Cloud 069 is already applied: run deploy without --with-069',
  );
  const added = [...(at068 ? PUSH_TABLES : []), ...STATION_PLAN_TABLES, ...RECONCILIATION_TABLES];
  guard(
    added.every((t) => !(t in before)),
    'Stage 2 tables already exist',
  );
  const existing = Object.fromEntries(
    Object.entries(before).filter(([n]) => n !== 'schema_migrations'),
  );
  const data = await fingerprint(c, existing);
  const rolesBefore = await roles(c);
  const appended = [];
  for (const name of pending) {
    await c.query(sql.get(name));
    const row = { version: name, checksum: sha256(sql.get(name)), scope: 'cloud' };
    await c.query('INSERT INTO schema_migrations(version,checksum,scope) VALUES($1,$2,$3)', [
      row.version,
      row.checksum,
      row.scope,
    ]);
    appended.push(row);
  }
  // Flags off: what provision.mjs grants with BACKOFFICE_STATION_PLAN_DELIVERY_ENABLED and
  // BACKOFFICE_RECONCILIATION_ENABLED unset. 069 gets no grant at all (push stays off).
  await c.query(stationPlanGrants(role, { backoffice, delivery: false }));
  await c.query(reconciliationGrants(role, false));
  const after = await columns(c);
  guard(
    equal(Object.keys(after).sort(), [...Object.keys(before), ...added].sort()),
    'Unexpected tables',
  );
  for (const [t, cols] of Object.entries(before))
    guard(equal(after[t], cols), 'Existing columns changed');
  guard(equal(await fingerprint(c, existing), data), 'Existing rows changed');
  guard(equal(await roles(c), rolesBefore), 'Role attributes changed');
  guard(
    equal(await runtimePrivileges(c, role), union(acl, expected)),
    'Unexpected privilege delta',
  );
  guard(equal(await ledgerOf(c), [...ledger, ...appended]), 'Ledger changed');
  return {
    applied: pending,
    existingDataPreserved: true,
    backofficeGrants: backoffice,
    privilegesAdded: minus(expected, acl),
    privilegesRemoved: [],
    flags: { stationPlanDelivery: false, reconciliation: false, push: false },
  };
}

/** Runtime grants of one stage 2 flag; exact delta, nothing else on the role changes. */
export async function setStage2Flag(c, { role, flag, enabled }) {
  guard(ROLE.test(role) && FLAGS.includes(flag) && typeof enabled === 'boolean', 'Invalid flag');
  await c.query("SET LOCAL lock_timeout='5s';SET LOCAL statement_timeout='60s'");
  await c.query('SELECT pg_advisory_xact_lock($1)', [LOCK]);
  const versions = (await ledgerOf(c)).map((r) => r.version);
  guard(
    MIGRATIONS.every((m) => versions.includes(m)),
    'Run deploy (070/071) first',
  );
  const acl = await runtimePrivileges(c, role);
  const backoffice = acl.includes(BACKOFFICE_MARKER);
  guard(!enabled || backoffice, 'BACKOFFICE_ENABLED grants are required first');
  let delta, sql;
  if (flag === 'station-plan-delivery') {
    guard(
      !backoffice || STATION_PLAN_READ.every((x) => acl.includes(x)),
      'Station plan read grants missing',
    );
    delta = STATION_PLAN_WRITE;
    sql = stationPlanGrants(role, { backoffice, delivery: enabled });
  } else {
    const tiptoppay = (
      await c.query("SELECT to_regclass('commerce_tiptoppay_test_payments') IS NOT NULL AS present")
    ).rows[0].present;
    delta = reconciliationPrivileges(tiptoppay);
    sql = reconciliationGrants(role, enabled);
  }
  const rolesBefore = await roles(c);
  await c.query(sql);
  const want = enabled ? union(acl, delta) : minus(acl, delta);
  guard(equal(await runtimePrivileges(c, role), want), 'Unexpected privilege delta');
  guard(equal(await roles(c), rolesBefore), 'Role attributes changed');
  return {
    flag,
    enabled,
    privilegesAdded: enabled ? minus(delta, acl) : [],
    privilegesRemoved: enabled ? [] : delta.filter((x) => acl.includes(x)),
    environment:
      flag === 'station-plan-delivery'
        ? 'BACKOFFICE_STATION_PLAN_DELIVERY_ENABLED'
        : 'BACKOFFICE_RECONCILIATION_ENABLED',
  };
}

export function parseArguments(argv) {
  const [command, ...rest] = argv;
  if (['inspect', 'deploy'].includes(command) && (rest.length === 0 || equal(rest, ['--with-069'])))
    return { command, with069: rest.length === 1 };
  if (
    command === 'flag' &&
    rest.length === 2 &&
    FLAGS.includes(rest[0]) &&
    ['true', 'false'].includes(rest[1])
  )
    return { command, flag: rest[0], enabled: rest[1] === 'true' };
  throw new OwnerGuardError(
    'Usage: stage2-cloud-owner.mjs inspect|deploy [--with-069] | flag <station-plan-delivery|reconciliation> <true|false>',
  );
}

async function main(argv) {
  const args = parseArguments(argv);
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
    const result =
      args.command === 'flag'
        ? await setStage2Flag(c, { role: 'pickchick_app', flag: args.flag, enabled: args.enabled })
        : await deployStage2(c, {
            directory: fileURLToPath(new URL('../../db/cloud/migrations/', import.meta.url)),
            role: 'pickchick_app',
            inspect: args.command === 'inspect',
            with069: args.with069,
          });
    await c.query(args.command === 'inspect' ? 'ROLLBACK' : 'COMMIT');
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
        ? `Stage 2 owner guard: ${e.message}`
        : 'Stage 2 owner transaction failed; inspect state before retry.',
    );
    process.exitCode = 1;
  });
