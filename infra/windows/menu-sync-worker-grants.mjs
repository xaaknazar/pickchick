/** Dedicated edge menu-sync worker role (pickchick_menu_sync, edge schema018).
 *
 * The worker applies cloud menu publications (packages/menu-sync edge.ts/worker.ts/media.ts):
 * snapshot, active menu, inbox, cursor, durable ACK outbox, apply result, photo cache and the
 * derived kitchen routing. It never reads staff, orders, stops, cash or credentials.
 * Every UPDATE column below is one that edge.ts or worker.ts actually writes; FOR UPDATE on
 * branch_config/fulfillment_config needs an UPDATE privilege, so the narrowest one is used.
 */
export const MENU_SYNC_ROLE = 'pickchick_menu_sync';

/** Expected privileges per table: SELECT/INSERT on the whole table, UPDATE on listed columns. */
export const MENU_SYNC_PRIVILEGES = Object.freeze({
  schema_migrations: { select: true, insert: false, update: [] },
  // Branch lock (SELECT ... FOR UPDATE). The singleton column only accepts true.
  branch_config: { select: true, insert: false, update: ['singleton'] },
  menu_snapshots: { select: true, insert: true, update: [] },
  active_menu: { select: true, insert: true, update: ['release_id'] },
  // INSERT ... ON CONFLICT DO UPDATE SET last_sequence; producer_id is only inserted.
  menu_sync_state: { select: true, insert: true, update: ['last_sequence'] },
  inbox_messages: { select: true, insert: true, update: [] },
  outbox_events: { select: true, insert: true, update: ['attempts', 'acknowledged_at'] },
  menu_media: { select: true, insert: true, update: [] },
  menu_apply_results: { select: true, insert: true, update: [] },
  fulfillment_config: { select: true, insert: false, update: ['active_routing_version'] },
  fulfillment_routing: { select: true, insert: true, update: [] },
  fulfillment_stations: { select: true, insert: false, update: [] },
});

function identifier(value) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(value))
    throw new Error('Invalid menu sync grant identifier');
  return '"' + value + '"';
}

/** Pure SQL for an already reset, dedicated role. Requires applied edge schema018. */
export function menuSyncWorkerGrants(role = MENU_SYNC_ROLE, schema = 'public') {
  const target = identifier(role),
    namespace = identifier(schema);
  const relation = (name) => `${namespace}.${identifier(name)}`;
  const entries = Object.entries(MENU_SYNC_PRIVILEGES);
  const tables = (predicate) =>
    entries
      .filter(([, privileges]) => predicate(privileges))
      .map(([name]) => relation(name))
      .join(', ');
  return [
    `GRANT USAGE ON SCHEMA ${namespace} TO ${target};`,
    `GRANT SELECT ON ${tables((p) => p.select)} TO ${target};`,
    `GRANT INSERT ON ${tables((p) => p.insert)} TO ${target};`,
    ...entries
      .filter(([, privileges]) => privileges.update.length)
      .map(
        ([name, privileges]) =>
          `GRANT UPDATE(${privileges.update.map(identifier).join(', ')}) ON ${relation(name)} TO ${target};`,
      ),
  ].join('\n');
}

/** Removes every table, column, sequence and schema privilege the role holds in this schema. */
export async function revokeMenuSyncPrivileges(client, role = MENU_SYNC_ROLE, schema = 'public') {
  const target = identifier(role),
    namespace = identifier(schema);
  const relations = await client.query(
    `SELECT c.relname,c.relkind,array_agg(a.attname::text ORDER BY a.attnum)
       FILTER(WHERE a.attnum>0 AND NOT a.attisdropped) AS columns
     FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     LEFT JOIN pg_attribute a ON a.attrelid=c.oid
     WHERE n.nspname=$1 AND c.relkind IN ('r','p','S','v','m','f') GROUP BY c.oid`,
    [schema],
  );
  for (const row of relations.rows) {
    const name = `${namespace}.${identifier(row.relname)}`;
    if (row.relkind === 'S') {
      await client.query(`REVOKE ALL ON SEQUENCE ${name} FROM ${target}`);
      continue;
    }
    await client.query(`REVOKE ALL ON TABLE ${name} FROM ${target}`);
    // REVOKE ALL ON TABLE does not remove earlier column grants.
    if (row.columns?.length) {
      const columns = row.columns.map(identifier).join(',');
      await client.query(
        `REVOKE SELECT(${columns}),INSERT(${columns}),UPDATE(${columns}),REFERENCES(${columns}) ON ${name} FROM ${target}`,
      );
    }
  }
  await client.query(`REVOKE ALL ON SCHEMA ${namespace} FROM ${target}`);
}

