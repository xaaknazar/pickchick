import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { createPool } from '@pickchick/database';
import { applyMenu, publishMenu } from '@pickchick/menu-sync';
import {
  closeCashShift,
  openCashShift,
  provisionStaff,
  readPosConfig,
  setOrdering,
} from '@pickchick/local-orders';
import {
  CLOUD_SUPPORT_HOURS,
  POS_METHODS,
  PosSalesSetupError,
  disablePosSales,
  enablePosSales,
  parsePosSalesSetupArgs,
  posSalesStatus,
  setPosFiscalPolicy,
} from '../../scripts/pos-sales-setup.mjs';
import { withSyncDatabases } from '../helpers/sync.mjs';
import { staffAuth } from '../helpers/orders.mjs';

// POS-6 operator tool (contracts 00 p.1, 6.1, 6.2): status, enable, disable, fiscal-policy on
// the real schema026. Synthetic data only.
const root = fileURLToPath(new URL('../../', import.meta.url));
const edgeDir = join(root, 'db/edge/migrations');
const ALL = POS_METHODS.join(',');
const refused =
  (code, check = () => true) =>
  (error) =>
    error instanceof PosSalesSetupError && error.code === code && check(error);
const blockers = (error) => error.details.blockers.map((b) => b.code);
const audit = async (pool) =>
  (
    await pool.query(
      'SELECT subject,before,after,actor,reason FROM pos_sales_setting_changes ORDER BY change_sequence',
    )
  ).rows;
const enabledMethods = (view) => view.methods.filter((m) => m.enabled).map((m) => m.code);

test('arguments: four commands, each option exactly once, codes and policies from the enums', () => {
  assert.deepEqual(parsePosSalesSetupArgs(['status']), { command: 'status' });
  assert.deepEqual(
    parsePosSalesSetupArgs([
      'enable',
      '--reason',
      '  Т7 смена  ',
      '--methods',
      'kaspi_terminal,cash',
    ]),
    { command: 'enable', methods: ['cash', 'kaspi_terminal'], reason: 'Т7 смена' },
  );
  assert.deepEqual(
    parsePosSalesSetupArgs(['enable', '--methods', ALL, '--reason', 'Т7 смена']).methods,
    [...POS_METHODS],
  );
  assert.deepEqual(parsePosSalesSetupArgs(['disable', '--reason', 'После Т7']), {
    command: 'disable',
    reason: 'После Т7',
  });
  assert.deepEqual(
    parsePosSalesSetupArgs([
      'fiscal-policy',
      '--method',
      'chocofood',
      '--policy',
      'manual_webkassa',
      '--reason',
      'Решение бухгалтера',
    ]),
    {
      command: 'fiscal-policy',
      method: 'chocofood',
      policy: 'manual_webkassa',
      reason: 'Решение бухгалтера',
    },
  );
  for (const argv of [
    [],
    ['start'],
    ['status', '--reason', 'Лишний ключ'],
    ['enable', '--methods', 'cash'],
    ['enable', '--methods', 'cash', '--reason', 'ab'],
    // The schema026 audit needs 3..300 characters: a bare "Т7" is refused before the database.
    ['enable', '--methods', 'cash', '--reason', ' Т7 '],
    ['enable', '--methods', 'cash', '--reason', 'x'.repeat(301)],
    ['enable', '--methods', 'cash,cash', '--reason', 'Т7 смена'],
    ['enable', '--methods', 'cash,ailillu', '--reason', 'Т7 смена'],
    ['enable', '--methods', '', '--reason', 'Т7 смена'],
    ['enable', '--methods', 'cash', '--reason', 'Т7 смена', '--reason', 'Т8 смена'],
    ['enable', '--methods', 'cash', '--reason'],
    ['disable', '--reason', 'Т7 смена', '--force', 'yes'],
    ['fiscal-policy', '--method', 'cash', '--policy', 'auto', '--reason', 'Т7 смена'],
    ['fiscal-policy', '--method', 'card', '--policy', 'not_required', '--reason', 'Т7 смена'],
    ['fiscal-policy', '--method', 'cash', '--reason', 'Т7 смена'],
  ])
    assert.throws(() => parsePosSalesSetupArgs(argv), refused('INVALID_ARGUMENTS'), argv.join(' '));
});

