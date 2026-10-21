/* global structuredClone */
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { createPool } from '../../packages/database/dist/index.js';
import { localCatalogId } from '../../packages/menu-sync/dist/index.js';
import {
  AvailabilityError,
  assertBranchItemsAvailable,
  branchAvailability,
} from '../../packages/commerce-core/dist/index.js';
import { applyRemoteStops } from '../../packages/local-orders/dist/index.js';
import { CatalogAdmin, provisionCatalogManager } from '../../packages/catalog-admin/dist/index.js';
import {
  Backoffice,
  BackofficeError,
  CloudChannelStops,
  CloudStopError,
  cloudStopOptions,
  grantBackoffice,
  latestCommands,
} from '../../packages/backoffice-core/dist/index.js';
import { pullFulfillment } from '../../packages/fulfillment-transport/dist/index.js';
import { fixture as cloudFixture } from '../../packages/fulfillment-transport/tests/cloud-fixture.mjs';
import { fixture as workerFixture } from '../../packages/fulfillment-transport/tests/worker-fixture.mjs';
import { backofficeGrants } from '../../infra/staging/backoffice-grants.mjs';
import { backofficeStopGrants } from '../../infra/staging/backoffice-stop-grants.mjs';
import { fulfillmentTransportGrants } from '../../infra/staging/fulfillment-transport-grants.mjs';
import { fulfillmentWorkerGrants } from '../../infra/windows/fulfillment-worker-grants.mjs';
import {
  cloudChannelAvailabilityGrants,
  cloudChannelStopGrants,
} from '../../infra/staging/cloud-channel-stop-grants.mjs';
import { syncFulfillmentOnce } from '../../packages/fulfillment-transport/dist/index.js';

// ADR-0014 S3 (cloud055): cloud channel stops, override of a stale cashier stop, durable
// back-office unstop for the cashier and the KITCHEN_OFFLINE gate of branches in mode 'cloud'.

const reasonOf = (code, detail) => (error) =>
  error instanceof CloudStopError && error.code === code && error.detail === detail;
const sqlCode = (expected) => (error) => error.code === expected;
const BURGER = { productId: 'burger', selections: [] };

async function publishCatalog(pool, token, branch) {
  const catalog = new CatalogAdmin(pool, { enabled: true });
  let state = await catalog.seed(token, branch, { expected_revision: 0, request_id: randomUUID() });
  const payload = structuredClone(state.draft.payload);
  payload.content_reviewed = true;
  state = await catalog.save(token, branch, {
    expected_revision: state.draft.revision,
    request_id: randomUUID(),
    payload,
  });
  await catalog.publish(token, branch, {
    expected_revision: state.draft.revision,
    expected_published_version: 0,
    request_id: randomUUID(),
    confirmation: 'publish_catalog',
  });
}

