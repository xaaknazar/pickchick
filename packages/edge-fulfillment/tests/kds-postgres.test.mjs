// Cutover lane kds on PostgreSQL (full repository chain incl. 027). KDS-3: station provisioning,
// the 027 guards and the runtime grants of infra/windows/kds-grants.mjs. KDS-2: the kitchen plan
// of both admission paths, the table cascade, finishing stations and the KDS read views.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createPool, transaction } from '@pickchick/database';
import { fulfillmentWorkerGrants } from '../../../infra/windows/fulfillment-worker-grants.mjs';
import {
  MIGRATION,
  RUNTIME_PRIVILEGES,
  WORKER_PRIVILEGES,
  assertKdsRuntimePrivileges,
  assertKdsWorkerPrivileges,
  kdsRuntimeGrantSql,
  kdsTableGrantees,
  kdsWorkerGrantSql,
} from '../../../infra/windows/kds-grants.mjs';
import { FulfillmentLayoutSchema, KdsBreadingSchema } from '@pickchick/contracts';
import {
  EdgeFulfillment,
  KDS_STATIONS,
  RoutingSchema,
  buildKitchenPlan,
  grantStation,
  kdsStationId,
  provisionKdsStations,
  taskPlan,
} from '../dist/index.js';
import { errorCode, fixture } from './fixture.mjs';
import {
  assertStrictEvents,
  cashierDesk,
  kdsTestLayout,
  switchKdsLayout,
  tableFingerprint,
  writeKdsLayout,
} from './kds-fixture.mjs';

const provision = (pool, branchId) =>
  transaction(pool, (client) => provisionKdsStations(client, branchId));
const enrollKitchenLogin = (f, staff = f.cook) =>
  f.pool.query(
    "INSERT INTO local_staff_passwords(staff_id,branch_id,login,salt,verifier) VALUES($1,$2,'kitchen',$3,$4)",
    [staff.staff_id, f.scope.branchId, 'a'.repeat(64), 'b'.repeat(64)],
  );
const rows = async (pool, sql, params = []) => (await pool.query(sql, params)).rows;
const kdsState = async (f) => {
  const fingerprint = await tableFingerprint(f.pool, f.schema);
  return {
    fulfillment_stations: fingerprint.fulfillment_stations,
    fulfillment_station_grants: fingerprint.fulfillment_station_grants,
    fulfillment_routing: fingerprint.fulfillment_routing,
    fulfillment_config: fingerprint.fulfillment_config,
    kds_settings: fingerprint.kds_settings,
    kds_setting_changes: fingerprint.kds_setting_changes,
  };
};

test('provisionKdsStations creates the six stations, grants the kitchen login and is idempotent', () =>
  fixture(async (f) => {
    await enrollKitchenLogin(f);
    const before = await rows(f.pool, 'SELECT * FROM fulfillment_stations ORDER BY id');
    const grantsBefore = await rows(
      f.pool,
      'SELECT * FROM fulfillment_station_grants ORDER BY staff_id,station_id',
    );
    const first = await provision(f.pool, f.scope.branchId);
    assert.deepEqual(
      first.stations,
      KDS_STATIONS.map((spec) => ({
        id: kdsStationId(f.scope.branchId, spec.function),
        function: spec.function,
        kind: spec.kind,
        name: spec.name,
      })),
    );
    assert.deepEqual(
      [first.stationsAdded, first.kitchenStaffId, first.grantsAdded, first.settingsCreated],
      [6, f.cook.staff_id, 6, true],
    );
    const settings = (await rows(f.pool, 'SELECT * FROM kds_settings'))[0];
    assert.deepEqual(
      [
        settings.branch_id,
        settings.layout_enabled,
        settings.active_layout_version,
        settings.shift_mode,
        settings.version,
      ],
      [f.scope.branchId, false, null, 'normal', 1],
    );
    const changes = await rows(f.pool, 'SELECT * FROM kds_setting_changes');
    assert.equal(changes.length, 1);
    assert.deepEqual(
      [
        changes[0].version,
        changes[0].field,
        changes[0].value,
        changes[0].actor,
        changes[0].staff_id,
      ],
      [1, 'provisioned', null, 'operator', null],
    );
    // Old stations and their grants stay exactly as they were (rollback path).
    const after = await rows(f.pool, 'SELECT * FROM fulfillment_stations ORDER BY id');
    for (const station of before)
      assert.deepEqual(
        after.find((s) => s.id === station.id),
        station,
      );
    assert.equal(after.length, before.length + 6);
    const grantsAfter = await rows(
      f.pool,
      'SELECT * FROM fulfillment_station_grants ORDER BY staff_id,station_id',
    );
    for (const grant of grantsBefore)
      assert.ok(grantsAfter.some((g) => JSON.stringify(g) === JSON.stringify(grant)));
    assert.equal(grantsAfter.length, grantsBefore.length + 6);

    const state = await kdsState(f);
    const again = await provision(f.pool, f.scope.branchId);
    assert.deepEqual(
      [again.stationsAdded, again.grantsAdded, again.settingsCreated, again.kitchenStaffId],
      [0, 0, false, f.cook.staff_id],
    );
    assert.deepEqual(again.stations, first.stations);
    assert.deepEqual(await kdsState(f), state);

    // Today's kitchen flow is untouched: a new order still uses the old routing and stations.
    const { order } = await f.accepted(true);
    const read = await f.read(order.orderId);
    assert.deepEqual(
      [...new Set(read.tasks.map((t) => t.station_id))].sort(),
      [f.prep, f.assembly].sort(),
    );
    assert.equal(read.assemblyStationId, f.assembly);
  }));

test('provisioning without a kitchen login adds no grants; a later run completes them', () =>
  fixture(async (f) => {
    const first = await provision(f.pool, f.scope.branchId);
    assert.deepEqual([first.kitchenStaffId, first.grantsAdded], [null, 0]);
    // An inactive kitchen identity never receives station rights.
    await enrollKitchenLogin(f);
    await f.pool.query('UPDATE local_staff SET active=false WHERE id=$1', [f.cook.staff_id]);
    assert.equal((await provision(f.pool, f.scope.branchId)).grantsAdded, 0);
    await f.pool.query('UPDATE local_staff SET active=true WHERE id=$1', [f.cook.staff_id]);
    const later = await provision(f.pool, f.scope.branchId);
    assert.deepEqual(
      [later.kitchenStaffId, later.grantsAdded, later.stationsAdded, later.settingsCreated],
      [f.cook.staff_id, 6, 0, false],
    );
    // A cashier login named kitchen is not the kitchen identity.
    assert.equal(
      (
        await rows(
          f.pool,
          'SELECT count(*)::int AS n FROM fulfillment_station_grants WHERE staff_id=$1',
          [f.cashier.staff_id],
        )
      )[0].n,
      0,
    );
  }));

