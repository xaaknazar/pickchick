// Lane bo-ui step 7 «Скидки» in the cabinet (design-bo-ui 5.8): the gate, the allowlists of
// ops/discounts, the words for a discount, the editor form (the same rules as the server) and the
// commands. Pure functions of the built cabinet and the core, no PostgreSQL. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { allowedPath } from '../../apps/backoffice/dist/api.js';
import { allowed } from '../../apps/backoffice/server.mjs';
import {
  RIGHTS_TEXT,
  commandPermission,
  discountsAvailable,
  permitted,
  rightsText,
} from '../../apps/backoffice/dist/operations-model.js';
import { auditAction } from '../../apps/backoffice/dist/audit-model.js';
import {
  CHANNEL_LABELS,
  DISCOUNTS_SECTION,
  DISCOUNT_BANNER,
  DISCOUNT_CHANNELS,
  DISCOUNT_ERRORS,
  FORM_ERRORS,
  almatyDay,
  almatyMidnight,
  amountMinor,
  channelsText,
  conditionsText,
  discountsView,
  emptyForm,
  formOf,
  formPayload,
  lastDay,
  percentBp,
  periodText,
  saveCommand,
  scopeText,
  stateActions,
  stateCommand,
  stateText,
  valueText,
  visible,
  whenText,
} from '../../apps/backoffice/dist/discounts-model.js';
import {
  DISCOUNT_CHANNELS as SERVER_CHANNELS,
  DiscountPayloadSchema,
  discountView,
  normalizeDiscount,
} from '../../packages/backoffice-core/dist/index.js';

const LONG_DASH = /[–—]/;
const branch = randomUUID();
const catalog = {
  version: 2,
  categories: [
    { id: 'chicken', name: 'Курица' },
    { id: 'drinks', name: 'Напитки' },
  ],
  products: [
    { id: 'wings', name: 'Крылья', category_id: 'chicken' },
    { id: 'cola', name: 'Кола', category_id: 'drinks' },
  ],
};
const stored = (payload, extra = {}) => ({
  ...discountView({
    id: randomUUID(),
    ...normalizeDiscount(DiscountPayloadSchema.parse(payload)),
    state: 'draft',
    revision: 1,
    created_by_name: 'Синтетический управляющий',
    created_at: new Date('2026-11-06T10:00:00Z'),
    updated_by_name: 'Синтетический управляющий',
    updated_at: new Date('2026-11-06T10:00:00Z'),
  }),
  period: 'always',
  unknown_items: { categories: [], products: [] },
  valid: true,
  ...extra,
});
const form = (extra = {}) => ({
  ...emptyForm(),
  name: 'Синтетический обед',
  value: '10',
  ...extra,
});

test('gate and allowlists: ops/discounts with an optional id, only with the capability', async () => {
  assert.equal(discountsAvailable({ capabilities: { discounts: true } }), true);
  for (const capabilities of [{}, { discounts: false }, { discounts: 'true' }, { pos_day: true }])
    assert.equal(discountsAvailable({ capabilities }), false);
  assert.equal(discountsAvailable(null), false);
  const id = randomUUID();
  const cabinet = (path) => allowedPath(`operations/branches/${branch}/ops/${path}`);
  const proxy = (path, method = 'GET') =>
    allowed(method, `/v1/admin/backoffice/branches/${branch}/ops/${path}`);
  for (const check of [cabinet, proxy]) {
    assert.equal(check('discounts'), true);
    assert.equal(check(`discounts?id=${id}`), true);
    assert.equal(check('discounts?id=x'), false);
    assert.equal(check(`discounts?id=${id}&id=${id}`), false);
    assert.equal(check('discounts?state=active'), false);
    assert.equal(check('discounts/x'), false);
  }
  assert.equal(proxy('discounts', 'POST'), false);
  // Commands go through the existing commands route; nothing new besides the view.
  assert.equal(allowed('POST', `/v1/admin/backoffice/branches/${branch}/commands`), true);
  const caddy = await readFile(
    new URL('../../infra/public-staging/gateway.Caddyfile', import.meta.url),
    'utf8',
  );
  const regex = new RegExp(/path_regexp backoffice_get (\S+)/.exec(caddy)[1]);
  assert.equal(regex.test(`/v1/admin/backoffice/branches/${branch}/ops/discounts`), true);
  assert.equal(regex.test(`/v1/admin/backoffice/branches/${branch}/ops/discounts/x`), false);
  // The cabinet module is served (a missing module would fail the whole cabinet).
  const server = await readFile(
    new URL('../../apps/backoffice/server.mjs', import.meta.url),
    'utf8',
  );
  for (const name of ["'discounts'", "'discounts-model'"]) assert.ok(server.includes(name), name);
});