/** A 026 edge with a menu, a cash desk (cashier and shift manager) and a kitchen screen login. */
async function setupDesk(run, options = {}) {
  await withSyncDatabases(async (ctx) => {
    const pool = ctx.edge.pool;
    const person = (role, terminal = randomUUID()) => ({
      staff_id: randomUUID(),
      terminal_id: terminal,
      name: 'Синтетический сотрудник',
      role,
    });
    const cashier = await provisionStaff(pool, ctx.branch, person('cashier'));
    const manager = await provisionStaff(
      pool,
      ctx.branch,
      person('shift_manager', cashier.terminal_id),
    );
    const cook = await provisionStaff(pool, ctx.branch, person('kitchen'));
    const supported = (hoursAgo) =>
      pool.query(
        `INSERT INTO pos_sale_sync_state(branch_id,last_supported_at) VALUES($1,clock_timestamp()-make_interval(hours=>$2))
         ON CONFLICT(branch_id) DO UPDATE SET last_supported_at=EXCLUDED.last_supported_at,updated_at=clock_timestamp()`,
        [ctx.branch, hoursAgo],
      );
    await run({ ...ctx, pool, cashier, manager, cook, supported });
  }, options);
}

test('status and enable: refused with every blocker and nothing written until all are met', async () => {
  await setupDesk(async (ctx) => {
    const { pool, branch } = ctx;
    const fresh = await posSalesStatus(pool, branch);
    assert.equal(fresh.mode, 'payment_required');
    assert.deepEqual(enabledMethods(fresh), []);
    assert.deepEqual(
      fresh.methods.map((m) => [m.code, m.fiscal_policy]),
      [
        ['cash', 'manual_webkassa'],
        ['kaspi_terminal', 'manual_webkassa'],
        ['aggregator_yandex_eda', 'not_required'],
        ['aggregator_glovo', 'not_required'],
        ['staff_meal', 'not_required'],
        ['marketing', 'not_required'],
        ['kaspi_manual', 'manual_webkassa'],
        ['chocofood', 'not_required'],
      ],
    );
    // The cash desk is the cashier's terminal; the kitchen login's screen is not one.
    assert.deepEqual(
      fresh.cash_desks.map((desk) => [desk.terminal_id, desk.config_fetched]),
      [[ctx.cashier.terminal_id, false]],
    );
    assert.deepEqual(
      fresh.blockers.map((b) => b.code),
      ['CLOUD_NOT_SUPPORTED', 'MENU_NOT_APPLIED', 'DESKS_NOT_UPDATED'],
    );
    assert.equal(fresh.ready_to_enable, false);
    assert.equal(fresh.cloud.supported, false);
    const enable = (methods = POS_METHODS) =>
      enablePosSales(pool, branch, { methods: [...methods], reason: 'Т7 пробная смена' });
    await assert.rejects(
      enable(),
      refused(
        'PRECONDITIONS',
        (e) =>
          blockers(e).join() === 'CLOUD_NOT_SUPPORTED,MENU_NOT_APPLIED,DESKS_NOT_UPDATED' &&
          e.details.cash_desks[0].terminal_id === ctx.cashier.terminal_id,
      ),
    );
    // Menu applied, an open drawer and a stale cloud answer still block.
    const release = ctx.menu();
    await applyMenu(pool, branch, await publishMenu(ctx.cloud.pool, release));
    await setOrdering(pool, branch, staffAuth(ctx.manager), randomUUID(), true, {
      expected_version: 1,
    });
    const shift = await openCashShift(pool, branch, staffAuth(ctx.manager), randomUUID(), {
      opening_cash_minor: '0',
    });
    await ctx.supported(CLOUD_SUPPORT_HOURS + 1);
    await assert.rejects(
      enable(),
      refused(
        'PRECONDITIONS',
        (e) => blockers(e).join() === 'OPEN_SHIFTS,CLOUD_NOT_SUPPORTED,DESKS_NOT_UPDATED',
      ),
    );
    await closeCashShift(pool, branch, staffAuth(ctx.manager), randomUUID(), shift.shift_id, {
      expected_version: 1,
      counted_cash_minor: '0',
      reason: 'Синтетическое закрытие',
    });
    await ctx.supported(1);
    await assert.rejects(
      enable(),
      refused('PRECONDITIONS', (e) => blockers(e).join() === 'DESKS_NOT_UPDATED'),
    );
    assert.deepEqual(await audit(pool), []);
    assert.equal((await posSalesStatus(pool, branch)).mode, 'payment_required');
    // The desk runs the new POS: its GET pos/config is recorded.
    await readPosConfig(pool, branch, staffAuth(ctx.cashier), 'pos-2.1.0');
    const ready = await posSalesStatus(pool, branch);
    assert.equal(ready.ready_to_enable, true);
    assert.deepEqual(ready.cash_desks[0].client_version, 'pos-2.1.0');
    assert.equal(ready.menu.release_id, release.release_id);

    const on = await enable();
    assert.equal(on.mode, 'pos_sale');
    assert.deepEqual(enabledMethods(on), [...POS_METHODS]);
    assert.equal(on.changes.length, 1 + POS_METHODS.length);
    // Every change is audited first, mode before methods, with exact before/after.
    const rows = await audit(pool);
    assert.deepEqual(rows[0], {
      subject: 'pos_service_mode',
      before: { pos_service_mode: 'payment_required' },
      after: { pos_service_mode: 'pos_sale' },
      actor: 'operator',
      reason: 'Т7 пробная смена',
    });
    assert.deepEqual(
      rows.slice(1).map((row) => [row.subject, row.before.enabled, row.after.enabled]),
      POS_METHODS.map((code) => [code, false, true]),
    );
    // Same request again: nothing to change, nothing written.
    assert.deepEqual((await enable()).changes, []);
    assert.equal((await audit(pool)).length, rows.length);
    // A smaller set turns the others off.
    const fewer = await enable(['cash', 'kaspi_terminal', 'kaspi_manual']);
    assert.deepEqual(enabledMethods(fewer), ['cash', 'kaspi_terminal', 'kaspi_manual']);
    assert.equal(fewer.changes.length, 5);
    assert.equal((await audit(pool)).length, rows.length + 5);
  });
});

