/**
 * Cutover 19.11.2026 (contracts 3.1, 6.1, 6.2 steps 2, 5 and 8; integration review R5): the
 * guarded owner steps of the cloud. On the VPS the full provision.mjs is never run (it rewrites
 * unrelated runtime ACL, docs/operations/stage2-2026-10-24/README.md), so cloud 073 (posSales
 * projection, lane pos) and 074 (back-office cutover, lane cloud) and the grants of each cutover
 * flag go through this tool only, modelled on stage2-cloud-owner.mjs:
 *
 *   node infra/staging/cutover-cloud-owner.mjs inspect
 *   node infra/staging/cutover-cloud-owner.mjs deploy
 *   node infra/staging/cutover-cloud-owner.mjs flag <pos-sales-sync|roles|stock-v2|sales-report> <true|false>
 *   node infra/staging/cutover-cloud-owner.mjs inspect-075
 *   node infra/staging/cutover-cloud-owner.mjs deploy-075
 *   node infra/staging/cutover-cloud-owner.mjs p1-grants <none|pos-day,stock-v2,autoconsume,manager-shifts,staff-positions,discounts>
 *   node infra/staging/cutover-cloud-owner.mjs inspect-076
 *   node infra/staging/cutover-cloud-owner.mjs deploy-076
 *   node infra/staging/cutover-cloud-owner.mjs supply-grants <none|supply,staff-assignment>
 *   node infra/staging/cutover-cloud-owner.mjs inspect-077
 *   node infra/staging/cutover-cloud-owner.mjs deploy-077
 *   node infra/staging/cutover-cloud-owner.mjs expenses-grants <on|off>
 *   node infra/staging/cutover-cloud-owner.mjs compose-candidate --compose <file> --sha256 <hex> --out <file>
 *   node infra/staging/cutover-cloud-owner.mjs compose-supply --compose <file> --sha256 <hex> --out <file>
 *   node infra/staging/cutover-cloud-owner.mjs compose-expenses --compose <file> --sha256 <hex> --out <file>
 *   node infra/staging/cutover-cloud-owner.mjs compose-flag <flag> <true|false> --compose <file> --sha256 <hex> --out <file>
 *
 * inspect/deploy/flag run inside the candidate API image as the cloud owner (CLOUD_DATABASE_URL
 * of pickchick_owner on pickchick_cloud), in ONE repeatable-read transaction, for the API role
 * pickchick_app:
 * - deploy: exact schema072 ledger (every file byte for byte), the reviewed bytes of 072/073/074,
 *   then 073 and 074 in order with their ledger rows, then the grants of provision.mjs's
 *   cutover:integration block with every cutover flag off (cloudPosSalesGrants receiver off,
 *   then backofficeCutoverGrants roles off, then both exact checks). Existing tables keep their
 *   columns (074 adds bo_stock_documents.reason_code and meta) and rows, role attributes stay,
 *   the API role gains exactly the back-office read set of 073 (none without BACKOFFICE_ENABLED).
 *   A repeat is refused; 072 is applied by its own С4 release, never here. Files after 074
 *   (cloud 075 of the bo-ui lane) are not touched.
 * - flag: the grants of ONE flag, the same reset and checks as provision.mjs, exact delta, nothing
 *   else on the role changes. Enable = grants first, then the API environment; disable = the API
 *   environment first, then the grants. stock-v2 and sales-report change no grant: they prove the
 *   rights the feature needs. Flags of the back office need BACKOFFICE_ENABLED grants.
 * - inspect-075 / deploy-075 (lane bo-ui, CR bo-ui-1 sections 3-4, CR bo-ui-6 section 2, CR bo-ui-9):
 *   cloud 075_cloud_backoffice_ops.sql as its own step on an exact schema074 ledger (every file
 *   001-074 byte for byte), the reviewed bytes of 075 (SHA-256 below), then the cutover:bo-ui
 *   block of provision.mjs with every P1 flag off: no right on any 075 relation, nothing else on
 *   the role changes; existing tables keep their rows, 075 adds three columns. A repeat is refused;
 *   files after 075 (cloud 076 of lane bo-ui2) are not touched.
 * - p1-grants: the grants of exactly the listed P1 flags (the helper backofficeP1Grants with the
 *   same reset and exact check as provision.mjs's cutover:bo-ui block): the 075 relations get
 *   exactly that set, outside 075 only the helper's declared SELECTs are added (they stay when a
 *   flag goes off: other helpers own their reset). The list names every P1 flag that is (or is
 *   about to be) on in the API environment, stock-v2 included when stock P1 is wanted;
 *   autoconsume needs stock-v2; any flag needs BACKOFFICE_ENABLED grants. Enable = grants first,
 *   then the API environment; disable = the API environment first, then the grants.
 * - inspect-076 / deploy-076 (lane bo-ui2, CR bo-ui2-1): cloud 076_cloud_backoffice_supply.sql as
 *   its own step on an exact schema075 ledger (every file 001-075 byte for byte), the reviewed
 *   bytes of 076 (SHA-256 below), then the second-wave helper with every second-wave flag off: no
 *   right on any 076 relation, nothing else on the role changes; existing tables keep their
 *   columns and rows (076 only creates). A repeat is refused; later files are not touched. The
 *   full provision.mjs is still never run on the VPS.
 * - supply-grants: the grants of exactly the listed second-wave flags on the 076 relations (the
 *   helper backofficeSupplyGrants with its exact check); nothing outside 076 changes.
 *   staff-assignment needs the staff-positions rights of p1-grants first. stock reports have no
 *   grant of their own. Enable = grants first, then the API environment; disable = the reverse.
 * - inspect-077 / deploy-077 («Расходы», owner request 11.11.2026, docs/operations/
 *   backoffice-expenses.md): cloud 077_cloud_backoffice_expenses.sql as its own step on an exact
 *   schema076 ledger (every file 001-076 byte for byte), the reviewed bytes of 077 (SHA-256
 *   below), then the expenses helper with the flag off: no right on any 077 relation, nothing
 *   else on the role changes; existing tables keep their columns and rows (077 only creates).
 *   A repeat is refused; later files are not touched.
 * - expenses-grants on|off: the rights of BACKOFFICE_EXPENSES_ENABLED on the 077 relations (the
 *   helper backofficeExpensesGrants), exact delta, nothing outside 077 changes. Needs
 *   BACKOFFICE_ENABLED grants. On = grants first, then the API environment; off = the reverse.
 * - compose-candidate / compose-flag: the guarded API environment step on a copy of the installed
 *   compose (no database): the installed file must have the reviewed SHA-256; the candidate adds
 *   only the literal cutover flag lines, all "false" (api and provision services, like the
 *   release scripts' compose_candidate); a flag run flips only that one key. The result goes to a
 *   new file; both SHA-256 are printed for the release record.
 * - compose-supply: the same guarded step for lane bo-ui2: a compose that already carries the
 *   cutover keys gets the three second-wave keys in the api service, all "false". compose-flag
 *   then flips supply, stock-reports or staff-assignment, only after the cutover flag the API
 *   itself requires (stock-v2, staff-positions), and refuses to turn that one off before them.
 * - compose-expenses: a compose that already carries the second-wave keys gets
 *   BACKOFFICE_EXPENSES_ENABLED "false" in the api service; compose-flag expenses flips it.
 * Output is names, booleans and hashes, never row data or the connection string.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fingerprint, OwnerGuardError, runtimePrivileges } from './unified-menu-owner.mjs';
import {
  BACKOFFICE_PRIVILEGES,
  POS_SALES_RELATIONS,
  RUNTIME_PRIVILEGES,
  assertCloudPosSalesPrivileges,
  cloudPosSalesGrants,
} from './pos-sales-grants.mjs';
import {
  SALES_REPORT_TABLES,
  assertBackofficeCutoverPrivileges,
  backofficeCutoverGrants,
} from './backoffice-cutover-grants.mjs';
import {
  BACKOFFICE_P1_RELATIONS,
  MIGRATION as P1_MIGRATION,
  P1_COLUMNS,
  assertBackofficeP1Privileges,
  backofficeP1Grants,
  backofficeP1Privileges,
  backofficeP1Reads,
} from './backoffice-p1-grants.mjs';
import {
  BACKOFFICE_SUPPLY_RELATIONS,
  MIGRATION as SUPPLY_MIGRATION,
  assertBackofficeSupplyPrivileges,
  backofficeSupplyGrants,
  backofficeSupplyPrivileges,
} from './backoffice-supply-grants.mjs';
import {
  BACKOFFICE_EXPENSES_RELATIONS,
  MIGRATION as EXPENSES_MIGRATION,
  backofficeExpensesGrants,
  backofficeExpensesPrivileges,
} from './backoffice-expenses-grants.mjs';

export const BASELINE = '072_cloud_kitchen_restore_review.sql';
export const MIGRATIONS = Object.freeze([
  '073_cloud_pos_sales_sync.sql',
  '074_cloud_backoffice_cutover.sql',
]);
/** Reviewed bytes (SHA-256, master runbook section 2.2) of the baseline and of both files. */
export const CHECKSUMS = Object.freeze({
  '072_cloud_kitchen_restore_review.sql':
    'd222ea9bf0aeebcaaeea96bc119c9b8aa3e1d9f032a1af7914aefe5c8981c5e2',
  '073_cloud_pos_sales_sync.sql':
    '1d649530705ecfaee8e297a047dda99541c8a310fe7e422a230365f02e5c13b0',
  '074_cloud_backoffice_cutover.sql':
    'ead3064f692da4712e6cd365f7fcae9a4e296970a2ab07cd411f1b9f2b5ffc73',
});
/** Tables 073/074 create, and the two columns 074 adds to an existing table. */
export const NEW_TABLES = Object.freeze([
  ...Object.keys(POS_SALES_RELATIONS),
  'bo_role_designations',
]);
export const ADDED_COLUMNS = Object.freeze({ bo_stock_documents: ['reason_code', 'meta'] });
/** Flags with database grants (or proofs) and their API environment keys. */
export const FLAGS = Object.freeze({
  'pos-sales-sync': 'CLOUD_POS_SALES_SYNC_ENABLED',
  roles: 'BACKOFFICE_ROLES_ENABLED',
  'stock-v2': 'BACKOFFICE_STOCK_V2_ENABLED',
  'sales-report': 'BACKOFFICE_SALES_REPORT_ENABLED',
});
/** Cloud 075 of lane bo-ui (CR bo-ui-6 section 2, CR bo-ui-9: SHA-256 of the reviewed file). */
export { P1_MIGRATION };
export const P1_CHECKSUM = 'c3c192ceafd149a9bd9151e3954f4b8d182b6c1886ee627d1a8651c61cc8f786';
/** Tables 075 creates, and the three columns it adds to existing tables (P1_COLUMNS). */
export const P1_TABLES = Object.freeze(Object.keys(BACKOFFICE_P1_RELATIONS));
export const P1_ADDED_COLUMNS = P1_COLUMNS;
/**
 * Back-office P1 flags of p1-grants: the key of backofficeP1Grants and the API environment key.
 * stock-v2 is the cloud lane's flag; stock P1 (storno, quick waste, menu links) rides on it.
 */
