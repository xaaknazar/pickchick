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

/**
 * Edge schema027 -> 028 (cutover 19.11.2026, lane pos, CR pos-7; lead decision 07.11 (1)): the
 * number of a cash desk. The same window C4 right after kds-upgrade-db.mjs (027), by the edge
 * owner with every edge service stopped and a fresh verified schema027 backup. `inspect` changes
 * nothing; `apply` adds exactly the reviewed 028 bytes and its ledger row in one transaction and
 * proves inside it: one new nullable smallint column local_terminals.desk_number and NULL in every
 * row; every row over the earlier columns, every sequence, table and column ACL and every function
 * unchanged; the CHECK local_terminals_desk_number_check, the unique partial index
 * local_terminals_active_desk_number (number set and desk active), the one new guard function and
 * trigger and nothing else new (no table, sequence, constraint, index or trigger beyond them);
 * pos_sales_setting_changes keeps its CHECK names and its subject CHECK admits desk_number; the
 * installed runtime reads the column (table SELECT) and can neither insert nor update it. No grant
 * is needed or given. A second `apply` refuses; `inspect` on 028 verifies the installed objects
 * and the runtime's read. Everything stays off: no desk has a number until the operator sets one
 * with `pos-sales-setup.mjs desk`. Rollback: the previous runtime never names the column
 * (contracts 3.2 p.4), so no schema rollback; a number is cleared with `desk --clear`.
 */
export const DESK_NUMBER_MIGRATION = '028_edge_pos_desk_number.sql';
/** SHA-256 of the reviewed 028 (CR pos-7 section 1.1); any other 028 bytes are refused. */
export const DESK_NUMBER_SHA256 =
  '684ffa9c5265d32fd3c33e6190ca3126c83c5cb47974aa274cf198fc905d0abf';
/** The reviewed 027 that 028 follows (CR kds-1): the pin of kds-upgrade-db.mjs KDS_SHA256. */
export const DESK_NUMBER_PREVIOUS = Object.freeze({
  version: '027_edge_kds_foundation.sql',
  checksum: '41e55b450721646e45be599cf58626fd52328113f5a8165bb8fa5edf1e3a2a97',
});
/** Everything 028 creates; it replaces no function and creates no table or sequence. */
export const DESK_NUMBER_OBJECTS = Object.freeze({
  table: 'local_terminals',
  column: 'desk_number',
  check: 'local_terminals_desk_number_check',
  index: 'local_terminals_active_desk_number',
  guard: 'guard_local_terminal_desk_number()',
  trigger: 'local_terminal_desk_number_guard',
});
/** The CHECKs of pos_sales_setting_changes that 028 recreates under their own names. */
export const DESK_NUMBER_AUDIT_CHECKS = Object.freeze([
  'pos_sales_setting_changes_check1',
  'pos_sales_setting_changes_subject_check',
]);
const DESK_LEDGER_LENGTH = 28;

/** Reviewed files of the app root: 001-027 by their bytes with 026 and 027 pinned, 028 pinned. */
async function reviewedDeskFiles(appRoot) {
  const dir = join(appRoot, 'db/edge/migrations');
  const names = (await readdir(dir)).filter((n) => /^\d{3}_[a-z_]+\.sql$/.test(n)).sort();
  const expected = [];
  for (const name of names.slice(0, DESK_LEDGER_LENGTH))
    expected.push({
      scope: 'edge',
      version: name,
      checksum: digest(await readFile(join(dir, name))),
    });
  const pins = [
    [POS_SALES_MIGRATION, POS_SALES_SHA256],
    [DESK_NUMBER_PREVIOUS.version, DESK_NUMBER_PREVIOUS.checksum],
    [DESK_NUMBER_MIGRATION, DESK_NUMBER_SHA256],
  ];
  if (
    expected.length !== DESK_LEDGER_LENGTH ||
    names.some((name, index) => !name.startsWith(String(index + 1).padStart(3, '0') + '_')) ||
    pins.some(
      ([version, checksum], index) =>
        expected[DESK_LEDGER_LENGTH - pins.length + index].version !== version ||
        expected[DESK_LEDGER_LENGTH - pins.length + index].checksum !== checksum,
    )
  )
    throw refused('Expected reviewed migrations 001-027 and the reviewed migration028');
  return { dir, expected };
}

