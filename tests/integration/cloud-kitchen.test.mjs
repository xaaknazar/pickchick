import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';
import { createPool, migrate } from '@pickchick/database';
import { loadConfig } from '@pickchick/platform';
import {
  KITCHEN_ACTIONS,
  checkVersion,
  commandShape,
  planCompleteStation,
  planConfirmCancel,
  planHandoff,
  planReady,
  planTask,
} from '@pickchick/fulfillment-state';
import { CloudKitchen, provisionCloudKitchen, digest } from '@pickchick/cloud-kitchen';
import { cloudKitchenGrants } from '../../infra/staging/cloud-kitchen-grants.mjs';
import { channelNumberGrants } from '../../infra/staging/channel-number-grants.mjs';

// Cloud migration 054 + @pickchick/cloud-kitchen (ADR-0014 S2). Not wired into payment capture.
const admin = createPool(loadConfig('api').databaseUrl);
after(() => admin.end());
const migrations = fileURLToPath(new URL('../../db/cloud/migrations/', import.meta.url));

async function withCloud(run) {
  const schema = `cloud_kitchen_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const base = new URL(loadConfig('api').databaseUrl);
  const urlFor = (role) => {
    const url = new URL(base);
    url.searchParams.set('options', `-c search_path=${schema}${role ? ` -c role=${role}` : ''}`);
    return url.toString();
  };
  const pool = createPool(urlFor(), 24);
  const pools = [pool];
  try {
    await migrate(pool, migrations, 'cloud');
    const org = randomUUID(),
      legal = randomUUID();
    await pool.query("INSERT INTO organizations(id,name) VALUES($1,'Cloud kitchen synthetic')", [
      org,
    ]);
    await pool.query(
      "INSERT INTO legal_entities(id,organization_id,name,bin) VALUES($1,$2,'Synthetic','000000000000')",
      [legal, org],
    );
    const branch = async (code, { provision = true, mode = 'cloud' } = {}) => {
      const id = randomUUID();
      await pool.query(
        "INSERT INTO branches(id,organization_id,legal_entity_id,code,name) VALUES($1,$2,$3,$4,'Synthetic')",
        [id, org, legal, code],
      );
      const prep = randomUUID(),
        assembly = randomUUID();
      if (provision)
        await provisionCloudKitchen(pool, {
          branchId: id,
          stations: [
            { id: prep, kind: 'prep', name: 'Горячий цех' },
            { id: assembly, kind: 'assembly', name: 'Сборка' },
          ],
          routing: {
            version: 1,
            assemblyStationId: assembly,
            routes: [
              { productId: 'burger', stationId: prep, kind: 'prep' },
              { productId: 'fries', stationId: prep, kind: 'prep' },
              { productId: 'drink', stationId: assembly, kind: 'assembly_item' },
            ],
          },
        });
      if (mode === 'cloud') await setMode(id, 'cloud');
      const actor = (stationIds, manager = false) => ({
        branchId: id,
        deviceId: randomUUID(),
        stationIds,
        manager,
      });
      return {
        id,
        prep,
        assembly,
        manager: actor([], true),
        cook: actor([prep]),
        packer: actor([assembly]),
      };
    };
    const setMode = async (branchId, owner, actor = 'synthetic-manager') =>
      (
        await pool.query(
          'SELECT cloud_channels_owner,epoch::int AS epoch FROM cloud_kitchen_set_mode($1,$2,$3,$4)',
          [branchId, owner, actor, 'Synthetic switch'],
        )
      ).rows[0];
    // Commerce rows are seeded directly (replica role skips the commerce FK/guard triggers, not
    // CHECK constraints): this stage only reads the committed payment facts.
    const paidOrder = async (
      b,
      {
        channel = 'kiosk',
        total = 2500,
        captured = total,
        refund = false,
        cancellation = false,
        attention = false,
        lines = [
          { productId: 'burger', quantity: 2 },
          { productId: 'drink', quantity: 1 },
        ],
      } = {},
    ) => {
      const id = randomUUID();
      const snapshot = {
        organizationId: org,
        branchId: b.id,
        channel,
        serviceMode: 'takeaway',
        displayName: 'Айгерим',
        currency: 'KZT',
        totalMinor: String(total),
        lines: lines.map((l) => ({
          lineId: randomUUID(),
          productId: l.productId,
          title: l.productId,
          description: '',
          quantity: l.quantity,
        })),
      };
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SET LOCAL session_replication_role='replica'");
        await client.query(
          `INSERT INTO commerce_orders(id,organization_id,branch_id,principal_id,quote_id,snapshot,total_minor,currency,quote_digest,state,attention_required,fiscal_policy,fiscal_deferral_reference)
           VALUES($1,$2,$3,$4,$5,$6,$7,'KZT',$8,'paid_pending_acceptance',$9,'deferred_pilot','SYNTHETIC-S2')`,
          [id, org, b.id, randomUUID(), randomUUID(), snapshot, total, digest(snapshot), attention],
        );
        const capture = randomUUID(),
          account = randomUUID();
        if (captured > 0)
          await client.query(
            'INSERT INTO commerce_captures(id,order_id,attempt_id,account_id,operation_id,amount_minor,occurred_at) VALUES($1,$2,$3,$4,$5,$6,clock_timestamp())',
            [capture, id, randomUUID(), account, 'op-' + capture, captured],
          );
        if (refund)
          await client.query(
            "INSERT INTO commerce_refunds(id,order_id,capture_id,account_id,principal_id,amount_minor,reason,state) VALUES($1,$2,$3,$4,$5,100,'Synthetic','pending')",
            [randomUUID(), id, capture, account, randomUUID()],
          );
        if (cancellation)
          await client.query(
            "INSERT INTO commerce_cancellation_intents(id,order_id,organization_id,branch_id,requested_by,reason,state) VALUES($1,$2,$3,$4,$5,'Synthetic','waiting_admission')",
            [randomUUID(), id, org, b.id, randomUUID()],
          );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
      return id;
    };
    const read = async (orderId) => {
      const order = (
        await pool.query('SELECT state,version FROM cloud_kitchen_orders WHERE order_id=$1', [
          orderId,
        ])
      ).rows[0];
      const tasks = (
        await pool.query(
          'SELECT id,station_id,state,version FROM cloud_kitchen_tasks WHERE order_id=$1 ORDER BY id',
          [orderId],
        )
      ).rows;
      return { ...order, tasks };
    };
    const outbox = async (orderId) =>
      (
        await pool.query(
          'SELECT event_type,aggregate_version FROM cloud_kitchen_outbox WHERE order_id=$1 ORDER BY sequence',
          [orderId],
        )
      ).rows;
    const hold = async (orderId) =>
      (
        await pool.query(
          'SELECT display_number,released_at FROM channel_number_holds WHERE order_id=$1',
          [orderId],
        )
      ).rows[0];
    const count = async (sql, params = []) => Number((await pool.query(sql, params)).rows[0].count);
    const poolAs = (role) => {
      const p = createPool(urlFor(role), 8);
      pools.push(p);
      return p;
    };
    await run({
      pool,
      schema,
      repo: new CloudKitchen(pool),
      branch,
      setMode,
      paidOrder,
      read,
      outbox,
      hold,
      count,
      poolAs,
    });
  } finally {
    for (const p of pools) await p.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  }
}
const key = () => 'k-' + randomUUID();
const codeOf = (code, reason) => (error) =>
  error.code === code && (reason === undefined || error.reason === reason);

test("mode 'edge' (default) records the owner and never admits to the cloud kitchen", () =>
  withCloud(async ({ pool, repo, branch, setMode, paidOrder, hold, count }) => {
    const b = await branch('CK-EDGE', { mode: 'edge' });
    const first = await paidOrder(b);
    assert.deepEqual(await repo.admitPaidOrder(first), {
      outcome: 'edge',
      fulfillmentOwner: 'edge',
      ownerEpoch: '0',
    });
    assert.equal(await hold(first), undefined, 'no cloud display number');
    assert.equal(await count('SELECT count(*) FROM cloud_kitchen_orders'), 0);
    // The owner is fixed at payment: switching the branch later never moves the order.
    assert.deepEqual(await setMode(b.id, 'cloud'), { cloud_channels_owner: 'cloud', epoch: 1 });
    assert.equal((await repo.admitPaidOrder(first)).outcome, 'edge');
    const second = await paidOrder(b);
    const admitted = await repo.admitPaidOrder(second);
    assert.equal(admitted.outcome, 'admitted');
    assert.equal(admitted.order.ownerEpoch, '1');
    assert.equal(admitted.order.displayNumber, 300);
    // And back: an order admitted under 'cloud' stays cloud after a switch to 'edge'.
    assert.deepEqual(await setMode(b.id, 'edge'), { cloud_channels_owner: 'edge', epoch: 2 });
    assert.equal((await repo.admitPaidOrder(second)).outcome, 'existing');
    assert.deepEqual((await repo.admitPaidOrder(await paidOrder(b))).ownerEpoch, '2');
    await assert.rejects(setMode(b.id, 'edge'), { code: '55000' });
    await assert.rejects(setMode(b.id, 'pos'), { code: '22023' });
    assert.deepEqual(
      (
        await pool.query(
          'SELECT epoch::int,cloud_channels_owner FROM branch_channel_mode_changes WHERE branch_id=$1 ORDER BY epoch',
          [b.id],
        )
      ).rows,
      [
        { epoch: 1, cloud_channels_owner: 'cloud' },
        { epoch: 2, cloud_channels_owner: 'edge' },
      ],
    );
    assert.deepEqual(
      (
        await pool.query(
          'SELECT fulfillment_owner,owner_epoch::int FROM cloud_kitchen_admissions ORDER BY decided_at',
        )
      ).rows,
      [
        { fulfillment_owner: 'edge', owner_epoch: 0 },
        { fulfillment_owner: 'cloud', owner_epoch: 1 },
        { fulfillment_owner: 'edge', owner_epoch: 2 },
      ],
    );
  }));

test('admission is idempotent under concurrency and allocates the channel number once', () =>
  withCloud(async ({ pool, repo, branch, paidOrder, outbox, hold, count }) => {
    const b = await branch('CK-A');
    const kiosk = await paidOrder(b, {
      lines: [
        { productId: 'burger', quantity: 2 },
        { productId: 'fries', quantity: 1 },
        { productId: 'drink', quantity: 3 },
      ],
    });
    const results = await Promise.all(Array.from({ length: 10 }, () => repo.admitPaidOrder(kiosk)));
    assert.deepEqual(results.map((r) => r.outcome).sort(), [
      'admitted',
      ...Array(9).fill('existing'),
    ]);
    for (const r of results) assert.deepEqual(r.order, results[0].order);
    const order = results[0].order;
    assert.deepEqual(
      [order.state, order.version, order.channel, order.displayNumber, order.fulfillmentOwner],
      ['accepted', 1, 'kiosk', 300, 'cloud'],
    );
    assert.deepEqual(await hold(kiosk), { display_number: 300, released_at: null });
    assert.deepEqual(
      (
        await pool.query(
          'SELECT station_id,kind,state,version,details->>$2 AS product,(details->>$3)::int AS qty FROM cloud_kitchen_tasks WHERE order_id=$1 ORDER BY details->>$2',
          [kiosk, 'productId', 'quantity'],
        )
      ).rows,
      [
        {
          station_id: b.prep,
          kind: 'prep',
          state: 'queued',
          version: 1,
          product: 'burger',
          qty: 2,
        },
        {
          station_id: b.assembly,
          kind: 'assembly_item',
          state: 'queued',
          version: 1,
          product: 'drink',
          qty: 3,
        },
        { station_id: b.prep, kind: 'prep', state: 'queued', version: 1, product: 'fries', qty: 1 },
      ],
    );
    assert.deepEqual(await outbox(kiosk), [
      { event_type: 'cloud_kitchen.accepted', aggregate_version: 1 },
    ]);
    // Mobile uses its own range; parallel admissions of different orders get unique numbers.
    const mobiles = await Promise.all(
      Array.from({ length: 6 }, () => paidOrder(b, { channel: 'mobile' })),
    );
    const numbers = (await Promise.all(mobiles.map((id) => repo.admitPaidOrder(id)))).map(
      (r) => r.order.displayNumber,
    );
    assert.deepEqual(
      numbers.sort((x, y) => x - y),
      [600, 601, 602, 603, 604, 605],
    );
    // A number reserved before payment is reused, not allocated twice.
    const reserved = await paidOrder(b);
    await pool.query('SELECT * FROM channel_number_allocate($1,$2,$3)', [b.id, 'kiosk', reserved]);
    assert.equal((await repo.admitPaidOrder(reserved)).order.displayNumber, 301);
    assert.equal(await count('SELECT count(*) FROM channel_number_holds'), 8);
  }));

test('admission refuses unpaid, refunded, cancelled, flagged, unknown and non-cloud channels', () =>
  withCloud(async ({ repo, branch, paidOrder, pool, count }) => {
    const b = await branch('CK-A');
    const refused = [
      [await paidOrder(b, { captured: 0 }), 'NOT_READY', 'NOT_PAID'],
      [await paidOrder(b, { captured: 1000 }), 'NOT_READY', 'NOT_PAID'],
      [await paidOrder(b, { captured: 3000 }), 'NOT_READY', 'NOT_PAID'],
      [await paidOrder(b, { refund: true }), 'NOT_READY', 'NOT_PAID'],
      [await paidOrder(b, { cancellation: true }), 'NOT_READY', 'NOT_PAID'],
      [await paidOrder(b, { attention: true }), 'NOT_READY', 'NOT_PAID'],
      [await paidOrder(b, { channel: 'pos' }), 'INVALID'],
      [await paidOrder(b, { lines: [{ productId: 'salad', quantity: 1 }] }), 'ROUTING_MISSING'],
      [randomUUID(), 'NOT_FOUND'],
    ];
    for (const [orderId, code, reason] of refused)
      await assert.rejects(repo.admitPaidOrder(orderId), codeOf(code, reason), orderId);
    await assert.rejects(repo.admitPaidOrder('not-a-uuid'), codeOf('INVALID'));
    // Unprovisioned branch in cloud mode: no routing, nothing recorded.
    const bare = await branch('CK-BARE', { provision: false });
    await assert.rejects(repo.admitPaidOrder(await paidOrder(bare)), codeOf('ROUTING_MISSING'));
    // All 300 kiosk numbers held by active orders: refused before any record is written.
    for (let i = 0; i < 300; i++)
      await pool.query('SELECT * FROM channel_number_allocate($1,$2,$3)', [
        b.id,
        'kiosk',
        randomUUID(),
      ]);
    await assert.rejects(
      repo.admitPaidOrder(await paidOrder(b)),
      codeOf('NOT_READY', 'NUMBERS_EXHAUSTED'),
    );
    assert.equal(await count('SELECT count(*) FROM cloud_kitchen_admissions'), 0);
    assert.equal(await count('SELECT count(*) FROM cloud_kitchen_orders'), 0);
    assert.equal(
      (await repo.admitPaidOrder(await paidOrder(b, { channel: 'mobile' }))).order.displayNumber,
      600,
    );
  }));

test('kitchen commands: whole ticket to handoff, replay, conflicts and number release', () =>
  withCloud(async ({ repo, branch, paidOrder, outbox, hold, read }) => {
    const b = await branch('CK-A');
    const orderId = await paidOrder(b);
    await repo.admitPaidOrder(orderId);
    const k1 = key();
    const prepDone = await repo.act(b.cook, k1, {
      orderId,
      expectedVersion: 1,
      action: 'complete_station',
      stationId: b.prep,
    });
    assert.deepEqual([prepDone.state, prepDone.version], ['in_production', 3]);
    // Same key and body: stored result, no new effect. Same key, other body: conflict.
    assert.deepEqual(
      await repo.act(b.cook, k1, {
        orderId,
        expectedVersion: 1,
        action: 'complete_station',
        stationId: b.prep,
      }),
      prepDone,
    );
    await assert.rejects(
      repo.act(b.cook, k1, { orderId, expectedVersion: 3, action: 'ready' }),
      codeOf('CONFLICT'),
    );
    // Stale expectedVersion, wrong station, missing idempotency key.
    await assert.rejects(
      repo.act(b.packer, key(), { orderId, expectedVersion: 1, action: 'ready' }),
      codeOf('CONFLICT'),
    );
    await assert.rejects(
      repo.act(b.cook, key(), {
        orderId,
        expectedVersion: 3,
        action: 'complete_station',
        stationId: b.assembly,
      }),
      codeOf('FORBIDDEN'),
    );
    await assert.rejects(
      repo.act(b.packer, undefined, { orderId, expectedVersion: 3, action: 'ready' }),
      codeOf('INVALID'),
    );
    await assert.rejects(
      repo.act(b.packer, 'short', { orderId, expectedVersion: 3, action: 'ready' }),
      codeOf('INVALID'),
    );
    const ready = await repo.act(b.packer, key(), {
      orderId,
      expectedVersion: 3,
      action: 'complete_station',
      stationId: b.assembly,
    });
    assert.deepEqual([ready.state, ready.version], ['ready', 6]);
    const display = await repo.readDisplay(b.packer);
    assert.deepEqual(display.items, [
      { number: 300, name: 'Айгерим', state: 'ready', fulfillmentOwner: 'cloud' },
    ]);
    assert.equal((await hold(orderId)).released_at, null);
    const handed = await repo.act(b.packer, key(), {
      orderId,
      expectedVersion: 6,
      action: 'handoff',
    });
    assert.deepEqual([handed.state, handed.version], ['handed_over', 7]);
    assert.notEqual((await hold(orderId)).released_at, null, 'number released on handoff');
    assert.deepEqual((await repo.readDisplay(b.packer)).items, []);
    assert.deepEqual((await repo.listKitchen(b.manager)).items, []);
    assert.deepEqual(
      (await outbox(orderId)).map((e) => e.event_type),
      [
        'cloud_kitchen.accepted',
        'cloud_kitchen.task_changed',
        'cloud_kitchen.task_changed',
        'cloud_kitchen.task_changed',
        'cloud_kitchen.task_changed',
        'cloud_kitchen.ready',
        'cloud_kitchen.handed_over',
      ],
    );
    assert.deepEqual(
      (await outbox(orderId)).map((e) => e.aggregate_version),
      [1, 2, 3, 4, 5, 6, 7],
    );
    // Terminal: nothing moves any more.
    await assert.rejects(
      repo.act(b.manager, key(), { orderId, expectedVersion: 7, action: 'handoff' }),
      codeOf('NOT_READY'),
    );
    assert.ok((await read(orderId)).tasks.every((t) => t.state === 'done'));
  }));

test('concurrent commands with one expectedVersion: exactly one wins, the rest conflict', () =>
  withCloud(async ({ repo, branch, paidOrder, read, outbox }) => {
    const b = await branch('CK-A');
    const orderId = await paidOrder(b);
    await repo.admitPaidOrder(orderId);
    const { tasks } = await read(orderId);
    const prepTask = tasks.find((t) => t.station_id === b.prep);
    const attempts = await Promise.allSettled(
      Array.from({ length: 12 }, (_, i) =>
        repo.act(i % 2 ? b.cook : b.manager, key(), {
          orderId,
          expectedVersion: 1,
          action: 'start_task',
          taskId: prepTask.id,
          expectedTaskVersion: 1,
        }),
      ),
    );
    assert.equal(attempts.filter((a) => a.status === 'fulfilled').length, 1);
    assert.ok(
      attempts.filter((a) => a.status === 'rejected').every((a) => a.reason.code === 'CONFLICT'),
    );
    assert.deepEqual(await outbox(orderId), [
      { event_type: 'cloud_kitchen.accepted', aggregate_version: 1 },
      { event_type: 'cloud_kitchen.task_changed', aggregate_version: 2 },
    ]);
    // Parallel retries of one command (same key and body) converge on one effect.
    const command = {
      orderId,
      expectedVersion: 2,
      action: 'complete_task',
      taskId: prepTask.id,
      expectedTaskVersion: 2,
    };
    const k = key();
    const retries = await Promise.all(
      Array.from({ length: 8 }, () => repo.act(b.cook, k, command)),
    );
    for (const retry of retries) assert.deepEqual(retry, retries[0]);
    assert.equal((await read(orderId)).version, 3);
  }));

test('branches are isolated: orders, feeds, display, commands and keys never cross', () =>
  withCloud(async ({ repo, branch, paidOrder }) => {
    const a = await branch('CK-A'),
      b = await branch('CK-B');
    const orderA = await paidOrder(a),
      orderB = await paidOrder(b);
    assert.equal((await repo.admitPaidOrder(orderA)).order.displayNumber, 300);
    assert.equal((await repo.admitPaidOrder(orderB)).order.displayNumber, 300);
    const intruder = { ...b.manager };
    await assert.rejects(repo.readOrder(intruder, orderA), codeOf('NOT_FOUND'));
    await assert.rejects(
      repo.act(intruder, key(), { orderId: orderA, expectedVersion: 1, action: 'ready' }),
      codeOf('NOT_FOUND'),
    );
    assert.deepEqual(
      (await repo.listKitchen(b.manager)).items.map((o) => o.orderId),
      [orderB],
    );
    assert.deepEqual(
      (await repo.readDisplay(a.packer)).items.map((i) => i.number),
      [300],
    );
    // A station of branch A is unknown to branch B, even for a manager.
    await assert.rejects(repo.listKitchen(b.manager, { stationId: a.prep }), codeOf('NOT_FOUND'));
    // The same Idempotency-Key from one device in two branches are two different commands.
    const shared = key();
    const device = randomUUID();
    const inA = await repo.act({ ...a.manager, deviceId: device }, shared, {
      orderId: orderA,
      expectedVersion: 1,
      action: 'complete_station',
      stationId: a.prep,
    });
    const inB = await repo.act({ ...b.manager, deviceId: device }, shared, {
      orderId: orderB,
      expectedVersion: 1,
      action: 'complete_station',
      stationId: b.prep,
    });
    assert.deepEqual([inA.orderId, inB.orderId], [orderA, orderB]);
    assert.deepEqual(
      (await repo.listStations(a.cook)).items.map((s) => [s.id, s.kind, s.allowed]),
      [
        [a.assembly, 'assembly', false],
        [a.prep, 'prep', true],
      ],
    );
  }));

test('cancellation: untouched cancels at once, started waits for stop and manager confirm', () =>
  withCloud(async ({ repo, branch, paidOrder, read, hold, outbox }) => {
    const b = await branch('CK-A');
    const untouched = await paidOrder(b);
    await repo.admitPaidOrder(untouched);
    await assert.rejects(
      repo.requestCancel(untouched, { branchId: b.id, expectedVersion: 2, reason: 'Гость ушёл' }),
      codeOf('CONFLICT'),
    );
    const cancelled = await repo.requestCancel(untouched, {
      branchId: b.id,
      expectedVersion: 1,
      reason: 'Гость ушёл',
    });
    assert.deepEqual([cancelled.state, cancelled.version], ['cancelled', 2]);
    assert.ok((await read(untouched)).tasks.every((t) => t.state === 'cancelled'));
    assert.notEqual((await hold(untouched)).released_at, null);

    const started = await paidOrder(b);
    await repo.admitPaidOrder(started);
    const prepTask = (await read(started)).tasks.find((t) => t.station_id === b.prep);
    await repo.act(b.cook, key(), {
      orderId: started,
      expectedVersion: 1,
      action: 'start_task',
      taskId: prepTask.id,
      expectedTaskVersion: 1,
    });
    const requested = await repo.requestCancel(started, {
      branchId: b.id,
      expectedVersion: 2,
      reason: 'Отмена оплаты',
    });
    assert.equal(requested.state, 'cancel_requested');
    assert.equal((await hold(started)).released_at, null, 'still on the kitchen screens');
    const confirmCancel = (actor, expectedVersion) =>
      repo.act(actor, key(), {
        orderId: started,
        expectedVersion,
        action: 'confirm_cancel',
        reason: 'Отмена оплаты',
        inventoryDisposition: 'requires_inventory_review',
      });
    await assert.rejects(confirmCancel(b.manager, 3), codeOf('NOT_READY'), 'task still cooking');
    const stopping = (await read(started)).tasks.find((t) => t.id === prepTask.id);
    assert.equal(stopping.state, 'cancel_requested');
    await repo.act(b.cook, key(), {
      orderId: started,
      expectedVersion: 3,
      action: 'confirm_stop',
      taskId: prepTask.id,
      expectedTaskVersion: stopping.version,
    });
    await assert.rejects(confirmCancel(b.cook, 4), codeOf('FORBIDDEN'));
    const done = await confirmCancel(b.manager, 4);
    assert.deepEqual([done.state, done.version], ['cancelled', 5]);
    assert.notEqual((await hold(started)).released_at, null);
    assert.equal((await outbox(started)).at(-1).event_type, 'cloud_kitchen.cancelled');
    const detail = await repo.readOrder(b.manager, started);
    assert.deepEqual(
      [detail.cancellationReason, detail.inventoryDisposition],
      ['Отмена оплаты', 'requires_inventory_review'],
    );
    await assert.rejects(
      repo.requestCancel(started, { branchId: b.id, expectedVersion: 5, reason: 'x' }),
      codeOf('NOT_READY'),
    );
  }));

test('station polls record presence for the future KITCHEN_OFFLINE gate', () =>
  withCloud(async ({ repo, branch, pool }) => {
    const b = await branch('CK-A');
    assert.deepEqual(await repo.stationPresence(b.id), { assembly: false, prep: false });
    await assert.rejects(repo.listKitchen(b.cook, { stationId: b.assembly }), codeOf('FORBIDDEN'));
    assert.deepEqual(await repo.stationPresence(b.id), { assembly: false, prep: false });
    await repo.listKitchen(b.cook, { stationId: b.prep });
    assert.deepEqual(await repo.stationPresence(b.id), { assembly: false, prep: true });
    await repo.listKitchen(b.packer, { stationId: b.assembly });
    assert.deepEqual(await repo.stationPresence(b.id), { assembly: true, prep: true });
    await pool.query(
      "UPDATE cloud_kitchen_station_presence SET seen_at=clock_timestamp()-interval '31 seconds' WHERE station_id=$1",
      [b.prep],
    );
    assert.deepEqual(await repo.stationPresence(b.id), { assembly: true, prep: false });
    assert.deepEqual(await repo.stationPresence(b.id, 60), { assembly: true, prep: true });
  }));

test('database guards keep identity, versions, journals and number holds intact', () =>
  withCloud(async ({ pool, repo, branch, paidOrder }) => {
    const b = await branch('CK-A');
    const orderId = await paidOrder(b);
    await repo.admitPaidOrder(orderId);
    await repo.act(b.manager, key(), {
      orderId,
      expectedVersion: 1,
      action: 'complete_station',
      stationId: b.prep,
    });
    for (const sql of [
      'UPDATE cloud_kitchen_orders SET display_number=301',
      'UPDATE cloud_kitchen_orders SET owner_epoch=owner_epoch+1,version=version+1',
      "UPDATE cloud_kitchen_orders SET state='ready',version=version+2",
      "UPDATE cloud_kitchen_orders SET state='ready'",
      'DELETE FROM cloud_kitchen_orders',
      'UPDATE cloud_kitchen_tasks SET station_id=gen_random_uuid(),version=version+1',
      "UPDATE cloud_kitchen_tasks SET state='queued',version=version+1 WHERE state='done'",
      'DELETE FROM cloud_kitchen_tasks',
      "UPDATE cloud_kitchen_admissions SET fulfillment_owner='edge'",
      'DELETE FROM cloud_kitchen_commands',
      "UPDATE cloud_kitchen_commands SET result='{}'",
      "UPDATE cloud_kitchen_outbox SET payload='{}'",
      'DELETE FROM cloud_kitchen_outbox',
      'UPDATE cloud_kitchen_routing SET version=2',
      "UPDATE branch_channel_mode_changes SET cloud_channels_owner='edge'",
      "UPDATE branch_channel_modes SET cloud_channels_owner='pos'",
    ])
      await assert.rejects(pool.query(sql), { code: '23514' }, sql);
    // A kitchen order cannot exist without its active channel number and cloud admission.
    const other = await paidOrder(b);
    await pool.query(
      "INSERT INTO cloud_kitchen_admissions(order_id,branch_id,channel,fulfillment_owner,owner_epoch) VALUES($1,$2,'kiosk','cloud',1)",
      [other, b.id],
    );
    const plan = '[]';
    await assert.rejects(
      pool.query(
        `INSERT INTO cloud_kitchen_orders(order_id,branch_id,channel,owner_epoch,quote_digest,snapshot,routing_version,assembly_station_id,task_plan,display_number,number_shift_epoch,state)
         SELECT $1,$2,'kiosk',1,repeat('a',64),'{}',1,$3,$4,555,0,'accepted'`,
        [other, b.id, b.assembly, plan],
      ),
      { code: '23514' },
      'no hold',
    );
    await pool.query('SELECT * FROM channel_number_allocate($1,$2,$3)', [b.id, 'kiosk', other]);
    await assert.rejects(
      pool.query(
        `INSERT INTO cloud_kitchen_orders(order_id,branch_id,channel,owner_epoch,quote_digest,snapshot,routing_version,assembly_station_id,task_plan,display_number,number_shift_epoch,state)
         SELECT $1,$2,'kiosk',1,repeat('a',64),'{}',1,$3,$4,555,0,'accepted'`,
        [other, b.id, b.assembly, plan],
      ),
      { code: '23514' },
      'wrong number for the hold',
    );
    // Outbox lease fields stay writable for the future publisher; ack is final.
    await pool.query(
      'UPDATE cloud_kitchen_outbox SET attempts=attempts+1,acknowledged_at=clock_timestamp() WHERE aggregate_version=1',
    );
    await assert.rejects(
      pool.query('UPDATE cloud_kitchen_outbox SET acknowledged_at=NULL WHERE aggregate_version=1'),
      { code: '23514' },
    );
  }));

test('restricted runtime role works with the S2 grants and cannot rewrite config or journals', () =>
  withCloud(async ({ pool, schema, branch, paidOrder, poolAs, setMode }) => {
    const b = await branch('CK-A', { mode: 'edge' });
    const role = 'kitchen_api_' + randomUUID().replaceAll('-', '');
    await pool.query(`CREATE ROLE ${role} NOLOGIN`);
    try {
      await pool.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
      // What the API runtime already holds for commerce (checkout-grants.mjs) plus 053 and 054.
      await pool.query(
        `GRANT SELECT ON commerce_orders,commerce_captures,commerce_refunds,commerce_cancellation_intents,branches TO ${role}`,
      );
      await pool.query(`GRANT UPDATE(state,version,updated_at) ON commerce_orders TO ${role}`);
      const runtime = new CloudKitchen(poolAs(role));
      const orderId = await paidOrder(b);
      await assert.rejects(runtime.admitPaidOrder(orderId), { code: '42501' }, 'no grants yet');
      await pool.query(channelNumberGrants(role, true));
      await pool.query(cloudKitchenGrants(role, true));
      const runtimePool = poolAs(role);
      await runtimePool.query('SELECT * FROM cloud_kitchen_set_mode($1,$2,$3,$4)', [
        b.id,
        'cloud',
        'synthetic-manager',
        'Runtime switch',
      ]);
      const admitted = await runtime.admitPaidOrder(orderId);
      assert.equal(admitted.outcome, 'admitted');
      const done = await runtime.act(b.manager, key(), {
        orderId,
        expectedVersion: 1,
        action: 'complete_station',
        stationId: b.prep,
      });
      assert.equal(done.state, 'in_production');
      await runtime.listKitchen(b.cook, { stationId: b.prep });
      assert.equal((await runtime.readDisplay(b.packer)).items.length, 1);
      for (const sql of [
        "UPDATE branch_channel_modes SET cloud_channels_owner='edge'",
        `INSERT INTO cloud_kitchen_stations(branch_id,id,kind,name) VALUES('${b.id}',gen_random_uuid(),'prep','x')`,
        'UPDATE cloud_kitchen_config SET active_routing_version=1',
        'DELETE FROM cloud_kitchen_orders',
        'DELETE FROM cloud_kitchen_commands',
        "UPDATE cloud_kitchen_admissions SET channel='mobile'",
        'TRUNCATE cloud_kitchen_outbox',
        'UPDATE channel_number_holds SET released_at=clock_timestamp()',
      ])
        await assert.rejects(runtimePool.query(sql), { code: '42501' }, sql);
      await pool.query(cloudKitchenGrants(role, false));
      await assert.rejects(runtime.listStations(b.manager), { code: '42501' }, 'revoked');
      assert.equal((await setMode(b.id, 'edge')).epoch, 2);
    } finally {
      await pool.query(`DROP OWNED BY ${role}`);
      await pool.query(`DROP ROLE ${role}`);
    }
  }));

const EVENT = {
  task_changed: 'cloud_kitchen.task_changed',
  ready: 'cloud_kitchen.ready',
  handed_over: 'cloud_kitchen.handed_over',
  cancelled: 'cloud_kitchen.cancelled',
};
function random(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const snapshot = (t) => ({ id: t.id, stationId: t.station_id, state: t.state, version: t.version });
// Same prediction as packages/edge-fulfillment/tests/state-machine-vectors.test.mjs.
function predict(order, command, manager, assemblyStationId) {
  const version = checkVersion(order.version, command.expectedVersion);
  if (!version.ok) return version;
  const shape = commandShape(command);
  if (!shape.ok) return shape;
  const tasks = order.tasks.map(snapshot);
  if (shape.value.kind === 'station')
    return planCompleteStation({
      order: order.state,
      assemblyStationId,
      stationId: shape.value.stationId,
      tasks,
    });
  if (shape.value.kind === 'task') {
    const task = tasks.find((t) => t.id === shape.value.taskId);
    if (!task) return { ok: false, code: 'NOT_FOUND' };
    return planTask({
      action: shape.value.action,
      order: order.state,
      task,
      expectedTaskVersion: shape.value.expectedTaskVersion,
    });
  }
  if (shape.value.action === 'confirm_cancel')
    return planConfirmCancel({
      order: order.state,
      manager,
      reason: command.reason,
      inventoryDisposition: command.inventoryDisposition,
      tasks,
    });
  if (shape.value.action === 'ready') return planReady({ order: order.state, tasks });
  return planHandoff({ order: order.state });
}

test('cloud kitchen commands equal the shared state machine on random transition walks', (t) =>
  withCloud(async ({ repo, branch, paidOrder, read, outbox, hold }) => {
    const b = await branch('CK-VEC');
    const next = random(20261011);
    const pick = (list) => list[Math.floor(next() * list.length)];
    const chance = (p) => next() < p;
    const tally = { applied: 0, rejected: {}, replayed: 0, cancels: 0 };
    const orders = [];
    for (let i = 0; i < 8; i++) {
      const orderId = await paidOrder(b, {
        lines:
          i % 3 === 2
            ? [{ productId: 'drink', quantity: 1 }]
            : [
                { productId: 'burger', quantity: 1 },
                { productId: 'fries', quantity: 2 },
                { productId: 'drink', quantity: 1 },
              ],
      });
      await repo.admitPaidOrder(orderId);
      orders.push(orderId);
    }
    for (const orderId of orders)
      for (let step = 0; step < 60; step++) {
        const before = await read(orderId);
        if (chance(0.06) && ['accepted', 'in_production'].includes(before.state)) {
          await repo.requestCancel(orderId, {
            branchId: b.id,
            expectedVersion: before.version,
            reason: 'Synthetic cancel',
          });
          tally.cancels++;
          continue;
        }
        const plausible = {
          accepted: ['start_task', 'complete_task', 'complete_station', 'ready'],
          in_production: ['start_task', 'complete_task', 'complete_station', 'ready'],
          ready: ['handoff'],
          cancel_requested: ['confirm_stop', 'confirm_cancel'],
        }[before.state];
        const action = plausible && chance(0.5) ? pick(plausible) : pick(KITCHEN_ACTIONS);
        const command = {
          orderId,
          expectedVersion:
            chance(0.9) || before.version < 2 ? before.version : before.version + pick([-1, 1]),
          action,
        };
        if (['start_task', 'complete_task', 'confirm_stop'].includes(action)) {
          const from =
            { start_task: 'queued', complete_task: 'in_progress' }[action] ?? 'cancel_requested';
          const eligible = before.tasks.filter((x) => x.state === from);
          const task =
            eligible.length && chance(0.7)
              ? pick(eligible)
              : before.tasks.length && chance(0.95)
                ? pick(before.tasks)
                : null;
          if (chance(0.97)) command.taskId = task ? task.id : randomUUID();
          if (chance(0.97))
            command.expectedTaskVersion =
              task && chance(0.9) ? task.version : 1 + Math.floor(next() * 9);
        }
        if (action === 'complete_station' && chance(0.97))
          command.stationId = pick([b.prep, b.assembly]);
        if (action === 'confirm_cancel') {
          if (chance(0.85)) command.reason = 'Synthetic stop';
          if (chance(0.85)) command.inventoryDisposition = 'recorded_elsewhere';
        }
        if (chance(0.03)) command.stationId = b.prep; // misplaced field
        if (chance(0.03)) command.taskId = before.tasks[0]?.id ?? randomUUID();
        const manager = !(action === 'confirm_cancel' && chance(0.2));
        const actor = manager ? b.manager : b.cook;
        const expected = predict(before, command, manager, b.assembly);
        const eventsBefore = await outbox(orderId);
        const k = key();
        let result, error;
        try {
          result = await repo.act(actor, k, command);
        } catch (e) {
          error = e;
        }
        const afterRead = await read(orderId);
        const eventsAfter = await outbox(orderId);
        const label = JSON.stringify({ before, command, expected });
        if (!expected.ok) {
          assert.equal(error?.code, expected.code, label);
          assert.equal(afterRead.version, before.version, label);
          assert.deepEqual(afterRead.tasks, before.tasks, label);
          assert.deepEqual(eventsAfter, eventsBefore, label);
          tally.rejected[expected.code] = (tally.rejected[expected.code] ?? 0) + 1;
          continue;
        }
        assert.equal(error, undefined, label + ' ' + error?.stack);
        tally.applied++;
        const steps = expected.value;
        assert.equal(result.version, before.version + steps.length, label);
        assert.equal(result.state, steps.at(-1).order, label);
        assert.equal(afterRead.state, result.state);
        assert.deepEqual(
          eventsAfter.slice(eventsBefore.length),
          steps.map((s, i) => ({
            event_type: EVENT[s.event],
            aggregate_version: before.version + i + 1,
          })),
          label,
        );
        for (const task of afterRead.tasks) {
          const old = before.tasks.find((x) => x.id === task.id);
          const mine = steps.filter((s) => s.kind === 'task' && s.taskId === task.id);
          assert.equal(task.state, mine.at(-1)?.to ?? old.state, label);
          assert.equal(task.version, mine.at(-1)?.taskVersion ?? old.version, label);
        }
        // The number is released exactly when the order leaves the kitchen for good.
        const released = (await hold(orderId)).released_at !== null;
        assert.equal(released, ['handed_over', 'cancelled'].includes(result.state), label);
        if (chance(0.3)) {
          assert.deepEqual(await repo.act(actor, k, command), result);
          await assert.rejects(
            repo.act(actor, k, { ...command, expectedVersion: command.expectedVersion + 1 }),
            codeOf('CONFLICT'),
          );
          assert.deepEqual(await outbox(orderId), eventsAfter);
          tally.replayed++;
        }
      }
    t.diagnostic(JSON.stringify(tally));
    assert.ok(tally.applied >= 20, JSON.stringify(tally));
    for (const code of ['INVALID', 'CONFLICT', 'NOT_READY', 'NOT_FOUND', 'FORBIDDEN'])
      assert.ok(tally.rejected[code] > 0, JSON.stringify(tally));
    assert.ok(tally.replayed > 0 && tally.cancels > 0, JSON.stringify(tally));
  }));
