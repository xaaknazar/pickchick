import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 18.11.2026, first unpaid POS order on the test cashier: PostgreSQL refused it with «нет доступа
 * к функции append_cashier_order_report» and rolled the whole order back (edge INTERNAL_ERROR, the
 * POS kept the request pending). Cause: the native foundation bootstrap (native-foundation-db.mjs)
 * runs `ALTER DEFAULT PRIVILEGES FOR ROLE pickchick_edge_owner REVOKE EXECUTE ON FUNCTIONS FROM
 * PUBLIC`, so every function a migration creates is callable by its owner only. Invoker triggers
 * still call invoker helpers as the role that wrote the row:
 * - 016 cashier_report_source_changed (local_orders, local_cash_shifts, local_cash_movements,
 *   fulfillment_reservations) calls append_cashier_order_report / append_cashier_shift_report;
 * - 026 sales guards and the sales code call pos_shift_cash, pos_sale_assert_complete,
 *   pos_approval_consumed, pos_refund_assert_complete and pos_shift_pending_fiscal.
 * The reviewed grant tools give these roles the table rights the helpers use (INSERT on
 * cashier_report_outbox, the read columns) but never EXECUTE, and CI databases keep PostgreSQL's
 * default PUBLIC EXECUTE, so no test saw it.
 *
 * This tool adds exactly EXECUTE on those functions to the roles that run them, nothing else:
 *
 *   node --env-file=<edge owner env> cashier-report-function-grants.mjs inspect|apply|revoke <toolsRoot>
 *
 * - edge runtime (pickchick_edge_runtime): the two report functions (schema016+) and the five
 *   sales helpers (schema026+);
 * - each fulfillment worker login present (pickchick_fulfillment_sync, pickchick_fulfillment_worker):
 *   append_cashier_order_report (it writes kitchen reservations that may belong to POS orders).
 *
 * The functions stay invoker: each still runs with the caller's own table rights. One transaction
 * under an advisory lock; the ledger must equal a reviewed prefix of length 016..029: rows 001..028
 * of native-edge-backup-ledger.json next to this tool, then the reviewed Kaspi 029 row pinned here
 * (the cutover ledger ends at 028; the test cashier runs 029); one branch (EDGE_BRANCH_ID when
 * set); restricted existing roles;
 * the full privilege map of every role must differ by exactly the added (or removed) EXECUTE
 * entries. A replay changes nothing. `revoke` removes only these entries (rollback). Output: role
 * and function names, codes and booleans only; no row data, SQL or connection details.
 */
export const RUNTIME_ROLE = 'pickchick_edge_runtime';
export const WORKER_ROLES = Object.freeze([
  'pickchick_fulfillment_sync',
  'pickchick_fulfillment_worker',
]);
export const REPORT_FUNCTIONS = Object.freeze([
  'append_cashier_order_report(uuid)',
  'append_cashier_shift_report(uuid)',
]);
export const SALES_FUNCTIONS = Object.freeze([
  'pos_shift_cash(uuid)',
  'pos_sale_assert_complete(uuid,uuid)',
  'pos_approval_consumed(uuid,uuid,uuid,text)',
  'pos_refund_assert_complete(uuid)',
  'pos_shift_pending_fiscal(uuid)',
]);
export const WORKER_FUNCTIONS = Object.freeze(['append_cashier_order_report(uuid)']);
/** Owner-rights functions of the runtime's order path, reported only (never granted here). */
export const OWNER_FUNCTIONS = Object.freeze([
  'edge_restore_fence(boolean)',
  'fulfillment_display_allocate(uuid)',
]);
/** Ledger lengths: 016 adds the report functions, 026 the sales helpers; 029 is the reviewed end. */
export const FIRST_SCHEMA = 16;
export const SALES_SCHEMA = 26;
export const LAST_SCHEMA = 29;
/** The shipped cutover ledger ends at 028: a pinned file holds at least that many rows. */
export const PINNED_MIN = 28;
/**
 * 029 (Kaspi Smart POS, ADR-0017; on the test cashier since 16.11, runtime 8290c87f), reviewed by
 * its exact bytes: two tables, a tender foreign key and three trigger functions that call built-ins
 * only (trigger functions are not checked for EXECUTE when they fire), no new or replaced helper.
 * So 029 needs exactly the 028 plan. Any other 029 is refused until it is reviewed here.
 */
export const KASPI_SCHEMA_ROW = Object.freeze({
  scope: 'edge',
  version: '029_edge_kaspi_pos.sql',
  checksum: 'edf0f0cbce196dc6601c5bcb2d9457ac2d43e12a51916d52d5cd6824f5339784',
});
const REVIEWED_RANGE = 'Reviewed schema016 to schema029 required';
const NAME = /^[a-z][a-z0-9_]{0,62}$/;
const identifier = (name) => {
  if (!NAME.test(name ?? '')) throw Error('Invalid identifier');
  return '"' + name + '"';
};

