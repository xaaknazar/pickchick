// Stage 2 lane cfg: back-office station plans delivered to the cashier edge (cloud070, edge024).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createApi } from '@pickchick/api';
import { createPool } from '@pickchick/database';
import {
  applyStationPlan,
  hashJson,
  provisionDevice,
  readActiveStationPlan,
  stationPlanReport,
  syncMenuOnce,
  syncStationPlanOnce,
} from '@pickchick/menu-sync';
import { provisionCatalogManager } from '../../packages/catalog-admin/dist/index.js';
import {
  Backoffice,
  grantBackoffice,
  pullStationPlan,
  readStationPlanStatus,
  recordStationPlanReceipt,
} from '../../packages/backoffice-core/dist/index.js';
import { backofficeGrants } from '../../infra/staging/backoffice-grants.mjs';
import { stationPlanGrants } from '../../infra/staging/station-plan-grants.mjs';
import { withSyncDatabases, running, authFor, headersFor, request } from '../helpers/sync.mjs';

const FLAG = 'BACKOFFICE_STATION_PLAN_DELIVERY_ENABLED';
const root = fileURLToPath(new URL('../../', import.meta.url));
const count = async (pool, table, where = 'true', args = []) =>
  Number((await pool.query(`SELECT count(*) FROM ${table} WHERE ${where}`, args)).rows[0].count);

