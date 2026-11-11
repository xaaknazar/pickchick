/**
 * Cloud schema077 («Расходы», owner request 11.11.2026; docs/operations/backoffice-expenses.md):
 * rights of the shared API role on the 077 relations, with BACKOFFICE_ENABLED and
 * BACKOFFICE_EXPENSES_ENABLED both on.
 *
 * - bo_expense_entries: SELECT, INSERT, UPDATE, DELETE (a grid cell is changed and cleared in
 *   place; every change is in bo_expense_log). The 077 trigger refuses any change in a closed month.
 * - bo_expense_rows, bo_expense_cash: SELECT, INSERT, UPDATE (never deleted).
 * - bo_expense_months: SELECT, INSERT, DELETE (opening a month deletes its row).
 * - bo_expense_access, bo_expense_log: SELECT, INSERT (append-only, refused by their triggers).
 * - Revenue and the cost by the cards are read through the rights of the sales report and of
 *   backofficeGrants; without them the section shows no automatic revenue, it never fails.
 *
 * The SQL is a reset of the 077 relations only (revoke all, then grant the enabled set); with a
 * flag off it only revokes; on a database without 077 it is a no-op (to_regclass guards).
 */
export const MIGRATION = '077_cloud_backoffice_expenses.sql';
export const BACKOFFICE_EXPENSES_RELATIONS = Object.freeze([
  'bo_expense_access',
  'bo_expense_entries',
  'bo_expense_rows',
  'bo_expense_cash',
  'bo_expense_months',
  'bo_expense_log',
]);
const NAME = /^[a-z][a-z0-9_]{0,62}$/;

/** Exact rights of the shared API role on the 077 relations. */
export function backofficeExpensesPrivileges(input) {
  if (!input || typeof input.backoffice !== 'boolean' || typeof input.expenses !== 'boolean')
    throw new Error('Invalid backoffice expenses grants');
  if (!input.backoffice || !input.expenses) return Object.freeze({});
  return Object.freeze({
    bo_expense_access: ['SELECT', 'INSERT'],
    bo_expense_entries: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
    bo_expense_rows: ['SELECT', 'INSERT', 'UPDATE'],
    bo_expense_cash: ['SELECT', 'INSERT', 'UPDATE'],
    bo_expense_months: ['SELECT', 'INSERT', 'DELETE'],
    bo_expense_log: ['SELECT', 'INSERT'],
  });
}

/** Reset SQL for `role` on the 077 relations (module comment). */
export function backofficeExpensesGrants(role, input, schema = 'public') {
  if (!NAME.test(role ?? '') || !NAME.test(schema))
    throw new Error('Invalid backoffice expenses grants');
  const privileges = backofficeExpensesPrivileges(input);
  const relation = (name) => `"${schema}"."${name}"`;
  const reset = BACKOFFICE_EXPENSES_RELATIONS.map(
    (name) =>
      `IF to_regclass('${schema}.${name}') IS NOT NULL THEN ` +
      `REVOKE ALL ON ${relation(name)} FROM "${role}";` +
      (privileges[name]
        ? `GRANT ${privileges[name].join(', ')} ON ${relation(name)} TO "${role}";`
        : '') +
      ' END IF;',
  ).join(' ');
  return `DO $bo_expenses$ BEGIN ${reset} END $bo_expenses$;`;
}