test('a conflicting station or a wrong branch refuses the whole provisioning', () =>
  fixture(async (f) => {
    await enrollKitchenLogin(f);
    await assert.rejects(provision(f.pool, 'not-a-branch'), errorCode('INVALID'));
    await assert.rejects(provision(f.pool, randomUUID()), errorCode('NOT_READY'));
    await f.pool.query(
      'INSERT INTO fulfillment_stations(branch_id,id,kind,name) VALUES($1,$2,$3,$4)',
      [f.scope.branchId, kdsStationId(f.scope.branchId, 'issue'), 'assembly', 'Выдача'],
    );
    const state = await kdsState(f);
    await assert.rejects(provision(f.pool, f.scope.branchId), errorCode('CONFLICT'));
    assert.deepEqual(await kdsState(f), state);
  }));

test('027 guards: immutable layouts, append-only journals, audited settings versions', () =>
  fixture(async (f) => {
    await provision(f.pool, f.scope.branchId);
    const q = (sql, params) => f.pool.query(sql, params);
    const fails = (sql, params, code) =>
      assert.rejects(q(sql, params), (error) => error.code === code, sql);
    const b = f.scope.branchId;
    await fails('DELETE FROM kds_settings', [], '23514');
    await fails('UPDATE kds_settings SET shift_mode=$1', ['peak'], '23514');
    // The next version without its audit row fails at commit (deferred foreign key).
    await fails('UPDATE kds_settings SET version=2', [], '23503');
    await fails('UPDATE kds_settings SET version=2, layout_enabled=true', [], '23514');
    await fails('UPDATE kds_settings SET version=2, active_layout_version=7', [], '23503');
    const layout = { schema_version: 1, branch_id: b, version: 1, stations: [] };
    for (const [bad, code] of [
      [{ ...layout, branch_id: randomUUID() }, '23514'],
      [{ ...layout, version: 2 }, '23514'],
      [{ ...layout, schema_version: 2 }, '23514'],
    ])
      await fails(
        "INSERT INTO kds_layouts(branch_id,version,layout,checksum,source,reason) VALUES($1,1,$2,$3,'operator','Synthetic')",
        [b, bad, 'c'.repeat(64)],
        code,
      );
    await fails(
      "INSERT INTO kds_layouts(branch_id,version,layout,checksum,source,reason) VALUES($1,1,$2,$3,'cabinet','Synthetic')",
      [b, layout, 'c'.repeat(64)],
      '23514',
    );
    await q(
      "INSERT INTO kds_layouts(branch_id,version,layout,checksum,source,reason) VALUES($1,1,$2,$3,'operator','Synthetic')",
      [b, layout, 'c'.repeat(64)],
    );
    await fails("UPDATE kds_layouts SET reason='Changed'", [], '23514');
    await fails('DELETE FROM kds_layouts', [], '23514');
    await transaction(f.pool, async (client) => {
      await client.query(
        `INSERT INTO kds_setting_changes(command_id,branch_id,version,field,value,actor,reason,request_hash)
         VALUES(gen_random_uuid(),$1,2,'active_layout_version','1','operator','Synthetic',$2)`,
        [b, 'd'.repeat(64)],
      );
      await client.query(
        'UPDATE kds_settings SET version=2, active_layout_version=1, layout_enabled=true',
      );
    });
    await fails('UPDATE kds_settings SET version=4', [], '23514');
    await fails(
      `INSERT INTO kds_setting_changes(command_id,branch_id,version,field,value,actor,reason,request_hash)
       VALUES(gen_random_uuid(),$1,3,'shift_mode','peak','shift_manager','Synthetic',$2)`,
      [b, 'd'.repeat(64)],
      '23514',
    );
    await fails(
      `INSERT INTO kds_setting_changes(command_id,branch_id,version,field,value,actor,reason,request_hash)
       VALUES(gen_random_uuid(),$1,3,'layout_enabled','false','operator','no',$2)`,
      [b, 'd'.repeat(64)],
      '23514',
    );
    // Journals: one-time reported_at only.
    await q('UPDATE kds_setting_changes SET reported_at=clock_timestamp() WHERE version=1');
    await fails(
      'UPDATE kds_setting_changes SET reported_at=clock_timestamp() WHERE version=1',
      [],
      '23514',
    );
    await fails("UPDATE kds_setting_changes SET reason='Rewritten' WHERE version=2", [], '23514');
    await fails('DELETE FROM kds_setting_changes WHERE version=2', [], '23514');

    const issue = kdsStationId(b, 'issue');
    const incident = (extra = {}) => ({
      provider: 'glovo',
      claimed: 'G-123',
      kind: 'number_mismatch',
      description: 'Номер у курьера другой',
      order: null,
      ...extra,
    });
    const insertIncident = (i) =>
      q(
        `INSERT INTO courier_incidents(incident_id,branch_id,order_id,provider,claimed_number,kind,description,station_id,staff_id,terminal_id,request_hash)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          randomUUID(),
          b,
          i.order,
          i.provider,
          i.claimed,
          i.kind,
          i.description,
          issue,
          f.packer.staff_id,
          f.packer.terminal_id,
          'e'.repeat(64),
        ],
      );
    await insertIncident(incident());
    await insertIncident(incident({ provider: 'other', claimed: null, kind: 'courier_refused' }));
    for (const bad of [
      { provider: 'chocofood' },
      { kind: 'late' },
      { description: 'no' },
      { claimed: '+7 700 000' },
      { order: randomUUID() },
    ])
      await assert.rejects(insertIncident(incident(bad)), /violates/, JSON.stringify(bad));
    await q('UPDATE courier_incidents SET reported_at=clock_timestamp() WHERE provider=$1', [
      'glovo',
    ]);
    await fails(
      "UPDATE courier_incidents SET description='Иначе' WHERE provider='glovo'",
      [],
      '23514',
    );
    await fails("UPDATE courier_incidents SET kind='other' WHERE provider='other'", [], '23514');
    await fails('DELETE FROM courier_incidents', [], '23514');

    const { order } = await f.accepted();
    const handover = (extra = {}) => ({
      provider: 'yandex_eda',
      number: 'YA-77',
      marks: [true, true, true],
      ...extra,
    });
    const insertHandover = (h) =>
      q(
        `INSERT INTO delivery_handovers(order_id,branch_id,command_id,provider,external_number,number_matched,courier_accepted,photo_taken,station_id,staff_id,terminal_id)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          order.orderId,
          b,
          randomUUID(),
          h.provider,
          h.number,
          ...h.marks,
          kdsStationId(b, 'delivery_handover'),
          f.packer.staff_id,
          f.packer.terminal_id,
        ],
      );
    for (const bad of [
      { marks: [false, true, true] },
      { marks: [true, false, true] },
      { marks: [true, true, false] },
      { number: 'ya-77' },
      { provider: 'other' },
    ])
      await assert.rejects(insertHandover(handover(bad)), /violates/, JSON.stringify(bad));
    await insertHandover(handover());
    await fails('UPDATE delivery_handovers SET staff_id=$1', [f.cook.staff_id], '23514');
    await q('UPDATE delivery_handovers SET reported_at=clock_timestamp()');
    await fails('UPDATE delivery_handovers SET reported_at=clock_timestamp()', [], '23514');
    await fails('DELETE FROM delivery_handovers', [], '23514');
    await assert.rejects(insertHandover(handover()), /duplicate key/);
  }));

