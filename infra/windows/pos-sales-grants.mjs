/**
 * Edge schema026 (cutover 19.11.2026, lane pos; contracts 3.3 and 5.9): the exact privileges of
 * the paid POS sale objects. Integration wires these lists into edge-runtime-grants.mjs and
 * pos-sales-upgrade-db.mjs; this module only states them, grants them additively and proves them.
 *
 * - Edge HTTP runtime (staff-facing): reads the operator settings, records config fetches,
 *   approvals, sales, tenders, refunds, receipts, Z reports and outbox rows. It never writes the
 *   operator settings (pos_payment_methods, pos_sales_setting_changes, branch_config mode) nor the
 *   sync state, and never updates or deletes a sale, tender, refund or outbox row.
 * - POS sync worker (posSales sender, cloud lane): reads the outbox and records only delivery
 *   (acknowledged_at, attempts, last_error) and its own sync state.
 * Every other 026 object is owner-only. Without 026 none of these relations exist and nothing
 * here is applied (the runtime does not need them for the unpaid flow).
 * Privilege strings: SELECT, INSERT, UPDATE (whole table), UPDATE(col,...) (those columns only);
 * sequences: USAGE.
 */
export const MIGRATION = '026_edge_pos_sales.sql';

/** Every relation 026 creates, with its kind ('r' table, 'S' sequence). */
export const POS_SALES_RELATIONS = Object.freeze({
  pos_sales_setting_changes: 'r',
  pos_sales_setting_changes_change_sequence_seq: 'S',
  pos_payment_methods: 'r',
  pos_config_fetches: 'r',
  local_manager_approvals: 'r',
  pos_sales: 'r',
  pos_sale_tenders: 'r',
  pos_refunds: 'r',
  pos_refund_tenders: 'r',
  pos_fiscal_receipts: 'r',
  pos_shift_reports: 'r',
  pos_sale_outbox: 'r',
  pos_sale_outbox_sequence_seq: 'S',
  pos_sale_sync_state: 'r',
});

export const RUNTIME_PRIVILEGES = Object.freeze({
  pos_payment_methods: Object.freeze(['SELECT']),
  pos_config_fetches: Object.freeze([
    'SELECT',
    'INSERT',
    'UPDATE(staff_id,client_version,last_fetched_at)',
  ]),
  local_manager_approvals: Object.freeze([
    'SELECT',
    'INSERT',
    'UPDATE(consumed_at,consumed_command_key)',
  ]),
  pos_sales: Object.freeze(['SELECT', 'INSERT']),
  pos_sale_tenders: Object.freeze(['SELECT', 'INSERT']),
  pos_refunds: Object.freeze(['SELECT', 'INSERT']),
  pos_refund_tenders: Object.freeze(['SELECT', 'INSERT']),
  pos_fiscal_receipts: Object.freeze([
    'SELECT',
    'INSERT',
    'UPDATE(state,receipt_number,version,recorded_by_staff_id,recorded_at,approval_id)',
  ]),
  pos_shift_reports: Object.freeze(['SELECT', 'INSERT']),
  pos_sale_outbox: Object.freeze(['SELECT', 'INSERT']),
  pos_sale_outbox_sequence_seq: Object.freeze(['USAGE']),
});

export const WORKER_PRIVILEGES = Object.freeze({
  pos_sale_outbox: Object.freeze(['SELECT', 'UPDATE(acknowledged_at,attempts,last_error)']),
  pos_sale_sync_state: Object.freeze(['SELECT', 'INSERT', 'UPDATE']),
});

function identifier(value) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(value))
    throw new Error('Invalid POS sales grant identifier');
  return '"' + value + '"';
}

/** Parsed privilege map: {relation: {kind, select, insert, update: true | string[], usage}}. */
export function parsePrivileges(privileges, relations = POS_SALES_RELATIONS) {
  if (!privileges || typeof privileges !== 'object')
    throw new Error('Invalid POS sales privileges');
  const result = {};
  for (const [relation, list] of Object.entries(privileges)) {
    const kind = relations[relation];
    identifier(relation);
    if (!kind || !Array.isArray(list) || list.length === 0 || new Set(list).size !== list.length)
      throw new Error('Invalid POS sales privileges');
    const entry = { kind, select: false, insert: false, update: [], usage: false };
    for (const item of list) {
      const columns = /^UPDATE\(([a-z_,]+)\)$/.exec(item);
      if (kind === 'S' && item === 'USAGE') entry.usage = true;
      else if (kind === 'r' && item === 'SELECT') entry.select = true;
      else if (kind === 'r' && item === 'INSERT') entry.insert = true;
      else if (kind === 'r' && item === 'UPDATE' && Array.isArray(entry.update))
        entry.update = true;
      else if (kind === 'r' && columns && Array.isArray(entry.update) && !entry.update.length) {
        entry.update = columns[1].split(',');
        entry.update.forEach(identifier);
      } else throw new Error('Invalid POS sales privileges');
    }
    result[relation] = entry;
  }
  return result;
}

