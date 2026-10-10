import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';
import { createPool, migrate } from '@pickchick/database';
import { loadConfig } from '@pickchick/platform';
import { channelNumberGrants } from '../../infra/staging/channel-number-grants.mjs';

// Cloud migration 053 (ADR-0014): channel display numbers. No runtime wiring yet.
const admin = createPool(loadConfig('api').databaseUrl);
after(() => admin.end());
const migrations = fileURLToPath(new URL('../../db/cloud/migrations/', import.meta.url));

async function withCloud(run) {
  const schema = `channel_numbers_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(loadConfig('api').databaseUrl);
  url.searchParams.set('options', `-c search_path=${schema}`);
  const pool = createPool(url.toString(), 24);
  try {
    await migrate(pool, migrations, 'cloud');
    const org = randomUUID(),
      legal = randomUUID();
    await pool.query("INSERT INTO organizations(id,name) VALUES($1,'Channel numbers synthetic')", [
      org,
    ]);
    await pool.query(
      "INSERT INTO legal_entities(id,organization_id,name,bin) VALUES($1,$2,'Synthetic','000000000000')",
      [legal, org],
    );
    const branch = async (code) => {
      const id = randomUUID();
      await pool.query(
        "INSERT INTO branches(id,organization_id,legal_entity_id,code,name) VALUES($1,$2,$3,$4,'Synthetic')",
        [id, org, legal, code],
      );
      return id;
    };
    const allocate = async (branchId, channel, orderId = randomUUID(), client = pool) => ({
      orderId,
      ...(
        await client.query(
          'SELECT outcome,display_number,shift_epoch::int AS shift_epoch FROM channel_number_allocate($1,$2,$3)',
          [branchId, channel, orderId],
        )
      ).rows[0],
    });
    const release = async (orderId) =>
      (await pool.query('SELECT channel_number_release($1) AS released', [orderId])).rows[0]
        .released;
    const openShift = async (branchId, key) =>
      (
        await pool.query(
          'SELECT epoch::int AS epoch,opened FROM channel_number_open_shift($1,$2)',
          [branchId, key],
        )
      ).rows[0];
    await run({ pool, schema, branch, allocate, release, openShift });
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  }
}

test('kiosk and mobile allocate inside their own ranges, idempotently per order', () =>
  withCloud(async ({ pool, branch, allocate }) => {
    const a = await branch('CH-A');
    const first = await allocate(a, 'kiosk');
    assert.deepEqual(
      { outcome: first.outcome, n: first.display_number, e: first.shift_epoch },
      { outcome: 'allocated', n: 300, e: 0 },
    );
    assert.equal((await allocate(a, 'kiosk')).display_number, 301);
    assert.equal((await allocate(a, 'mobile')).display_number, 600);
    assert.equal((await allocate(a, 'mobile')).display_number, 601);
    // Same order again: the same number, no new hold and no counter movement.
    const again = await allocate(a, 'kiosk', first.orderId);
    assert.deepEqual([again.outcome, again.display_number], ['existing', 300]);
    assert.equal((await allocate(a, 'kiosk')).display_number, 302);
    // One order never holds numbers in two channels or branches.
    await assert.rejects(allocate(a, 'mobile', first.orderId), { code: '55000' });
    await assert.rejects(allocate(await branch('CH-B'), 'kiosk', first.orderId), {
      code: '55000',
    });
    for (const channel of ['pos', 'aggregator', null])
      await assert.rejects(allocate(a, channel), { code: '22023' });
    await assert.rejects(allocate(randomUUID(), 'kiosk'), { code: '23503' });
    assert.equal(
      Number((await pool.query('SELECT count(*) FROM channel_number_holds')).rows[0].count),
      5,
    );
  }));

test('parallel allocations on one branch channel are unique and contiguous', () =>
  withCloud(async ({ pool, branch, allocate }) => {
    const a = await branch('CH-A');
    const results = await Promise.all(Array.from({ length: 60 }, () => allocate(a, 'kiosk')));
    const numbers = results.map((r) => r.display_number).sort((x, y) => x - y);
    assert.ok(results.every((r) => r.outcome === 'allocated'));
    assert.deepEqual(
      numbers,
      Array.from({ length: 60 }, (_, i) => 300 + i),
    );
    // Parallel retries of one order converge on one number.
    const orderId = randomUUID();
    const same = await Promise.all(
      Array.from({ length: 10 }, () => allocate(a, 'mobile', orderId)),
    );
    assert.equal(new Set(same.map((r) => r.display_number)).size, 1);
    assert.deepEqual(same.map((r) => r.outcome).sort(), [
      'allocated',
      ...Array(9).fill('existing'),
    ]);
    assert.equal(
      (
        await pool.query('SELECT last_number FROM channel_number_counters WHERE channel=$1', [
          'kiosk',
        ])
      ).rows[0].last_number,
      359,
    );
  }));

test('wraps inside the range, skips active numbers and refuses when all 300 are held', () =>
  withCloud(async ({ pool, branch, allocate, release }) => {
    const a = await branch('CH-A');
    const held = [];
    for (let i = 0; i < 300; i++) held.push(await allocate(a, 'kiosk'));
    assert.deepEqual([held[0].display_number, held.at(-1).display_number], [300, 599]);
    const full = await allocate(a, 'kiosk');
    assert.deepEqual([full.outcome, full.display_number], ['not_ready', null]);
    // Refusal creates no hold and does not move the counter.
    assert.equal(
      Number(
        (
          await pool.query('SELECT count(*) FROM channel_number_holds WHERE order_id=$1', [
            full.orderId,
          ])
        ).rows[0].count,
      ),
      0,
    );
    assert.equal((await allocate(a, 'mobile')).display_number, 600, 'other channel unaffected');
    // Free 310 and 305: the next numbers wrap past 599 to the lowest free after the last issued.
    assert.equal(await release(held[10].orderId), true);
    assert.equal(await release(held[10].orderId), false, 'release is idempotent');
    assert.equal(await release(held[5].orderId), true);
    assert.equal((await allocate(a, 'kiosk')).display_number, 305);
    assert.equal((await allocate(a, 'kiosk')).display_number, 310);
    assert.equal((await allocate(a, 'kiosk')).outcome, 'not_ready');
    // Released holds keep their history; a released order cannot take a new number.
    await assert.rejects(allocate(a, 'kiosk', held[5].orderId), { code: '55000' });
    assert.equal(
      Number(
        (await pool.query('SELECT count(*) FROM channel_number_holds WHERE display_number=305'))
          .rows[0].count,
      ),
      2,
    );
  }));

test('shift open restarts numbering once per shift key and keeps active numbers held', () =>
  withCloud(async ({ pool, branch, allocate, release, openShift }) => {
    const a = await branch('CH-A');
    const before = [];
    for (let i = 0; i < 5; i++) before.push(await allocate(a, 'kiosk'));
    await release(before[0].orderId);
    await release(before[2].orderId);
    assert.deepEqual(await openShift(a, 'shift-1'), { epoch: 1, opened: true });
    // 300 and 302 were released; 301, 303, 304 are still on the display and are skipped.
    const after1 = [];
    for (let i = 0; i < 4; i++) after1.push(await allocate(a, 'kiosk'));
    assert.deepEqual(
      after1.map((r) => [r.display_number, r.shift_epoch]),
      [
        [300, 1],
        [302, 1],
        [305, 1],
        [306, 1],
      ],
    );
    assert.equal((await allocate(a, 'mobile')).display_number, 600);
    // Redelivered event (offline cashier reconnecting, retries): no second reset.
    assert.deepEqual(await openShift(a, 'shift-1'), { epoch: 1, opened: false });
    assert.equal((await allocate(a, 'kiosk')).display_number, 307);
    assert.deepEqual(await openShift(a, 'shift-2'), { epoch: 2, opened: true });
    const next = await allocate(a, 'kiosk');
    assert.deepEqual([next.display_number, next.shift_epoch], [308, 2]);
    // 300-307 are all held again, so the restarted counter skips to 308.
    // A late redelivery of an older shift never resets numbering.
    assert.deepEqual(await openShift(a, 'shift-1'), { epoch: 1, opened: false });
    assert.equal((await allocate(a, 'kiosk')).display_number, 309);
    // Mobile restarted at 600 with shift-2, but 600 is still held.
    assert.equal((await allocate(a, 'mobile')).display_number, 601);
    // Concurrent deliveries of one new shift key open it exactly once.
    const opened = await Promise.all(Array.from({ length: 8 }, () => openShift(a, 'shift-3')));
    assert.deepEqual(opened.map((r) => r.opened).sort(), [
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      true,
    ]);
    assert.ok(opened.every((r) => r.epoch === 3));
    assert.deepEqual(
      (await pool.query('SELECT shift_key,epoch::int FROM channel_number_shifts ORDER BY epoch'))
        .rows,
      [
        { shift_key: 'shift-1', epoch: 1 },
        { shift_key: 'shift-2', epoch: 2 },
        { shift_key: 'shift-3', epoch: 3 },
      ],
    );
    await assert.rejects(openShift(a, ''), { code: '23514' });
    await assert.rejects(openShift(randomUUID(), 'x'), { code: '23503' });
  }));

test('branches are isolated: counters, holds and shift resets never cross', () =>
  withCloud(async ({ branch, allocate, openShift }) => {
    const a = await branch('CH-A'),
      b = await branch('CH-B');
    const parallel = await Promise.all(
      Array.from({ length: 40 }, (_, i) => allocate(i % 2 ? a : b, 'kiosk')),
    );
    for (const id of [a, b])
      assert.deepEqual(
        parallel
          .filter((_, i) => (i % 2 ? a : b) === id)
          .map((r) => r.display_number)
          .sort((x, y) => x - y),
        Array.from({ length: 20 }, (_, i) => 300 + i),
      );
    assert.deepEqual(await openShift(a, 'same-key'), { epoch: 1, opened: true });
    assert.deepEqual(await openShift(b, 'same-key'), { epoch: 1, opened: true });
    await openShift(a, 'a-2');
    const fromB = await allocate(b, 'kiosk');
    assert.deepEqual([fromB.display_number, fromB.shift_epoch], [320, 1]);
    const fromA = await allocate(a, 'kiosk');
    assert.deepEqual([fromA.display_number, fromA.shift_epoch], [320, 2]);
  }));

test('database constraints keep ranges, holds and history intact', () =>
  withCloud(async ({ pool, branch, allocate }) => {
    const a = await branch('CH-A');
    const hold = await allocate(a, 'kiosk');
    for (const sql of [
      "UPDATE channel_number_ranges SET low=1 WHERE channel='kiosk'",
      "INSERT INTO channel_number_ranges(channel,low,high) VALUES('pos',1,299)",
      "UPDATE channel_number_counters SET last_number=600 WHERE channel='kiosk'",
      'UPDATE channel_number_holds SET display_number=301',
      'DELETE FROM channel_number_holds',
    ])
      await assert.rejects(pool.query(sql), { code: '23514' }, sql);
    await assert.rejects(
      pool.query(
        "INSERT INTO channel_number_holds(order_id,branch_id,channel,display_number,shift_epoch) VALUES($1,$2,'mobile',300,0)",
        [randomUUID(), a],
      ),
      { code: '23514' },
    );
    await assert.rejects(
      pool.query(
        "INSERT INTO channel_number_holds(order_id,branch_id,channel,display_number,shift_epoch) VALUES($1,$2,'kiosk',300,0)",
        [randomUUID(), a],
      ),
      { code: '23505' },
    );
    await pool.query(
      'UPDATE channel_number_holds SET released_at=clock_timestamp() WHERE order_id=$1',
      [hold.orderId],
    );
    await assert.rejects(
      pool.query('UPDATE channel_number_holds SET released_at=NULL WHERE order_id=$1', [
        hold.orderId,
      ]),
      { code: '23514' },
    );
  }));

test('restricted runtime role reads and calls the functions but cannot write tables', () =>
  withCloud(async ({ pool, schema, branch }) => {
    const a = await branch('CH-A');
    const role = 'channel_api_' + randomUUID().replaceAll('-', '');
    await pool.query(`CREATE ROLE ${role} NOLOGIN`);
    const client = await pool.connect();
    try {
      await pool.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
      const asRuntime = async (sql, params = []) => {
        await client.query('BEGIN');
        try {
          await client.query(`SET LOCAL ROLE ${role}`);
          const result = await client.query(sql, params);
          await client.query('COMMIT');
          return result;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      };
      const call = () =>
        asRuntime('SELECT * FROM channel_number_allocate($1,$2,$3)', [a, 'kiosk', randomUUID()]);
      await assert.rejects(call(), { code: '42501' }, 'no access before grants');
      await pool.query(channelNumberGrants(role, true));
      assert.equal((await call()).rows[0].display_number, 300);
      assert.equal(
        (await asRuntime('SELECT epoch::int FROM channel_number_open_shift($1,$2)', [a, 'k']))
          .rows[0].epoch,
        1,
      );
      assert.equal(
        (await asRuntime('SELECT count(*)::int AS n FROM channel_number_holds')).rows[0].n,
        1,
      );
      for (const sql of [
        "UPDATE channel_number_counters SET last_number=299 WHERE channel='kiosk'",
        'UPDATE channel_number_holds SET released_at=clock_timestamp()',
        `INSERT INTO channel_number_shifts(branch_id,shift_key,epoch) VALUES('${a}','x',9)`,
        'DELETE FROM channel_number_holds',
      ])
        await assert.rejects(asRuntime(sql), { code: '42501' }, sql);
      const privileges = (
        await pool.query(
          'SELECT table_name,privilege_type FROM information_schema.role_table_grants WHERE grantee=$1 AND table_schema=$2 ORDER BY 1,2',
          [role, schema],
        )
      ).rows;
      assert.deepEqual(
        privileges,
        [
          'channel_number_counters',
          'channel_number_holds',
          'channel_number_ranges',
          'channel_number_shifts',
        ].map((table_name) => ({ table_name, privilege_type: 'SELECT' })),
      );
      await pool.query(channelNumberGrants(role, false));
      await assert.rejects(call(), { code: '42501' }, 'revoked');
    } finally {
      client.release();
      await pool.query(`DROP OWNED BY ${role}`);
      await pool.query(`DROP ROLE ${role}`);
    }
  }));