test('kds-grants: exact runtime privileges on the 027 tables', () =>
  fixture(async (f) => {
    const role = 'kds_runtime_' + randomUUID().replaceAll('-', '').slice(0, 20);
    assert.equal(MIGRATION, '027_edge_kds_foundation.sql');
    assert.throws(() => kdsRuntimeGrantSql('Bad-Role'), /Invalid KDS grant identifier/);
    await f.admin.query(`CREATE ROLE ${role} NOLOGIN NOINHERIT`);
    try {
      const q = (sql, params) => f.pool.query(sql, params);
      await q(`GRANT USAGE ON SCHEMA ${f.schema} TO ${role}`);
      await assert.rejects(assertKdsRuntimePrivileges(f.pool, role, f.schema), /differ/);
      await q(kdsRuntimeGrantSql(role, f.schema));
      assert.deepEqual(await assertKdsRuntimePrivileges(f.pool, role, f.schema), {
        role,
        schema: f.schema,
        migration: MIGRATION,
        tables: 5,
        verified: true,
      });
      assert.deepEqual(await kdsTableGrantees(f.pool, f.schema), [role]);
      // Re-applying is harmless; any extra right is detected.
      await q(kdsRuntimeGrantSql(role, f.schema));
      await assertKdsRuntimePrivileges(f.pool, role, f.schema);
      for (const extra of [
        `GRANT UPDATE(layout_enabled) ON ${f.schema}.kds_settings TO ${role}`,
        `GRANT SELECT ON ${f.schema}.kds_setting_changes TO ${role}`,
        `GRANT INSERT ON ${f.schema}.kds_layouts TO ${role}`,
        `GRANT DELETE ON ${f.schema}.courier_incidents TO ${role}`,
        `GRANT UPDATE(reported_at) ON ${f.schema}.delivery_handovers TO ${role}`,
      ]) {
        await q(extra);
        await assert.rejects(assertKdsRuntimePrivileges(f.pool, role, f.schema), /differ/, extra);
        await q(extra.replace('GRANT', 'REVOKE').replace(' TO ', ' FROM '));
        await assertKdsRuntimePrivileges(f.pool, role, f.schema);
      }
      // What the runtime role can actually do.
      await provision(f.pool, f.scope.branchId);
      const asRuntime = (sql, params) =>
        transaction(f.pool, async (client) => {
          await client.query(`SET LOCAL ROLE ${role}`);
          return client.query(sql, params);
        });
      assert.equal(
        (await asRuntime('SELECT layout_enabled FROM kds_settings')).rows[0].layout_enabled,
        false,
      );
      assert.equal((await asRuntime('SELECT count(*)::int AS n FROM kds_layouts')).rows[0].n, 0);
      const denied = (error) => error.code === '42501';
      await assert.rejects(asRuntime('UPDATE kds_settings SET layout_enabled=true'), denied);
      await assert.rejects(asRuntime('SELECT * FROM kds_setting_changes'), denied);
      await assert.rejects(
        asRuntime(
          "INSERT INTO kds_layouts(branch_id,version,layout,checksum,source,reason) VALUES($1,1,'{}',$2,'operator','x')",
          [f.scope.branchId, 'c'.repeat(64)],
        ),
        denied,
      );
      await assert.rejects(asRuntime('UPDATE courier_incidents SET reported_at=now()'), denied);
      assert.deepEqual(Object.keys(RUNTIME_PRIVILEGES).sort(), [
        'courier_incidents',
        'delivery_handovers',
        'kds_layouts',
        'kds_setting_changes',
        'kds_settings',
      ]);
    } finally {
      await f.admin.query(`DROP OWNED BY ${role}`).catch(() => {});
      await f.admin.query(`DROP ROLE IF EXISTS ${role}`);
    }
  }));

// ---------------------------------------------------------------------------------------------
// KDS-2: the kitchen plan on PostgreSQL.
const S = (f, fn) => kdsStationId(f.scope.branchId, fn);
const reservation = async (f, orderId) =>
  (await f.pool.query('SELECT * FROM fulfillment_reservations WHERE order_id=$1', [orderId]))
    .rows[0];
const tasksOf = async (f, orderId) =>
  (
    await f.pool.query(
      'SELECT id,component_key,station_id,kind,details,state,version FROM fulfillment_tasks WHERE order_id=$1',
      [orderId],
    )
  ).rows.sort((a, b) => (a.component_key < b.component_key ? -1 : 1));
const activeRouting = async (f) =>
  RoutingSchema.parse(
    (
      await f.pool.query(
        'SELECT r.payload FROM fulfillment_routing r JOIN fulfillment_config c ON c.branch_id=r.branch_id AND c.active_routing_version=r.version',
      )
    ).rows[0].payload,
  );
const completeStation = (f, current, fn, actor = f.manager) =>
  f.act(current, 'complete_station', actor, { stationId: S(f, fn) });
const noKdsKeys = (value) => {
  const text = JSON.stringify(value);
  for (const key of ['"kds"', '"delivery"', '"upstreamOf"']) assert.ok(!text.includes(key), key);
};
const MARKS = Object.freeze({ numberMatched: true, courierAccepted: true, photoTaken: true });

test('KDS-2 layout off: stations and a stored layout change nothing for either admission path', () =>
  fixture(async (f) => {
    await writeKdsLayout(f.pool, f.scope.branchId, kdsTestLayout(f.scope.branchId), {
      enable: false,
    });
    const desk = await cashierDesk(f);
    const routing = await activeRouting(f);
    const { command, order } = await f.accepted(true);
    const cloud = await reservation(f, order.orderId);
    assert.deepEqual(cloud.task_plan, taskPlan(command.payload.snapshot, routing));
    assert.equal(cloud.assembly_station_id, f.assembly);
    const local = await desk.order();
    const cash = await reservation(f, local.order_id);
    assert.deepEqual(cash.task_plan, taskPlan(cash.snapshot, routing));
    assert.equal(cash.assembly_station_id, f.assembly);
    for (const id of [order.orderId, local.order_id]) {
      const read = await f.read(id);
      noKdsKeys(read);
      assert.ok(read.tasks.every((t) => [f.prep, f.assembly].includes(t.station_id)));
    }
    noKdsKeys(await f.repo.listKitchen(f.scope.branchId, f.manager.auth, {}));
    assert.deepEqual(await f.repo.readLayout(f.scope.branchId, f.packer.auth), { enabled: false });
    await assert.rejects(
      f.repo.readBreading(f.scope.branchId, f.manager.auth),
      errorCode('NOT_FOUND'),
    );
    const streams = await assertStrictEvents(f.pool);
    assert.ok(streams.pos > 0 && streams.cloud > 0);
  }));