/**
 * Proves the exact privilege set with has_table_privilege/has_column_privilege over every
 * relation and column in the schema: nothing missing, nothing extra, no sequences, no
 * functions beyond PostgreSQL defaults, no CREATE. Throws without naming secrets.
 */
export async function assertMenuSyncPrivileges(
  client,
  role = MENU_SYNC_ROLE,
  schema = 'public',
  // The native foundation revokes PUBLIC CREATE/TEMP on pickchick_edge; shared development
  // databases keep the PostgreSQL defaults, so isolated tests opt out of that one check.
  { databaseDefaultsRevoked = true } = {},
) {
  identifier(role);
  identifier(schema);
  const relations = (
    await client.query(
      `SELECT c.oid,c.relname,
        has_table_privilege($1,c.oid,'SELECT') AS sel,
        has_table_privilege($1,c.oid,'INSERT') AS ins,
        has_table_privilege($1,c.oid,'UPDATE') AS upd,
        has_table_privilege($1,c.oid,'DELETE,TRUNCATE,REFERENCES,TRIGGER') AS other
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname=$2 AND c.relkind IN ('r','p','v','m','f') ORDER BY c.relname`,
      [role, schema],
    )
  ).rows;
  for (const name of Object.keys(MENU_SYNC_PRIVILEGES))
    if (!relations.some((relation) => relation.relname === name))
      throw new Error('Menu sync schema018 relation missing');
  for (const relation of relations) {
    const expected = MENU_SYNC_PRIVILEGES[relation.relname];
    if (
      relation.other ||
      relation.sel !== Boolean(expected?.select) ||
      relation.ins !== Boolean(expected?.insert) ||
      relation.upd
    )
      throw new Error(`Menu sync table privileges differ: ${relation.relname}`);
    const columns = (
      await client.query(
        `SELECT attname,
          has_column_privilege($1,attrelid,attnum,'SELECT') AS sel,
          has_column_privilege($1,attrelid,attnum,'INSERT') AS ins,
          has_column_privilege($1,attrelid,attnum,'UPDATE') AS upd,
          has_column_privilege($1,attrelid,attnum,'REFERENCES') AS ref
         FROM pg_attribute WHERE attrelid=$2 AND attnum>0 AND NOT attisdropped`,
        [role, relation.oid],
      )
    ).rows;
    for (const column of columns)
      if (
        column.ref ||
        column.sel !== Boolean(expected?.select) ||
        column.ins !== Boolean(expected?.insert) ||
        column.upd !== Boolean(expected?.update.includes(column.attname))
      )
        throw new Error(`Menu sync column privileges differ: ${relation.relname}`);
  }
  const extra = (
    await client.query(
      `SELECT
        has_schema_privilege($1,$2,'CREATE') AS schema_create,
        NOT has_schema_privilege($1,$2,'USAGE') AS schema_usage_missing,
        ($3 AND has_database_privilege($1,current_database(),'CREATE,TEMP')) AS database_write,
        EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname=$2 AND CASE WHEN c.relkind='S'
            THEN has_sequence_privilege($1,c.oid,'USAGE,SELECT,UPDATE') ELSE false END) AS sequences,
        EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname=$1 AND (r.rolsuper OR r.rolcreatedb
          OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls OR r.rolinherit)) AS attributes,
        EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member OR r.oid=m.roleid
          WHERE r.rolname=$1) AS membership`,
      [role, schema, databaseDefaultsRevoked === true],
    )
  ).rows[0];
  if (Object.values(extra).some(Boolean)) throw new Error('Menu sync role exceeds reviewed rights');
  return { role, schema, tables: Object.keys(MENU_SYNC_PRIVILEGES).length, verified: true };
}