function stopFixture(run) {
  return cloudFixture(async (f) => {
    const branch = f.scope.branchId;
    const manager = await provisionCatalogManager(f.pool, {
      organization_id: f.scope.organizationId,
      name: 'Synthetic shift lead',
      branch_ids: [branch],
    });
    const second = await provisionCatalogManager(f.pool, {
      organization_id: f.scope.organizationId,
      name: 'Synthetic second manager',
      branch_ids: [branch],
    });
    const analyst = await provisionCatalogManager(f.pool, {
      organization_id: f.scope.organizationId,
      name: 'Synthetic analyst',
      branch_ids: [branch],
    });
    await grantBackoffice(f.pool, manager.actor_id, branch, 'manager');
    await grantBackoffice(f.pool, second.actor_id, branch, 'manager');
    await grantBackoffice(f.pool, analyst.actor_id, branch, 'analyst');
    await publishCatalog(f.pool, manager.token, branch);
    const prep = randomUUID(),
      assembly = randomUUID();
    for (const [id, kind] of [
      [prep, 'prep'],
      [assembly, 'assembly'],
    ])
      await f.pool.query(
        "INSERT INTO cloud_kitchen_stations(branch_id,id,kind,name) VALUES($1,$2,$3,'Synthetic')",
        [branch, id, kind],
      );
    let revision = 0;
    /** One cashier heartbeat (protocol 4), exactly as the Windows worker sends it. */
    const heartbeat = (body = {}) =>
      pullFulfillment(f.pool, f.auth, {
        workerId: f.workerId,
        leaseSeconds: 15,
        availability: { revision: String(++revision), stoppedIds: body.stoppedIds ?? [] },
        protocolVersion: 4,
        stopStates: body.stopStates ?? [],
        ...(body.stopReceipts ? { stopReceipts: body.stopReceipts } : {}),
      });
    /** The cashier goes quiet: its last observation becomes older than the 30 s window. */
    const staleCashier = (seconds = 60) =>
      f.pool.query(
        "UPDATE cloud_branch_availability SET observed_at=observed_at-$1*interval '1 second'",
        [seconds],
      );
    /** Kitchen screens polling the cloud feed (cloud054 presence), seconds ago. */
    const poll = async (station, secondsAgo = 0) =>
      f.pool.query(
        `INSERT INTO cloud_kitchen_station_presence(branch_id,device_id,station_id,seen_at)
        VALUES($1,$2,$3,clock_timestamp()-$4*interval '1 second')`,
        [branch, randomUUID(), station, secondsAgo],
      );
    const setMode = (owner) =>
      f.pool.query("SELECT cloud_kitchen_set_mode($1,$2,'synthetic-owner','Synthetic switch')", [
        branch,
        owner,
      ]);
    const options = { enabled: true, cloudStopsEnabled: true, remoteStopsEnabled: true };
    const service = new CloudChannelStops(f.pool, options);
    const variant = (product, group, option) =>
      group
        ? localCatalogId(branch, 'modifier-option', `${product}:${group}:${option}`)
        : localCatalogId(branch, 'base-preview', product);
    const cloudStop = (patch = {}) => ({
      request_id: randomUUID(),
      catalog_ref: { product_id: 'burger' },
      stopped: true,
      duration: 'manual',
      reason: 'Закончились булочки',
      expected_version: 0,
      ...patch,
    });
    const override = (patch = {}) => ({
      request_id: randomUUID(),
      catalog_ref: { product_id: 'burger' },
      expected_version: 3,
      reason: 'Касса выключена, булочки привезли',
      ...patch,
    });
    const cashierStop = (id, version = 3) => ({
      stoppedIds: [id],
      stopStates: [
        { id, version, stopped: true, source: 'pos', expiresAt: null, shiftScoped: false },
      ],
    });
    const gate = (items = [BURGER]) => assertBranchItemsAvailable(f.pool, branch, items);
    const gateFails = (code, items) =>
      assert.rejects(gate(items), (e) => e instanceof AvailabilityError && e.code === code);
    await run({
      ...f,
      branch,
      manager,
      second,
      analyst,
      prep,
      assembly,
      heartbeat,
      staleCashier,
      poll,
      setMode,
      options,
      service,
      variant,
      cloudStop,
      override,
      cashierStop,
      gate,
      gateFails,
    });
  });
}
/** Simulated clock for stop commands: the 048 guard owns created_at/expires_at. */
async function age(pool, id, seconds) {
  await pool.query('ALTER TABLE cloud_stop_commands DISABLE TRIGGER cloud_stop_command_guard');
  try {
    await pool.query(
      `UPDATE cloud_stop_commands SET created_at=created_at-$2*interval '1 second',expires_at=expires_at-$2*interval '1 second',
      delivered_at=delivered_at-$2*interval '1 second' WHERE id=$1`,
      [id, seconds],
    );
  } finally {
    await pool.query('ALTER TABLE cloud_stop_commands ENABLE TRIGGER cloud_stop_command_guard');
  }
}

test('BACKOFFICE_CLOUD_STOPS_ENABLED and the other flags default off and accept only true/false', () => {
  assert.deepEqual(cloudStopOptions({}), {
    enabled: false,
    cloudStopsEnabled: false,
    remoteStopsEnabled: false,
  });
  assert.equal(
    cloudStopOptions({ BACKOFFICE_CLOUD_STOPS_ENABLED: 'true' }).cloudStopsEnabled,
    true,
  );
  for (const value of ['1', 'TRUE', 'yes', ''])
    assert.throws(() => cloudStopOptions({ BACKOFFICE_CLOUD_STOPS_ENABLED: value }));
});

