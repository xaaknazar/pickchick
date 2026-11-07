// Synthetic stock history of the stock report tests (lane bo-ui2 step 4, stock-reports.ts):
// documents at chosen past instants with exactly the effect of the stock command (stockEffect),
// because a command always writes «now». Shared by stock-reports.test.mjs and the cabinet browser
// test. Every name, number and amount is made up.
import { randomUUID } from 'node:crypto';
import { stockEffect } from '../dist/index.js';

/** The Almaty day `offsetDays` from the Almaty day of `at` (YYYY-MM-DD). */
export const almaty = (offsetDays = 0, at = new Date()) => {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Almaty' }).format(at);
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
};
/** Noon in Almaty (07:00 UTC) of the day `offsetDays` from today. */
export const noon = (offsetDays, hour = 12) =>
  new Date(Date.parse(`${almaty(offsetDays)}T00:00:00Z`) + (hour - 5) * 3600000);

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
export async function post(c, actor, at, kind, lines, extra = {}) {
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
/** A source_ref of an automatic consumption of a POS sale. */
export const pos = () => 'pos:' + randomUUID();
