import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPool } from '@pickchick/database';
import { fixture } from '../../fulfillment-transport/tests/cloud-fixture.mjs';
import { provisionCatalogManager } from '../../catalog-admin/dist/index.js';
import { Backoffice, grantBackoffice } from '../dist/index.js';
import {
  Reconciliation,
  grantReconciliationAccountant,
  reconciliationOptions,
} from '../dist/reconciliation.js';
import { backofficeGrants } from '../../../infra/staging/backoffice-grants.mjs';
import { reconciliationGrants } from '../../../infra/staging/reconciliation-grants.mjs';

const D = '2026-10-21';
const NEXT = '2026-10-22';
// 11:00 Almaty on the next day: the day under review is over.
const morning = () => new Date('2026-10-22T06:00:00.000Z');
const almaty = (day, time) => new Date(`${day}T${time}+05:00`).toISOString();
const reason = (r = 'Synthetic reconciliation') => r;
const header = 'Дата;Номер операции;Тип;Канал;Сумма';
const kaspiMapping = {
  version: 1,
  source: 'kaspi',
  delimiter: ';',
  has_header: true,
  columns: {
    occurred_at: 'Дата',
    amount: 'Сумма',
    operation_id: 'Номер операции',
    direction: 'Тип',
    method: 'Канал',
  },
  date_format: 'dmy',
  decimal_separator: ',',
  amount_unit: 'major',
  refund_values: ['Возврат'],
  method_values: { QR: 'kaspi_qr', Счёт: 'kaspi_remote', Терминал: 'kaspi_pos' },
};
const cardMapping = {
  ...kaspiMapping,
  source: 'tiptoppay',
  method_values: {},
  default_method: 'tiptoppay',
};

async function setup(f, options = {}) {
  const org = f.scope.organizationId,
    branch = f.scope.branchId;
  const person = async (name, role, accountant = false) => {
    const m = await provisionCatalogManager(f.pool, {
      organization_id: org,
      name,
      branch_ids: [branch],
    });
    if (role) await grantBackoffice(f.pool, m.actor_id, branch, role);
    if (accountant) await grantReconciliationAccountant(f.pool, m.actor_id, branch, true);
    return m;
  };
  const account = async (provider) => {
    const id = randomUUID();
    await f.pool.query(
      "INSERT INTO commerce_provider_accounts(id,organization_id,branch_id,legal_entity_id,kind,provider,external_reference,enabled) VALUES($1,$2,$3,$4,'payment',$5,$6,true)",
      [id, org, branch, f.legal, provider, id],
    );
    return id;
  };
  const accounts = {
    qr: await account('kaspi-qr'),
    remote: await account('kaspi-remote'),
    card: await account('tiptoppay'),
  };
  /** A paid order: admission by the cashier, then a confirmed capture from the given rail. */
  const pay = async (rail, at, operationId, value = null) => {
    const v = value ?? (await f.reserve());
    if (!value) await f.confirm(v);
    const attempt = value
      ? v.attempt
      : await f.commerce.startPaymentAttempt(f.scope, randomUUID(), {
          orderId: v.orderId,
          providerAccountId: accounts[rail],
        });
    await f.commerce.observePayment(
      { organizationId: org, branchId: branch, accountId: accounts[rail] },
      {
        eventId: randomUUID(),
        attemptId: attempt.attemptId,
        outcome: 'captured',
        operationId,
        amountMinor: attempt.amountMinor,
        occurredAt: at,
      },
    );
    return { ...v, attempt, view: await f.commerce.readOrder(f.scope, v.orderId) };
  };
  const rec = new Reconciliation(f.pool, true, { now: options.now ?? morning });
  const req = (command, why = reason()) => ({ request_id: randomUUID(), reason: why, command });
  return { org, branch, person, account, accounts, pay, rec, req };
}

