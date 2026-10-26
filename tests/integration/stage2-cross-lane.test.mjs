// Stage 2 integration: the merged cashier talks to one merged API with the three new protocol
// extensions together - menu pull `menu_features` (lane pcs), station plan pull/receipt (lane
// cfg) and the optional heartbeat field `edgeBackup` (lane ebk) - with the flags on and off.
/* global structuredClone */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createApi } from '@pickchick/api';
import {
  hashJson,
  projectCatalogMenu,
  provisionDevice,
  publishMenu,
  readActiveStationPlan,
  syncMenuOnce,
  syncStationPlanOnce,
} from '@pickchick/menu-sync';
import { MenuPullSchema } from '@pickchick/contracts';
import {
  PullResponseSchema,
  provisionFulfillmentTransport,
  transportRequest,
} from '../../packages/fulfillment-transport/dist/index.js';
import { mockupCatalogDraft } from '../../packages/catalog-admin/dist/seed.js';
import { provisionCatalogManager } from '../../packages/catalog-admin/dist/index.js';
import { Backoffice, grantBackoffice } from '../../packages/backoffice-core/dist/index.js';
import { withSyncDatabases, running, headersFor, request } from '../helpers/sync.mjs';

const FLAG = 'BACKOFFICE_STATION_PLAN_DELIVERY_ENABLED';
const at = '2026-10-24T00:00:00.000Z';
const attention = { state: 'stale', ageMinutes: 190, maxAgeMinutes: 120, error: null };
const fieldsIn = (value) =>
  /combo_component_variant_ids|linked_variant_id/.test(JSON.stringify(value));

function catalog() {
  const draft = structuredClone(mockupCatalogDraft);
  const product = (id) => draft.products.find((p) => p.id === id);
  product('pick-combo').combo_components = [
    { product_id: 'fingers', quantity: 3 },
    { product_id: 'toast', quantity: 1 },
  ];
  return draft;
}

