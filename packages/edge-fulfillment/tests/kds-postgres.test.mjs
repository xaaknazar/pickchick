// Cutover lane kds, KDS-3 on PostgreSQL (full repository chain incl. 027): station provisioning,
// the 027 guards and the runtime grants of infra/windows/kds-grants.mjs.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { transaction } from '@pickchick/database';
import {
  MIGRATION,
  RUNTIME_PRIVILEGES,
  assertKdsRuntimePrivileges,
  kdsRuntimeGrantSql,
  kdsTableGrantees,
} from '../../../infra/windows/kds-grants.mjs';
import { KDS_STATIONS, kdsStationId, provisionKdsStations } from '../dist/index.js';
import { errorCode, fixture } from './fixture.mjs';
import { tableFingerprint } from './kds-fixture.mjs';

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
