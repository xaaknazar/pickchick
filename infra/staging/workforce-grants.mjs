/** Workforce-only ACL; existing backoffice scope/audit rights stay under their owner. */
export function workforceGrants(role, enabled) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(role) || typeof enabled !== 'boolean')
    throw new Error('INVALID_GRANTS_INPUT');
  const target = `"${role}"`;
  const statements = [
    `REVOKE ALL ON bo_workforce_records,bo_workforce_events,bo_workforce_periods,bo_workforce_commands FROM ${target}`,
  ];
  if (enabled)
    statements.push(
      `GRANT SELECT,INSERT ON bo_workforce_records,bo_workforce_events,bo_workforce_periods,bo_workforce_commands TO ${target}`,
      `GRANT UPDATE(revision,payload,updated_at) ON bo_workforce_records TO ${target}`,
      `GRANT UPDATE(closed,revision,snapshot) ON bo_workforce_periods TO ${target}`,
    );
  return statements.map((s) => s + ';').join('\n');
}
