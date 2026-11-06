import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MIGRATION,
  POS_SALES_RELATIONS,
  RUNTIME_PRIVILEGES,
  WORKER_PRIVILEGES,
  assertPosSalesPrivileges,
  posSalesGrantees,
  posSalesRuntimeGrants,
  posSalesWorkerGrants,
} from './pos-sales-grants.mjs';

/**
 * Edge schema025 -> 026 (cutover 19.11.2026, lane pos; contracts 3.1, 3.2, 5.9, 6.2 step 3):
 * paid POS sales. Run by the edge owner with every edge service stopped and a fresh verified
 * schema025 backup. `inspect` changes nothing; `apply` adds exactly the reviewed 026 bytes in one
 * transaction, grants the runtime and the POS sync worker their reviewed 026 privileges (each only
 * when its role is installed), proves both exact privilege sets, that no other role can reach the
 * 026 relations, and that every existing row, sequence, table privilege, function owner and ACL is
 * unchanged. 026 replaces seven functions: their ACLs stay, and edge_restore_fence differs from
 * 023 only by pos_sale_outbox in its queue list (CR pos-6). A second `apply` refuses and changes
 * nothing; `inspect` on 026 verifies the installed state. Everything stays off: the branch keeps
 * its service mode (never pos_sale) and the eight payment methods are seeded disabled.
 * Rollback: the previous binary keeps working on 026 (contracts 3.2 p.4), so no schema rollback.
 */
export const POS_SALES_MIGRATION = MIGRATION;
/** SHA-256 of the reviewed 026 (CR pos-6 section 2); any other 026 bytes are refused. */
export const POS_SALES_SHA256 = '921c526320f6b878f592949d7ca2ebc71e28a1ceb14881c74909314ed46d057c';
/** The one column 026 adds to an existing table (NOT NULL DEFAULT false). */
export const POS_SALES_ADDED_COLUMNS = Object.freeze({ local_cash_shifts: ['sales_mode'] });
/** Existing functions 026 replaces (CREATE OR REPLACE); every other function stays byte for byte. */
export const POS_SALES_REPLACED_FUNCTIONS = Object.freeze([
  'append_cashier_shift_report(uuid)',
  'edge_restore_fence(boolean)',
  'guard_cash_movement()',
  'guard_local_cash_shift()',
  'guard_local_execution_admission()',
  'guard_local_execution_mode()',
  'guard_local_order_update()',
]);
export const FENCE_QUEUES_023 = "ARRAY['cashier_report_outbox', 'fulfillment_outbox']";
export const FENCE_QUEUES_026 =
  "ARRAY['cashier_report_outbox', 'fulfillment_outbox', 'pos_sale_outbox']";
const LEDGER_LENGTH = 26;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
/**
 * A refusal of this tool: the operator sees its own message (integration review R10). Nothing
 * else is printed: no connection string, SQL or row data.
 */
const refused = (message) => Object.assign(new Error(message), { refusal: true });
/** What the command line may print for an error: own refusals and grant-proof messages only. */
export function operatorMessage(error) {
  const message = typeof error?.message === 'string' ? error.message : '';
  if (error?.refusal === true) return message;
  if (/^POS sales [A-Za-z0-9 ,:._-]{3,160}$/.test(message)) return message;
  const code =
    typeof error?.code === 'string' && /^[A-Z0-9_]{2,20}$/.test(error.code) ? error.code : null;
  return code ? 'database or connection error ' + code : null;
}
const identifier = (name) => {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(name ?? '')) throw refused('Invalid identifier');
  return '"' + name + '"';
};

/** Reviewed migration ledger of the app root: 001-025 by their bytes, 026 by the pinned hash. */
async function reviewedFiles(appRoot) {
  const dir = join(appRoot, 'db/edge/migrations');
  const names = (await readdir(dir)).filter((n) => /^\d{3}_[a-z_]+\.sql$/.test(n)).sort();
  const expected = [];
  for (const name of names.slice(0, LEDGER_LENGTH))
    expected.push({
      scope: 'edge',
      version: name,
      checksum: digest(await readFile(join(dir, name))),
    });
  if (
    expected.length !== LEDGER_LENGTH ||
    names.some((name, index) => !name.startsWith(String(index + 1).padStart(3, '0') + '_')) ||
    names[LEDGER_LENGTH - 1] !== POS_SALES_MIGRATION ||
    expected[LEDGER_LENGTH - 1].checksum !== POS_SALES_SHA256
  )
    throw refused('Expected reviewed migrations 001-025 and the reviewed migration026');
  return { dir, expected };
}

