#!/usr/bin/env node
/**
 * Owner operator of the cloud kitchen release (ADR-0014, docs/operations/cloud-kitchen-release.md).
 * Runs in the `provision` service of the candidate release (owner database role):
 *
 *   inspect | deploy                 exact cloud052 -> 056 additive transaction plus the reviewed
 *                                    runtime grants (053 numbers, 054 kitchen, 055 stops, 056
 *                                    screens/orders); flags stay off, every branch stays `edge`.
 *   status   --branch <uuid>         mode, stations/routing, active portal screens, active orders.
 *   stations --branch <uuid>         trusted station/routing provisioning (JSON on stdin): either the
 *                                    full {branchId, stations, routing} or the minimal
 *                                    {branchId, stations, routeAllProductsTo: <prep station id>}, which
 *                                    routes every product of the branch's head catalog publication to
 *                                    that prep station (routing version only moves when routes change).
 *   stations-preview --branch <uuid> read-only: the routing the same stdin would load.
 *   mode     --branch <uuid> --owner edge|cloud --operator <name> --reason <text>
 *                                    audited cloud_kitchen_set_mode (journal + epoch).
 *
 * Output is one JSON line without secrets. Guards print only curated messages.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fingerprint, runtimePrivileges, OwnerGuardError } from './unified-menu-owner.mjs';
import { channelNumberGrants } from './channel-number-grants.mjs';
import { cloudKitchenGrants } from './cloud-kitchen-grants.mjs';
import {
  cloudChannelAvailabilityGrants,
  cloudChannelStopGrants,
} from './cloud-channel-stop-grants.mjs';
import {
  cloudChannelOrderGrants,
  cloudKitchenScreenGrants,
} from './cloud-kitchen-screen-grants.mjs';

export const MIGRATIONS = [
  '053_cloud_channel_numbers.sql',
  '054_cloud_kitchen_fulfillment.sql',
  '055_cloud_channel_stops.sql',
  '056_cloud_kitchen_screens.sql',
];
export const BASELINE_NUMBERS = [
  ...Array.from({ length: 40 }, (_, i) => i + 1),
  ...Array.from({ length: 11 }, (_, i) => i + 42),
];
/** 055 adds one defaulted column to the live remote-stop queue (048); nothing else existing changes. */
export const ADDED_COLUMNS = { cloud_stop_commands: ['delivery_policy'] };
/** Identity sequences owned by the new tables (no runtime grant is needed for IDENTITY). */
export const NEW_SEQUENCES = ['cloud_kitchen_outbox_sequence_seq'];
/** 053 seeds the two fixed channel ranges; every other new table must be empty. */
export const SEEDED = { channel_number_ranges: 2 };
const T = (names) => names.split(',');
const tablePrivs = (tables, privs) => tables.flatMap((t) => privs.map((p) => `${t}||${p}`));
const columnPrivs = (table, columns) => columns.map((c) => `${table}|${c}|UPDATE`);
/** Exact union of the four reviewed grant files for one runtime role (table|column|privilege). */
export const EXPECTED_PRIVILEGES = [
  ...new Set([
    ...tablePrivs(
      T('channel_number_ranges,channel_number_shifts,channel_number_counters,channel_number_holds'),
      ['SELECT'],
    ),
    ...tablePrivs(
      T(
        'branch_channel_modes,branch_channel_mode_changes,cloud_kitchen_stations,cloud_kitchen_routing,cloud_kitchen_config',
      ),
      ['SELECT'],
    ),
    ...tablePrivs(T('cloud_kitchen_admissions,cloud_kitchen_commands'), ['SELECT', 'INSERT']),
    ...tablePrivs(
      T(
        'cloud_kitchen_orders,cloud_kitchen_tasks,cloud_kitchen_outbox,cloud_kitchen_station_presence',
      ),
      ['SELECT', 'INSERT', 'UPDATE'],
    ),
    ...tablePrivs(T('cloud_channel_stops,cloud_channel_stop_events,cloud_stale_stop_overrides'), [
      'SELECT',
      'INSERT',
    ]),
    ...columnPrivs(
      'cloud_channel_stops',
      T('stopped,duration,reason,version,actor_id,actor_label'),
    ),
    ...tablePrivs(
      T('cloud_kitchen_screens,cloud_kitchen_pairing_codes,cloud_kitchen_screen_events'),
      ['SELECT', 'INSERT'],
    ),
    ...columnPrivs(
      'cloud_kitchen_screens',
      T('generation,key_hash,key_issued_at,revoked_at,revoked_by,revoked_reason,last_seen_at'),
    ),
    ...columnPrivs('cloud_kitchen_pairing_codes', T('failed_attempts,used_at,burned_at')),
    ...tablePrivs(['cloud_channel_orders'], ['SELECT', 'INSERT']),
  ]),
].sort();
export const EXPECTED_FUNCTIONS = [
  'channel_number_allocate(uuid, text, uuid)',
  'channel_number_open_shift(uuid, text)',
  'channel_number_release(uuid)',
  'cloud_kitchen_set_mode(uuid, text, text, text)',
];

