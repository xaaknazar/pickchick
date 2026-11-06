/**
 * Cloud schema075 (cutover 19.11.2026, lane bo-ui; docs/architecture/cutover-2026-11/design-bo-ui.md
 * sections 2 and 3): rights of the shared API role on the back-office P1 relations, per flag. The
 * automatic consumption worker runs under the same role (design-backoffice 4).
 *
 * - bo_menu_stock_links: SELECT, INSERT, UPDATE with BACKOFFICE_STOCK_V2_ENABLED (links, storno and
 *   the waste report live under stock v2). The new bo_stock_documents columns (source_ref,
 *   reverses_document_id) and bo_stock_balances.counted_at are covered by the table-level rights
 *   that backofficeGrants already gives (its bytes are pinned by guarded historical releases, so
 *   nothing is added there); assertBackofficeP1Privileges proves the column rights.
 * - bo_stock_settings, bo_consumption_items: SELECT, INSERT, UPDATE with
 *   BACKOFFICE_STOCK_AUTOCONSUME_ENABLED and stock v2 (the worker consumes by the links).
 * - bo_manager_shifts: SELECT, INSERT, UPDATE with BACKOFFICE_MANAGER_SHIFTS_ENABLED.
 * - bo_discounts: SELECT, INSERT, UPDATE and bo_discount_revisions: SELECT with
 *   BACKOFFICE_DISCOUNTS_ENABLED. The history is written by the cloud075 trigger as the owner, so
 *   the API role never inserts it.
 * - No DELETE and no TRUNCATE anywhere: the 075 triggers refuse deletes, the role cannot try.
 *
 * Additive reads outside 075 (no REVOKE: another helper owns each reset, so this one runs after
 * them, last in provision.mjs):
 * - BACKOFFICE_POS_DAY_ENABLED: SELECT on every POS_DAY_TABLES table that exists (cloud073). The
 *   pos lane's cloudPosSalesGrants(role, {backoffice: true}) gives the same set, so its exact proof
 *   still holds after this helper when its `backoffice` option is the same back-office switch.
 * - BACKOFFICE_STOCK_AUTOCONSUME_ENABLED: SELECT on cloud_pos_sales (sold lines and release),
 *   catalog_menu_deliveries and catalog_publications (the catalog version of a POS release).
 *
 * With the back office off the SQL only revokes. For the 075 relations the SQL is a reset: it
 * revokes every privilege of `role` on them, then grants the enabled set. On a database without 075
 * (or 073) those parts are no-ops (to_regclass guards), so provisioning can run before the
 * migration.
 */
export const MIGRATION = '075_cloud_backoffice_ops.sql';

export const BACKOFFICE_P1_RELATIONS = Object.freeze({
  bo_stock_settings: 'r',
  bo_menu_stock_links: 'r',
  bo_consumption_items: 'r',
  bo_manager_shifts: 'r',
  bo_discounts: 'r',
  bo_discount_revisions: 'r',
});
const READ = Object.freeze(['SELECT']);
const WRITE = Object.freeze(['SELECT', 'INSERT', 'UPDATE']);
const NAME = /^[a-z][a-z0-9_]{0,62}$/;
const FLAGS = Object.freeze([
  'backoffice',
  'posDay',
  'stockV2',
  'autoconsume',
  'managerShifts',
  'discounts',
]);
/** The cloud073 tables GET .../ops/pos-day reads (packages/backoffice-core, design-bo-ui 4.1). */
export const POS_DAY_TABLES = Object.freeze([
  'cloud_pos_sales',
  'cloud_pos_tenders',
  'cloud_pos_refunds',
  'cloud_pos_refund_tenders',
  'cloud_pos_fiscal_receipts',
  'cloud_pos_shift_reports',
]);
/** Tables outside 075 the consumption worker reads (design-backoffice 4, algorithm step 2). */
export const AUTOCONSUME_READ_TABLES = Object.freeze([
  'cloud_pos_sales',
  'catalog_menu_deliveries',
  'catalog_publications',
]);
/** Columns of older tables that P1 writes, with the table rights of backofficeGrants. */
export const P1_COLUMNS = Object.freeze({
  bo_stock_documents: Object.freeze(['source_ref', 'reverses_document_id']),
  bo_stock_balances: Object.freeze(['counted_at']),
});

function options(input) {
  if (!input || FLAGS.some((flag) => typeof input[flag] !== 'boolean'))
    throw new Error('Invalid backoffice P1 grants');
  return input;
}

