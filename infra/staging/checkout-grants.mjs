function check(role, enabled) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(role) || typeof enabled !== 'boolean')
    throw new Error('Invalid checkout grants');
}

/** Apply after transport and backoffice grants. No bank observation authority. */
export function customerCheckoutGrants(role, enabled) {
  check(role, enabled);
  return (
    `REVOKE ALL ON commerce_kaspi_invoices FROM ${role};
    REVOKE INSERT ON commerce_quotes,commerce_orders,commerce_payment_intents,commerce_payment_attempts FROM ${role};
    REVOKE UPDATE(lock_anchor) ON catalog_branch_heads FROM ${role};` +
    (enabled
      ? `
    GRANT SELECT ON branches,devices,catalog_publications,catalog_branch_heads,
      commerce_quotes,commerce_orders,commerce_commands,commerce_provider_accounts,
      commerce_payment_intents,commerce_payment_attempts,commerce_captures,commerce_refunds,
      commerce_refund_effects,commerce_fiscal_documents,commerce_fiscal_effects,
      commerce_reconciliation_issues,commerce_outbox,commerce_cancellation_intents,
      commerce_kaspi_invoices,fulfillment_transport_bindings,cloud_fulfillment_projection,
      cloud_fulfillment_observed_tasks TO ${role};
    GRANT UPDATE(lock_anchor) ON catalog_branch_heads,fulfillment_transport_bindings TO ${role};
    GRANT UPDATE(state,version,updated_at,attention_required,kitchen_effect_id) ON commerce_orders TO ${role};
    GRANT UPDATE(state) ON commerce_payment_intents TO ${role};
    GRANT INSERT ON commerce_quotes,commerce_orders,commerce_payment_intents,
      commerce_payment_attempts,commerce_commands,commerce_outbox TO ${role};
    GRANT USAGE ON SEQUENCE commerce_outbox_sequence_seq TO ${role};`
      : '')
  );
}

/** Dedicated worker role only. Immutable money/identity/catalog cannot be rewritten. */
export function kaspiWorkerGrants(role, enabled) {
  check(role, enabled);
  const tables = `branches,identity_customers,commerce_quotes,commerce_orders,
    commerce_provider_accounts,commerce_payment_intents,commerce_payment_attempts,
    commerce_captures,commerce_refunds,commerce_refund_effects,commerce_fiscal_documents,
    commerce_fiscal_effects,commerce_provider_inbox,commerce_reconciliation_issues,
    commerce_outbox,commerce_cancellation_intents,commerce_kaspi_invoices,cloud_fulfillment_projection`;
  return (
    `REVOKE ALL ON ${tables} FROM ${role};
    REVOKE SELECT(id,phone_cipher,deleted_at) ON identity_customers FROM ${role};
    REVOKE UPDATE(state,version,updated_at,attention_required,kitchen_effect_id) ON commerce_orders FROM ${role};
    REVOKE UPDATE(state) ON commerce_payment_intents,commerce_payment_attempts FROM ${role};
    REVOKE UPDATE(lease_worker,lease_token,lease_until,attempts,acknowledged_at) ON commerce_outbox FROM ${role};
    REVOKE ALL ON SEQUENCE commerce_outbox_sequence_seq FROM ${role};` +
    (enabled
      ? `
    GRANT SELECT ON ${tables.replace('identity_customers,', '')} TO ${role};
    GRANT SELECT(id,phone_cipher,deleted_at) ON identity_customers TO ${role};
    GRANT INSERT,UPDATE ON commerce_kaspi_invoices TO ${role};
    GRANT INSERT ON commerce_captures,commerce_provider_inbox,commerce_fiscal_documents,
      commerce_reconciliation_issues,commerce_outbox TO ${role};
    GRANT UPDATE(state,version,updated_at,attention_required,kitchen_effect_id) ON commerce_orders TO ${role};
    GRANT UPDATE(state) ON commerce_payment_intents,commerce_payment_attempts TO ${role};
    GRANT UPDATE(lease_worker,lease_token,lease_until,attempts,acknowledged_at) ON commerce_outbox TO ${role};
    GRANT USAGE ON SEQUENCE commerce_outbox_sequence_seq TO ${role};`
      : '')
  );
}
