import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { createPool } from '@pickchick/database';
import { applyMenu, hashJson } from '@pickchick/menu-sync';
import { applyRemoteStops } from '@pickchick/local-orders';
import { branchAvailability } from '@pickchick/commerce-core';
import { fixtureMenu } from '@pickchick/test-fixtures';
import { fixture as cloudFixture, code } from './cloud-fixture.mjs';
import { fixture } from './worker-fixture.mjs';
import { pullFulfillment, syncFulfillmentOnce, PullRequestSchema } from '../dist/index.js';
import { fulfillmentWorkerGrants } from '../../../infra/windows/fulfillment-worker-grants.mjs';
import { fulfillmentTransportGrants } from '../../../infra/staging/fulfillment-transport-grants.mjs';

async function manager(cloud, organizationId) {
  const id = randomUUID();
  await cloud.query(
    "INSERT INTO catalog_managers(id,organization_id,name,token_hash) VALUES($1,$2,'Synthetic manager',$3)",
    [id, organizationId, randomBytes(32).toString('hex')],
  );
  return id;
}
async function issue(cloud, scope, actorId, variantId, patch = {}) {
  const command = {
    id: randomUUID(),
    stopped: true,
    duration: 'manual',
    reason: 'Synthetic back-office stop',
    expected_version: 0,
    ...patch,
  };
  await cloud.query(
    `INSERT INTO cloud_stop_commands(id,organization_id,branch_id,variant_id,catalog_ref,stopped,duration,reason,expected_version,actor_id,actor_label)
    VALUES($1,$2,$3,$4,'burger',$5,$6,$7,$8,$9,'Synthetic manager')`,
    [
      command.id,
      scope.organizationId,
      scope.branchId,
      variantId,
      command.stopped,
      command.duration,
      command.reason,
      command.expected_version,
      actorId,
    ],
  );
  return command.id;
}
const commandRow = async (cloud, id) =>
  (await cloud.query('SELECT * FROM cloud_stop_commands WHERE id=$1', [id])).rows[0];
