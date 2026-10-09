/** Schema020 only. Separate mailbox metadata and runtime reset privileges.
 * No staff enrollment, role/PIN changes, order access or worker password verifiers. */
export function terminalAccessGrants(role, schema = 'public', { worker = false } = {}) {
  for (const id of [role, schema])
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(id)) throw new Error('Invalid terminal access identifier');
  if (typeof worker !== 'boolean') throw new Error('Invalid terminal access role');
  const grant = (privilege, tables) =>
    `GRANT ${privilege} ON ${tables.map((t) => `"${schema}"."${t}"`).join(',')} TO "${role}";`;
  return [
    `GRANT USAGE ON SCHEMA "${schema}" TO "${role}";`,
    grant('SELECT', [
      'schema_migrations',
      'fulfillment_config',
      'terminal_access_commands',
      'terminal_access_registry',
      'local_terminals',
      'kitchen_password_reset_commands',
    ]),
    grant('UPDATE(active)', ['local_terminals']),
    grant('UPDATE(state,code_hash,key_hash)', ['terminal_access_registry']),
    grant('UPDATE(state)', ['terminal_access_commands', 'kitchen_password_reset_commands']),
    ...(worker
      ? [
          grant('INSERT', [
            'terminal_access_commands',
            'terminal_access_registry',
            'local_terminals',
            'kitchen_password_reset_commands',
          ]),
          grant('UPDATE(generation,command_id,name,expires_at)', ['terminal_access_registry']),
          grant('UPDATE(reported_state)', [
            'terminal_access_commands',
            'kitchen_password_reset_commands',
          ]),
          grant('SELECT(id,branch_id,role,active)', ['local_staff']),
          grant('SELECT(staff_id,branch_id,login)', ['local_staff_passwords']),
        ]
      : [
          grant('SELECT,INSERT', ['terminal_pair_limits']),
          // Existing runtime already has SELECT and session/audit authority. No verifier INSERT, identity or role writes.
          grant('UPDATE(salt,verifier,failed_attempts,locked_until,updated_at)', [
            'local_staff_passwords',
          ]),
          grant('UPDATE(window_started_at,attempts)', ['terminal_pair_limits']),
        ]),
  ].join('\n');
}
