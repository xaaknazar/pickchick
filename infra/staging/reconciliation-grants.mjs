/**
 * BACKOFFICE_RECONCILIATION_ENABLED (stage 2, lane rec, cloud071): daily payment reconciliation.
 *
 * The runtime stores only external facts (statement lines, manual totals) and the accountant's
 * decisions. It never writes captures, refunds, orders or fiscal documents and cannot designate
 * accountants (bo_rec_accountants is read-only here; the operator writes it). PickChick money
 * facts are read through the SELECT privileges of backofficeGrants (reconciliation needs
 * BACKOFFICE_ENABLED). Two optional sources get column-level read access only.
 *
 * Apply AFTER backofficeGrants and customerCheckoutGrants: the checkout helper revokes all
 * table privileges on commerce_kaspi_invoices, which also drops column privileges.
 */
export function reconciliationGrants(role, enabled) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(role) || typeof enabled !== 'boolean')
    throw new Error('Invalid reconciliation grants');
  const own =
    'bo_rec_accountants,bo_rec_profiles,bo_rec_imports,bo_rec_import_voids,bo_rec_lines,bo_rec_totals,bo_rec_total_voids,bo_rec_items,bo_rec_days,bo_rec_commands';
  const appendOnly =
    'bo_rec_profiles,bo_rec_imports,bo_rec_import_voids,bo_rec_lines,bo_rec_totals,bo_rec_total_voids,bo_rec_items,bo_rec_days,bo_rec_commands';
  const invoices = 'attempt_id,reference,operation_id';
  const sandbox = 'branch_id,amount_minor,state,updated_at';
  return (
    `DO $rec$ BEGIN IF to_regclass('bo_rec_days') IS NOT NULL THEN REVOKE ALL ON ${own} FROM ${role};` +
    `IF to_regclass('commerce_kaspi_invoices') IS NOT NULL THEN REVOKE SELECT(${invoices}) ON commerce_kaspi_invoices FROM ${role}; END IF;` +
    `IF to_regclass('commerce_tiptoppay_test_payments') IS NOT NULL THEN REVOKE SELECT(${sandbox}) ON commerce_tiptoppay_test_payments FROM ${role}; END IF;` +
    (enabled
      ? `GRANT SELECT ON ${own} TO ${role};GRANT INSERT ON ${appendOnly} TO ${role};` +
        `GRANT UPDATE(revision,name,mapping,archived,actor_id,updated_at) ON bo_rec_profiles TO ${role};` +
        `GRANT UPDATE(revision,state,amount_minor,status,assignee_id,comment,actor_id,updated_at) ON bo_rec_items TO ${role};` +
        `IF to_regclass('commerce_kaspi_invoices') IS NOT NULL THEN GRANT SELECT(${invoices}) ON commerce_kaspi_invoices TO ${role}; END IF;` +
        `IF to_regclass('commerce_tiptoppay_test_payments') IS NOT NULL THEN GRANT SELECT(${sandbox}) ON commerce_tiptoppay_test_payments TO ${role}; END IF;`
      : '') +
    ' END IF; END $rec$;'
  );
}
