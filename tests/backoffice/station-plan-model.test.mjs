// Stage 2 lane cfg: the cabinet shows the station plan version the cashier confirmed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  OperationsModel,
  stationPlanReason,
  stationPlanStatus,
  stationPlanSummary,
} from '../../apps/backoffice/dist/operations-model.js';
import { ApiError } from '../../apps/backoffice/dist/api.js';
import {
  applyStationPlan,
  provisionDevice,
  stationPlanReport,
} from '../../packages/menu-sync/dist/index.js';
import {
  pullStationPlan,
  recordStationPlanReceipt,
} from '../../packages/backoffice-core/dist/index.js';
import { withCatalog, storage } from './helpers.mjs';

const version = (patch = {}) => ({
  id: randomUUID(),
  version: 1,
  published_at: '2026-10-24T08:00:00.000Z',
  stations: 2,
  state: 'published',
  delivered_at: null,
  deliveries: 0,
  reason: null,
  station_id: null,
  station_name: null,
  answered_at: null,
  ...patch,
});
const status = (patch = {}) => ({
  schema_version: 1,
  enabled: true,
  available: true,
  latest: null,
  applied: null,
  edge: null,
  plans: [],
  ...patch,
});

test('an old server without the report keeps the cabinet as before; a malformed report is refused', () => {
  assert.equal(stationPlanStatus(undefined), null);
  assert.equal(stationPlanStatus(null), null);
  for (const bad of [
    'x',
    status({ enabled: 'yes' }),
    status({ plans: {} }),
    status({ latest: version({ state: 'done' }) }),
    status({ latest: version({ version: 0 }) }),
    status({ applied: { id: randomUUID(), version: 'one', applied_at: 'x' } }),
    status({
      edge: {
        active_plan_id: null,
        active_version: null,
        stations: [{ id: randomUUID(), kind: 'drinks', name: 'x' }],
        observed_at: 'x',
      },
    }),
  ])
    assert.throws(
      () => stationPlanStatus(bad),
      (error) => error instanceof ApiError,
    );
});

test('the summary names the cloud publication and the edge-confirmed version separately', () => {
  const parsed = (patch) => stationPlanSummary(stationPlanStatus(status(patch)));
  assert.deepEqual(parsed({ available: false }), {
    tone: 'off',
    title: 'Доставка плана на кассу не установлена на сервере',
    detail: 'Отметка «Опубликовано» означает только версию в облаке.',
    edgeVersion: null,
    canDeliver: false,
  });
  const off = parsed({ enabled: false, applied: { id: 'a', version: 2, applied_at: 'x' } });
  assert.equal(off.tone, 'off');
  assert.equal(off.canDeliver, false);
  assert.match(off.detail, /только версию в облаке\. На кассе действует версия 2\./);
  const empty = parsed({});
  assert.equal(empty.title, 'План ещё не отправлялся на кассу');
  assert.equal(empty.canDeliver, true);
  assert.match(empty.detail, /Касса ещё не подтвердила ни одной версии плана/);

  const published = parsed({ latest: version() });
  assert.equal(published.tone, 'wait');
  assert.equal(published.title, 'Версия 1: опубликовано в облаке, касса ещё не получила');
  assert.equal(published.edgeVersion, null);
  const delivered = parsed({
    latest: version({ version: 3, state: 'delivered' }),
    edge: { active_plan_id: 'p', active_version: 2, stations: [], observed_at: 'x' },
  });
  assert.equal(delivered.title, 'Версия 3: касса получила, ждём подтверждения');
  assert.equal(delivered.detail, 'На кассе действует версия 2.');
  // The receipt confirms at once, before the next edge report catches up.
  const applied = parsed({
    latest: version({ version: 3, state: 'applied' }),
    applied: { id: 'p3', version: 3, applied_at: '2026-10-24T08:05:00.000Z' },
    edge: {
      active_plan_id: 'p2',
      active_version: 2,
      stations: [],
      observed_at: '2026-10-24T08:04:50.000Z',
    },
  });
  assert.deepEqual([applied.tone, applied.edgeVersion], ['good', 3]);
  // A report made after the receipt wins: a cashier restored from a backup serves version 2.
  const restored = parsed({
    latest: version({ version: 3, state: 'applied' }),
    applied: { id: 'p3', version: 3, applied_at: '2026-10-24T08:05:00.000Z' },
    edge: {
      active_plan_id: 'p2',
      active_version: 2,
      stations: [],
      observed_at: '2026-10-24T09:00:00.000Z',
    },
  });
  assert.deepEqual([restored.tone, restored.edgeVersion], ['bad', 2]);
  assert.match(restored.detail, /^На кассе действует версия 2\. После подтверждения касса/);
  const emptied = parsed({
    latest: version({ version: 3, state: 'applied' }),
    applied: { id: 'p3', version: 3, applied_at: '2026-10-24T08:05:00.000Z' },
    edge: {
      active_plan_id: null,
      active_version: null,
      stations: [],
      observed_at: '2026-10-24T09:00:00.000Z',
    },
  });
  assert.deepEqual([emptied.tone, emptied.edgeVersion], ['bad', null]);
  // Reported and confirmed in either order, the same plan is good.
  const caughtUp = parsed({
    latest: version({ version: 3, state: 'applied' }),
    applied: { id: 'p3', version: 3, applied_at: '2026-10-24T08:05:00.000Z' },
    edge: {
      active_plan_id: 'p3',
      active_version: 3,
      stations: [],
      observed_at: '2026-10-24T08:05:10.000Z',
    },
  });
  assert.deepEqual([caughtUp.tone, caughtUp.edgeVersion], ['good', 3]);
  const rejected = parsed({
    latest: version({
      version: 4,
      state: 'rejected',
      reason: 'UNKNOWN_STATION',
      station_name: 'Напитки',
    }),
    applied: { id: 'p3', version: 3, applied_at: 'x' },
  });
  assert.equal(rejected.tone, 'bad');
  assert.equal(
    rejected.detail,
    'Причина: станция кухни не найдена на кассе (станция «Напитки»). Предыдущий план остаётся на кассе. На кассе действует версия 3.',
  );
  // A reason code from a newer cashier is shown as is, never hidden.
  assert.equal(stationPlanReason({ reason: 'FUTURE_REASON', station_name: null }), 'FUTURE_REASON');
  assert.equal(stationPlanReason({ reason: null, station_name: null }), '');
  for (const reason of [
    'SCHEMA_UNSUPPORTED',
    'INVALID_PLAN',
    'VERSION_NOT_NEWER',
    'STATION_KIND_MISMATCH',
  ])
    assert.doesNotMatch(stationPlanReason({ reason, station_name: null }), /^[A-Z_]+$/);
});

