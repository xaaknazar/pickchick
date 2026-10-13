/** Inventory/telemetry do not grant pairing, staff access or financial mutations. */
export function deviceCenterGrants(role) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(role)) throw new Error('INVALID_ROLE');
  const r = '"' + role + '"';
  return [
    `GRANT SELECT,INSERT,UPDATE ON device_inventory,device_presence TO ${r}`,
    `GRANT SELECT,INSERT ON device_inventory_commands TO ${r}`,
    `GRANT SELECT ON device_terminal_registry,cloud_device_commands,device_events,cloud_kitchen_password_resets,kitchen_password_reset_events TO ${r}`,
    `GRANT SELECT(device_id,expires_at) ON device_credentials TO ${r}`,
    `GRANT SELECT(id,branch_id,organization_id,active,token_hash) ON kiosk_devices TO ${r}`,
  ]
    .map((s) => s + ';')
    .join('\n');
}
