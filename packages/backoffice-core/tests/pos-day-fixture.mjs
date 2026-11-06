// Synthetic cashier day (19.11.2026, Asia/Almaty) for the «Касса» tests of lane bo-ui
// (GET .../ops/pos-day): rows exactly as the posSales receiver projects them (cloud073), the
// cashier reports of the edge (cloud033) and employee cards whose edge ids name the staff.
// Shared by packages/backoffice-core/tests/pos-day.test.mjs and the cabinet browser test.
// Every name, number and amount is synthetic.
import { randomUUID } from 'node:crypto';
import { edgeStaffId } from '../dist/index.js';

export const DAY = '2026-11-19';
export const at = (day, time) => new Date(`${day}T${time}+05:00`);
/** Back-office employee cards; the edge accounts use edgeStaffId of them. */
export const EMPLOYEE = {
  cashier: randomUUID(),
  manager: randomUUID(),
  second: randomUUID(),
};
export const NAMES = {
  cashier: 'Синтетический кассир',
  manager: 'Синтетический начальник смены',
  second: 'Синтетическая кассир 2',
};
export const STAFF = {
  cashier: edgeStaffId(EMPLOYEE.cashier, 'cashier'),
  manager: edgeStaffId(EMPLOYEE.manager, 'shift_manager'),
  second: edgeStaffId(EMPLOYEE.second, 'cashier'),
  // An edge account the operator did not take from edge-staff-id.mjs: no card, no name.
  stranger: randomUUID(),
};
export const TERMINAL = { one: randomUUID(), two: randomUUID(), three: randomUUID() };
export const SHIFT = {
  earlier: randomUUID(),
  one: randomUUID(),
  two: randomUUID(),
  unknown: randomUUID(),
  next: randomUUID(),
};

export async function employees(c) {
  for (const [key, id] of Object.entries(EMPLOYEE))
    await c.cloud.pool.query(
      `INSERT INTO bo_records(id,branch_id,organization_id,kind,revision,payload)
       VALUES($1,$2,$3,'employee',1,$4)`,
      [
        id,
        c.branch,
        c.org,
        {
          name: NAMES[key],
          role: key === 'manager' ? 'manager' : 'cashier',
          active: true,
          note: '',
        },
      ],
    );
}

