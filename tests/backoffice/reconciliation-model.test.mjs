import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, allowedPath } from '../../apps/backoffice/dist/api.js';
import {
  ReconciliationModel,
  dayCsv,
  csvText,
  decodeStatement,
  draftFromMapping,
  mappingFromDraft,
  parseSnapshot,
  signedMinor,
  tenge,
  writesClosedDay,
} from '../../apps/backoffice/dist/reconciliation-model.js';
import { storage } from './helpers.mjs';

const branch = '11111111-1111-4111-8111-111111111111';
const actor = '22222222-2222-4222-8222-222222222222';
const DAY = '2026-10-21';
const row = (patch = {}) => ({
  key: 'pair:c-33333333-3333-4333-8333-333333333333:44444444-4444-4444-8444-444444444444',
  state: 'late',
  rule: 'amount_time',
  method: 'kaspi_qr',
  amount_minor: '-300000',
  pickchick_minor: '300000',
  bank_minor: '300000',
  pickchick: {
    id: 'c-33333333-3333-4333-8333-333333333333',
    kind: 'capture',
    order_id: '55555555-5555-4555-8555-555555555555',
    occurred_at: '2026-10-21T18:58:00.000Z',
    day: DAY,
    operation_id: '700001',
  },
  bank: {
    id: '44444444-4444-4444-8444-444444444444',
    import_id: '66666666-6666-4666-8666-666666666666',
    row_number: 6,
    occurred_at: '2026-10-21T19:03:00.000Z',
    day: '2026-10-22',
    operation_id: null,
    reference: null,
    description: '=HYPERLINK("x")',
    fee_minor: '0',
  },
  total: null,
  order_id: '55555555-5555-4555-8555-555555555555',
  explanation: 'Другой день: в PickChick 21.10, в банке 22.10',
  time: '2026-10-21T18:58:00.000Z',
  resolution: {
    status: 'resolved',
    assignee_id: actor,
    assignee_name: 'Бухгалтер',
    comment: 'Банк зачислил после полуночи',
    revision: 2,
    updated_at: '2026-10-22T05:00:00.000Z',
    author: 'Бухгалтер',
  },
  stale_resolution: null,
  item_revision: 2,
  blocking: false,
  ...patch,
});
const snapshot = (patch = {}) => ({
  schema_version: 1,
  branch_id: branch,
  day: DAY,
  timezone: 'Asia/Almaty',
  as_of: '2026-10-22T06:00:00.000Z',
  role: 'accountant',
  writable: true,
  actor_id: actor,
  day_finished: true,
  state: 'open',
  revision: 0,
  closed: null,
  drift: false,
  report: {
    day: DAY,
    methods: [
      {
        method: 'kaspi_qr',
        label: 'Kaspi QR на киоске',
        source: 'kaspi',
        recorded: true,
        orders_paid: 2,
        captures_count: 3,
        captures_minor: '900000',
        refunds_count: 0,
        refunds_minor: '0',
        gifts_minor: '0',
        expected_minor: '900000',
        coverage: 'statement',
        bank_count: 2,
        bank_minor: '600000',
        fees_minor: '0',
        totals: [],
        difference_minor: '-300000',
        unknown_attempts: 0,
      },
      {
        method: 'cash',
        label: 'Наличные на кассе',
        source: 'cash',
        recorded: false,
        orders_paid: 0,
        captures_count: 0,
        captures_minor: '0',
        refunds_count: 0,
        refunds_minor: '0',
        gifts_minor: '0',
        expected_minor: null,
        coverage: 'total',
        bank_count: 0,
        bank_minor: '0',
        fees_minor: '0',
        totals: [{ id: 't', source: 'kkm', amount_minor: '450000' }],
        difference_minor: '450000',
        unknown_attempts: 0,
      },
    ],
    rows: [
      row(),
      row({
        key: 'nobank:tiptoppay',
        state: 'missing_in_bank',
        blocking: true,
        resolution: null,
        bank: null,
        pickchick: null,
      }),
    ],
    gifts: { orders: 1, discount_minor: '250000' },
    shifts_checked: 0,
    fingerprint: 'a'.repeat(64),
    open_items: 1,
  },
  live_open_items: 1,
  tiptoppay_test: null,
  totals: [],
  imports: [],
  profiles: [],
  assignees: [{ id: actor, name: 'Бухгалтер', role: 'accountant' }],
  history: [],
  days: [],
  methods: [],
  sources: {},
  limits: { statement_max_chars: 200000, statement_max_rows: 5000 },
  capabilities: { statement_import: true, manual_totals: true },
  ...patch,
});

