import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPool } from '@pickchick/database';
import { provisionCatalogManager } from '../../catalog-admin/dist/index.js';
import { withSyncDatabases } from '../../../tests/helpers/sync.mjs';
import { backofficeGrants } from '../../../infra/staging/backoffice-grants.mjs';
import { backofficeP1Grants } from '../../../infra/staging/backoffice-p1-grants.mjs';
import {
  Backoffice,
  BackofficeError,
  TURNOVER_KINDS,
  runStockConsumption,
  stockEffect,
} from '../dist/index.js';
import {
  kitchen,
  linkFixture,
  people,
  posSale,
  publishMenuFixture,
  request,
  stockFixture,
} from './consumption-fixture.mjs';

/**
 * Stock reports of lane bo-ui2 step 4 (stock-reports.ts; design-bo-ui.md §9.4) on PostgreSQL:
 * the movement report reconciles (opening + kinds = opening + in - out = closing, the chain of
 * cloud017, adjacent windows, the balances of today); the balances at the last purchase price;
 * the reorder rule over consumption documents of 7 and 14 full days; whether sales are in the
 * numbers (the automatic consumption of bo-ui, the real worker); every role reads; flag off = the
 * answers of bo-ui. History is posted by SQL with the exact effect of the stock command
 * (stockEffect) at chosen past times, because a command always writes «now». Synthetic data only.
 */
const ON = Object.freeze({ rolesEnabled: true, stockV2Enabled: true, stockReportsEnabled: true });
const BO_UI = Object.freeze({ rolesEnabled: true, stockV2Enabled: true });
const is = (code, reason) => (error) =>
  error instanceof BackofficeError && error.code === code && error.reason === reason;
const almaty = (offsetDays = 0, at = new Date()) => {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Almaty' }).format(at);
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
};
/** Noon in Almaty (07:00 UTC) of the day `offsetDays` from today. */
const noon = (offsetDays, hour = 12) =>
  new Date(Date.parse(`${almaty(offsetDays)}T00:00:00Z`) + (hour - 5) * 3600000);

async function ingredient(bo, token, c, payload) {
  const id = randomUUID();
  await bo.command(
    token,
    c.branch,
    request(
      { type: 'save', kind: 'ingredient', id, expected_revision: 0, payload },
      'Синтетическая позиция',
    ),
  );
  return id;
}
async function balanceOf(db, branch, id) {
  return (
    await db.query(
      'SELECT quantity::text,value_minor::text,revision FROM bo_stock_balances WHERE branch_id=$1 AND ingredient_id=$2 FOR UPDATE',
      [branch, id],
    )
  ).rows[0];
}
/**
 * One stock document at a past instant with exactly the effect of the stock command: receipt
 * [[id, qty, value]], waste or consumption [[id, qty]], count [[id, counted]], production
 * { inputs: [[id, qty]], output: [id, qty] } (output value = cost of the inputs), reversal
 * { of } (the exact opposite movements). Runs in one transaction, like a command.
 */
async function post(c, actor, at, kind, lines, extra = {}) {
  const db = await c.cloud.pool.connect();
  const id = randomUUID();
  try {
    await db.query('BEGIN');
    await db.query(
      `INSERT INTO bo_stock_documents(id,branch_id,actor_id,kind,reference,reason,created_at,source_ref,reverses_document_id)
       VALUES($1,$2,$3,$4,$5,'Синтетическая история склада',$6,$7,$8)`,
      [
        id,
        c.branch,
        actor,
        kind,
        'СИН-' + kind,
        at,
        extra.source_ref ?? null,
        kind === 'reversal' ? lines.of : null,
      ],
    );
    const move = async (ingredient, e) => {
      await db.query(
        'UPDATE bo_stock_balances SET quantity=$3,value_minor=$4,revision=revision+1 WHERE branch_id=$1 AND ingredient_id=$2',
        [c.branch, ingredient, e.quantity, e.value_minor],
      );
      await db.query(
        'INSERT INTO bo_stock_movements(document_id,branch_id,ingredient_id,quantity_delta,value_delta_minor,balance_after,value_after_minor) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [
          id,
          c.branch,
          ingredient,
          e.quantity_delta,
          e.value_delta_minor,
          e.quantity,
          e.value_minor,
        ],
      );
    };
    if (kind === 'reversal') {
      for (const m of (
        await db.query(
          'SELECT ingredient_id,quantity_delta,value_delta_minor FROM bo_stock_movements WHERE document_id=$1',
          [lines.of],
        )
      ).rows) {
        const b = await balanceOf(db, c.branch, m.ingredient_id);
        const q = BigInt(b.quantity) - BigInt(m.quantity_delta),
          v = BigInt(b.value_minor) - BigInt(m.value_delta_minor);
        await move(m.ingredient_id, {
          quantity_delta: (-BigInt(m.quantity_delta)).toString(),
          value_delta_minor: (-BigInt(m.value_delta_minor)).toString(),
          quantity: q.toString(),
          value_minor: v.toString(),
        });
      }
    } else if (kind === 'production') {
      let cost = 0n;
      for (const [ingredient, quantity] of lines.inputs) {
        const e = stockEffect('waste', await balanceOf(db, c.branch, ingredient), {
          quantity,
          value_minor: '0',
        });
        cost -= BigInt(e.value_delta_minor);
        await move(ingredient, e);
      }
      const [output, quantity] = lines.output;
      await move(
        output,
        stockEffect('receipt', await balanceOf(db, c.branch, output), {
          quantity,
          value_minor: cost.toString(),
        }),
      );
    } else
      for (const [ingredient, quantity, value = '0'] of lines)
        await move(
          ingredient,
          stockEffect(
            kind === 'consumption' ? 'waste' : kind,
            await balanceOf(db, c.branch, ingredient),
            { quantity, value_minor: value },
          ),
        );
    await db.query('COMMIT');
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  } finally {
    db.release();
  }
  return id;
}
const pos = () => 'pos:' + randomUUID();
const stockOps = (bo, token, c, input) => bo.ops(token, c.branch, 'stock', input);
const movement = (bo, token, c, start, end) =>
  stockOps(bo, token, c, { view: 'movement', start_date: start, end_date: end });