test('cloud stops: versioned, audited, idempotent, manager-only, events append-only', () =>
  stopFixture(async (f) => {
    const off = new CloudChannelStops(f.pool, { enabled: true });
    await assert.rejects(
      off.setStop(f.manager.token, f.branch, f.cloudStop()),
      reasonOf('SERVICE_UNAVAILABLE', 'CLOUD_STOPS_DISABLED'),
    );
    await assert.rejects(
      f.service.setStop(f.analyst.token, f.branch, f.cloudStop()),
      (e) => e instanceof BackofficeError && e.code === 'FORBIDDEN',
    );
    await assert.rejects(
      f.service.setStop('0'.repeat(64), f.branch, f.cloudStop()),
      /UNAUTHORIZED/,
    );
    for (const invalid of [
      { duration: 'shift' },
      { stopped: false, duration: 'hour' },
      { reason: ' x ' },
      { expected_version: -1 },
      { catalog_ref: { product_id: 'burger', group_id: 'x' } },
      { extra: true },
    ])
      await assert.rejects(
        f.service.setStop(f.manager.token, f.branch, f.cloudStop(invalid)),
        /INVALID_REQUEST/,
      );
    await assert.rejects(
      f.service.setStop(
        f.manager.token,
        f.branch,
        f.cloudStop({ catalog_ref: { product_id: 'no-such' } }),
      ),
      reasonOf('NOT_FOUND', 'CATALOG_ITEM_NOT_FOUND'),
    );
    const request = f.cloudStop({ duration: 'hour' });
    const first = await f.service.setStop(f.manager.token, f.branch, request);
    assert.equal(first.variant_id, f.variant('burger'));
    assert.equal(first.version, 1);
    assert.equal(first.stopped, true);
    assert.equal(first.effective, true);
    assert.equal(Date.parse(first.expires_at) - Date.parse(first.updated_at), 3600000);
    // Replay returns the stored result; another body under the same id conflicts.
    assert.deepEqual(await f.service.setStop(f.manager.token, f.branch, request), first);
    await assert.rejects(
      f.service.setStop(f.manager.token, f.branch, { ...request, reason: 'Другая причина' }),
      (e) => e instanceof BackofficeError && e.code === 'CONFLICT',
    );
    // Stale expected version: no last-write-wins.
    await assert.rejects(
      f.service.setStop(f.manager.token, f.branch, f.cloudStop({ stopped: false })),
      reasonOf('CONFLICT', 'VERSION_MISMATCH'),
    );
    // Concurrent writers at the same version: exactly one wins.
    const results = await Promise.allSettled(
      [f.manager, f.second, f.manager, f.second].map((actor, i) =>
        f.service.setStop(
          actor.token,
          f.branch,
          f.cloudStop({ stopped: i % 2 === 0, expected_version: 1 }),
        ),
      ),
    );
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    for (const r of results.filter((x) => x.status === 'rejected'))
      assert.ok(reasonOf('CONFLICT', 'VERSION_MISMATCH')(r.reason), String(r.reason));
    const unstop = await f.service.setStop(
      f.manager.token,
      f.branch,
      f.cloudStop({ stopped: false, expected_version: 2 }),
    );
    assert.equal(unstop.version, 3);
    assert.equal(unstop.expires_at, null);
    // An option is its own POS identity.
    const option = await f.service.setStop(
      f.manager.token,
      f.branch,
      f.cloudStop({
        catalog_ref: { product_id: 'pick-combo', group_id: 'drink', option_id: 'cola-bottle' },
      }),
    );
    assert.equal(option.variant_id, f.variant('pick-combo', 'drink', 'cola-bottle'));
    const events = (
      await f.pool.query(
        'SELECT version,stopped,duration,reason,actor_label FROM cloud_channel_stop_events WHERE variant_id=$1 ORDER BY version',
        [first.variant_id],
      )
    ).rows;
    assert.deepEqual(
      events.map((e) => e.version),
      [1, 2, 3],
    );
    assert.equal(events[0].duration, 'hour');
    const audit = (
      await f.pool.query(
        "SELECT action,entity_id,reason,before_value,after_value FROM bo_audit WHERE action LIKE 'cloud_stop:%' ORDER BY created_at",
      )
    ).rows;
    assert.deepEqual(
      audit.map((a) => a.action),
      [
        'cloud_stop:stop',
        'cloud_stop:' + (events[1].stopped ? 'stop' : 'unstop'),
        'cloud_stop:unstop',
        'cloud_stop:stop',
      ],
    );
    assert.equal(audit[0].before_value, null);
    assert.equal(audit[0].reason, 'Закончились булочки');
    assert.equal(audit[2].before_value.version, 2);
    for (const sql of [
      'DELETE FROM cloud_channel_stops',
      'UPDATE cloud_channel_stops SET version=version+2',
      'UPDATE cloud_channel_stops SET variant_id=gen_random_uuid()',
      "UPDATE cloud_channel_stop_events SET reason='Подмена'",
      'DELETE FROM cloud_channel_stop_events',
    ])
      await assert.rejects(f.pool.query(sql), sqlCode('23514'), sql);
    await assert.rejects(
      f.pool.query(
        `INSERT INTO cloud_channel_stops(organization_id,branch_id,variant_id,catalog_ref,stopped,duration,reason,version,actor_id,actor_label)
        VALUES($1,$2,$3,'toast',true,'manual','Synthetic',5,$4,'x')`,
        [f.scope.organizationId, f.branch, randomUUID(), f.manager.actor_id],
      ),
      sqlCode('23514'),
    );
    // Read model: the next expected version and the effective cloud verdict per entry.
    const view = await f.service.read(f.analyst.token, f.branch);
    const burger = view.items.find((i) => i.catalog_ref.product_id === 'burger');
    assert.equal(burger.cloud_version, 3);
    assert.equal(burger.cloud_stop.stopped, false);
    assert.equal(view.cloud_stops.writable, false);
    assert.equal((await f.service.read(f.manager.token, f.branch)).cloud_stops.writable, true);
  }));

