// Shared by the KDS lane database tests (tests/integration/kds-*.test.mjs): an isolated schema
// migrated from an explicit list of edge migrations, on a local development database only.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool, migrate, transaction } from '@pickchick/database';
import {
  OrderError,
  audit,
  cancelLocalOrder,
  createLocalOrder,
  createQuote,
} from '@pickchick/local-orders';
import {
  FulfillmentError,
  RoutingSchema,
  buildKitchenPlan,
  digest,
  kdsStationId,
  localUnpaidExecution,
  provisionFulfillment,
  provisionKdsStations,
} from '../dist/index.js';
import { allocateDisplayNumber, emit } from '../dist/records.js';
import { EdgeEventSchema } from '../../fulfillment-transport/dist/model.js';
import { parseKitchenEvent } from '../../pos-order-sync/dist/kitchen-model.js';

export const repoMigrations = fileURLToPath(
  new URL('../../../db/edge/migrations/', import.meta.url),
);
export const KDS_MIGRATION = '027_edge_kds_foundation.sql';

export function edgeTestUrl(env = process.env) {
  const value =
    env.EDGE_FULFILLMENT_TEST_DATABASE_URL ??
    env.EDGE_DATABASE_URL ??
    'postgresql://pickchick_local:pickchick_local_only@127.0.0.1:55433/pickchick_edge';
  const url = new URL(value);
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Local PostgreSQL only');
  assert.match(url.pathname, /^\/pickchick_(edge|test)(_[a-z0-9]+)?$/, 'Development database only');
  assert.equal(url.search, '', 'Connection overrides may not select another host/schema');
  return value;
}

export async function edgeMigrationNames() {
  return (await readdir(repoMigrations)).filter((n) => /^\d{3}_[a-z_]+\.sql$/.test(n)).sort();
}

/**
 * Synthetic stand-in for the pos lane's 026 while this branch does not carry it: same file
 * name, additive DDL on objects the real 026 also extends (contracts section 3.3). The tests
 * use the real file instead as soon as the repository has one.
 */
export const POS_026_STANDIN = `-- Test-only stand-in for 026_edge_pos_sales.sql (lane pos).
ALTER TABLE local_cash_shifts ADD COLUMN sales_mode boolean NOT NULL DEFAULT false;
CREATE TABLE pos_payment_methods (
  branch_id uuid NOT NULL REFERENCES branch_config(id),
  code text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  PRIMARY KEY (branch_id, code)
);
`;

/** Writes a migration directory: repo files below `below` (e.g. '026'), optional 026, optional 027. */
export async function migrationDirectory(dir, { below, with026 = false, with027 = false }) {
  const names = await edgeMigrationNames();
  for (const name of names.filter((n) => n < below))
    await copyFile(join(repoMigrations, name), join(dir, name));
  const real026 = names.find((n) => n.startsWith('026_'));
  if (with026) {
    if (real026) await copyFile(join(repoMigrations, real026), join(dir, real026));
    else await writeFile(join(dir, '026_edge_pos_sales.sql'), POS_026_STANDIN);
  }
  if (with027) await copyFile(join(repoMigrations, KDS_MIGRATION), join(dir, KDS_MIGRATION));
  return { real026: Boolean(real026) };
}

/** Runs `run` with a pool on a fresh, empty schema; migrateWith() applies a migration set. */
export async function withEdgeSchema(run) {
  const connection = edgeTestUrl();
  const schema = 'kds_' + randomUUID().replaceAll('-', '');
  const admin = createPool(connection, 2);
  const root = await mkdtemp(join(tmpdir(), 'pickchick-kds-'));
  let pool;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(connection);
    url.searchParams.set('options', `-c search_path=${schema}`);
    pool = createPool(url.toString(), 4);
    let step = 0;
    const migrateWith = async (options) => {
      const dir = join(root, String(step++));
      await mkdir(dir);
      const info = await migrationDirectory(dir, options);
      return { applied: await migrate(pool, dir, 'edge'), ...info };
    };
    await run({ pool, admin, schema, url, migrateWith });
  } finally {
    await pool?.end();
    const cleanup = await admin.connect();
    try {
      await cleanup.query('SET statement_timeout = 0');
      await cleanup.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally {
      cleanup.release();
    }
    await admin.end();
    await rm(root, { recursive: true, force: true });
  }
}