const n = (v) => BigInt(v);
/** opening + every kind = closing, and opening + in - out = closing, quantity and value. */
function assertReconciles(row, label) {
  for (const k of ['quantity', 'value_minor']) {
    const kinds = TURNOVER_KINDS.reduce((s, kind) => s + n(row[kind][k]), 0n);
    assert.equal(n(row.opening[k]) + kinds, n(row.closing[k]), `${label}: kinds ${k}`);
    assert.equal(
      n(row.opening[k]) + n(row.in[k]) - n(row.out[k]),
      n(row.closing[k]),
      `${label}: in-out ${k}`,
    );
  }
}
async function history(c) {
  const p = await people(c);
  const bo = new Backoffice(c.cloud.pool, true, ON);
  const token = p.manager.token;
  const s = {
    fillet: await ingredient(bo, token, c, {
      name: 'Синтетическое филе',
      unit: 'g',
      minimum: '1000',
      active: true,
    }),
    bun: await ingredient(bo, token, c, {
      name: 'Синтетическая булка',
      unit: 'pcs',
      minimum: '10',
      active: true,
    }),
    breaded: await ingredient(bo, token, c, {
      name: 'Синтетическое филе в панировке',
      unit: 'g',
      minimum: '0',
      active: true,
    }),
    old: await ingredient(bo, token, c, {
      name: 'Синтетическая старая позиция',
      unit: 'pcs',
      minimum: '5',
      active: false,
    }),
  };
  const actor = p.manager.actor_id;
  // Before the window (20 days ago): the opening receipts.
  await post(c, actor, noon(-20), 'receipt', [
    [s.fillet, '5000', '1000000'],
    [s.bun, '50', '50000'],
  ]);
  await post(c, actor, noon(-19), 'receipt', [[s.fillet, '1000', '230000']]);
  // The window (10 to 3 days ago): sales, waste and its storno, production, a count.
  const waste = await post(c, actor, noon(-10), 'waste', [[s.fillet, '200']]);
  await post(
    c,
    actor,
    noon(-9),
    'consumption',
    [
      [s.fillet, '1000'],
      [s.bun, '5'],
    ],
    {
      source_ref: pos(),
    },
  );
  await post(c, actor, noon(-8), 'production', {
    inputs: [[s.fillet, '500']],
    output: [s.breaded, '450'],
  });
  await post(c, actor, noon(-7), 'reversal', { of: waste });
  await post(c, actor, noon(-6), 'count', [[s.fillet, '4400']]);
  const consumed = await post(c, actor, noon(-5), 'consumption', [[s.bun, '3']], {
    source_ref: pos(),
  });
  await post(c, actor, noon(-4), 'reversal', { of: consumed });
  // After the window (yesterday): another receipt.
  await post(c, actor, noon(-1), 'receipt', [[s.bun, '10', '12000']]);
  return { p, bo, token, s, actor };
}

