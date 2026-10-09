/** Additive, independently switched device-access ACL. Never grants credential/password writes. */
export function deviceRegistryGrants(role, enabled) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(role) || typeof enabled !== 'boolean')
    throw new Error('INVALID_GRANTS_INPUT');
  const target = '"' + role + '"';
  const statements = [
    `REVOKE SELECT(id,branch_id,organization_id,active) ON kiosk_devices FROM ${target}`,
    `REVOKE INSERT ON devices FROM ${target}`,
    `REVOKE SELECT(device_id,expires_at) ON device_credentials FROM ${target}`,
    `REVOKE ALL ON device_terminal_registry,cloud_device_commands,device_events,cloud_kitchen_password_resets,kitchen_password_reset_events FROM ${target}`,
  ];
  if (enabled)
    statements.push(
      `GRANT SELECT,INSERT ON device_terminal_registry,cloud_device_commands,device_events,cloud_kitchen_password_resets,kitchen_password_reset_events TO ${target}`,
      `GRANT UPDATE(generation,paired_at) ON device_terminal_registry TO ${target}`,
      `GRANT UPDATE(state,delivered_at,resolved_at) ON cloud_device_commands TO ${target}`,
      `GRANT UPDATE(state,delivered_at,resolved_at) ON cloud_kitchen_password_resets TO ${target}`,
      // Shared devices SELECT/UPDATE(status) belong to existing BO/transport profiles.
      `GRANT SELECT(id,branch_id,organization_id,active) ON kiosk_devices TO ${target}`,
      `GRANT INSERT ON devices TO ${target}`,
      `GRANT SELECT(device_id,expires_at) ON device_credentials TO ${target}`,
    );
  return statements.map((s) => s + ';').join('\n');
}