export async function deskNumberMigration(
  client,
  { mode, appRoot, branchId, schema = 'public', runtimeRole = 'pickchick_edge_runtime' },
) {
  if (!['inspect', 'apply'].includes(mode)) throw refused('Invalid mode');
  const ns = identifier(schema);
  identifier(runtimeRole);
  const { table, column, check, index, guard, trigger } = DESK_NUMBER_OBJECTS;
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query('SET LOCAL search_path TO ' + ns);
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('pickchick-pos-desk-028',0))",
    );
    // 028 changes local_terminals and the audit CHECKs: no edge service may hold a session.
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
    const { dir, expected } = await reviewedDeskFiles(appRoot);
    const branches = (await client.query('SELECT id FROM branch_config')).rows;
    if (branches.length !== 1 || branches[0].id !== branchId) throw refused('Branch differs');
    const runtime =
      (await client.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [runtimeRole])).rowCount === 1;
    const qualified = ns + '.' + identifier(table);
    // The installed runtime answers GET pos/config with to_jsonb of the whole row (CR pos-7
    // section 1.3): before 028 it needs the table-level SELECT that covers a new column, after
    // 028 it reads the column and can neither insert nor update it.
    const runtimeReads = async (installed) => {
      if (!runtime) return null;
      // Before 028 only a table-level privilege reaches the new column.
      const privileges = (
        await client.query(
          installed
            ? `SELECT has_column_privilege($1,$2::regclass,$3,'SELECT') AS select,
                 has_column_privilege($1,$2::regclass,$3,'INSERT') AS insert,
                 has_column_privilege($1,$2::regclass,$3,'UPDATE') AS update`
            : `SELECT has_table_privilege($1,$2::regclass,'SELECT') AS select,
                 has_table_privilege($1,$2::regclass,'INSERT') AS insert,
                 has_table_privilege($1,$2::regclass,'UPDATE') AS update`,
          installed ? [runtimeRole, qualified, column] : [runtimeRole, qualified],
        )
      ).rows[0];
      if (!privileges.select) throw refused('Runtime role cannot read the desk number');
      if (privileges.insert || privileges.update)
        throw refused('Runtime role can write the desk number');
      return true;
    };
    // The objects of 028 as installed: column type, CHECK, unique partial index, guard, trigger.
    const deskObjects = async () => {
      const columnRow = (
        await client.query(
          `SELECT data_type, is_nullable, column_default FROM information_schema.columns
            WHERE table_schema=$1 AND table_name=$2 AND column_name=$3`,
          [schema, table, column],
        )
      ).rows[0];
      const constraint = (
        await client.query(
          `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
            WHERE conrelid=$1::regclass AND conname=$2 AND contype='c'`,
          [qualified, check],
        )
      ).rows[0];
      const unique = (
        await client.query(
          `SELECT i.indisunique AS unique, pg_get_expr(i.indpred,i.indrelid) AS predicate,
             (SELECT array_agg(a.attname::text ORDER BY k.ordinality) FROM unnest(i.indkey)
                WITH ORDINALITY k(attnum,ordinality)
                JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum) AS columns
             FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
            WHERE i.indrelid=$1::regclass AND c.relname=$2`,
          [qualified, index],
        )
      ).rows[0];
      const guardRow = (await functionState(client, schema, [guard], true))[guard];
      const triggerRow = (
        await client.query(
          `SELECT pg_get_triggerdef(t.oid) AS definition, t.tgfoid::regprocedure::text AS fn
             FROM pg_trigger t WHERE t.tgrelid=$1::regclass AND t.tgname=$2 AND NOT t.tgisinternal`,
          [qualified, trigger],
        )
      ).rows[0];
      const subjectCheck = (
        await client.query(
          `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
            WHERE conrelid=$1::regclass AND conname=$2 AND contype='c'`,
          [ns + '.pos_sales_setting_changes', 'pos_sales_setting_changes_subject_check'],
        )
      ).rows[0];
      if (
        columnRow?.data_type !== 'smallint' ||
        columnRow.is_nullable !== 'YES' ||
        columnRow.column_default !== null ||
        constraint?.definition !== 'CHECK (((desk_number >= 1) AND (desk_number <= 99)))' ||
        unique?.unique !== true ||
        JSON.stringify(unique.columns) !== JSON.stringify(['branch_id', column]) ||
        unique.predicate !== '((desk_number IS NOT NULL) AND active)' ||
        !guardRow ||
        triggerRow?.fn !== guard ||
        !/BEFORE INSERT OR UPDATE OF desk_number ON .*FOR EACH ROW/.test(triggerRow.definition) ||
        !(subjectCheck?.definition ?? '').includes("'desk_number'::text")
      )
        throw refused('Desk number objects differ from migration028');
    };
    // Desks with a number (only after 028; the operator sets them with pos-sales-setup.mjs desk).
    const numbered = async () =>
      (
        await client.query(
          `SELECT count(*)::int AS count FROM ${qualified} WHERE ${identifier(column)} IS NOT NULL`,
        )
      ).rows[0].count;
    // Already on the reviewed 028 (later reviewed migrations may follow): inspect verifies it.
    if (JSON.stringify(ledger.slice(0, DESK_LEDGER_LENGTH)) === JSON.stringify(expected)) {
      if (mode === 'apply') throw refused('Migration028 is already applied; nothing changed');
      await deskObjects();
      const reads = await runtimeReads(true);
      const desks = await numbered();
      await client.query('ROLLBACK');
      return {
        mode,
        migration: DESK_NUMBER_MIGRATION,
        migrations: DESK_LEDGER_LENGTH,
        applied: true,
        runtimeRolePresent: runtime,
        runtimeReadsDeskNumber: reads,
        deskNumbers: desks,
        dataPreserved: true,
        fingerprint: null,
      };
    }
    if (JSON.stringify(ledger) !== JSON.stringify(expected.slice(0, DESK_LEDGER_LENGTH - 1)))
      throw refused('Expected unchanged schema027 and only reviewed migration028');
    const columns = Object.fromEntries(
      (
        await client.query(
          `SELECT table_name AS name, array_agg(column_name::text ORDER BY ordinal_position) AS columns
             FROM information_schema.columns WHERE table_schema=$1 GROUP BY table_name`,
          [schema],
        )
      ).rows.map((r) => [r.name, r.columns]),
    );
    if (
      columns[table]?.includes(column) ||
      (
        await client.query(
          'SELECT 1 FROM pg_proc WHERE pronamespace=$1::regnamespace AND proname=$2',
          [schema, guard.slice(0, -2)],
        )
      ).rowCount
    )
      throw refused('Desk number objects already exist');
    const sequenceNames = (
      await client.query('SELECT sequencename FROM pg_sequences WHERE schemaname=$1', [schema])
    ).rows.map((r) => r.sequencename);
    // Rows over the pre-028 columns, sequences, table and column ACLs and every function but
    // the new guard.
    const snapshot = async () => {
      const result = {};
      for (const name of tables.filter((t) => t !== 'schema_migrations')) {
        const projection = `jsonb_build_object(${columns[name]
          .map((c) => `'${c}',t.${identifier(c)}`)
          .join(',')})`;
        result[name] = (
          await client.query(
            `SELECT count(*)::text AS count, md5(COALESCE(string_agg(h,'' ORDER BY h),'')) AS hash FROM (SELECT md5((${projection})::text) h FROM ${ns}.${identifier(name)} t) r`,
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
      result.columnAcl = (
        await client.query(
          `SELECT c.relname, a.attname::text AS attname, a.attacl::text AS acl FROM pg_attribute a
             JOIN pg_class c ON c.oid=a.attrelid
            WHERE c.relnamespace=$1::regnamespace AND a.attacl IS NOT NULL ORDER BY 1,2`,
          [schema],
        )
      ).rows;
      result.functions = Object.fromEntries(
        Object.entries(await functionState(client, schema, null, true)).filter(
          ([name]) => name !== guard,
        ),
      );
      return result;
    };
    // Every constraint, index and trigger but the three 028 adds; the two audit CHECKs 028
    // recreates by name only (their new rule is checked by deskObjects).
    const schemaObjects = async () => {
      const result = {};
      result.constraints = (
        await client.query(
          `SELECT c.relname::text AS relname, k.conname::text AS conname,
             CASE WHEN c.relname='pos_sales_setting_changes' AND k.conname::text=ANY($2::text[])
               THEN NULL ELSE pg_get_constraintdef(k.oid) END AS definition
             FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid
            WHERE c.relnamespace=$1::regnamespace
              AND NOT (c.relname::text=$3 AND k.conname::text=$4) ORDER BY 1,2`,
          [schema, DESK_NUMBER_AUDIT_CHECKS, table, check],
        )
      ).rows;
      result.indexes = (
        await client.query(
          'SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname=$1 AND indexname<>$2 ORDER BY 1,2',
          [schema, index],
        )
      ).rows;
      result.triggers = (
        await client.query(
          `SELECT c.relname::text AS relname, t.tgname::text AS tgname,
             pg_get_triggerdef(t.oid) AS definition
             FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
            WHERE c.relnamespace=$1::regnamespace AND NOT t.tgisinternal AND t.tgname<>$2
            ORDER BY 1,2`,
          [schema, trigger],
        )
      ).rows;
      return result;
    };
    const auditChecks = async () =>
      (
        await client.query(
          `SELECT conname::text AS name FROM pg_constraint
            WHERE conrelid=$1::regclass AND contype='c' ORDER BY 1`,
          [ns + '.pos_sales_setting_changes'],
        )
      ).rows.map((r) => r.name);
    const initial = await snapshot();
    const objects = await schemaObjects();
    const checks = await auditChecks();
    if (DESK_NUMBER_AUDIT_CHECKS.some((name) => !checks.includes(name)))
      throw refused('Audit checks of schema026 differ');
    let reads = await runtimeReads(false);
    const fingerprint = digest(JSON.stringify({ initial, objects }));
    if (mode === 'apply') {
      await client.query(await readFile(join(dir, DESK_NUMBER_MIGRATION), 'utf8'));
      await client.query('INSERT INTO schema_migrations(scope,version,checksum) VALUES($1,$2,$3)', [
        'edge',
        DESK_NUMBER_MIGRATION,
        DESK_NUMBER_SHA256,
      ]);
      // No new relation (an index is not one); only local_terminals gains the one column.
      const relations = (
        await client.query(
          `SELECT relname FROM pg_class WHERE relnamespace=$1::regnamespace
             AND relkind IN ('r','S','v','m','p','f') AND NOT (relname=ANY($2)) ORDER BY relname`,
          [schema, [...tables, ...sequenceNames]],
        )
      ).rows;
      if (relations.length) throw refused('Unexpected relation created by migration028');
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
          JSON.stringify([...columns[name], ...(name === table ? [column] : [])])
        )
          throw refused('Unexpected column change');
      await deskObjects();
      if (JSON.stringify(await auditChecks()) !== JSON.stringify(checks))
        throw refused('Audit checks of schema026 differ');
      if (JSON.stringify(await schemaObjects()) !== JSON.stringify(objects))
        throw refused('Unexpected constraint, index or trigger change');
      reads = await runtimeReads(true);
      if ((await numbered()) !== 0)
        throw refused('Desk numbers must stay unset after migration028');
      if (JSON.stringify(await snapshot()) !== JSON.stringify(initial))
        throw refused('Data, sequence or permission changed during migration');
    }
    await client.query(mode === 'apply' ? 'COMMIT' : 'ROLLBACK');
    return {
      mode,
      migration: DESK_NUMBER_MIGRATION,
      migrations: mode === 'apply' ? DESK_LEDGER_LENGTH : DESK_LEDGER_LENGTH - 1,
      applied: mode === 'apply',
      runtimeRolePresent: runtime,
      runtimeReadsDeskNumber: reads,
      deskNumbers: 0,
      dataPreserved: true,
      fingerprint,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

/** Command line modes: 026 (`inspect`, `apply`) and 028 (`inspect-028`, `apply-028`). */
export const CLI_MODES = Object.freeze({
  inspect: [posSalesMigration, 'inspect'],
  apply: [posSalesMigration, 'apply'],
  'inspect-028': [deskNumberMigration, 'inspect'],
  'apply-028': [deskNumberMigration, 'apply'],
});

async function main() {
  const [mode, toolsRoot, appRoot, branchId, ...extra] = process.argv.slice(2);
  if (
    !Object.prototype.hasOwnProperty.call(CLI_MODES, mode ?? '') ||
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
    const [migration, toolMode] = CLI_MODES[mode];
    console.log(JSON.stringify(await migration(client, { mode: toolMode, appRoot, branchId })));
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
