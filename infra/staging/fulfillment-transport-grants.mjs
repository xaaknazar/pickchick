/** Only transport-owned delivery/projection writes; never grant capture/refund/bank authority. */
export function fulfillmentTransportGrants(role, enabled) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(role) || typeof enabled !== 'boolean')
    throw new Error('Invalid fulfillment transport grants');
  const tables =
    'cloud_cashier_report_inbox,cloud_cashier_shifts,cloud_cashier_orders,cloud_branch_availability,cloud_stop_commands, fulfillment_transport_bindings, cloud_fulfillment_inbox, cloud_fulfillment_versions, cloud_fulfillment_projection, cloud_fulfillment_observed_tasks, cloud_fulfillment_task_versions, commerce_cancellation_intents, commerce_cancellation_results';
  const commerce =
    'commerce_orders, commerce_quotes, commerce_payment_intents, commerce_payment_attempts, commerce_provider_accounts, commerce_captures, commerce_refunds, commerce_refund_effects, commerce_fiscal_documents, commerce_outbox, commerce_edge_inbox, commerce_reconciliation_issues';
  return (
    `REVOKE ALL ON ${tables} FROM ${role};
    REVOKE UPDATE(state,release_event_id,expected_edge_version,reservation_id,result_event_id,resolution_code,updated_at) ON commerce_cancellation_intents FROM ${role};
    REVOKE UPDATE(lock_anchor) ON fulfillment_transport_bindings FROM ${role};
    REVOKE UPDATE(state,result_version,delivered_at,resolved_at) ON cloud_stop_commands FROM ${role};
    REVOKE ALL ON ${commerce} FROM ${role};
    REVOKE UPDATE(admission_device_id,admission_reservation_id,state,version,updated_at,kitchen_effect_id,attention_required) ON commerce_orders FROM ${role};
    REVOKE UPDATE(state) ON commerce_payment_intents FROM ${role};
    REVOKE UPDATE(lease_worker,lease_token,lease_until,attempts,acknowledged_at) ON commerce_outbox FROM ${role};
    REVOKE ALL ON SEQUENCE commerce_outbox_sequence_seq FROM ${role};` +
    (enabled
      ? `
    GRANT SELECT ON ${tables}, ${commerce} TO ${role};
    GRANT UPDATE(lock_anchor) ON fulfillment_transport_bindings TO ${role};
    GRANT UPDATE(state,result_version,delivered_at,resolved_at) ON cloud_stop_commands TO ${role};
    GRANT UPDATE(state,release_event_id,expected_edge_version,reservation_id,result_event_id,resolution_code,updated_at) ON commerce_cancellation_intents TO ${role};
    GRANT INSERT ON commerce_cancellation_results TO ${role};
    GRANT INSERT ON cloud_cashier_report_inbox,cloud_fulfillment_inbox,cloud_fulfillment_versions,cloud_fulfillment_task_versions TO ${role};
    GRANT INSERT,UPDATE ON cloud_cashier_shifts,cloud_cashier_orders,cloud_branch_availability,cloud_fulfillment_projection,cloud_fulfillment_observed_tasks TO ${role};
    GRANT UPDATE(admission_device_id,admission_reservation_id,state,version,updated_at,kitchen_effect_id,attention_required) ON commerce_orders TO ${role};
    GRANT UPDATE(state) ON commerce_payment_intents TO ${role};
    GRANT INSERT ON commerce_fiscal_documents,commerce_outbox,commerce_edge_inbox,commerce_reconciliation_issues TO ${role};
    GRANT UPDATE(lease_worker,lease_token,lease_until,attempts,acknowledged_at) ON commerce_outbox TO ${role};
    GRANT USAGE ON SEQUENCE commerce_outbox_sequence_seq TO ${role};`
      : '')
  );
}