test('movement: opening + movements = closing per ingredient and in total, chained to the balances', () =>
  withSyncDatabases(async (c) => {
    const { bo, token, s } = await history(c);
    const view = await movement(bo, token, c, almaty(-10), almaty(-3));
    const t = view.turnover;
    assert.deepEqual(t.mismatches, []);
    assert.equal(t.truncated.rows, false);
    const row = (id) => t.rows.find((r) => r.ingredient_id === id);
    for (const r of t.rows) assertReconciles(r, r.name);
    // Fillet: 6000 g at 1 230 000 before; -200 waste, +200 storno, -1000 sold, -500 into
    // production, count to 4400 (-100): closing 4400.
    const fillet = row(s.fillet);
    assert.deepEqual(fillet.opening, { quantity: '6000', value_minor: '1230000' });
    assert.equal(fillet.receipts.quantity, '0');
    assert.equal(fillet.waste.quantity, '-200');
    assert.equal(fillet.reversals.quantity, '200');
    assert.equal(fillet.consumption.quantity, '-1000');
    assert.equal(fillet.production_out.quantity, '-500');
    assert.equal(fillet.production_in.quantity, '0');
    assert.equal(fillet.counts.quantity, '-100');
    assert.equal(fillet.closing.quantity, '4400');
    assert.equal(fillet.in.quantity, '200');
    assert.equal(fillet.out.quantity, '1800');
    // The output of production comes in at the cost of its inputs.
    const breaded = row(s.breaded);
    assert.deepEqual(breaded.opening, { quantity: '0', value_minor: '0' });
    assert.equal(breaded.production_in.quantity, '450');
    assert.equal(
      breaded.production_in.value_minor,
      (-n(fillet.production_out.value_minor)).toString(),
    );
    // The bun: 50 at the start, 5 and 3 sold, the 3 reversed: 45.
    const bun = row(s.bun);
    assert.equal(bun.consumption.quantity, '-8');
    assert.equal(bun.reversals.quantity, '3');
    assert.equal(bun.closing.quantity, '45');
    // An ingredient that never moved is not a row.
    assert.equal(row(s.old), undefined);
    // Totals are values: the same identities over all rows.
    const kinds = TURNOVER_KINDS.reduce((sum, k) => sum + n(t.totals[k].value_minor), 0n);
    assert.equal(n(t.totals.opening.value_minor) + kinds, n(t.totals.closing.value_minor));
    assert.equal(
      n(t.totals.opening.value_minor) + n(t.totals.in.value_minor) - n(t.totals.out.value_minor),
      n(t.totals.closing.value_minor),
    );
    for (const k of ['opening', 'closing', ...TURNOVER_KINDS])
      assert.equal(
        t.totals[k].value_minor,
        t.rows.reduce((sum, r) => sum + n(r[k].value_minor), 0n).toString(),
        k,
      );
    // Adjacent windows: the closing of one is the opening of the next.
    const before = await movement(bo, token, c, almaty(-30), almaty(-11));
    const after = await movement(bo, token, c, almaty(-2), almaty(0));
    for (const id of [s.fillet, s.bun]) {
      assert.deepEqual(
        before.turnover.rows.find((r) => r.ingredient_id === id).closing,
        row(id).opening,
      );
      assert.deepEqual(
        after.turnover.rows.find((r) => r.ingredient_id === id).opening,
        row(id).closing,
      );
    }
    // A window from before the first document to today ends at the balances of «Остатки».
    const all = await movement(bo, token, c, almaty(-60), almaty(0));
    const now = (
      await c.cloud.pool.query(
        'SELECT ingredient_id,quantity::text,value_minor::text FROM bo_stock_balances WHERE branch_id=$1',
        [c.branch],
      )
    ).rows;
    for (const b of now) {
      const r = all.turnover.rows.find((x) => x.ingredient_id === b.ingredient_id);
      if (!r) {
        assert.equal(b.quantity, '0');
        continue;
      }
      assert.deepEqual(r.opening, { quantity: '0', value_minor: '0' });
      assert.deepEqual(r.closing, { quantity: b.quantity, value_minor: b.value_minor });
      assertReconciles(r, 'all ' + r.name);
    }
    // A real command today joins the chain: the window of today still reconciles to the balance.
    const fresh = (
      await c.cloud.pool.query('SELECT revision FROM bo_stock_balances WHERE ingredient_id=$1', [
        s.fillet,
      ])
    ).rows[0].revision;
    await bo.command(
      token,
      c.branch,
      request({
        type: 'stock',
        kind: 'waste',
        reference: 'СП-7',
        reason_code: 'defect',
        lines: [
          { ingredient_id: s.fillet, quantity: '400', value_minor: '0', expected_revision: fresh },
        ],
      }),
    );
    const today = (await movement(bo, token, c, almaty(0), almaty(0))).turnover;
    const f = today.rows.find((r) => r.ingredient_id === s.fillet);
    assert.equal(f.waste.quantity, '-400');
    assert.equal(f.closing.quantity, '4000');
    assertReconciles(f, 'today');
    assert.deepEqual(today.mismatches, []);
    // The rest of the answer is the bo-ui movement view, keys and values.
    const plain = await movement(
      new Backoffice(c.cloud.pool, true, BO_UI),
      token,
      c,
      almaty(-10),
      almaty(-3),
    );
    const { turnover, consumption, ...rest } = view;
    assert.ok(turnover && consumption);
    assert.deepEqual(Object.keys(view).slice(0, -2), Object.keys(plain));
    assert.deepEqual({ ...rest, as_of: null }, { ...plain, as_of: null });
    assert.deepEqual(consumption, {
      mode: 'unavailable',
      start_at: null,
      backlog: null,
      sales_included: false,
    });
  }));