test('KDS-2 cloud admission: the pinned KDS plan, cascade from the table, ready only at issue', () =>
  fixture(async (f) => {
    const b = f.scope.branchId;
    await writeKdsLayout(f.pool, b, kdsTestLayout(b));
    const { command, order } = await f.accepted(true);
    const row = await reservation(f, order.orderId);
    assert.equal(row.assembly_station_id, S(f, 'issue'));
    assert.equal(row.routing_version, 1);
    const lineId = command.payload.snapshot.lines[0].lineId;
    const key = (part, fn) => `${lineId}:component:${part}:${fn}`;
    let tasks = await tasksOf(f, order.orderId);
    assert.deepEqual(
      tasks.map((t) => [t.component_key, t.station_id, t.kind, t.details.kds, t.state]),
      [
        [
          key('burger', 'assembly_hall'),
          S(f, 'assembly_hall'),
          'assembly_item',
          { function: 'assembly_hall' },
          'queued',
        ],
        [
          key('burger', 'toasts'),
          S(f, 'toasts'),
          'prep',
          { function: 'toasts', upstreamOf: S(f, 'assembly_hall'), units: 2, unit: 'burger' },
          'queued',
        ],
        [key('drink', 'issue'), S(f, 'issue'), 'assembly_item', { function: 'issue' }, 'queued'],
        [
          key('fries', 'assembly_hall'),
          S(f, 'assembly_hall'),
          'assembly_item',
          { function: 'assembly_hall', fingers: 8 },
          'queued',
        ],
      ],
    );
    // The linked drink choice is hidden on the table and stays with the drink at issue.
    const drinkChoice = command.payload.snapshot.lines[0].selectedDetails.modifiers;
    for (const task of tasks)
      assert.deepEqual(
        task.details.modifiers,
        task.station_id === S(f, 'issue') ? drinkChoice : [],
      );
    const toast = tasks.find((t) => t.station_id === S(f, 'toasts'));
    let current = await f.act(order, 'start_task', f.manager, {
      taskId: toast.id,
      expectedTaskVersion: toast.version,
    });
    // Issue waits for the table and its toast; the table is never the finishing station.
    await assert.rejects(completeStation(f, current, 'issue'), errorCode('NOT_READY'));
    await assert.rejects(f.act(current, 'ready'), errorCode('NOT_READY'));
    const before = Number(
      (await f.pool.query('SELECT max(sequence) AS s FROM fulfillment_outbox')).rows[0].s,
    );
    current = await completeStation(f, current, 'assembly_hall');
    assert.equal(current.state, 'in_production');
    tasks = await tasksOf(f, order.orderId);
    assert.deepEqual(
      tasks.map((t) => t.state),
      ['done', 'done', 'queued', 'done'],
    );
    const cascade = (
      await f.pool.query(
        "SELECT payload FROM fulfillment_outbox WHERE sequence>$1 AND event_type='edge.task_changed' ORDER BY sequence",
        [before],
      )
    ).rows.map((r) => [r.payload.taskId, r.payload.stationId, r.payload.taskState]);
    // Toast first, with its own station; then the table's own tasks; no event of a new kind.
    assert.deepEqual(cascade[0], [toast.id, S(f, 'toasts'), 'done']);
    assert.equal(cascade.length, 5);
    assert.ok(cascade.slice(1).every(([, station]) => station === S(f, 'assembly_hall')));
    current = await completeStation(f, current, 'issue');
    assert.equal(current.state, 'ready');
    // The guest board shows the hall order as usual.
    assert.deepEqual((await f.repo.readDisplay(b)).items, [
      { number: current.displayNumber, state: 'ready' },
    ]);
    current = await f.act(current, 'handoff');
    assert.equal(current.state, 'handed_over');
    const read = await f.read(order.orderId);
    assert.ok(read.tasks.every((t) => t.details.kds));
    assert.ok(!('delivery' in read));
    assert.equal((await assertStrictEvents(f.pool)).pos, 0);
  }));

test('KDS-2 cloud reservation pins its plan: switching the layout before authorization changes nothing', () =>
  fixture(async (f) => {
    const b = f.scope.branchId;
    await writeKdsLayout(f.pool, b, kdsTestLayout(b));
    const kds = f.admission();
    const held = await f.repo.acceptCloud(f.scope, kds);
    await switchKdsLayout(f.pool, b, false);
    const legacy = f.admission();
    const legacyHeld = await f.repo.acceptCloud(f.scope, legacy);
    await switchKdsLayout(f.pool, b, true);
    const a = await f.repo.acceptCloud(f.scope, f.authorize(kds, held));
    const c = await f.repo.acceptCloud(f.scope, f.authorize(legacy, legacyHeld));
    assert.equal(a.assemblyStationId, S(f, 'issue'));
    assert.deepEqual(
      (await tasksOf(f, a.orderId)).map((t) => t.station_id),
      [S(f, 'assembly_hall'), S(f, 'toasts')],
    );
    assert.equal(c.assemblyStationId, f.assembly);
    assert.deepEqual(
      (await tasksOf(f, c.orderId)).map((t) => t.station_id),
      [f.prep],
    );
  }));

