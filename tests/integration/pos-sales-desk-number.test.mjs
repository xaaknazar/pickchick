import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { createPool, migrate } from '@pickchick/database';
import { createEdge } from '@pickchick/edge';
import { applyMenu, publishMenu } from '@pickchick/menu-sync';
import {
  closeCashShift,
  openCashShift,
  provisionStaff,
  readPosConfig,
} from '@pickchick/local-orders';
import { POS_PAYMENT_METHOD_POLICY, PosConfigSchema } from '@pickchick/contracts';
import {
  DESK_NUMBER_MIGRATION,
  POS_METHODS,
  PosSalesSetupError,
  disablePosSales,
  enablePosSales,
  parsePosSalesSetupArgs,
  posSalesStatus,
  setDeskNumber,
  setPosFiscalPolicy,
} from '../../scripts/pos-sales-setup.mjs';
import { applyEdgeRuntimeGrants } from '../../infra/windows/edge-runtime-grants.mjs';
import { posSalesRuntimeGrants } from '../../infra/windows/pos-sales-grants.mjs';
import { request, running, withSyncDatabases } from '../helpers/sync.mjs';
import { staffAuth, staffHeaders } from '../helpers/orders.mjs';

// Lead decision 07.11 (1), CR client-5 3.2, CR pos-7: the desk number of a cash desk. Edge
// schema028 (local_terminals.desk_number, audit subject 'desk_number'), the owner command
// `pos-sales-setup.mjs desk` and GET pos/config desk_number. Synthetic data only.
const root = fileURLToPath(new URL('../../', import.meta.url));
const edgeDir = join(root, 'db/edge/migrations');
const refused =
  (code, check = () => true) =>
  (error) =>
    error instanceof PosSalesSetupError && error.code === code && check(error);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sqlError = (code, pattern) => (error) =>
  error.code === code && (pattern === undefined || pattern.test(error.message));

/** A migration directory holding the repo files strictly before `limit` (and nothing later). */
async function upTo(base, name, limit) {
  const target = join(base, name);
  await mkdir(target);
  for (const file of await readdir(edgeDir))
    if (/^\d{3}_[a-z_]+\.sql$/.test(file) && file < limit)
      await copyFile(join(edgeDir, file), join(target, file));
  return target;
}
const rows = async (pool, table, order) =>
  (await pool.query(`SELECT row_to_json(t) AS r FROM ${table} t ORDER BY ${order}`)).rows.map(
    (row) => row.r,
  );
const audit = async (pool) =>
  (
    await pool.query(
      'SELECT subject,before,after,actor,reason FROM pos_sales_setting_changes ORDER BY change_sequence',
    )
  ).rows;
const desksOf = (view) =>
  Object.fromEntries(view.cash_desks.map((desk) => [desk.terminal_id, desk.desk_number]));

/** Two cash desks (cashier and shift manager each), a kitchen login, a menu, the cloud answering. */
async function twoDesks(ctx) {
  const pool = ctx.edge.pool;
  const person = (role, terminal = randomUUID()) => ({
    staff_id: randomUUID(),
    terminal_id: terminal,
    name: 'Синтетический сотрудник',
    role,
  });
  const one = await provisionStaff(pool, ctx.branch, person('cashier'));
  const oneManager = await provisionStaff(
    pool,
    ctx.branch,
    person('shift_manager', one.terminal_id),
  );
  const two = await provisionStaff(pool, ctx.branch, person('cashier'));
  const twoManager = await provisionStaff(
    pool,
    ctx.branch,
    person('shift_manager', two.terminal_id),
  );
  await applyMenu(pool, ctx.branch, await publishMenu(ctx.cloud.pool, ctx.menu()));
  await pool.query(
    'INSERT INTO pos_sale_sync_state(branch_id,last_supported_at) VALUES($1,clock_timestamp())',
    [ctx.branch],
  );
  return { one, oneManager, two, twoManager, person };
}

