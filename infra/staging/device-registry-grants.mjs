/**
 * API runtime grants for the back-office device registry (migration 051). Additive to
 * backofficeGrants: bo_audit/bo_commands, catalog_managers, devices, commerce reads and
 * UPDATE(status) ON devices stay owned there, and the kiosk enrollment exchange privileges on
 * kiosk_enrollment_aliases stay owned by the kiosk release. Disabling revokes only what this
 * helper alone grants. Pairing codes and device events are never deleted.
 */
export const DEVICE_REGISTRY_TABLES = Object.freeze(['device_pairing_codes', 'device_events']);
/** Exact privileges granted when enabled: [table, column or null, privilege]. */
export const DEVICE_REGISTRY_ACL = Object.freeze(
  [
    ['device_pairing_codes', null, 'SELECT'],
    ['device_pairing_codes', null, 'INSERT'],
    ['device_pairing_codes', 'state', 'UPDATE'],
    ['device_pairing_codes', 'failed_attempts', 'UPDATE'],
    ['device_pairing_codes', 'consumed_at', 'UPDATE'],
    ['device_pairing_codes', 'consumed_request_id', 'UPDATE'],
    ['device_events', null, 'SELECT'],
    ['device_events', null, 'INSERT'],
    ['devices', null, 'INSERT'],
    ['devices', 'name', 'UPDATE'],
    ['devices', 'status', 'UPDATE'],
    ['devices', 'revoked_at', 'UPDATE'],
    ['devices', 'revoked_by', 'UPDATE'],
    ['devices', 'last_seen_at', 'UPDATE'],
    ['devices', 'app_version', 'UPDATE'],
    ['kiosk_devices', null, 'SELECT'],
    ['kiosk_devices', null, 'INSERT'],
    ['kiosk_devices', 'active', 'UPDATE'],
    ['kiosk_enrollment_aliases', null, 'SELECT'],
    ['kiosk_enrollment_aliases', null, 'INSERT'],
    ['kiosk_enrollment_aliases', 'active', 'UPDATE'],
    ['kiosk_sessions', null, 'SELECT'],
    ['device_credentials', 'device_id', 'SELECT'],
    ['device_credentials', 'expires_at', 'SELECT'],
  ].map((row) => Object.freeze(row)),
);

export function deviceRegistryGrants(role, enabled) {
  if (
    typeof role !== 'string' ||
    !/^[a-z][a-z0-9_]{0,62}$/.test(role) ||
    typeof enabled !== 'boolean'
  )
    throw new Error('Invalid device registry grant configuration');
  const revoke =
    `REVOKE ALL ON device_pairing_codes,device_events FROM ${role};` +
    `REVOKE INSERT ON devices,kiosk_devices,kiosk_enrollment_aliases FROM ${role};` +
    `REVOKE UPDATE(name,revoked_at,revoked_by,last_seen_at,app_version) ON devices FROM ${role};` +
    `REVOKE UPDATE(active) ON kiosk_devices,kiosk_enrollment_aliases FROM ${role};`;
  if (!enabled) return revoke;
  return (
    revoke +
    `
 GRANT SELECT,INSERT ON device_pairing_codes,device_events TO ${role};
 GRANT UPDATE(state,failed_attempts,consumed_at,consumed_request_id) ON device_pairing_codes TO ${role};
 GRANT INSERT ON devices TO ${role};
 GRANT UPDATE(name,status,revoked_at,revoked_by,last_seen_at,app_version) ON devices TO ${role};
 GRANT SELECT,INSERT ON kiosk_devices TO ${role};
 GRANT UPDATE(active) ON kiosk_devices TO ${role};
 GRANT SELECT,INSERT ON kiosk_enrollment_aliases TO ${role};
 GRANT UPDATE(active) ON kiosk_enrollment_aliases TO ${role};
 GRANT SELECT ON kiosk_sessions TO ${role};
 GRANT SELECT(device_id,expires_at) ON device_credentials TO ${role};`
  );
}