/** The EXECUTE entries this tool manages for a ledger length and the roles present. */
export function functionGrantPlan(
  ledgerLength,
  { runtimeRole = RUNTIME_ROLE, workerRoles = [] } = {},
) {
  if (!Number.isInteger(ledgerLength) || ledgerLength < FIRST_SCHEMA || ledgerLength > LAST_SCHEMA)
    throw Error(REVIEWED_RANGE);
  identifier(runtimeRole);
  for (const role of workerRoles) identifier(role);
  const runtime = [...REPORT_FUNCTIONS, ...(ledgerLength >= SALES_SCHEMA ? SALES_FUNCTIONS : [])];
  return [
    ...runtime.map((fn) => ({ role: runtimeRole, fn })),
    ...workerRoles.flatMap((role) => WORKER_FUNCTIONS.map((fn) => ({ role, fn }))),
  ];
}
const entry = ({ role, fn }) => `${role}|${fn}||EXECUTE`;

/** Every privilege of every role on the schema's objects, as sorted text rows. */
async function privilegeMap(client, schema) {
  const { rows } = await client.query(
    `SELECT format('%s|%s||%s',x.grantee::regrole,c.relname,x.privilege_type) AS p
       FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) x
      WHERE c.relnamespace=$1::regnamespace
     UNION ALL
     SELECT format('%s|%s|%s|%s',x.grantee::regrole,c.relname,a.attname,x.privilege_type)
       FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid CROSS JOIN LATERAL aclexplode(a.attacl) x
      WHERE c.relnamespace=$1::regnamespace AND a.attnum>0 AND NOT a.attisdropped
     UNION ALL
     SELECT format('%s|%s||%s',x.grantee::regrole,p.oid::regprocedure,x.privilege_type)
       FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) x
      WHERE p.pronamespace=$1::regnamespace
     UNION ALL
     SELECT format('%s|schema||%s',x.grantee::regrole,x.privilege_type)
       FROM pg_namespace n CROSS JOIN LATERAL aclexplode(n.nspacl) x
      WHERE n.oid=$1::regnamespace`,
    [schema],
  );
  // With search_path on the schema, regprocedure prints e.g. pos_shift_cash(uuid).
  return rows.map((r) => r.p).sort();
}

