/** Separate commercial edge transport role. No staff, POS or credential access.
 * remoteStops (edge schema019, transport protocol 4): fill the stop-command inbox, report
 * verdicts and read per-variant stop versions. It never writes local_stops. */
export function fulfillmentWorkerGrants(role, schema = 'public', { remoteStops = false } = {}) {
  for (const name of [role, schema])
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(name)) throw new Error('Invalid role/schema');
  if (typeof remoteStops !== 'boolean') throw new Error('Invalid remote stop grant flag');
  const grant = (privilege, names) =>
    `GRANT ${privilege} ON ${names
      .split(',')
      .map((n) => `"${schema}"."${n}"`)
      .join(',')} TO "${role}";`;
  return [
    `GRANT USAGE ON SCHEMA "${schema}" TO "${role}";`,
    grant(
      'SELECT',
      'cashier_report_outbox,schema_migrations,branch_config,fulfillment_config,fulfillment_routing,fulfillment_reservations,fulfillment_tasks,fulfillment_inbox,fulfillment_outbox,fulfillment_release_results,fulfillment_transport_state,fulfillment_transport_failures,fulfillment_transport_reverse_failures',
    ),
    grant('SELECT(branch_id,variant_id,stopped,expires_at,expires_shift_id)', 'local_stops'),
    ...(remoteStops
      ? [
          grant('SELECT(version,source,updated_at)', 'local_stops'),
          grant(
            'SELECT(command_id,branch_id,state,result_version,applied_at,reported_at)',
            'remote_stop_commands',
          ),
          grant(
            'INSERT(command_id,branch_id,variant_id,stopped,duration,reason,expected_version,actor_label,issued_at)',
            'remote_stop_commands',
          ),
          grant('UPDATE(reported_at)', 'remote_stop_commands'),
        ]
      : []),
    grant('SELECT(id,state)', 'local_cash_shifts'),
    grant(
      'SELECT(id,branch_id,quote_id,cash_shift_id,created_at,total_minor,state,version,execution_mode)',
      'local_orders',
    ),
    grant('SELECT(id,branch_id,snapshot)', 'checkout_quotes'),
    grant('INSERT', 'cashier_report_outbox'),
    grant('UPDATE(acknowledged_at,attempts,last_error)', 'cashier_report_outbox'),
    // FOR SHARE needs an UPDATE privilege, but not permission to alter binding or opening state.
    grant('UPDATE(singleton)', 'branch_config'),
    grant('UPDATE(lock_anchor)', 'fulfillment_config'),
    grant(
      'INSERT',
      'fulfillment_reservations,fulfillment_tasks,fulfillment_inbox,fulfillment_outbox,fulfillment_release_results,fulfillment_transport_state,fulfillment_transport_failures,fulfillment_transport_reverse_failures',
    ),
    grant(
      'UPDATE(state,version,display_number,business_day,authorized_event_id,updated_at,cancellation_reason)',
      'fulfillment_reservations',
    ),
    grant('UPDATE(state,version,updated_at)', 'fulfillment_tasks'),
    grant(
      'UPDATE(lease_worker,lease_token,lease_until,attempts,acknowledged_at)',
      'fulfillment_outbox',
    ),
    grant(
      'UPDATE(worker_id,lease_token,lease_until,pending_cloud,last_error,last_success_at,attempts,updated_at)',
      'fulfillment_transport_state',
    ),
    grant('UPDATE(attempts,last_failed_at,resolved_at)', 'fulfillment_transport_failures'),
    grant(
      'UPDATE(attempts,last_error,retry_after,last_failed_at,resolved_at)',
      'fulfillment_transport_reverse_failures',
    ),
    grant(
      'USAGE',
      'cashier_report_outbox_sequence_seq,fulfillment_display_sequence,fulfillment_outbox_sequence_seq',
    ).replace(' ON ', ' ON SEQUENCE '),
  ].join('\n');
}
