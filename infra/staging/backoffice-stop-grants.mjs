/**
 * Back-office remote stops (after cloud048). Apply after fulfillmentTransportGrants and
 * backofficeGrants: the transport owns delivery and verdict columns and revokes the table first.
 * Enabled, the back-office may queue commands (INSERT), read them and the published catalog
 * names, and close its own lapsed command (state/resolved_at, the transport's expiry rule).
 * Disabled, it only loses INSERT, so the transport keeps its SELECT/UPDATE grants.
 */
export function backofficeStopGrants(role, enabled) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(role) || typeof enabled !== 'boolean')
    throw new Error('Invalid back-office stop grants');
  return enabled
    ? `GRANT SELECT,INSERT ON cloud_stop_commands TO ${role};
 GRANT UPDATE(state,resolved_at) ON cloud_stop_commands TO ${role};
 GRANT SELECT ON catalog_publications TO ${role};`
    : `REVOKE INSERT ON cloud_stop_commands FROM ${role};`;
}