/** Additive GRANT statements of one privilege map (contracts 5.9 lists) for an existing role. */
export function posSalesGrantSql(
  role,
  privileges,
  schema = 'public',
  relations = POS_SALES_RELATIONS,
) {
  const target = identifier(role),
    namespace = identifier(schema);
  const lines = [];
  for (const [relation, entry] of Object.entries(parsePrivileges(privileges, relations))) {
    const name = `${namespace}.${identifier(relation)}`;
    if (entry.kind === 'S') {
      lines.push(`GRANT USAGE ON SEQUENCE ${name} TO ${target};`);
      continue;
    }
    const table = [
      entry.select && 'SELECT',
      entry.insert && 'INSERT',
      entry.update === true && 'UPDATE',
    ]
      .filter(Boolean)
      .join(', ');
    if (table) lines.push(`GRANT ${table} ON ${name} TO ${target};`);
    if (Array.isArray(entry.update) && entry.update.length)
      lines.push(
        `GRANT UPDATE(${entry.update.map(identifier).join(', ')}) ON ${name} TO ${target};`,
      );
  }
  return lines.join('\n');
}
export const posSalesRuntimeGrants = (role, schema = 'public') =>
  posSalesGrantSql(role, RUNTIME_PRIVILEGES, schema);
export const posSalesWorkerGrants = (role, schema = 'public') =>
  posSalesGrantSql(role, WORKER_PRIVILEGES, schema);

/**
 * Proves that `role` holds exactly `privileges` on the 026 relations of `schema` (effective rights,
 * PUBLIC included): nothing missing, nothing extra, no DELETE/TRUNCATE/REFERENCES/TRIGGER, column
 * UPDATE only where listed. Relations missing from the map must be unreachable. Throws naming the
 * relation only; returns {verified, relations}.
 */
export async function assertPosSalesPrivileges(
  client,
  role,
  privileges,
  { schema = 'public', relations = POS_SALES_RELATIONS } = {},
) {
  identifier(role);
  identifier(schema);
  const expected = parsePrivileges(privileges, relations);
  const rows = (
    await client.query(
      `SELECT c.oid,c.relname,c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname=$1 AND c.relname=ANY($2::text[])`,
      [schema, Object.keys(relations)],
    )
  ).rows;
  if (
    rows.length !== Object.keys(relations).length ||
    rows.some((row) => row.relkind !== relations[row.relname])
  )
    throw new Error('POS sales relations differ from schema026');
  for (const row of rows) {
    const want = expected[row.relname] ?? {
      kind: row.relkind,
      select: false,
      insert: false,
      update: [],
      usage: false,
    };
    if (row.relkind === 'S') {
      const actual = (
        await client.query(
          `SELECT has_sequence_privilege($1,$2::oid,'USAGE') AS usage,
            has_sequence_privilege($1,$2::oid,'SELECT') AS sel,
            has_sequence_privilege($1,$2::oid,'UPDATE') AS upd`,
          [role, row.oid],
        )
      ).rows[0];
      if (actual.usage !== want.usage || actual.sel || actual.upd)
        throw new Error(`POS sales sequence privileges differ: ${row.relname}`);
      continue;
    }
    const table = (
      await client.query(
        `SELECT has_table_privilege($1,$2::oid,'SELECT') AS sel,
          has_table_privilege($1,$2::oid,'INSERT') AS ins,
          has_table_privilege($1,$2::oid,'UPDATE') AS upd,
          has_table_privilege($1,$2::oid,'DELETE,TRUNCATE,REFERENCES,TRIGGER') AS other`,
        [role, row.oid],
      )
    ).rows[0];
    if (
      table.other ||
      table.sel !== want.select ||
      table.ins !== want.insert ||
      table.upd !== (want.update === true)
    )
      throw new Error(`POS sales table privileges differ: ${row.relname}`);
    const columns = (
      await client.query(
        `SELECT attname,
          has_column_privilege($1,attrelid,attnum,'SELECT') AS sel,
          has_column_privilege($1,attrelid,attnum,'INSERT') AS ins,
          has_column_privilege($1,attrelid,attnum,'UPDATE') AS upd,
          has_column_privilege($1,attrelid,attnum,'REFERENCES') AS ref
         FROM pg_attribute WHERE attrelid=$2::oid AND attnum>0 AND NOT attisdropped`,
        [role, row.oid],
      )
    ).rows;
    for (const column of columns)
      if (
        column.ref ||
        column.sel !== want.select ||
        column.ins !== want.insert ||
        column.upd !== (want.update === true || want.update.includes(column.attname))
      )
        throw new Error(`POS sales column privileges differ: ${row.relname}`);
    if (
      Array.isArray(want.update) &&
      want.update.some((name) => !columns.some((c) => c.attname === name))
    )
      throw new Error(`POS sales column missing: ${row.relname}`);
  }
  return { verified: true, relations: rows.length };
}

/** Grantees (roles, or PUBLIC) holding any table, column or sequence privilege on 026 objects. */
export async function posSalesGrantees(
  client,
  { schema = 'public', relations = POS_SALES_RELATIONS } = {},
) {
  identifier(schema);
  const rows = (
    await client.query(
      `SELECT DISTINCT coalesce(r.rolname,'PUBLIC') AS grantee FROM pg_class c
       JOIN pg_namespace n ON n.oid=c.relnamespace
       CROSS JOIN LATERAL (SELECT (aclexplode(c.relacl)).grantee
         UNION SELECT (aclexplode(a.attacl)).grantee FROM pg_attribute a WHERE a.attrelid=c.oid) g
       LEFT JOIN pg_roles r ON r.oid=g.grantee
       WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) AND g.grantee<>c.relowner
       ORDER BY 1`,
      [schema, Object.keys(relations)],
    )
  ).rows;
  return rows.map((row) => row.grantee);
}
