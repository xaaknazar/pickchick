/**
 * Edge schema027 (cutover 19.11.2026, lane kds; contracts section 5.9): privileges of the edge
 * runtime role on the KDS foundation tables. Additive: nothing else is granted or revoked here.
 * Integration composes these with edge-runtime-grants.mjs (a full reset) and runs them from
 * kds-upgrade-db.mjs after the migration.
 *
 * P0 runtime needs: read the switch and the active layout (GET fulfillment/layout, admission),
 * write the courier journals (handoff with marks, incidents). kds_settings.layout_enabled and
 * kds_layouts are changed only by the owner tool kds-switch.mjs; the audit table is the owner's.
 * P0 fulfillment transport worker (fulfillment-worker-grants.mjs role) needs to read the switch
 * and the active layout too: it runs the cloud admission (acceptCloud -> buildKitchenPlan).
 * Without them a cloud order keeps today's stations while the KDS screens are open.
 * P1 (manager shift mode, cloud reports) adds its own reviewed grants with migration 028+.
 */
export const MIGRATION = '027_edge_kds_foundation.sql';
export const KDS_TABLES = Object.freeze([
  'kds_setting_changes',
  'kds_layouts',
  'kds_settings',
  'delivery_handovers',
  'courier_incidents',
]);
export const RUNTIME_PRIVILEGES = Object.freeze({
  kds_setting_changes: Object.freeze([]),
  kds_layouts: Object.freeze(['SELECT']),
  kds_settings: Object.freeze(['SELECT']),
  delivery_handovers: Object.freeze(['SELECT', 'INSERT']),
  courier_incidents: Object.freeze(['SELECT', 'INSERT']),
});

/** Fulfillment transport worker: reads the switch and the layout of the cloud admission. */
export const WORKER_PRIVILEGES = Object.freeze({
  kds_setting_changes: Object.freeze([]),
  kds_layouts: Object.freeze(['SELECT']),
  kds_settings: Object.freeze(['SELECT']),
  delivery_handovers: Object.freeze([]),
  courier_incidents: Object.freeze([]),
});

const identifier = (value) => {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(value))
    throw new Error('Invalid KDS grant identifier');
  return '"' + value + '"';
};
/** 'SELECT' -> table privilege; 'UPDATE(a, b)' -> column privilege on a, b. */
function privilegeParts(privilege) {
  const match = /^(SELECT|INSERT|UPDATE)(?:\(([a-z_, ]+)\))?$/.exec(privilege);
  if (!match) throw new Error('Invalid KDS privilege');
  const columns = match[2]?.split(',').map((column) => column.trim());
  for (const column of columns ?? []) identifier(column);
  return { action: match[1], columns };
}

function grantSql(privilegeMap, role, schema) {
  const target = identifier(role),
    namespace = identifier(schema);
  return Object.entries(privilegeMap)
    .filter(([, privileges]) => privileges.length)
    .map(([table, privileges]) => {
      for (const privilege of privileges) privilegeParts(privilege);
      return `GRANT ${privileges.join(', ')} ON ${namespace}.${identifier(table)} TO ${target};`;
    })
    .join('\n');
}
/** Pure SQL for the runtime role (no REVOKE; the caller owns the reset). */
export function kdsRuntimeGrantSql(role, schema = 'public') {
  return grantSql(RUNTIME_PRIVILEGES, role, schema);
}
/** Pure SQL for the fulfillment transport worker role (no REVOKE; the caller owns the reset). */
export function kdsWorkerGrantSql(role, schema = 'public') {
  return grantSql(WORKER_PRIVILEGES, role, schema);
}

/**
 * Proves the exact privilege set of `role` on the five KDS tables: every table and column right
 * equals RUNTIME_PRIVILEGES (nothing more, nothing missing). Other tables are verified by their
 * own helpers. Throws on the first difference; returns a summary otherwise.
 */