export const P1_FLAGS = Object.freeze({
  'pos-day': Object.freeze(['posDay', 'BACKOFFICE_POS_DAY_ENABLED']),
  'stock-v2': Object.freeze(['stockV2', 'BACKOFFICE_STOCK_V2_ENABLED']),
  autoconsume: Object.freeze(['autoconsume', 'BACKOFFICE_STOCK_AUTOCONSUME_ENABLED']),
  'manager-shifts': Object.freeze(['managerShifts', 'BACKOFFICE_MANAGER_SHIFTS_ENABLED']),
  'staff-positions': Object.freeze(['staffPositions', 'BACKOFFICE_STAFF_POSITIONS_ENABLED']),
  discounts: Object.freeze(['discounts', 'BACKOFFICE_DISCOUNTS_ENABLED']),
});
/** The five P1 keys of the API environment that are new (stock-v2 is already a cutover key). */
const P1_COMPOSE = Object.freeze(
  Object.fromEntries(
    Object.entries(P1_FLAGS)
      .filter(([name]) => name !== 'stock-v2')
      .map(([name, [, key]]) => [name, key]),
  ),
);
/** Every cutover key of the API environment (aggregator prices has no grant). */
export const COMPOSE_FLAGS = Object.freeze({
  ...FLAGS,
  'aggregator-prices': 'CATALOG_AGGREGATOR_PRICES_ENABLED',
  ...P1_COMPOSE,
});
/** Keys the provision service also carries (they choose grants in provision.mjs). */
export const PROVISION_KEYS = Object.freeze([
  'CLOUD_POS_SALES_SYNC_ENABLED',
  'BACKOFFICE_ROLES_ENABLED',
  'BACKOFFICE_STOCK_V2_ENABLED',
  'BACKOFFICE_SALES_REPORT_ENABLED',
  ...Object.values(P1_COMPOSE),
]);
/** Cloud 076 of lane bo-ui2 (CR bo-ui2-1: SHA-256 of the reviewed file) and the tables it creates. */
export { SUPPLY_MIGRATION };
export const SUPPLY_CHECKSUM = '436131f9854b5f4c024ab1492c2b7857bd14925e2398dc092548dadc25e693a3';
export const SUPPLY_TABLES = Object.freeze(Object.keys(BACKOFFICE_SUPPLY_RELATIONS));
/**
 * Second-wave flags of supply-grants: the key of backofficeSupplyGrants and the API environment
 * key. BACKOFFICE_STOCK_REPORTS_ENABLED has no grant (it reads what the stock flags already give).
 */
export const SUPPLY_FLAGS = Object.freeze({
  supply: Object.freeze(['supply', 'BACKOFFICE_SUPPLY_ENABLED']),
  'staff-assignment': Object.freeze(['staffAssignment', 'BACKOFFICE_STAFF_ASSIGNMENT_ENABLED']),
});
/**
 * Second-wave keys of the API environment (compose-supply adds them, compose-flag flips them).
 * The API refuses to start with supply or stock-reports on while stock v2 is off, and with
 * staff-assignment on while staff positions are off (packages/platform config), so the same
 * order is kept here: `requires` is the cutover flag that must already be "true".
 */
