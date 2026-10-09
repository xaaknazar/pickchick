/**
 * API runtime grants for manager-accepted kiosk payment incidents (migration 050).
 * Append-only: the runtime may read and insert, never update or delete. Disabling revokes all.
 */
export function kioskIncidentGrants(role, enabled) {
  if (
    typeof role !== 'string' ||
    !/^[a-z][a-z0-9_]{0,62}$/.test(role) ||
    typeof enabled !== 'boolean'
  )
    throw new Error('Invalid kiosk incident grant configuration');
  return (
    `REVOKE ALL ON commerce_kiosk_payment_incidents FROM ${role};` +
    (enabled ? `\n GRANT SELECT,INSERT ON commerce_kiosk_payment_incidents TO ${role};` : '')
  );
}