test('section, permission and rights: the manager edits, every other role reads', () => {
  assert.deepEqual([...DISCOUNTS_SECTION].slice(0, 2), ['discounts', 'Скидки']);
  assert.equal(commandPermission({ type: 'discount_save' }), 'discounts.write');
  assert.equal(commandPermission({ type: 'discount_state' }), 'discounts.write');
  assert.equal(RIGHTS_TEXT['discounts.write'], 'Скидки создаёт и меняет только управляющий точки.');
  assert.equal(
    rightsText({ permissions: ['reports.read'] }, 'discounts.write'),
    RIGHTS_TEXT['discounts.write'],
  );
  // Without roles on the server the grant decides: the manager writes, the analyst reads.
  assert.equal(permitted({ role: 'manager' }, 'discounts.write'), true);
  assert.equal(permitted({ role: 'analyst' }, 'discounts.write'), false);
  assert.equal(
    permitted({ role: 'analyst', permissions: ['reports.read'] }, 'discounts.write'),
    false,
  );
  assert.equal(
    permitted(
      { role: 'manager', permissions: ['reports.read', 'discounts.write'] },
      'discounts.write',
    ),
    true,
  );
  for (const code of ['discount_save', 'discount_state']) {
    const a = auditAction(code);
    assert.equal(a.section, 'Скидки', code);
    assert.doesNotMatch(a.text, /Другая операция|[a-z]_[a-z]/, code);
  }
});

test('words: the banner, channels, value, scope, period, days, hours, conditions, state', () => {
  assert.equal(
    DISCOUNT_BANNER,
    'Скидки пока не применяются на кассе. Включим после проверки на кассе.',
  );
  assert.deepEqual(DISCOUNT_CHANNELS, [...SERVER_CHANNELS]);
  assert.deepEqual(Object.values(CHANNEL_LABELS), [
    'Зал',
    'Яндекс Еда',
    'Glovo',
    'ChocoFood',
    'Приложение',
    'Киоск',
  ]);
  assert.equal(channelsText([...DISCOUNT_CHANNELS]), 'Все каналы');
  assert.equal(channelsText(['hall', 'glovo']), 'Зал, Glovo');
  assert.equal(valueText({ kind: 'percent', percent_bp: 1000, value_minor: null }), '10 %');
  assert.equal(valueText({ kind: 'percent', percent_bp: 1250, value_minor: null }), '12,5 %');
  assert.equal(valueText({ kind: 'percent', percent_bp: 1205, value_minor: null }), '12,05 %');
  assert.equal(valueText({ kind: 'percent', percent_bp: 10000, value_minor: null }), '100 %');
  assert.equal(valueText({ kind: 'amount', percent_bp: null, value_minor: '1167000' }), '11 670 ₸');
  assert.equal(valueText({ kind: 'amount', percent_bp: null, value_minor: '50050' }), '500,50 ₸');
  const all = { categories: [], products: [], channels: ['hall'] };
  assert.equal(scopeText(all, catalog), 'Всё меню');
  assert.equal(
    scopeText({ ...all, categories: ['chicken'], products: ['cola', 'pizza'] }, catalog, {
      categories: [],
      products: ['pizza'],
    }),
    'Категории: Курица; Позиции: Кола, pizza (нет в меню)',
  );
  // Period: inclusive Almaty days; the end bound is the next midnight.
  assert.equal(almatyMidnight('2026-11-20'), '2026-11-19T19:00:00.000Z');
  assert.equal(almatyDay('2026-11-19T19:00:00.000Z'), '2026-11-20');
  assert.equal(almatyDay('2026-11-19T18:59:59.000Z'), '2026-11-19');
  assert.equal(lastDay('2026-11-30T19:00:00.000Z'), '2026-11-30');
  assert.equal(
    periodText({ start_at: '2026-11-19T19:00:00Z', end_at: '2026-11-30T19:00:00Z' }),
    'с 20.11.2026 по 30.11.2026',
  );
  assert.equal(periodText({ start_at: '2026-11-19T19:00:00Z', end_at: null }), 'с 20.11.2026');
  assert.equal(periodText({ start_at: null, end_at: '2026-11-30T19:00:00Z' }), 'по 30.11.2026');
  assert.equal(periodText({ start_at: null, end_at: null }), 'Без срока');
  assert.equal(
    periodText({ start_at: '2026-11-20T06:00:00Z', end_at: '2026-11-21T10:30:00Z' }),
    'с 20.11.2026 11:00 до 21.11.2026 15:30',
  );
  assert.equal(
    whenText({
      start_at: null,
      end_at: null,
      weekdays: [1, 2, 3, 4, 5, 6, 7],
      hours: [],
    }),
    'Без срока; Каждый день; Весь день',
  );
  assert.equal(
    whenText({
      start_at: null,
      end_at: null,
      weekdays: [7, 6],
      hours: [
        { from: '18:00', to: '20:00' },
        { from: '12:00', to: '15:00' },
      ],
    }),
    'Без срока; Сб, Вс; 12:00-15:00, 18:00-20:00',
  );
  assert.equal(
    conditionsText({ requires_manager_pin: true, combinable: false }),
    'PIN начальника смены, не суммируется',
  );
  assert.equal(
    conditionsText({ requires_manager_pin: false, combinable: true }),
    'Без PIN, вместе с другими скидками',
  );
  assert.equal(stateText({ state: 'active', period: 'running' }), 'Включена, идёт');
  assert.equal(stateText({ state: 'draft', period: 'ended' }), 'Черновик, период закончился');
  assert.equal(stateText({ state: 'archived', period: 'always' }), 'В архиве');
  assert.deepEqual(stateActions({ state: 'draft' }), ['active', 'archived']);
  assert.deepEqual(stateActions({ state: 'active' }), ['draft', 'archived']);
  assert.deepEqual(stateActions({ state: 'archived' }), []);
  for (const text of [
    DISCOUNT_BANNER,
    ...Object.values(FORM_ERRORS),
    ...Object.values(DISCOUNT_ERRORS),
    ...Object.values(CHANNEL_LABELS),
  ])
    assert.doesNotMatch(text, LONG_DASH, text);
});