export const SUPPLY_COMPOSE = Object.freeze({
  supply: Object.freeze({ key: 'BACKOFFICE_SUPPLY_ENABLED', requires: 'stock-v2' }),
  'stock-reports': Object.freeze({
    key: 'BACKOFFICE_STOCK_REPORTS_ENABLED',
    requires: 'stock-v2',
  }),
  'staff-assignment': Object.freeze({
    key: 'BACKOFFICE_STAFF_ASSIGNMENT_ENABLED',
    requires: 'staff-positions',
  }),
});
/** Cloud 077 «Расходы» (SHA-256 of the reviewed file) and the tables it creates. */
export { EXPENSES_MIGRATION };
export const EXPENSES_CHECKSUM = 'af585ccadaed5ea51e416a904e2e729308904a949a16ae34d88a7aee076b6988';
export const EXPENSES_TABLES = Object.freeze([...BACKOFFICE_EXPENSES_RELATIONS]);
/** The API environment key of the section (compose-expenses adds it, compose-flag flips it). */
export const EXPENSES_COMPOSE = Object.freeze({ expenses: 'BACKOFFICE_EXPENSES_ENABLED' });
export const API_ROLE = 'pickchick_app';
/** Back-office grants on (backofficeGrants(role, true)), as in stage2-cloud-owner.mjs. */
const BACKOFFICE_MARKER = 'bo_commands||INSERT';
const RECEIVER_MARKER = 'cloud_pos_sale_inbox||INSERT';
const ROLES_MARKER = 'bo_role_designations||SELECT';
const POSITIONS_MARKER = 'bo_branch_templates||SELECT';
const LOCK = 724001; // Same advisory lock as @pickchick/database migrate().
const ROLE = /^[a-z][a-z0-9_]{0,62}$/;
const SHA = /^[a-f0-9]{64}$/;

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const guard = (ok, message) => {
  if (!ok) throw new OwnerGuardError(message);
};
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const union = (a, b) => [...new Set([...a, ...b])].sort();
const minus = (a, b) => a.filter((x) => !b.includes(x));

/** A privilege map of pos-sales-grants.mjs as runtimePrivileges strings (table|column|privilege). */
function privilegeStrings(map) {
  const out = [];
  for (const [table, list] of Object.entries(map))
    for (const item of list) {
      const columns = /^UPDATE\(([a-z_,]+)\)$/.exec(item);
      if (columns)
        for (const column of columns[1].split(',')) out.push(`${table}|${column}|UPDATE`);
      else out.push(`${table}||${item}`);
    }
  return out;
}
const cutoverPrivilege = (privilege) => NEW_TABLES.includes(privilege.split('|')[0]);
/** The exact cutover rights of the API role for a grant state (provision.mjs cutover block). */
export function cutoverPrivileges({ receiver, backoffice, roles }) {
  const pos = receiver ? RUNTIME_PRIVILEGES : backoffice ? BACKOFFICE_PRIVILEGES : {};
  return union(privilegeStrings(pos), [
    ...(backoffice ? SALES_REPORT_TABLES.map((t) => `${t}||SELECT`) : []),
    ...(backoffice && roles ? [ROLES_MARKER] : []),
  ]);
}
const stateOf = (acl) => ({
  backoffice: acl.includes(BACKOFFICE_MARKER),
  receiver: acl.includes(RECEIVER_MARKER),
  roles: acl.includes(ROLES_MARKER),
});
async function currentSchema(c) {
  const schema = (await c.query('SELECT current_schema() AS s')).rows[0].s;
  guard(ROLE.test(schema ?? ''), 'Unexpected schema');
  return schema;
}
/** The provision.mjs cutover:integration block for one state, with its exact checks. */
async function cutoverGrants(c, role, schema, state, proofs = {}) {
  const posSales = { receiver: state.receiver, backoffice: state.backoffice };
  const cutover = { backoffice: state.backoffice, roles: state.roles };
  await c.query(cloudPosSalesGrants(role, posSales, schema));
  await c.query(backofficeCutoverGrants(role, cutover, schema));
  await assertCloudPosSalesPrivileges(c, role, posSales, schema);
  await assertBackofficeCutoverPrivileges(
    c,
    role,
    { ...cutover, stockV2: proofs.stockV2 === true, salesReport: proofs.salesReport === true },
    schema,
  );
}

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

/**
 * Repository files up to 074 (or up to 075 with `p1`, up to 076 with `supply`, up to 077 with
 * `expenses`) with the reviewed bytes of 072/073/074 (and 075, 076, 077); later files are ignored.
 */
async function candidate(directory, p1 = false, supply = false, expenses = false) {
  const all = (await readdir(directory)).filter((n) => /^\d{3}_[a-z0-9_]+\.sql$/.test(n)).sort();
  const at = all.indexOf(MIGRATIONS[0]);
  guard(
    at > 0 && all[at - 1] === BASELINE && all[at + 1] === MIGRATIONS[1],
    'Exact 072, 073 and 074 candidate files required',
  );
  if (p1) guard(all[at + 2] === P1_MIGRATION, 'Exact 075 candidate file required');
  if (supply) guard(all[at + 3] === SUPPLY_MIGRATION, 'Exact 076 candidate file required');
  if (expenses) guard(all[at + 4] === EXPENSES_MIGRATION, 'Exact 077 candidate file required');
  const files = all.slice(0, at + (expenses ? 5 : supply ? 4 : p1 ? 3 : 2));
  const sql = new Map(
    await Promise.all(files.map(async (n) => [n, await readFile(join(directory, n), 'utf8')])),
  );
  for (const [name, checksum] of Object.entries(CHECKSUMS))
    guard(sha256(sql.get(name)) === checksum, 'Reviewed migration bytes differ: ' + name);
  if (p1)
    guard(
      sha256(sql.get(P1_MIGRATION)) === P1_CHECKSUM,
      'Reviewed migration bytes differ: ' + P1_MIGRATION,
    );
  if (supply)
    guard(
      sha256(sql.get(SUPPLY_MIGRATION)) === SUPPLY_CHECKSUM,
      'Reviewed migration bytes differ: ' + SUPPLY_MIGRATION,
    );
  if (expenses)
    guard(
      sha256(sql.get(EXPENSES_MIGRATION)) === EXPENSES_CHECKSUM,
      'Reviewed migration bytes differ: ' + EXPENSES_MIGRATION,
    );
  return { files, sql, baseline: at };
}
const exactPrefix = (ledger, files, sql, count) =>
  ledger.length >= count &&
  ledger
    .slice(0, count)
    .every(
      (r, i) =>
        r.version === files[i] && r.scope === 'cloud' && r.checksum === sha256(sql.get(r.version)),
    );

