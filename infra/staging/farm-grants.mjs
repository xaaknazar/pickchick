/** Example for explicitly enabling farm on a migrated API runtime role.
 * Customer identity permissions are provisioned separately by customerAuthGrants.
 */
export function farmGrants(role, enabled) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(role) || typeof enabled !== 'boolean')
    throw new Error('Invalid farm grant configuration');
  return (
    `REVOKE ALL ON customer_farms, customer_farm_commands FROM ${role};` +
    (enabled
      ? `
GRANT SELECT, INSERT, UPDATE ON customer_farms TO ${role};
GRANT SELECT, INSERT ON customer_farm_commands TO ${role};
GRANT SELECT(id, deleted_at), UPDATE(id) ON identity_customers TO ${role};`
      : '')
  );
}