test('balances: minimum, below it, counted_at, last movement and the value at the last purchase price', () =>
  withSyncDatabases(async (c) => {
    const { bo, token, s, actor } = await history(c);
    // A later receipt of the fillet that is reversed does not set the purchase price.
    const reversed = await post(c, actor, noon(-1, 14), 'receipt', [[s.fillet, '100', '99900']]);
    await post(c, actor, noon(-1, 15), 'reversal', { of: reversed });
    // A count today by command moves counted_at (stock P1).
    const rev = (
      await c.cloud.pool.query('SELECT revision FROM bo_stock_balances WHERE ingredient_id=$1', [
        s.bun,
      ])
    ).rows[0].revision;
    await bo.command(
      token,
      c.branch,
      request({
        type: 'stock',
        kind: 'count',
        reference: 'ИНВ-7',
        lines: [{ ingredient_id: s.bun, quantity: '8', value_minor: '0', expected_revision: rev }],
      }),
    );
    const view = await stockOps(bo, token, c, { view: 'balances' });
    assert.equal(view.view, 'balances');
    const row = (id) => view.rows.find((r) => r.ingredient_id === id);
    assert.equal(view.rows.length, 4);
    // Fillet 4400 g; its last valid purchase is 1000 g for 230 000: 4400 × 230 = 1 012 000.
    const fillet = row(s.fillet);
    assert.equal(fillet.quantity, '4400');
    assert.equal(fillet.minimum, '1000');
    assert.equal(fillet.below_minimum, false);
    assert.equal(fillet.last_purchase.quantity, '1000');
    assert.equal(fillet.last_purchase.value_minor, '230000');
    assert.equal(fillet.value_last_price_minor, '1012000');
    assert.equal(fillet.last_movement_at, noon(-1, 15).toISOString());
    assert.equal(fillet.counted_at, null);
    // Bun counted to 8 (minimum 10): below; last purchase 10 for 12 000 -> 8 × 1 200 = 9 600.
    const bun = row(s.bun);
    assert.equal(bun.quantity, '8');
    assert.equal(bun.below_minimum, true);
    assert.equal(bun.value_last_price_minor, '9600');
    assert.ok(bun.counted_at);
    // Output of production: no purchase, so no value at a purchase price.
    assert.equal(row(s.breaded).last_purchase, null);
    assert.equal(row(s.breaded).value_last_price_minor, null);
    // An inactive position is never «ниже минимума».
    assert.equal(row(s.old).active, false);
    assert.equal(row(s.old).below_minimum, false);
    assert.equal(view.totals.below_minimum, 1);
    assert.equal(view.totals.items, 4);
    assert.equal(view.totals.active, 3);
    assert.equal(view.totals.unpriced, 1);
    assert.equal(
      view.totals.value_minor,
      view.rows.reduce((sum, r) => sum + n(r.value_minor), 0n).toString(),
    );
    assert.equal(view.totals.value_last_price_minor, (1012000n + 9600n).toString());
    // The same balances as GET branches/:id.
    const read = await bo.read(token, c.branch);
    for (const r of read.stock) assert.equal(row(r.id).quantity, r.quantity ?? '0', r.payload.name);
    assert.equal(view.consumption.mode, 'unavailable');
  }));