/** Minimal synthetic edge: branch, fulfillment with the two old stations, staff and terminals. */
export async function seedEdge(pool, { provisionFulfillment, kitchenLogin = true } = {}) {
  const scope = {
    organizationId: randomUUID(),
    branchId: randomUUID(),
    deviceId: randomUUID(),
    producerId: randomUUID(),
  };
  await pool.query(
    "INSERT INTO branch_config(id,code,name,timezone) VALUES($1,'KDS-TEST','Synthetic KDS edge','Asia/Almaty')",
    [scope.branchId],
  );
  const prep = randomUUID(),
    assembly = randomUUID();
  await provisionFulfillment(pool, {
    ...scope,
    stations: [
      { id: prep, kind: 'prep', name: 'Приготовление' },
      { id: assembly, kind: 'assembly', name: 'Сборка и выдача' },
    ],
    routing: {
      version: 1,
      assemblyStationId: assembly,
      routes: [{ productId: 'synthetic-burger', stationId: prep, kind: 'prep' }],
    },
  });
  const kitchen = randomUUID();
  await pool.query(
    "INSERT INTO local_staff(id,branch_id,name,role,access_expires_at) VALUES($1,$2,'Synthetic kitchen','kitchen',clock_timestamp()+interval '8 hours')",
    [kitchen, scope.branchId],
  );
  if (kitchenLogin)
    await pool.query(
      "INSERT INTO local_staff_passwords(staff_id,branch_id,login,salt,verifier) VALUES($1,$2,'kitchen',$3,$4)",
      [kitchen, scope.branchId, 'a'.repeat(64), 'b'.repeat(64)],
    );
  await pool.query(
    'INSERT INTO fulfillment_station_grants(branch_id,staff_id,station_id) VALUES($1,$2,$3),($1,$2,$4)',
    [scope.branchId, kitchen, prep, assembly],
  );
  return { scope, prep, assembly, kitchen };
}

/** Rows (as JSON) and table ACLs of every table, to prove an upgrade changed nothing. */
export async function tableFingerprint(client, schema) {
  const tables = (
    await client.query('SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename', [
      schema,
    ])
  ).rows.map((row) => row.tablename);
  const result = {};
  for (const table of tables)
    result[table] = (
      await client.query(
        `SELECT count(*)::int AS count, md5(COALESCE(string_agg(h,'' ORDER BY h),'')) AS hash
         FROM (SELECT md5(to_jsonb(t)::text) h FROM "${schema}"."${table}" t) r`,
      )
    ).rows[0];
  result.acl = (
    await client.query(
      "SELECT relname, relacl::text FROM pg_class WHERE relnamespace=$1::regnamespace AND relkind IN ('r','S') ORDER BY relname",
      [schema],
    )
  ).rows;
  return result;
}

// ---------------------------------------------------------------------------------------------
// KDS-2 helpers on the full fixture (fixture.mjs): layout rows, a cashier desk and strict events.

/** Layout of the fixture products: fries breaded, burgers at 5, drinks and cola only at issue. */
export function kdsTestLayout(branchId, { version = 1, terminals = {} } = {}) {
  const station = (fn, product_ids, counts) => ({
    edge_station_id: kdsStationId(branchId, fn),
    function: fn,
    terminal_ids: terminals[fn] ?? [],
    product_ids,
    ...(counts ? { counts } : {}),
  });
  const tables = ['burger', 'fries', 'pick-combo'];
  return {
    schema_version: 1,
    branch_id: branchId,
    version,
    stations: [
      station(
        'breading',
        ['fries', 'pick-combo'],
        [
          { product_id: 'fries', unit: 'finger', count: 2 },
          { product_id: 'pick-combo', unit: 'finger', count: 3 },
        ],
      ),
      station(
        'toasts',
        ['burger', 'pick-combo'],
        [{ product_id: 'burger', unit: 'burger', count: 1 }],
      ),
      station('assembly_hall', tables),
      station('assembly_delivery', tables),
      station('issue', ['drink', 'cola']),
      station('delivery_handover', []),
    ],
  };
}