test('cabinet paths: one day per read, preview and commands only', () => {
  assert.equal(allowedPath(`operations/branches/${branch}/reconciliation?day=${DAY}`), true);
  assert.equal(allowedPath(`operations/branches/${branch}/reconciliation/commands`), true);
  assert.equal(allowedPath(`operations/branches/${branch}/reconciliation/preview`), true);
  for (const p of [
    `operations/branches/${branch}/reconciliation`,
    `operations/branches/${branch}/reconciliation?day=${DAY}&x=1`,
    `operations/branches/${branch}/reconciliation?day=21.10.2026`,
    `operations/branches/${branch}/reconciliation/commands?day=${DAY}`,
    `operations/branches/${branch}/reconciliation/other`,
  ])
    assert.equal(allowedPath(p), false, p);
});

test('payload validation never shows another branch, another day or an unknown role', () => {
  assert.equal(parseSnapshot(snapshot(), branch, DAY).report.rows.length, 2);
  for (const bad of [
    snapshot({ branch_id: actor }),
    snapshot({ day: '2026-10-20' }),
    snapshot({ role: 'owner' }),
    snapshot({ schema_version: 2 }),
    snapshot({ report: { ...snapshot().report, rows: 'x' } }),
    snapshot({ state: 'frozen' }),
  ])
    assert.throws(
      () => parseSnapshot(bad, branch, DAY),
      (e) => e instanceof ApiError,
    );
});

test('amount input, tenge formatting and statement decoding', () => {
  assert.equal(signedMinor('1 234,50'), '123450');
  assert.equal(signedMinor('-500'), '-50000');
  assert.equal(signedMinor('0'), '0');
  assert.equal(signedMinor('4500.5'), '450050');
  for (const bad of ['', '1,234', 'abc', '1.2.3', '-'])
    assert.throws(() => signedMinor(bad), /сумм/i, bad);
  assert.equal(tenge('-123450'), '-1 234,50 ₸');
  assert.equal(tenge(null), '-');
  const cp1251 = new Uint8Array([0xc4, 0xe0, 0xf2, 0xe0, 0x3b, 0x31]);
  assert.equal(decodeStatement(cp1251.buffer, 'windows-1251'), 'Дата;1');
  assert.equal(decodeStatement(new Uint8Array(Buffer.from('Дата;1')).buffer, 'utf-8'), 'Дата;1');
});

test('a statement is refused only when it would add lines to a closed day', () => {
  const day = (patch) => ({ day: DAY, lines: 2, amount_minor: '1000', closed: false, ...patch });
  assert.equal(writesClosedDay({ days: [day({ closed: true, new_lines: 0 }), day({})] }), false);
  assert.equal(writesClosedDay({ days: [day({ closed: true, new_lines: 1 })] }), true);
  // An older API without new_lines: every line of a closed day counts.
  assert.equal(writesClosedDay({ days: [day({ closed: true })] }), true);
});

test('mapping drafts: method values and refund values round-trip, wrong sources are refused', () => {
  const draft = draftFromMapping(null);
  assert.equal(draft.source, 'kaspi');
  const mapping = mappingFromDraft({
    ...draft,
    occurred_at: 'Дата',
    amount: 'Сумма',
    operation_id: 'Номер',
    direction: 'Тип',
    method: 'Канал',
    refund_values: 'Возврат, Отмена',
    method_values: 'QR=kaspi_qr\nТерминал = kaspi_pos',
  });
  assert.deepEqual(mapping.refund_values, ['Возврат', 'Отмена']);
  assert.deepEqual(mapping.method_values, { QR: 'kaspi_qr', Терминал: 'kaspi_pos' });
  assert.equal(mapping.columns.time, null);
  assert.deepEqual(draftFromMapping(mapping).method_values, 'QR=kaspi_qr\nТерминал=kaspi_pos');
  assert.throws(
    () =>
      mappingFromDraft({
        ...draft,
        occurred_at: 'Дата',
        amount: 'Сумма',
        method_values: 'QR=cash',
      }),
    /способ/i,
  );
  assert.throws(() => mappingFromDraft({ ...draft, amount: 'Сумма' }), /дат/i);
});