test('KDS-2 cashier admission through the seam: menu slugs, drink option at issue, cancel before start', () =>
  fixture(async (f) => {
    const b = f.scope.branchId;
    const desk = await cashierDesk(f);
    await writeKdsLayout(f.pool, b, kdsTestLayout(b));
    const local = await desk.order();
    assert.equal(local.fulfillment.state, 'accepted');
    const row = await reservation(f, local.order_id);
    assert.equal(row.assembly_station_id, S(f, 'issue'));
    const [combo, burger] = row.snapshot.lines;
    assert.equal(combo.selectedDetails.modifiers[0].optionId, desk.colaOption);
    const tasks = await tasksOf(f, local.order_id);
    assert.deepEqual(
      tasks.map((t) => [t.component_key, t.station_id, t.details.kds, t.details.modifiers.length]),
      [
        ...[
          [`${combo.lineId}:modifier:0:issue`, S(f, 'issue'), { function: 'issue' }, 0],
          [
            `${combo.lineId}:parent:assembly_hall`,
            S(f, 'assembly_hall'),
            { function: 'assembly_hall', fingers: 6 },
            0,
          ],
          [
            `${combo.lineId}:parent:toasts`,
            S(f, 'toasts'),
            { function: 'toasts', upstreamOf: S(f, 'assembly_hall'), units: 2 },
            0,
          ],
          [
            `${burger.lineId}:parent:assembly_hall`,
            S(f, 'assembly_hall'),
            { function: 'assembly_hall' },
            0,
          ],
          [
            `${burger.lineId}:parent:toasts`,
            S(f, 'toasts'),
            { function: 'toasts', upstreamOf: S(f, 'assembly_hall'), units: 1, unit: 'burger' },
            0,
          ],
        ].sort((x, y) => (x[0] < y[0] ? -1 : 1)),
      ],
    );
    const drink = tasks.find((t) => t.component_key.endsWith(':modifier:0:issue'));
    assert.deepEqual(
      [drink.details.productId, drink.details.title, drink.details.quantity],
      [desk.cola.product, 'Кола', 2],
    );
    // Hall path: the table closes both toasts, issue makes the order ready, then handoff.
    let current = await f.read(local.order_id);
    current = await completeStation(f, current, 'assembly_hall');
    assert.deepEqual(
      (await tasksOf(f, local.order_id)).filter((t) => t.state !== 'done').map((t) => t.station_id),
      [S(f, 'issue')],
    );
    current = await completeStation(f, current, 'issue');
    assert.equal(current.state, 'ready');
    assert.equal((await f.act(current, 'handoff')).state, 'handed_over');
    // Cancel before the kitchen starts: every KDS task of the order is cancelled.
    const second = await desk.order({ comboQuantity: 1, burgers: 2 });
    const cancelled = await desk.cancel(second);
    assert.equal(cancelled.state, 'cancelled');
    const after = await tasksOf(f, second.order_id);
    assert.equal(after.length, 5);
    assert.ok(after.every((t) => t.state === 'cancelled'));
    assert.equal((await reservation(f, second.order_id)).state, 'cancelled');
    // A started KDS order cannot be cancelled at the cashier, exactly as before.
    const third = await desk.order({ comboQuantity: 0, burgers: 1 });
    const toast = (await tasksOf(f, third.order_id)).find((t) => t.station_id === S(f, 'toasts'));
    await f.act(await f.read(third.order_id), 'start_task', f.manager, {
      taskId: toast.id,
      expectedTaskVersion: toast.version,
    });
    await assert.rejects(desk.cancel(third), (error) => error.code === 'ORDER_IN_PRODUCTION');
    const streams = await assertStrictEvents(f.pool);
    assert.ok(streams.pos >= 15, JSON.stringify(streams));
  }));

test('KDS-2 aggregator sale: table 2, drinks at issue, station 3 finishes, off the guest board', () =>
  fixture(async (f) => {
    const b = f.scope.branchId;
    const desk = await cashierDesk(f);
    await writeKdsLayout(f.pool, b, kdsTestLayout(b));
    const hall = await desk.order({ comboQuantity: 0, burgers: 1 });
    const delivery = { provider: 'yandex_eda', externalNumber: 'YA-123' };
    const agg = await desk.order({ delivery, burgers: 0 });
    const row = await reservation(f, agg.order_id);
    assert.equal(row.assembly_station_id, S(f, 'delivery_handover'));
    assert.deepEqual(row.snapshot.delivery, delivery);
    assert.equal(row.snapshot.serviceMode, 'takeaway');
    assert.deepEqual(
      (await tasksOf(f, agg.order_id)).map((t) => [
        t.station_id,
        t.details.kds.function,
        t.details.kds.upstreamOf,
      ]),
      [
        [S(f, 'issue'), 'issue', undefined],
        [S(f, 'assembly_delivery'), 'assembly_delivery', undefined],
        [S(f, 'toasts'), 'toasts', S(f, 'assembly_delivery')],
      ],
    );
    // Guest board: only the hall order, with the same keys as ever.
    const board = await f.repo.readDisplay(b);
    assert.deepEqual(board, {
      items: [{ number: (await reservation(f, hall.order_id)).display_number, state: 'preparing' }],
      nextAfterNumber: null,
    });
    // Kitchen output: delivery and details.kds only while the layout is on.
    const kitchen = await f.repo.listKitchen(b, f.manager.auth, {});
    const aggItem = kitchen.items.find((item) => item.orderId === agg.order_id);
    assert.deepEqual(aggItem.delivery, delivery);
    assert.ok(!('delivery' in kitchen.items.find((item) => item.orderId === hall.order_id)));
    assert.deepEqual((await f.read(agg.order_id)).delivery, delivery);
    await switchKdsLayout(f.pool, b, false);
    noKdsKeys(await f.read(agg.order_id));
    noKdsKeys(await f.repo.listKitchen(b, f.manager.auth, {}));
    assert.equal((await f.repo.readDisplay(b)).items.length, 1);
    await switchKdsLayout(f.pool, b, true);
    // Courier flow: drinks at issue do not make it ready; table 2, then station 3.
    let current = await f.read(agg.order_id);
    current = await completeStation(f, current, 'issue');
    assert.equal(current.state, 'in_production');
    await assert.rejects(completeStation(f, current, 'delivery_handover'), errorCode('NOT_READY'));
    current = await completeStation(f, current, 'assembly_delivery');
    current = await completeStation(f, current, 'delivery_handover');
    assert.equal(current.state, 'ready');
    assert.equal((await f.repo.readDisplay(b)).items.length, 1);
    // KDS-4: the courier handover needs the three protocol marks.
    current = await f.act(current, 'handoff', f.manager, { handover: MARKS });
    assert.equal(current.state, 'handed_over');
    await assertStrictEvents(f.pool);
  }));

test('KDS-2 race: toast completion and table completion on the same order version', () =>
  fixture(async (f) => {
    const b = f.scope.branchId;
    await writeKdsLayout(f.pool, b, kdsTestLayout(b));
    await grantStation(f.pool, b, f.cook.staff_id, S(f, 'toasts'));
    const winners = new Set();
    for (let round = 0; round < 6; round++) {
      const { order } = await f.accepted();
      const toast = (await tasksOf(f, order.orderId)).find((t) => t.station_id === S(f, 'toasts'));
      const current = await f.act(order, 'start_task', f.manager, {
        taskId: toast.id,
        expectedTaskVersion: toast.version,
      });
      const [byToast, byTable] = await Promise.allSettled([
        f.act(current, 'complete_task', f.cook, {
          taskId: toast.id,
          expectedTaskVersion: toast.version + 1,
        }),
        completeStation(f, current, 'assembly_hall', f.manager),
      ]);
      const outcomes = [byToast.status, byTable.status].sort();
      assert.deepEqual(outcomes, ['fulfilled', 'rejected']);
      const loser = byToast.status === 'rejected' ? byToast : byTable;
      assert.equal(loser.reason.code, 'CONFLICT');
      winners.add(byToast.status === 'fulfilled' ? 'toast' : 'table');
      const fresh = await f.read(order.orderId);
      const toastNow = fresh.tasks.find((t) => t.id === toast.id);
      assert.deepEqual([toastNow.state, toastNow.version], ['done', toast.version + 2]);
      if (byToast.status === 'fulfilled') {
        await completeStation(f, fresh, 'assembly_hall');
      } else {
        await assert.rejects(
          f.act(fresh, 'complete_task', f.cook, {
            taskId: toast.id,
            expectedTaskVersion: toast.version + 1,
          }),
          errorCode('CONFLICT'),
        );
        await assert.rejects(
          f.act(fresh, 'complete_task', f.cook, {
            taskId: toast.id,
            expectedTaskVersion: toast.version + 2,
          }),
          errorCode('NOT_READY'),
        );
      }
      const doneEvents = (
        await f.pool.query(
          "SELECT count(*)::int AS n FROM fulfillment_outbox WHERE payload->>'taskId'=$1 AND payload->>'taskState'='done'",
          [toast.id],
        )
      ).rows[0].n;
      assert.equal(doneEvents, 1);
      assert.ok((await tasksOf(f, order.orderId)).every((t) => t.state === 'done'));
    }
    assert.ok(winners.size >= 1);
    await assertStrictEvents(f.pool);
  }));