test('disable: refused while a sales shift is open, then back to the previous mode, all methods off', async () => {
  await setupDesk(async (ctx) => {
    const { pool, branch } = ctx;
    await applyMenu(pool, branch, await publishMenu(ctx.cloud.pool, ctx.menu()));
    await pool.query("UPDATE branch_config SET pos_service_mode='unpaid_service' WHERE id=$1", [
      branch,
    ]);
    await ctx.supported(0);
    await readPosConfig(pool, branch, staffAuth(ctx.cashier));
    await enablePosSales(pool, branch, { methods: [...POS_METHODS], reason: 'Т7 смена' });
    const shift = await openCashShift(pool, branch, staffAuth(ctx.manager), randomUUID(), {
      opening_cash_minor: '0',
    });
    assert.equal(shift.payment_processing_available, true);
    const status = await posSalesStatus(pool, branch);
    assert.deepEqual([status.open_shifts, status.open_sales_shifts], [1, 1]);
    await assert.rejects(
      disablePosSales(pool, branch, { reason: 'Возврат после Т7' }),
      refused('SALES_SHIFT_OPEN', (e) => e.details.open_sales_shifts === 1),
    );
    // The receipt policy is the accountant's and may change during the day (new sales only).
    const before = (await audit(pool)).length;
    const policy = await setPosFiscalPolicy(pool, branch, {
      method: 'chocofood',
      policy: 'manual_webkassa',
      reason: 'Решение бухгалтера',
    });
    assert.equal(
      policy.methods.find((m) => m.code === 'chocofood').fiscal_policy,
      'manual_webkassa',
    );
    assert.deepEqual((await audit(pool)).at(-1), {
      subject: 'chocofood',
      before: { enabled: true, fiscal_policy: 'not_required' },
      after: { enabled: true, fiscal_policy: 'manual_webkassa' },
      actor: 'operator',
      reason: 'Решение бухгалтера',
    });
    assert.deepEqual(
      (
        await setPosFiscalPolicy(pool, branch, {
          method: 'chocofood',
          policy: 'manual_webkassa',
          reason: 'Повтор',
        })
      ).changes,
      [],
    );
    assert.equal((await audit(pool)).length, before + 1);
    await closeCashShift(pool, branch, staffAuth(ctx.manager), randomUUID(), shift.shift_id, {
      expected_version: 1,
      counted_cash_minor: '0',
      reason: 'Синтетическое закрытие',
    });
    const off = await disablePosSales(pool, branch, { reason: 'Возврат после Т7' });
    // Back to the mode before the last switch into pos_sale, every method off, all audited.
    assert.equal(off.mode, 'unpaid_service');
    assert.deepEqual(enabledMethods(off), []);
    assert.equal(off.changes.length, 1 + POS_METHODS.length);
    assert.deepEqual(off.changes[0], {
      subject: 'pos_service_mode',
      before: { pos_service_mode: 'pos_sale' },
      after: { pos_service_mode: 'unpaid_service' },
    });
    // Disabling again changes nothing; the fiscal policy chosen stays for the next enable.
    assert.deepEqual((await disablePosSales(pool, branch, { reason: 'Повтор' })).changes, []);
    assert.equal(
      (await posSalesStatus(pool, branch)).methods.find((m) => m.code === 'chocofood')
        .fiscal_policy,
      'manual_webkassa',
    );
  });
});

