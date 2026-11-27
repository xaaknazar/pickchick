/**
 * Edge schema029 (ADR-0017, Kaspi Smart POS adapter): the exact privileges of the edge runtime on
 * the terminal link and its payment attempts. Additive: edge-runtime-grants.mjs (a full reset)
 * composes this after 029; the owner tool scripts/kaspi-terminal-setup.mjs alone links, re-links
 * and unlinks terminals.
 *
 * - kaspi_pos_devices: the runtime reads the link and renews only the token (/v2/revoke).
 * - kaspi_pos_attempts: the runtime writes an attempt and records the terminal's answers; the
 *   schema029 guard allows only forward transitions and never a delete.
 */
export const MIGRATION = '029_edge_kaspi_pos.sql';
export const KASPI_POS_TABLES = Object.freeze(['kaspi_pos_devices', 'kaspi_pos_attempts']);
export const RUNTIME_PRIVILEGES = Object.freeze({
  kaspi_pos_devices: Object.freeze([
    'SELECT',
    'UPDATE(access_token,refresh_token,token_expires_at)',
  ]),
  kaspi_pos_attempts: Object.freeze([
    'SELECT',
    'INSERT',
    'UPDATE(state,sub_status,process_id,transaction_id,payment_method,message,cheque,order_id,finished_at,actualized_at)',
  ]),
});

const identifier = (value) => {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(value))
    throw new Error('Invalid Kaspi POS grant identifier');
  return '"' + value + '"';
};

/** Pure SQL for the runtime role (no REVOKE; the caller owns the reset). */
export function kaspiPosRuntimeGrantSql(role, schema = 'public') {
  const target = identifier(role),
    namespace = identifier(schema);
  return Object.entries(RUNTIME_PRIVILEGES)
    .map(([table, privileges]) => {
      for (const privilege of privileges)
        if (!/^(SELECT|INSERT|UPDATE\([a-z_,]+\))$/.test(privilege))
          throw new Error('Invalid Kaspi POS privilege');
      return `GRANT ${privileges.join(', ')} ON ${namespace}.${identifier(table)} TO ${target};`;
    })
    .join('\n');
}

/**
 * Proves the exact privilege set of `role` on the two schema029 tables: table rights and column
 * UPDATE rights equal RUNTIME_PRIVILEGES. Throws on the first difference.
 */
export async function assertKaspiPosRuntimePrivileges(client, role, schema = 'public') {
  for (const [table, privileges] of Object.entries(RUNTIME_PRIVILEGES)) {
    const relation = `${identifier(schema)}.${identifier(table)}`;
    const expectedTable = privileges.filter((p) => !p.includes('(')).sort();
    const update = privileges.find((p) => p.startsWith('UPDATE('));
    const expectedColumns = update ? update.slice(7, -1).split(',').sort() : [];
    const tableRights = [];
    for (const action of [
      'SELECT',
      'INSERT',
      'UPDATE',
      'DELETE',
      'TRUNCATE',
      'REFERENCES',
      'TRIGGER',
    ])
      if (
        (await client.query('SELECT has_table_privilege($1,$2,$3) AS ok', [role, relation, action]))
          .rows[0].ok
      )
        tableRights.push(action);
    if (JSON.stringify(tableRights.sort()) !== JSON.stringify(expectedTable))
      throw new Error(`Kaspi POS table privileges differ on ${table}`);
    const columns = (
      await client.query(
        `SELECT a.attname FROM pg_attribute a WHERE a.attrelid=$2::regclass AND a.attnum>0
         AND NOT a.attisdropped AND has_column_privilege($1,$2::regclass,a.attname,'UPDATE')
         ORDER BY a.attname`,
        [role, relation],
      )
    ).rows.map((row) => row.attname);
    if (JSON.stringify(columns) !== JSON.stringify(expectedColumns))
      throw new Error(`Kaspi POS column privileges differ on ${table}`);
  }
  return { role, tables: KASPI_POS_TABLES.length };
}