test('reorder: below or near the target, average use of 7 and 14 full days, meat = 3 days', () =>
  withSyncDatabases(async (c) => {
    const p = await people(c);
    const bo = new Backoffice(c.cloud.pool, true, ON);
    const token = p.manager.token;
    const actor = p.manager.actor_id;
    // The meat flag is a field of the card while the stock reports are on.
    const chicken = await ingredient(bo, token, c, {
      name: 'Синтетическая курица',
      unit: 'g',
      minimum: '2000',
      active: true,
      meat: true,
    });
    const box = await ingredient(bo, token, c, {
      name: 'Синтетическая коробка',
      unit: 'pcs',
      minimum: '100',
      active: true,
    });
    const sauce = await ingredient(bo, token, c, {
      name: 'Синтетический соус',
      unit: 'ml',
      minimum: '500',
      active: true,
    });
    const breaded = await ingredient(bo, token, c, {
      name: 'Синтетическая заготовка',
      unit: 'g',
      minimum: '0',
      active: true,
    });
    const idle = await ingredient(bo, token, c, {
      name: 'Синтетическая выключенная позиция',
      unit: 'pcs',
      minimum: '50',
      active: false,
    });
    await post(c, actor, noon(-20), 'receipt', [
      [chicken, '40000', '8000000'],
      [box, '300', '150000'],
      [sauce, '560', '56000'],
    ]);
    // 14 days ago .. 8 days ago: 1000 g of chicken a day into production (raw meat is used by
    // production, not sold); the last 7 days: 2000 g a day, of it 500 g sold directly.
    for (let d = -14; d <= -8; d++)
      await post(c, actor, noon(d), 'production', {
        inputs: [[chicken, '1000']],
        output: [breaded, '900'],
      });
    for (let d = -7; d <= -1; d++) {
      await post(c, actor, noon(d), 'production', {
        inputs: [[chicken, '1500']],
        output: [breaded, '1350'],
      });
      const sold = await post(
        c,
        actor,
        noon(d, 13),
        'consumption',
        [
          [chicken, '500'],
          [box, '20'],
        ],
        {
          source_ref: pos(),
        },
      );
      // Waste never counts as use; a storno of a sale reduces the use of the day it is made.
      if (d === -3) {
        await post(c, actor, noon(d, 15), 'waste', [[box, '10']]);
        await post(c, actor, noon(d, 18), 'reversal', { of: sold });
      }
    }
    // Today is not a full day: its sales are not in the averages.
    await post(c, actor, new Date(Date.now() - 500), 'consumption', [[box, '50']], {
      source_ref: pos(),
    });
    const view = await stockOps(bo, token, c, { view: 'reorder' });
    assert.equal(view.view, 'reorder');
    assert.deepEqual(view.rule, { meat_days: 3, near_percent: 20, use_days: [7, 14] });
    assert.deepEqual(view.periods.d7, { days: 7, start_date: almaty(-7), end_date: almaty(-1) });
    assert.deepEqual(view.periods.d14, { days: 14, start_date: almaty(-14), end_date: almaty(-1) });
    const row = (id) => view.rows.find((r) => r.ingredient_id === id);
    // Chicken: 40000 - 7×1000 - 7×2000 + 500 (storno) = 19500 g. Use 13500 in 7 days, 20500
    // in 14: the 7-day average is larger: 3 days = ceil(3 × 13500 / 7) = 5786 > minimum 2000.
    // 19500 is far above: not listed. Then the chicken runs low (a count to 5000).
    assert.equal(row(chicken), undefined);
    const rev = (
      await c.cloud.pool.query('SELECT revision FROM bo_stock_balances WHERE ingredient_id=$1', [
        chicken,
      ])
    ).rows[0].revision;
    await bo.command(
      token,
      c.branch,
      request({
        type: 'stock',
        kind: 'count',
        reference: 'ИНВ-8',
        lines: [
          { ingredient_id: chicken, quantity: '5000', value_minor: '0', expected_revision: rev },
        ],
      }),
    );
    const again = await stockOps(bo, token, c, { view: 'reorder' });
    const meat = again.rows.find((r) => r.ingredient_id === chicken);
    assert.equal(meat.meat, true);
    assert.deepEqual(meat.use, {
      d7: { quantity: '13500', days: 7 },
      d14: { quantity: '20500', days: 14 },
    });
    assert.deepEqual(meat.rate, { quantity: '13500', days: 7 });
    assert.equal(meat.target, '5786');
    assert.equal(meat.target_rule, 'meat_days');
    assert.equal(meat.hint, '786');
    // floor(5000 × 7 / 13500) = 2 days.
    assert.equal(meat.days_left, '2');
    assert.equal(meat.state, 'below');
    // 8000000 / 40000 = 200 tiyn a gram at the last purchase: 786 g = 157 200.
    assert.equal(meat.hint_value_minor, '157200');
    // Boxes: 300 - 7×20 + 20 (storno) - 10 waste - 50 today = 120 ≤ 100 + 20 %: near.
    // Use: 140 - 20 = 120 in 7 days: 120 boxes last 7 days.
    const boxes = again.rows.find((r) => r.ingredient_id === box);
    assert.equal(boxes.balance, '120');
    assert.equal(boxes.target, '100');
    assert.equal(boxes.target_rule, 'minimum');
    assert.equal(boxes.hint, '0');
    assert.equal(boxes.state, 'near');
    assert.deepEqual(boxes.use.d7, { quantity: '120', days: 7 });
    assert.deepEqual(boxes.use.d14, { quantity: '120', days: 14 });
    assert.equal(boxes.days_left, '7');
    // Sauce 560 ml, minimum 500, no use: near (560 ≤ 600), no days.
    const s = again.rows.find((r) => r.ingredient_id === sauce);
    assert.equal(s.state, 'near');
    assert.equal(s.rate, null);
    assert.equal(s.days_left, null);
    // The output of production has no target; an inactive position is never listed.
    assert.equal(
      again.rows.find((r) => r.ingredient_id === breaded),
      undefined,
    );
    assert.equal(
      again.rows.find((r) => r.ingredient_id === idle),
      undefined,
    );
    // Below first, then by days left.
    assert.deepEqual(
      again.rows.map((r) => r.ingredient_id),
      [chicken, box, sauce],
    );
    assert.deepEqual(again.totals, {
      rows: 3,
      below: 1,
      near: 2,
      hint_value_minor: '157200',
      unpriced: 0,
    });
    assert.equal(again.consumption.sales_included, false);
    // A storno made today of a sale of yesterday (500 g of chicken, 20 boxes) counts today: the
    // balance grows, the averages stay. Boxes are then above the target and leave the list.
    const doc = (
      await c.cloud.pool.query(
        "SELECT d.id FROM bo_stock_documents d JOIN bo_stock_movements m ON m.document_id=d.id WHERE d.kind='consumption' AND m.ingredient_id=$1 AND d.created_at < $2 ORDER BY d.created_at DESC LIMIT 1",
        [box, noon(0, 0)],
      )
    ).rows[0].id;
    await post(c, actor, new Date(), 'reversal', { of: doc });
    const third = await stockOps(bo, token, c, { view: 'reorder' });
    const later = third.rows.find((r) => r.ingredient_id === chicken);
    assert.equal(later.balance, '5500');
    assert.deepEqual(later.use.d7, { quantity: '13500', days: 7 });
    assert.equal(later.hint, '286');
    assert.equal(
      third.rows.find((r) => r.ingredient_id === box),
      undefined,
    );
    // And the movement of today still reconciles with it.
    const whole = (await movement(bo, token, c, almaty(-20), almaty(0))).turnover;
    assert.deepEqual(whole.mismatches, []);
    for (const r of whole.rows) assertReconciles(r, 'reorder ' + r.name);
  }));

