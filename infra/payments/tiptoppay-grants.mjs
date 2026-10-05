const checked = (role, enabled) => {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(role) || role === 'public' || typeof enabled !== 'boolean')
    throw new Error('Invalid TipTop Pay grants');
};
// Migration 039 must exist. Apply after ordinary customer-checkout grants.
// This role can bind a method/open a session, but cannot manufacture a capture.
export function tipTopPayCheckoutGrants(role, enabled) {
  checked(role, enabled);
  return (
    `REVOKE ALL ON commerce_checkout_payment_methods,commerce_tiptoppay_sessions FROM ${role};` +
    (enabled
      ? `
    GRANT SELECT,INSERT ON commerce_checkout_payment_methods,commerce_tiptoppay_sessions TO ${role};
    GRANT UPDATE(method,locked_at,updated_at) ON commerce_checkout_payment_methods TO ${role};
    GRANT UPDATE(token_hash,opened_at) ON commerce_tiptoppay_sessions TO ${role};`
      : '')
  );
}
// Receiver/reconciler only, after their base SELECT grants. Never grant DELETE,
// provider identity changes, catalog writes or receipt-issued authority.
export function tipTopPayObservationGrants(role, enabled) {
  checked(role, enabled);
  const tables =
    'commerce_captures,commerce_provider_inbox,commerce_fiscal_documents,commerce_reconciliation_issues,commerce_outbox';
  return (
    `REVOKE INSERT ON ${tables} FROM ${role};
    REVOKE UPDATE(authorized_operation_id,last_reconcile_at,reconcile_attempts) ON commerce_tiptoppay_sessions FROM ${role};
    REVOKE UPDATE(state,version,updated_at,attention_required,kitchen_effect_id) ON commerce_orders FROM ${role};
    REVOKE UPDATE(state) ON commerce_payment_intents,commerce_payment_attempts FROM ${role};
    REVOKE USAGE ON SEQUENCE commerce_outbox_sequence_seq FROM ${role};` +
    (enabled
      ? `
    GRANT SELECT ON branches,commerce_orders,commerce_provider_accounts,commerce_payment_intents,
      commerce_payment_attempts,commerce_captures,commerce_refunds,commerce_refund_effects,
      commerce_fiscal_documents,commerce_fiscal_effects,commerce_provider_inbox,
      commerce_reconciliation_issues,commerce_outbox,commerce_cancellation_intents,
      commerce_tiptoppay_sessions TO ${role};
    GRANT INSERT ON ${tables} TO ${role};
    GRANT UPDATE(state,version,updated_at,attention_required,kitchen_effect_id) ON commerce_orders TO ${role};
    GRANT UPDATE(state) ON commerce_payment_intents,commerce_payment_attempts TO ${role};
    GRANT UPDATE(authorized_operation_id,last_reconcile_at,reconcile_attempts) ON commerce_tiptoppay_sessions TO ${role};
    GRANT USAGE ON SEQUENCE commerce_outbox_sequence_seq TO ${role};`
      : '')
  );
}