test('double payment, late bank operation, partial refund, duplicate import and day closing', () =>
  fixture(async (f) => {
    const s = await setup(f);
    const manager = await s.person('Synthetic manager', 'manager');
    const analyst = await s.person('Synthetic analyst', 'analyst');
    const accountant = await s.person('Synthetic accountant', 'analyst', true);
    const outsider = await s.person('Synthetic outsider', null);
    // PickChick facts of the day.
    await s.pay('remote', almaty(D, '10:00:00'), 'kaspi:900001');
    const late = await s.pay('qr', almaty(D, '23:58:00'), '700001');
    const double = await s.pay('qr', almaty(D, '13:00:00'), '700002');
    await s.pay('qr', almaty(D, '13:01:00'), '700003', double);
    const card = await s.pay('card', almaty(D, '12:00:00'), '810001');
    const bo = new Backoffice(f.pool, true, { refundAdapterEnabled: true });
    await grantBackoffice(f.pool, manager.actor_id, s.branch, 'manager');
    const refund = await bo.command(manager.token, s.branch, {
      request_id: randomUUID(),
      reason: 'Synthetic partial refund',
      command: {
        type: 'refund',
        id: card.orderId,
        capture_id: card.view.captures[0].id,
        amount_minor: '100000',
      },
    });
    await f.commerce.observeRefund(
      { organizationId: s.org, branchId: s.branch, accountId: s.accounts.card },
      {
        eventId: randomUUID(),
        refundId: refund.refundId,
        outcome: 'succeeded',
        operationId: '810002',
        amountMinor: '100000',
        occurredAt: almaty(D, '15:00:00'),
      },
    );
    // Access: flag, authentication, branch grant and the read-only analyst.
    await assert.rejects(
      new Reconciliation(f.pool, false).read(manager.token, s.branch, { day: D }),
      {
        code: 'SERVICE_UNAVAILABLE',
      },
    );
    await assert.rejects(s.rec.read('0'.repeat(64), s.branch, { day: D }), {
      code: 'UNAUTHORIZED',
    });
    await assert.rejects(s.rec.read(outsider.token, s.branch, { day: D }), { code: 'FORBIDDEN' });
    await assert.rejects(s.rec.read(manager.token, s.branch, { day: '2026-10-23' }), {
      code: 'INVALID_REQUEST',
    });
    assert.equal((await s.rec.read(analyst.token, s.branch, { day: D })).role, 'analyst');
    assert.equal((await s.rec.read(accountant.token, s.branch, { day: D })).role, 'accountant');
    // Without any statement: one "no bank data" item per paid method.
    let d = await s.rec.read(manager.token, s.branch, { day: D });
    assert.equal(d.state, 'open');
    assert.equal(d.writable, true);
    assert.deepEqual(
      d.report.rows.filter((r) => r.rule === 'no_bank_data').map((r) => [r.method, r.amount_minor]),
      [
        ['kaspi_qr', '-900000'],
        ['kaspi_remote', '-300000'],
        ['tiptoppay', '-200000'],
      ],
    );
    const qr = d.report.methods.find((m) => m.method === 'kaspi_qr');
    assert.deepEqual(
      [qr.orders_paid, qr.captures_count, qr.captures_minor, qr.expected_minor, qr.coverage],
      [2, 3, '900000', '900000', 'none'],
    );
    const tip = d.report.methods.find((m) => m.method === 'tiptoppay');
    assert.deepEqual(
      [tip.captures_minor, tip.refunds_minor, tip.refunds_count, tip.expected_minor],
      ['300000', '100000', 1, '200000'],
    );
    const dbl = d.report.rows.find((r) => r.rule === 'double_payment');
    assert.equal(dbl.order_id, double.orderId);
    assert.equal(dbl.amount_minor, '300000');
    // Statements: Kaspi Pay for two days and TipTopPay.
    const kaspi = [
      header,
      '21.10.2026 10:00:30;900001;Покупка;Счёт;3 000,00',
      '21.10.2026 13:00:10;700002;Покупка;QR;3 000,00',
      '21.10.2026 13:01:10;700003;Покупка;QR;3 000,00',
      '21.10.2026 18:00:00;555555;Покупка;Терминал;1 200,00',
      '22.10.2026 00:03:00;;Покупка;QR;3 000,00',
    ].join('\r\n');
    const preview = await s.rec.preview(accountant.token, s.branch, {
      mapping: kaspiMapping,
      content: kaspi,
    });
    assert.equal(preview.valid, true);
    assert.equal(preview.lines, 5);
    assert.deepEqual(
      preview.days.map((x) => [x.day, x.lines, x.amount_minor, x.closed]),
      [
        [D, 4, '1020000', false],
        [NEXT, 1, '300000', false],
      ],
    );
    await assert.rejects(
      s.rec.preview(analyst.token, s.branch, { mapping: kaspiMapping, content: kaspi }),
      { code: 'FORBIDDEN' },
    );
    const importKaspi = s.req({
      type: 'import',
      id: randomUUID(),
      profile_id: null,
      mapping: kaspiMapping,
      file_name: 'kaspi-21-10.csv',
      content: kaspi,
    });
    const imported = await Promise.all([
      s.rec.command(accountant.token, s.branch, importKaspi),
      s.rec.command(accountant.token, s.branch, importKaspi),
    ]);
    assert.deepEqual(imported[0], imported[1]);
    assert.equal(imported[0].lines, 5);
    await assert.rejects(
      s.rec.command(accountant.token, s.branch, { ...importKaspi, reason: 'Changed retry' }),
      { code: 'CONFLICT' },
    );
    // The same file again (other line endings) is a duplicate import.
    await assert.rejects(
      s.rec.command(
        accountant.token,
        s.branch,
        s.req({
          ...importKaspi.command,
          id: randomUUID(),
          content: kaspi.replaceAll('\r\n', '\n'),
        }),
      ),
      { code: 'CONFLICT', detail: 'DUPLICATE_IMPORT' },
    );
    // An overlapping statement: the already imported operation is skipped, the new one stored.
    const overlap = await s.rec.command(
      accountant.token,
      s.branch,
      s.req({
        ...importKaspi.command,
        id: randomUUID(),
        file_name: 'kaspi-21-10-evening.csv',
        content: [
          header,
          '21.10.2026 18:00:00;555555;Покупка;Терминал;1 200,00',
          '21.10.2026 19:00:00;555556;Покупка;Терминал;800,00',
        ].join('\n'),
      }),
    );
    assert.deepEqual([overlap.lines, overlap.already_imported], [1, 1]);
    await s.rec.command(
      accountant.token,
      s.branch,
      s.req({
        type: 'import',
        id: randomUUID(),
        profile_id: null,
        mapping: cardMapping,
        file_name: 'tiptoppay-21-10.csv',
        content: [
          header,
          '21.10.2026 12:00:02;810001;Покупка;;3 000,00',
          '21.10.2026 15:00:01;810002;Возврат;;1 000,00',
        ].join('\n'),
      }),
    );
    d = await s.rec.read(manager.token, s.branch, { day: D });
    const byKey = (pred) => d.report.rows.filter(pred);
    const lateRow = byKey((r) => r.state === 'late')[0];
    assert.equal(lateRow.pickchick.order_id, late.orderId);
    assert.equal(lateRow.rule, 'amount_time');
    assert.equal(lateRow.amount_minor, '-300000');
    assert.equal(byKey((r) => r.state === 'matched' && r.method === 'kaspi_qr').length, 2);
    assert.equal(byKey((r) => r.state === 'matched' && r.method === 'kaspi_remote').length, 1);
    assert.equal(byKey((r) => r.state === 'matched' && r.method === 'tiptoppay').length, 2);
    assert.deepEqual(
      byKey((r) => r.state === 'missing_in_pickchick').map((r) => [r.method, r.amount_minor]),
      [
        ['kaspi_pos', '120000'],
        ['kaspi_pos', '80000'],
      ],
    );
    assert.equal(byKey((r) => r.rule === 'no_bank_data').length, 0);
    const pos = d.report.methods.find((m) => m.method === 'kaspi_pos');
    assert.deepEqual([pos.expected_minor, pos.bank_minor, pos.bank_count], [null, '200000', 2]);
    const qrNow = d.report.methods.find((m) => m.method === 'kaspi_qr');
    assert.deepEqual([qrNow.bank_minor, qrNow.difference_minor], ['600000', '-300000']);
    assert.equal(d.report.methods.find((m) => m.method === 'tiptoppay').difference_minor, '0');
    // The next day sees the same late operation from the bank side.
    const next = await new Reconciliation(f.pool, true, {
      now: () => new Date('2026-10-23T06:00:00Z'),
    }).read(manager.token, s.branch, { day: NEXT });
    assert.equal(next.report.rows.find((r) => r.state === 'late').key, lateRow.key);
    // Closing is blocked by open differences, the analyst cannot decide, decisions are bound.
    const open = d.report.rows.filter((r) => r.blocking);
    assert.equal(d.report.open_items, 4);
    assert.equal(open.length, 4);
    await assert.rejects(
      s.rec.command(
        manager.token,
        s.branch,
        s.req({ type: 'close', day: D, expected_revision: 0 }),
      ),
      { code: 'CONFLICT', detail: 'DIFFERENCES_OPEN' },
    );
    const decide = (who, row, patch = {}) =>
      s.rec.command(
        who.token,
        s.branch,
        s.req({
          type: 'item',
          day: D,
          key: row.key,
          state: row.state,
          amount_minor: row.amount_minor,
          status: 'resolved',
          assignee_id: accountant.actor_id,
          comment: 'Синтетическое пояснение',
          expected_revision: row.item_revision,
          ...patch,
        }),
      );
    await assert.rejects(decide(analyst, lateRow), { code: 'FORBIDDEN' });
    await assert.rejects(decide(accountant, { ...lateRow, amount_minor: '-1' }), {
      code: 'CONFLICT',
      detail: 'ITEM_CHANGED',
    });
    await assert.rejects(decide(accountant, lateRow, { assignee_id: outsider.actor_id }), {
      code: 'INVALID_REQUEST',
      detail: 'ASSIGNEE_UNKNOWN',
    });
    await assert.rejects(decide(accountant, lateRow, { comment: '' }), {
      code: 'INVALID_REQUEST',
    });
    // A difference in work, resolved or accepted always names a responsible person.
    await assert.rejects(decide(accountant, lateRow, { assignee_id: null }), {
      code: 'INVALID_REQUEST',
      detail: 'ASSIGNEE_REQUIRED',
    });
    // Assigned first (in progress), then resolved with the exact revision.
    await decide(accountant, lateRow, { status: 'in_progress', comment: '' });
    await assert.rejects(decide(accountant, lateRow), {
      code: 'CONFLICT',
      detail: 'REVISION_CHANGED',
    });
    await decide(accountant, lateRow, {
      comment: 'Банк зачислил после полуночи',
      expected_revision: 1,
    });
    const bulk = await s.rec.command(
      manager.token,
      s.branch,
      s.req({
        type: 'accept',
        day: D,
        comment: 'Оплаты на терминале кассы и двойная оплата: возврат в работе',
        items: open
          .filter((r) => r.key !== lateRow.key)
          .map((r) => ({ key: r.key, state: r.state, amount_minor: r.amount_minor })),
      }),
    );
    assert.equal(bulk.accepted, 3);
    d = await s.rec.read(manager.token, s.branch, { day: D });
    assert.equal(d.report.open_items, 0);
    const lateNow = d.report.rows.find((r) => r.key === lateRow.key);
    assert.deepEqual(
      [lateNow.resolution.status, lateNow.resolution.assignee_name, lateNow.resolution.revision],
      ['resolved', 'Synthetic accountant', 2],
    );
    // A day that is not over yet cannot be closed.
    await assert.rejects(
      new Reconciliation(f.pool, true, { now: () => new Date(almaty(D, '22:00:00')) }).command(
        manager.token,
        s.branch,
        s.req({ type: 'close', day: D, expected_revision: 0 }),
      ),
      { code: 'CONFLICT', detail: 'DAY_NOT_FINISHED' },
    );
    const closing = s.req({ type: 'close', day: D, expected_revision: 0 }, 'День сверен');
    const closed = await Promise.allSettled([
      s.rec.command(accountant.token, s.branch, closing),
      s.rec.command(
        manager.token,
        s.branch,
        s.req({ type: 'close', day: D, expected_revision: 0 }),
      ),
    ]);
    assert.equal(closed.filter((x) => x.status === 'fulfilled').length, 1);
    d = await s.rec.read(analyst.token, s.branch, { day: D });
    assert.equal(d.state, 'closed');
    assert.equal(d.revision, 1);
    assert.equal(d.drift, false);
    assert.equal(d.writable, false);
    // Closed days are immutable for every write path.
    for (const command of [
      {
        type: 'total',
        id: randomUUID(),
        day: D,
        method: 'cash',
        source: 'kkm',
        amount_minor: '1000',
        comment: 'Синтетика',
        replaces: null,
      },
      {
        type: 'item',
        day: D,
        key: lateRow.key,
        state: 'late',
        amount_minor: '-300000',
        status: 'open',
        assignee_id: null,
        comment: '',
        expected_revision: 2,
      },
      {
        ...importKaspi.command,
        id: randomUUID(),
        content: header + '\n21.10.2026 20:00:00;1;Покупка;QR;10,00',
      },
      { type: 'void_import', id: importKaspi.command.id },
    ])
      await assert.rejects(s.rec.command(manager.token, s.branch, s.req(command)), {
        code: 'CONFLICT',
        detail: 'DAY_CLOSED',
      });
    await assert.rejects(
      s.rec.command(
        manager.token,
        s.branch,
        s.req({ type: 'close', day: D, expected_revision: 1 }),
      ),
      { code: 'CONFLICT', detail: 'DAY_CLOSED' },
    );
    // An overlapping statement whose closed-day lines were imported before adds only the open day.
    const overlapping = [
      header,
      '21.10.2026 13:00:10;700002;Покупка;QR;3 000,00',
      '22.10.2026 09:00:00;700010;Покупка;QR;1 000,00',
    ].join('\n');
    const checked = await s.rec.preview(accountant.token, s.branch, {
      mapping: kaspiMapping,
      content: overlapping,
    });
    assert.deepEqual(
      checked.days.map((x) => [x.day, x.lines, x.new_lines, x.closed]),
      [
        [D, 1, 0, true],
        [NEXT, 1, 1, false],
      ],
    );
    assert.equal(checked.already_imported, 1);
    const added = await s.rec.command(
      accountant.token,
      s.branch,
      s.req({
        ...importKaspi.command,
        id: randomUUID(),
        file_name: 'kaspi-21-22.csv',
        content: overlapping,
      }),
    );
    assert.deepEqual([added.lines, added.already_imported, added.days], [1, 1, [NEXT]]);
    assert.equal((await s.rec.read(manager.token, s.branch, { day: D })).drift, false);
    await assert.rejects(f.pool.query("UPDATE bo_rec_days SET reason='Forged'"), { code: '23514' });
    await assert.rejects(f.pool.query('DELETE FROM bo_rec_lines'), { code: '23514' });
    // A capture that arrives after closing does not change the frozen day but is reported.
    await s.pay('remote', almaty(D, '16:00:00'), 'kaspi:900002');
    d = await s.rec.read(manager.token, s.branch, { day: D });
    assert.equal(d.drift, true);
    assert.equal(d.report.methods.find((m) => m.method === 'kaspi_remote').captures_count, 1);
    assert.equal(d.live_open_items, 1);
    // Reopening needs the reason and the exact revision; history and audit keep both events.
    await assert.rejects(
      s.rec.command(
        manager.token,
        s.branch,
        s.req({ type: 'reopen', day: D, expected_revision: 0 }),
      ),
      { code: 'CONFLICT', detail: 'REVISION_CHANGED' },
    );
    await assert.rejects(
      s.rec.command(manager.token, s.branch, {
        request_id: randomUUID(),
        reason: 'x',
        command: { type: 'reopen', day: D, expected_revision: 1 },
      }),
      { code: 'INVALID_REQUEST' },
    );
    await s.rec.command(
      manager.token,
      s.branch,
      s.req({ type: 'reopen', day: D, expected_revision: 1 }, 'Поздняя оплата Kaspi'),
    );
    d = await s.rec.read(manager.token, s.branch, { day: D });
    assert.deepEqual(
      [d.state, d.revision, d.history.map((h) => [h.kind, h.reason])],
      [
        'open',
        2,
        [
          ['close', 'День сверен'],
          ['reopen', 'Поздняя оплата Kaspi'],
        ],
      ],
    );
    assert.equal(d.report.open_items, 1);
    const audit = (
      await f.pool.query(
        "SELECT action,reason FROM bo_audit WHERE branch_id=$1 AND action LIKE 'reconciliation.%' ORDER BY created_at,id",
        [s.branch],
      )
    ).rows.map((r) => r.action);
    assert.deepEqual([...new Set(audit)].sort(), [
      'reconciliation.accept',
      'reconciliation.close',
      'reconciliation.import',
      'reconciliation.item',
      'reconciliation.reopen',
    ]);
  }));

