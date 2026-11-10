import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INGREDIENT_P2_KEYS,
  REORDER_MEAT_DAYS,
  REORDER_NEAR_PERCENT,
  atPurchasePrice,
  ingredientP2Keys,
  reorderRule,
  usePeriod,
} from '../dist/index.js';

/**
 * The pure rules of the stock reports (lane bo-ui2 step 4, stock-reports.ts): the reorder target,
 * the suggested quantity, «хватит на N дней», the periods of the average use and the value at the
 * last purchase price. Whole numbers only; synthetic quantities.
 */
const rule = (balance, minimum, meat, use = []) =>
  reorderRule({
    balance: BigInt(balance),
    minimum: BigInt(minimum),
    meat,
    use: use.map(([quantity, days]) => ({ quantity: BigInt(quantity), days })),
  });

test('the rule is the one the cabinet explains: 3 days for meat, 20 % for «рядом»', () => {
  assert.equal(REORDER_MEAT_DAYS, 3);
  assert.equal(REORDER_NEAR_PERCENT, 20);
});

test('not meat: target = minimum, hint = max(0, minimum - balance), the use only tells the days', () => {
  assert.deepEqual(rule('4', '10', false), {
    rate: null,
    days_left: null,
    target: '10',
    target_rule: 'minimum',
    hint: '6',
    state: 'below',
  });
  // 10 pieces used in 7 days: 4 pieces last 2 days (floor), the target stays the minimum.
  assert.deepEqual(
    rule('4', '10', false, [
      ['10', 7],
      ['14', 14],
    ]),
    {
      rate: { quantity: '10', days: 7 },
      days_left: '2',
      target: '10',
      target_rule: 'minimum',
      hint: '6',
      state: 'below',
    },
  );
  // Near: balance at most the target plus 20 %; above it the row is not listed.
  assert.equal(rule('12', '10', false).state, 'near');
  assert.equal(rule('12', '10', false).hint, '0');
  assert.equal(rule('13', '10', false).state, null);
  // Exactly at the minimum: nothing to order, but near.
  assert.equal(rule('10', '10', false).hint, '0');
  assert.equal(rule('10', '10', false).state, 'near');
  // Without a minimum and not meat: not tracked.
  assert.equal(rule('0', '0', false).state, null);
  assert.equal(rule('0', '0', false, [['500', 7]]).state, null);
});

test('meat: target = 3 days of the larger average, never below the minimum, rounded up', () => {
  // 7000 g in 7 days (1000 a day) and 21000 g in 14 days (1500 a day): the larger one counts.
  assert.deepEqual(
    rule('2000', '1000', true, [
      ['7000', 7],
      ['21000', 14],
    ]),
    {
      rate: { quantity: '21000', days: 14 },
      days_left: '1',
      target: '4500',
      target_rule: 'meat_days',
      hint: '2500',
      state: 'below',
    },
  );
  // 10 pcs in 7 days: 3 days = 4.28... -> 5 (up, so the kitchen does not run out).
  assert.equal(
    rule('0', '0', true, [
      ['10', 7],
      ['0', 14],
    ]).target,
    '5',
  );
  // 3 days of use below the minimum: the minimum stays the target.
  const low = rule('500', '1000', true, [
    ['100', 7],
    ['150', 14],
  ]);
  assert.equal(low.target, '1000');
  assert.equal(low.target_rule, 'minimum');
  assert.equal(low.hint, '500');
  // Meat without use data: the minimum.
  assert.deepEqual(
    rule('200', '1000', true, [
      ['0', 7],
      ['0', 14],
    ]),
    {
      rate: null,
      days_left: null,
      target: '1000',
      target_rule: 'minimum',
      hint: '800',
      state: 'below',
    },
  );
  // A period without full days (the write-off started today) is not an average.
  const fresh = rule('100', '0', true, [
    ['900', 0],
    ['900', 0],
  ]);
  assert.equal(fresh.rate, null);
  assert.equal(fresh.state, null);
  // Enough meat for more than 3 days of use plus 20 %: not listed.
  assert.equal(rule('4000', '0', true, [['7000', 7]]).state, null);
  assert.equal(rule('3600', '0', true, [['7000', 7]]).state, 'near');
});

test('the periods of the average: full Almaty days before today, from the first full day of the write-off', () => {
  const off = { mode: 'off', start_at: null };
  assert.deepEqual(usePeriod('2026-11-25', 7, off), {
    days: 7,
    start_date: '2026-11-18',
    end_date: '2026-11-24',
  });
  assert.deepEqual(usePeriod('2026-11-25', 14, off), {
    days: 14,
    start_date: '2026-11-11',
    end_date: '2026-11-24',
  });
  // dry_run writes nothing off: the period is not cut.
  assert.equal(
    usePeriod('2026-11-25', 7, { mode: 'dry_run', start_at: '2026-11-24T00:00:00Z' }).days,
    7,
  );
  // On since 20.11 10:00 Almaty: the first full day is 21.11.
  assert.deepEqual(
    usePeriod('2026-11-25', 7, { mode: 'on', start_at: '2026-11-20T05:00:00.000Z' }),
    {
      days: 4,
      start_date: '2026-11-21',
      end_date: '2026-11-24',
    },
  );
  // On since 20.11 00:00 Almaty (19.11 19:00 UTC): 20.11 is full.
  assert.equal(
    usePeriod('2026-11-25', 7, { mode: 'on', start_at: '2026-11-19T19:00:00.000Z' }).days,
    5,
  );
  // On since today: no full day yet.
  assert.deepEqual(
    usePeriod('2026-11-25', 14, { mode: 'on', start_at: '2026-11-25T01:00:00.000Z' }),
    {
      days: 0,
      start_date: null,
      end_date: '2026-11-24',
    },
  );
  // On long ago: the whole period.
  assert.equal(
    usePeriod('2026-11-25', 14, { mode: 'on', start_at: '2026-10-01T00:00:00Z' }).days,
    14,
  );
});

test('value at the last purchase price: whole tiyn, half up; unknown without a purchase', () => {
  const p = {
    quantity: '3',
    value_minor: '1000',
    at: '2026-11-18T05:00:00.000Z',
    document_id: 'x',
  };
  assert.equal(atPurchasePrice(1n, p), '333');
  assert.equal(atPurchasePrice(2n, p), '667');
  assert.equal(atPurchasePrice(0n, p), '0');
  assert.equal(atPurchasePrice(5n, undefined), null);
});

test('second-wave ingredient fields: each only with its flag (and stock v2)', () => {
  assert.deepEqual(INGREDIENT_P2_KEYS, ['supply_kind', 'meat']);
  assert.deepEqual(ingredientP2Keys({}), { on: [], off: ['supply_kind', 'meat'] });
  assert.deepEqual(ingredientP2Keys({ stockReportsEnabled: true }), {
    on: [],
    off: ['supply_kind', 'meat'],
  });
  assert.deepEqual(ingredientP2Keys({ stockReportsEnabled: true, stockV2Enabled: true }), {
    on: ['meat'],
    off: ['supply_kind'],
  });
  assert.deepEqual(
    ingredientP2Keys({ supplyEnabled: true, stockReportsEnabled: true, stockV2Enabled: true }),
    { on: ['supply_kind', 'meat'], off: [] },
  );
});
