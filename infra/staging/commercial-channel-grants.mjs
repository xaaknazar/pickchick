import { customerCheckoutGrants } from './checkout-grants.mjs';
import { orderRecipeGrants } from './backoffice-grants.mjs';
function check(role, enabled) {
  if (
    typeof role !== 'string' ||
    !/^[a-z][a-z0-9_]{0,62}$/.test(role) ||
    typeof enabled !== 'boolean'
  )
    throw new Error('Invalid commercial channel grant configuration');
}
/** After catalogAdminGrants. Publication writes never claim installation on the edge. */
export function catalogEdgePublicationGrants(role, enabled) {
  check(role, enabled);
  return (
    `REVOKE ALL ON catalog_menu_deliveries FROM ${role};` +
    (enabled
      ? `
 GRANT SELECT,INSERT ON catalog_menu_deliveries,menu_releases,menu_streams,outbox_events TO ${role};
 GRANT SELECT ON branches,devices,branch_menu_activations,inbox_messages,fulfillment_transport_bindings TO ${role};
 GRANT UPDATE(menu_publication_lock_anchor) ON branches TO ${role};
 GRANT UPDATE(last_sequence) ON menu_streams TO ${role};`
      : '')
  );
}
/** Explicit operator addition after cloud034-036. Shared mobile grants survive disable. */
export function kioskCheckoutGrants(role, enabled) {
  check(role, enabled);
  const revoke = `REVOKE ALL ON kiosk_devices,kiosk_sessions FROM ${role};
 REVOKE UPDATE(lock_anchor) ON kiosk_devices FROM ${role};
 REVOKE UPDATE(ended_at,phone_ciphertext,phone_nonce,phone_tag,phone_expires_at) ON kiosk_sessions FROM ${role};`;
  return (
    revoke +
    (enabled
      ? customerCheckoutGrants(role, true) +
        orderRecipeGrants(role) +
        `
 GRANT SELECT ON kiosk_devices,kiosk_sessions,catalog_menu_deliveries,menu_releases,branch_menu_activations,outbox_events,inbox_messages,fulfillment_transport_bindings,devices TO ${role};
 GRANT UPDATE(lock_anchor) ON kiosk_devices TO ${role};
 GRANT INSERT ON kiosk_sessions TO ${role};
 GRANT UPDATE(ended_at,phone_ciphertext,phone_nonce,phone_tag,phone_expires_at) ON kiosk_sessions TO ${role};`
      : '')
  );
}
/** Apply after kaspiWorkerGrants. Disabling new checkout must not disable payment recovery. */
export function kioskWorkerGrants(role, enabled) {
  check(role, enabled);
  return (
    `REVOKE ALL ON kiosk_sessions FROM ${role};
 REVOKE UPDATE(phone_ciphertext,phone_nonce,phone_tag) ON kiosk_sessions FROM ${role};` +
    (enabled
      ? `
 GRANT SELECT ON kiosk_sessions,commerce_orders,commerce_payment_attempts,commerce_kaspi_invoices TO ${role};
 GRANT UPDATE(phone_ciphertext,phone_nonce,phone_tag) ON kiosk_sessions TO ${role};`
      : '')
  );
}