/** Each statement inside one rolled-back transaction of the owner: what the schema answers. */
async function answers(ctx, statements) {
  const client = await ctx.edge.admin.connect();
  const result = [];
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL search_path TO ${ctx.edge.schema}`);
    for (const [sql, params = []] of statements) {
      await client.query('SAVEPOINT probe');
      try {
        await client.query(sql, params);
        result.push('ok');
        await client.query('RELEASE SAVEPOINT probe');
      } catch (error) {
        result.push(error.constraint ? `${error.code} ${error.constraint}` : error.code);
        await client.query('ROLLBACK TO SAVEPOINT probe');
      }
    }
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
  return result;
}

test('desk arguments: --terminal and --reason with exactly one of --number 1..99 or --clear', () => {
  const terminal = randomUUID();
  assert.deepEqual(
    parsePosSalesSetupArgs([
      'desk',
      '--terminal',
      terminal,
      '--number',
      '2',
      '--reason',
      'Касса у окна',
    ]),
    { command: 'desk', terminal_id: terminal, desk_number: 2, reason: 'Касса у окна' },
  );
  // --clear is a bare flag in any position; the UUID is taken in any case, stored lower case.
  assert.deepEqual(
    parsePosSalesSetupArgs([
      'desk',
      '--clear',
      '--terminal',
      terminal.toUpperCase(),
      '--reason',
      '  Замена моноблока ',
    ]),
    { command: 'desk', terminal_id: terminal, desk_number: null, reason: 'Замена моноблока' },
  );
  for (const [text, number] of [
    ['1', 1],
    ['9', 9],
    ['10', 10],
    ['99', 99],
  ])
    assert.equal(
      parsePosSalesSetupArgs(['desk', '--terminal', terminal, '--number', text, '--reason', 'abc'])
        .desk_number,
      number,
    );
  const reason = ['--reason', 'Касса 2'];
  for (const argv of [
    ['desk'],
    ['desk', '--terminal', terminal, '--number', '2'],
    ['desk', '--terminal', terminal, '--number', '2', '--reason', 'ab'],
    ['desk', '--terminal', terminal, '--number', '2', '--reason', 'x'.repeat(301)],
    ['desk', '--terminal', terminal, ...reason],
    ['desk', '--terminal', terminal, '--number', '2', '--clear', ...reason],
    ['desk', '--terminal', terminal, '--clear', '--clear', ...reason],
    ['desk', '--terminal', terminal, '--clear', 'yes', ...reason],
    ['desk', '--number', '2', ...reason],
    ['desk', '--terminal', 'desk-2', '--number', '2', ...reason],
    ['desk', '--terminal', terminal.replaceAll('-', ''), '--number', '2', ...reason],
    ...['0', '100', '01', '1.5', '+2', ' 2', '2 ', 'two', '-1', '', '1e1'].map((number) => [
      'desk',
      '--terminal',
      terminal,
      '--number',
      number,
      ...reason,
    ]),
    ['desk', '--terminal', terminal, '--number', '2', ...reason, '--number', '3'],
    ['desk', '--terminal', terminal, '--number', '2', ...reason, '--methods', 'cash'],
    ['status', '--clear'],
    ['disable', '--clear', ...reason],
    ['fiscal-policy', '--method', 'cash', '--policy', 'not_required', '--clear', ...reason],
  ])
    assert.throws(
      () => parsePosSalesSetupArgs(argv),
      refused('INVALID_ARGUMENTS'),
      JSON.stringify(argv),
    );
});

test('028 on a populated edge (every migration before it): rows and audit unchanged, every desk NULL; CHECK, one active number per branch, guard and audit rule; the runtime reads it with its own grants', async () => {
  const base = await mkdtemp(join(tmpdir(), 'pickchick-desk-number-'));
  try {
    const before028 = await upTo(base, 'edge-before-028', '028');
    const with028 = await upTo(base, 'edge-028', '029');
    await withSyncDatabases(
      async (ctx) => {
        const pool = ctx.edge.pool;
        const desks = await twoDesks(ctx);
        const A = desks.one.terminal_id,
          B = desks.two.terminal_id;
        // History of the schema026 subjects: a pos_sale switch and back, a receipt policy.
        for (const desk of [desks.one, desks.two])
          await readPosConfig(pool, ctx.branch, staffAuth(desk), 'pos-desktop-0.5.0');
        await enablePosSales(pool, ctx.branch, { methods: [...POS_METHODS], reason: 'Т7 смена' });
        await disablePosSales(pool, ctx.branch, { reason: 'Возврат после Т7' });
        await setPosFiscalPolicy(pool, ctx.branch, {
          method: 'chocofood',
          policy: 'manual_webkassa',
          reason: 'Решение бухгалтера',
        });
        // A third desk taken out of service.
        const old = await provisionStaff(pool, ctx.branch, desks.person('cashier'));
        await pool.query('UPDATE local_terminals SET active=false WHERE id=$1', [old.terminal_id]);

        // New code on the schema without 028: null everywhere, `desk` refused, nothing written.
        const ledger = await rows(pool, 'schema_migrations', 'version');
        assert.equal(
          ledger.some((row) => row.version === DESK_NUMBER_MIGRATION),
          false,
        );
        assert.equal(
          (await readPosConfig(pool, ctx.branch, staffAuth(desks.one))).desk_number,
          null,
        );
        assert.deepEqual(desksOf(await posSalesStatus(pool, ctx.branch)), { [A]: null, [B]: null });
        await assert.rejects(
          setDeskNumber(pool, ctx.branch, { terminal_id: A, desk_number: 1, reason: 'Касса 1' }),
          refused('DESK_NOT_INSTALLED'),
        );
        const terminals = await rows(pool, 'local_terminals', 'id');
        const history = await rows(pool, 'pos_sales_setting_changes', 'change_sequence');
        assert.equal(history.length, 1 + 8 + 1 + 8 + 1);
        const constraints = async () =>
          (
            await pool.query(
              `SELECT conname FROM pg_constraint WHERE conrelid='pos_sales_setting_changes'::regclass
               ORDER BY conname`,
            )
          ).rows.map((row) => row.conname);
        const names = await constraints();

        assert.deepEqual(await migrate(pool, with028, 'edge'), [DESK_NUMBER_MIGRATION]);
        assert.deepEqual(await migrate(pool, with028, 'edge'), []);
        const after = await rows(pool, 'schema_migrations', 'version');
        assert.deepEqual(after.slice(0, ledger.length), ledger);
        assert.deepEqual(
          after.slice(ledger.length).map((row) => row.version),
          [DESK_NUMBER_MIGRATION],
        );
        // Every terminal keeps its bytes and gets NULL; the history and its CHECK names stay.
        assert.deepEqual(
          await rows(pool, 'local_terminals', 'id'),
          terminals.map((row) => ({ ...row, desk_number: null })),
        );
        assert.deepEqual(await rows(pool, 'pos_sales_setting_changes', 'change_sequence'), history);
        assert.deepEqual(await constraints(), names);
        assert.deepEqual(desksOf(await posSalesStatus(pool, ctx.branch)), { [A]: null, [B]: null });
        assert.equal(
          (await readPosConfig(pool, ctx.branch, staffAuth(desks.two))).desk_number,
          null,
        );
        // The schema026 subjects keep working on 028.
        assert.equal(
          (
            await setPosFiscalPolicy(pool, ctx.branch, {
              method: 'chocofood',
              policy: 'not_required',
              reason: 'Решение бухгалтера',
            })
          ).changes.length,
          1,
        );

        // The column CHECK and one number per active desk (guard set aside). An edge holds one
        // branch (branch_config is a singleton), the index still names branch_id.
        assert.deepEqual(
          await answers(ctx, [
            ['ALTER TABLE local_terminals DISABLE TRIGGER local_terminal_desk_number_guard'],
            ['UPDATE local_terminals SET desk_number=0 WHERE id=$1', [A]],
            ['UPDATE local_terminals SET desk_number=100 WHERE id=$1', [A]],
            ['UPDATE local_terminals SET desk_number=-1 WHERE id=$1', [A]],
            ['UPDATE local_terminals SET desk_number=99 WHERE id=$1', [A]],
            ['UPDATE local_terminals SET desk_number=1 WHERE id=$1', [A]],
            ['UPDATE local_terminals SET desk_number=1 WHERE id=$1', [B]],
            ['UPDATE local_terminals SET desk_number=1 WHERE id=$1', [old.terminal_id]],
            ['UPDATE local_terminals SET active=true WHERE id=$1', [old.terminal_id]],
            ['UPDATE local_terminals SET desk_number=2 WHERE id=$1', [B]],
            ['UPDATE local_terminals SET desk_number=NULL WHERE id=$1', [B]],
            ['UPDATE local_terminals SET desk_number=2 WHERE id=$1', [old.terminal_id]],
          ]),
          [
            'ok',
            '23514 local_terminals_desk_number_check',
            '23514 local_terminals_desk_number_check',
            '23514 local_terminals_desk_number_check',
            'ok',
            'ok',
            '23505 local_terminals_active_desk_number',
            // A desk out of service keeps its number apart; back in service it may not clash.
            'ok',
            '23505 local_terminals_active_desk_number',
            'ok',
            'ok',
            // The desk out of service may hold the number of an active one (B released 2 above).
            'ok',
          ],
        );
        // The guard: a desk starts without a number; a change only with its own audit row.
        const audited = (terminal, before, after) => [
          `INSERT INTO pos_sales_setting_changes(change_id,branch_id,subject,before,after,actor,reason)
           VALUES ($1,$2,'desk_number',$3,$4,'operator','Синтетика')`,
          [
            randomUUID(),
            ctx.branch,
            { terminal_id: terminal, desk_number: before },
            { terminal_id: terminal, desk_number: after },
          ],
        ];
        assert.deepEqual(
          await answers(ctx, [
            [
              'INSERT INTO local_terminals(id,branch_id,desk_number) VALUES ($1,$2,1)',
              [randomUUID(), ctx.branch],
            ],
            [
              'INSERT INTO local_terminals(id,branch_id) VALUES ($1,$2)',
              [randomUUID(), ctx.branch],
            ],
            ['UPDATE local_terminals SET desk_number=1 WHERE id=$1', [A]],
            audited(A, null, 2),
            ['UPDATE local_terminals SET desk_number=3 WHERE id=$1', [A]],
            ['UPDATE local_terminals SET desk_number=2 WHERE id=$1', [B]],
            ['UPDATE local_terminals SET desk_number=2 WHERE id=$1', [A]],
            ['UPDATE local_terminals SET desk_number=desk_number,active=active WHERE id=$1', [A]],
            ['UPDATE local_terminals SET active=true WHERE id=$1', [A]],
            audited(B, null, 2),
            ['UPDATE local_terminals SET desk_number=2 WHERE id=$1', [B]],
          ]),
          [
            '23514',
            'ok',
            '23514',
            'ok',
            '23514',
            '23514',
            'ok',
            'ok',
            'ok',
            'ok',
            '23505 local_terminals_active_desk_number',
          ],
        );
        await assert.rejects(
          pool.query('UPDATE local_terminals SET desk_number=1 WHERE id=$1', [A]),
          sqlError('23514', /^Desk number changes require a matching audit record$/),
        );
        await assert.rejects(
          pool.query('INSERT INTO local_terminals(id,branch_id,desk_number) VALUES ($1,$2,1)', [
            randomUUID(),
            ctx.branch,
          ]),
          sqlError('23514', /^A cash desk starts without a number$/),
        );
        // The audit rule of the new subject; the schema026 subjects keep theirs.
        const row = (subject, before, after) => [
          `INSERT INTO pos_sales_setting_changes(change_id,branch_id,subject,before,after,actor,reason)
           VALUES ($1,$2,$3,$4,$5,'operator','Синтетика')`,
          [randomUUID(), ctx.branch, subject, before, after],
        ];
        const desk = (number, terminal = A) => ({ terminal_id: terminal, desk_number: number });
        const method = (enabled) => ({ enabled, fiscal_policy: 'manual_webkassa' });
        const CHECK = '23514 pos_sales_setting_changes_check1';
        assert.deepEqual(
          await answers(ctx, [
            row('desk_number', desk(null), desk(5)),
            row('desk_number', desk(5), desk(99)),
            row('desk_number', desk(99), desk(null)),
            row('desk_number', { terminal_id: A }, desk(5)),
            row('desk_number', { ...desk(null), extra: 1 }, desk(5)),
            row('desk_number', desk(null), desk(5, B)),
            row('desk_number', desk(null, 'desk-1'), desk(5, 'desk-1')),
            row('desk_number', desk(null, A.toUpperCase()), desk(5, A.toUpperCase())),
            row('desk_number', desk(null), desk(0)),
            row('desk_number', desk(null), desk(100)),
            row('desk_number', desk(null), desk(1.5)),
            row('desk_number', desk(null), desk('5')),
            row('desk_number', desk(null), desk(true)),
            row('desk_number', desk(5), desk(5)),
            row('desk_number', desk(null), desk(null)),
            row('desk_number', method(false), method(true)),
            row('cash', desk(null), desk(5)),
            row('cash', method(false), method(true)),
            row(
              'pos_service_mode',
              { pos_service_mode: 'unpaid_service' },
              { pos_service_mode: 'pos_sale' },
            ),
            // CHECKs run in name order: a shape check1 accepts reaches the subject list.
            row('desk', method(false), method(true)),
          ]),
          [
            'ok',
            'ok',
            'ok',
            CHECK,
            CHECK,
            CHECK,
            CHECK,
            CHECK,
            CHECK,
            CHECK,
            CHECK,
            CHECK,
            CHECK,
            CHECK,
            CHECK,
            CHECK,
            CHECK,
            'ok',
            'ok',
            '23514 pos_sales_setting_changes_subject_check',
          ],
        );

        // The runtime as installed (edge-runtime-grants and the 026 set): it reads the number
        // through its table SELECT on local_terminals and can write none.
        await setDeskNumber(pool, ctx.branch, {
          terminal_id: A,
          desk_number: 1,
          reason: 'Касса 1',
        });
        const role = 'pos_desk_' + randomUUID().replaceAll('-', '').slice(0, 16),
          password = randomBytes(32).toString('hex');
        let restricted;
        try {
          await ctx.edge.admin.query(
            `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
          );
          await applyEdgeRuntimeGrants(pool, role, { schema: ctx.edge.schema, fulfillment: true });
          await pool.query(posSalesRuntimeGrants(role, ctx.edge.schema));
          assert.deepEqual(
            (
              await pool.query(
                `SELECT has_column_privilege($1,'local_terminals','desk_number','SELECT') AS sel,
                   has_column_privilege($1,'local_terminals','desk_number','INSERT') AS ins,
                   has_column_privilege($1,'local_terminals','desk_number','UPDATE') AS upd`,
                [role],
              )
            ).rows[0],
            { sel: true, ins: false, upd: false },
          );
          const url = new URL(ctx.edge.config.databaseUrl);
          url.username = role;
          url.password = password;
          restricted = createPool(url.toString());
          assert.equal(
            (await readPosConfig(restricted, ctx.branch, staffAuth(desks.one))).desk_number,
            1,
          );
          assert.equal(
            (await readPosConfig(restricted, ctx.branch, staffAuth(desks.oneManager))).desk_number,
            1,
          );
          assert.equal(
            (await readPosConfig(restricted, ctx.branch, staffAuth(desks.two))).desk_number,
            null,
          );
          await assert.rejects(
            restricted.query('UPDATE local_terminals SET desk_number=2 WHERE id=$1', [A]),
            sqlError('42501'),
          );
          // Today's shift path (terminal row locks included) runs on 028 with these grants.
          const shift = await openCashShift(
            restricted,
            ctx.branch,
            staffAuth(desks.twoManager),
            randomUUID(),
            { opening_cash_minor: '0' },
          );
          const closed = await closeCashShift(
            restricted,
            ctx.branch,
            staffAuth(desks.twoManager),
            randomUUID(),
            shift.shift_id,
            { expected_version: 1, counted_cash_minor: '0', reason: 'Синтетическое закрытие' },
          );
          assert.equal(closed.state, 'closed');
        } finally {
          await restricted?.end();
          await ctx.edge.admin.query(`DROP OWNED BY ${role}; DROP ROLE ${role}`);
        }
      },
      { edgeMigrationDirectory: before028 },
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('desk: owner only, audited first, idempotent, one number per active desk; every refusal writes nothing; status and pos/config show it', async () => {
  await withSyncDatabases(async (ctx) => {
    const pool = ctx.edge.pool;
    const desks = await twoDesks(ctx);
    const A = desks.one.terminal_id,
      B = desks.two.terminal_id;
    const set = (terminal_id, desk_number, reason = 'Касса у окна') =>
      setDeskNumber(pool, ctx.branch, { terminal_id, desk_number, reason });
    const config = async (credential) =>
      (await readPosConfig(pool, ctx.branch, staffAuth(credential))).desk_number;
    assert.deepEqual(desksOf(await posSalesStatus(pool, ctx.branch)), { [A]: null, [B]: null });

    const first = await set(A, 1, 'Касса 1 у входа');
    assert.deepEqual(first.desk, { terminal_id: A, desk_number: 1 });
    assert.equal(first.message, 'Номер кассы записан');
    assert.deepEqual(first.changes, [
      {
        subject: 'desk_number',
        before: { terminal_id: A, desk_number: null },
        after: { terminal_id: A, desk_number: 1 },
      },
    ]);
    assert.deepEqual(await audit(pool), [
      {
        subject: 'desk_number',
        before: { terminal_id: A, desk_number: null },
        after: { terminal_id: A, desk_number: 1 },
        actor: 'operator',
        reason: 'Касса 1 у входа',
      },
    ]);
    assert.deepEqual(desksOf(first), { [A]: 1, [B]: null });
    assert.equal(first.recent_changes[0].subject, 'desk_number');
    // Offline: nothing else of the branch moved.
    assert.equal(first.mode, 'payment_required');
    assert.ok(first.methods.every((method) => !method.enabled));

    // The same number again: nothing written, one clear message.
    const again = await set(A, 1, 'Повтор');
    assert.deepEqual(
      [again.changes, again.message],
      [[], 'Ничего не изменено: у кассы уже этот номер'],
    );
    assert.equal((await audit(pool)).length, 1);

    // Every refusal leaves the history and the desks as they were.
    const unchanged = async () => {
      assert.equal((await audit(pool)).length, 1);
      assert.deepEqual(desksOf(await posSalesStatus(pool, ctx.branch)), { [A]: 1, [B]: null });
    };
    await assert.rejects(
      set(B, 1),
      refused(
        'DESK_NUMBER_TAKEN',
        (e) =>
          e.details.terminal_id === A &&
          e.details.desk_number === 1 &&
          e.message ===
            'Этот номер уже у другой активной кассы точки: сначала снимите его там (desk --clear)',
      ),
    );
    await unchanged();
    await assert.rejects(
      set(randomUUID(), 3),
      refused('TERMINAL_UNKNOWN', (e) => UUID.test(e.details.terminal_id)),
    );
    // Another branch's id is unknown here too (the branch of this edge only).
    await assert.rejects(
      setDeskNumber(pool, randomUUID(), { terminal_id: A, desk_number: 3, reason: 'Касса 3' }),
      refused('BRANCH_MISSING'),
    );
    const retired = await provisionStaff(pool, ctx.branch, desks.person('cashier'));
    await pool.query('UPDATE local_terminals SET active=false WHERE id=$1', [retired.terminal_id]);
    await assert.rejects(set(retired.terminal_id, 3), refused('TERMINAL_INACTIVE'));
    // Kitchen screens and the display are paired by device access (020), never cash desks.
    const managed = randomUUID();
    await pool.query(
      'INSERT INTO local_terminals(id,branch_id,active,device_access_managed) VALUES ($1,$2,true,true)',
      [managed, ctx.branch],
    );
    await assert.rejects(set(managed, 3), refused('TERMINAL_NOT_DESK'));
    const screen = randomUUID(),
      command = randomUUID();
    await pool.query('INSERT INTO local_terminals(id,branch_id) VALUES ($1,$2)', [
      screen,
      ctx.branch,
    ]);
    await pool.query(
      `INSERT INTO terminal_access_commands(command_id,branch_id,edge_device_id,terminal_id,generation,payload,state)
       VALUES ($1,$2,$3,$4,1,'{}','applied')`,
      [command, ctx.branch, ctx.device, screen],
    );
    await pool.query(
      `INSERT INTO terminal_access_registry(terminal_id,branch_id,edge_device_id,mode,name,generation,command_id,state,key_hash,expires_at)
       VALUES ($1,$2,$3,'prep','Синтетический экран',1,$4,'paired',repeat('a',64),clock_timestamp()+interval '1 day')`,
      [screen, ctx.branch, ctx.device, command],
    );
    await assert.rejects(set(screen, 3), refused('TERMINAL_NOT_DESK'));
    await unchanged();

    // The second desk, a renumbering and pos/config of every session on each desk.
    await set(B, 2, 'Касса 2 у окна');
    assert.deepEqual(
      [await config(desks.one), await config(desks.oneManager), await config(desks.two)],
      [1, 1, 2],
    );
    const renumbered = await set(A, 3, 'Перестановка касс');
    assert.deepEqual(renumbered.changes[0].before, { terminal_id: A, desk_number: 1 });
    assert.deepEqual(renumbered.changes[0].after, { terminal_id: A, desk_number: 3 });
    const cleared = await set(A, null, 'Касса снята');
    assert.deepEqual(
      [cleared.message, cleared.changes[0].before.desk_number, cleared.changes[0].after],
      ['Номер кассы снят', 3, { terminal_id: A, desk_number: null }],
    );
    assert.equal(await config(desks.one), null);
    const none = await set(A, null, 'Повтор снятия');
    assert.deepEqual([none.changes, none.message], [[], 'Ничего не изменено: у кассы нет номера']);
    assert.equal((await audit(pool)).length, 4);

    // A desk out of service frees its number; back in service the clash is refused by the index.
    await pool.query('UPDATE local_terminals SET active=false WHERE id=$1', [B]);
    await set(A, 2, 'Касса 2 заменена');
    await assert.rejects(
      pool.query('UPDATE local_terminals SET active=true WHERE id=$1', [B]),
      (error) =>
        error.code === '23505' && error.constraint === 'local_terminals_active_desk_number',
    );

    // Not the owner of the edge database: refused before anything is read or written.
    const role = `pos_desk_reader_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const schema = ctx.edge.schema;
    await ctx.edge.admin.query(`CREATE ROLE ${role} NOLOGIN`);
    let reader;
    try {
      await ctx.edge.admin.query(
        `GRANT USAGE ON SCHEMA ${schema} TO ${role}; GRANT SELECT, UPDATE ON ALL TABLES IN SCHEMA ${schema} TO ${role}; GRANT INSERT ON ALL TABLES IN SCHEMA ${schema} TO ${role}`,
      );
      const url = new URL(ctx.edge.config.databaseUrl);
      url.searchParams.set('options', `-c search_path=${schema} -c role=${role}`);
      reader = createPool(url.toString());
      await assert.rejects(
        setDeskNumber(reader, ctx.branch, { terminal_id: A, desk_number: 4, reason: 'Касса 4' }),
        refused('NOT_OWNER'),
      );
    } finally {
      await reader?.end();
      await ctx.edge.admin.query(`DROP OWNED BY ${role}; DROP ROLE ${role}`);
    }
    assert.equal((await audit(pool)).length, 5);
  });
});

test('GET pos/config: desk_number of the session terminal as the last key, every earlier byte as before with everything off', async () => {
  await withSyncDatabases(async (ctx) => {
    const pool = ctx.edge.pool;
    const desks = await twoDesks(ctx);
    const server = await running(createEdge, ctx.edge.config);
    try {
      const raw = async (credential) => {
        const response = await request(server.url + '/edge/v1/pos/config', {
          headers: staffHeaders(credential),
        });
        assert.equal(response.status, 200);
        return response.text();
      };
      // The answer of today's 026 edge, rebuilt key by key in its order from the same values.
      const legacy = (body) =>
        JSON.stringify({
          mode: body.mode,
          methods: body.methods,
          channels: body.channels,
          fiscal_mode: body.fiscal_mode,
          approval_ttl_seconds: body.approval_ttl_seconds,
          server_time: body.server_time,
        });
      const off = {
        methods: POS_METHODS.map((code) => ({
          code,
          enabled: false,
          requires_approval: POS_PAYMENT_METHOD_POLICY[code].requires_approval,
          allow_in_mix: POS_PAYMENT_METHOD_POLICY[code].allow_in_mix,
          fiscal_policy: POS_PAYMENT_METHOD_POLICY[code].fiscal_policy,
        })),
        channels: [
          { code: 'hall', enabled: false },
          { code: 'yandex_eda', enabled: false },
          { code: 'glovo', enabled: false },
        ],
        fiscal_mode: 'manual_webkassa',
        approval_ttl_seconds: 120,
      };
      for (const mode of ['payment_required', 'unpaid_service']) {
        await pool.query('UPDATE branch_config SET pos_service_mode=$2 WHERE id=$1', [
          ctx.branch,
          mode,
        ]);
        const text = await raw(desks.one);
        const body = PosConfigSchema.parse(JSON.parse(text));
        assert.deepEqual(
          { ...body, server_time: undefined, desk_number: undefined },
          {
            mode,
            ...off,
            server_time: undefined,
            desk_number: undefined,
          },
        );
        assert.equal(text, legacy(body).slice(0, -1) + ',"desk_number":null}');
      }
      await setDeskNumber(pool, ctx.branch, {
        terminal_id: desks.two.terminal_id,
        desk_number: 2,
        reason: 'Касса 2 у окна',
      });
      for (const [credential, number] of [
        [desks.one, null],
        [desks.oneManager, null],
        [desks.two, 2],
        [desks.twoManager, 2],
      ]) {
        const text = await raw(credential);
        const body = JSON.parse(text);
        assert.equal(body.desk_number, number);
        assert.equal(text, legacy(body).slice(0, -1) + `,"desk_number":${number}}`);
        assert.deepEqual(
          { ...body, server_time: undefined, desk_number: undefined },
          {
            mode: 'unpaid_service',
            ...off,
            server_time: undefined,
            desk_number: undefined,
          },
        );
      }
    } finally {
      await server.app.close();
    }
  });
});

test('desk on the command line: refusals in Russian, never a credential', async () => {
  const run = (args) =>
    promisify(execFile)(process.execPath, ['scripts/pos-sales-setup.mjs', ...args], {
      cwd: root,
      env: { PATH: process.env.PATH },
    }).then(
      () => assert.fail('the CLI must refuse'),
      (error) => error,
    );
  for (const args of [
    ['desk', '--terminal', randomUUID(), '--number', '100', '--reason', 'Касса 100'],
    ['desk', '--terminal', randomUUID(), '--reason', 'Касса без номера'],
  ]) {
    const bad = await run(args);
    assert.equal(bad.code, 1);
    assert.equal(bad.stdout, '');
    assert.deepEqual(JSON.parse(bad.stderr), {
      event: 'pos_sales_setup_refused',
      command: 'unknown',
      code: 'INVALID_ARGUMENTS',
      message: 'Неверные аргументы: см. docs/operations/pos-sales.md',
    });
  }
});
