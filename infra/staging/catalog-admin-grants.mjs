/** Row-lock privileges must not allow changing a manager token or branch scope. */
export function catalogAdminGrants(role, enabled) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(role) || typeof enabled !== 'boolean')
    throw new Error('Invalid catalog grant configuration');
  return (
    `REVOKE ALL ON catalog_managers, catalog_manager_branches, catalog_draft_versions,
    catalog_publications, catalog_branch_heads, catalog_audit, catalog_command_receipts, catalog_manager_audit FROM ${role};
    REVOKE UPDATE(lock_anchor) ON catalog_managers, catalog_manager_branches FROM ${role};
    GRANT SELECT ON catalog_publications, catalog_branch_heads TO ${role};` +
    (enabled
      ? `
    GRANT SELECT ON catalog_managers, catalog_manager_branches, catalog_draft_versions,
      catalog_audit, catalog_command_receipts, catalog_manager_audit TO ${role};
    GRANT UPDATE(lock_anchor) ON catalog_managers, catalog_manager_branches TO ${role};
    GRANT INSERT, UPDATE ON catalog_branch_heads TO ${role};
    GRANT INSERT ON catalog_draft_versions, catalog_publications, catalog_audit, catalog_command_receipts TO ${role};`
      : '')
  );
}