test('owner only, 026 only; the CLI prints refusals in Russian and never a credential', async () => {
  const before026 = await mkdtemp(join(tmpdir(), 'pickchick-edge-025-'));
  try {
    for (const name of (await readdir(edgeDir)).filter((n) => n.endsWith('.sql')))
      if (Number(name.slice(0, 3)) <= 25)
        await copyFile(join(edgeDir, name), join(before026, name));
    await withSyncDatabases(
      async (ctx) => {
        await assert.rejects(posSalesStatus(ctx.edge.pool, ctx.branch), refused('NOT_INSTALLED'));
      },
      { edgeMigrationDirectory: before026 },
    );
  } finally {
    await rm(before026, { recursive: true, force: true });
  }
  await setupDesk(async (ctx) => {
    await assert.rejects(posSalesStatus(ctx.pool, randomUUID()), refused('BRANCH_MISSING'));
    // A role that can read everything but owns nothing (the runtime, a worker) is refused.
    const role = `pos_setup_reader_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const schema = ctx.edge.schema;
    await ctx.edge.admin.query(`CREATE ROLE ${role} NOLOGIN`);
    let reader;
    try {
      await ctx.edge.admin.query(
        `GRANT USAGE ON SCHEMA ${schema} TO ${role}; GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO ${role}`,
      );
      const url = new URL(ctx.edge.config.databaseUrl);
      url.searchParams.set('options', `-c search_path=${schema} -c role=${role}`);
      reader = createPool(url.toString());
      await assert.rejects(posSalesStatus(reader, ctx.branch), refused('NOT_OWNER'));
      await assert.rejects(
        enablePosSales(reader, ctx.branch, { methods: ['cash'], reason: 'Т7 смена' }),
        refused('NOT_OWNER'),
      );
    } finally {
      await reader?.end();
      await ctx.edge.admin.query(`DROP OWNED BY ${role}; DROP ROLE ${role}`);
    }
  });
  const run = (args, env) =>
    promisify(execFile)(process.execPath, ['scripts/pos-sales-setup.mjs', ...args], {
      cwd: root,
      env: { PATH: process.env.PATH, ...env },
    }).then(
      () => assert.fail('the CLI must refuse'),
      (error) => error,
    );
  const bad = await run(['enable', '--methods', 'ailillu', '--reason', 'Т7 смена'], {});
  assert.equal(bad.code, 1);
  assert.deepEqual(JSON.parse(bad.stderr), {
    event: 'pos_sales_setup_refused',
    command: 'unknown',
    code: 'INVALID_ARGUMENTS',
    message: 'Неверные аргументы: см. docs/operations/pos-sales.md',
  });
  // A connection the owner tools refuse (URL overrides) fails opaquely: no URL, no password.
  const secret = 'synthetic_secret_value';
  const opaque = await run(['status'], {
    APP_ENV: 'local',
    EDGE_DATABASE_URL: `postgresql://pickchick_local:${secret}@127.0.0.1:55463/pickchick_edge?options=-c%20role%3Dx`,
    CLOUD_DATABASE_URL: `postgresql://pickchick_local:${secret}@127.0.0.1:55462/pickchick_cloud`,
    REDIS_URL: 'redis://127.0.0.1:56379',
    EDGE_BRANCH_ID: randomUUID(),
  });
  assert.equal(opaque.code, 1);
  assert.deepEqual(JSON.parse(opaque.stderr), {
    event: 'pos_sales_setup_failed',
    command: 'status',
  });
  assert.equal(opaque.stdout, '');
  assert.ok(!opaque.stderr.includes(secret));
});