test('sales in the numbers: the real worker writes off, the periods start with the write-off', () =>
  withSyncDatabases(async (c) => {
    const p = await people(c);
    const options = { ...ON, stockAutoconsumeEnabled: true };
    const bo = new Backoffice(c.cloud.pool, true, options);
    const token = p.manager.token;
    const { release } = await publishMenuFixture(c);
    const s = await stockFixture(bo, token, c);
    await linkFixture(bo, token, c, s);
    // Off: the stock reports say sales are not written off.
    let view = await stockOps(bo, token, c, { view: 'reorder' });
    assert.equal(view.consumption.mode, 'off');
    assert.equal(view.consumption.sales_included, false);
    assert.equal(view.periods.d7.days, 7);
    // On since two hours ago: no full day of sales yet, the averages wait.
    const start = new Date(Date.now() - 2 * 3600000);
    await bo.command(
      token,
      c.branch,
      request({
        type: 'stock_settings',
        autoconsume_mode: 'on',
        start_at: start.toISOString(),
        expected_revision: 0,
      }),
    );
    const sale = await posSale(c, release, {
      at: new Date(Date.now() - 10 * 60000),
      number: 61,
      lines: [['fries', 2]],
    });
    await kitchen(c, sale, 'in_production');
    const done = await runStockConsumption(
      c.cloud.pool,
      options,
      () => new Date(),
      (e) => {
        throw e;
      },
    );
    assert.equal(done.states.applied, 1);
    view = await stockOps(bo, token, c, { view: 'reorder' });
    assert.equal(view.consumption.mode, 'on');
    assert.equal(view.consumption.start_at, start.toISOString());
    assert.equal(view.consumption.backlog.stalled, false);
    assert.equal(view.consumption.sales_included, true);
    assert.equal(view.periods.d7.days, 0);
    assert.equal(view.periods.d14.start_date, null);
    // The movement of today shows the sale as «consumption» (2 × 150 g of potato).
    const today = await movement(bo, token, c, almaty(0), almaty(0));
    const potato = today.turnover.rows.find((r) => r.ingredient_id === s.potato);
    assert.equal(potato.consumption.quantity, '-300');
    assertReconciles(potato, 'potato');
    assert.equal(today.consumption.sales_included, true);
    // dry_run: written off nowhere, so not included.
    await bo.command(
      token,
      c.branch,
      request({
        type: 'stock_settings',
        autoconsume_mode: 'dry_run',
        start_at: start.toISOString(),
        expected_revision: 1,
      }),
    );
    const dry = await stockOps(bo, token, c, { view: 'reorder' });
    assert.equal(dry.consumption.mode, 'dry_run');
    assert.equal(dry.consumption.sales_included, false);
    assert.equal(dry.periods.d7.days, 7);
  }));