/** Copies the migrations of one scope that sort before `before` (an installed older schema). */
async function olderSchema(scope, before, run) {
  const dir = await mkdtemp(join(tmpdir(), `pickchick-${scope}-before-${before}-`));
  try {
    const source = join(root, 'db', scope, 'migrations');
    for (const name of await readdir(source))
      if (/^\d{3}_[a-z_]+\.sql$/.test(name) && name < before)
        await copyFile(join(source, name), join(dir, name));
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function withEnv(value, run) {
  const previous = process.env[FLAG];
  if (value === undefined) delete process.env[FLAG];
  else process.env[FLAG] = value;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env[FLAG];
    else process.env[FLAG] = previous;
  }
}

function setup(run, { enabled = true, migrations = {} } = {}) {
  return withSyncDatabases(async (c) => {
    const manager = await provisionCatalogManager(c.cloud.pool, {
      organization_id: c.org,
      name: 'Синтетический управляющий станциями',
      branch_ids: [c.branch],
    });
    await grantBackoffice(c.cloud.pool, manager.actor_id, c.branch, 'manager');
    const bo = new Backoffice(c.cloud.pool, true, { stationPlanDeliveryEnabled: enabled });
    const identity = await provisionDevice(c.cloud.pool, c.device);
    const prep = randomUUID(),
      assembly = randomUUID();
    for (const [id, kind, name] of [
      [prep, 'prep', 'Фритюр'],
      [assembly, 'assembly', 'Сборка'],
    ])
      await c.edge.pool.query(
        'INSERT INTO fulfillment_stations(branch_id,id,kind,name) VALUES($1,$2,$3,$4)',
        [c.branch, id, kind, name],
      );
    const command = (value, reason = 'Синтетический план станций') =>
      bo.command(manager.token, c.branch, { request_id: randomUUID(), reason, command: value });
    const payload = (patch = {}) => ({
      name: 'Фритюр',
      role: 'prep',
      device_id: null,
      edge_station_id: prep,
      active: true,
      product_ids: ['synthetic-burger'],
      target_seconds: 240,
      ...patch,
    });
    /** Saves (creates or updates) a station record and returns its new revision. */
    const save = async (record, patch) => {
      const saved = await command({
        type: 'save',
        kind: 'station',
        id: record.id,
        expected_revision: record.revision,
        payload: payload(patch),
      });
      record.revision = saved.revision;
      return record;
    };
    const publish = (record) =>
      command({
        type: 'publish',
        kind: 'station',
        id: record.id,
        expected_revision: record.revision,
      });
    const auth = authFor(identity);
    const pull = async (extra = {}) =>
      (
        await pullStationPlan(c.cloud.pool, auth, {
          ...(await stationPlanReport(c.edge.pool, c.branch)),
          ...extra,
        })
      ).delivery;
    const read = async () => (await bo.read(manager.token, c.branch)).station_plan;
    await run({
      ...c,
      manager,
      bo,
      identity,
      auth,
      prep,
      assembly,
      command,
      save,
      publish,
      pull,
      read,
      station: () => ({ id: randomUUID(), revision: 0 }),
    });
  }, migrations);
}

test('a station publication reaches the edge over HTTP, applies atomically and the cabinet shows the edge-confirmed version', () =>
  setup(async (c) => {
    await withEnv('true', async () => {
      const api = await running(createApi, {
        ...c.cloud.config,
        backofficeEnabled: true,
        catalogAdminEnabled: true,
      });
      try {
        const fryer = await c.save(c.station());
        const published = await c.publish(fryer);
        assert.deepEqual(Object.keys(published.station_plan).sort(), ['id', 'version']);
        assert.equal(published.station_plan.version, 1);
        let status = await c.read();
        assert.equal(status.enabled, true);
        assert.equal(status.available, true);
        assert.equal(status.latest.state, 'published');
        assert.equal(status.latest.delivered_at, null);
        assert.equal(status.applied, null);
        assert.equal(
          (await c.bo.read(c.manager.token, c.branch)).capabilities.edge_configuration_delivery,
          true,
        );

        assert.deepEqual(await syncStationPlanOnce(c.edge.pool, c.branch, api.url, c.identity), {
          state: 'applied',
          version: 1,
        });
        const active = await readActiveStationPlan(c.edge.pool, c.branch);
        assert.equal(active.version, 1);
        assert.equal(active.plan.stations[0].edge_station_id, c.prep);
        // The receipt left the edge in the same cycle.
        assert.equal(await count(c.edge.pool, 'station_plan_receipts', 'reported_at IS NULL'), 0);
        status = await c.read();
        assert.equal(status.latest.state, 'applied');
        assert.equal(status.latest.deliveries, 1);
        assert.ok(status.latest.delivered_at);
        assert.equal(status.applied.version, 1);
        assert.equal(status.applied.id, published.station_plan.id);

        assert.deepEqual(await syncStationPlanOnce(c.edge.pool, c.branch, api.url, c.identity), {
          state: 'idle',
        });
        status = await c.read();
        assert.equal(status.edge.active_version, 1);
        assert.equal(status.edge.active_plan_id, published.station_plan.id);
        assert.deepEqual(status.edge.stations.map((s) => s.kind).sort(), ['assembly', 'prep']);
        // Sending the same plan again is a no-op while the edge did not reject it.
        const again = await c.command({ type: 'deliver_station_plan' });
        assert.deepEqual(again.station_plan, {
          id: published.station_plan.id,
          version: 1,
          created: false,
        });
        // Menu delivery keeps working next to station plans.
        assert.deepEqual(await syncMenuOnce(c.edge.pool, c.branch, api.url, c.identity), {
          state: 'idle',
        });
        const ready = await request(`${api.url}/health/ready`);
        assert.equal(ready.status, 200, 'cloud070 and its rights are checked when enabled');
        await ready.body?.cancel();

        // HTTP boundary: device authentication and bounded bodies.
        const pullUrl = `${api.url}/internal/v1/edge/station-plans/pull`;
        const anonymous = await request(pullUrl, {
          method: 'POST',
          headers: { ...headersFor(c.identity), Authorization: `Bearer ${'0'.repeat(64)}` },
          body: JSON.stringify({ active: null, stations: [] }),
        });
        assert.equal(anonymous.status, 401);
        await anonymous.body?.cancel();
        const malformed = await request(pullUrl, {
          method: 'POST',
          headers: headersFor(c.identity),
          body: JSON.stringify({ active: null, stations: [], cursor: 7 }),
        });
        assert.equal(malformed.status, 400);
        await malformed.body?.cancel();
        const receiptUrl = `${api.url}/internal/v1/edge/station-plans/receipt`;
        const unknown = await request(receiptUrl, {
          method: 'POST',
          headers: headersFor(c.identity),
          body: JSON.stringify({
            plan_id: randomUUID(),
            branch_id: c.branch,
            version: 9,
            checksum: 'a'.repeat(64),
            result: 'applied',
          }),
        });
        assert.equal(unknown.status, 404);
        await unknown.body?.cancel();
      } finally {
        await api.app.close();
      }
    });
  }));

test('an incompatible plan is rejected with a reason and the previous plan stays active', () =>
  setup(async (c) => {
    const apply = async () => {
      const receipt = await applyStationPlan(c.edge.pool, c.branch, await c.pull());
      await recordStationPlanReceipt(c.cloud.pool, c.auth, receipt);
      return receipt;
    };
    const fryer = await c.save(c.station());
    await c.publish(fryer);
    assert.equal((await apply()).result, 'applied');

    // Unknown local station: the edge has no such kitchen station.
    const drinks = await c.save(c.station(), { name: 'Напитки', edge_station_id: randomUUID() });
    await c.publish(drinks);
    let receipt = await apply();
    assert.equal(receipt.result, 'rejected');
    assert.equal(receipt.reason, 'UNKNOWN_STATION');
    assert.equal(receipt.station_id, drinks.id);
    assert.equal(receipt.version, 2);
    assert.equal((await readActiveStationPlan(c.edge.pool, c.branch)).version, 1);
    let status = await c.read();
    assert.equal(status.latest.state, 'rejected');
    assert.equal(status.latest.reason, 'UNKNOWN_STATION');
    assert.equal(status.latest.station_name, 'Напитки');
    assert.equal(status.applied.version, 1);
    // The rejected plan is answered: nothing more is delivered until a new version exists.
    assert.equal(await c.pull(), null);

    // Kind mismatch: an assembly station bound to the prep kitchen station.
    await c.save(drinks, { name: 'Напитки', role: 'assembly', edge_station_id: c.prep });
    await c.publish(drinks);
    receipt = await apply();
    assert.equal(receipt.reason, 'STATION_KIND_MISMATCH');
    assert.equal(receipt.station_id, drinks.id);
    assert.equal((await readActiveStationPlan(c.edge.pool, c.branch)).version, 1);

    // Fixed binding: the next version applies and becomes the active plan.
    await c.save(drinks, { name: 'Напитки', role: 'assembly', edge_station_id: c.assembly });
    const fixed = await c.publish(drinks);
    receipt = await apply();
    assert.equal(receipt.result, 'applied');
    assert.equal(receipt.version, fixed.station_plan.version);
    assert.equal((await readActiveStationPlan(c.edge.pool, c.branch)).version, 4);

    // Two active plan stations cannot both be the same kitchen station.
    const twin = await c.save(c.station(), { name: 'Второй фритюр' });
    await c.publish(twin);
    receipt = await apply();
    assert.equal(receipt.reason, 'INVALID_PLAN');
    assert.equal((await readActiveStationPlan(c.edge.pool, c.branch)).version, 4);
    await c.save(twin, { name: 'Второй фритюр', active: false });
    await c.publish(twin);
    receipt = await apply();
    assert.equal(receipt.result, 'applied');
    status = await c.read();
    assert.equal(status.applied.version, 6);
    assert.deepEqual(
      status.plans.map((p) => p.state),
      ['applied', 'rejected', 'applied', 'rejected', 'rejected', 'applied'],
    );
    assert.equal(
      await count(c.edge.pool, 'station_plan_snapshots'),
      3,
      'only applied plans are stored as snapshots',
    );

    // The cabinet refuses a binding the cashier kitchen cannot have.
    await assert.rejects(
      c.save(c.station(), { name: 'Выдача', role: 'handoff', edge_station_id: c.assembly }),
      /INVALID_REQUEST/,
    );
  }));

test('the edge rejects unsupported schema, invalid content and older versions; integrity errors are retried', () =>
  setup(async (c) => {
    const fryer = await c.save(c.station());
    await c.publish(fryer);
    const delivery = await c.pull();
    const crafted = (patch) => {
      const plan = { ...delivery.plan, plan_id: randomUUID(), ...patch };
      return { plan, checksum: hashJson(plan) };
    };
    // Integrity first: no receipt, the cloud offers the plan again.
    for (const broken of [
      { ...delivery, checksum: '0'.repeat(64) },
      crafted({ branch_id: randomUUID() }),
    ])
      await assert.rejects(applyStationPlan(c.edge.pool, c.branch, broken), { code: 'CONFLICT' });
    for (const broken of [
      { plan: delivery.plan },
      { ...delivery, extra: true },
      crafted({ plan_id: 'not-a-uuid' }),
      crafted({ version: 0 }),
    ])
      await assert.rejects(applyStationPlan(c.edge.pool, c.branch, broken), {
        code: 'INVALID_REQUEST',
      });
    assert.equal(await count(c.edge.pool, 'station_plan_receipts'), 0);

    const future = await applyStationPlan(
      c.edge.pool,
      c.branch,
      crafted({ schema_version: 2, stations: [{ unknown: true }] }),
    );
    assert.deepEqual([future.result, future.reason], ['rejected', 'SCHEMA_UNSUPPORTED']);
    const invalid = await applyStationPlan(c.edge.pool, c.branch, crafted({ stations: [] }));
    assert.deepEqual([invalid.result, invalid.reason], ['rejected', 'INVALID_PLAN']);
    assert.equal(await readActiveStationPlan(c.edge.pool, c.branch), null);

    assert.equal((await applyStationPlan(c.edge.pool, c.branch, delivery)).result, 'applied');
    const older = await applyStationPlan(c.edge.pool, c.branch, crafted({ version: 1 }));
    assert.deepEqual([older.result, older.reason], ['rejected', 'VERSION_NOT_NEWER']);
    assert.equal(
      (await readActiveStationPlan(c.edge.pool, c.branch)).plan_id,
      delivery.plan.plan_id,
    );
    // A receipt for a plan the cloud never published is not recorded.
    await assert.rejects(recordStationPlanReceipt(c.cloud.pool, c.auth, older), {
      code: 'NOT_FOUND',
    });
  }));

test('replays are idempotent, a lost receipt response is resent and versions never collide', () =>
  setup(async (c) => {
    await withEnv('true', async () => {
      const api = await running(createApi, {
        ...c.cloud.config,
        backofficeEnabled: true,
        catalogAdminEnabled: true,
      });
      try {
        const [a, b] = [await c.save(c.station()), await c.save(c.station(), { active: false })];
        const versions = await Promise.all([c.publish(a), c.publish(b)]);
        assert.deepEqual(versions.map((v) => v.station_plan.version).sort(), [1, 2]);
        const first = await c.pull();
        const second = await c.pull();
        assert.deepEqual(second, first);
        assert.equal(first.plan.version, 2);
        assert.equal((await c.read()).latest.deliveries, 2);

        const receipts = await Promise.all([
          applyStationPlan(c.edge.pool, c.branch, first),
          applyStationPlan(c.edge.pool, c.branch, first),
        ]);
        assert.deepEqual(receipts[0], receipts[1]);
        for (const table of [
          'station_plan_snapshots',
          'station_plan_receipts',
          'station_plan_active',
        ])
          assert.equal(await count(c.edge.pool, table), 1);
        // The same plan id with different content is an integrity conflict, not a new plan.
        const changed = {
          ...first.plan,
          stations: [{ ...first.plan.stations[0], name: 'Другое' }],
        };
        await assert.rejects(
          applyStationPlan(c.edge.pool, c.branch, { plan: changed, checksum: hashJson(changed) }),
          { code: 'CONFLICT' },
        );

        // The cloud stored the receipt but the HTTP answer was lost: the edge sends it again.
        const receipt = receipts[0];
        assert.deepEqual(await recordStationPlanReceipt(c.cloud.pool, c.auth, receipt), {
          plan_id: first.plan.plan_id,
          recorded: true,
        });
        assert.deepEqual(await recordStationPlanReceipt(c.cloud.pool, c.auth, receipt), {
          plan_id: first.plan.plan_id,
          recorded: true,
        });
        await assert.rejects(
          recordStationPlanReceipt(c.cloud.pool, c.auth, {
            ...receipt,
            result: 'rejected',
            reason: 'INVALID_PLAN',
          }),
          { code: 'CONFLICT' },
        );
        await assert.rejects(
          recordStationPlanReceipt(c.cloud.pool, c.auth, { ...receipt, checksum: 'b'.repeat(64) }),
          { code: 'CONFLICT' },
        );
        assert.equal(await count(c.edge.pool, 'station_plan_receipts', 'reported_at IS NULL'), 1);
        assert.deepEqual(await syncStationPlanOnce(c.edge.pool, c.branch, api.url, c.identity), {
          state: 'reported',
          version: 2,
        });
        assert.equal(await count(c.edge.pool, 'station_plan_receipts', 'reported_at IS NULL'), 0);
        assert.equal(await count(c.cloud.pool, 'bo_station_plan_receipts'), 1);
        assert.deepEqual(await syncStationPlanOnce(c.edge.pool, c.branch, api.url, c.identity), {
          state: 'idle',
        });
        const status = await c.read();
        assert.deepEqual(
          status.plans.map((p) => [p.version, p.state]),
          [
            [2, 'applied'],
            [1, 'superseded'],
          ],
        );
        // Nothing changed and nothing was rejected: sending again creates no new version.
        const next = await c.command({ type: 'deliver_station_plan' });
        assert.deepEqual(next.station_plan, { id: first.plan.plan_id, version: 2, created: false });
      } finally {
        await api.app.close();
      }
    });
  }));

test('report mode records the edge state without handing out a plan', () =>
  setup(async (c) => {
    await withEnv('true', async () => {
      const api = await running(createApi, {
        ...c.cloud.config,
        backofficeEnabled: true,
        catalogAdminEnabled: true,
      });
      try {
        await c.publish(await c.save(c.station()));
        assert.deepEqual(
          await syncStationPlanOnce(c.edge.pool, c.branch, api.url, c.identity, {
            mode: 'report',
          }),
          { state: 'idle' },
        );
        const status = await c.read();
        assert.equal(status.latest.state, 'published');
        assert.equal(status.edge.stations.length, 2);
        assert.equal(status.edge.active_version, null);
        assert.equal(await count(c.cloud.pool, 'bo_station_plan_deliveries'), 0);
        assert.equal(await count(c.edge.pool, 'station_plan_receipts'), 0);
      } finally {
        await api.app.close();
      }
    });
  }));

test('old edges, older clouds and the disabled flag keep the previous behaviour', async () => {
  // Disabled flag: publication works as before and creates no plan; the routes answer 404.
  await setup(
    async (c) => {
      await withEnv(undefined, async () => {
        const api = await running(createApi, {
          ...c.cloud.config,
          backofficeEnabled: true,
          catalogAdminEnabled: true,
        });
        try {
          const published = await c.publish(await c.save(c.station()));
          assert.equal(published.station_plan, undefined);
          assert.equal(await count(c.cloud.pool, 'bo_station_plans'), 0);
          await assert.rejects(c.command({ type: 'deliver_station_plan' }), (error) => {
            assert.equal(error.code, 'NOT_READY');
            assert.equal(error.reason, 'STATION_PLAN_DELIVERY_DISABLED');
            return true;
          });
          const snapshot = await c.bo.read(c.manager.token, c.branch);
          assert.equal(snapshot.station_plan.enabled, false);
          assert.equal(snapshot.capabilities.edge_configuration_delivery, false);
          // A new edge runtime against a cloud without the flag: menu sync is untouched.
          assert.deepEqual(await syncStationPlanOnce(c.edge.pool, c.branch, api.url, c.identity), {
            state: 'unavailable',
          });
          assert.deepEqual(await syncMenuOnce(c.edge.pool, c.branch, api.url, c.identity), {
            state: 'idle',
          });
        } finally {
          await api.app.close();
        }
      });
    },
    { enabled: false },
  );

  // An old edge never pulls: the cabinet keeps saying "published", never "applied".
  await setup(async (c) => {
    const first = await c.save(c.station());
    await c.publish(first);
    await c.publish(await c.save(c.station(), { name: 'Второй' }));
    const status = await c.read();
    assert.deepEqual(
      status.plans.map((p) => p.state),
      ['published', 'superseded'],
    );
    assert.equal(status.applied, null);
    assert.equal(status.edge, null);
  });

  // A new runtime on an edge database before schema024 never contacts the cloud.
  await olderSchema('edge', '024', (edgeMigrationDirectory) =>
    withSyncDatabases(
      async (c) => {
        const identity = await provisionDevice(c.cloud.pool, c.device);
        assert.deepEqual(
          await syncStationPlanOnce(c.edge.pool, c.branch, 'http://127.0.0.1:9', identity),
          { state: 'schema_missing' },
        );
      },
      { edgeMigrationDirectory },
    ),
  );

  // The cabinet on a cloud before cloud070 reads as before.
  await olderSchema('cloud', '070', (cloudMigrationDirectory) =>
    withSyncDatabases(
      async (c) => {
        const manager = await provisionCatalogManager(c.cloud.pool, {
          organization_id: c.org,
          name: 'Синтетический управляющий',
          branch_ids: [c.branch],
        });
        await grantBackoffice(c.cloud.pool, manager.actor_id, c.branch, 'manager');
        const snapshot = await new Backoffice(c.cloud.pool, true).read(manager.token, c.branch);
        assert.equal(snapshot.station_plan.available, false);
        assert.equal(snapshot.capabilities.edge_configuration_delivery, false);
        // Switching the flag on before cloud070 keeps the API out of service (readiness).
        for (const [flag, status] of [
          [undefined, 200],
          ['true', 503],
        ])
          await withEnv(flag, async () => {
            const api = await running(createApi, {
              ...c.cloud.config,
              backofficeEnabled: true,
              catalogAdminEnabled: true,
            });
            try {
              const ready = await request(`${api.url}/health/ready`);
              assert.equal(ready.status, status, `flag ${flag}`);
              await ready.body?.cancel();
            } finally {
              await api.app.close();
            }
          });
      },
      { cloudMigrationDirectory },
    ),
  );
});

test('an empty branch has no plan to send', () =>
  setup(async (c) => {
    await assert.rejects(c.command({ type: 'deliver_station_plan' }), (error) => {
      assert.equal(error.code, 'NOT_READY');
      assert.equal(error.reason, 'STATION_PLAN_EMPTY');
      return true;
    });
  }));

test('plan, delivery, receipt and active-plan rows only move forward', () =>
  setup(async (c) => {
    await c.publish(await c.save(c.station()));
    const delivery = await c.pull();
    const receipt = await applyStationPlan(c.edge.pool, c.branch, delivery);
    await recordStationPlanReceipt(c.cloud.pool, c.auth, receipt);
    for (const sql of [
      'UPDATE bo_station_plans SET version=version+1',
      'DELETE FROM bo_station_plans',
      "UPDATE bo_station_plan_receipts SET result='rejected',reason='INVALID_PLAN'",
      'DELETE FROM bo_station_plan_receipts',
      'UPDATE bo_station_plan_deliveries SET deliveries=0',
      'DELETE FROM bo_station_plan_deliveries',
    ])
      await assert.rejects(c.cloud.pool.query(sql), { code: '23514' }, sql);
    for (const sql of [
      'UPDATE station_plan_active SET version=version-1',
      'DELETE FROM station_plan_active',
      "UPDATE station_plan_snapshots SET payload='{}'",
      'DELETE FROM station_plan_snapshots',
      "UPDATE station_plan_receipts SET result='rejected',reason='INVALID_PLAN'",
      'UPDATE station_plan_receipts SET reported_at=NULL',
      'DELETE FROM station_plan_receipts',
    ])
      await assert.rejects(c.edge.pool.query(sql), { code: '23514' }, sql);
    // reported_at moves once.
    await c.edge.pool.query(
      'UPDATE station_plan_receipts SET reported_at=now() WHERE reported_at IS NULL',
    );
    await assert.rejects(c.edge.pool.query('UPDATE station_plan_receipts SET reported_at=now()'), {
      code: '23514',
    });
  }));

test('restricted API role: station plan grants follow the back-office and delivery flags', () =>
  setup(async (c) => {
    const role = 'plan_runtime_' + randomUUID().replaceAll('-', '');
    await c.cloud.admin.query(
      `CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
    );
    let pool;
    try {
      await c.cloud.pool.query(`GRANT USAGE ON SCHEMA ${c.cloud.schema} TO ${role}`);
      await c.cloud.pool.query(backofficeGrants(role, true));
      // provision.mjs base runtime grants used by device authentication.
      await c.cloud.pool.query(`GRANT SELECT ON devices, device_credentials TO ${role};
        GRANT UPDATE (id) ON devices TO ${role};
        GRANT UPDATE (device_id) ON device_credentials TO ${role};`);
      await c.cloud.pool.query(stationPlanGrants(role, { backoffice: true, delivery: true }));
      const url = new URL(c.cloud.config.databaseUrl);
      url.searchParams.set('options', `-c search_path=${c.cloud.schema} -c role=${role}`);
      pool = createPool(url.toString());
      const bo = new Backoffice(pool, true, { stationPlanDeliveryEnabled: true });
      const command = (value) =>
        bo.command(c.manager.token, c.branch, {
          request_id: randomUUID(),
          reason: 'Синтетическая проверка прав',
          command: value,
        });
      const record = { id: randomUUID() };
      const saved = await command({
        type: 'save',
        kind: 'station',
        id: record.id,
        expected_revision: 0,
        payload: {
          name: 'Фритюр',
          role: 'prep',
          device_id: null,
          edge_station_id: c.prep,
          active: true,
          product_ids: [],
          target_seconds: 120,
        },
      });
      const published = await command({
        type: 'publish',
        kind: 'station',
        id: record.id,
        expected_revision: saved.revision,
      });
      assert.equal(published.station_plan.version, 1);
      const report = await stationPlanReport(c.edge.pool, c.branch);
      const { delivery } = await pullStationPlan(pool, c.auth, report);
      const receipt = await applyStationPlan(c.edge.pool, c.branch, delivery);
      await recordStationPlanReceipt(pool, c.auth, receipt);
      assert.equal((await bo.read(c.manager.token, c.branch)).station_plan.latest.state, 'applied');
      for (const sql of [
        'UPDATE bo_station_plans SET version=2',
        'DELETE FROM bo_station_plans',
        'UPDATE bo_station_plan_receipts SET reason=NULL',
        'DELETE FROM bo_station_plan_receipts',
        'DELETE FROM bo_station_plan_deliveries',
        'UPDATE bo_station_plan_deliveries SET plan_id=plan_id',
      ])
        await assert.rejects(pool.query(sql), { code: '42501' }, sql);

      // Delivery off: the cabinet keeps the history, the edge routes cannot write.
      await c.cloud.pool.query(stationPlanGrants(role, { backoffice: true, delivery: false }));
      const history = (await new Backoffice(pool, true).read(c.manager.token, c.branch))
        .station_plan;
      assert.equal(history.available, true);
      assert.equal(history.applied.version, 1);
      await assert.rejects(pullStationPlan(pool, c.auth, report), { code: '42501' });
      // Replaying an already recorded receipt only reads.
      assert.equal((await recordStationPlanReceipt(pool, c.auth, receipt)).recorded, true);

      // Back-office off: the section reads as unavailable instead of failing the cabinet.
      await c.cloud.pool.query(stationPlanGrants(role, { backoffice: false, delivery: false }));
      assert.equal((await readStationPlanStatus(pool, c.branch, false)).available, false);
      for (const table of [
        'bo_station_plans',
        'bo_station_plan_deliveries',
        'bo_station_plan_receipts',
        'bo_station_plan_edge_state',
      ])
        assert.equal(
          (
            await c.cloud.pool.query(
              "SELECT has_any_column_privilege($1,$2,'SELECT,INSERT,UPDATE') AS any",
              [role, table],
            )
          ).rows[0].any,
          false,
          table,
        );
      assert.throws(() => stationPlanGrants('Bad-Role', { backoffice: true, delivery: true }));
      assert.throws(() => stationPlanGrants(role, { backoffice: true }));
    } finally {
      await pool?.end();
      await c.cloud.pool.query(`DROP OWNED BY ${role}`);
      await c.cloud.admin.query(`DROP ROLE ${role}`);
    }
  }));