/** Simulated clock: the guard owns created_at/expires_at, so tests move them with it disabled. */
async function age(cloud, id, seconds) {
  await cloud.query('ALTER TABLE cloud_stop_commands DISABLE TRIGGER cloud_stop_command_guard');
  try {
    await cloud.query(
      `UPDATE cloud_stop_commands SET created_at=created_at-$2*interval '1 second',expires_at=expires_at-$2*interval '1 second',
      delivered_at=delivered_at-$2*interval '1 second' WHERE id=$1`,
      [id, seconds],
    );
  } finally {
    await cloud.query('ALTER TABLE cloud_stop_commands ENABLE TRIGGER cloud_stop_command_guard');
  }
}
async function activeMenu(pool, branchId) {
  const menu = { ...fixtureMenu, release_id: randomUUID(), branch_id: branchId };
  await applyMenu(pool, branchId, {
    event_id: randomUUID(),
    producer_id: randomUUID(),
    producer_sequence: '1',
    branch_id: branchId,
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
  return menu.items[0].variant_id;
}
/** The real Windows worker role, optionally with the schema019 stop grants. */
async function workerRole(f, remoteStops, run) {
  const role = 'transport_' + randomUUID().replaceAll('-', '');
  const schema = (await f.pool.query('SELECT current_schema() AS name')).rows[0].name;
  await f.pool.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
  let pool;
  try {
    await f.pool.query(fulfillmentWorkerGrants(role, schema, { remoteStops }));
    const url = new URL(f.url);
    url.searchParams.set('options', `-c search_path=${schema} -c role=${role}`);
    pool = createPool(url.toString(), 4);
    await run(pool, (options = {}, io) =>
      syncFulfillmentOnce(pool, { ...f.options, ...options }, io),
    );
  } finally {
    if (pool) await pool.end();
    await f.pool.query(`DROP OWNED BY ${role}; DROP ROLE ${role}`);
  }
}
/** Records every pull body the worker sends. */
function recorder() {
  const bodies = [];
  return {
    bodies,
    io: {
      fetch: (url, init) => {
        if (String(url).endsWith('/pull')) bodies.push(JSON.parse(init.body));
        return fetch(url, init);
      },
    },
  };
}

test('protocol 4 round trip: delivered, applied on the edge, receipt and stop list in one pull', () =>
  fixture(async (f) => {
    const variant = await activeMenu(f.pool, f.scope.branchId);
    const actor = await manager(f.cloud, f.scope.organizationId);
    const id = await issue(f.cloud, f.scope, actor, variant);
    // Fail closed before the edge answers: the pending stop already blocks mobile and kiosk.
    assert.ok((await branchAvailability(f.cloud, f.scope.branchId)).stoppedIds.includes(variant));
    await workerRole(f, true, async (pool, tick) => {
      for (const sql of [
        'DELETE FROM remote_stop_commands',
        "UPDATE remote_stop_commands SET state='applied'",
        'UPDATE local_stops SET stopped=false',
        'INSERT INTO local_stop_events DEFAULT VALUES',
      ])
        await assert.rejects(pool.query(sql), code('42501'));
      const record = recorder();
      await tick({ protocolVersion: 4 }, record.io);
      assert.equal(record.bodies[0].protocolVersion, 4);
      assert.deepEqual(record.bodies[0].stopStates, []);
      assert.equal(record.bodies[0].stopReceipts, undefined);
      assert.equal((await commandRow(f.cloud, id)).state, 'delivered');
      const inbox = (await f.pool.query('SELECT * FROM remote_stop_commands')).rows;
      assert.equal(inbox.length, 1);
      assert.equal(inbox[0].command_id, id);
      assert.equal(inbox[0].state, 'received');
      assert.equal(inbox[0].actor_label, 'Synthetic manager');
      // A delivered command is not resent before the redelivery pause; the inbox deduplicates.
      await tick({ protocolVersion: 4 });
      assert.equal(await f.counts(f.pool, 'remote_stop_commands'), '1');

      assert.deepEqual(await applyRemoteStops(f.pool, f.scope.branchId), [
        { commandId: id, state: 'applied', version: 1 },
      ]);
      const next = recorder();
      await tick({ protocolVersion: 4 }, next.io);
      const sent = next.bodies[0];
      assert.deepEqual(sent.stopReceipts, [{ commandId: id, result: 'applied', version: 1 }]);
      assert.deepEqual(sent.availability.stoppedIds, [variant]);
      assert.deepEqual(sent.stopStates, [
        {
          id: variant,
          version: 1,
          stopped: true,
          source: 'backoffice',
          expiresAt: null,
          shiftScoped: false,
        },
      ]);
      const row = await commandRow(f.cloud, id);
      assert.equal(row.state, 'applied');
      assert.equal(row.result_version, 1);
      assert.ok(row.resolved_at);
      const projection = (await f.cloud.query('SELECT * FROM cloud_branch_availability')).rows[0];
      assert.deepEqual(projection.stopped_ids, [variant]);
      assert.deepEqual(projection.stop_states, sent.stopStates);
      assert.deepEqual((await branchAvailability(f.cloud, f.scope.branchId)).stoppedIds, [variant]);
      assert.ok(
        (await f.pool.query('SELECT reported_at FROM remote_stop_commands')).rows[0].reported_at,
      );
      // Reported once only.
      const quiet = recorder();
      await tick({ protocolVersion: 4 }, quiet.io);
      assert.equal(quiet.bodies[0].stopReceipts, undefined);
      assert.equal(
        (await f.cloud.query('SELECT state FROM cloud_stop_commands WHERE id=$1', [id])).rows[0]
          .state,
        'applied',
      );
    });
  }));

test('pending back-office unstop never unblocks before the edge applies it', () =>
  fixture(async (f) => {
    const variant = await activeMenu(f.pool, f.scope.branchId);
    await f.pool.query(
      "INSERT INTO local_stops(branch_id,variant_id,stopped,version,reason) VALUES($1,$2,true,3,'Cashier stop')",
      [f.scope.branchId, variant],
    );
    const actor = await manager(f.cloud, f.scope.organizationId);
    await workerRole(f, true, async (_pool, tick) => {
      await tick({ protocolVersion: 4 });
      const id = await issue(f.cloud, f.scope, actor, variant, {
        stopped: false,
        expected_version: 3,
      });
      assert.deepEqual((await branchAvailability(f.cloud, f.scope.branchId)).stoppedIds, [variant]);
      await tick({ protocolVersion: 4 });
      assert.deepEqual((await branchAvailability(f.cloud, f.scope.branchId)).stoppedIds, [variant]);
      assert.deepEqual(await applyRemoteStops(f.pool, f.scope.branchId), [
        { commandId: id, state: 'applied', version: 4 },
      ]);
      await tick({ protocolVersion: 4 });
      assert.deepEqual((await branchAvailability(f.cloud, f.scope.branchId)).stoppedIds, []);
      const states = (await f.cloud.query('SELECT stop_states FROM cloud_branch_availability'))
        .rows[0].stop_states;
      assert.deepEqual(states, [
        {
          id: variant,
          version: 4,
          stopped: false,
          source: 'backoffice',
          expiresAt: null,
          shiftScoped: false,
        },
      ]);
    });
  }));

test('a stale revision does not replace stop_states or stopped_ids', () =>
  fixture(async (f) => {
    const variant = await activeMenu(f.pool, f.scope.branchId);
    await workerRole(f, true, async (_pool, tick) => {
      await tick({ protocolVersion: 4 });
      await f.cloud.query('UPDATE cloud_branch_availability SET revision=9000000000');
      await f.pool.query(
        "INSERT INTO local_stops(branch_id,variant_id,stopped,version,reason) VALUES($1,$2,true,1,'Cashier stop')",
        [f.scope.branchId, variant],
      );
      await tick({ protocolVersion: 4 });
      const row = (await f.cloud.query('SELECT * FROM cloud_branch_availability')).rows[0];
      assert.deepEqual(row.stopped_ids, []);
      assert.deepEqual(row.stop_states, []);
    });
  }));

test('protocol 2 worker is unaffected; protocol 4 without edge schema019 grants keeps the heartbeat', () =>
  fixture(async (f) => {
    const variant = await activeMenu(f.pool, f.scope.branchId);
    const actor = await manager(f.cloud, f.scope.organizationId);
    const id = await issue(f.cloud, f.scope, actor, variant);
    await workerRole(f, false, async (_pool, tick) => {
      const record = recorder();
      await tick({}, record.io);
      await tick({ protocolVersion: 4 }, record.io);
      for (const body of record.bodies) {
        assert.equal(body.protocolVersion, 2);
        assert.deepEqual(Object.keys(body).sort(), [
          'availability',
          'leaseSeconds',
          'protocolVersion',
          'workerId',
        ]);
      }
      const result = await tick({ protocolVersion: 4 });
      assert.equal(result.remoteStops, 'edge_unavailable');
      assert.equal((await commandRow(f.cloud, id)).state, 'pending');
      assert.equal(await f.counts(f.pool, 'remote_stop_commands'), '0');
      const fresh = (
        await f.cloud.query(
          "SELECT observed_at>clock_timestamp()-interval '5 seconds' AS fresh FROM cloud_branch_availability",
        )
      ).rows[0].fresh;
      assert.equal(fresh, true);
    });
  }));

test('a cloud that rejects protocol 4 gets the protocol-2 heartbeat in the same turn', () =>
  fixture(async (f) => {
    await activeMenu(f.pool, f.scope.branchId);
    await workerRole(f, true, async (_pool, tick) => {
      const bodies = [];
      const io = {
        fetch: (url, init) => {
          const body = JSON.parse(init.body);
          if (String(url).endsWith('/pull')) bodies.push(body);
          if (body.protocolVersion === 4)
            return Promise.resolve(
              // What a pre-protocol-4 cloud answers to an unknown protocolVersion.
              new Response(
                JSON.stringify({
                  code: 'INVALID_REQUEST',
                  message_key: 'errors.invalid_request',
                  trace_id: randomUUID(),
                  retryable: false,
                }),
                {
                  status: 400,
                  headers: { 'content-type': 'application/json' },
                },
              ),
            );
          return fetch(url, init);
        },
      };
      // Drain the fixture order first so the turn is a plain heartbeat.
      for (let i = 0; i < 3; i++) await tick({ protocolVersion: 4 }, io);
      const result = await tick({ protocolVersion: 4 }, io);
      assert.equal(result.state, 'idle');
      assert.equal(result.remoteStops, 'cloud_unsupported');
      assert.deepEqual(
        bodies.slice(-2).map((b) => b.protocolVersion),
        [4, 2],
      );
      assert.equal(bodies.at(-1).stopStates, undefined);
    });
  }));

test('cloud expires undelivered commands, closes silent deliveries and accepts a late edge verdict', () =>
  cloudFixture(async (f) => {
    const variant = randomUUID(),
      other = randomUUID(),
      actor = await manager(f.pool, f.scope.organizationId);
    const pull = (extra = {}) =>
      pullFulfillment(f.pool, f.auth, {
        workerId: f.workerId,
        leaseSeconds: 30,
        protocolVersion: 4,
        availabilityOnly: true,
        availability: { revision: String(Date.now()), stoppedIds: [] },
        ...extra,
      });
    const undelivered = await issue(f.pool, f.scope, actor, variant);
    await assert.rejects(issue(f.pool, f.scope, actor, variant), code('23505'));
    assert.deepEqual((await branchAvailability(f.pool, f.scope.branchId)).stoppedIds, [variant]);
    await age(f.pool, undelivered, 121);
    // Lapsed by time alone, before any pull closes it.
    assert.deepEqual((await branchAvailability(f.pool, f.scope.branchId)).stoppedIds, []);
    assert.deepEqual((await pull()).stopCommands, []);
    assert.equal((await commandRow(f.pool, undelivered)).state, 'expired');
    assert.deepEqual((await branchAvailability(f.pool, f.scope.branchId)).stoppedIds, []);

    const silent = await issue(f.pool, f.scope, actor, other, { duration: 'hour' });
    const delivered = (await pull()).stopCommands;
    assert.deepEqual(delivered, [
      {
        commandId: silent,
        variantId: other,
        stopped: true,
        duration: 'hour',
        reason: 'Synthetic back-office stop',
        expectedVersion: 0,
        actorLabel: 'Synthetic manager',
        issuedAt: (await commandRow(f.pool, silent)).created_at.toISOString(),
      },
    ]);
    // Within the pause a delivered command is not resent; afterwards it is (lost response).
    assert.deepEqual((await pull()).stopCommands, []);
    await age(f.pool, silent, 6);
    assert.equal((await pull()).stopCommands.length, 1);
    await age(f.pool, silent, 120);
    assert.deepEqual((await pull()).stopCommands, []);
    assert.equal((await commandRow(f.pool, silent)).state, 'delivered');
    await age(f.pool, silent, 60);
    await pull();
    assert.equal((await commandRow(f.pool, silent)).state, 'expired');
    // The edge is the source of truth: its late verdict replaces the cloud-side expiry.
    await pull({ stopReceipts: [{ commandId: silent, result: 'applied', version: 2 }] });
    const late = await commandRow(f.pool, silent);
    assert.equal(late.state, 'applied');
    assert.equal(late.result_version, 2);
    // A verdict is final, and a never-delivered expiry is not reopened.
    await pull({ stopReceipts: [{ commandId: silent, result: 'conflict', version: 3 }] });
    await pull({ stopReceipts: [{ commandId: undelivered, result: 'applied', version: 1 }] });
    assert.equal((await commandRow(f.pool, silent)).state, 'applied');
    assert.equal((await commandRow(f.pool, undelivered)).state, 'expired');
    for (const sql of [
      'DELETE FROM cloud_stop_commands',
      "UPDATE cloud_stop_commands SET reason='Changed'",
      "UPDATE cloud_stop_commands SET state='pending'",
    ])
      await assert.rejects(f.pool.query(sql), code('23514'));
  }));

test('protocol 4 is a superset of 3 and protocols 2/3 reject stop fields', () =>
  cloudFixture(async (f) => {
    const base = {
      workerId: f.workerId,
      leaseSeconds: 30,
      availabilityOnly: true,
      availability: { revision: '5', stoppedIds: [] },
    };
    const v3 = await pullFulfillment(f.pool, f.auth, { ...base, protocolVersion: 3 });
    assert.equal(v3.stopCommands, undefined);
    assert.equal(v3.cashierReportsSupported, true);
    const v2 = await pullFulfillment(f.pool, f.auth, {
      ...base,
      availability: { revision: '6', stoppedIds: [] },
      protocolVersion: 2,
    });
    assert.deepEqual(Object.keys(v2).sort(), ['event', 'scope']);
    const v4 = await pullFulfillment(f.pool, f.auth, {
      ...base,
      availability: { revision: '7', stoppedIds: [] },
      protocolVersion: 4,
      stopStates: [],
    });
    assert.equal(v4.cashierReportsSupported, true);
    assert.deepEqual(v4.stopCommands, []);
    for (const protocolVersion of [2, 3])
      await assert.rejects(
        pullFulfillment(f.pool, f.auth, { ...base, protocolVersion, stopStates: [] }),
        (e) => e.code === 'INVALID_REQUEST',
      );
    assert.equal(PullRequestSchema.safeParse({ ...base, stopReceipts: [] }).success, false);
  }));

test('restricted cloud transport role runs the stop exchange but cannot issue or rewrite commands', () =>
  cloudFixture(async (f) => {
    const role = 'transport_runtime_' + randomUUID().replaceAll('-', '');
    let limited;
    await f.admin.query(
      `CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
    );
    try {
      await f.pool.query(`GRANT USAGE ON SCHEMA ${f.schema} TO ${role}`);
      await f.pool.query(
        `GRANT SELECT ON devices,device_credentials,branches TO ${role}; GRANT UPDATE(id) ON devices TO ${role}; GRANT UPDATE(device_id) ON device_credentials TO ${role}`,
      );
      await f.pool.query(fulfillmentTransportGrants(role, true));
      const url = new URL(f.url);
      url.searchParams.set('options', `-c search_path=${f.schema} -c role=${role}`);
      limited = createPool(url.toString(), 2);
      const actor = await manager(f.pool, f.scope.organizationId),
        variant = randomUUID(),
        id = await issue(f.pool, f.scope, actor, variant);
      assert.deepEqual((await branchAvailability(limited, f.scope.branchId)).stoppedIds, [variant]);
      const response = await pullFulfillment(limited, f.auth, {
        workerId: f.workerId,
        leaseSeconds: 30,
        protocolVersion: 4,
        availabilityOnly: true,
        availability: { revision: '9', stoppedIds: [] },
        stopStates: [],
      });
      assert.equal(response.stopCommands[0].commandId, id);
      await pullFulfillment(limited, f.auth, {
        workerId: f.workerId,
        leaseSeconds: 30,
        protocolVersion: 4,
        availabilityOnly: true,
        availability: { revision: '10', stoppedIds: [variant] },
        stopStates: [],
        stopReceipts: [{ commandId: id, result: 'applied', version: 1 }],
      });
      assert.equal((await commandRow(f.pool, id)).state, 'applied');
      for (const sql of [
        `INSERT INTO cloud_stop_commands(id) VALUES('${randomUUID()}')`,
        "UPDATE cloud_stop_commands SET reason='x'",
        'DELETE FROM cloud_stop_commands',
      ])
        await assert.rejects(limited.query(sql), code('42501'));
      await f.pool.query(fulfillmentTransportGrants(role, false));
      await assert.rejects(limited.query('SELECT 1 FROM cloud_stop_commands'), code('42501'));
      // A narrow reader (e.g. a payment worker) keeps the edge projection instead of failing.
      await issue(f.pool, f.scope, actor, randomUUID());
      await f.pool.query(
        `GRANT SELECT ON cloud_branch_availability,fulfillment_transport_bindings TO ${role}`,
      );
      assert.deepEqual((await branchAvailability(limited, f.scope.branchId)).stoppedIds, [variant]);
    } finally {
      if (limited) await limited.end();
      await f.pool.query(`DROP OWNED BY ${role}`);
      await f.admin.query(`DROP ROLE ${role}`);
    }
  }));