test('mode edge is unchanged: cloud stops and kitchen presence do not affect it', () =>
  stopFixture(async (f) => {
    await f.heartbeat();
    await f.service.setStop(f.manager.token, f.branch, f.cloudStop());
    assert.deepEqual(await branchAvailability(f.pool, f.branch), { fresh: true, stoppedIds: [] });
    await f.gate();
    await f.staleCashier();
    await f.poll(f.prep);
    await f.poll(f.assembly);
    await f.gateFails('AVAILABILITY_STALE');
    assert.deepEqual(await branchAvailability(f.pool, f.branch), { fresh: false, stoppedIds: [] });
    // An explicit 'edge' row (switched back) behaves the same.
    await f.setMode('cloud');
    await f.setMode('edge');
    await f.gateFails('AVAILABILITY_STALE');
  }));

test('mode cloud: KITCHEN_OFFLINE gate, stale cashier allowed, both stop sources block', () =>
  stopFixture(async (f) => {
    await f.setMode('cloud');
    // No cashier at all and no kitchen: closed by the kitchen gate, not by the cashier.
    await f.gateFails('KITCHEN_OFFLINE');
    await f.poll(f.prep);
    await f.gateFails('KITCHEN_OFFLINE');
    await f.poll(f.assembly, 31);
    await f.gateFails('KITCHEN_OFFLINE');
    await f.poll(f.assembly, 5);
    await f.gate();
    assert.deepEqual(await branchAvailability(f.pool, f.branch), {
      fresh: true,
      stoppedIds: [],
      mode: 'cloud',
    });
    // Cashier offline for minutes: irrelevant for the cloud gate.
    await f.heartbeat();
    await f.staleCashier(600);
    await f.gate();
    // The last known cashier stop still blocks (fail closed) ...
    await f.heartbeat(f.cashierStop(f.variant('burger')));
    await f.staleCashier(600);
    await f.gateFails('ITEM_STOPPED');
    await f.gate([{ productId: 'toast', selections: [] }]);
    // ... and so does a cloud stop of an option.
    await f.service.setStop(
      f.manager.token,
      f.branch,
      f.cloudStop({
        catalog_ref: { product_id: 'pick-combo', group_id: 'drink', option_id: 'cola-bottle' },
      }),
    );
    await f.gateFails('ITEM_STOPPED', [
      { productId: 'pick-combo', selections: [{ group_id: 'drink', option_id: 'cola-bottle' }] },
    ]);
    await f.gate([{ productId: 'pick-combo', selections: [] }]);
    // A cloud hour stop that ran out no longer blocks.
    const toast = await f.service.setStop(
      f.manager.token,
      f.branch,
      f.cloudStop({ catalog_ref: { product_id: 'toast' }, duration: 'hour' }),
    );
    await f.gateFails('ITEM_STOPPED', [{ productId: 'toast', selections: [] }]);
    await f.pool.query('ALTER TABLE cloud_channel_stops DISABLE TRIGGER USER');
    await f.pool.query(
      "UPDATE cloud_channel_stops SET expires_at=clock_timestamp()-interval '1 second' WHERE variant_id=$1",
      [toast.variant_id],
    );
    await f.pool.query('ALTER TABLE cloud_channel_stops ENABLE TRIGGER USER');
    await f.gate([{ productId: 'toast', selections: [] }]);
    // Stops are checked before the gate: a stopped item stays ITEM_STOPPED when the kitchen is
    // offline too, as in mode edge.
    await f.pool.query('DELETE FROM cloud_kitchen_station_presence');
    await f.gateFails('ITEM_STOPPED');
    await f.gateFails('KITCHEN_OFFLINE', [{ productId: 'toast', selections: [] }]);
  }));

