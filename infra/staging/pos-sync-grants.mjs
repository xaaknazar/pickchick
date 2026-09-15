import { posSyncReceiverGrants } from '../windows/pos-sync-worker-grants.mjs';

/** Internal POS ingress shares the API role; it cannot issue device authority. */
export function cloudPosSyncGrants(role, enabled) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(role) || typeof enabled !== 'boolean')
    throw new Error('Invalid POS receiver grants');
  return (
    `REVOKE ALL ON pos_order_sync_bindings,pos_order_sync_inbox,pos_order_sync_projection,pos_kitchen_sync_inbox,pos_kitchen_sync_projection FROM ${role};
REVOKE UPDATE(pos_sync_lock_anchor) ON devices,device_credentials FROM ${role};
REVOKE UPDATE(lock_anchor) ON pos_order_sync_bindings FROM ${role};` +
    (enabled ? posSyncReceiverGrants(role) : '')
  );
}