export async function cashierReportFunctionGrants(
  client,
  {
    mode,
    schema = 'public',
    runtimeRole = RUNTIME_ROLE,
    workerRoles = WORKER_ROLES,
    pinned,
    branchId,
  },
) {
  if (!['inspect', 'apply', 'revoke'].includes(mode)) throw Error('Invalid mode');
  if (branchId !== undefined && !/^[a-f0-9-]{36}$/.test(branchId)) throw Error('Invalid branch');
  const ns = identifier(schema);
  identifier(runtimeRole);
  if (!Array.isArray(pinned) || pinned.length < PINNED_MIN)
    throw Error('Pinned edge ledger is invalid');
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query('SET LOCAL search_path TO ' + ns);
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('pickchick-cashier-report-function-grants',0))",
    );
    const ledger = (
      await client.query('SELECT scope,version,checksum FROM schema_migrations ORDER BY version')
    ).rows;
    // Reviewed rows: 001..028 from the pinned file, then the reviewed Kaspi 029 row of this tool (a
    // 029 row the pinned file may carry is not trusted in its place).
    const reviewedRows = [...pinned.slice(0, PINNED_MIN), KASPI_SCHEMA_ROW];
    const row = ({ scope, version, checksum }) => JSON.stringify({ scope, version, checksum });
    const reviewed =
      ledger.length >= FIRST_SCHEMA &&
      ledger.length <= LAST_SCHEMA &&
      ledger.every((r, i) => row(r) === row(reviewedRows[i]));
    if (!reviewed) throw Error(REVIEWED_RANGE);
    const branches = (await client.query('SELECT id::text AS id FROM branch_config')).rows;
    if (branches.length !== 1 || (branchId !== undefined && branches[0].id !== branchId))
      throw Error('Branch differs');
    const roles = (
      await client.query(
        `SELECT rolname,rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls
           OR EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid OR m.roleid=r.oid) AS broad
           FROM pg_roles r WHERE rolname=ANY($1)`,
        [[runtimeRole, ...workerRoles]],
      )
    ).rows;
    const runtime = roles.find((r) => r.rolname === runtimeRole);
    if (!runtime || roles.some((r) => r.broad)) throw Error('Existing restricted roles required');
    const workers = workerRoles.filter((role) => roles.some((r) => r.rolname === role));
    const plan = functionGrantPlan(ledger.length, { runtimeRole, workerRoles: workers });
    const functions = (
      await client.query(
        `SELECT f AS fn, to_regprocedure(f) IS NOT NULL AS present,
           COALESCE((SELECT NOT p.prosecdef FROM pg_proc p WHERE p.oid=to_regprocedure(f)),false) AS invoker
           FROM unnest($1::text[]) f`,
        [[...new Set(plan.map((p) => p.fn))]],
      )
    ).rows;
    if (functions.some((f) => !f.present || !f.invoker)) throw Error('Reviewed functions differ');
    const before = await privilegeMap(client, schema);
    const state = [];
    for (const item of plan) {
      const { allowed } = (
        await client.query("SELECT has_function_privilege($1,$2,'EXECUTE') AS allowed", [
          item.role,
          item.fn,
        ])
      ).rows[0];
      state.push({ ...item, allowed, explicit: before.includes(entry(item)) });
    }
    const change =
      mode === 'apply'
        ? state.filter((s) => !s.allowed)
        : mode === 'revoke'
          ? state.filter((s) => s.explicit)
          : [];
    for (const item of change)
      await client.query(
        `${mode === 'apply' ? 'GRANT' : 'REVOKE'} EXECUTE ON FUNCTION ${ns}.${item.fn} ${
          mode === 'apply' ? 'TO' : 'FROM'
        } ${identifier(item.role)}`,
      );
    if (change.length) {
      const entries = change.map(entry);
      const want =
        mode === 'apply'
          ? [...before, ...entries].sort()
          : before.filter((p) => !entries.includes(p));
      if (JSON.stringify(await privilegeMap(client, schema)) !== JSON.stringify(want))
        throw Error('Unexpected privilege change');
    }
    const after = [];
    for (const item of plan)
      after.push({
        ...item,
        allowed: (
          await client.query("SELECT has_function_privilege($1,$2,'EXECUTE') AS allowed", [
            item.role,
            item.fn,
          ])
        ).rows[0].allowed,
      });
    if (mode === 'apply' && after.some((a) => !a.allowed)) throw Error('EXECUTE still missing');
    // Read only: the owner-rights functions of the same order path come from their own reviewed
    // tools (display numbers 022, restore fence 023); without the display grant admissions fall
    // back to the old global sequence, so the report shows it instead of granting it.
    const ownerFunctions = Object.fromEntries(
      (
        await client.query(
          `SELECT f AS fn, has_function_privilege($2,to_regprocedure(f),'EXECUTE') AS allowed
             FROM unnest($1::text[]) f WHERE to_regprocedure(f) IS NOT NULL ORDER BY f`,
          [OWNER_FUNCTIONS, runtimeRole],
        )
      ).rows.map((r) => [r.fn, r.allowed]),
    );
    await client.query(change.length ? 'COMMIT' : 'ROLLBACK');
    return {
      mode,
      schema: 'schema0' + String(ledger.length).padStart(2, '0'),
      runtimeRole,
      workerRoles: workers,
      changed: change.length > 0,
      granted: mode === 'apply' ? change.map(entry) : [],
      revoked: mode === 'revoke' ? change.map(entry) : [],
      missing: after.filter((a) => !a.allowed).map(entry),
      ready: after.every((a) => a.allowed),
      ownerFunctions,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

/** Messages this command may print: its own refusals only, never driver or SQL text. */
const OWN =
  /^(Invalid [a-z ]+|Reviewed [a-z0-9 ]+|Pinned edge ledger is invalid|Branch differs|Existing restricted roles required|Unexpected privilege change|EXECUTE still missing|Local edge owner required)$/;

async function main() {
  const [mode, toolsRoot, ...extra] = process.argv.slice(2);
  if (extra.length || !toolsRoot) throw Error('Invalid invocation');
  const url = new URL(process.env.EDGE_DATABASE_URL ?? '');
  if (
    url.hostname !== '127.0.0.1' ||
    url.port !== '55433' ||
    url.pathname !== '/pickchick_edge' ||
    url.username !== 'pickchick_edge_owner'
  )
    throw Error('Local edge owner required');
  const branchId = process.env.EDGE_BRANCH_ID || undefined;
  const pinned = JSON.parse(
    await readFile(new URL('./native-edge-backup-ledger.json', import.meta.url), 'utf8'),
  );
  const { Client } = createRequire(join(resolve(toolsRoot), 'package.json'))('pg');
  const c = new Client({
    connectionString: url.href,
    connectionTimeoutMillis: 3000,
    statement_timeout: 60000,
  });
  c.on('error', () => {});
  await c.connect();
  try {
    console.log(JSON.stringify(await cashierReportFunctionGrants(c, { mode, pinned, branchId })));
  } finally {
    await c.end();
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    const message =
      typeof error?.message === 'string' && OWN.test(error.message) ? error.message : null;
    const code =
      typeof error?.code === 'string' && /^[A-Z0-9_]{2,20}$/.test(error.code) ? error.code : null;
    console.error(
      JSON.stringify({
        event: 'cashier_report_function_grants_failed',
        ...(message ? { message } : {}),
        ...(code ? { code } : {}),
      }),
    );
    process.exitCode = 1;
  });
