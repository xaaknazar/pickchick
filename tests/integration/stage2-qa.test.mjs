// Stage 2 QA (24-25.10.2026): adversarial cross-lane checks on the integrated branch. The cashier
// runtime of this branch meets one API with the combo stop menu (lane pcs) and station plan
// delivery (lane cfg) switched on, first on an edge database still at schema023 (the release
// order installs the runtime before the guarded 024 upgrade), then after 024; an installed
// worker without the menu feature key pulls the same release next to it.
/* global structuredClone */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createApi } from '@pickchick/api';
import { migrate } from '@pickchick/database';
import {
  createQuote,
  openCashShift,
  provisionStaff,
  setOrdering,
  setStop,
} from '@pickchick/local-orders';
import {
  hashJson,
  localCatalogId,
  projectCatalogMenu,
  provisionDevice,
  publishMenu,
  readActiveStationPlan,
  syncMenuOnce,
  syncStationPlanOnce,
} from '@pickchick/menu-sync';
import { MenuPullSchema } from '@pickchick/contracts';
import { mockupCatalogDraft } from '../../packages/catalog-admin/dist/seed.js';
import { provisionCatalogManager } from '../../packages/catalog-admin/dist/index.js';
import { Backoffice, grantBackoffice } from '../../packages/backoffice-core/dist/index.js';
import { withSyncDatabases, running, headersFor, request } from '../helpers/sync.mjs';
import { staffAuth } from '../helpers/orders.mjs';

const FLAG = 'BACKOFFICE_STATION_PLAN_DELIVERY_ENABLED';
const root = fileURLToPath(new URL('../../', import.meta.url));
const fieldsIn = (value) =>
  /combo_component_variant_ids|linked_variant_id/.test(JSON.stringify(value));

/** Owner data the combo rule needs (as in lane pcs): fixed components of pick-combo. */
function ownerCatalog() {
  const catalog = structuredClone(mockupCatalogDraft);
  catalog.products.find((p) => p.id === 'pick-combo').combo_components = [
    { product_id: 'fingers', quantity: 3 },
    { product_id: 'toast', quantity: 1 },
  ];
  return catalog;
}