export async function deployCutover(c, { directory, role = API_ROLE, inspect = false }) {
  guard(ROLE.test(role), 'Invalid runtime role');
  await c.query("SET LOCAL lock_timeout='5s';SET LOCAL statement_timeout='300s'");
  if (!inspect) await c.query('SELECT pg_advisory_xact_lock($1)', [LOCK]);
  const schema = await currentSchema(c);
  const { files, sql, baseline } = await candidate(directory);
  const ledger = await ledgerOf(c);
  const at072 = ledger.length === baseline && exactPrefix(ledger, files, sql, baseline);
  const at074 = exactPrefix(ledger, files, sql, files.length);
  guard(
    at072 || at074,
    'Exact schema072 ledger required (072 by its own C4 release; do not replay a partial apply)',
  );
  const acl = await runtimePrivileges(c, role);
  const state = stateOf(acl);
  const expected = cutoverPrivileges({ ...state, receiver: false, roles: false });
  if (inspect)
    return {
      ledger: at072 ? 'schema072' : 'schema074',
      pending: at072 ? [...MIGRATIONS] : [],
      reviewedBytes: true,
      backofficeGrants: state.backoffice,
      privilegesAdded: at072 ? expected : [],
      flags: at074
        ? { posSalesSync: state.receiver, roles: state.roles }
        : { posSalesSync: false, roles: false },
    };
  guard(at072, 'Cloud 073/074 are already applied: deploy runs once');
  const before = await columns(c);
  guard(
    NEW_TABLES.every((t) => !(t in before)),
    'Cutover tables already exist',
  );
  for (const [table, added] of Object.entries(ADDED_COLUMNS))
    guard(
      table in before && added.every((name) => !before[table].includes(name)),
      'Cutover columns already exist',
    );
  guard(!acl.some(cutoverPrivilege), 'Unexpected cutover privileges before deploy');
  const existing = Object.fromEntries(
    Object.entries(before).filter(([n]) => n !== 'schema_migrations'),
  );
  const data = await fingerprint(c, existing);
  const rolesBefore = await roles(c);
  const appended = [];
  for (const name of MIGRATIONS) {
    await c.query(sql.get(name));
    const row = { version: name, checksum: sha256(sql.get(name)), scope: 'cloud' };
    await c.query('INSERT INTO schema_migrations(version,checksum,scope) VALUES($1,$2,$3)', [
      row.version,
      row.checksum,
      row.scope,
    ]);
    appended.push(row);
  }
  // Every cutover flag off: what provision.mjs grants with them unset.
  await cutoverGrants(c, role, schema, { ...state, receiver: false, roles: false });
  const after = await columns(c);
  guard(
    equal(Object.keys(after).sort(), [...Object.keys(before), ...NEW_TABLES].sort()),
    'Unexpected tables',
  );
  for (const [t, cols] of Object.entries(before))
    guard(equal(after[t], [...cols, ...(ADDED_COLUMNS[t] ?? [])]), 'Existing columns changed');
  guard(equal(await fingerprint(c, existing), data), 'Existing rows changed');
  guard(equal(await roles(c), rolesBefore), 'Role attributes changed');
  guard(
    equal(await runtimePrivileges(c, role), union(acl, expected)),
    'Unexpected privilege delta',
  );
  guard(equal(await ledgerOf(c), [...ledger, ...appended]), 'Ledger changed');
  return {
    applied: [...MIGRATIONS],
    existingDataPreserved: true,
    backofficeGrants: state.backoffice,
    privilegesAdded: expected,
    privilegesRemoved: [],
    flags: { posSalesSync: false, roles: false, stockV2: false, salesReport: false },
  };
}

/** Grants (or proofs) of one cutover flag; exact delta, nothing else on the role changes. */
export async function setCutoverFlag(c, { role = API_ROLE, flag, enabled }) {
  guard(ROLE.test(role) && flag in FLAGS && typeof enabled === 'boolean', 'Invalid flag');
  await c.query("SET LOCAL lock_timeout='5s';SET LOCAL statement_timeout='60s'");
  await c.query('SELECT pg_advisory_xact_lock($1)', [LOCK]);
  const schema = await currentSchema(c);
  const applied = new Map((await ledgerOf(c)).map((r) => [r.version, r.checksum]));
  guard(
    MIGRATIONS.every((m) => applied.get(m) === CHECKSUMS[m]),
    'Run deploy (073/074 with the reviewed bytes) first',
  );
  const acl = await runtimePrivileges(c, role);
  const state = stateOf(acl);
  guard(
    equal(acl.filter(cutoverPrivilege), cutoverPrivileges(state)),
    'Cutover grants differ from every known flag state: run inspect',
  );
  guard(
    !enabled || flag === 'pos-sales-sync' || state.backoffice,
    'BACKOFFICE_ENABLED grants are required first',
  );
  const target = {
    ...state,
    ...(flag === 'pos-sales-sync' ? { receiver: enabled } : {}),
    ...(flag === 'roles' ? { roles: enabled } : {}),
  };
  const rolesBefore = await roles(c);
  await cutoverGrants(c, role, schema, target, {
    stockV2: flag === 'stock-v2' && enabled,
    salesReport: flag === 'sales-report' && enabled,
  });
  const want = union(
    acl.filter((p) => !cutoverPrivilege(p)),
    cutoverPrivileges(target),
  );
  const now = await runtimePrivileges(c, role);
  guard(equal(now, want), 'Unexpected privilege delta');
  guard(equal(await roles(c), rolesBefore), 'Role attributes changed');
  return {
    flag,
    enabled,
    privilegesAdded: minus(now, acl),
    privilegesRemoved: minus(acl, now),
    environment: FLAGS[flag],
    order: enabled
      ? 'grants done; now set the API environment and restart the API'
      : 'run after the API environment is off and the API restarted',
  };
}

// ------------------------------------------------------- back-office P1 (lane bo-ui, 075) ----
const p1Privilege = (privilege) => P1_TABLES.includes(privilege.split('|')[0]);
/** backofficeP1Grants options of a P1 flag list (names of P1_FLAGS) and the back-office switch. */
function p1Options(backoffice, enabled) {
  return Object.fromEntries([
    ['backoffice', backoffice],
    ...Object.entries(P1_FLAGS).map(([name, [key]]) => [key, enabled.includes(name)]),
  ]);
}
/** The exact rights of the API role on the 075 relations for a P1 state (runtimePrivileges form). */
export function p1Privileges(backoffice, enabled) {
  return privilegeStrings(backofficeP1Privileges(p1Options(backoffice, enabled))).sort();
}
const P1_STATES = (() => {
  const names = Object.keys(P1_FLAGS);
  const lists = [];
  for (let mask = 0; mask < 2 ** names.length; mask += 1) {
    const list = names.filter((_, i) => mask & (1 << i));
    if (!list.includes('autoconsume') || list.includes('stock-v2')) lists.push(list);
  }
  return Object.freeze(lists);
})();
/** Every 075 right set p1-grants can leave (each valid flag list, with and without the back office). */
const knownP1 = (acl) =>
  [true, false].some((backoffice) =>
    P1_STATES.some((list) => equal(acl.filter(p1Privilege), p1Privileges(backoffice, list))),
  );

