import { posSalesWorkerGrants } from './pos-sales-grants.mjs';

/** Dedicated transport roles. Never apply these to the staff-facing Edge HTTP role. */
function roleSql(role, schema, statements) {
  for (const name of [role, schema])
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(name)) throw new Error('Invalid transport role/schema');
  const qualify = (names) =>
    names
      .split(',')
      .map((name) => '"' + schema + '"."' + name + '"')
      .join(',');
  return (
    'GRANT USAGE ON SCHEMA "' +
    schema +
    '" TO "' +
    role +
    '";\n' +
    statements
      .map(
        ([permission, names]) =>
          'GRANT ' + permission + ' ON ' + qualify(names) + ' TO "' + role + '";',
      )
      .join('\n')
  );
}
/**
 * POS sync worker role. posSales (edge schema026, cutover CR pos-1 section 1): the caller passes
 * true only when 026 is applied; the posSales sender (cloud lane) then also reads pos_sale_outbox,
 * records its delivery and writes pos_sale_sync_state (WORKER_PRIVILEGES of pos-sales-grants.mjs).
 * Without it the SQL is byte-identical to the pre-cutover grants.
 */
export function posSyncWorkerGrants(role, schema = 'public', { posSales = false } = {}) {
  if (typeof posSales !== 'boolean') throw new Error('Invalid POS sales grant flag');
  const sql = roleSql(role, schema, [
    ['SELECT', 'pos_order_sync_state,pos_kitchen_sync_state,outbox_events,fulfillment_outbox'],
    [
      'UPDATE(lease_token,lease_until,pending_event_id,pending_envelope,pending_hash,failure_count,retry_after,last_error)',
      'pos_order_sync_state',
    ],
    [
      'UPDATE(lease_token,lease_until,pending_event_id,pending_envelope,pending_hash,failure_count,retry_after,last_error,dead_lettered_at)',
      'pos_kitchen_sync_state',
    ],
    ['UPDATE(attempts,acknowledged_at)', 'outbox_events,fulfillment_outbox'],
  ]);
  return posSales ? sql + '\n' + posSalesWorkerGrants(role, schema) : sql;
}
export function posSyncReceiverGrants(role, schema = 'public', { restoreReview = false } = {}) {
  return (
    roleSql(role, schema, [
      [
        'SELECT',
        'devices,device_credentials,pos_order_sync_bindings,pos_order_sync_inbox,pos_order_sync_projection,pos_kitchen_sync_inbox,pos_kitchen_sync_projection',
      ],
      ['UPDATE(pos_sync_lock_anchor)', 'devices,device_credentials'],
      ['UPDATE(lock_anchor)', 'pos_order_sync_bindings'],
      [
        'INSERT',
        'pos_order_sync_inbox,pos_order_sync_projection,pos_kitchen_sync_inbox,pos_kitchen_sync_projection',
      ],
      ['UPDATE(version,state,last_event_id,updated_at)', 'pos_order_sync_projection'],
      ['UPDATE(version,state,last_event_id,updated_at,observed_at)', 'pos_kitchen_sync_projection'],
    ]) +
    (restoreReview
      ? '\n' + roleSql(role, schema, [['SELECT,INSERT', 'pos_kitchen_restore_conflicts']])
      : '')
  );
}
