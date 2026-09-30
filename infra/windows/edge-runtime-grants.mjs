import { transaction } from '@pickchick/database';

const posRead = [
  'schema_migrations',
  'branch_config',
  'menu_snapshots',
  'active_menu',
  'local_staff',
  'local_terminals',
  'staff_sessions',
  'local_stops',
  'checkout_quotes',
  'local_orders',
  'local_command_results',
  'local_order_streams',
  'local_cash_shifts',
  'local_cash_movements',
  'local_staff_passwords',
  'local_staff_pins',
  'local_pin_lookup_keys',
  'local_staff_login_limits',
];
const kitchenRead = [
  'fulfillment_config',
  'fulfillment_stations',
  'fulfillment_station_grants',
  'fulfillment_routing',
  'fulfillment_reservations',
  'fulfillment_tasks',
  'fulfillment_inbox',
  'fulfillment_commands',
  'fulfillment_outbox',
];

function identifier(value) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(value))
    throw new Error('Invalid edge grant identifier');
  return '"' + value + '"';
}

/** Only the staff-facing POS and kitchen HTTP service, not setup/cloud transport workers. */
export function edgeRuntimeGrantSql(role, { schema = 'public', fulfillment = false } = {}) {
  const target = identifier(role),
    namespace = identifier(schema);
  if (typeof fulfillment !== 'boolean') throw new Error('Invalid fulfillment grant flag');
  const tables = (names) => names.map((name) => `${namespace}.${identifier(name)}`).join(', ');
  const grant = (privilege, names) => `GRANT ${privilege} ON ${tables(names)} TO ${target};`;
  return [
    `GRANT USAGE ON SCHEMA ${namespace} TO ${target};`,
    grant('SELECT', posRead),
    grant('UPDATE(access_expires_at)', ['local_staff']),
    grant('UPDATE(revoked)', ['staff_sessions']),
    grant('UPDATE(failed_attempts, locked_until)', ['local_staff_passwords', 'local_staff_pins']),
    grant('INSERT', ['staff_sessions', 'local_staff_login_limits']),
    grant('UPDATE(window_started_at, attempts)', ['local_staff_login_limits']),
    grant('UPDATE(lock_anchor)', ['local_staff', 'local_terminals', 'staff_sessions']),
    grant('UPDATE(ordering_enabled, ordering_version)', ['branch_config']),
    grant('INSERT', [
      'checkout_quotes',
      'local_orders',
      'local_command_results',
      'local_order_streams',
      'outbox_events',
      'local_audit',
      'local_cash_shifts',
      'local_cash_movements',
    ]),
    grant('UPDATE(state, version, cancellation_reason)', ['local_orders']),
    grant(
      'UPDATE(state, version, closed_at, closed_by_staff_id, counted_cash_minor, discrepancy_minor, closing_reason, closed_report)',
      ['local_cash_shifts'],
    ),
    grant('UPDATE(last_sequence)', ['local_order_streams']),
    grant('INSERT', ['local_stops']),
    grant(
      'UPDATE(stopped, version, reason, expires_at, expires_shift_id, updated_at, updated_by)',
      ['local_stops'],
    ),
    ...(fulfillment
      ? [
          grant('SELECT', kitchenRead),
          grant('UPDATE(lock_anchor)', [
            'fulfillment_config',
            'fulfillment_stations',
            'fulfillment_station_grants',
          ]),
          grant('UPDATE(state, version, updated_at)', ['fulfillment_tasks']),
          grant('UPDATE(state, version, updated_at, cancellation_reason, inventory_disposition)', [
            'fulfillment_reservations',
          ]),
          grant('INSERT', [
            'fulfillment_commands',
            'fulfillment_outbox',
            'fulfillment_reservations',
            'fulfillment_tasks',
          ]),
          `GRANT USAGE ON SEQUENCE ${namespace}.fulfillment_display_sequence TO ${target};`,
          `GRANT USAGE ON SEQUENCE ${namespace}.fulfillment_outbox_sequence_seq TO ${target};`,
        ]
      : []),
  ].join('\n');
}