test('form values: a percent of 1-100 with two decimals, an amount in tenge up to 1 000 000 ₸', () => {
  for (const [text, bp] of [
    ['10', 1000],
    ['12,5', 1250],
    ['12.55', 1255],
    ['1', 100],
    ['100', 10000],
    [' 7 ', 700],
  ])
    assert.equal(percentBp(text), bp, text);
  for (const text of ['0', '0,99', '100,01', '101', '12,555', '-5', 'десять', '', '1e2'])
    assert.equal(percentBp(text), null, text);
  for (const [text, minor] of [
    ['500', '50000'],
    ['500,5', '50050'],
    ['1 500,50', '150050'],
    ['0,01', '1'],
    ['1000000', '100000000'],
  ])
    assert.equal(amountMinor(text), minor, text);
  for (const text of ['0', '0,00', '1000000,01', '10000000', '-1', '5,555', 'пятьсот', ''])
    assert.equal(amountMinor(text), null, text);
});

test('form payload: the server accepts what the form makes, and the form refuses what it refuses', () => {
  const ok = formPayload(form());
  assert.deepEqual(ok.errors, []);
  assert.equal(DiscountPayloadSchema.safeParse(ok.payload).success, true);
  assert.deepEqual(ok.payload, {
    name: 'Синтетический обед',
    kind: 'percent',
    percent_bp: 1000,
    value_minor: null,
    scope: { categories: [], products: [], channels: ['hall'] },
    schedule: { start_at: null, end_at: null, weekdays: [1, 2, 3, 4, 5, 6, 7], hours: [] },
    requires_manager_pin: true,
    combinable: false,
  });
  const full = formPayload(
    form({
      name: '  Синтетический ужин  ',
      kind: 'amount',
      value: '500',
      channels: ['kiosk', 'hall', 'chocofood'],
      whole: false,
      categories: ['chicken'],
      products: ['cola', 'wings'],
      startDay: '2026-11-20',
      endDay: '2026-11-30',
      weekdays: [5, 6],
      hours: [
        { from: '18:00', to: '24:00' },
        { from: '12:00', to: '15:00' },
      ],
      pin: false,
      combinable: true,
    }),
  );
  assert.deepEqual(full.errors, []);
  assert.equal(DiscountPayloadSchema.safeParse(full.payload).success, true);
  assert.deepEqual(full.payload.scope, {
    categories: ['chicken'],
    products: ['cola', 'wings'],
    channels: ['hall', 'chocofood', 'kiosk'],
  });
  assert.deepEqual(full.payload.schedule, {
    start_at: '2026-11-19T19:00:00.000Z',
    end_at: '2026-11-30T19:00:00.000Z',
    weekdays: [5, 6],
    hours: [
      { from: '12:00', to: '15:00' },
      { from: '18:00', to: '24:00' },
    ],
  });
  assert.equal(full.payload.value_minor, '50000');
  assert.equal(full.payload.name, 'Синтетический ужин');
  // The form of a stored discount gives back the same payload (round trip, kept bounds).
  for (const payload of [ok.payload, full.payload]) {
    const d = stored(payload);
    assert.deepEqual(
      formPayload(formOf(d)).payload,
      normalizeDiscount(DiscountPayloadSchema.parse(payload)),
    );
  }
  const odd = stored({
    ...ok.payload,
    schedule: {
      ...ok.payload.schedule,
      start_at: '2026-11-20T06:00:00.000Z',
      end_at: '2026-11-21T10:30:00.000Z',
    },
  });
  assert.deepEqual(formPayload(formOf(odd)).payload.schedule, odd.schedule);
  // A changed day of a kept bound takes midnight of the new day.
  assert.equal(
    formPayload({ ...formOf(odd), startDay: '2026-11-19' }).payload.schedule.start_at,
    '2026-11-18T19:00:00.000Z',
  );
  // Refusals in words, every one the server would refuse too.
  const cases = [
    [form({ name: ' ' }), FORM_ERRORS.name],
    [form({ name: 'а'.repeat(81) }), FORM_ERRORS.name],
    [form({ value: '0' }), FORM_ERRORS.percent],
    [form({ kind: 'amount', value: '0' }), FORM_ERRORS.amount],
    [form({ channels: [] }), FORM_ERRORS.channels],
    [form({ whole: false }), FORM_ERRORS.items],
    [form({ startDay: '2026-11-30', endDay: '2026-11-20' }), FORM_ERRORS.period],
    [form({ weekdays: [] }), FORM_ERRORS.weekdays],
    [form({ hours: [{ from: '15:00', to: '12:00' }] }), FORM_ERRORS.hours],
    [form({ hours: [{ from: '12:00', to: '' }] }), FORM_ERRORS.hours],
    [
      form({
        hours: [
          { from: '11:00', to: '14:00' },
          { from: '13:00', to: '15:00' },
        ],
      }),
      FORM_ERRORS.hours,
    ],
    [
      form({ hours: Array.from({ length: 5 }, (_, i) => ({ from: `1${i}:00`, to: `1${i}:30` })) }),
      FORM_ERRORS.hours,
    ],
  ];
  for (const [f, text] of cases) {
    const r = formPayload(f);
    assert.equal(r.payload, null, text);
    assert.ok(r.errors.includes(text), `${text}: ${r.errors}`);
  }
  // A single-day period is valid (from and to the same day, inclusive).
  assert.deepEqual(formPayload(form({ startDay: '2026-11-20', endDay: '2026-11-20' })).errors, []);
  assert.deepEqual(saveCommand('x', 0, ok.payload), {
    type: 'discount_save',
    id: 'x',
    expected_revision: 0,
    payload: ok.payload,
  });
  assert.deepEqual(stateCommand('x', 3, 'archived'), {
    type: 'discount_state',
    id: 'x',
    state: 'archived',
    expected_revision: 3,
  });
});