test('manual refunds, manual bank/ККМ totals, profiles and withdrawn imports', () =>
  fixture(async (f) => {
    const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Almaty' }).format(new Date());
    const s = await setup(f, { now: () => new Date(Date.now() + 2 * 86400000) });
    const manager = await s.person('Synthetic manager', 'manager');
    const paid = await s.pay('remote', new Date().toISOString(), 'kaspi:910001');
    const bo = new Backoffice(f.pool, true, { manualRefundsEnabled: true });
    await bo.command(manager.token, s.branch, {
      request_id: randomUUID(),
      reason: 'Synthetic manual refund',
      command: {
        type: 'manual_refund',
        id: paid.orderId,
        capture_id: paid.view.captures[0].id,
        amount_minor: '50000',
        bank_reference: 'kp-ref 1',
      },
    });
    const statement = [
      header,
      `${today.split('-').reverse().join('.')} 00:00:01;910001;Покупка;Счёт;3 000,00`,
      `${today.split('-').reverse().join('.')} 00:00:02;KP-REF 1;Возврат;Счёт;500,00`,
    ].join('\n');
    const importId = randomUUID();
    await s.rec.command(
      manager.token,
      s.branch,
      s.req({
        type: 'import',
        id: importId,
        profile_id: null,
        mapping: { ...kaspiMapping, window_minutes: 1 },
        file_name: 'kaspi-today.csv',
        content: statement,
      }),
    );
    let d = await s.rec.read(manager.token, s.branch, { day: today });
    const manual = d.report.rows.find((r) => r.method === 'manual_refund');
    assert.deepEqual([manual.state, manual.rule], ['matched', 'operation_id']);
    assert.equal(
      d.report.methods.find((m) => m.method === 'manual_refund').expected_minor,
      '-50000',
    );
    // Statement mapping profiles: optimistic revisions and unique names.
    const profile = randomUUID();
    const save = (revision, name = 'Kaspi Pay (черновик)') =>
      s.rec.command(
        manager.token,
        s.branch,
        s.req({
          type: 'profile',
          id: profile,
          expected_revision: revision,
          name,
          mapping: kaspiMapping,
        }),
      );
    assert.deepEqual(await save(0), { id: profile, revision: 1 });
    await assert.rejects(save(0), { code: 'CONFLICT', detail: 'REVISION_CHANGED' });
    assert.deepEqual(await save(1, 'Kaspi Pay'), { id: profile, revision: 2 });
    await assert.rejects(
      s.rec.command(
        manager.token,
        s.branch,
        s.req({
          type: 'profile',
          id: randomUUID(),
          expected_revision: 0,
          name: 'Kaspi Pay',
          mapping: kaspiMapping,
        }),
      ),
      { code: 'CONFLICT', detail: 'PROFILE_NAME_TAKEN' },
    );
    await assert.rejects(
      s.rec.command(
        manager.token,
        s.branch,
        s.req({
          type: 'profile',
          id: randomUUID(),
          expected_revision: 0,
          name: 'Broken',
          mapping: { ...kaspiMapping, method_values: { Карта: 'tiptoppay' } },
        }),
      ),
      { code: 'INVALID_REQUEST' },
    );
    // A statement that does not fit its mapping is rejected as a whole.
    await assert.rejects(
      s.rec.command(
        manager.token,
        s.branch,
        s.req({
          type: 'import',
          id: randomUUID(),
          profile_id: profile,
          mapping: kaspiMapping,
          file_name: 'broken.csv',
          content: header + '\nвчера;1;Покупка;QR;10,00',
        }),
      ),
      { code: 'INVALID_REQUEST', detail: 'STATEMENT_INVALID' },
    );
    // Manual totals: cash is not recorded by PickChick, so the ККМ total must be explained.
    const cash = randomUUID();
    const total = (patch) =>
      s.rec.command(
        manager.token,
        s.branch,
        s.req({
          type: 'total',
          id: randomUUID(),
          day: today,
          method: 'cash',
          source: 'kkm',
          amount_minor: '450000',
          comment: 'Z-отчёт ККМ (синтетика)',
          replaces: null,
          ...patch,
        }),
      );
    await total({ id: cash });
    await assert.rejects(total({}), { code: 'CONFLICT', detail: 'TOTAL_EXISTS' });
    const replacement = randomUUID();
    assert.deepEqual(await total({ id: replacement, amount_minor: '460000', replaces: cash }), {
      id: replacement,
      replaced_id: cash,
    });
    d = await s.rec.read(manager.token, s.branch, { day: today });
    const cashRow = d.report.rows.find((r) => r.rule === 'manual_total');
    assert.deepEqual([cashRow.state, cashRow.amount_minor], ['missing_in_pickchick', '460000']);
    assert.equal(d.totals.find((t) => t.id === cash).void_reason, 'Synthetic reconciliation');
    await s.rec.command(manager.token, s.branch, s.req({ type: 'void_total', id: replacement }));
    // Withdrawing the import brings back "no bank data" for the day.
    await s.rec.command(manager.token, s.branch, s.req({ type: 'void_import', id: importId }));
    d = await s.rec.read(manager.token, s.branch, { day: today });
    assert.deepEqual(d.report.rows.map((r) => r.key).sort(), [
      'nobank:kaspi_remote',
      'nobank:manual_refund',
    ]);
    assert.ok(d.imports.find((i) => i.id === importId).void_reason);
    assert.equal(d.profiles[0].name, 'Kaspi Pay');
    assert.deepEqual(reconciliationOptions({}), { enabled: false });
    assert.deepEqual(reconciliationOptions({ BACKOFFICE_RECONCILIATION_ENABLED: 'true' }), {
      enabled: true,
    });
    assert.throws(() => reconciliationOptions({ BACKOFFICE_RECONCILIATION_ENABLED: '1' }));
  }));