async function nextSettingsVersion(client, branchId, field, value) {
  const { version } = (
    await client.query('SELECT version FROM kds_settings WHERE branch_id=$1 FOR UPDATE', [branchId])
  ).rows[0];
  await client.query(
    `INSERT INTO kds_setting_changes(command_id,branch_id,version,field,value,actor,reason,request_hash)
     VALUES(gen_random_uuid(),$1,$2,$3,$4,'operator','Synthetic KDS test',$5)`,
    [branchId, version + 1, field, value, 'd'.repeat(64)],
  );
  return version + 1;
}
/** Same rows as kds-switch layout-apply (+ enable): provisioned stations, layout, audited switch. */
export async function writeKdsLayout(pool, branchId, layout, { enable = true } = {}) {
  await transaction(pool, async (client) => {
    await provisionKdsStations(client, branchId);
    await client.query(
      "INSERT INTO kds_layouts(branch_id,version,layout,checksum,source,reason) VALUES($1,$2,$3,$4,'operator','Synthetic KDS test')",
      [branchId, layout.version, layout, digest(layout)],
    );
    const version = await nextSettingsVersion(
      client,
      branchId,
      'active_layout_version',
      String(layout.version),
    );
    await client.query(
      'UPDATE kds_settings SET version=$2,active_layout_version=$3 WHERE branch_id=$1',
      [branchId, version, layout.version],
    );
  });
  if (enable) await switchKdsLayout(pool, branchId, true);
}
export function switchKdsLayout(pool, branchId, enabled) {
  return transaction(pool, async (client) => {
    const version = await nextSettingsVersion(client, branchId, 'layout_enabled', String(enabled));
    await client.query('UPDATE kds_settings SET version=$2,layout_enabled=$3 WHERE branch_id=$1', [
      branchId,
      version,
      enabled,
    ]);
  });
}

/**
 * The cashier admission after the pos lane switches local-pos.ts to the seam (contracts 5.2):
 * the D0 localUnpaidExecution().admit with buildKitchenPlan in place of taskPlan, plus
 * snapshot.delivery for an aggregator sale. A test stub only; local-pos.ts is the pos lane's.
 */