/** Owner, ACL, settings and security of a function; its definition when `withDefinition`. */
async function functionState(client, schema, signatures, withDefinition) {
  const rows = (
    await client.query(
      `SELECT p.oid::regprocedure::text AS name, pg_get_userbyid(p.proowner) AS owner,
         p.proacl::text AS acl, p.proconfig::text AS config, p.prosecdef AS definer,
         CASE WHEN $3 THEN pg_get_functiondef(p.oid) END AS definition
       FROM pg_proc p WHERE p.pronamespace=$1::regnamespace AND p.prokind='f'
         AND ($2::text[] IS NULL OR p.oid::regprocedure::text=ANY($2::text[]))
       ORDER BY 1`,
      [schema, signatures, withDefinition],
    )
  ).rows;
  return Object.fromEntries(rows.map(({ name, ...state }) => [name, state]));
}

export async function posSalesMigration(
  client,
  {
    mode,
    appRoot,
    branchId,
    schema = 'public',
    runtimeRole = 'pickchick_edge_runtime',
    workerRole = 'pickchick_pos_sync',
  },
) {
  if (!['inspect', 'apply'].includes(mode)) throw refused('Invalid mode');
  const ns = identifier(schema);
  identifier(runtimeRole);
  identifier(workerRole);
  if (runtimeRole === workerRole) throw refused('Runtime and worker roles must differ');
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query('SET LOCAL search_path TO ' + ns);
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('pickchick-pos-sales-026',0))",
    );
    // 026 replaces guard functions of live tables: no edge service may hold a session meanwhile.
    const others = (
      await client.query(
        `SELECT DISTINCT usename::text AS role FROM pg_stat_activity
         WHERE datname=current_database() AND pid<>pg_backend_pid()
           AND backend_type='client backend' AND usename IS DISTINCT FROM current_user ORDER BY 1`,
      )
    ).rows.map((r) => r.role);
    if (others.length) throw refused('Edge services must be stopped');
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
    const ledger = (
      await client.query('SELECT scope,version,checksum FROM schema_migrations ORDER BY version')
    ).rows;
    const { dir, expected } = await reviewedFiles(appRoot);
    const branches = (await client.query('SELECT id FROM branch_config')).rows;
    if (branches.length !== 1 || branches[0].id !== branchId) throw refused('Branch differs');
    const roles = (
      await client.query('SELECT rolname FROM pg_roles WHERE rolname=ANY($1) ORDER BY rolname', [
        [runtimeRole, workerRole],
      ])
    ).rows.map((r) => r.rolname);
    const runtime = roles.includes(runtimeRole),
      worker = roles.includes(workerRole);
    const verifyGrants = async () => {
      if (runtime)
        await assertPosSalesPrivileges(client, runtimeRole, RUNTIME_PRIVILEGES, { schema });
      if (worker) await assertPosSalesPrivileges(client, workerRole, WORKER_PRIVILEGES, { schema });
      // Only the runtime and the POS sync worker may reach 026; the owner keeps its own rights.
      const grantees = (await posSalesGrantees(client, { schema })).sort();
      if (JSON.stringify(grantees) !== JSON.stringify([...roles].sort()))
        throw refused('Unexpected role can reach POS sales relations');
    };
    const methods = async () =>
      (
        await client.query(
          `SELECT count(*)::int AS count, coalesce(bool_or(enabled),false) AS enabled,
             (SELECT pos_service_mode FROM branch_config) AS mode FROM pos_payment_methods`,
        )
      ).rows[0];
    const offState = async () => {
      const state = await methods();
      if (state.count !== 8 || state.enabled || state.mode === 'pos_sale')
        throw refused('POS sales must stay off after migration026');
      return state;
    };
    // Already on the reviewed 026 (later reviewed migrations may follow): inspect verifies it.
    if (JSON.stringify(ledger.slice(0, LEDGER_LENGTH)) === JSON.stringify(expected)) {
      // Already on the reviewed 026: never reapplied; inspect proves the installed state.
      if (mode === 'apply') throw refused('Migration026 is already applied; nothing changed');
      await verifyGrants();
      const fence = (await functionState(client, schema, ['edge_restore_fence(boolean)'], true))[
        'edge_restore_fence(boolean)'
      ];
      if (!fence?.definition.includes(FENCE_QUEUES_026))
        throw refused('Restore fence does not cover pos_sale_outbox');
      const state = await methods();
      await client.query('ROLLBACK');
      return {
        mode,
        migrations: LEDGER_LENGTH,
        applied: true,
        posSalesGrantedTo: roles,
        runtimeRolePresent: runtime,
        workerRolePresent: worker,
        serviceMode: state.mode,
        paymentMethodsEnabled: state.enabled,
        dataPreserved: true,
        fingerprint: null,
      };
    }
    if (JSON.stringify(ledger) !== JSON.stringify(expected.slice(0, LEDGER_LENGTH - 1)))
      throw refused('Expected unchanged schema025 and only reviewed migration026');
    if (Object.keys(POS_SALES_RELATIONS).some((name) => tables.includes(name)))
      throw refused('POS sales objects already exist');
    const columns = Object.fromEntries(
      (
        await client.query(
          `SELECT table_name AS name, array_agg(column_name::text ORDER BY ordinal_position) AS columns
             FROM information_schema.columns WHERE table_schema=$1 GROUP BY table_name`,
          [schema],
        )
      ).rows.map((r) => [r.name, r.columns]),
    );
    const sequenceNames = (
      await client.query('SELECT sequencename FROM pg_sequences WHERE schemaname=$1', [schema])
    ).rows.map((r) => r.sequencename);
    // Rows over the pre-026 columns, existing sequences, table/sequence ACLs, function owners
    // and ACLs, and the definition of every function 026 does not replace.
    const snapshot = async (existingFunctions) => {
      const result = {};
      for (const table of tables.filter((t) => t !== 'schema_migrations')) {
        const projection = `jsonb_build_object(${columns[table]
          .map((c) => `'${c}',t.${identifier(c)}`)
          .join(',')})`;
        result[table] = (
          await client.query(
            `SELECT count(*)::text AS count, md5(COALESCE(string_agg(h,'' ORDER BY h),'')) AS hash FROM (SELECT md5((${projection})::text) h FROM ${ns}.${identifier(table)} t) r`,
          )
        ).rows[0];
      }
      result.sequences = (
        await client.query(
          'SELECT sequencename,last_value FROM pg_sequences WHERE schemaname=$1 AND sequencename=ANY($2) ORDER BY sequencename',
          [schema, sequenceNames],
        )
      ).rows;
      result.acl = (
        await client.query(
          "SELECT relname,relacl FROM pg_class WHERE relnamespace=$1::regnamespace AND relkind IN ('r','S') AND relname=ANY($2) ORDER BY relname",
          [schema, [...tables, ...sequenceNames]],
        )
      ).rows;
      const functions = await functionState(client, schema, null, true);
      result.functions = Object.fromEntries(
        Object.entries(functions)
          .filter(([name]) => !existingFunctions || existingFunctions.includes(name))
          .map(([name, state]) => [
            name,
            POS_SALES_REPLACED_FUNCTIONS.includes(name) ? { ...state, definition: null } : state,
          ]),
      );
      return result;
    };
    const initial = await snapshot(null);
    const existingFunctions = Object.keys(initial.functions);
    for (const name of POS_SALES_REPLACED_FUNCTIONS)
      if (!(name in initial.functions)) throw refused('Expected function of schema025 is missing');
    const fence023 = (await functionState(client, schema, ['edge_restore_fence(boolean)'], true))[
      'edge_restore_fence(boolean)'
    ];
    if (fence023.definition.split(FENCE_QUEUES_023).length !== 2)
      throw refused('Restore fence of schema025 differs from 023');
    const fingerprint = digest(JSON.stringify(initial));
    let serviceMode = (await client.query('SELECT pos_service_mode FROM branch_config')).rows[0]
      .pos_service_mode;
    if (mode === 'apply') {
      await client.query(await readFile(join(dir, POS_SALES_MIGRATION), 'utf8'));
      await client.query('INSERT INTO schema_migrations(scope,version,checksum) VALUES($1,$2,$3)', [
        'edge',
        POS_SALES_MIGRATION,
        POS_SALES_SHA256,
      ]);
      if (runtime) await client.query(posSalesRuntimeGrants(runtimeRole, schema));
      if (worker) await client.query(posSalesWorkerGrants(workerRole, schema));
      await verifyGrants();
      // Exactly the 026 relations are new; existing tables gain only the reviewed column.
      const relations = (
        await client.query(
          `SELECT relname,relkind FROM pg_class WHERE relnamespace=$1::regnamespace
             AND relkind IN ('r','S','v','m','p','f') AND NOT (relname=ANY($2)) ORDER BY relname`,
          [schema, [...tables, ...sequenceNames]],
        )
      ).rows;
      if (
        JSON.stringify(Object.fromEntries(relations.map((r) => [r.relname, r.relkind]))) !==
        JSON.stringify(Object.fromEntries(Object.entries(POS_SALES_RELATIONS).sort()))
      )
        throw refused('Unexpected relation created by migration026');
      const after = (
        await client.query(
          `SELECT table_name AS name, array_agg(column_name::text ORDER BY ordinal_position) AS columns
             FROM information_schema.columns WHERE table_schema=$1 AND table_name=ANY($2)
             GROUP BY table_name`,
          [schema, tables],
        )
      ).rows;
      for (const { name, columns: cols } of after)
        if (
          JSON.stringify(cols) !==
          JSON.stringify([...columns[name], ...(POS_SALES_ADDED_COLUMNS[name] ?? [])])
        )
          throw refused('Unexpected column change');
      if (
        (
          await client.query(
            'SELECT coalesce(bool_or(sales_mode),false) AS any FROM local_cash_shifts',
          )
        ).rows[0].any
      )
        throw refused('Existing cash shifts must stay outside sales mode');
      // CR pos-6: the fence keeps owner, ACL, search_path and SECURITY DEFINER; its definition
      // differs from 023 only by pos_sale_outbox in the queue list.
      const fence026 = (await functionState(client, schema, ['edge_restore_fence(boolean)'], true))[
        'edge_restore_fence(boolean)'
      ];
      if (
        fence026.definition !== fence023.definition.replace(FENCE_QUEUES_023, FENCE_QUEUES_026) ||
        fence026.owner !== fence023.owner ||
        fence026.acl !== fence023.acl ||
        fence026.config !== fence023.config ||
        fence026.definer !== true
      )
        throw refused('Restore fence changed beyond the pos_sale_outbox queue');
      serviceMode = (await offState()).mode;
      if (JSON.stringify(await snapshot(existingFunctions)) !== JSON.stringify(initial))
        throw refused('Data, sequence or permission changed during migration');
    }
    await client.query(mode === 'apply' ? 'COMMIT' : 'ROLLBACK');
    return {
      mode,
      migrations: mode === 'apply' ? LEDGER_LENGTH : LEDGER_LENGTH - 1,
      applied: mode === 'apply',
      posSalesGrantedTo: mode === 'apply' ? roles : [],
      runtimeRolePresent: runtime,
      workerRolePresent: worker,
      serviceMode,
      paymentMethodsEnabled: false,
      dataPreserved: true,
      fingerprint,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

async function main() {
  const [mode, toolsRoot, appRoot, branchId, ...extra] = process.argv.slice(2);
  if (
    !['inspect', 'apply'].includes(mode) ||
    extra.length ||
    !toolsRoot ||
    !appRoot ||
    !/^[a-f0-9-]{36}$/.test(branchId ?? '')
  )
    throw refused('Invalid POS sales migration invocation');
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
    // 026 re-validates the CHECKs of local_orders and fulfillment_reservations on real rows.
    statement_timeout: 120000,
  });
  client.on('error', () => {});
  await client.connect();
  try {
    console.log(JSON.stringify(await posSalesMigration(client, { mode, appRoot, branchId })));
  } finally {
    await client.end();
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    const reason = operatorMessage(error);
    console.error(
      `POS sales migration stopped${reason ? ': ' + reason : ''}; inspect protected state.`,
    );
    process.exitCode = 1;
  });