test('view: the answer is checked; filters by state', () => {
  const d1 = stored(formPayload(form()).payload, { state: 'active' });
  const d2 = stored(formPayload(form({ name: 'Второй' })).payload, { state: 'archived' });
  const view = {
    schema_version: 1,
    branch_id: branch,
    view: 'discounts',
    as_of: new Date().toISOString(),
    applied_at_pos: false,
    published_to_edge: false,
    channels: [...DISCOUNT_CHANNELS],
    catalog,
    discounts: [d1, d2],
    truncated: false,
  };
  assert.equal(discountsView(view, branch), view);
  for (const bad of [
    { ...view, branch_id: randomUUID() },
    { ...view, discounts: null },
    { ...view, discounts: [{ id: 'x' }] },
    { ...view, catalog: [] },
    { ...view, history: {} },
    null,
  ])
    assert.throws(() => discountsView(bad, branch), /INVALID_RESPONSE/);
  assert.deepEqual(visible([d1, d2], 'live'), [d1]);
  assert.deepEqual(visible([d1, d2], 'archived'), [d2]);
  assert.deepEqual(visible([d1, d2], 'all'), [d1, d2]);
  assert.deepEqual(visible([d1, d2], 'draft'), []);
});

test('sources: plain hyphens only in the discount module texts', async () => {
  for (const file of ['discounts.ts', 'discounts-model.ts'])
    assert.doesNotMatch(
      await readFile(new URL(`../../apps/backoffice/src/${file}`, import.meta.url), 'utf8'),
      LONG_DASH,
      file,
    );
});
