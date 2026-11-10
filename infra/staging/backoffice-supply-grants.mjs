/**
 * Cloud schema076 (cutover 19.11.2026, lane bo-ui2; docs/architecture/cutover-2026-11/
 * design-bo-ui.md «Вторая волна»): rights of the shared API role on the second-wave relations of
 * the back office, per flag.
 *
 * - bo_suppliers, bo_supplier_prices, bo_supply_requests: SELECT, INSERT, UPDATE and
 *   bo_supplier_price_imports: SELECT, INSERT (an applied import never changes) with
 *   BACKOFFICE_SUPPLY_ENABLED. Receiving a request writes the stock receipt through the rights
 *   backofficeGrants already gives on the stock tables (its bytes are pinned by guarded
 *   historical releases, so nothing is added there).
 * - bo_staff_assignments: SELECT, INSERT, UPDATE with BACKOFFICE_STAFF_ASSIGNMENT_ENABLED. The
 *   stations come from the list of positions, which the bo-ui helper (backoffice-p1-grants.mjs)
 *   makes readable with BACKOFFICE_STAFF_POSITIONS_ENABLED, a flag this one requires.
 * - BACKOFFICE_STOCK_REPORTS_ENABLED needs nothing here: the reports read the stock tables of
 *   backofficeGrants, and the consumption state only through the 075 rights the bo-ui helper
 *   gives with automatic consumption (without them a report says it has no worker state).
 * - No DELETE and no TRUNCATE anywhere: the 076 triggers refuse deletes, the role cannot try.
 *
 * The SQL is a reset of the 076 relations only: it revokes every privilege of `role` on them,
 * then grants the enabled set; nothing outside 076 is granted or revoked, so it may run anywhere
 * after backofficeGrants (CR bo-ui2-1: right after the bo-ui helper, last in provision.mjs). With
 * the back office off it only revokes. On a database without 076 it is a no-op (to_regclass
 * guards), so provisioning can run before the migration.
 */
export const MIGRATION = '076_cloud_backoffice_supply.sql';

export const BACKOFFICE_SUPPLY_RELATIONS = Object.freeze({
  bo_suppliers: 'r',
  bo_supplier_price_imports: 'r',
  bo_supplier_prices: 'r',
  bo_supply_requests: 'r',
  bo_staff_assignments: 'r',
});
const APPEND = Object.freeze(['SELECT', 'INSERT']);
const WRITE = Object.freeze(['SELECT', 'INSERT', 'UPDATE']);
const NAME = /^[a-z][a-z0-9_]{0,62}$/;
const FLAGS = Object.freeze(['backoffice', 'supply', 'stockReports', 'staffAssignment']);
function options(input) {
  if (!input || FLAGS.some((flag) => typeof input[flag] !== 'boolean'))
    throw new Error('Invalid backoffice supply grants');
  return input;
}

/** Exact rights of the shared API role on the 076 relations for the enabled flags. */
export function backofficeSupplyPrivileges(input) {
  const o = options(input);
  if (!o.backoffice) return Object.freeze({});
  return Object.freeze({
    ...(o.supply
      ? {
          bo_suppliers: WRITE,
          bo_supplier_price_imports: APPEND,
          bo_supplier_prices: WRITE,
          bo_supply_requests: WRITE,
        }
      : {}),
    ...(o.staffAssignment ? { bo_staff_assignments: WRITE } : {}),
  });
}

/** Reset SQL for `role` on the 076 relations (module comment). */
export function backofficeSupplyGrants(role, input, schema = 'public') {
  if (!NAME.test(role ?? '') || !NAME.test(schema))
    throw new Error('Invalid backoffice supply grants');
  const privileges = backofficeSupplyPrivileges(input);
  const relation = (name) => `"${schema}"."${name}"`;
  const reset = Object.keys(BACKOFFICE_SUPPLY_RELATIONS)
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
  return `DO $bo_supply$ BEGIN ${reset} END $bo_supply$;`;
}

const PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
/**
 * Proves the exact set of backofficeSupplyPrivileges(input) on every 076 relation that exists.
 * Throws with the first difference.
 */
export async function assertBackofficeSupplyPrivileges(client, role, input, schema = 'public') {
  if (!NAME.test(role ?? '') || !NAME.test(schema))
    throw new Error('Invalid backoffice supply grants');
  const expected = backofficeSupplyPrivileges(input);
  for (const name of Object.keys(BACKOFFICE_SUPPLY_RELATIONS)) {
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
}