/** inspect-075 / deploy-075: cloud 075 on exact schema074 with every P1 flag off (module comment). */
export async function deployBackofficeP1(c, { directory, role = API_ROLE, inspect = false }) {
  guard(ROLE.test(role), 'Invalid runtime role');
  await c.query("SET LOCAL lock_timeout='5s';SET LOCAL statement_timeout='300s'");
  if (!inspect) await c.query('SELECT pg_advisory_xact_lock($1)', [LOCK]);
  const schema = await currentSchema(c);
  const { files, sql } = await candidate(directory, true);
  const ledger = await ledgerOf(c);
  const at074 =
    ledger.length === files.length - 1 && exactPrefix(ledger, files, sql, files.length - 1);
  const at075 = ledger.length === files.length && exactPrefix(ledger, files, sql, files.length);
  guard(
    at074 || at075,
    'Exact schema074 ledger required (073/074 by deploy first; do not replay a partial apply)',
  );
  const acl = await runtimePrivileges(c, role);
  const backoffice = acl.includes(BACKOFFICE_MARKER);
  if (inspect)
    return {
      ledger: at074 ? 'schema074' : 'schema075',
      pending: at074 ? [P1_MIGRATION] : [],
      reviewedBytes: true,
      backofficeGrants: backoffice,
      privilegesAdded: [],
      p1Privileges: acl.filter(p1Privilege),
    };
  guard(at074, 'Cloud 075 is already applied: deploy-075 runs once');
  const before = await columns(c);
  guard(
    P1_TABLES.every((t) => !(t in before)),
    'Back-office P1 tables already exist',
  );
  for (const [table, added] of Object.entries(P1_ADDED_COLUMNS))
    guard(
      table in before && added.every((name) => !before[table].includes(name)),
      'Back-office P1 columns already exist',
    );
  guard(!acl.some(p1Privilege), 'Unexpected back-office P1 privileges before deploy');
  const existing = Object.fromEntries(
    Object.entries(before).filter(([n]) => n !== 'schema_migrations'),
  );
  const data = await fingerprint(c, existing);
  const rolesBefore = await roles(c);
  await c.query(sql.get(P1_MIGRATION));
  const row = { version: P1_MIGRATION, checksum: sha256(sql.get(P1_MIGRATION)), scope: 'cloud' };
  await c.query('INSERT INTO schema_migrations(version,checksum,scope) VALUES($1,$2,$3)', [
    row.version,
    row.checksum,
    row.scope,
  ]);
  // Every P1 flag off: what the cutover:bo-ui block of provision.mjs grants with them unset.
  const off = p1Options(backoffice, []);
  await c.query(backofficeP1Grants(role, off, schema));
  await assertBackofficeP1Privileges(c, role, off, schema);
  const after = await columns(c);
  guard(
    equal(Object.keys(after).sort(), [...Object.keys(before), ...P1_TABLES].sort()),
    'Unexpected tables',
  );
  for (const [t, cols] of Object.entries(before))
    guard(equal(after[t], [...cols, ...(P1_ADDED_COLUMNS[t] ?? [])]), 'Existing columns changed');
  guard(equal(await fingerprint(c, existing), data), 'Existing rows changed');
  guard(equal(await roles(c), rolesBefore), 'Role attributes changed');
  guard(equal(await runtimePrivileges(c, role), acl), 'Unexpected privilege delta');
  guard(equal(await ledgerOf(c), [...ledger, row]), 'Ledger changed');
  return {
    applied: [P1_MIGRATION],
    existingDataPreserved: true,
    backofficeGrants: backoffice,
    privilegesAdded: [],
    privilegesRemoved: [],
    p1Flags: [],
  };
}

/** p1-grants: the P1 grants of exactly `enabled` (module comment); exact delta. */
export async function setBackofficeP1(c, { role = API_ROLE, enabled }) {
  guard(
    ROLE.test(role) &&
      Array.isArray(enabled) &&
      enabled.every((name) => name in P1_FLAGS) &&
      new Set(enabled).size === enabled.length,
    'Invalid P1 flags',
  );
  guard(
    !enabled.includes('autoconsume') || enabled.includes('stock-v2'),
    'autoconsume requires stock-v2',
  );
  await c.query("SET LOCAL lock_timeout='5s';SET LOCAL statement_timeout='60s'");
  await c.query('SELECT pg_advisory_xact_lock($1)', [LOCK]);
  const schema = await currentSchema(c);
  const applied = new Map((await ledgerOf(c)).map((r) => [r.version, r.checksum]));
  guard(
    MIGRATIONS.every((m) => applied.get(m) === CHECKSUMS[m]) &&
      applied.get(P1_MIGRATION) === P1_CHECKSUM,
    'Run deploy-075 (075 with the reviewed bytes) first',
  );
  const acl = await runtimePrivileges(c, role);
  const backoffice = acl.includes(BACKOFFICE_MARKER);
  guard(enabled.length === 0 || backoffice, 'BACKOFFICE_ENABLED grants are required first');
  guard(knownP1(acl), 'Back-office P1 grants differ from every known flag state: run inspect-075');
  const target = p1Options(backoffice, enabled);
  const rolesBefore = await roles(c);
  await c.query(backofficeP1Grants(role, target, schema));
  await assertBackofficeP1Privileges(c, role, target, schema);
  const now = await runtimePrivileges(c, role);
  const reads = backofficeP1Reads(target).map((table) => `${table}||SELECT`);
  guard(
    equal(
      now,
      union(
        union(
          acl.filter((p) => !p1Privilege(p)),
          reads,
        ),
        p1Privileges(backoffice, enabled),
      ),
    ),
    'Unexpected privilege delta',
  );
  guard(equal(await roles(c), rolesBefore), 'Role attributes changed');
  const flags = Object.keys(P1_FLAGS).filter((name) => enabled.includes(name));
  return {
    p1Flags: flags,
    privilegesAdded: minus(now, acl),
    privilegesRemoved: minus(acl, now),
    environment: flags.map((name) => P1_FLAGS[name][1]),
    order: 'grants set; the API environment must name exactly these P1 flags (restart the API)',
  };
}

// ------------------------------------------------- back-office second wave (lane bo-ui2, 076) ----
const supplyPrivilege = (privilege) => SUPPLY_TABLES.includes(privilege.split('|')[0]);
/** backofficeSupplyGrants options of a second-wave flag list and the back-office switch. */
function supplyOptions(backoffice, enabled) {
  return {
    backoffice,
    supply: enabled.includes('supply'),
    stockReports: false,
    staffAssignment: enabled.includes('staff-assignment'),
  };
}
/** The exact rights of the API role on the 076 relations for a second-wave state. */
export function supplyPrivileges(backoffice, enabled) {
  return privilegeStrings(backofficeSupplyPrivileges(supplyOptions(backoffice, enabled))).sort();
}
const SUPPLY_STATES = Object.freeze([
  [],
  ['supply'],
  ['staff-assignment'],
  ['supply', 'staff-assignment'],
]);
const knownSupply = (acl) =>
  [true, false].some((backoffice) =>
    SUPPLY_STATES.some((list) =>
      equal(acl.filter(supplyPrivilege), supplyPrivileges(backoffice, list)),
    ),
  );