const guard = (condition, message) => {
  if (!condition) throw new OwnerGuardError(message);
};
const hash = (text) => createHash('sha256').update(text).digest('hex');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Order matters: later files revoke-then-grant overlapping tables (see each file's header). */
export function releaseGrants(role) {
  return [
    channelNumberGrants(role, true),
    cloudKitchenGrants(role, true),
    cloudChannelAvailabilityGrants(role, true),
    cloudChannelStopGrants(role, true),
    cloudKitchenScreenGrants(role, true),
    cloudChannelOrderGrants(role, true),
  ].join('\n');
}

export function newTables(sqlByName) {
  const result = new Set();
  for (const name of MIGRATIONS)
    for (const m of sqlByName.get(name).matchAll(/CREATE\s+TABLE\s+([a-z][a-z0-9_]*)/gi))
      result.add(m[1]);
  return [...result].sort();
}

async function columns(c) {
  return Object.fromEntries(
    (
      await c.query(
        `SELECT c.relname AS name,array_agg(a.attname::text ORDER BY a.attnum) AS columns FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped WHERE n.nspname=current_schema() AND c.relkind IN ('r','p') GROUP BY c.relname ORDER BY c.relname`,
      )
    ).rows.map((r) => [r.name, r.columns]),
  );
}
async function sequenceNames(c) {
  return (
    await c.query(
      'SELECT sequencename AS name FROM pg_sequences WHERE schemaname=current_schema() ORDER BY 1',
    )
  ).rows
    .map((r) => r.name)
    .sort();
}
async function roles(c) {
  return (
    await c.query(
      `SELECT rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls,rolconnlimit,rolvaliduntil,rolconfig FROM pg_roles ORDER BY rolname`,
    )
  ).rows;
}
/** Explicit EXECUTE grants of `role` on functions of the schema ("name(argtypes)"). */
export async function functionPrivileges(c, role) {
  return (
    await c.query(
      `SELECT p.proname||'('||oidvectortypes(p.proargtypes)||')' AS f FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace CROSS JOIN LATERAL aclexplode(p.proacl) x JOIN pg_roles r ON r.oid=x.grantee WHERE n.nspname=current_schema() AND r.rolname=$1 AND x.privilege_type='EXECUTE' ORDER BY 1`,
      [role],
    )
  ).rows.map((r) => r.f);
}
async function otherAcl(c, role, excluded) {
  return (
    await c.query(
      `SELECT c.relname,a.attname,x.grantor,x.grantee,x.privilege_type,x.is_grantable FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped CROSS JOIN LATERAL aclexplode(a.attacl) x WHERE n.nspname=current_schema() AND c.relkind IN ('r','p','v','m','f','S') AND x.grantee<>(SELECT oid FROM pg_roles WHERE rolname=$1) UNION ALL SELECT c.relname,NULL,x.grantor,x.grantee,x.privilege_type,x.is_grantable FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault(CASE WHEN c.relkind='S' THEN 'S'::"char" ELSE 'r'::"char" END,c.relowner))) x WHERE n.nspname=current_schema() AND c.relkind IN ('r','p','v','m','f','S') AND x.grantee<>(SELECT oid FROM pg_roles WHERE rolname=$1) AND c.relname<>ALL($2::text[]) ORDER BY 1,2,3,4,5`,
      [role, excluded],
    )
  ).rows;
}

/** Ledger must be exactly the cloud052 baseline (1-40, 42-52) of the candidate files. */
export async function releasePlan(c, directory) {
  const files = (await readdir(directory)).filter((n) => /^\d{3}_[a-z0-9_]+\.sql$/.test(n)).sort();
  guard(
    JSON.stringify(files.slice(-MIGRATIONS.length)) === JSON.stringify(MIGRATIONS),
    'Candidate must end at cloud053-056',
  );
  guard(
    JSON.stringify(files.slice(0, -MIGRATIONS.length).map((n) => +n.slice(0, 3))) ===
      JSON.stringify(BASELINE_NUMBERS),
    'Exact cloud052 baseline required',
  );
  const sql = new Map(
    await Promise.all(files.map(async (n) => [n, await readFile(join(directory, n), 'utf8')])),
  );
  const ledger = (
    await c.query('SELECT version,checksum,scope FROM schema_migrations ORDER BY version')
  ).rows;
  guard(
    ledger.length === files.length - MIGRATIONS.length &&
      ledger.every(
        (r, i) =>
          r.version === files[i] && r.scope === 'cloud' && r.checksum === hash(sql.get(r.version)),
      ),
    'Exact cloud052 ledger required; applied/partial 053-056 is not replayed',
  );
  return { sql, ledger };
}

export async function deployCloudKitchen(c, { directory, role, inspect = false }) {
  guard(/^[a-z][a-z0-9_]{0,62}$/.test(role), 'Invalid runtime role');
  await c.query("SET LOCAL lock_timeout='5s';SET LOCAL statement_timeout='120s'");
  if (!inspect) await c.query('SELECT pg_advisory_xact_lock($1)', [724014]);
  const plan = await releasePlan(c, directory);
  const tables = newTables(plan.sql);
  const before = await columns(c);
  const aclBefore = await runtimePrivileges(c, role);
  const functionsBefore = await functionPrivileges(c, role);
  guard(
    tables.every((t) => !(t in before)),
    'A cloud kitchen table exists before 053',
  );
  const required = EXPECTED_PRIVILEGES.filter((p) => !aclBefore.includes(p));
  if (inspect) return { pending: MIGRATIONS, newTables: tables, privilegesAdded: required };
  const existing = Object.fromEntries(
    Object.entries(before).filter(([name]) => name !== 'schema_migrations'),
  );
  const data = await fingerprint(c, existing),
    rolesBefore = await roles(c),
    otherBefore = await otherAcl(c, role, [...tables, ...NEW_SEQUENCES]),
    sequencesBefore = await sequenceNames(c);
  const appended = [];
  for (const name of MIGRATIONS) {
    await c.query(plan.sql.get(name));
    const row = { version: name, checksum: hash(plan.sql.get(name)), scope: 'cloud' };
    await c.query('INSERT INTO schema_migrations(version,checksum,scope) VALUES($1,$2,$3)', [
      row.version,
      row.checksum,
      row.scope,
    ]);
    appended.push(row);
  }
  const ledgerAfter = (
    await c.query('SELECT version,checksum,scope FROM schema_migrations ORDER BY version')
  ).rows;
  guard(
    JSON.stringify(ledgerAfter) === JSON.stringify([...plan.ledger, ...appended]),
    'Existing migration ledger changed',
  );
  await c.query(releaseGrants(role));
  const after = await columns(c);
  guard(
    JSON.stringify(Object.keys(after).sort()) ===
      JSON.stringify([...Object.keys(before), ...tables].sort()),
    'Unexpected table delta',
  );
  for (const [table, cols] of Object.entries(before))
    guard(
      JSON.stringify(after[table]) === JSON.stringify([...cols, ...(ADDED_COLUMNS[table] ?? [])]),
      'Existing columns changed: ' + table,
    );
  guard(
    (
      await c.query(
        "SELECT count(*)::int AS n FROM cloud_stop_commands WHERE delivery_policy<>'ttl'",
      )
    ).rows[0].n === 0,
    'Existing remote stops must keep the ttl delivery policy',
  );
  guard(
    JSON.stringify(await fingerprint(c, existing)) === JSON.stringify(data),
    'Existing data changed within migration transaction',
  );
  for (const t of tables)
    guard(
      (await c.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n === (SEEDED[t] ?? 0),
      'New cloud kitchen tables must be empty (053 ranges seeded only)',
    );
  guard(
    JSON.stringify(await runtimePrivileges(c, role)) ===
      JSON.stringify([...new Set([...aclBefore, ...EXPECTED_PRIVILEGES])].sort()),
    'Unexpected runtime ACL delta',
  );
  guard(
    JSON.stringify(await functionPrivileges(c, role)) ===
      JSON.stringify([...new Set([...functionsBefore, ...EXPECTED_FUNCTIONS])].sort()),
    'Unexpected runtime function ACL delta',
  );
  guard(
    JSON.stringify(await sequenceNames(c)) ===
      JSON.stringify([...sequencesBefore, ...NEW_SEQUENCES].sort()),
    'Unexpected sequence delta',
  );
  guard(JSON.stringify(await roles(c)) === JSON.stringify(rolesBefore), 'Role attributes changed');
  guard(
    JSON.stringify(await otherAcl(c, role, [...tables, ...NEW_SEQUENCES])) ===
      JSON.stringify(otherBefore),
    'Other role ACL changed',
  );
  const modes = (await c.query('SELECT count(*)::int AS n FROM branch_channel_modes')).rows[0].n;
  guard(modes === 0, 'Every branch must remain edge after deploy');
  return {
    applied: MIGRATIONS,
    existingDataPreserved: true,
    privilegesAdded: required,
    functionsAdded: EXPECTED_FUNCTIONS.filter((f) => !functionsBefore.includes(f)),
    privilegesRemoved: [],
    newTables: tables,
    allBranchesEdge: true,
  };
}

const SETUP_FULL = 'branchId,routing,stations';
const SETUP_MINIMAL = 'branchId,routeAllProductsTo,stations';
const routeKey = (r) =>
  JSON.stringify([r.productId, r.stationId, r.kind, r.unexpandedCombo ?? null]);

/**
 * Expand the minimal setup into the full provisioning input. Every product id of the head catalog
 * publication (components and modifier-linked products are products of the same payload) goes to
 * the named prep station as `prep`; combos/sets without expanded components go there whole. The
 * names come only from the input. The version stays when the active routes are identical.
 */
export async function expandSetup(c, setup) {
  guard(setup && typeof setup === 'object' && !Array.isArray(setup), 'Setup object required');
  const keys = Object.keys(setup).sort().join(',');
  if (keys === SETUP_FULL) return { setup, routeAll: false };
  guard(
    keys === SETUP_MINIMAL,
    'Setup must be {branchId,stations,routing} or {branchId,stations,routeAllProductsTo}',
  );
  guard(UUID.test(setup.branchId ?? ''), 'Invalid branch');
  const stations = Array.isArray(setup.stations) ? setup.stations : [];
  const assembly = stations.filter((s) => s?.kind === 'assembly');
  guard(
    assembly.length === 1 &&
      stations.some((s) => s?.kind === 'prep' && s.id === setup.routeAllProductsTo),
    'Minimal setup needs one assembly station and routeAllProductsTo naming a listed prep station',
  );
  const heads = (
    await c.query(
      `SELECT p.version,p.payload FROM catalog_branch_heads h JOIN catalog_publications p
       ON p.branch_id=h.branch_id AND p.organization_id=h.organization_id AND p.version=h.published_version
       WHERE h.branch_id=$1`,
      [setup.branchId],
    )
  ).rows;
  guard(heads.length === 1, 'Exactly one head catalog publication required for the branch');
  const products = heads[0].payload?.products;
  guard(Array.isArray(products) && products.length > 0, 'Head catalog has no products');
  const routes = products
    .map((p) => ({
      productId: String(p.id),
      stationId: setup.routeAllProductsTo,
      kind: 'prep',
      ...(p.kind === 'combo' || p.kind === 'set' ? { unexpandedCombo: 'whole_product' } : {}),
    }))
    .sort((a, b) => (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0));
  const active = (
    await c.query(
      `SELECT r.version,r.assembly_station_id,r.payload FROM cloud_kitchen_config k JOIN cloud_kitchen_routing r
       ON r.branch_id=k.branch_id AND r.version=k.active_routing_version WHERE k.branch_id=$1`,
      [setup.branchId],
    )
  ).rows[0];
  const same =
    active &&
    active.assembly_station_id === assembly[0].id &&
    // Same order too: the stored payload hash covers the exact route array.
    JSON.stringify((active.payload?.routes ?? []).map(routeKey)) ===
      JSON.stringify(routes.map(routeKey));
  const version = active ? Number(active.version) + (same ? 0 : 1) : 1;
  return {
    setup: {
      branchId: setup.branchId,
      stations,
      routing: { version, assemblyStationId: assembly[0].id, routes },
    },
    routeAll: true,
    catalogVersion: Number(heads[0].version),
    unchanged: Boolean(same),
  };
}

/** Facts the release verifies before and after each enable/disable step (no secrets). */
export async function cloudKitchenStatus(c, branch) {
  guard(UUID.test(branch), 'Invalid branch');
  const one = async (sql) => (await c.query(sql, [branch])).rows[0];
  const mode = await one(
    'SELECT cloud_channels_owner AS owner,epoch FROM branch_channel_modes WHERE branch_id=$1',
  );
  const stations = (
    await c.query(
      'SELECT id,kind,name FROM cloud_kitchen_stations WHERE branch_id=$1 ORDER BY kind,id',
      [branch],
    )
  ).rows;
  const config = await one(
    'SELECT active_routing_version AS version FROM cloud_kitchen_config WHERE branch_id=$1',
  );
  const screens = (
    await c.query(
      'SELECT id,role FROM cloud_kitchen_screens WHERE branch_id=$1 AND revoked_at IS NULL ORDER BY role,id',
      [branch],
    )
  ).rows;
  const active = await one(
    "SELECT count(*)::int AS n FROM cloud_kitchen_orders WHERE branch_id=$1 AND state NOT IN ('handed_over','cancelled')",
  );
  return {
    branch,
    mode: mode?.owner ?? 'edge',
    epoch: Number(mode?.epoch ?? 0),
    routingVersion: config?.version ?? null,
    prepStations: stations.filter((s) => s.kind === 'prep').map((s) => s.id),
    assemblyStations: stations.filter((s) => s.kind === 'assembly').map((s) => s.id),
    stationNames: Object.fromEntries(stations.map((s) => [s.id, s.name])),
    activeScreens: screens.map((s) => ({ id: s.id, role: s.role })),
    activeCloudOrders: active.n,
  };
}

export async function setMode(c, { branch, owner, operator, reason }) {
  guard(UUID.test(branch) && ['edge', 'cloud'].includes(owner), 'Invalid mode request');
  guard(/^[A-Za-z0-9._-]{1,60}$/.test(operator ?? ''), 'Operator required');
  guard(typeof reason === 'string' && reason.trim().length >= 3, 'Reason required');
  const before = await cloudKitchenStatus(c, branch);
  if (owner === 'cloud')
    guard(
      before.routingVersion !== null &&
        before.prepStations.length > 0 &&
        before.assemblyStations.length > 0,
      'Cloud mode requires provisioned stations and routing',
    );
  const row = (
    await c.query('SELECT * FROM cloud_kitchen_set_mode($1,$2,$3,$4)', [
      branch,
      owner,
      'owner:' + operator,
      reason.trim(),
    ])
  ).rows[0];
  const after = await cloudKitchenStatus(c, branch);
  guard(
    row.cloud_channels_owner === owner && after.mode === owner && after.epoch === before.epoch + 1,
    'Mode change not recorded',
  );
  const journal = (
    await c.query(
      'SELECT cloud_channels_owner AS owner,changed_by FROM branch_channel_mode_changes WHERE branch_id=$1 AND epoch=$2',
      [branch, after.epoch],
    )
  ).rows[0];
  guard(
    journal?.owner === owner && journal.changed_by === 'owner:' + operator,
    'Mode journal missing',
  );
  return { before: before.mode, after: after.mode, epoch: after.epoch, audited: true };
}

function options(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i]?.startsWith('--') ? argv[i].slice(2) : null;
    guard(
      name && ['branch', 'owner', 'operator', 'reason'].includes(name) && !(name in values),
      'Invalid arguments',
    );
    guard(argv[i + 1] !== undefined, 'Invalid arguments');
    values[name] = argv[i + 1];
  }
  return values;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main(argv) {
  const [command, ...rest] = argv;
  guard(
    ['inspect', 'deploy', 'status', 'stations', 'stations-preview', 'mode'].includes(command),
    'Usage: cloud-kitchen-release-owner.mjs inspect|deploy|status|stations|stations-preview|mode',
  );
  const url = new URL(process.env.CLOUD_DATABASE_URL ?? '');
  guard(
    url.username === 'pickchick_owner' && url.pathname === '/pickchick_cloud',
    'Owner database required',
  );
  const args = options(rest);
  const setup = command.startsWith('stations') ? JSON.parse(await readStdin()) : null;
  const { createPool } = await import('@pickchick/database');
  const pool = createPool(url.href),
    c = await pool.connect();
  const readOnly = ['inspect', 'status', 'stations-preview'].includes(command);
  try {
    await c.query(
      readOnly
        ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'
        : 'BEGIN ISOLATION LEVEL SERIALIZABLE',
    );
    let result;
    if (command === 'inspect' || command === 'deploy')
      result = await deployCloudKitchen(c, {
        directory: fileURLToPath(new URL('../../db/cloud/migrations/', import.meta.url)),
        role: 'pickchick_app',
        inspect: command === 'inspect',
      });
    else if (command === 'status') result = await cloudKitchenStatus(c, args.branch);
    else if (command === 'mode') result = await setMode(c, args);
    else {
      guard(setup?.branchId === args.branch, 'Setup branch differs');
      const expanded = await expandSetup(c, setup);
      const summary = {
        routeAll: expanded.routeAll,
        routingVersion: expanded.setup.routing.version,
        routes: expanded.setup.routing.routes.length,
        assemblyStationId: expanded.setup.routing.assemblyStationId,
        catalogVersion: expanded.catalogVersion ?? null,
        unchanged: expanded.unchanged ?? null,
      };
      if (command === 'stations-preview') result = summary;
      else {
        const { provisionCloudKitchenInTransaction } = await import('@pickchick/cloud-kitchen');
        await provisionCloudKitchenInTransaction(c, expanded.setup);
        result = { ...(await cloudKitchenStatus(c, args.branch)), provisioned: summary };
      }
    }
    await c.query(readOnly ? 'ROLLBACK' : 'COMMIT');
    console.log(JSON.stringify(result));
  } catch (error) {
    await c.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    c.release();
    await pool.end();
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  main(process.argv.slice(2)).catch((error) => {
    console.error(
      error instanceof OwnerGuardError
        ? error.message
        : `Cloud kitchen owner failed (${error?.code ?? 'error'})`,
    );
    process.exitCode = 1;
  });