let sequence = 0;
/** One cashier sale as the receiver projects it (cloud073 columns), with its tenders. */
export async function sale(c, s) {
  const db = c.cloud.pool;
  const id = s.order_id ?? randomUUID();
  const total = s.tenders.reduce((a, [, amount]) => a + BigInt(amount), 0n).toString();
  const cash = s.tenders.find(([method]) => method === 'cash');
  const lines = s.lines ?? [
    {
      product_id: randomUUID(),
      variant_id: randomUUID(),
      name: { ru: s.item ?? 'Синтетический бургер', kk: '' },
      quantity: 1,
      unit_price_minor: total,
      total_minor: total,
      ...(s.modifiers ? { modifiers: s.modifiers } : {}),
    },
  ];
  const channel = s.channel ?? 'hall';
  const noRevenue = s.kind && s.kind !== 'revenue';
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
      s.shift,
      s.terminal,
      s.cashier ?? STAFF.cashier,
      s.number,
      s.at,
      channel,
      s.mode ?? (channel !== 'hall' ? 'takeaway' : 'dine_in'),
      s.kind ?? 'revenue',
      s.ref ?? null,
      total,
      cash ? (s.tendered ?? cash[1]) : null,
      cash ? (BigInt(s.tendered ?? cash[1]) - BigInt(cash[1])).toString() : null,
      s.beneficiary ?? null,
      s.reason ?? null,
      noRevenue ? randomUUID() : null,
      noRevenue ? STAFF.manager : null,
      randomUUID(),
      JSON.stringify(lines),
      s.voided ? 'voided' : 'paid',
      s.voided ? s.voided.at : null,
      ++sequence,
    ],
  );
  const tenders = [];
  for (const [method, amount, confirmation = 'cashier_attested', reference = null] of s.tenders) {
    const tender = randomUUID();
    tenders.push({ tender, method, amount });
    await db.query(
      `INSERT INTO cloud_pos_tenders(tender_id,order_id,branch_id,method,amount_minor,confirmation,reference,created_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [tender, id, c.branch, method, amount, confirmation, reference, s.at],
    );
  }
  const out = { id, tenders, shift: s.shift, terminal: s.terminal, total };
  if (s.voided)
    out.void = await refund(c, out, {
      kind: 'void',
      at: s.voided.at,
      shift: s.voided.shift ?? s.shift,
      parts: tenders,
    });
  if (s.receipt) out.receipt = await receipt(c, out, s.receipt);
  return out;
}
/** A void or refund of `of` (parts of its tenders), made in `r.shift`. */
export async function refund(c, of, r) {
  const id = randomUUID();
  const parts = r.parts ?? of.tenders;
  const amount = parts.reduce((a, p) => a + BigInt(p.amount), 0n).toString();
  await c.cloud.pool.query(
    `INSERT INTO cloud_pos_refunds(refund_id,order_id,branch_id,kind,amount_minor,reason_code,reason,
      staff_id,approved_by_staff_id,approval_id,terminal_id,shift_id,created_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      id,
      of.id,
      c.branch,
      r.kind ?? 'refund',
      amount,
      r.kind === 'void' ? 'aggregator_cancelled' : 'quality',
      r.kind === 'void' ? 'Курьер отменил заказ' : 'Гость вернул холодный заказ',
      r.staff ?? STAFF.cashier,
      r.approver ?? STAFF.manager,
      randomUUID(),
      r.terminal ?? of.terminal,
      r.shift,
      r.at,
    ],
  );
  for (const p of parts)
    await c.cloud.pool.query(
      `INSERT INTO cloud_pos_refund_tenders(refund_id,tender_id,order_id,branch_id,method,amount_minor)
       VALUES($1,$2,$3,$4,$5,$6)`,
      [id, p.tender, of.id, c.branch, p.method, p.amount],
    );
  const out = { id, amount };
  if (r.receipt) out.receipt = await receipt(c, of, { ...r.receipt, refund: out });
  return out;
}
/** A Webkassa receipt record: pending, recorded with a synthetic number, or not_required. */
export async function receipt(c, of, f) {
  const id = randomUUID();
  const recorded = f.state === 'recorded';
  await c.cloud.pool.query(
    `INSERT INTO cloud_pos_fiscal_receipts(receipt_id,order_id,branch_id,refund_id,kind,mode,state,
      receipt_number,version,amount_minor,recorded_by_staff_id,recorded_at)
     VALUES($1,$2,$3,$4,$5,'manual_webkassa',$6,$7,$8,$9,$10,$11)`,
    [
      id,
      of.id,
      c.branch,
      f.refund?.id ?? null,
      f.refund ? 'refund' : 'sale',
      f.state,
      recorded ? f.number : null,
      recorded ? 2 : 1,
      f.refund ? f.refund.amount : of.total,
      recorded ? (f.by ?? STAFF.cashier) : null,
      recorded ? (f.at ?? new Date()) : null,
    ],
  );
  return id;
}
/** The frozen Z report of a closed shift (ShiftReport kind z, contracts 5.1). */
export async function zReport(c, z) {
  const report = {
    kind: 'z',
    shift_id: z.shift,
    terminal_id: z.terminal,
    state: 'closed',
    opened_at: z.opened.toISOString(),
    closed_at: z.closed.toISOString(),
    opening_cash_minor: z.opening,
    cash_in_minor: '0',
    cash_out_minor: '0',
    cash_sales_minor: z.cash_sales,
    cash_refunds_minor: z.cash_refunds,
    expected_cash_minor: z.expected,
    counted_cash_minor: z.counted,
    discrepancy_minor: (BigInt(z.counted) - BigInt(z.expected)).toString(),
    methods: z.methods,
    channels: [],
    terminal_reported_minor: z.terminal_reported ?? null,
    terminal_discrepancy_minor: z.terminal_discrepancy ?? null,
    fiscal: z.fiscal ?? { pending: 0, recorded: 0, not_required: 0 },
    orders: z.orders ?? { count: 0, voided_count: 0 },
    report_at: z.closed.toISOString(),
  };
  await c.cloud.pool.query(
    `INSERT INTO cloud_pos_shift_reports(shift_id,branch_id,device_id,terminal_id,opened_at,closed_at,report,
      expected_cash_minor,counted_cash_minor,discrepancy_minor,terminal_reported_minor)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      z.shift,
      c.branch,
      c.device,
      z.terminal,
      z.opened,
      z.closed,
      report,
      z.expected,
      z.counted,
      report.discrepancy_minor,
      z.terminal_reported ?? null,
    ],
  );
  return report;
}
/** A shift of the cashier reports (cloud033), as the edge sends it (sales shift keys optional). */
export async function cashierShift(c, s) {
  const payload = {
    shift_id: s.shift,
    terminal_id: s.terminal,
    staff_id: s.staff,
    state: s.closed ? 'closed' : 'open',
    opened_at: s.opened.toISOString(),
    closed_at: s.closed ? s.closed.toISOString() : null,
    opening_cash_minor: s.opening,
    cash_in_minor: '0',
    cash_out_minor: '0',
    expected_cash_minor: s.expected,
    counted_cash_minor: s.counted ?? null,
    discrepancy_minor: s.counted ? (BigInt(s.counted) - BigInt(s.expected)).toString() : null,
    ...(s.cash_sales !== undefined
      ? { cash_sales_minor: s.cash_sales, cash_refunds_minor: s.cash_refunds ?? '0' }
      : {}),
  };
  await c.cloud.pool.query(
    'INSERT INTO cloud_cashier_shifts(id,branch_id,device_id,sequence,payload) VALUES($1,$2,$3,$4,$5)',
    [s.shift, c.branch, c.device, ++sequence, payload],
  );
  return payload;
}

const M = (method, sales, refunds, count) => ({
  method,
  sales_minor: sales,
  refunds_minor: refunds,
  count,
});
/** Z methods of shift «one» on 19.11 (all eight, contract order of the edge). */
export const ONE_METHODS = [
  M('cash', '500000', '700000', 3),
  M('kaspi_terminal', '200000', '50000', 1),
  M('aggregator_yandex_eda', '400000', '0', 1),
  M('aggregator_glovo', '200000', '200000', 1),
  M('staff_meal', '90000', '0', 1),
  M('marketing', '60000', '0', 1),
  M('kaspi_manual', '0', '0', 0),
  M('chocofood', '0', '0', 0),
];

/**
 * The day (expected figures in pos-day.test.mjs):
 * - desk one: shift «earlier» 18.11 09:00-23:55 (Z) with sale №9 at 23:30, refunded on 19.11 09:30
 *   in shift «one»; shift «one» 19.11 09:00 - 20.11 00:30 (Z) with №1-№7, №7 after midnight;
 * - desk two: shift «two» from 19.11 10:00, still open (cashier report only) with №1-№3;
 * - desk three: shift «unknown» (no Z, no report) with №1 on 19.11, and on 20.11 shift «next».
 * Three receipts have the number 1 on three cash desks.
 */
export async function seedDay(c) {
  await employees(c);
  const D = DAY;
  // ---- desk one, 18.11 ----
  await zReport(c, {
    shift: SHIFT.earlier,
    terminal: TERMINAL.one,
    opened: at('2026-11-18', '09:00:00'),
    closed: at('2026-11-18', '23:55:00'),
    opening: '1000000',
    cash_sales: '700000',
    cash_refunds: '0',
    expected: '1700000',
    counted: '1700000',
    methods: [M('cash', '700000', '0', 1)],
  });
  const nine = await sale(c, {
    shift: SHIFT.earlier,
    terminal: TERMINAL.one,
    number: 9,
    at: at('2026-11-18', '23:30:00'),
    tenders: [['cash', '700000', 'drawer']],
    tendered: '1000000',
    receipt: { state: 'recorded', number: 'SYN-0009' },
  });
  // ---- desk one, 19.11 (closes after midnight) ----
  const one = { shift: SHIFT.one, terminal: TERMINAL.one };
  await zReport(c, {
    ...one,
    opened: at(D, '09:00:00'),
    closed: at('2026-11-20', '00:30:00'),
    opening: '1000000',
    cash_sales: '500000',
    cash_refunds: '700000',
    expected: '800000',
    counted: '795000',
    terminal_reported: '140000',
    terminal_discrepancy: '-10000',
    methods: ONE_METHODS,
  });
  await refund(c, nine, {
    at: at(D, '09:30:00'),
    shift: SHIFT.one,
    receipt: { state: 'pending' },
  });
  await sale(c, {
    ...one,
    number: 1,
    at: at(D, '10:00:00'),
    tenders: [['cash', '250000', 'drawer']],
    tendered: '300000',
    receipt: { state: 'recorded', number: 'SYN-0001' },
    modifiers: [
      {
        group_id: randomUUID(),
        option_id: randomUUID(),
        group_name: { ru: 'Соус', kk: '' },
        name: { ru: 'Сырный', kk: '' },
        price_minor: '0',
      },
    ],
  });
  const two = await sale(c, {
    ...one,
    number: 2,
    mode: 'takeaway',
    at: at(D, '12:00:00'),
    tenders: [
      ['cash', '100000', 'drawer'],
      ['kaspi_terminal', '200000', 'cashier_attested'],
    ],
    receipt: { state: 'pending' },
  });
  await refund(c, two, {
    at: at(D, '18:00:00'),
    shift: SHIFT.one,
    parts: [{ ...two.tenders[1], amount: '50000' }],
    receipt: { state: 'recorded', number: 'SYN-0002' },
  });
  await sale(c, {
    ...one,
    number: 3,
    channel: 'yandex_eda',
    ref: 'YA-123456',
    at: at(D, '13:00:00'),
    tenders: [['aggregator_yandex_eda', '400000', 'aggregator_attested']],
    receipt: { state: 'not_required' },
  });
  await sale(c, {
    ...one,
    number: 4,
    kind: 'staff_meal',
    beneficiary: 'Синтетический сотрудник',
    at: at(D, '14:00:00'),
    tenders: [['staff_meal', '90000', 'manager_approved']],
    receipt: { state: 'not_required' },
  });
  await sale(c, {
    ...one,
    number: 5,
    kind: 'marketing',
    reason: 'Дегустация для партнёра',
    at: at(D, '15:00:00'),
    tenders: [['marketing', '60000', 'manager_approved']],
    receipt: { state: 'not_required' },
  });
  await sale(c, {
    ...one,
    number: 6,
    channel: 'glovo',
    ref: 'GL-777',
    at: at(D, '16:00:00'),
    tenders: [['aggregator_glovo', '200000', 'aggregator_attested']],
    voided: { at: at(D, '16:10:00') },
    receipt: { state: 'not_required' },
  });
  await sale(c, {
    ...one,
    number: 7,
    at: at('2026-11-20', '00:10:00'),
    tenders: [['cash', '150000', 'drawer']],
    receipt: { state: 'pending' },
  });
  // ---- desk two, 19.11, open ----
  const deskTwo = { shift: SHIFT.two, terminal: TERMINAL.two, cashier: STAFF.second };
  await cashierShift(c, {
    ...deskTwo,
    staff: STAFF.second,
    opened: at(D, '10:00:00'),
    opening: '500000',
    cash_sales: '150000',
    expected: '650000',
  });
  await sale(c, {
    ...deskTwo,
    number: 1,
    at: at(D, '11:00:00'),
    tenders: [['kaspi_manual', '120000', 'cashier_attested', 'KM-55']],
    receipt: { state: 'recorded', number: 'SYN-0003', by: STAFF.second },
  });
  await sale(c, {
    ...deskTwo,
    number: 2,
    mode: 'takeaway',
    ref: 'CF-42',
    at: at(D, '12:30:00'),
    tenders: [['chocofood', '180000', 'aggregator_attested']],
    receipt: { state: 'not_required' },
  });
  await sale(c, {
    ...deskTwo,
    cashier: STAFF.stranger,
    number: 3,
    at: at(D, '19:00:00'),
    tenders: [['cash', '150000', 'drawer']],
    receipt: { state: 'pending' },
  });
  // ---- desk three: a shift the cloud does not know ----
  await sale(c, {
    shift: SHIFT.unknown,
    terminal: TERMINAL.three,
    number: 1,
    at: at(D, '21:00:00'),
    tenders: [['cash', '50000', 'drawer']],
    receipt: { state: 'pending' },
  });
  await sale(c, {
    shift: SHIFT.next,
    terminal: TERMINAL.two,
    number: 1,
    at: at('2026-11-20', '11:00:00'),
    tenders: [['cash', '30000', 'drawer']],
  });
  return { nine };
}
