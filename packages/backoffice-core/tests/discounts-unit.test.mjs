import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  BACKOFFICE_P1_PERMISSIONS,
  BackofficeErrorReasonSchema,
  DISCOUNT_CHANNELS,
  DiscountPayloadSchema,
  DiscountSaveCommand,
  DiscountStateCommand,
  DiscountsQuery,
  P1Command,
  P1_COMMAND_FLAGS,
  P1_COMMAND_PERMISSIONS,
  P1_ROLE_PERMISSIONS,
  Request,
  can,
  discountPeriod,
  normalizeDiscount,
  permissionsOf,
  unknownItems,
} from '../dist/index.js';

/**
 * Discount rules of lane bo-ui step 7 (discounts.ts; design-bo-ui.md 5.8), without a database:
 * the payload a manager may save, its normal form, the period state, the scope check against
 * the catalog and the manager-only permission. Synthetic values.
 */
const ALL_DAYS = [1, 2, 3, 4, 5, 6, 7];
const percent = (extra = {}) => ({
  name: 'Синтетическая скидка 10',
  kind: 'percent',
  percent_bp: 1000,
  value_minor: null,
  scope: { categories: [], products: [], channels: ['hall'] },
  schedule: { start_at: null, end_at: null, weekdays: ALL_DAYS, hours: [] },
  requires_manager_pin: true,
  combinable: false,
  ...extra,
});
const amount = (value = '50000', extra = {}) =>
  percent({
    name: 'Синтетическая скидка 500',
    kind: 'amount',
    percent_bp: null,
    value_minor: value,
    ...extra,
  });
const ok = (p) => DiscountPayloadSchema.safeParse(p).success;
const scope = (extra) => ({ categories: [], products: [], channels: ['hall'], ...extra });
const schedule = (extra) => ({
  start_at: null,
  end_at: null,
  weekdays: ALL_DAYS,
  hours: [],
  ...extra,
});

test('payload: a percent 1-100 % or an amount in tiyn, never both, a name of 1-80 characters', () => {
  assert.equal(ok(percent()), true);
  assert.equal(ok(amount()), true);
  // 1 % and 100 %; a percent with two decimals (12,5 % = 1250 bp).
  for (const bp of [100, 1250, 10000]) assert.equal(ok(percent({ percent_bp: bp })), true, bp);
  for (const bp of [0, 1, 99, 10001, 12.5, '1000', null])
    assert.equal(ok(percent({ percent_bp: bp })), false, String(bp));
  // Whole tiyn up to 1 000 000 ₸.
  for (const v of ['1', '100', '100000000']) assert.equal(ok(amount(v)), true, v);
  for (const v of ['0', '-100', '1.5', '100000001', '0100', 100, null, ''])
    assert.equal(ok(amount(v)), false, String(v));
  // Exactly one of the two values.
  assert.equal(ok(percent({ value_minor: '100' })), false);
  assert.equal(ok(amount('100', { percent_bp: 1000 })), false);
  assert.equal(ok(percent({ percent_bp: null })), false);
  // The name: trimmed, 1..80, no control characters.
  assert.equal(DiscountPayloadSchema.parse(percent({ name: '  Обед  ' })).name, 'Обед');
  assert.equal(ok(percent({ name: 'а'.repeat(80) })), true);
  for (const name of ['', '   ', 'а'.repeat(81), 'Обед\nвечер', 'Tab\there', 42])
    assert.equal(ok(percent({ name })), false, JSON.stringify(name));
  // Strict: no unknown key, no id, state or revision in the payload.
  for (const key of ['id', 'state', 'revision', 'discount_minor', 'branch_id'])
    assert.equal(ok({ ...percent(), [key]: 'x' }), false, key);
  assert.equal(ok({ ...percent(), kind: 'fixed' }), false);
});

test('payload: the manager PIN is required and discounts do not stack unless said so', () => {
  const p = percent();
  delete p.requires_manager_pin;
  delete p.combinable;
  delete p.value_minor;
  const parsed = DiscountPayloadSchema.parse(p);
  assert.equal(parsed.requires_manager_pin, true);
  assert.equal(parsed.combinable, false);
  assert.equal(parsed.value_minor, null);
  assert.equal(ok(percent({ requires_manager_pin: false, combinable: true })), true);
  for (const v of ['true', 1, null])
    assert.equal(ok(percent({ requires_manager_pin: v })), false, String(v));
});