/** Apply to a pre-created, dedicated, unprivileged runtime role in one transaction. */
export async function applyEdgeRuntimeGrants(pool, role, options = {}) {
  const sql = edgeRuntimeGrantSql(role, options);
  const schema = options.schema ?? 'public';
  const target = identifier(role),
    namespace = identifier(schema);
  return transaction(pool, async (client) => {
    const roleResult = await client.query(
      `SELECT oid,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls
       FROM pg_roles WHERE rolname=$1`,
      [role],
    );
    const actual = roleResult.rows[0];
    if (!actual || Object.entries(actual).some(([key, value]) => key !== 'oid' && value))
      throw new Error('Unprivileged runtime role required');
    const unsafe = await client.query(
      `SELECT 1 WHERE EXISTS(SELECT 1 FROM pg_auth_members WHERE member=$1)
       OR EXISTS(SELECT 1 FROM pg_shdepend
         WHERE refclassid='pg_authid'::regclass AND refobjid=$1 AND deptype='o')`,
      [actual.oid],
    );
    if (unsafe.rowCount) throw new Error('Runtime role may not own objects or inherit roles');
    const ledger = await client.query(
      `SELECT 1 FROM ${namespace}.schema_migrations WHERE scope='edge' AND version='012_edge_pos_unpaid_fulfillment.sql'`,
    );
    if (ledger.rowCount !== 1) throw new Error('Edge migration 012 required');
    const otherScope = await client.query(
      `SELECT 1 FROM ${namespace}.schema_migrations WHERE scope<>'edge' LIMIT 1`,
    );
    if (otherScope.rowCount) throw new Error('Edge-only schema required');
    // PUBLIC grants cannot be removed from just this role and would defeat the
    // allowlist below. The installer must use a dedicated private database.
    const publicAccess = await client.query(
      `SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       CROSS JOIN LATERAL aclexplode(c.relacl) p
       WHERE n.nspname=$1 AND p.grantee=0
       UNION ALL
       SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       JOIN pg_attribute a ON a.attrelid=c.oid
       CROSS JOIN LATERAL aclexplode(a.attacl) p
       WHERE n.nspname=$1 AND p.grantee=0 LIMIT 1`,
      [schema],
    );
    if (publicAccess.rowCount)
      throw new Error('Remove public relation privileges before runtime grants');
    // Reapply is a reset, including prior explicit column grants. REVOKE ALL ON
    // TABLE alone does not revoke column privileges. Never touch another schema.
    const relations = await client.query(
      `SELECT c.relname,c.relkind,array_agg(a.attname::text ORDER BY a.attnum) FILTER(WHERE a.attnum>0 AND NOT a.attisdropped) AS columns
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       LEFT JOIN pg_attribute a ON a.attrelid=c.oid
       WHERE n.nspname=$1 AND c.relkind IN ('r','p','S','v','m','f') GROUP BY c.oid`,
      [schema],
    );
    for (const relation of relations.rows) {
      const name = `${namespace}.${identifier(relation.relname)}`;
      if (relation.relkind === 'S') {
        await client.query(`REVOKE ALL ON SEQUENCE ${name} FROM ${target}`);
      } else {
        await client.query(`REVOKE ALL ON TABLE ${name} FROM ${target}`);
        if (relation.columns?.length) {
          const columns = relation.columns.map(identifier).join(',');
          await client.query(
            `REVOKE SELECT(${columns}),INSERT(${columns}),UPDATE(${columns}),REFERENCES(${columns}) ON ${name} FROM ${target}`,
          );
        }
      }
    }
    await client.query(`REVOKE ALL ON SCHEMA ${namespace} FROM ${target}`);
    await client.query(sql);
    const create = await client.query("SELECT has_schema_privilege($1,$2,'CREATE') AS permitted", [
      role,
      schema,
    ]);
    if (create.rows[0].permitted)
      throw new Error('Public schema CREATE must be removed before runtime grants');
    return { role, schema, fulfillment: options.fulfillment ?? false };
  });
}