test('override of a stale cashier stop: cloud channels only, audited, lapses on reconnect', () =>
  stopFixture(async (f) => {
    await f.setMode('cloud');
    await f.poll(f.prep);
    await f.poll(f.assembly);
    const burger = f.variant('burger');
    await f.heartbeat(f.cashierStop(burger));
    await assert.rejects(
      f.service.overrideCashierStop(f.manager.token, f.branch, f.override()),
      reasonOf('CONFLICT', 'CASHIER_ONLINE'),
    );
    await f.staleCashier();
    await assert.rejects(
      f.service.overrideCashierStop(f.analyst.token, f.branch, f.override()),
      (e) => e instanceof BackofficeError && e.code === 'FORBIDDEN',
    );
    await assert.rejects(
      new CloudChannelStops(f.pool, { enabled: true }).overrideCashierStop(
        f.manager.token,
        f.branch,
        f.override(),
      ),
      reasonOf('SERVICE_UNAVAILABLE', 'CLOUD_STOPS_DISABLED'),
    );
    await assert.rejects(
      f.service.overrideCashierStop(f.manager.token, f.branch, f.override({ expected_version: 2 })),
      reasonOf('CONFLICT', 'CASHIER_VERSION_MISMATCH'),
    );
    await assert.rejects(
      f.service.overrideCashierStop(
        f.manager.token,
        f.branch,
        f.override({ catalog_ref: { product_id: 'toast' } }),
      ),
      reasonOf('NOT_FOUND', 'CASHIER_STOP_NOT_FOUND'),
    );
    await f.gateFails('ITEM_STOPPED');
    const request = f.override();
    const created = await f.service.overrideCashierStop(f.manager.token, f.branch, request);
    assert.equal(created.variant_id, burger);
    assert.equal(created.edge_version, 3);
    assert.equal(created.cashier_command, null);
    assert.deepEqual(
      await f.service.overrideCashierStop(f.manager.token, f.branch, request),
      created,
    );
    await assert.rejects(
      f.service.overrideCashierStop(f.manager.token, f.branch, f.override()),
      reasonOf('CONFLICT', 'OVERRIDE_ACTIVE'),
    );
    // Sold again in the cloud channels; the cashier stop itself is untouched.
    await f.gate();
    assert.deepEqual(
      (await f.pool.query('SELECT stopped_ids FROM cloud_branch_availability')).rows[0].stopped_ids,
      [burger],
    );
    assert.equal(
      await f.pool.query('SELECT 1 FROM cloud_stop_commands').then((r) => r.rowCount),
      0,
    );
    const audit = (
      await f.pool.query("SELECT * FROM bo_audit WHERE action='cloud_stop:override_cashier'")
    ).rows;
    assert.equal(audit.length, 1);
    assert.equal(audit[0].entity_id, created.override_id);
    assert.equal(audit[0].reason, 'Касса выключена, булочки привезли');
    assert.equal(audit[0].before_value.version, 3);
    const view = await f.service.read(f.manager.token, f.branch);
    const item = view.items.find((i) => i.variant_id === burger);
    assert.equal(item.override.override_id, created.override_id);
    assert.equal(item.cashier_stop.stopped, true);
    assert.equal(item.cloud_sales_blocked, false);
    assert.equal(view.kitchen.online, true);
    assert.equal(view.mode, 'cloud');
    // Not for mode edge: the override never touches the cashier channel's own verdict.
    await f.setMode('edge');
    await f.gateFails('ITEM_STOPPED');
    await f.setMode('cloud');
    await f.gate();
    // Immutable, and only against the current stale observation (DB guard as well).
    for (const sql of [
      'UPDATE cloud_stale_stop_overrides SET reason=$1',
      'DELETE FROM cloud_stale_stop_overrides',
    ])
      await assert.rejects(f.pool.query(sql.replace('$1', "'x'")), sqlCode('23514'));
    // The cashier comes back still reporting the stop: the override lapses (fail closed).
    await f.heartbeat(f.cashierStop(burger));
    await f.gateFails('ITEM_STOPPED');
    assert.equal(
      (await f.service.read(f.manager.token, f.branch)).items.find((i) => i.variant_id === burger)
        .override,
      null,
    );
    await assert.rejects(
      f.pool.query(
        `INSERT INTO cloud_stale_stop_overrides(id,organization_id,branch_id,variant_id,catalog_ref,edge_device_id,edge_version,edge_observed_at,reason,actor_id,actor_label)
        SELECT $1,$2,$3,$4,'burger',device_id,3,observed_at,'Synthetic',$5,'x' FROM cloud_branch_availability`,
        [randomUUID(), f.scope.organizationId, f.branch, burger, f.manager.actor_id],
      ),
      sqlCode('23514'),
    );
  }));