test('scope: catalog slugs, at least one of the six channels, no repeats', () => {
  assert.deepEqual(
    [...DISCOUNT_CHANNELS],
    ['hall', 'yandex_eda', 'glovo', 'chocofood', 'mobile', 'kiosk'],
  );
  assert.equal(ok(percent({ scope: scope({ channels: [...DISCOUNT_CHANNELS] }) })), true);
  assert.equal(
    ok(percent({ scope: scope({ categories: ['chicken'], products: ['wings-6', 'cola'] }) })),
    true,
  );
  for (const bad of [
    scope({ channels: [] }),
    scope({ channels: ['hall', 'hall'] }),
    scope({ channels: ['delivery'] }),
    scope({ channels: ['pos'] }),
    scope({ categories: ['Курица'] }),
    scope({ categories: ['chicken', 'chicken'] }),
    scope({ products: ['-wings'] }),
    scope({ products: Array.from({ length: 101 }, (_, i) => `p${i}`) }),
    scope({ categories: Array.from({ length: 31 }, (_, i) => `c${i}`) }),
    { categories: [], products: [] },
    { ...scope({}), stations: [] },
  ])
    assert.equal(ok(percent({ scope: bad })), false, JSON.stringify(bad));
});

test('schedule: period, ISO weekdays and up to four daily windows in Almaty time', () => {
  for (const good of [
    schedule({ start_at: '2026-11-20T00:00:00Z', end_at: '2026-11-30T19:00:00.000Z' }),
    schedule({ start_at: '2026-11-20T00:00:00Z' }),
    schedule({ end_at: '2026-12-31T19:00:00Z' }),
    schedule({ weekdays: [6, 7] }),
    schedule({ hours: [{ from: '00:00', to: '24:00' }] }),
    schedule({
      hours: [
        { from: '15:00', to: '17:00' },
        { from: '11:00', to: '13:00' },
        { from: '13:00', to: '14:00' },
        { from: '20:00', to: '23:59' },
      ],
    }),
  ])
    assert.equal(ok(percent({ schedule: good })), true, JSON.stringify(good));
  for (const bad of [
    schedule({ start_at: '2026-11-30T00:00:00Z', end_at: '2026-11-20T00:00:00Z' }),
    schedule({ start_at: '2026-11-20T00:00:00Z', end_at: '2026-11-20T00:00:00Z' }),
    schedule({ start_at: '2026-11-20' }),
    schedule({ start_at: '2026-11-20T00:00:00+05:00' }),
    schedule({ start_at: '1999-12-31T00:00:00Z' }),
    schedule({ weekdays: [] }),
    schedule({ weekdays: [0] }),
    schedule({ weekdays: [8] }),
    schedule({ weekdays: [1, 1] }),
    schedule({ weekdays: [1.5] }),
    schedule({ hours: [{ from: '15:00', to: '12:00' }] }),
    schedule({ hours: [{ from: '12:00', to: '12:00' }] }),
    schedule({ hours: [{ from: '24:00', to: '24:00' }] }),
    schedule({ hours: [{ from: '9:00', to: '12:00' }] }),
    schedule({ hours: [{ from: '12:00', to: '24:30' }] }),
    schedule({
      hours: [
        { from: '11:00', to: '14:00' },
        { from: '13:00', to: '15:00' },
      ],
    }),
    schedule({
      hours: Array.from({ length: 5 }, (_, i) => ({ from: `1${i}:00`, to: `1${i}:30` })),
    }),
    { start_at: null, end_at: null, weekdays: ALL_DAYS },
    { ...schedule({}), timezone: 'UTC' },
  ])
    assert.equal(ok(percent({ schedule: bad })), false, JSON.stringify(bad));
});

test('normal form: sorted lists, channels in the fixed order, instants as ISO strings', () => {
  const p = DiscountPayloadSchema.parse(
    percent({
      scope: scope({
        categories: ['drinks', 'chicken'],
        products: ['b', 'a'],
        channels: ['kiosk', 'hall', 'glovo'],
      }),
      schedule: schedule({
        start_at: '2026-11-20T00:00:00Z',
        weekdays: [7, 1, 3],
        hours: [
          { from: '18:00', to: '20:00' },
          { from: '12:00', to: '14:00' },
        ],
      }),
    }),
  );
  const n = normalizeDiscount(p);
  assert.deepEqual(n.scope, {
    categories: ['chicken', 'drinks'],
    products: ['a', 'b'],
    channels: ['hall', 'glovo', 'kiosk'],
  });
  assert.deepEqual(n.schedule, {
    start_at: '2026-11-20T00:00:00.000Z',
    end_at: null,
    weekdays: [1, 3, 7],
    hours: [
      { from: '12:00', to: '14:00' },
      { from: '18:00', to: '20:00' },
    ],
  });
  assert.deepEqual(normalizeDiscount(n), n);
  assert.equal(DiscountPayloadSchema.safeParse(n).success, true);
});

