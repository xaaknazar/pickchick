// Release fixes 2026-10-19 (audit 1.4): cashier numbers 1-299, again from 1 at every opened
// shift, never shared by two live orders and never in the cloud kiosk/mobile range 300-899.
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { localUnpaidExecution } from '../dist/index.js';
import { fixture, errorCode } from './fixture.mjs';

const number = (order) => Number(order.displayNumber);
async function handOver(f, order) {
  let current = await f.complete(order);
  current = await f.act(current, 'ready', f.packer);
  return f.act(current, 'handoff', f.packer);
}
const openShift = (f) =>
  f.pool.query(
    'INSERT INTO local_cash_shifts(id,branch_id,terminal_id,staff_id,opening_cash_minor) VALUES($1,$2,$3,$4,0)',
    [randomUUID(), f.scope.branchId, f.cashier.terminal_id, f.cashier.staff_id],
  );

test('numbers start at 1, skip live orders and start again from 1 at an opened shift', () =>
  fixture(async (f) => {
    const first = await f.accepted(),
      second = await f.accepted(),
      third = await f.accepted();
    assert.deepEqual(
      [first, second, third].map((x) => number(x.order)),
      [1, 2, 3],
    );
    await handOver(f, first.order);
    // Same day, no new shift: numbering simply continues.
    assert.equal(number((await f.accepted()).order), 4);
    await openShift(f);
    // New shift: from 1 again; 2, 3 and 4 still belong to live orders.
    assert.equal(number((await f.accepted()).order), 1);
    assert.equal(number((await f.accepted()).order), 5);
  }));

test('299 live orders: the next admission is refused until a number frees up; never 300+', () =>
  fixture(async (f) => {
    // Bulk live orders on the stored path (reservation + kitchen admission) without the HTTP cost.
    for (let i = 0; i < 299; i++) await f.accepted();
    const numbers = (
      await f.pool.query('SELECT display_number::int n FROM fulfillment_reservations ORDER BY 1')
    ).rows.map((r) => r.n);
    assert.deepEqual(
      numbers,
      Array.from({ length: 299 }, (_, i) => i + 1),
    );
    // The hold is reserved without a number; its kitchen admission waits for one.
    const command = f.admission(),
      held = await f.repo.acceptCloud(f.scope, command);
    assert.equal(held.displayNumber, null);
    await assert.rejects(
      f.repo.acceptCloud(f.scope, f.authorize(command, held)),
      errorCode('NOT_READY'),
    );
    // A cashier POS admission is refused the same way, as kitchen unavailable.
    const client = await f.pool.connect();
    try {
      await client.query('BEGIN');
      const exec = localUnpaidExecution({ enabled: true, deviceId: f.scope.deviceId });
      await client.query("UPDATE branch_config SET pos_service_mode='unpaid_service'");
      const calls = [];
      const spy = { query: (...args) => (calls.push(String(args[0])), client.query(...args)) };
      await assert.rejects(
        exec.admit(
          spy,
          {
            orderId: randomUUID(),
            branchId: f.scope.branchId,
            quote: {
              quote_id: randomUUID(),
              service_mode: 'takeaway',
              total_minor: '100000',
              lines: [
                {
                  product_id: 'burger',
                  name: { ru: 'Synthetic', kk: '' },
                  quantity: 1,
                  modifiers: [],
                },
              ],
            },
          },
          { staff_id: f.cashier.staff_id },
          randomUUID(),
        ),
        (error) => error.code === 'KITCHEN_UNAVAILABLE',
      );
      // Refused right after the allocator found no free number, before any write.
      assert.match(calls.at(-1), /fulfillment_display_allocate/);
      assert.ok(!calls.some((sql) => /INSERT INTO fulfillment_reservations/.test(sql)));
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    // A forgotten order (no change for 12 hours) gives its number back. The reservation guard
    // allows no such rewrite; the test bypasses it only to age the row.
    const aging = await f.pool.connect();
    try {
      await aging.query('BEGIN');
      await aging.query('SET LOCAL session_replication_role=replica');
      await aging.query(
        "UPDATE fulfillment_reservations SET updated_at=clock_timestamp()-interval '13 hours' WHERE display_number=7",
      );
      await aging.query('COMMIT');
    } finally {
      aging.release();
    }
    const admitted = await f.repo.acceptCloud(f.scope, f.authorize(command, held));
    assert.equal(admitted.displayNumber, '7');
    assert.equal(admitted.state, 'accepted');
  }));

/** Moves one order's last change back in time; the reservation guard allows no such rewrite. */
async function age(f, displayNumber, hours) {
  const client = await f.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL session_replication_role=replica');
    await client.query(
      "UPDATE fulfillment_reservations SET updated_at=clock_timestamp()-$2*interval '1 hour' WHERE display_number=$1",
      [displayNumber, hours],
    );
    await client.query('COMMIT');
  } finally {
    client.release();
  }
}

test('a ready order nobody hands over frees its number after 3 hours and leaves the board', () =>
  fixture(async (f) => {
    // Staff often forget "Выдан": such orders must not use up the 299 cashier numbers.
    const forgotten = await f.accepted(),
      recent = await f.accepted(),
      cooking = await f.accepted();
    for (const { order } of [forgotten, recent])
      await f.act(await f.complete(order), 'ready', f.packer);
    await age(f, 1, 4);
    await age(f, 2, 2);
    await age(f, 3, 4);
    const board = await f.repo.readDisplay(f.scope.branchId);
    assert.deepEqual(
      board.items.map((i) => [i.number, i.state]),
      [
        ['2', 'ready'],
        ['3', 'preparing'],
      ],
    );
    await openShift(f);
    // 1: ready for 4 hours, free again; 2: ready for 2 hours and 3: cooking, both still live.
    assert.equal(number((await f.accepted()).order), 1);
    assert.equal(number((await f.accepted()).order), 4);
    assert.equal(cooking.order.displayNumber, '3');
    assert.equal(recent.order.displayNumber, '2');
  }));
