/** Required by the order recipe pinning trigger after cloud017, independently of BO UI. */
export function orderRecipeGrants(role) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(role)) throw new Error('Invalid runtime role');
  return `GRANT SELECT ON bo_records TO ${role}; GRANT INSERT ON bo_order_recipes TO ${role};`;
}
/** Additive runtime permissions. Provisioning grants remain exclusive to the operator. */
export function backofficeGrants(role, enabled) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(role) || typeof enabled !== 'boolean')
    throw new Error('Invalid backoffice grants');
  const own =
    'bo_records,bo_audit,bo_commands,bo_stock_balances,bo_stock_documents,bo_stock_movements,bo_publications,bo_delivery_outbox,bo_access_grants,bo_order_recipes,bo_access_audit';
  return (
    `REVOKE ALL ON ${own} FROM ${role};REVOKE UPDATE(lock_anchor) ON bo_access_grants FROM ${role};REVOKE INSERT ON commerce_commands FROM ${role};REVOKE UPDATE(status) ON devices FROM ${role};${orderRecipeGrants(role)}` +
    (enabled
      ? `
 GRANT SELECT ON ${own},catalog_managers,catalog_manager_branches,catalog_branch_heads,catalog_draft_versions,catalog_audit,devices,identity_customers,identity_consents,commerce_orders,commerce_payment_intents,commerce_payment_attempts,commerce_provider_accounts,commerce_captures,commerce_refunds,commerce_refund_effects,commerce_fiscal_documents,commerce_fiscal_effects,commerce_reconciliation_issues,commerce_commands,commerce_outbox,commerce_cancellation_intents,commerce_cancellation_results,cloud_fulfillment_projection,cloud_fulfillment_inbox,pos_order_sync_projection,pos_order_sync_inbox,pos_kitchen_sync_projection,pos_kitchen_sync_inbox,fulfillment_transport_bindings,branches,legal_entities TO ${role};
 GRANT INSERT,UPDATE ON bo_records,bo_stock_balances TO ${role};
 GRANT INSERT ON bo_audit,bo_commands,bo_stock_documents,bo_stock_movements,bo_publications,bo_delivery_outbox,bo_order_recipes,commerce_fiscal_documents,commerce_reconciliation_issues,commerce_refunds,commerce_commands,commerce_outbox,commerce_cancellation_intents TO ${role};
 GRANT UPDATE(lock_anchor) ON bo_access_grants,catalog_managers,catalog_manager_branches,fulfillment_transport_bindings TO ${role};
 GRANT UPDATE(status) ON devices TO ${role};
 GRANT UPDATE(state,version,updated_at,attention_required,kitchen_effect_id,admission_device_id,admission_reservation_id) ON commerce_orders TO ${role};
 GRANT UPDATE(state) ON commerce_payment_intents TO ${role};
 GRANT UPDATE(state,release_event_id,expected_edge_version,reservation_id,result_event_id,resolution_code,updated_at) ON commerce_cancellation_intents TO ${role};
 GRANT USAGE ON SEQUENCE commerce_outbox_sequence_seq TO ${role};`
      : '')
  );
}