export function assertKdsRuntimePrivileges(client, role, schema = 'public') {
  return assertPrivileges(RUNTIME_PRIVILEGES, client, role, schema);
}
/** The same proof for the fulfillment transport worker role and WORKER_PRIVILEGES. */
export function assertKdsWorkerPrivileges(client, role, schema = 'public') {
  return assertPrivileges(WORKER_PRIVILEGES, client, role, schema);
}
async function assertPrivileges(privilegeMap, client, role, schema) {
  identifier(role);
  identifier(schema);
  const relations = (
    await client.query(
      `SELECT c.oid, c.relname,
        has_table_privilege($1, c.oid, 'SELECT') AS can_select,
        has_table_privilege($1, c.oid, 'INSERT') AS can_insert,
        has_table_privilege($1, c.oid, 'UPDATE') AS can_update,
        has_table_privilege($1, c.oid, 'DELETE') AS can_delete,
        has_table_privilege($1, c.oid, 'TRUNCATE') AS can_truncate,
        has_table_privilege($1, c.oid, 'REFERENCES') AS can_references,
        has_table_privilege($1, c.oid, 'TRIGGER') AS can_trigger
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $2 AND c.relkind = 'r' AND c.relname = ANY($3) ORDER BY c.relname`,
      [role, schema, KDS_TABLES],
    )
  ).rows;
  if (relations.length !== KDS_TABLES.length) throw new Error('KDS schema027 tables missing');
  for (const relation of relations) {
    const parts = privilegeMap[relation.relname].map(privilegeParts);
    const whole = (action) => parts.some((part) => part.action === action && !part.columns);
    const columnSet = (action) =>
      new Set(parts.filter((part) => part.action === action).flatMap((p) => p.columns ?? []));
    for (const action of ['select', 'insert', 'update'])
      if (relation['can_' + action] !== whole(action.toUpperCase()))
        throw new Error(`KDS table privileges differ: ${relation.relname}`);
    if (
      relation.can_delete ||
      relation.can_truncate ||
      relation.can_references ||
      relation.can_trigger
    )
      throw new Error(`KDS table privileges differ: ${relation.relname}`);
    const columns = (
      await client.query(
        `SELECT attname,
          has_column_privilege($1, attrelid, attnum, 'SELECT') AS can_select,
          has_column_privilege($1, attrelid, attnum, 'INSERT') AS can_insert,
          has_column_privilege($1, attrelid, attnum, 'UPDATE') AS can_update,
          has_column_privilege($1, attrelid, attnum, 'REFERENCES') AS can_references
         FROM pg_attribute WHERE attrelid = $2 AND attnum > 0 AND NOT attisdropped`,
        [role, relation.oid],
      )
    ).rows;
    for (const column of columns) {
      for (const action of ['select', 'insert', 'update']) {
        const upper = action.toUpperCase();
        if (column['can_' + action] !== (whole(upper) || columnSet(upper).has(column.attname)))
          throw new Error(`KDS column privileges differ: ${relation.relname}.${column.attname}`);
      }
      if (column.can_references)
        throw new Error(`KDS column privileges differ: ${relation.relname}.${column.attname}`);
    }
  }
  return { role, schema, migration: MIGRATION, tables: KDS_TABLES.length, verified: true };
}

/** Roles other than the owner holding any explicit right on the KDS tables (PUBLIC included). */
export async function kdsTableGrantees(client, schema = 'public') {
  identifier(schema);
  return (
    await client.query(
      `SELECT DISTINCT COALESCE(r.rolname, 'PUBLIC') AS grantee FROM pg_class c
       CROSS JOIN LATERAL aclexplode(c.relacl) x LEFT JOIN pg_roles r ON r.oid = x.grantee
       WHERE c.relnamespace = $1::regnamespace AND c.relname = ANY($2) AND x.grantee <> c.relowner
       UNION
       SELECT DISTINCT COALESCE(r.rolname, 'PUBLIC') FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       CROSS JOIN LATERAL aclexplode(a.attacl) x LEFT JOIN pg_roles r ON r.oid = x.grantee
       WHERE c.relnamespace = $1::regnamespace AND c.relname = ANY($2) AND x.grantee <> c.relowner
       ORDER BY 1`,
      [schema, KDS_TABLES],
    )
  ).rows.map((row) => row.grantee);
}