async function withFlag(value, run) {
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

/** The cloud log lines `edge_backup_attention` written while `run` executes (same process). */
async function backupLines(run) {
  const lines = [];
  const original = console.error;
  console.error = (...args) => lines.push(args.join(' '));
  try {
    return { result: await run(), lines: lines.filter((l) => l.includes('edge_backup_attention')) };
  } finally {
    console.error = original;
  }
}

/** One branch, its cashier device (menu, plan and transport identity) and a station manager. */
function cashier(run) {
  return withSyncDatabases(async (c) => {
    const identity = await provisionDevice(c.cloud.pool, c.device);
    await provisionFulfillmentTransport(c.cloud.pool, {
      organizationId: c.org,
      branchId: c.branch,
      deviceId: c.device,
      producerId: randomUUID(),
    });
    const manager = await provisionCatalogManager(c.cloud.pool, {
      organization_id: c.org,
      name: 'Синтетический управляющий этапа 2',
      branch_ids: [c.branch],
    });
    await grantBackoffice(c.cloud.pool, manager.actor_id, c.branch, 'manager');
    const station = randomUUID();
    await c.edge.pool.query(
      "INSERT INTO fulfillment_stations(branch_id,id,kind,name) VALUES($1,$2,'prep','Фритюр')",
      [c.branch, station],
    );
    const publishStation = async (bo) => {
      const command = (value) =>
        bo.command(manager.token, c.branch, {
          request_id: randomUUID(),
          reason: 'Синтетический план станций',
          command: value,
        });
      const saved = await command({
        type: 'save',
        kind: 'station',
        id: randomUUID(),
        expected_revision: 0,
        payload: {
          name: 'Фритюр',
          role: 'prep',
          device_id: null,
          edge_station_id: station,
          active: true,
          product_ids: ['synthetic-burger'],
          target_seconds: 240,
        },
      });
      return command({
        type: 'publish',
        kind: 'station',
        id: saved.id,
        expected_revision: saved.revision,
      });
    };
    /** The heartbeat pull of the new cashier fulfillment worker, with the backup field. */
    const heartbeat = (url, extra = {}) =>
      transportRequest(url, 'pull', identity, {
        workerId: randomUUID(),
        leaseSeconds: 30,
        ...extra,
      });
    await run({ ...c, identity, manager, station, publishStation, heartbeat });
  });
}

test('flags on: one API serves the combo stop menu, the station plan and the backup heartbeat of the merged cashier', () =>
  cashier((c) =>
    withFlag('true', async () => {
      const extended = projectCatalogMenu(catalog(), c.branch, 1, at, randomUUID(), {
        comboStops: true,
      });
      await publishMenu(c.cloud.pool, extended);
      const api = await running(createApi, {
        ...c.cloud.config,
        backofficeEnabled: true,
        catalogAdminEnabled: true,
        fulfillmentTransportEnabled: true,
      });
      try {
        const bo = new Backoffice(c.cloud.pool, true, { stationPlanDeliveryEnabled: true });
        const published = await c.publishStation(bo);
        // Menu worker cycle: menu (sends menu_features) and then the station plan step.
        assert.deepEqual(await syncMenuOnce(c.edge.pool, c.branch, api.url, c.identity), {
          state: 'applied',
        });
        assert.deepEqual(await syncStationPlanOnce(c.edge.pool, c.branch, api.url, c.identity), {
          state: 'applied',
          version: 1,
        });
        const stored = (await c.edge.pool.query('SELECT payload, checksum FROM menu_snapshots'))
          .rows[0];
        assert.equal(fieldsIn(stored.payload), true);
        assert.equal(stored.checksum, hashJson(extended));
        const active = await readActiveStationPlan(c.edge.pool, c.branch);
        assert.equal(active.version, 1);
        assert.equal(active.plan.stations[0].edge_station_id, c.station);
        // The cabinet shows the version the cashier confirmed, not only the publication.
        const status = (await bo.read(c.manager.token, c.branch)).station_plan;
        assert.equal(status.applied.version, 1);
        assert.equal(status.applied.id, published.station_plan.id);
        // Fulfillment worker heartbeat with the optional backup field: accepted and logged.
        const { result, lines } = await backupLines(() =>
          c.heartbeat(api.url, { edgeBackup: attention }),
        );
        assert.equal(PullResponseSchema.safeParse(result).success, true);
        assert.equal(lines.length, 1);
        assert.deepEqual(JSON.parse(lines[0]), {
          event: 'edge_backup_attention',
          branchId: c.branch,
          ...attention,
        });
        // An installed (old) worker: no menu_features, no plan step, no backup field.
        const old = await request(`${api.url}/internal/v1/edge/sync/pull`, {
          headers: headersFor(c.identity),
        });
        assert.equal(old.status, 200);
        assert.equal(fieldsIn(MenuPullSchema.parse(await old.json())), false);
        assert.equal(
          PullResponseSchema.safeParse(await c.heartbeat(api.url)).success,
          true,
          'heartbeat without the field',
        );
        const ready = await request(`${api.url}/health/ready`);
        assert.equal(ready.status, 200);
        await ready.body?.cancel();
      } finally {
        await api.app.close();
      }
    }),
  ));

test('flags off (the first API release): the merged cashier keeps syncing menus and beating', () =>
  cashier((c) =>
    withFlag(undefined, async () => {
      const legacy = projectCatalogMenu(catalog(), c.branch, 1, at, randomUUID());
      await publishMenu(c.cloud.pool, legacy);
      const api = await running(createApi, {
        ...c.cloud.config,
        backofficeEnabled: true,
        catalogAdminEnabled: true,
        fulfillmentTransportEnabled: true,
      });
      try {
        const bo = new Backoffice(c.cloud.pool, true, { stationPlanDeliveryEnabled: false });
        const published = await c.publishStation(bo);
        assert.equal(published.station_plan, undefined);
        assert.deepEqual(await syncMenuOnce(c.edge.pool, c.branch, api.url, c.identity), {
          state: 'applied',
        });
        assert.deepEqual(await syncStationPlanOnce(c.edge.pool, c.branch, api.url, c.identity), {
          state: 'unavailable',
        });
        assert.equal(await readActiveStationPlan(c.edge.pool, c.branch), null);
        const stored = (await c.edge.pool.query('SELECT payload, checksum FROM menu_snapshots'))
          .rows[0];
        assert.equal(fieldsIn(stored.payload), false);
        assert.equal(stored.checksum, hashJson(legacy));
        const { result, lines } = await backupLines(() =>
          c.heartbeat(api.url, {
            edgeBackup: { ...attention, state: 'failed', error: 'UNREVIEWED_SCHEMA' },
          }),
        );
        assert.equal(PullResponseSchema.safeParse(result).success, true);
        assert.equal(lines.length, 1);
        const ready = await request(`${api.url}/health/ready`);
        assert.equal(ready.status, 200);
        await ready.body?.cancel();
      } finally {
        await api.app.close();
      }
    }),
  ));

test('the merged contracts publish all three extensions next to each other', async () => {
  const { readFile } = await import('node:fs/promises');
  const { EDGE_MENU_FEATURES_QUERY_KEY, EdgeMenuFeatureSchema } =
    await import('@pickchick/contracts');
  const openapi = JSON.parse(
    await readFile(new URL('../../packages/contracts/openapi.json', import.meta.url), 'utf8'),
  );
  const text = JSON.stringify(openapi);
  for (const path of [
    '/internal/v1/edge/station-plans/pull',
    '/internal/v1/edge/station-plans/receipt',
    '/edge/v1/cloud-link',
  ])
    assert.ok(openapi.paths[path], path);
  for (const name of ['combo_component_variant_ids', 'linked_variant_id', 'edgeBackup'])
    assert.ok(text.includes(name), name);
  // The menu feature key is a query key outside the published schemas (pcs handshake).
  assert.equal(EDGE_MENU_FEATURES_QUERY_KEY, 'menu_features');
  assert.deepEqual(EdgeMenuFeatureSchema.options, ['combo_stops']);
});