export function seamCashierPort(f, { delivery } = {}) {
  const real = localUnpaidExecution({ enabled: true, deviceId: f.scope.deviceId });
  return {
    async admit(client, order, actor, commandId) {
      const config = (
        await client.query(
          `SELECT f.* FROM fulfillment_config f JOIN branch_config b ON b.id=f.branch_id
           WHERE f.branch_id=$1 AND f.device_id=$2 AND b.ordering_enabled
             AND b.pos_service_mode='unpaid_service' FOR SHARE OF f`,
          [order.branchId, f.scope.deviceId],
        )
      ).rows[0];
      if (!config) throw new OrderError('KITCHEN_UNAVAILABLE');
      const stored = (
        await client.query(
          'SELECT payload FROM fulfillment_routing WHERE branch_id=$1 AND version=$2',
          [order.branchId, config.active_routing_version],
        )
      ).rows[0];
      const snapshot = {
        organizationId: config.organization_id,
        branchId: order.branchId,
        channel: 'pos',
        serviceMode: order.quote.service_mode,
        currency: 'KZT',
        totalMinor: order.quote.total_minor,
        ...(delivery ? { delivery } : {}),
        lines: order.quote.lines.map((line) => ({
          lineId: randomUUID(),
          productId: line.product_id,
          title: line.name.ru,
          description: '',
          quantity: line.quantity,
          selectedDetails: {
            kind: 'item',
            components: [],
            modifiers: (line.modifiers ?? []).map((modifier) => ({
              groupId: modifier.group_id,
              groupTitle: modifier.group_name,
              optionId: modifier.option_id,
              label: modifier.name,
              quantity: modifier.quantity ?? 1,
              linkedProductId: null,
            })),
          },
        })),
      };
      let routing, kitchen;
      try {
        routing = RoutingSchema.parse(stored.payload);
        kitchen = await buildKitchenPlan(client, { branchId: order.branchId, snapshot, routing });
      } catch (error) {
        if (error instanceof FulfillmentError) throw new OrderError('KITCHEN_UNAVAILABLE');
        throw error;
      }
      const quoteHash = digest(order.quote);
      const number = await allocateDisplayNumber(client, order.branchId);
      const row = (
        await client.query(
          `INSERT INTO fulfillment_reservations(order_id,branch_id,reservation_id,quote_id,
          quote_hash,owner_hash,commercial_owner,fulfillment_owner,device_id,snapshot,
          routing_version,task_plan,assembly_station_id,state,display_number,business_day,
          authorized_event_id,admission_kind,local_order_id,authorized_by_staff_id)
         VALUES($1,$2,$3,$4,$5,$6,'edge_pos','edge',$7,$8,$9,$10,$11,'accepted',
           $14::bigint,(clock_timestamp() AT TIME ZONE 'Asia/Almaty')::date,
           $12,'unpaid_service',$1,$13) RETURNING *`,
          [
            order.orderId,
            order.branchId,
            randomUUID(),
            order.quote.quote_id,
            quoteHash,
            digest({
              organizationId: config.organization_id,
              branchId: order.branchId,
              deviceId: f.scope.deviceId,
              owner: 'edge_pos',
              orderId: order.orderId,
              quoteId: order.quote.quote_id,
              quoteDigest: quoteHash,
            }),
            f.scope.deviceId,
            snapshot,
            routing.version,
            JSON.stringify(kitchen.plan),
            kitchen.assemblyStationId,
            commandId,
            actor.staff_id,
            number,
          ],
        )
      ).rows[0];
      await client.query(
        `INSERT INTO fulfillment_tasks(id,branch_id,order_id,component_key,station_id,routing_version,kind,details)
         SELECT gen_random_uuid(),$1,$2,p->>'componentKey',(p->>'stationId')::uuid,$3,p->>'kind',p->'details'
         FROM jsonb_array_elements($4::jsonb) p`,
        [order.branchId, order.orderId, routing.version, JSON.stringify(kitchen.plan)],
      );
      await emit(client, row, 'edge.fulfillment_accepted', { staffId: actor.staff_id });
      await audit(
        client,
        order.branchId,
        actor.staff_id,
        'fulfillment.local_unpaid_admitted',
        order.orderId,
      );
    },
    cancel: real.cancel,
  };
}

/**
 * Cashier desk on the fixture: a synthetic menu with slugs (a combo whose drink option links
 * cola), routing v2 with the hashed cashier ids, an open shift and unpaid service.
 */