test('CSV export lists every amount with its explanation, Almaty time and safe cells', () => {
  const rows = dayCsv(parseSnapshot(snapshot(), branch, DAY));
  assert.equal(rows[0][0], 'День');
  const summary = rows.filter((r) => r[1] === 'Итог по способу');
  assert.equal(summary.length, 2);
  const qr = summary.find((r) => r[2] === 'Kaspi QR на киоске');
  assert.deepEqual([qr[6], qr[10], qr[14]], ['9000,00', '6000,00', '-3000,00']);
  const late = rows.find((r) => r[3] === 'Поздно / другой день');
  assert.equal(late[5], '2026-10-21 23:58:00');
  assert.equal(late[9], '2026-10-22 00:03:00');
  assert.equal(late[17], 'Решено');
  assert.equal(rows.find((r) => r[3] === 'Нет в банке')[17], 'Не решено');
  assert.ok(rows.some((r) => r[1] === 'Подарки без оплаты' && r[6] === '2500,00'));
  const text = csvText(rows);
  assert.ok(text.startsWith('﻿"День";'));
  // A statement description can never start a spreadsheet formula.
  assert.ok(text.includes('=HYPERLINK(""x"")'));
  assert.doesNotMatch(text, /(^|;|\n)"[=+@]/);
  assert.equal(
    csvText([['=1+1', '-5', '-3000,00', '@x']]),
    '\ufeff"\'=1+1";"-5";"-3000,00";"\'@x"',
  );
  assert.ok(text.includes('"-3000,00"'));
});

test('model: hidden while the flag is off, recoverable commands, read-only analysts', async () => {
  const store = storage();
  let flag = false,
    fail = null;
  const calls = [];
  const api = async (path, request) => {
    calls.push([path, request?.body]);
    if (!flag) throw new ApiError('SERVICE_UNAVAILABLE', 503, 'RECONCILIATION_DISABLED');
    if (path.includes('/commands')) {
      if (fail) throw fail;
      return { day: DAY, key: 'x', revision: 1 };
    }
    return snapshot();
  };
  let renders = 0;
  const m = new ReconciliationModel(
    api,
    store,
    () => renders++,
    () => new Date('2026-10-22T06:00:00Z'),
  );
  await m.scope(actor, branch);
  assert.equal(m.day, DAY);
  assert.equal(m.unavailable, true);
  assert.equal(m.error, '');
  flag = true;
  await m.load();
  assert.equal(m.unavailable, false);
  assert.equal(m.writable, true);
  fail = new ApiError('NETWORK', 0);
  assert.equal(
    await m.send({ type: 'close', day: DAY, expected_revision: 0 }, 'День сверен'),
    false,
  );
  assert.ok(m.pending);
  assert.ok(store.map.get('pickchick.reconciliation.v1:' + actor));
  const requestId = m.pending.body.request_id;
  // A reload restores the unconfirmed command with the same request id.
  const again = new ReconciliationModel(
    api,
    store,
    () => {},
    () => new Date('2026-10-22T06:00:00Z'),
  );
  await again.scope(actor, branch);
  assert.equal(again.pending.body.request_id, requestId);
  assert.equal(again.writable, false);
  fail = new ApiError('CONFLICT', 409, 'DIFFERENCES_OPEN');
  assert.equal(await again.recover(), false);
  assert.equal(again.pending, null);
  assert.match(again.error, /нерешённые расхождения/i);
  fail = null;
  assert.equal(
    await again.send({ type: 'close', day: DAY, expected_revision: 0 }, 'День сверен'),
    true,
  );
  assert.equal(calls.filter(([p]) => p.endsWith('/commands')).at(-1)[1].reason, 'День сверен');
  assert.equal(store.map.size, 0);
  const analyst = new ReconciliationModel(
    async () => snapshot({ role: 'analyst', writable: false }),
    storage(),
    () => {},
  );
  await analyst.scope(actor, branch);
  assert.equal(analyst.writable, false);
  assert.equal(await analyst.send({ type: 'close', day: DAY, expected_revision: 0 }, 'x'), false);
  assert.ok(renders > 0);
});