/** Exact rights of the shared API role on the 075 relations for the enabled flags. */
export function backofficeP1Privileges(input) {
  const o = options(input);
  if (!o.backoffice) return Object.freeze({});
  const consume = o.stockV2 && o.autoconsume;
  return Object.freeze({
    ...(o.stockV2 ? { bo_menu_stock_links: WRITE } : {}),
    ...(consume ? { bo_stock_settings: WRITE, bo_consumption_items: WRITE } : {}),
    ...(o.managerShifts ? { bo_manager_shifts: WRITE } : {}),
    ...(o.discounts ? { bo_discounts: WRITE, bo_discount_revisions: READ } : {}),
  });
}
/** The additive SELECT grants on tables outside 075 (see the module comment). */
export function backofficeP1Reads(input) {
  const o = options(input);
  if (!o.backoffice) return Object.freeze([]);
  return Object.freeze([
    ...new Set([
      ...(o.posDay ? POS_DAY_TABLES : []),
      ...(o.stockV2 && o.autoconsume ? AUTOCONSUME_READ_TABLES : []),
    ]),
  ]);
}

/** Reset SQL for `role` on the 075 relations, then the additive reads (module comment). */
export function backofficeP1Grants(role, input, schema = 'public') {
  if (!NAME.test(role ?? '') || !NAME.test(schema)) throw new Error('Invalid backoffice P1 grants');
  const privileges = backofficeP1Privileges(input);
  const reads = backofficeP1Reads(input);
  const relation = (name) => `"${schema}"."${name}"`;
  const reset = Object.keys(BACKOFFICE_P1_RELATIONS)
    .map(
      (name) =>
        `IF to_regclass('${schema}.${name}') IS NOT NULL THEN ` +
        `REVOKE ALL ON ${relation(name)} FROM "${role}";` +
        (privileges[name]
          ? `GRANT ${privileges[name].join(', ')} ON ${relation(name)} TO "${role}";`
          : '') +
        ' END IF;',
    )
    .join(' ');
  return (
    `DO $bo_p1$ BEGIN ${reset} END $bo_p1$;` +
    (reads.length
      ? ' DO $bo_p1_reads$ BEGIN ' +
        reads
          .map(
            (name) =>
              `IF to_regclass('${schema}.${name}') IS NOT NULL THEN ` +
              `GRANT SELECT ON ${relation(name)} TO "${role}"; END IF;`,
          )
          .join(' ') +
        ' END $bo_p1_reads$;'
      : '')
  );
}

const PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
/**
 * Proves the exact set of backofficeP1Privileges(input) on every 075 relation that exists, SELECT on
 * every backofficeP1Reads(input) table that exists, and, with stock v2 or autoconsume on, the INSERT,
 * UPDATE and SELECT column rights of P1_COLUMNS. Throws with the first difference.
 */
export async function assertBackofficeP1Privileges(client, role, input, schema = 'public') {
  if (!NAME.test(role ?? '') || !NAME.test(schema)) throw new Error('Invalid backoffice P1 grants');
  const expected = backofficeP1Privileges(input);
  for (const name of Object.keys(BACKOFFICE_P1_RELATIONS)) {
    const present = (
      await client.query('SELECT to_regclass($1) IS NOT NULL AS ok', [`${schema}.${name}`])
    ).rows[0].ok;
    if (!present) continue;
    const actual = (
      await client.query(
        `SELECT p.privilege FROM unnest($3::text[]) p(privilege)
         WHERE has_table_privilege($1, $2::regclass, p.privilege) ORDER BY 1`,
        [role, `${schema}.${name}`, PRIVILEGES],
      )
    ).rows.map((row) => row.privilege);
    const want = [...(expected[name] ?? [])].sort();
    if (JSON.stringify(actual) !== JSON.stringify(want))
      throw new Error(`${name} privileges of ${role}: ${actual.join(',') || 'none'}`);
  }
  const missing = (
    await client.query(
      `SELECT t FROM unnest($2::text[]) t
       WHERE to_regclass($3 || '.' || t) IS NOT NULL
         AND NOT has_table_privilege($1, ($3 || '.' || t)::regclass, 'SELECT')
       ORDER BY t`,
      [role, backofficeP1Reads(input), schema],
    )
  ).rows.map((row) => row.t);
  if (missing.length)
    throw new Error(`P1 read tables not readable by ${role}: ${missing.join(',')}`);
  const o = options(input);
  if (o.backoffice && (o.stockV2 || o.autoconsume)) {
    for (const [table, names] of Object.entries(P1_COLUMNS)) {
      const columns = (
        await client.query(
          `SELECT c.column_name,
             has_column_privilege($1, $2::regclass, c.column_name, 'SELECT') AS can_select,
             has_column_privilege($1, $2::regclass, c.column_name, 'INSERT') AS can_insert,
             has_column_privilege($1, $2::regclass, c.column_name, 'UPDATE') AS can_update
           FROM unnest($3::text[]) c(column_name)
           WHERE EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=$2::regclass
             AND a.attname=c.column_name AND NOT a.attisdropped)`,
          [role, `${schema}.${table}`, names],
        )
      ).rows;
      // bo_stock_documents is append-only: INSERT and SELECT; counted_at is updated in place.
      const ok = columns.every(
        (c) => c.can_select && (table === 'bo_stock_documents' ? c.can_insert : c.can_update),
      );
      if (!ok) throw new Error(`${table} P1 columns are not writable by ${role}`);
    }
  }
}