/** inspect-076 / deploy-076: cloud 076 on exact schema075 with every second-wave flag off. */
export async function deployBackofficeSupply(c, { directory, role = API_ROLE, inspect = false }) {
  guard(ROLE.test(role), 'Invalid runtime role');
  await c.query("SET LOCAL lock_timeout='5s';SET LOCAL statement_timeout='300s'");
  if (!inspect) await c.query('SELECT pg_advisory_xact_lock($1)', [LOCK]);
  const schema = await currentSchema(c);
  const { files, sql } = await candidate(directory, true, true);
  const ledger = await ledgerOf(c);
  const at075 =
    ledger.length === files.length - 1 && exactPrefix(ledger, files, sql, files.length - 1);
  const at076 = ledger.length === files.length && exactPrefix(ledger, files, sql, files.length);
  guard(
    at075 || at076,
    'Exact schema075 ledger required (075 by deploy-075 first; do not replay a partial apply)',
  );
  const acl = await runtimePrivileges(c, role);
  const backoffice = acl.includes(BACKOFFICE_MARKER);
  if (inspect)
    return {
      ledger: at075 ? 'schema075' : 'schema076',
      pending: at075 ? [SUPPLY_MIGRATION] : [],
      reviewedBytes: true,
      backofficeGrants: backoffice,
      privilegesAdded: [],
      supplyPrivileges: acl.filter(supplyPrivilege),
    };
  guard(at075, 'Cloud 076 is already applied: deploy-076 runs once');
  const before = await columns(c);
  guard(
    SUPPLY_TABLES.every((t) => !(t in before)),
    'Back-office second-wave tables already exist',
  );
  guard(!acl.some(supplyPrivilege), 'Unexpected back-office second-wave privileges before deploy');
  const existing = Object.fromEntries(
    Object.entries(before).filter(([n]) => n !== 'schema_migrations'),
  );
  const data = await fingerprint(c, existing);
  const rolesBefore = await roles(c);
  await c.query(sql.get(SUPPLY_MIGRATION));
  const row = {
    version: SUPPLY_MIGRATION,
    checksum: sha256(sql.get(SUPPLY_MIGRATION)),
    scope: 'cloud',
  };
  await c.query('INSERT INTO schema_migrations(version,checksum,scope) VALUES($1,$2,$3)', [
    row.version,
    row.checksum,
    row.scope,
  ]);
  // Every second-wave flag off: what the helper leaves in provision.mjs with them unset.
  const off = supplyOptions(backoffice, []);
  await c.query(backofficeSupplyGrants(role, off, schema));
  await assertBackofficeSupplyPrivileges(c, role, off, schema);
  const after = await columns(c);
  guard(
    equal(Object.keys(after).sort(), [...Object.keys(before), ...SUPPLY_TABLES].sort()),
    'Unexpected tables',
  );
  for (const [t, cols] of Object.entries(before))
    guard(equal(after[t], cols), 'Existing columns changed');
  guard(equal(await fingerprint(c, existing), data), 'Existing rows changed');
  guard(equal(await roles(c), rolesBefore), 'Role attributes changed');
  guard(equal(await runtimePrivileges(c, role), acl), 'Unexpected privilege delta');
  guard(equal(await ledgerOf(c), [...ledger, row]), 'Ledger changed');
  return {
    applied: [SUPPLY_MIGRATION],
    existingDataPreserved: true,
    backofficeGrants: backoffice,
    privilegesAdded: [],
    privilegesRemoved: [],
    supplyFlags: [],
  };
}

/** supply-grants: the second-wave grants of exactly `enabled` (module comment); exact delta. */
export async function setBackofficeSupply(c, { role = API_ROLE, enabled }) {
  guard(
    ROLE.test(role) &&
      Array.isArray(enabled) &&
      enabled.every((name) => name in SUPPLY_FLAGS) &&
      new Set(enabled).size === enabled.length,
    'Invalid second-wave flags',
  );
  await c.query("SET LOCAL lock_timeout='5s';SET LOCAL statement_timeout='60s'");
  await c.query('SELECT pg_advisory_xact_lock($1)', [LOCK]);
  const schema = await currentSchema(c);
  const applied = new Map((await ledgerOf(c)).map((r) => [r.version, r.checksum]));
  guard(
    MIGRATIONS.every((m) => applied.get(m) === CHECKSUMS[m]) &&
      applied.get(P1_MIGRATION) === P1_CHECKSUM &&
      applied.get(SUPPLY_MIGRATION) === SUPPLY_CHECKSUM,
    'Run deploy-076 (076 with the reviewed bytes) first',
  );
  const acl = await runtimePrivileges(c, role);
  const backoffice = acl.includes(BACKOFFICE_MARKER);
  guard(enabled.length === 0 || backoffice, 'BACKOFFICE_ENABLED grants are required first');
  guard(
    knownSupply(acl),
    'Back-office second-wave grants differ from every known flag state: run inspect-076',
  );
  // The stations of an assignment come from the list of positions, readable with the
  // staff-positions (or manager-shifts) rights of p1-grants (backoffice-supply-grants.mjs).
  guard(
    !enabled.includes('staff-assignment') || acl.includes(POSITIONS_MARKER),
    'staff-assignment requires the staff-positions grants of p1-grants first',
  );
  const target = supplyOptions(backoffice, enabled);
  const rolesBefore = await roles(c);
  await c.query(backofficeSupplyGrants(role, target, schema));
  await assertBackofficeSupplyPrivileges(c, role, target, schema);
  const now = await runtimePrivileges(c, role);
  guard(
    equal(
      now,
      union(
        acl.filter((p) => !supplyPrivilege(p)),
        supplyPrivileges(backoffice, enabled),
      ),
    ),
    'Unexpected privilege delta',
  );
  guard(equal(await roles(c), rolesBefore), 'Role attributes changed');
  const flags = Object.keys(SUPPLY_FLAGS).filter((name) => enabled.includes(name));
  return {
    supplyFlags: flags,
    privilegesAdded: minus(now, acl),
    privilegesRemoved: minus(acl, now),
    environment: flags.map((name) => SUPPLY_FLAGS[name][1]),
    order:
      'grants set; the API environment must name exactly these second-wave flags (restart the API)',
  };
}

// ------------------------------------------------------------ «Расходы» (cloud 077, 11.11) ----
const expensesPrivilege = (privilege) => EXPENSES_TABLES.includes(privilege.split('|')[0]);
/** The exact rights of the API role on the 077 relations. */
export function expensesPrivileges(backoffice, expenses) {
  return privilegeStrings(backofficeExpensesPrivileges({ backoffice, expenses })).sort();
}
const knownExpenses = (acl) =>
  [true, false].some((on) =>
    equal(acl.filter(expensesPrivilege).sort(), expensesPrivileges(true, on)),
  );

/** inspect-077 / deploy-077: cloud 077 on exact schema076 with the expenses flag off. */
export async function deployBackofficeExpenses(c, { directory, role = API_ROLE, inspect = false }) {
  guard(ROLE.test(role), 'Invalid runtime role');
  await c.query("SET LOCAL lock_timeout='5s';SET LOCAL statement_timeout='300s'");
  if (!inspect) await c.query('SELECT pg_advisory_xact_lock($1)', [LOCK]);
  const schema = await currentSchema(c);
  const { files, sql } = await candidate(directory, true, true, true);
  const ledger = await ledgerOf(c);
  const at076 =
    ledger.length === files.length - 1 && exactPrefix(ledger, files, sql, files.length - 1);
  const at077 = ledger.length === files.length && exactPrefix(ledger, files, sql, files.length);
  guard(
    at076 || at077,
    'Exact schema076 ledger required (076 by deploy-076 first; do not replay a partial apply)',
  );
  const acl = await runtimePrivileges(c, role);
  const backoffice = acl.includes(BACKOFFICE_MARKER);
  if (inspect)
    return {
      ledger: at076 ? 'schema076' : 'schema077',
      pending: at076 ? [EXPENSES_MIGRATION] : [],
      reviewedBytes: true,
      backofficeGrants: backoffice,
      privilegesAdded: [],
      expensesPrivileges: acl.filter(expensesPrivilege),
    };
  guard(at076, 'Cloud 077 is already applied: deploy-077 runs once');
  const before = await columns(c);
  guard(
    EXPENSES_TABLES.every((t) => !(t in before)),
    'Back-office expenses tables already exist',
  );
  guard(!acl.some(expensesPrivilege), 'Unexpected back-office expenses privileges before deploy');
  const existing = Object.fromEntries(
    Object.entries(before).filter(([n]) => n !== 'schema_migrations'),
  );
  const data = await fingerprint(c, existing);
  const rolesBefore = await roles(c);
  await c.query(sql.get(EXPENSES_MIGRATION));
  const row = {
    version: EXPENSES_MIGRATION,
    checksum: sha256(sql.get(EXPENSES_MIGRATION)),
    scope: 'cloud',
  };
  await c.query('INSERT INTO schema_migrations(version,checksum,scope) VALUES($1,$2,$3)', [
    row.version,
    row.checksum,
    row.scope,
  ]);
  // The flag off: the helper only revokes (077 grants nothing by itself).
  await c.query(backofficeExpensesGrants(role, { backoffice, expenses: false }, schema));
  const after = await columns(c);
  guard(
    equal(Object.keys(after).sort(), [...Object.keys(before), ...EXPENSES_TABLES].sort()),
    'Unexpected tables',
  );
  for (const [t, cols] of Object.entries(before))
    guard(equal(after[t], cols), 'Existing columns changed');
  guard(equal(await fingerprint(c, existing), data), 'Existing rows changed');
  guard(equal(await roles(c), rolesBefore), 'Role attributes changed');
  guard(equal(await runtimePrivileges(c, role), acl), 'Unexpected privilege delta');
  guard(equal(await ledgerOf(c), [...ledger, row]), 'Ledger changed');
  return {
    applied: [EXPENSES_MIGRATION],
    existingDataPreserved: true,
    backofficeGrants: backoffice,
    privilegesAdded: [],
    privilegesRemoved: [],
    expenses: false,
  };
}