test('period: always, not started, running and ended ([start_at, end_at))', () => {
  const now = new Date('2026-11-25T07:00:00Z');
  const s = (start_at, end_at) => ({ start_at, end_at });
  assert.equal(discountPeriod(s(null, null), now), 'always');
  assert.equal(discountPeriod(s('2026-11-26T00:00:00Z', null), now), 'not_started');
  assert.equal(discountPeriod(s('2026-11-25T07:00:00Z', null), now), 'running');
  assert.equal(discountPeriod(s(null, '2026-11-25T07:00:00Z'), now), 'ended');
  assert.equal(discountPeriod(s(null, '2026-11-25T07:00:01Z'), now), 'running');
  assert.equal(discountPeriod(s('2026-11-01T00:00:00Z', '2026-11-20T00:00:00Z'), now), 'ended');
});

test('scope items the head catalog does not have', () => {
  const catalog = {
    version: 3,
    categories: [{ id: 'chicken', name: 'Курица' }],
    products: [{ id: 'wings-6', name: 'Крылья 6 шт', category_id: 'chicken' }],
  };
  assert.deepEqual(
    unknownItems(
      scope({ categories: ['chicken', 'drinks'], products: ['wings-6', 'cola'] }),
      catalog,
    ),
    { categories: ['drinks'], products: ['cola'] },
  );
  assert.deepEqual(unknownItems(scope({}), null), { categories: [], products: [] });
  assert.deepEqual(unknownItems(scope({ products: ['cola'] }), null), {
    categories: [],
    products: ['cola'],
  });
});

test('commands: only through the P1 schema, manager only, behind BACKOFFICE_DISCOUNTS_ENABLED', () => {
  const id = randomUUID();
  const save = { type: 'discount_save', id, expected_revision: 0, payload: percent() };
  const state = { type: 'discount_state', id, state: 'active', expected_revision: 1 };
  assert.equal(DiscountSaveCommand.safeParse(save).success, true);
  assert.equal(DiscountStateCommand.safeParse(state).success, true);
  for (const bad of [
    { ...state, expected_revision: 0 },
    { ...state, state: 'deleted' },
    { ...state, reason: 'x' },
    { ...save, payload: { ...percent(), state: 'active' } },
    { ...save, id: 'not-a-uuid' },
    { ...save, expected_revision: -1 },
  ])
    assert.equal(P1Command.safeParse(bad).success, false, JSON.stringify(bad));
  // The shared command union of the cloud lane does not know them.
  for (const command of [save, state])
    assert.equal(
      Request.safeParse({ request_id: randomUUID(), reason: 'Синтетика', command }).success,
      false,
    );
  assert.equal(P1_COMMAND_PERMISSIONS.discount_save, 'discounts.write');
  assert.equal(P1_COMMAND_PERMISSIONS.discount_state, 'discounts.write');
  assert.deepEqual(P1_COMMAND_FLAGS.discount_save, ['discountsEnabled']);
  assert.deepEqual(P1_COMMAND_FLAGS.discount_state, ['discountsEnabled']);
  // The permission: the manager only, the last P1 permission, listed only when asked for.
  assert.equal(BACKOFFICE_P1_PERMISSIONS.at(-1), 'discounts.write');
  assert.deepEqual(
    Object.fromEntries(
      ['manager', 'shift_manager', 'accountant', 'analyst'].map((r) => [
        r,
        can(r, 'discounts.write'),
      ]),
    ),
    { manager: true, shift_manager: false, accountant: false, analyst: false },
  );
  for (const role of ['shift_manager', 'accountant', 'analyst'])
    assert.equal(P1_ROLE_PERMISSIONS[role].includes('discounts.write'), false, role);
  assert.equal(permissionsOf('manager').includes('discounts.write'), false);
  assert.deepEqual(permissionsOf('manager', ['discounts.write']).at(-1), 'discounts.write');
  assert.equal(
    permissionsOf('shift_manager', ['discounts.write']).includes('discounts.write'),
    false,
  );
  for (const reason of ['DISCOUNT_NAME_TAKEN', 'DISCOUNT_ARCHIVED', 'DISCOUNT_PERIOD_ENDED'])
    assert.equal(BackofficeErrorReasonSchema.safeParse(reason).success, true, reason);
  // The view takes only an optional id.
  assert.equal(DiscountsQuery.safeParse({}).success, true);
  assert.equal(DiscountsQuery.safeParse({ id }).success, true);
  for (const q of [{ id: 'x' }, { state: 'active' }, { id: [id, id] }])
    assert.equal(DiscountsQuery.safeParse(q).success, false, JSON.stringify(q));
});