test('restricted runtime role: reconciliation needs its own grant and never writes money', () =>
  fixture(async (f) => {
    const role = 'rec_runtime_' + randomUUID().replaceAll('-', '');
    let pool;
    await f.admin.query(
      `CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
    );
    try {
      await f.pool.query(`GRANT USAGE ON SCHEMA ${f.schema} TO ${role}`);
      await f.pool.query(backofficeGrants(role, true));
      const url = new URL(f.url);
      url.searchParams.set('options', `-c search_path=${f.schema} -c role=${role}`);
      pool = createPool(url.toString());
      const s = await setup(f);
      const manager = await s.person('Synthetic manager', 'manager');
      await s.pay('remote', almaty(D, '10:00:00'), 'kaspi:920001');
      const rec = new Reconciliation(pool, true, { now: morning });
      await assert.rejects(rec.read(manager.token, s.branch, { day: D }), { code: '42501' });
      await f.pool.query(reconciliationGrants(role, true));
      // Applied twice (as provision does on every run) it stays the same.
      await f.pool.query(reconciliationGrants(role, true));
      const d = await rec.read(manager.token, s.branch, { day: D });
      assert.equal(d.report.rows[0].key, 'nobank:kaspi_remote');
      await rec.command(
        manager.token,
        s.branch,
        s.req({
          type: 'item',
          day: D,
          key: 'nobank:kaspi_remote',
          state: 'missing_in_bank',
          amount_minor: '-300000',
          status: 'accepted',
          assignee_id: manager.actor_id,
          comment: 'Выписка будет позже',
          expected_revision: 0,
        }),
      );
      await rec.command(
        manager.token,
        s.branch,
        s.req({ type: 'close', day: D, expected_revision: 0 }),
      );
      for (const [sql, args] of [
        [
          'INSERT INTO bo_rec_accountants(actor_id,branch_id,enabled) VALUES($1,$2,true)',
          [manager.actor_id, s.branch],
        ],
        ["UPDATE bo_rec_days SET reason='Forged'", []],
        ['UPDATE bo_rec_lines SET amount_minor=1', []],
        ['DELETE FROM bo_rec_items', []],
        ['UPDATE commerce_captures SET amount_minor=1', []],
      ])
        await assert.rejects(pool.query(sql, args), { code: '42501' }, sql);
      await f.pool.query(reconciliationGrants(role, false));
      await assert.rejects(rec.read(manager.token, s.branch, { day: D }), { code: '42501' });
    } finally {
      await pool?.end();
      await f.pool.query(`DROP OWNED BY ${role}`);
      await f.admin.query(`DROP ROLE ${role}`);
    }
  }));