export async function cashierDesk(f) {
  const text = (ru) => ({ ru, kk: ru });
  const ids = () => ({ product: randomUUID(), variant: randomUUID() });
  const combo = ids(),
    cola = ids(),
    burger = ids(),
    group = randomUUID(),
    colaOption = randomUUID(),
    category = randomUUID();
  const item = (id, name, source_id, extra = {}) => ({
    product_id: id.product,
    variant_id: id.variant,
    category_id: category,
    name: text(name),
    price_minor: '150000',
    currency: 'KZT',
    source_id,
    ...extra,
  });
  const menu = {
    schema_version: 1,
    release_id: randomUUID(),
    branch_id: f.scope.branchId,
    version: 1,
    published_at: '2026-11-10T00:00:00.000Z',
    items: [
      item(combo, 'Pick Combo', 'pick-combo', {
        modifier_groups: [
          {
            id: group,
            name: text('Напиток'),
            min_selected: 1,
            max_selected: 1,
            options: [
              {
                id: colaOption,
                name: text('Кола'),
                price_minor: '0',
                linked_variant_id: cola.variant,
              },
            ],
          },
        ],
      }),
      item(cola, 'Кола 0,5', 'cola'),
      item(burger, 'Pick Burger', 'burger'),
    ],
  };
  await f.pool.query(
    'INSERT INTO menu_snapshots(id,branch_id,version,schema_version,payload,checksum,published_at) VALUES($1,$2,1,1,$3,$4,$5)',
    [menu.release_id, f.scope.branchId, menu, 'f'.repeat(64), menu.published_at],
  );
  await f.pool.query('INSERT INTO active_menu(branch_id,release_id) VALUES($1,$2)', [
    f.scope.branchId,
    menu.release_id,
  ]);
  await provisionFulfillment(f.pool, {
    ...f.setup,
    routing: {
      ...f.setup.routing,
      version: 2,
      routes: [
        ...f.setup.routing.routes,
        { productId: combo.product, stationId: f.prep, kind: 'prep' },
        { productId: burger.product, stationId: f.prep, kind: 'prep' },
        { productId: cola.product, stationId: f.assembly, kind: 'assembly_item' },
      ],
    },
  });
  await f.pool.query("UPDATE branch_config SET pos_service_mode='unpaid_service' WHERE id=$1", [
    f.scope.branchId,
  ]);
  await f.pool.query(
    'INSERT INTO local_cash_shifts(id,branch_id,terminal_id,staff_id,opening_cash_minor) VALUES($1,$2,$3,$4,0)',
    [randomUUID(), f.scope.branchId, f.cashier.terminal_id, f.cashier.staff_id],
  );
  const order = async ({ comboQuantity = 2, burgers = 1, delivery, serviceMode } = {}) => {
    const quote = await createQuote(f.pool, f.scope.branchId, f.cashier.auth, {
      release_id: menu.release_id,
      service_mode: serviceMode ?? (delivery ? 'takeaway' : 'dine_in'),
      items: [
        ...(comboQuantity
          ? [
              {
                variant_id: combo.variant,
                quantity: comboQuantity,
                modifiers: [{ group_id: group, option_id: colaOption }],
              },
            ]
          : []),
        ...(burgers ? [{ variant_id: burger.variant, quantity: burgers }] : []),
      ],
    });
    return createLocalOrder(
      f.pool,
      f.scope.branchId,
      f.cashier.auth,
      randomUUID(),
      { quote_id: quote.quote_id, kitchen_admission: 'unpaid' },
      seamCashierPort(f, { delivery }),
    );
  };
  const cancel = (local, reason = 'Гость передумал') =>
    cancelLocalOrder(
      f.pool,
      f.scope.branchId,
      f.cashier.auth,
      randomUUID(),
      local.order_id,
      { expected_version: local.version, reason },
      seamCashierPort(f),
    );
  return { menu, combo, cola, burger, colaOption, order, cancel };
}

/** Each outbox row must pass the strict POS kitchen stream or the strict cloud transport. */
export async function assertStrictEvents(pool) {
  const rows = (await pool.query('SELECT * FROM fulfillment_outbox ORDER BY sequence')).rows;
  let pos = 0,
    cloud = 0;
  for (const row of rows) {
    if (row.payload.commercialOwner === 'edge_pos') {
      parseKitchenEvent({
        event_id: row.event_id,
        producer_id: '00000000-0000-4000-8000-000000000001',
        producer_sequence: String(row.sequence),
        aggregate_type: row.aggregate_type,
        aggregate_id: row.order_id,
        aggregate_version: Number(row.aggregate_version),
        event_type: row.event_type,
        schema_version: 1,
        branch_id: row.branch_id,
        occurred_at: row.occurred_at.toISOString(),
        correlation_id: row.order_id,
        causation_id: null,
        payload: row.payload,
      });
      pos++;
    } else {
      EdgeEventSchema.parse({
        schemaVersion: 1,
        eventId: row.event_id,
        sequence: String(row.sequence),
        orderId: row.order_id,
        aggregateVersion: row.aggregate_version,
        type: row.event_type,
        payload: row.payload,
      });
      cloud++;
    }
  }
  return { pos, cloud };
}