test('every role reads the three reports; a person without the branch does not', () =>
  withSyncDatabases(async (c) => {
    const { p, bo } = await history(c);
    for (const who of ['manager', 'shift', 'accountant', 'analyst']) {
      const token = p[who].token;
      for (const input of [
        { view: 'balances' },
        { view: 'reorder' },
        { view: 'movement', start_date: almaty(-10), end_date: almaty(0) },
      ]) {
        const out = await stockOps(bo, token, c, input);
        assert.equal(out.view, input.view, `${who} ${input.view}`);
      }
    }
    const read = await bo.read(p.analyst.token, c.branch);
    assert.equal(read.capabilities.stock_reports, true);
    assert.equal(Object.keys(read.capabilities).at(-1), 'stock_reports');
    // No new permission: reading is reports.read.
    assert.deepEqual(
      read.permissions,
      (await new Backoffice(c.cloud.pool, true, BO_UI).read(p.analyst.token, c.branch)).permissions,
    );
    await assert.rejects(stockOps(bo, 'f'.repeat(64), c, { view: 'balances' }), is('UNAUTHORIZED'));
    // A person of the organisation without a grant on the branch.
    const stranger = await provisionCatalogManager(c.cloud.pool, {
      organization_id: c.org,
      name: 'Синтетический посторонний',
      branch_ids: [c.branch],
    });
    for (const view of ['balances', 'reorder'])
      await assert.rejects(stockOps(bo, stranger.token, c, { view }), is('FORBIDDEN'));
    // Strict queries: no extra keys, a window of at most 92 days.
    await assert.rejects(
      stockOps(bo, p.manager.token, c, { view: 'balances', date: almaty() }),
      is('INVALID_REQUEST'),
    );
    await assert.rejects(
      stockOps(bo, p.manager.token, c, { view: 'reorder', days: '7' }),
      is('INVALID_REQUEST'),
    );
    await assert.rejects(
      movement(bo, p.manager.token, c, almaty(-92), almaty(0)),
      is('INVALID_REQUEST'),
    );
    assert.ok(await movement(bo, p.manager.token, c, almaty(-91), almaty(0)));
  }));

