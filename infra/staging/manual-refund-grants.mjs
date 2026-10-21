/**
 * BACKOFFICE_MANUAL_REFUNDS_ENABLED only (release fixes 19.10, findings 0.3/7.1). Lets the manager
 * command record a refund that staff already made by hand in Kaspi Pay (effect row) and settle or
 * withdraw an old pending request. Apply AFTER fulfillmentTransportGrants/backofficeGrants/
 * customerCheckoutGrants: the transport helper revokes all refund privileges from the shared API
 * role. Never grants capture rights.
 *
 * Kept apart from backoffice-grants.mjs: guarded historical releases (release-finance-ledger.py)
 * pin that helper's exact bytes.
 */
export function manualRefundGrants(role, enabled) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(role) || typeof enabled !== 'boolean')
    throw new Error('Invalid manual refund grants');
  return (
    `REVOKE INSERT ON commerce_refund_effects FROM ${role};REVOKE UPDATE(state) ON commerce_refunds FROM ${role};` +
    (enabled
      ? `GRANT INSERT ON commerce_refund_effects TO ${role};GRANT UPDATE(state) ON commerce_refunds TO ${role};`
      : '')
  );
}
