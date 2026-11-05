/**
 * Cloud schema074 (cutover 19.11.2026, lane cloud; contracts 3.3, 5.10, 6.1): back-office role
 * designations (CC-5) and stock documents v2 (CC-6).
 *
 * - bo_role_designations: the shared API role only reads it, and only while
 *   BACKOFFICE_ROLES_ENABLED is on. The operator appends rows as the owner with
 *   scripts/backoffice-setup.mjs --designation; no HTTP route writes it.
 * - bo_stock_documents.reason_code / meta: covered by the table-level SELECT and INSERT that
 *   backofficeGrants already gives the API role (backoffice-grants.mjs bytes are pinned by
 *   guarded historical releases, so nothing is added there). assertBackofficeCutoverPrivileges
 *   proves the column rights the stock v2 command needs.
 *
 * Apply after backofficeGrants. The SQL is a reset of exactly the 074 relations: it revokes every
 * privilege of `role` on them, then grants the enabled set. On a database without 074 it is a
 * no-op (to_regclass guard), so provisioning can run before the migration.
 */
export const MIGRATION = '074_cloud_backoffice_cutover.sql';

export const BACKOFFICE_CUTOVER_RELATIONS = Object.freeze({ bo_role_designations: 'r' });
const READ = Object.freeze(['SELECT']);
const NAME = /^[a-z][a-z0-9_]{0,62}$/;

/** Exact rights of the shared API role on the 074 relations. */
export function backofficeCutoverPrivileges({ backoffice, roles }) {
  if (typeof backoffice !== 'boolean' || typeof roles !== 'boolean')
    throw new Error('Invalid backoffice cutover grants');
  return Object.freeze(backoffice && roles ? { bo_role_designations: READ } : {});
}

/** Reset SQL for `role` on the 074 relations (see the module comment). */
export function backofficeCutoverGrants(role, options, schema = 'public') {
  if (!NAME.test(role ?? '') || !NAME.test(schema))
    throw new Error('Invalid backoffice cutover grants');
  const privileges = backofficeCutoverPrivileges(options);
  const table = `"${schema}"."bo_role_designations"`;
  return (
    `DO $bo_cutover$ BEGIN IF to_regclass('${schema}.bo_role_designations') IS NOT NULL THEN ` +
    `REVOKE ALL ON ${table} FROM "${role}";` +
    (privileges.bo_role_designations ? `GRANT SELECT ON ${table} TO "${role}";` : '') +
    ' END IF; END $bo_cutover$;'
  );
}

/**
 * Proves the exact set of backofficeCutoverPrivileges(options) on bo_role_designations, and, when
 * `stockV2` is on, the INSERT and SELECT column rights of the stock v2 command.
 */
export async function assertBackofficeCutoverPrivileges(client, role, options, schema = 'public') {
  if (!NAME.test(role ?? '') || !NAME.test(schema))
    throw new Error('Invalid backoffice cutover grants');
  const expected = backofficeCutoverPrivileges(options);
  const actual = (
    await client.query(
      `SELECT p.privilege FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p(privilege)
       WHERE has_table_privilege($1, $2::regclass, p.privilege) ORDER BY 1`,
      [role, `${schema}.bo_role_designations`],
    )
  ).rows.map((row) => row.privilege);
  const want = [...(expected.bo_role_designations ?? [])].sort();
  if (JSON.stringify(actual) !== JSON.stringify(want))
    throw new Error(`bo_role_designations privileges of ${role}: ${actual.join(',') || 'none'}`);
  if (options.stockV2 === true) {
    const columns = (
      await client.query(
        `SELECT c.column_name, has_column_privilege($1, $2::regclass, c.column_name, 'INSERT') AS can_insert,
          has_column_privilege($1, $2::regclass, c.column_name, 'SELECT') AS can_select
         FROM unnest(ARRAY['reason_code','meta']) c(column_name)`,
        [role, `${schema}.bo_stock_documents`],
      )
    ).rows;
    if (!columns.every((c) => c.can_insert && c.can_select))
      throw new Error(`bo_stock_documents v2 columns are not writable by ${role}`);
  }
}