/** expenses-grants on|off: the 077 rights of BACKOFFICE_EXPENSES_ENABLED; exact delta. */
export async function setBackofficeExpenses(c, { role = API_ROLE, enabled }) {
  guard(ROLE.test(role) && typeof enabled === 'boolean', 'Invalid expenses flag');
  await c.query("SET LOCAL lock_timeout='5s';SET LOCAL statement_timeout='60s'");
  await c.query('SELECT pg_advisory_xact_lock($1)', [LOCK]);
  const schema = await currentSchema(c);
  const applied = new Map((await ledgerOf(c)).map((r) => [r.version, r.checksum]));
  guard(
    applied.get(SUPPLY_MIGRATION) === SUPPLY_CHECKSUM &&
      applied.get(EXPENSES_MIGRATION) === EXPENSES_CHECKSUM,
    'Run deploy-077 (077 with the reviewed bytes) first',
  );
  const acl = await runtimePrivileges(c, role);
  const backoffice = acl.includes(BACKOFFICE_MARKER);
  guard(!enabled || backoffice, 'BACKOFFICE_ENABLED grants are required first');
  guard(
    !acl.some(expensesPrivilege) || knownExpenses(acl),
    'Back-office expenses grants differ from every known flag state: run inspect-077',
  );
  const rolesBefore = await roles(c);
  await c.query(backofficeExpensesGrants(role, { backoffice, expenses: enabled }, schema));
  const now = await runtimePrivileges(c, role);
  guard(
    equal(
      now,
      union(
        acl.filter((p) => !expensesPrivilege(p)),
        expensesPrivileges(backoffice, enabled),
      ),
    ),
    'Unexpected privilege delta',
  );
  guard(equal(await roles(c), rolesBefore), 'Role attributes changed');
  return {
    expenses: enabled,
    privilegesAdded: minus(now, acl),
    privilegesRemoved: minus(acl, now),
    environment: enabled ? [EXPENSES_COMPOSE.expenses] : [],
    order: enabled
      ? 'grants set; now set BACKOFFICE_EXPENSES_ENABLED "true" in the API environment (restart the API)'
      : 'grants removed; BACKOFFICE_EXPENSES_ENABLED must already be "false"',
  };
}

// --------------------------------------------------------------- API environment (compose) ----
const API_ANCHOR = '      CLOUD_DATABASE_URL: postgresql://pickchick_app:';
const OWNER_ANCHOR = '      CLOUD_DATABASE_URL: postgresql://pickchick_owner:';
const line = (key, value) => `      ${key}: "${value}"\n`;
const apiLines = (value = 'false') =>
  Object.values(COMPOSE_FLAGS)
    .map((key) => line(key, value))
    .join('');
const provisionLines = () => PROVISION_KEYS.map((key) => line(key, 'false')).join('');
const installed = (text, expected) =>
  guard(
    typeof text === 'string' && SHA.test(expected ?? '') && sha256(text) === expected,
    'Installed compose differs from the reviewed hash',
  );

/** Installed compose plus the cutover keys, all "false"; nothing else changes. */
export function composeCandidate(text, expectedSha256) {
  installed(text, expectedSha256);
  for (const key of Object.values(COMPOSE_FLAGS))
    guard(!text.includes(key + ':'), 'Installed compose already mentions ' + key);
  guard(
    text.split('\n' + API_ANCHOR).length === 2 && text.split('\n' + OWNER_ANCHOR).length === 2,
    'Compose database anchors differ',
  );
  const result = text
    .replace('\n' + API_ANCHOR, '\n' + apiLines() + API_ANCHOR)
    .replace('\n' + OWNER_ANCHOR, '\n' + provisionLines() + OWNER_ANCHOR);
  guard(
    result.replace(apiLines(), '').replace(provisionLines(), '') === text,
    'Compose candidate changed more than the flag lines',
  );
  return result;
}

const supplyLines = () =>
  Object.values(SUPPLY_COMPOSE)
    .map(({ key }) => line(key, 'false'))
    .join('');
/**
 * Compose that already carries the cutover keys (compose-candidate) plus the three second-wave
 * keys of the api service, all "false"; nothing else changes. The provision service gets none:
 * the second-wave grants are set by supply-grants, not by provision.
 */
export function composeSupply(text, expectedSha256) {
  installed(text, expectedSha256);
  for (const { key } of Object.values(SUPPLY_COMPOSE))
    guard(!text.includes(key + ':'), 'Installed compose already mentions ' + key);
  for (const key of Object.values(COMPOSE_FLAGS))
    guard(
      text.split(key + ':').length === (PROVISION_KEYS.includes(key) ? 3 : 2),
      'Installed compose lacks the cutover keys: run compose-candidate first',
    );
  guard(text.split('\n' + API_ANCHOR).length === 2, 'Compose database anchors differ');
  const result = text.replace('\n' + API_ANCHOR, '\n' + supplyLines() + API_ANCHOR);
  guard(result.replace(supplyLines(), '') === text, 'Compose changed more than the flag lines');
  return result;
}

/**
 * Compose that already carries the second-wave keys (compose-supply) plus
 * BACKOFFICE_EXPENSES_ENABLED "false" in the api service; nothing else changes.
 */
export function composeExpenses(text, expectedSha256) {
  installed(text, expectedSha256);
  const key = EXPENSES_COMPOSE.expenses;
  guard(!text.includes(key + ':'), 'Installed compose already mentions ' + key);
  for (const { key: supply } of Object.values(SUPPLY_COMPOSE))
    guard(
      text.split(supply + ':').length === 2,
      'Installed compose lacks the second-wave keys: run compose-supply first',
    );
  guard(text.split('\n' + API_ANCHOR).length === 2, 'Compose database anchors differ');
  const result = text.replace('\n' + API_ANCHOR, '\n' + line(key, 'false') + API_ANCHOR);
  guard(result.replace(line(key, 'false'), '') === text, 'Compose changed more than the flag line');
  return result;
}

/**
 * One cutover key flipped in the api service (and in provision where it is carried). A
 * second-wave key (SUPPLY_COMPOSE) lives in the api service only and follows the order the API
 * itself enforces at start: it turns on only after its cutover flag, and that cutover flag
 * turns off only after it.
 */