test('through the real HTTP proxy the cabinet sees published, then edge-applied versions', () =>
  withCatalog(
    async (c) => {
      const api = async (path, request) => {
        const response = await fetch(`${c.upstream}/v1/admin/backoffice/${path}`, {
          method: request?.method ?? 'GET',
          headers: {
            Authorization: `Bearer ${c.manager.token}`,
            'Content-Type': 'application/json',
          },
          ...(request?.body ? { body: JSON.stringify(request.body) } : {}),
        });
        const body = await response.json();
        if (!response.ok) throw new ApiError(body.code, response.status);
        return body;
      };
      const prep = randomUUID();
      await c.edge.pool.query(
        "INSERT INTO fulfillment_stations(branch_id,id,kind,name) VALUES($1,$2,'prep','Фритюр')",
        [c.branch, prep],
      );
      const identity = await provisionDevice(c.cloud.pool, c.device);
      const auth = { deviceId: identity.device_id, token: identity.token };
      const m = new OperationsModel(api, storage(), () => {});
      await m.load(c.manager.actor_id, c.branch);
      assert.equal(stationPlanSummary(stationPlanStatus(m.data.station_plan)).canDeliver, true);
      assert.equal(m.data.capabilities.edge_configuration_delivery, true);
      // The cashier reports its kitchen stations: the cabinet can offer them for binding.
      await pullStationPlan(c.cloud.pool, auth, {
        ...(await stationPlanReport(c.edge.pool, c.branch)),
        report_only: true,
      });
      await m.load(c.manager.actor_id, c.branch);
      assert.deepEqual(
        stationPlanStatus(m.data.station_plan).edge.stations.map((s) => s.name),
        ['Фритюр'],
      );
      const id = randomUUID();
      assert.equal(
        await m.execute(
          {
            type: 'save',
            kind: 'station',
            id,
            expected_revision: 0,
            payload: {
              name: 'Фритюр',
              role: 'prep',
              device_id: null,
              edge_station_id: prep,
              active: true,
              product_ids: [],
              target_seconds: 180,
            },
          },
          'Синтетическая станция',
        ),
        true,
      );
      assert.equal(
        await m.execute(
          { type: 'publish', kind: 'station', id, expected_revision: 1 },
          'Синтетическая публикация',
        ),
        true,
      );
      let summary = stationPlanSummary(stationPlanStatus(m.data.station_plan));
      assert.equal(summary.title, 'Версия 1: опубликовано в облаке, касса ещё не получила');
      assert.equal(summary.edgeVersion, null);
      const { delivery } = await pullStationPlan(
        c.cloud.pool,
        auth,
        await stationPlanReport(c.edge.pool, c.branch),
      );
      await recordStationPlanReceipt(
        c.cloud.pool,
        auth,
        await applyStationPlan(c.edge.pool, c.branch, delivery),
      );
      await m.load(c.manager.actor_id, c.branch);
      summary = stationPlanSummary(stationPlanStatus(m.data.station_plan));
      assert.deepEqual([summary.tone, summary.edgeVersion], ['good', 1]);
      assert.equal(summary.title, 'Версия 1: применено на кассе');
      // Sending the unchanged plan again is a durable, idempotent command.
      assert.equal(await m.execute({ type: 'deliver_station_plan' }, 'Повторная отправка'), true);
      assert.equal(stationPlanStatus(m.data.station_plan).plans.length, 1);
    },
    { stationPlans: true },
  ));