test('flag off: the queries of bo-ui, no turnover, no key; the meat field is kept, not taken', () =>
  withSyncDatabases(async (c) => {
    const { p, bo, token, s } = await history(c);
    for (const options of [{}, BO_UI, { ...BO_UI, supplyEnabled: true }]) {
      const off = new Backoffice(c.cloud.pool, true, options);
      for (const view of ['balances', 'reorder'])
        await assert.rejects(
          stockOps(off, token, c, { view }),
          options.stockV2Enabled ? is('INVALID_REQUEST') : is('NOT_FOUND', 'STOCK_V2_DISABLED'),
          view,
        );
      if (options.stockV2Enabled) {
        const m = await movement(off, token, c, almaty(-10), almaty(0));
        assert.equal('turnover' in m, false);
        assert.equal('consumption' in m, false);
      }
      const read = await off.read(token, c.branch);
      assert.equal('stock_reports' in read.capabilities, false);
    }
    // The flag without stock v2 (loadConfig refuses it): the key is false, the view is the 404.
    const alone = new Backoffice(c.cloud.pool, true, {
      rolesEnabled: true,
      stockReportsEnabled: true,
    });
    assert.equal((await alone.read(token, c.branch)).capabilities.stock_reports, false);
    await assert.rejects(
      stockOps(alone, token, c, { view: 'balances' }),
      is('NOT_FOUND', 'STOCK_V2_DISABLED'),
    );
    // The meat field: taken with the flag, refused without it, and kept by a server without it.
    const save = (server, revision, payload) =>
      server.command(
        token,
        c.branch,
        request({
          type: 'save',
          kind: 'ingredient',
          id: s.fillet,
          expected_revision: revision,
          payload,
        }),
      );
    const card = { name: 'Синтетическое филе', unit: 'g', minimum: '1000', active: true };
    const plain = new Backoffice(c.cloud.pool, true, BO_UI);
    await assert.rejects(save(plain, 1, { ...card, meat: true }), is('INVALID_REQUEST'));
    await assert.rejects(
      save(plain, 1, { ...card, supply_kind: 'supplier' }),
      is('INVALID_REQUEST'),
    );
    // supply_kind needs the supply flag, meat the stock reports.
    await assert.rejects(save(bo, 1, { ...card, supply_kind: 'supplier' }), is('INVALID_REQUEST'));
    const saved = await save(bo, 1, { ...card, meat: true });
    assert.equal(saved.payload.meat, true);
    const both = new Backoffice(c.cloud.pool, true, { ...ON, supplyEnabled: true });
    const kinded = await save(both, 2, { ...card, meat: true, supply_kind: 'supplier' });
    assert.equal(kinded.payload.supply_kind, 'supplier');
    // Rollback: bo-ui keeps the stored fields; the card sent back unchanged is saved.
    const back = await save(plain, 3, {
      ...card,
      meat: true,
      supply_kind: 'supplier',
      minimum: '1500',
    });
    assert.deepEqual(back.payload, {
      ...card,
      minimum: '1500',
      meat: true,
      supply_kind: 'supplier',
    });
    const left = await save(plain, 4, { ...card, minimum: '1200' });
    assert.equal(left.payload.meat, true);
    assert.equal(left.payload.supply_kind, 'supplier');
    // A changed value is refused without the flag.
    await assert.rejects(save(plain, 5, { ...card, meat: false }), is('INVALID_REQUEST'));
    // With its flag a field can be cleared; the other one is kept.
    const cleared = await save(bo, 5, { ...card, supply_kind: 'supplier' });
    assert.equal('meat' in cleared.payload, false);
    assert.equal(cleared.payload.supply_kind, 'supplier');
    const unset = await save(both, 6, { ...card });
    assert.deepEqual(unset.payload, card);
    assert.ok(p);
  }));

test('API role: the reports run with the grants the back office already has', () =>
  withSyncDatabases(async (c) => {
    const { p, s } = await history(c);
    const schema = c.cloud.schema;
    const role = 'bo_sr_' + randomUUID().replaceAll('-', '');
    let pool;
    await c.cloud.admin.query(
      `CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
    );
    try {
      await c.cloud.pool.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
      await c.cloud.pool.query(backofficeGrants(role, true));
      const url = new URL(c.cloud.config.databaseUrl);
      url.searchParams.set('options', `-c search_path=${schema} -c role=${role}`);
      pool = createPool(url.toString());
      const bo = new Backoffice(pool, true, ON);
      const token = p.manager.token;
      const owner = new Backoffice(c.cloud.pool, true, ON);
      const same = async (input) =>
        assert.deepEqual(
          { ...(await stockOps(bo, token, c, input)), as_of: null },
          { ...(await stockOps(owner, token, c, input)), as_of: null },
          input.view,
        );
      // Cloud lane grants only (the table rights of 017 cover the 074 and 075 columns): the
      // key is on and every report is exactly the owner's.
      assert.equal((await bo.read(token, c.branch)).capabilities.stock_reports, true);
      assert.equal((await stockOps(bo, token, c, { view: 'balances' })).counted_at_known, true);
      await same({ view: 'balances' });
      const m = await movement(bo, token, c, almaty(-10), almaty(-3));
      assert.deepEqual(m.turnover.mismatches, []);
      for (const r of m.turnover.rows) assertReconciles(r, 'lane ' + r.name);
      assert.deepEqual(
        m.turnover,
        (await movement(owner, token, c, almaty(-10), almaty(-3))).turnover,
      );
      // With the bo-ui helper (stock P1) as well: still the same numbers.
      await c.cloud.pool.query(
        backofficeP1Grants(
          role,
          {
            backoffice: true,
            posDay: false,
            stockV2: true,
            autoconsume: false,
            managerShifts: false,
            discounts: false,
          },
          schema,
        ),
      );
      await same({ view: 'balances' });
      await same({ view: 'reorder' });
      assert.ok(
        (await stockOps(bo, token, c, { view: 'balances' })).rows.some(
          (r) => r.ingredient_id === s.bun,
        ),
      );
      // The API role still cannot change the history.
      await assert.rejects(pool.query('DELETE FROM bo_stock_movements'), (e) => e.code === '42501');
    } finally {
      await pool?.end();
      await c.cloud.admin.query(`DROP OWNED BY ${role}`);
      await c.cloud.admin.query(`DROP ROLE ${role}`);
    }
  }));
