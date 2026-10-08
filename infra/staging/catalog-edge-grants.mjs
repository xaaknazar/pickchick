const role = (value) => {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(value))
    throw new Error('Invalid catalog edge grant configuration');
  return value;
};
/**
 * Always-on menu sync runtime (after cloud045). Pull records the edge-reported active menu,
 * ACK appends the edge verdict. The device and branch of a state row are never rewritable.
 */
export function edgeMenuStateGrants(name) {
  const r = role(name);
  return `GRANT SELECT,INSERT ON edge_menu_state,catalog_menu_delivery_results TO ${r};
 GRANT UPDATE(active_release_id,active_version,observed_at) ON edge_menu_state TO ${r};`;
}
/**
 * Apply after backofficeGrants, which revokes bo_access_grants when the back-office is off.
 * Catalog role checks only read grants and take the inert lock_anchor row lock.
 */
export function catalogAccessGrants(name, enabled) {
  const r = role(name);
  if (typeof enabled !== 'boolean') throw new Error('Invalid catalog edge grant configuration');
  return enabled
    ? `GRANT SELECT ON bo_access_grants TO ${r};
 GRANT UPDATE(lock_anchor) ON bo_access_grants TO ${r};`
    : '';
}