test('KDS-2 switch off: started KDS orders finish on their stations, new orders use the old routing', () =>
  fixture(async (f) => {
    const b = f.scope.branchId;
    await writeKdsLayout(f.pool, b, kdsTestLayout(b));
    const { order } = await f.accepted(true);
    await switchKdsLayout(f.pool, b, false);
    const { order: old } = await f.accepted(true);
    assert.equal(old.assemblyStationId, f.assembly);
    assert.ok((await tasksOf(f, old.orderId)).every((t) => !t.details.kds));
    let current = await f.read(order.orderId);
    noKdsKeys(current.tasks.map((t) => t.details));
    current = await completeStation(f, current, 'assembly_hall');
    assert.deepEqual(
      (await tasksOf(f, order.orderId)).filter((t) => t.state !== 'done').map((t) => t.station_id),
      [S(f, 'issue')],
    );
    current = await completeStation(f, current, 'issue');
    assert.equal(current.state, 'ready');
    // The old order still goes the old way.
    const legacy = await f.complete(old);
    assert.equal((await f.act(legacy, 'ready', f.packer)).state, 'ready');
  }));

test('KDS-2 GET layout and breading views: screens per terminal, fingers, permissions', () =>
  fixture(async (f) => {
    const b = f.scope.branchId;
    const desk = await cashierDesk(f);
    const terminals = {
      assembly_hall: [f.packer.terminal_id],
      issue: [f.packer.terminal_id],
      breading: [f.cook.terminal_id],
      toasts: [f.cook.terminal_id],
    };
    await writeKdsLayout(f.pool, b, kdsTestLayout(b, { terminals }), { enable: false });
    assert.deepEqual(await f.repo.readLayout(b, f.packer.auth), { enabled: false });
    await switchKdsLayout(f.pool, b, true);
    const layout = FulfillmentLayoutSchema.parse(await f.repo.readLayout(b, f.packer.auth));
    assert.deepEqual(layout, {
      enabled: true,
      layoutVersion: 1,
      mode: 'normal',
      stations: KDS_STATIONS.map((spec) => ({
        id: S(f, spec.function),
        function: spec.function,
        name: spec.name,
        kind: spec.kind,
      })),
      screens: [S(f, 'assembly_hall'), S(f, 'issue')],
    });
    assert.deepEqual((await f.repo.readLayout(b, f.cook.auth)).screens, [
      S(f, 'breading'),
      S(f, 'toasts'),
    ]);
    assert.deepEqual((await f.repo.readLayout(b, f.packer.auth, 'prep')).screens, []);
    assert.deepEqual((await f.repo.readLayout(b, f.manager.auth)).screens, []);
    await assert.rejects(f.repo.readLayout(b, f.cashier.auth), errorCode('FORBIDDEN'));

    const { order: combo } = await f.accepted(true);
    await f.accepted(); // a burger only: nothing to bread
    const local = await desk.order({ comboQuantity: 2, burgers: 1 });
    await assert.rejects(f.repo.readBreading(b, f.cook.auth), errorCode('FORBIDDEN'));
    await assert.rejects(f.repo.readBreading(b, f.cashier.auth), errorCode('FORBIDDEN'));
    await grantStation(f.pool, b, f.cook.staff_id, S(f, 'breading'));
    const view = KdsBreadingSchema.parse(await f.repo.readBreading(b, f.cook.auth));
    assert.deepEqual(view, {
      orders: [
        {
          orderId: combo.orderId,
          displayNumber: combo.displayNumber,
          serviceMode: 'takeaway',
          lines: [{ title: 'Synthetic fries', quantity: 4, fingers: 8 }],
          fingers: 8,
        },
        {
          orderId: local.order_id,
          displayNumber: (await reservation(f, local.order_id)).display_number,
          serviceMode: 'dine_in',
          lines: [{ title: 'Pick Combo', quantity: 2, fingers: 6 }],
          fingers: 6,
        },
      ],
      totalFingers: 14,
    });
    assert.deepEqual(
      (await f.repo.readBreading(b, f.cook.auth, { limit: 1 })).orders.map((o) => o.orderId),
      [combo.orderId],
    );
    // The table assembled the combo: it leaves the breading screen.
    await completeStation(f, await f.read(combo.orderId), 'assembly_hall');
    assert.deepEqual(
      (await f.repo.readBreading(b, f.manager.auth)).orders.map((o) => o.orderId),
      [local.order_id],
    );
    await assert.rejects(
      f.repo.readBreading(b, f.manager.auth, { limit: 0 }),
      errorCode('INVALID'),
    );
    await switchKdsLayout(f.pool, b, false);
    await assert.rejects(f.repo.readBreading(b, f.manager.auth), errorCode('NOT_FOUND'));
  }));

test('KDS-2 a database role without SELECT on the KDS tables keeps the old plan', () =>
  fixture(async (f) => {
    const b = f.scope.branchId;
    const role = 'kds_worker_' + randomUUID().replaceAll('-', '').slice(0, 20);
    await f.admin.query(`CREATE ROLE ${role} NOLOGIN NOINHERIT`);
    try {
      await f.pool.query(`GRANT USAGE ON SCHEMA ${f.schema} TO ${role}`);
      await writeKdsLayout(f.pool, b, kdsTestLayout(b));
      const snapshot = f.admission(true).payload.snapshot;
      const routing = await activeRouting(f);
      const plan = () =>
        transaction(f.pool, async (client) => {
          await client.query(`SET LOCAL ROLE ${role}`);
          return buildKitchenPlan(client, { branchId: b, snapshot, routing });
        });
      assert.deepEqual(await plan(), {
        plan: taskPlan(snapshot, routing),
        assemblyStationId: f.assembly,
      });
      await f.pool.query(
        `GRANT SELECT ON ${f.schema}.kds_settings,${f.schema}.kds_layouts TO ${role}`,
      );
      // Cloud lines name slugs: the worker never needs the menu tables.
      const kds = await plan();
      assert.equal(kds.assemblyStationId, S(f, 'issue'));
      assert.equal(kds.plan.length, 4);
    } finally {
      await f.admin.query(`DROP OWNED BY ${role}`).catch(() => {});
      await f.admin.query(`DROP ROLE IF EXISTS ${role}`);
    }
  }));

