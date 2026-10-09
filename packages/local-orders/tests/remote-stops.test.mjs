import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createPool } from '@pickchick/database';
import { applyMenu, hashJson, effectiveLocalStops } from '@pickchick/menu-sync';
import { fixture } from '../../edge-fulfillment/tests/fixture.mjs';
import { applyEdgeRuntimeGrants } from '../../../infra/windows/edge-runtime-grants.mjs';
import { createEdge } from '../../../services/edge/dist/index.js';
import {
  applyRemoteStops,
  remoteStopsReady,
  setStop,
  readStop,
  openCashShift,
  closeCashShift,
  provisionStaff,
  REMOTE_STOP_MAX_AGE_SECONDS,
} from '../dist/index.js';

const code = (expected) => (error) => error.code === expected;
const variant = randomUUID(),
  option = randomUUID();

async function activeMenu(pool, branchId) {
  const menu = {
    schema_version: 1,
    release_id: randomUUID(),
    branch_id: branchId,
    version: 1,
    published_at: '2026-10-01T00:00:00Z',
    items: [
      {
        product_id: randomUUID(),
        variant_id: variant,
        category_id: randomUUID(),
        name: { ru: 'Синтетический бургер', kk: 'Синтетикалық бургер' },
        price_minor: '150000',
        currency: 'KZT',
        modifier_groups: [
          {
            id: randomUUID(),
            name: { ru: 'Соус', kk: 'Тұздық' },
            min_selected: 0,
            max_selected: 1,
            options: [{ id: option, name: { ru: 'Сырный', kk: 'Ірімшік' }, price_minor: '0' }],
          },
        ],
      },
    ],
  };
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
}
/** What the fulfillment worker writes into the inbox (it cannot set received_at in production). */
async function receive(pool, branchId, patch = {}) {
  const command = {
    command_id: randomUUID(),
    variant_id: variant,
    stopped: true,
    duration: 'manual',
    reason: 'Синтетический стоп из бэк-офиса',
    expected_version: 0,
    actor_label: 'Synthetic manager',
    ...patch,
  };
  await pool.query(
    `INSERT INTO remote_stop_commands(command_id,branch_id,variant_id,stopped,duration,reason,expected_version,actor_label,issued_at,received_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp(),COALESCE($9::timestamptz,clock_timestamp())) ON CONFLICT DO NOTHING`,
    [
      command.command_id,
      branchId,
      command.variant_id,
      command.stopped,
      command.duration,
      command.reason,
      command.expected_version,
      command.actor_label,
      command.received_at ?? null,
    ],
  );
  return command.command_id;
}
const stopRow = async (pool, branchId, id = variant) =>
  (
    await pool.query('SELECT * FROM local_stops WHERE branch_id=$1 AND variant_id=$2', [
      branchId,
      id,
    ])
  ).rows[0];
const inbox = async (pool, id) =>
  (await pool.query('SELECT * FROM remote_stop_commands WHERE command_id=$1', [id])).rows[0];

