/**
 * Edge schema030 (audit 28.11 P0-1, CR pos-8): the exact privileges of the edge runtime on the
 * table of manager releases of paid Kaspi attempts that never became an order. Additive:
 * edge-runtime-grants.mjs (a full reset) composes this after 029; the guarded upgrade
 * kaspi-pos-release-upgrade-db.mjs grants it in the run that applies 030.
 *
 * - kaspi_pos_attempt_releases: SELECT (the guards of an attempt and the sales code read it, and
 *   the release route is on only when this right exists) and INSERT (the release itself). Never
 *   UPDATE, DELETE, TRUNCATE or REFERENCES: the table is append-only, and schema030 triggers
 *   refuse change, delete and truncate as well.
 */
export const MIGRATION = '030_edge_kaspi_pos_release.sql';
export const KASPI_POS_RELEASE_TABLES = Object.freeze(['kaspi_pos_attempt_releases']);
export const RUNTIME_PRIVILEGES = Object.freeze({
  kaspi_pos_attempt_releases: Object.freeze(['SELECT', 'INSERT']),
});

const identifier = (value) => {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(value))
    throw new Error('Invalid Kaspi POS release grant identifier');
  return '"' + value + '"';
};

/** Pure SQL for the runtime role (no REVOKE; the caller owns the reset). */
export function kaspiPosReleaseRuntimeGrantSql(role, schema = 'public') {
  const target = identifier(role),
    namespace = identifier(schema);
  return Object.entries(RUNTIME_PRIVILEGES)
    .map(([table, privileges]) => {
      for (const privilege of privileges)
        if (!/^(SELECT|INSERT)$/.test(privilege))
          throw new Error('Invalid Kaspi POS release privilege');
      return `GRANT ${privileges.join(', ')} ON ${namespace}.${identifier(table)} TO ${target};`;
    })
    .join('\n');
}

/**
 * Proves the exact privilege set of `role` on the schema030 table: table rights equal
 * RUNTIME_PRIVILEGES and no column carries UPDATE. Throws on the first difference.
 */
export async function assertKaspiPosReleaseRuntimePrivileges(client, role, schema = 'public') {
  for (const [table, privileges] of Object.entries(RUNTIME_PRIVILEGES)) {
    const relation = `${identifier(schema)}.${identifier(table)}`;
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
    if (JSON.stringify(tableRights.sort()) !== JSON.stringify([...privileges].sort()))
      throw new Error(`Kaspi POS release table privileges differ on ${table}`);
    const columns = (
      await client.query(
        `SELECT a.attname FROM pg_attribute a WHERE a.attrelid=$2::regclass AND a.attnum>0
         AND NOT a.attisdropped AND has_column_privilege($1,$2::regclass,a.attname,'UPDATE')
         ORDER BY a.attname`,
        [role, relation],
      )
    ).rows;
    if (columns.length) throw new Error(`Kaspi POS release column privileges differ on ${table}`);
  }
  return { role, tables: KASPI_POS_RELEASE_TABLES.length };
}
