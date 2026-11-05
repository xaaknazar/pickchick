// Synthetic sales of one Almaty day (19.11.2026) for the cutover CC-7 sales report tests:
// cashier rows exactly as the posSales receiver projects them (cloud073) and paid cloud orders.
// Shared by packages/backoffice-core/tests/sales-report.test.mjs and the cabinet browser test.
import { randomUUID } from 'node:crypto';

export const D = '2026-11-19';
export const at = (day, time) => new Date(`${day}T${time}+05:00`);
export const STAFF = {
  cashier: randomUUID(),
  manager: randomUUID(),
  second: randomUUID(),
};
export const TERMINAL = randomUUID();
export const PRODUCT = { burger: randomUUID(), wings: randomUUID() };

/** One cashier sale exactly as the posSales receiver projects it (cloud073 columns). */
export async function posSale(db, c, sale) {
  const id = sale.order_id ?? randomUUID();
  const total = sale.tenders.reduce((a, [, amount]) => a + BigInt(amount), 0n).toString();
  const product = randomUUID();
  const lines = sale.lines ?? [
    {
      product_id: product,
      variant_id: product,
      name: { ru: `Синтетическая позиция ${sale.number}` },
      quantity: 1,
      unit_price_minor: total,
      total_minor: total,
    },
  ];
  const cash = sale.tenders.find(([method]) => method === 'cash');
  await db.query(
    `INSERT INTO cloud_pos_sales(order_id,branch_id,device_id,shift_id,terminal_id,cashier_staff_id,
      display_number,sold_at,business_date,sales_channel,service_mode,revenue_kind,external_order_ref,
      subtotal_minor,discount_minor,total_minor,cash_tendered_minor,change_minor,beneficiary,reason,
      approval_id,approval_manager_staff_id,release_id,menu_version,lines,state,voided_at,last_sequence)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,($8::timestamptz AT TIME ZONE 'Asia/Almaty')::date,$9,$10,$11,$12,
      $13,0,$13,$14,$15,$16,$17,$18,$19,$20,1,$21,$22,$23,$24)`,
    [
      id,
      c.branch,
      c.device,
      sale.shift,
      TERMINAL,
      STAFF.cashier,
      sale.number,
      sale.at,
      sale.channel ?? 'hall',
      sale.mode ?? (sale.channel && sale.channel !== 'hall' ? 'takeaway' : 'dine_in'),
      sale.kind ?? 'revenue',
      sale.ref ?? null,
      total,
      cash ? (sale.tendered ?? cash[1]) : null,
      cash ? (BigInt(sale.tendered ?? cash[1]) - BigInt(cash[1])).toString() : null,
      sale.beneficiary ?? null,
      sale.reason ?? null,
      sale.kind && sale.kind !== 'revenue' ? randomUUID() : null,
      sale.kind && sale.kind !== 'revenue' ? STAFF.manager : null,
      randomUUID(),
      JSON.stringify(lines),
      sale.voided ? 'voided' : 'paid',
      sale.voided ?? null,
      sale.number,
    ],
  );
  const tenders = [];
  for (const [method, amount, confirmation = 'cashier_attested'] of sale.tenders) {
    const tender = randomUUID();
    tenders.push({ tender, method, amount });
    await db.query(
      `INSERT INTO cloud_pos_tenders(tender_id,order_id,branch_id,method,amount_minor,confirmation,created_at)
       VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [tender, id, c.branch, method, amount, confirmation, sale.at],
    );
  }
  if (sale.voided) await posRefund(db, c, { id, tenders }, 'void', sale.voided, tenders);
  return { id, tenders };
}
export async function posRefund(db, c, sale, kind, when, parts, approver = STAFF.manager) {
  const refund = randomUUID();
  const amount = parts.reduce((a, p) => a + BigInt(p.amount), 0n).toString();
  await db.query(
    `INSERT INTO cloud_pos_refunds(refund_id,order_id,branch_id,kind,amount_minor,reason_code,reason,
      staff_id,approved_by_staff_id,approval_id,terminal_id,shift_id,created_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      refund,
      sale.id,
      c.branch,
      kind,
      amount,
      kind === 'void' ? 'aggregator_cancelled' : 'quality',
      kind === 'void' ? 'Курьер отменил заказ' : 'Гость вернул холодный заказ',
      STAFF.cashier,
      approver,
      randomUUID(),
      TERMINAL,
      sale.shift ?? randomUUID(),
      when,
    ],
  );
  for (const p of parts)
    await db.query(
      `INSERT INTO cloud_pos_refund_tenders(refund_id,tender_id,order_id,branch_id,method,amount_minor)
       VALUES($1,$2,$3,$4,$5,$6)`,
      [refund, p.tender, sale.id, c.branch, p.method, p.amount],
    );
  return refund;
}
/**
 * Paid cloud orders without the provider flow: inserted with triggers off
 * (session_replication_role=replica) on one owner connection of the throwaway schema. The
 * report reads only these columns; the commercial flow itself is covered by test:commerce.
 */
export async function cloudOrders(c, orders) {
  const db = await c.cloud.pool.connect();
  try {
    await db.query('SET session_replication_role = replica');
    for (const o of orders) {
      const id = randomUUID();
      const account = randomUUID();
      const capture = randomUUID();
      await db.query(
        `INSERT INTO commerce_orders(id,organization_id,branch_id,principal_id,quote_id,fiscal_account_id,
          snapshot,total_minor,currency,quote_digest,created_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,'KZT',$9,$10)`,
        [
          id,
          c.org,
          c.branch,
          randomUUID(),
          randomUUID(),
          account,
          JSON.stringify({ channel: o.channel, totalMinor: o.amount, currency: 'KZT' }),
          o.amount,
          'a'.repeat(64),
          o.at,
        ],
      );
      await db.query(
        `INSERT INTO commerce_captures(id,order_id,attempt_id,account_id,operation_id,amount_minor,occurred_at)
         VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [capture, id, randomUUID(), account, 'synthetic:' + capture, o.amount, o.at],
      );
      if (o.refund) {
        const refund = randomUUID();
        await db.query(
          `INSERT INTO commerce_refunds(id,order_id,capture_id,account_id,principal_id,amount_minor,reason,
            fulfillment_policy,state,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,'manager_reviewed','succeeded',$8)`,
          [
            refund,
            id,
            capture,
            account,
            o.refund.actor,
            o.refund.amount,
            'Синтетический возврат',
            o.refund.at,
          ],
        );
        await db.query(
          `INSERT INTO commerce_refund_effects(id,refund_id,order_id,account_id,operation_id,amount_minor,occurred_at)
           VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [randomUUID(), refund, id, account, 'synthetic:r' + refund, o.refund.amount, o.refund.at],
        );
      }
    }
  } finally {
    await db.query('SET session_replication_role = DEFAULT');
    db.release();
  }
}
/** The day of the report plus its neighbours (see the expected numbers in the tests). */
export async function seed(c, p) {
  const db = c.cloud.pool;
  const shift = randomUUID();
  const earlier = randomUUID();
  // 18.11 23:30, refunded on 19.11 09:00: the refund belongs to the 19th, the sale to the 18th.
  const s0 = await posSale(db, c, {
    shift: earlier,
    number: 1,
    at: at('2026-11-18', '23:30:00'),
    tenders: [['cash', '70000', 'drawer']],
  });
  await posRefund(db, c, { ...s0, shift }, 'refund', at(D, '09:00:00'), s0.tenders, STAFF.second);
  await db.query(
    `INSERT INTO cloud_pos_shift_reports(shift_id,branch_id,device_id,terminal_id,opened_at,closed_at,report,
      expected_cash_minor,counted_cash_minor,discrepancy_minor,terminal_reported_minor)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      earlier,
      c.branch,
      c.device,
      TERMINAL,
      at('2026-11-18', '09:00:00'),
      at('2026-11-18', '23:55:00'),
      JSON.stringify({ kind: 'z', shift_id: earlier, terminal_id: TERMINAL }),
      '1070000',
      '1069500',
      '-500',
      '0',
    ],
  );
  const burger = (quantity, total) => [
    {
      product_id: PRODUCT.burger,
      variant_id: PRODUCT.burger,
      name: { ru: 'Синтетический бургер' },
      quantity,
      unit_price_minor: (BigInt(total) / BigInt(quantity)).toString(),
      total_minor: total,
    },
  ];
  await posSale(db, c, {
    shift,
    number: 2,
    at: at(D, '10:15:00'),
    tenders: [['cash', '300000', 'drawer']],
    tendered: '500000',
    lines: burger(2, '300000'),
  });
  const s2 = await posSale(db, c, {
    shift,
    number: 3,
    at: at(D, '12:30:00'),
    mode: 'takeaway',
    tenders: [
      ['cash', '100000', 'drawer'],
      ['kaspi_terminal', '150000'],
    ],
  });
  await posRefund(db, c, { ...s2, shift }, 'refund', at(D, '13:00:00'), [
    { ...s2.tenders[1], amount: '50000' },
  ]);
  await posSale(db, c, {
    shift,
    number: 4,
    at: at(D, '13:05:00'),
    channel: 'yandex_eda',
    ref: 'YA-1001',
    tenders: [['aggregator_yandex_eda', '400000', 'aggregator_attested']],
    lines: [
      {
        product_id: PRODUCT.wings,
        variant_id: PRODUCT.wings,
        name: { ru: 'Синтетические крылья' },
        quantity: 4,
        unit_price_minor: '100000',
        total_minor: '400000',
      },
    ],
  });
  await posSale(db, c, {
    shift,
    number: 5,
    at: at(D, '18:40:00'),
    channel: 'glovo',
    ref: 'GL-2002',
    tenders: [['aggregator_glovo', '200000', 'aggregator_attested']],
    voided: at(D, '18:45:00'),
  });
  await posSale(db, c, {
    shift,
    number: 6,
    at: at(D, '19:00:00'),
    tenders: [['kaspi_manual', '120000']],
    lines: burger(1, '120000'),
  });
  await posSale(db, c, {
    shift,
    number: 7,
    at: at(D, '20:10:00'),
    mode: 'takeaway',
    ref: 'CHOCO-77',
    tenders: [['chocofood', '180000', 'aggregator_attested']],
  });
  await posSale(db, c, {
    shift,
    number: 8,
    at: at(D, '15:00:00'),
    kind: 'staff_meal',
    beneficiary: 'Синтетический сотрудник',
    tenders: [['staff_meal', '90000', 'manager_approved']],
  });
  await posSale(db, c, {
    shift,
    number: 9,
    at: at(D, '16:00:00'),
    kind: 'marketing',
    reason: 'Дегустация для партнёра',
    tenders: [['marketing', '60000', 'manager_approved']],
  });
  // 19.11 23:50, refunded at 00:10 on the 20th.
  const s10 = await posSale(db, c, {
    shift,
    number: 10,
    at: at(D, '23:50:00'),
    tenders: [['cash', '50000', 'drawer']],
  });
  await posRefund(db, c, { ...s10, shift }, 'refund', at('2026-11-20', '00:10:00'), s10.tenders);
  await posSale(db, c, {
    shift,
    number: 11,
    at: at('2026-11-20', '00:30:00'),
    tenders: [['cash', '100000', 'drawer']],
  });
  await cloudOrders(c, [
    { channel: 'kiosk', amount: '210000', at: at(D, '11:00:00') },
    {
      channel: 'mobile',
      amount: '330000',
      at: at(D, '14:00:00'),
      refund: { actor: p.manager.actor_id, amount: '30000', at: at(D, '14:30:00') },
    },
    { channel: 'mobile', amount: '990000', at: at('2026-11-18', '14:00:00') },
  ]);
  return { shift, earlier };
}