export function composeFlag(text, expectedSha256, flag, enabled) {
  installed(text, expectedSha256);
  guard(
    (flag in COMPOSE_FLAGS || flag in SUPPLY_COMPOSE || flag in EXPENSES_COMPOSE) &&
      typeof enabled === 'boolean',
    'Invalid flag',
  );
  const key = COMPOSE_FLAGS[flag] ?? SUPPLY_COMPOSE[flag]?.key ?? EXPENSES_COMPOSE[flag];
  if (flag in SUPPLY_COMPOSE && enabled) {
    const needed = COMPOSE_FLAGS[SUPPLY_COMPOSE[flag].requires];
    guard(text.includes(line(needed, 'true')), `${key} requires ${needed} "true" first`);
  }
  if (flag in COMPOSE_FLAGS && !enabled)
    for (const dependent of Object.values(SUPPLY_COMPOSE))
      guard(
        dependent.requires !== flag || !text.includes(line(dependent.key, 'true')),
        `Turn ${dependent.key} off before ${key}`,
      );
  const [from, to] = enabled ? ['false', 'true'] : ['true', 'false'];
  const count = PROVISION_KEYS.includes(key) ? 2 : 1;
  guard(
    text.split(line(key, from)).length === count + 1 && !text.includes(line(key, to)),
    `${key} is not in the expected state in the installed compose`,
  );
  guard(text.split(key + ':').length === count + 1, `${key} appears in an unexpected place`);
  const result = text.replaceAll(line(key, from), line(key, to));
  guard(result.replaceAll(line(key, to), line(key, from)) === text, 'Compose changed more');
  return result;
}

// ------------------------------------------------------------------------------- command line ----
const USAGE =
  'Usage: cutover-cloud-owner.mjs inspect | deploy | flag <pos-sales-sync|roles|stock-v2|sales-report> <true|false> | inspect-075 | deploy-075 | p1-grants <none|pos-day,stock-v2,autoconsume,manager-shifts,staff-positions,discounts> | inspect-076 | deploy-076 | supply-grants <none|supply,staff-assignment> | inspect-077 | deploy-077 | expenses-grants <on|off> | compose-candidate --compose <file> --sha256 <hex> --out <file> | compose-supply --compose <file> --sha256 <hex> --out <file> | compose-expenses --compose <file> --sha256 <hex> --out <file> | compose-flag <flag> <true|false> --compose <file> --sha256 <hex> --out <file>';
function composeOptions(rest) {
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    const name = /^--(compose|sha256|out)$/.exec(rest[i] ?? '')?.[1];
    guard(name && !(name in options) && typeof rest[i + 1] === 'string', USAGE);
    options[name] = rest[i + 1];
  }
  guard(
    ['compose', 'sha256', 'out'].every((name) => options[name]),
    USAGE,
  );
  guard(SHA.test(options.sha256), USAGE);
  return options;
}
export function parseArguments(argv) {
  const [command, ...rest] = argv;
  if (
    [
      'inspect',
      'deploy',
      'inspect-075',
      'deploy-075',
      'inspect-076',
      'deploy-076',
      'inspect-077',
      'deploy-077',
    ].includes(command) &&
    rest.length === 0
  )
    return { command };
  if (command === 'expenses-grants' && rest.length === 1 && ['on', 'off'].includes(rest[0]))
    return { command, enabled: rest[0] === 'on' };
  if (command === 'supply-grants' && rest.length === 1) {
    const enabled = rest[0] === 'none' ? [] : rest[0].split(',');
    guard(
      enabled.every((name) => name in SUPPLY_FLAGS) && new Set(enabled).size === enabled.length,
      USAGE,
    );
    return { command, enabled };
  }
  if (command === 'p1-grants' && rest.length === 1) {
    const enabled = rest[0] === 'none' ? [] : rest[0].split(',');
    guard(
      enabled.every((name) => name in P1_FLAGS) && new Set(enabled).size === enabled.length,
      USAGE,
    );
    return { command, enabled };
  }
  if (
    command === 'flag' &&
    rest.length === 2 &&
    rest[0] in FLAGS &&
    ['true', 'false'].includes(rest[1])
  )
    return { command, flag: rest[0], enabled: rest[1] === 'true' };
  if (
    command === 'compose-candidate' ||
    command === 'compose-supply' ||
    command === 'compose-expenses'
  )
    return { command, ...composeOptions(rest) };
  if (
    command === 'compose-flag' &&
    (rest[0] in COMPOSE_FLAGS || rest[0] in SUPPLY_COMPOSE || rest[0] in EXPENSES_COMPOSE) &&
    ['true', 'false'].includes(rest[1])
  )
    return {
      command,
      flag: rest[0],
      enabled: rest[1] === 'true',
      ...composeOptions(rest.slice(2)),
    };
  throw new OwnerGuardError(USAGE);
}

async function compose(args) {
  const text = await readFile(args.compose, 'utf8');
  const result =
    args.command === 'compose-candidate'
      ? composeCandidate(text, args.sha256)
      : args.command === 'compose-supply'
        ? composeSupply(text, args.sha256)
        : args.command === 'compose-expenses'
          ? composeExpenses(text, args.sha256)
          : composeFlag(text, args.sha256, args.flag, args.enabled);
  await writeFile(args.out, result, { flag: 'wx', mode: 0o600 }).catch(() => {
    throw new OwnerGuardError('Output file exists or is not writable');
  });
  return {
    composeBefore: sha256(text),
    composeAfter: sha256(result),
    ...(args.flag
      ? {
          environment:
            COMPOSE_FLAGS[args.flag] ??
            SUPPLY_COMPOSE[args.flag]?.key ??
            EXPENSES_COMPOSE[args.flag],
          enabled: args.enabled,
        }
      : {}),
  };
}

async function main(argv) {
  const args = parseArguments(argv);
  if (args.command.startsWith('compose-')) return console.log(JSON.stringify(await compose(args)));
  let url;
  try {
    url = new URL(process.env.CLOUD_DATABASE_URL ?? '');
  } catch {
    url = null;
  }
  guard(
    url?.username === 'pickchick_owner' && url.pathname === '/pickchick_cloud',
    'Owner database required',
  );
  const { createPool } = await import('@pickchick/database');
  const pool = createPool(url.href),
    c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const directory = fileURLToPath(new URL('../../db/cloud/migrations/', import.meta.url));
    const result =
      args.command === 'flag'
        ? await setCutoverFlag(c, { flag: args.flag, enabled: args.enabled })
        : args.command === 'p1-grants'
          ? await setBackofficeP1(c, { enabled: args.enabled })
          : args.command === 'supply-grants'
            ? await setBackofficeSupply(c, { enabled: args.enabled })
            : args.command === 'expenses-grants'
              ? await setBackofficeExpenses(c, { enabled: args.enabled })
              : args.command.endsWith('-077')
                ? await deployBackofficeExpenses(c, {
                    directory,
                    inspect: args.command === 'inspect-077',
                  })
                : args.command.endsWith('-076')
                  ? await deployBackofficeSupply(c, {
                      directory,
                      inspect: args.command === 'inspect-076',
                    })
                  : args.command.endsWith('-075')
                    ? await deployBackofficeP1(c, {
                        directory,
                        inspect: args.command === 'inspect-075',
                      })
                    : await deployCutover(c, { directory, inspect: args.command === 'inspect' });
    await c.query(args.command.startsWith('inspect') ? 'ROLLBACK' : 'COMMIT');
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
        ? `Cutover cloud owner guard: ${e.message}`
        : 'Cutover cloud owner transaction failed; inspect state before retry.',
    );
    process.exitCode = 1;
  });