test('durable cashier unstop: pending while offline, delivered on reconnect, conflict shown', () =>
  stopFixture(async (f) => {
    await f.setMode('cloud');
    await f.poll(f.prep);
    await f.poll(f.assembly);
    const burger = f.variant('burger');
    await f.heartbeat(f.cashierStop(burger));
    await f.staleCashier();
    await assert.rejects(
      new CloudChannelStops(f.pool, { enabled: true, cloudStopsEnabled: true }).overrideCashierStop(
        f.manager.token,
        f.branch,
        f.override({ include_cashier: true }),
      ),
      reasonOf('SERVICE_UNAVAILABLE', 'REMOTE_STOPS_DISABLED'),
    );
    const created = await f.service.overrideCashierStop(
      f.manager.token,
      f.branch,
      f.override({ include_cashier: true }),
    );
    const id = created.cashier_command.command_id;
    assert.equal(created.cashier_command.awaits_reconnect, true);
    const row = (await f.pool.query('SELECT * FROM cloud_stop_commands WHERE id=$1', [id])).rows[0];
    assert.equal(row.delivery_policy, 'until_reconnect');
    assert.equal(row.stopped, false);
    assert.equal(row.expected_version, 3);
    assert.equal(row.reason, 'Касса выключена, булочки привезли');
    assert.deepEqual(
      (
        await f.pool.query(
          "SELECT action,entity_id FROM bo_audit WHERE action IN ('cloud_stop:override_cashier','remote_stop:unstop') ORDER BY action",
        )
      ).rows.map((a) => [a.action, a.entity_id]),
      [
        ['cloud_stop:override_cashier', created.override_id],
        ['remote_stop:unstop', id],
      ],
    );
    // The cloud channels sell at once.
    await f.gate();
    // Offline far beyond 120 s + grace: still pending, still the one open command.
    await age(f.pool, id, 3600);
    const bo = new Backoffice(f.pool, true, { remoteStopsEnabled: true });
    await assert.rejects(
      bo.requestStop(f.manager.token, f.branch, {
        request_id: randomUUID(),
        catalog_ref: { product_id: 'burger' },
        stopped: false,
        duration: 'manual',
        reason: 'Повторное снятие',
        expected_version: 3,
      }),
      (e) => e instanceof BackofficeError && e.reason === 'STOP_COMMAND_IN_PROGRESS',
    );
    let view = (await f.service.read(f.manager.token, f.branch)).items.find(
      (i) => i.variant_id === burger,
    );
    assert.equal(view.cashier_command.pending.command_id, id);
    assert.equal(view.cashier_command.pending.awaits_reconnect, true);
    assert.equal(view.cashier_command.pending.expires_at, null);
    const v2 = (await bo.stops(f.manager.token, f.branch)).items.find(
      (i) => i.variant_id === burger,
    );
    assert.equal(v2.pending.command_id, id);
    // The cloud never lapses it before the cashier has seen it.
    await assert.rejects(
      f.pool.query(
        "UPDATE cloud_stop_commands SET state='expired',resolved_at=clock_timestamp() WHERE id=$1",
        [id],
      ),
      sqlCode('23514'),
    );
    await assert.rejects(
      f.pool.query("UPDATE cloud_stop_commands SET delivery_policy='ttl' WHERE id=$1", [id]),
      sqlCode('23514'),
    );
    // A TTL command of another variant offline as long lapses as before.
    const toast = f.variant('toast');
    const ttl = randomUUID();
    await f.pool.query(
      `INSERT INTO cloud_stop_commands(id,organization_id,branch_id,variant_id,catalog_ref,stopped,duration,reason,expected_version,actor_id,actor_label)
      VALUES($1,$2,$3,$4,'toast',true,'manual','Synthetic',0,$5,'Synthetic')`,
      [ttl, f.scope.organizationId, f.branch, toast, f.manager.actor_id],
    );
    await age(f.pool, ttl, 3600);
    // Reconnect: the heartbeat delivers the durable unstop, the TTL one is closed as expired.
    const response = await f.heartbeat(f.cashierStop(burger));
    assert.deepEqual(
      response.stopCommands.map((c) => [c.commandId, c.stopped, c.expectedVersion]),
      [[id, false, 3]],
    );
    const states = Object.fromEntries(
      (await f.pool.query('SELECT id,state FROM cloud_stop_commands')).rows.map((r) => [
        r.id,
        r.state,
      ]),
    );
    assert.deepEqual(states, { [id]: 'delivered', [ttl]: 'expired' });
    // Delivered but unanswered (cashier dropped again): redelivered, never lapsed by the cloud.
    await age(f.pool, id, 3600);
    const again = await f.heartbeat(f.cashierStop(burger));
    assert.deepEqual(
      again.stopCommands.map((c) => c.commandId),
      [id],
    );
    // Meanwhile the cashier changed the stop itself (version 4): edge verdict conflict.
    await f.heartbeat({
      ...f.cashierStop(burger, 4),
      stopReceipts: [{ commandId: id, result: 'conflict', version: 4 }],
    });
    const resolved = (await f.pool.query('SELECT * FROM cloud_stop_commands WHERE id=$1', [id]))
      .rows[0];
    assert.equal(resolved.state, 'conflict');
    assert.equal(resolved.result_version, 4);
    view = (await f.service.read(f.manager.token, f.branch)).items.find(
      (i) => i.variant_id === burger,
    );
    assert.equal(view.cashier_command.pending, null);
    assert.equal(view.cashier_command.last_result.state, 'conflict');
    assert.equal(view.cashier_command.last_result.result_version, 4);
    // New observation: the override lapsed, the cashier's own stop is authoritative again.
    assert.equal(view.override, null);
    assert.equal(view.cloud_sales_blocked, true);
    await f.gateFails('ITEM_STOPPED');
  }));