/** The real least-privilege edge runtime role used by the Windows edge service. */
async function runtime(ctx, run) {
  const role = 'edge_runtime_' + randomUUID().replaceAll('-', '');
  const password = randomBytes(32).toString('hex');
  let pool;
  try {
    await ctx.admin.query(
      `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
    );
    await applyEdgeRuntimeGrants(ctx.pool, role, { schema: ctx.schema, fulfillment: true });
    const url = new URL(ctx.url);
    url.username = role;
    url.password = password;
    url.searchParams.set('options', `-c search_path=${ctx.schema}`);
    pool = createPool(url.toString(), 2);
    await run(pool, role);
  } finally {
    if (pool) await pool.end();
    await ctx.admin.query(`DROP OWNED BY ${role}`);
    await ctx.admin.query(`DROP ROLE ${role}`);
  }
}

test('runtime role applies a remote stop like the POS, with source and audit, and nothing more', () =>
  fixture(async (ctx) => {
    const branch = ctx.scope.branchId;
    await activeMenu(ctx.pool, branch);
    await runtime(ctx, async (pool) => {
      assert.equal(await remoteStopsReady(pool), true);
      const id = await receive(ctx.pool, branch);
      assert.deepEqual(await applyRemoteStops(pool, branch), [
        { commandId: id, state: 'applied', version: 1 },
      ]);
      const stop = await stopRow(ctx.pool, branch);
      assert.equal(stop.stopped, true);
      assert.equal(stop.source, 'backoffice');
      assert.equal(stop.updated_by, null);
      assert.equal(stop.expires_at, null);
      assert.deepEqual(await effectiveLocalStops(ctx.pool, branch), [variant]);
      const command = await inbox(ctx.pool, id);
      assert.equal(command.state, 'applied');
      assert.equal(command.result_version, 1);
      assert.ok(command.applied_at);
      assert.equal(command.reported_at, null);
      const events = (await ctx.pool.query('SELECT * FROM local_stop_events')).rows;
      assert.equal(events.length, 1);
      assert.equal(events[0].source, 'backoffice');
      assert.equal(events[0].command_id, id);
      assert.equal(events[0].actor_label, 'Synthetic manager');
      assert.equal(events[0].staff_id, null);
      assert.equal(events[0].version, 1);
      assert.equal(events[0].duration, 'manual');
      // The POS sees it with the version it needs for its own next change.
      assert.deepEqual(await readStop(pool, branch, ctx.cashier.auth, variant), {
        variant_id: variant,
        stopped: true,
        version: 1,
      });
      // The cashier lifts it: POS source and staff are recorded in the same history.
      await setStop(pool, branch, ctx.cashier.auth, randomUUID(), {
        variant_id: variant,
        expected_version: 1,
        stopped: false,
        reason: 'Снова в наличии',
      });
      const lifted = await stopRow(ctx.pool, branch);
      assert.equal(lifted.source, 'pos');
      assert.equal(lifted.updated_by, ctx.cashier.staff_id);
      const history = (await ctx.pool.query('SELECT * FROM local_stop_events ORDER BY version'))
        .rows;
      assert.deepEqual(
        history.map((e) => [e.version, e.stopped, e.source, e.staff_id]),
        [
          [1, true, 'backoffice', null],
          [2, false, 'pos', ctx.cashier.staff_id],
        ],
      );
      for (const sql of [
        'DELETE FROM remote_stop_commands',
        "UPDATE remote_stop_commands SET reason='x'",
        'UPDATE remote_stop_commands SET reported_at=now()',
        'DELETE FROM local_stop_events',
        "UPDATE local_stop_events SET reason='x'",
        `INSERT INTO remote_stop_commands(command_id,branch_id,variant_id,stopped,duration,reason,expected_version,actor_label,issued_at) VALUES('${randomUUID()}','${branch}','${variant}',true,'manual','x',0,'x',now())`,
      ])
        await assert.rejects(pool.query(sql), code('42501'));
      // Schema guards hold even for the owner: verdicts are final and history is append-only.
      await assert.rejects(
        ctx.pool.query("UPDATE remote_stop_commands SET state='conflict'"),
        code('23514'),
      );
      await assert.rejects(ctx.pool.query('DELETE FROM local_stop_events'), code('23514'));
      await assert.rejects(ctx.pool.query('DELETE FROM remote_stop_commands'), code('23514'));
    });
  }));

test('version CAS conflict, unknown variant and expired command never touch local_stops', () =>
  fixture(async (ctx) => {
    const branch = ctx.scope.branchId;
    await activeMenu(ctx.pool, branch);
    await setStop(ctx.pool, branch, ctx.cashier.auth, randomUUID(), {
      variant_id: option,
      expected_version: 0,
      stopped: true,
      reason: 'Закончился соус',
    });
    const before = await stopRow(ctx.pool, branch, option);
    const conflict = await receive(ctx.pool, branch, { variant_id: option, stopped: false });
    const missing = await receive(ctx.pool, branch, { variant_id: randomUUID() });
    const stale = await receive(ctx.pool, branch, {
      received_at: new Date(Date.now() - (REMOTE_STOP_MAX_AGE_SECONDS + 5) * 1000).toISOString(),
    });
    const results = await applyRemoteStops(ctx.pool, branch);
    assert.deepEqual(
      results.sort((a, b) => a.commandId.localeCompare(b.commandId)),
      [
        { commandId: conflict, state: 'conflict', version: 1 },
        { commandId: missing, state: 'not_found', version: null },
        { commandId: stale, state: 'expired', version: null },
      ].sort((a, b) => a.commandId.localeCompare(b.commandId)),
    );
    assert.deepEqual(await stopRow(ctx.pool, branch, option), before);
    assert.equal(await stopRow(ctx.pool, branch), undefined);
    assert.equal(
      (await ctx.pool.query("SELECT count(*) FROM local_stop_events WHERE source='backoffice'"))
        .rows[0].count,
      '0',
    );
    // The POS stop wrote its own history row.
    assert.equal(
      (await ctx.pool.query("SELECT count(*) FROM local_stop_events WHERE source='pos'")).rows[0]
        .count,
      '1',
    );
    // Nothing left: the idle check does no work and takes no branch lock.
    assert.deepEqual(await applyRemoteStops(ctx.pool, branch), []);
  }));

test('shift stop needs an open register shift and lapses when it closes', () =>
  fixture(async (ctx) => {
    const branch = ctx.scope.branchId;
    await activeMenu(ctx.pool, branch);
    const early = await receive(ctx.pool, branch, { duration: 'shift' });
    assert.deepEqual(await applyRemoteStops(ctx.pool, branch), [
      { commandId: early, state: 'no_open_shift', version: null },
    ]);
    const register = await provisionStaff(ctx.pool, branch, {
      staff_id: randomUUID(),
      terminal_id: ctx.cashier.terminal_id,
      name: 'Synthetic register manager',
      role: 'shift_manager',
    });
    const auth = { sessionId: register.session_id, token: register.token };
    const shift = await openCashShift(ctx.pool, branch, auth, randomUUID(), {
      opening_cash_minor: '0',
    });
    const id = await receive(ctx.pool, branch, { duration: 'shift' });
    assert.deepEqual(await applyRemoteStops(ctx.pool, branch), [
      { commandId: id, state: 'applied', version: 1 },
    ]);
    assert.equal((await stopRow(ctx.pool, branch)).expires_shift_id, shift.shift_id);
    assert.deepEqual(await effectiveLocalStops(ctx.pool, branch), [variant]);
    await closeCashShift(ctx.pool, branch, auth, randomUUID(), shift.shift_id, {
      expected_version: 1,
      counted_cash_minor: '0',
      reason: 'Synthetic close',
    });
    assert.deepEqual(await effectiveLocalStops(ctx.pool, branch), []);
    // An hour stop uses the edge clock, exactly like the POS.
    const hour = await receive(ctx.pool, branch, { duration: 'hour', expected_version: 1 });
    assert.deepEqual(await applyRemoteStops(ctx.pool, branch), [
      { commandId: hour, state: 'applied', version: 2 },
    ]);
    const timed = (
      await ctx.pool.query(
        "SELECT expires_at BETWEEN clock_timestamp()+interval '59 minutes' AND clock_timestamp()+interval '61 minutes' AS hour, expires_shift_id FROM local_stops WHERE variant_id=$1",
        [variant],
      )
    ).rows[0];
    assert.equal(timed.hour, true);
    assert.equal(timed.expires_shift_id, null);
  }));

test('re-delivered command is applied once', () =>
  fixture(async (ctx) => {
    const branch = ctx.scope.branchId;
    await activeMenu(ctx.pool, branch);
    const id = randomUUID();
    await receive(ctx.pool, branch, { command_id: id });
    assert.equal((await applyRemoteStops(ctx.pool, branch)).length, 1);
    await receive(ctx.pool, branch, { command_id: id });
    await receive(ctx.pool, branch, { command_id: id, stopped: false });
    assert.deepEqual(await applyRemoteStops(ctx.pool, branch), []);
    assert.equal((await stopRow(ctx.pool, branch)).version, 1);
    assert.equal((await stopRow(ctx.pool, branch)).stopped, true);
    assert.equal(
      (await ctx.pool.query('SELECT count(*) FROM local_stop_events')).rows[0].count,
      '1',
    );
  }));

test('POS stop keeps working for a runtime role without the schema019 grants', () =>
  fixture(async (ctx) => {
    const branch = ctx.scope.branchId;
    await activeMenu(ctx.pool, branch);
    await runtime(ctx, async (pool, role) => {
      await ctx.pool.query(`REVOKE INSERT ON local_stop_events FROM ${role}`);
      assert.equal(await remoteStopsReady(pool), false);
      await setStop(pool, branch, ctx.cashier.auth, randomUUID(), {
        variant_id: variant,
        expected_version: 0,
        stopped: true,
        reason: 'Кассир',
      });
      assert.equal((await stopRow(ctx.pool, branch)).stopped, true);
      assert.equal(
        (await ctx.pool.query('SELECT count(*) FROM local_stop_events')).rows[0].count,
        '0',
      );
    });
  }));

test('edge service applies the inbox only when EDGE_REMOTE_STOPS_ENABLED', () =>
  fixture(async (ctx) => {
    const branch = ctx.scope.branchId;
    await activeMenu(ctx.pool, branch);
    const config = {
      service: 'edge',
      environment: 'test',
      databaseUrl: ctx.url,
      port: 0,
      branchId: branch,
    };
    const off = await createEdge(config);
    await off.init();
    const idle = await receive(ctx.pool, branch);
    await delay(1200);
    assert.equal((await inbox(ctx.pool, idle)).state, 'received');
    await off.close();
    const on = await createEdge({ ...config, remoteStopsEnabled: true });
    try {
      await on.init();
      let state;
      for (let i = 0; i < 40 && state !== 'applied'; i++) {
        await delay(100);
        state = (await inbox(ctx.pool, idle)).state;
      }
      assert.equal(state, 'applied');
    } finally {
      await on.close();
    }
  }));