test('kds-grants: the fulfillment worker admits cloud orders on the KDS layout only with WORKER_PRIVILEGES', () =>
  fixture(async (f) => {
    const b = f.scope.branchId;
    const role = 'kds_ffworker_' + randomUUID().replaceAll('-', '').slice(0, 20);
    await f.admin.query(`CREATE ROLE ${role} NOLOGIN NOINHERIT`);
    let worker;
    try {
      // The real transport worker grant set (infra/windows/fulfillment-worker-grants.mjs).
      await f.pool.query(fulfillmentWorkerGrants(role, f.schema));
      await writeKdsLayout(f.pool, b, kdsTestLayout(b));
      const url = new URL(f.url);
      url.searchParams.set('options', url.searchParams.get('options') + ' -c role=' + role);
      worker = createPool(url.toString(), 2);
      assert.equal((await worker.query('SELECT current_user AS u')).rows[0].u, role);
      const repo = new EdgeFulfillment(worker);
      // Without the KDS worker rights the cloud order keeps today's stations.
      const plain = await repo.acceptCloud(f.scope, f.admission());
      assert.equal(plain.assemblyStationId, f.assembly);
      assert.deepEqual(
        Object.keys(WORKER_PRIVILEGES).sort(),
        Object.keys(RUNTIME_PRIVILEGES).sort(),
      );
      await assert.rejects(assertKdsWorkerPrivileges(f.pool, role, f.schema), /differ/);
      await f.pool.query(kdsWorkerGrantSql(role, f.schema));
      assert.deepEqual(await assertKdsWorkerPrivileges(f.pool, role, f.schema), {
        role,
        schema: f.schema,
        migration: MIGRATION,
        tables: 5,
        verified: true,
      });
      await assert.rejects(assertKdsRuntimePrivileges(f.pool, role, f.schema), /differ/);
      assert.deepEqual(await kdsTableGrantees(f.pool, f.schema), [role]);
      const command = f.admission(true);
      const held = await repo.acceptCloud(f.scope, command);
      assert.equal(held.assemblyStationId, S(f, 'issue'));
      const admitted = await repo.acceptCloud(f.scope, f.authorize(command, held));
      assert.equal(admitted.state, 'accepted');
      assert.deepEqual(
        (await tasksOf(f, admitted.orderId)).map((t) => t.details.kds.function).sort(),
        ['assembly_hall', 'assembly_hall', 'issue', 'toasts'],
      );
      // Read-only rights: the worker can neither switch the layout nor write a layout.
      const denied = (error) => error.code === '42501';
      await assert.rejects(worker.query('UPDATE kds_settings SET layout_enabled=false'), denied);
      await assert.rejects(
        worker.query(
          "INSERT INTO kds_layouts(branch_id,version,layout,checksum,source,reason) VALUES($1,9,'{}',$2,'operator','x')",
          [b, 'c'.repeat(64)],
        ),
        denied,
      );
      for (const extra of [
        `GRANT INSERT ON ${f.schema}.kds_layouts TO ${role}`,
        `GRANT SELECT ON ${f.schema}.delivery_handovers TO ${role}`,
      ]) {
        await f.pool.query(extra);
        await assert.rejects(assertKdsWorkerPrivileges(f.pool, role, f.schema), /differ/, extra);
        await f.pool.query(extra.replace('GRANT', 'REVOKE').replace(' TO ', ' FROM '));
      }
      await assertKdsWorkerPrivileges(f.pool, role, f.schema);
      await assertStrictEvents(f.pool);
    } finally {
      await worker?.end();
      await f.admin.query(`DROP OWNED BY ${role}`).catch(() => {});
      await f.admin.query(`DROP ROLE IF EXISTS ${role}`);
    }
  }));

// ---------------------------------------------------------------------------------------------
// KDS-4: the courier handover protocol (Аг9) on the edge.
const marksRequired = (error) =>
  error.code === 'INVALID' && error.reason === 'HANDOVER_MARKS_REQUIRED';
const handoff = (f, current, actor, extra = {}, commandId = randomUUID()) =>
  f.repo.act(f.scope.branchId, actor.auth, {
    commandId,
    orderId: current.orderId,
    expectedVersion: current.version,
    action: 'handoff',
    ...extra,
  });
/** An aggregator sale on the layout, completed by table 2, issue and station 3. */
async function readyDelivery(f, desk, delivery) {
  const local = await desk.order({ delivery, burgers: 0 });
  let current = await f.read(local.order_id);
  for (const fn of ['issue', 'assembly_delivery', 'delivery_handover'])
    current = await completeStation(f, current, fn);
  assert.equal(current.state, 'ready');
  return current;
}
/** A ticket on the old stations (layout off at admission): all tasks done, then ready. */
async function readyLegacy(f, local) {
  const done = await f.complete(await f.read(local.order_id));
  return f.act(done, 'ready', f.packer);
}