test('production-shaped grants: back-office writes cloud stops, sales runtime only reads', () =>
  stopFixture(async (f) => {
    const bo = 'bo_cloud_stops_' + randomUUID().replaceAll('-', '').slice(0, 20);
    const sales = 'sales_cloud_' + randomUUID().replaceAll('-', '').slice(0, 20);
    const pools = [];
    const roleUrl = (role) => {
      const url = new URL(f.url);
      url.searchParams.set('options', `-c search_path=${f.schema} -c role=${role}`);
      return url.toString();
    };
    for (const role of [bo, sales])
      await f.admin.query(
        `CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
      );
    try {
      for (const role of [bo, sales])
        await f.pool.query(`GRANT USAGE ON SCHEMA ${f.schema} TO ${role}`);
      // Same order as infra/staging/provision.mjs for the back-office role.
      await f.pool.query(fulfillmentTransportGrants(bo, true));
      await f.pool.query(backofficeGrants(bo, true));
      await f.pool.query(backofficeStopGrants(bo, true));
      await f.pool.query(cloudChannelStopGrants(bo, true));
      // Sales runtime: the edge availability inputs (as the transport grants give them) only.
      await f.pool.query(fulfillmentTransportGrants(sales, true));
      await f.pool.query(`GRANT SELECT ON devices TO ${sales}`);
      const boPool = createPool(roleUrl(bo), 4),
        salesPool = createPool(roleUrl(sales), 4);
      pools.push(boPool, salesPool);
      const service = new CloudChannelStops(boPool, f.options);
      await f.setMode('cloud');
      await f.poll(f.prep);
      await f.poll(f.assembly);
      const burger = f.variant('burger');
      await f.heartbeat(f.cashierStop(burger));
      await f.staleCashier();
      const stop = await service.setStop(
        f.manager.token,
        f.branch,
        f.cloudStop({ catalog_ref: { product_id: 'toast' } }),
      );
      await service.setStop(
        f.manager.token,
        f.branch,
        f.cloudStop({ catalog_ref: { product_id: 'toast' }, stopped: false, expected_version: 1 }),
      );
      const created = await service.overrideCashierStop(
        f.manager.token,
        f.branch,
        f.override({ include_cashier: true }),
      );
      assert.equal(created.cashier_command.awaits_reconnect, true);
      const view = await service.read(f.manager.token, f.branch);
      assert.equal(view.kitchen.online, true);
      for (const sql of [
        'DELETE FROM cloud_channel_stops',
        "UPDATE cloud_channel_stops SET updated_at=now() - interval '1 day'",
        'UPDATE cloud_channel_stops SET branch_id=branch_id',
        "UPDATE cloud_channel_stop_events SET reason='x'",
        'DELETE FROM cloud_stale_stop_overrides',
        "UPDATE cloud_stop_commands SET delivery_policy='ttl'",
        "UPDATE branch_channel_modes SET cloud_channels_owner='edge'",
        'INSERT INTO cloud_kitchen_station_presence SELECT * FROM cloud_kitchen_station_presence',
      ])
        await assert.rejects(boPool.query(sql), sqlCode('42501'), sql);
      assert.equal(stop.version, 1);

      // Without the cloud read grants a branch in mode 'cloud' cannot be checked: it is
      // treated as mode 'edge' (no mode grant), so the stale cashier closes the sale.
      await assert.rejects(
        assertBranchItemsAvailable(salesPool, f.branch, [{ productId: 'toast', selections: [] }]),
        (e) => e.code === 'AVAILABILITY_STALE',
      );
      // Mode readable but the other inputs not: the gate stays closed (fail closed).
      await f.pool.query(`GRANT SELECT ON branch_channel_modes TO ${sales}`);
      await assert.rejects(
        assertBranchItemsAvailable(salesPool, f.branch, [{ productId: 'toast', selections: [] }]),
        (e) => e.code === 'KITCHEN_OFFLINE',
      );
      await f.pool.query(cloudChannelAvailabilityGrants(sales, true));
      await assertBranchItemsAvailable(salesPool, f.branch, [BURGER]);
      await assertBranchItemsAvailable(salesPool, f.branch, [
        { productId: 'toast', selections: [] },
      ]);
      assert.deepEqual(await branchAvailability(salesPool, f.branch), {
        fresh: true,
        stoppedIds: [],
        mode: 'cloud',
      });
      for (const sql of [
        'INSERT INTO cloud_channel_stops SELECT * FROM cloud_channel_stops',
        'UPDATE cloud_channel_stops SET stopped=true',
        'DELETE FROM cloud_stale_stop_overrides',
      ])
        await assert.rejects(salesPool.query(sql), sqlCode('42501'), sql);
      // Revoked again: the override is no longer visible, the cashier stop blocks, the rest
      // waits for a kitchen gate that cannot be checked.
      await f.pool.query(cloudChannelAvailabilityGrants(sales, false));
      await assert.rejects(
        assertBranchItemsAvailable(salesPool, f.branch, [BURGER]),
        (e) => e.code === 'ITEM_STOPPED',
      );
      await assert.rejects(
        assertBranchItemsAvailable(salesPool, f.branch, [{ productId: 'toast', selections: [] }]),
        (e) => e.code === 'KITCHEN_OFFLINE',
      );
    } finally {
      for (const pool of pools) await pool.end();
      for (const role of [bo, sales]) {
        await f.pool.query(`DROP OWNED BY ${role}`);
        await f.admin.query(`DROP ROLE ${role}`);
      }
    }
  }));

/** Edge end to end: the real Windows worker role and the edge applier (019) unchanged. */
async function activeEdgeStop(f, version) {
  const { applyMenu, hashJson } = await import('../../packages/menu-sync/dist/index.js');
  const { fixtureMenu } = await import('../../packages/test-fixtures/dist/index.js');
  const menu = { ...fixtureMenu, release_id: randomUUID(), branch_id: f.scope.branchId };
  await applyMenu(f.pool, f.scope.branchId, {
    event_id: randomUUID(),
    producer_id: randomUUID(),
    producer_sequence: '1',
    branch_id: f.scope.branchId,
    aggregate_type: 'menu_release',
    aggregate_id: menu.release_id,
    aggregate_version: 1,
    schema_version: 1,
    event_type: 'menu.published',
    payload: { menu, checksum: hashJson(menu) },
    occurred_at: new Date().toISOString(),
    correlation_id: randomUUID(),
    causation_id: null,
  });
  const variant = menu.items[0].variant_id;
  await f.pool.query(
    "INSERT INTO local_stops(branch_id,variant_id,stopped,version,reason) VALUES($1,$2,true,$3,'Cashier stop')",
    [f.scope.branchId, variant, version],
  );
  return variant;
}
async function durableUnstop(f, variant, expectedVersion) {
  const actor = randomUUID(),
    id = randomUUID();
  await f.cloud.query(
    "INSERT INTO catalog_managers(id,organization_id,name,token_hash) VALUES($1,$2,'Synthetic manager',$3)",
    [actor, f.scope.organizationId, randomBytes(32).toString('hex')],
  );
  await f.cloud.query(
    `INSERT INTO cloud_stop_commands(id,organization_id,branch_id,variant_id,catalog_ref,stopped,duration,reason,expected_version,actor_id,actor_label,delivery_policy)
    VALUES($1,$2,$3,$4,'burger',false,'manual','Synthetic unstop',$5,$6,'Synthetic manager','until_reconnect')`,
    [id, f.scope.organizationId, f.scope.branchId, variant, expectedVersion, actor],
  );
  return id;
}
async function workerRole(f, run) {
  const role = 'transport_' + randomUUID().replaceAll('-', '');
  const schema = (await f.pool.query('SELECT current_schema() AS name')).rows[0].name;
  await f.pool.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
  let pool;
  try {
    await f.pool.query(fulfillmentWorkerGrants(role, schema, { remoteStops: true }));
    const url = new URL(f.url);
    url.searchParams.set('options', `-c search_path=${schema} -c role=${role}`);
    pool = createPool(url.toString(), 4);
    await run(() => syncFulfillmentOnce(pool, { ...f.options, protocolVersion: 4 }));
  } finally {
    if (pool) await pool.end();
    await f.pool.query(`DROP OWNED BY ${role}; DROP ROLE ${role}`);
  }
}
const cloudState = async (f, id) =>
  (await f.cloud.query('SELECT state,result_version FROM cloud_stop_commands WHERE id=$1', [id]))
    .rows[0];

test('edge e2e: a durable unstop issued an hour before reconnect is applied by edge 019', () =>
  workerFixture(async (f) => {
    const variant = await activeEdgeStop(f, 3);
    const id = await durableUnstop(f, variant, 3);
    await age(f.cloud, id, 3600);
    await workerRole(f, async (tick) => {
      await tick();
      assert.equal((await cloudState(f, id)).state, 'delivered');
      assert.deepEqual(await applyRemoteStops(f.pool, f.scope.branchId), [
        { commandId: id, state: 'applied', version: 4 },
      ]);
      await tick();
      assert.deepEqual(await cloudState(f, id), { state: 'applied', result_version: 4 });
      assert.deepEqual((await branchAvailability(f.cloud, f.scope.branchId)).stoppedIds, []);
      const event = (
        await f.pool.query('SELECT source,command_id,stopped,version FROM local_stop_events')
      ).rows;
      assert.deepEqual(event, [
        { source: 'backoffice', command_id: id, stopped: false, version: 4 },
      ]);
    });
  }));

test('edge e2e: the cashier changed the stop while offline, the durable unstop is a conflict', () =>
  workerFixture(async (f) => {
    const variant = await activeEdgeStop(f, 3);
    const id = await durableUnstop(f, variant, 3);
    await age(f.cloud, id, 3600);
    // The cashier re-stopped the item locally (version 4) before the link came back.
    await f.pool.query('UPDATE local_stops SET version=4 WHERE variant_id=$1', [variant]);
    await workerRole(f, async (tick) => {
      await tick();
      assert.deepEqual(await applyRemoteStops(f.pool, f.scope.branchId), [
        { commandId: id, state: 'conflict', version: 4 },
      ]);
      await tick();
      assert.deepEqual(await cloudState(f, id), { state: 'conflict', result_version: 4 });
      // No last-write-wins: the cashier stop stays.
      assert.deepEqual((await branchAvailability(f.cloud, f.scope.branchId)).stoppedIds, [variant]);
      const commands = await latestCommands(f.cloud, f.scope.branchId);
      assert.equal(commands.resolved.get(variant).state, 'conflict');
      assert.equal(commands.resolved.get(variant).awaits_reconnect, true);
    });
  }));