/** Edge migrations before 024: the cashier database after the pending runtime release. */
async function schema023(run) {
  const dir = await mkdtemp(join(tmpdir(), 'pickchick-edge-qa-023-'));
  try {
    const source = join(root, 'db', 'edge', 'migrations');
    for (const name of await readdir(source))
      if (/^\d{3}_[a-z_]+\.sql$/.test(name) && name < '024')
        await copyFile(join(source, name), join(dir, name));
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('QA: combo stop menu and station plan pull on one cashier before and after edge 024, next to an installed worker', () =>
  schema023((edgeMigrationDirectory) =>
    withSyncDatabases(
      async (c) => {
        const previous = process.env[FLAG];
        process.env[FLAG] = 'true';
        const identity = await provisionDevice(c.cloud.pool, c.device);
        const manager = await provisionCatalogManager(c.cloud.pool, {
          organization_id: c.org,
          name: 'Синтетический управляющий QA',
          branch_ids: [c.branch],
        });
        await grantBackoffice(c.cloud.pool, manager.actor_id, c.branch, 'manager');
        const prep = randomUUID();
        await c.edge.pool.query(
          "INSERT INTO fulfillment_stations(branch_id,id,kind,name) VALUES($1,$2,'prep','Фритюр')",
          [c.branch, prep],
        );
        const menu = projectCatalogMenu(
          ownerCatalog(),
          c.branch,
          1,
          new Date().toISOString(),
          randomUUID(),
          { comboStops: true },
        );
        await publishMenu(c.cloud.pool, menu);
        const api = await running(createApi, {
          ...c.cloud.config,
          backofficeEnabled: true,
          catalogAdminEnabled: true,
        });
        try {
          const bo = new Backoffice(c.cloud.pool, true, { stationPlanDeliveryEnabled: true });
          const command = (value) =>
            bo.command(manager.token, c.branch, {
              request_id: randomUUID(),
              reason: 'Синтетический план станций QA',
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
              edge_station_id: prep,
              active: true,
              product_ids: ['fingers'],
              target_seconds: 240,
            },
          });
          await command({
            type: 'publish',
            kind: 'station',
            id: saved.id,
            expected_revision: saved.revision,
          });

          // 1. New runtime on schema023: the menu with the combo fields applies, the plan step
          //    stays local (no 024 yet) and the cabinet does not claim a delivery.
          assert.deepEqual(await syncMenuOnce(c.edge.pool, c.branch, api.url, identity), {
            state: 'applied',
          });
          assert.deepEqual(await syncStationPlanOnce(c.edge.pool, c.branch, api.url, identity), {
            state: 'schema_missing',
          });
          const stored = (await c.edge.pool.query('SELECT payload, checksum FROM menu_snapshots'))
            .rows[0];
          assert.equal(fieldsIn(stored.payload), true);
          assert.equal(stored.checksum, hashJson(menu));
          let status = (await bo.read(manager.token, c.branch)).station_plan;
          assert.deepEqual(
            [status.plans.map((p) => p.state), status.applied, status.edge],
            [['published'], null, null],
          );

          // The combo rule works on schema023: a stopped fixed component refuses the combo.
          const person = (role, terminal = randomUUID()) => ({
            staff_id: randomUUID(),
            terminal_id: terminal,
            name: 'Synthetic staff',
            role,
          });
          const cashier = await provisionStaff(c.edge.pool, c.branch, person('cashier'));
          const shiftManager = await provisionStaff(
            c.edge.pool,
            c.branch,
            person('shift_manager', cashier.terminal_id),
          );
          await openCashShift(c.edge.pool, c.branch, staffAuth(shiftManager), randomUUID(), {
            opening_cash_minor: '0',
          });
          await setOrdering(c.edge.pool, c.branch, staffAuth(shiftManager), randomUUID(), true, {
            expected_version: 1,
          });
          const variant = (id) => localCatalogId(c.branch, 'base-preview', id);
          const pick = (product, group, option) => ({
            group_id: localCatalogId(c.branch, 'modifier-group', `${product}:${group}`),
            option_id: localCatalogId(c.branch, 'modifier-option', `${product}:${group}:${option}`),
          });
          const combo = {
            release_id: menu.release_id,
            service_mode: 'takeaway',
            items: [
              {
                variant_id: variant('pick-combo'),
                quantity: 1,
                modifiers: [
                  pick('pick-combo', 'drink', 'lemonade'),
                  { ...pick('pick-combo', 'sauce', 'pick'), quantity: 1 },
                ],
              },
            ],
          };
          const quote = () => createQuote(c.edge.pool, c.branch, staffAuth(cashier), combo);
          assert.equal((await quote()).lines.length, 1);
          const stop = await setStop(c.edge.pool, c.branch, staffAuth(shiftManager), randomUUID(), {
            variant_id: variant('fingers'),
            stopped: true,
            expected_version: 0,
            reason: 'Synthetic stop',
          });
          await assert.rejects(quote(), { code: 'ITEM_STOPPED' });

          // 2. An installed worker (no menu_features) pulls the same release without the fields.
          const old = await request(`${api.url}/internal/v1/edge/sync/pull`, {
            headers: headersFor(identity),
          });
          assert.equal(old.status, 200);
          assert.equal(fieldsIn(MenuPullSchema.parse(await old.json())), false);

          // 3. The guarded 024 upgrade (here the plain migration of the same file): the next
          //    cycle applies the plan, the cabinet shows the edge-confirmed version, and the combo
          //    stop and the active menu are untouched.
          await migrate(c.edge.pool, join(root, 'db', 'edge', 'migrations'), 'edge');
          assert.deepEqual(await syncMenuOnce(c.edge.pool, c.branch, api.url, identity), {
            state: 'idle',
          });
          assert.deepEqual(await syncStationPlanOnce(c.edge.pool, c.branch, api.url, identity), {
            state: 'applied',
            version: 1,
          });
          const active = await readActiveStationPlan(c.edge.pool, c.branch);
          assert.deepEqual([active.version, active.plan.stations[0].edge_station_id], [1, prep]);
          status = (await bo.read(manager.token, c.branch)).station_plan;
          assert.equal(status.applied.version, 1);
          await assert.rejects(quote(), { code: 'ITEM_STOPPED' });
          await setStop(c.edge.pool, c.branch, staffAuth(shiftManager), randomUUID(), {
            variant_id: variant('fingers'),
            stopped: false,
            expected_version: stop.version,
            reason: 'Synthetic unstop',
          });
          assert.equal((await quote()).lines.length, 1);
          const ready = await request(`${api.url}/health/ready`);
          assert.equal(ready.status, 200);
          await ready.body?.cancel();
        } finally {
          await api.app.close();
          if (previous === undefined) delete process.env[FLAG];
          else process.env[FLAG] = previous;
        }
      },
      { edgeMigrationDirectory },
    ),
  ));