test('KDS-4 courier handover: three marks for a delivery order, journal row with the handoff, replay', () =>
  fixture(async (f) => {
    const b = f.scope.branchId;
    const desk = await cashierDesk(f);
    await writeKdsLayout(f.pool, b, kdsTestLayout(b));
    await grantStation(f.pool, b, f.packer.staff_id, S(f, 'delivery_handover'));
    const delivery = { provider: 'glovo', externalNumber: 'G-77' };
    // The state check comes first, as for every handoff.
    const early = await desk.order({ delivery, burgers: 0 });
    await assert.rejects(
      handoff(f, await f.read(early.order_id), f.packer),
      errorCode('NOT_READY'),
    );
    const current = await readyDelivery(f, desk, delivery);
    const counts = async () => ({
      version: (await reservation(f, current.orderId)).version,
      outbox: await f.count('fulfillment_outbox'),
      commands: await f.count('fulfillment_commands'),
      audit: await f.count('local_audit'),
      handovers: await f.count('delivery_handovers'),
    });
    const before = await counts();
    // Without the marks: HANDOVER_MARKS_REQUIRED and nothing is written.
    await assert.rejects(handoff(f, current, f.packer), marksRequired);
    // A missing, false or unknown mark is not a valid command at all.
    for (const bad of [
      { numberMatched: true, courierAccepted: true },
      { ...MARKS, photoTaken: false },
      { ...MARKS, extra: true },
    ])
      await assert.rejects(handoff(f, current, f.packer, { handover: bad }), errorCode('INVALID'));
    // Marks belong to a handoff only.
    await assert.rejects(
      f.act(current, 'ready', f.manager, { handover: MARKS }),
      errorCode('INVALID'),
    );
    assert.deepEqual(await counts(), before);
    // With the marks: handed over, and the journal row in the same transaction.
    const commandId = randomUUID();
    const handed = await handoff(f, current, f.packer, { handover: MARKS }, commandId);
    assert.equal(handed.state, 'handed_over');
    assert.equal(handed.version, current.version + 1);
    const journal = (await f.pool.query('SELECT * FROM delivery_handovers')).rows;
    assert.equal(journal.length, 1);
    const { handed_over_at: at, ...row } = journal[0];
    assert.ok(at instanceof Date);
    assert.deepEqual(row, {
      order_id: current.orderId,
      branch_id: b,
      command_id: commandId,
      provider: 'glovo',
      external_number: 'G-77',
      number_matched: true,
      courier_accepted: true,
      photo_taken: true,
      station_id: S(f, 'delivery_handover'),
      staff_id: f.packer.staff_id,
      terminal_id: f.packer.terminal_id,
      reported_at: null,
    });
    // Replay: the same key and body give the stored result; another body conflicts.
    assert.deepEqual(await handoff(f, current, f.packer, { handover: MARKS }, commandId), handed);
    await assert.rejects(handoff(f, current, f.packer, {}, commandId), errorCode('CONFLICT'));
    assert.equal(await f.count('delivery_handovers'), 1);
    // The handoff event keeps exactly the keys of a hall handoff (no marks, no delivery).
    const hall = await desk.order({ comboQuantity: 0, burgers: 1 });
    let plain = await f.read(hall.order_id);
    for (const fn of ['assembly_hall', 'issue']) plain = await completeStation(f, plain, fn);
    assert.equal((await f.act(plain, 'handoff')).state, 'handed_over');
    const handedEvents = (
      await f.pool.query(
        "SELECT order_id,payload FROM fulfillment_outbox WHERE event_type='edge.fulfillment_handed_over' ORDER BY sequence",
      )
    ).rows;
    assert.deepEqual(
      handedEvents.map((e) => e.order_id),
      [current.orderId, hall.order_id],
    );
    assert.deepEqual(
      Object.keys(handedEvents[0].payload).sort(),
      Object.keys(handedEvents[1].payload).sort(),
    );
    assert.equal(handedEvents[0].payload.staffId, f.packer.staff_id);
    // One journal row per command: a reused key of another login on another order conflicts.
    const second = await readyDelivery(f, desk, { provider: 'yandex_eda', externalNumber: 'YA-9' });
    await assert.rejects(
      handoff(f, second, f.manager, { handover: MARKS }, commandId),
      errorCode('CONFLICT'),
    );
    // A kitchen login without access to the finishing station cannot hand over.
    await assert.rejects(handoff(f, second, f.cook, { handover: MARKS }), errorCode('FORBIDDEN'));
    assert.equal((await reservation(f, second.orderId)).state, 'ready');
    assert.equal(await f.count('delivery_handovers'), 1);
    assert.equal((await handoff(f, second, f.manager, { handover: MARKS })).state, 'handed_over');
    assert.deepEqual(
      (
        await f.pool.query(
          'SELECT provider,external_number,staff_id FROM delivery_handovers WHERE order_id=$1',
          [second.orderId],
        )
      ).rows,
      [{ provider: 'yandex_eda', external_number: 'YA-9', staff_id: f.manager.staff_id }],
    );
    await assertStrictEvents(f.pool);
  }));

test('KDS-4 the protocol covers exactly the tickets that show delivery: layout off, hall, rollback', () =>
  fixture(async (f) => {
    const b = f.scope.branchId;
    const desk = await cashierDesk(f);
    await writeKdsLayout(f.pool, b, kdsTestLayout(b), { enable: false });
    for (const fn of ['assembly_hall', 'issue', 'assembly_delivery', 'delivery_handover'])
      await grantStation(f.pool, b, f.packer.staff_id, S(f, fn));
    const delivery = { provider: 'yandex_eda', externalNumber: 'YA-500' };
    // Layout off: an aggregator order is today's order. Marks are refused, the plain handoff works.
    let legacy = await readyLegacy(f, await desk.order({ delivery, burgers: 0 }));
    await assert.rejects(
      handoff(f, legacy, f.packer, { handover: MARKS }),
      (error) => error.code === 'INVALID' && error.reason === undefined,
    );
    legacy = await handoff(f, legacy, f.packer);
    assert.equal(legacy.state, 'handed_over');
    // Admitted while off, still open when the layout goes on: its ticket shows delivery now.
    const early = await readyLegacy(f, await desk.order({ delivery, burgers: 0 }));
    await switchKdsLayout(f.pool, b, true);
    assert.deepEqual((await f.read(early.orderId)).delivery, delivery);
    await assert.rejects(handoff(f, early, f.packer), marksRequired);
    assert.equal((await handoff(f, early, f.packer, { handover: MARKS })).state, 'handed_over');
    assert.deepEqual(
      (await f.pool.query('SELECT order_id,station_id FROM delivery_handovers')).rows,
      [{ order_id: early.orderId, station_id: f.assembly }],
    );
    // Layout on: hall orders (cashier and cloud) hand over without marks, marks are refused.
    let hall = await f.read((await desk.order({ comboQuantity: 0, burgers: 1 })).order_id);
    for (const fn of ['assembly_hall', 'issue']) hall = await completeStation(f, hall, fn);
    const { order } = await f.accepted(true);
    let cloud = await f.read(order.orderId);
    for (const fn of ['assembly_hall', 'issue']) cloud = await completeStation(f, cloud, fn);
    for (const ticket of [hall, cloud]) {
      assert.equal(ticket.state, 'ready');
      await assert.rejects(
        handoff(f, ticket, f.packer, { handover: MARKS }),
        (error) => error.code === 'INVALID' && error.reason === undefined,
      );
      assert.equal((await handoff(f, ticket, f.packer)).state, 'handed_over');
    }
    // Rollback: a KDS delivery order still open when the layout goes off finishes the old way
    // (the old screen has no marks); no journal row.
    const late = await readyDelivery(f, desk, delivery);
    await switchKdsLayout(f.pool, b, false);
    await assert.rejects(
      handoff(f, late, f.packer, { handover: MARKS }),
      (error) => error.code === 'INVALID' && error.reason === undefined,
    );
    assert.equal((await handoff(f, late, f.packer)).state, 'handed_over');
    assert.equal(await f.count('delivery_handovers'), 1);
    await assertStrictEvents(f.pool);
  }));
