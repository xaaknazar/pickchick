import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createApi } from '@pickchick/api';
import { hashJson } from '@pickchick/menu-sync';
import { PosSaleBatchResultSchema, posSaleReceiptFor, receivePosSales } from '../dist/index.js';
import { running, authFor } from '../../../tests/helpers/sync.mjs';
import {
  CASH_TERMINAL_VECTORS,
  SALES_PATH,
  cashSale,
  copy,
  headersFor,
  migrationsUpTo,
  stream,
  vectorEvent,
  withPosSalesDatabases,
  zReportFor,
} from './sales-cloud-fixture.mjs';

// Cloud receiver of posSales (contracts 5.6, CC-4) on PostgreSQL with schema073: projection,
// deduplication, in-order prefix, ACK only after COMMIT, arithmetic rejections, flag and schema
// gates. Synthetic data only.
const ON = { posOrderSyncEnabled: true, posSalesSyncEnabled: true };

async function withReceiver(run, { flags = ON, ...options } = {}) {
  await withPosSalesDatabases(async (ctx) => {
    const api = await running(createApi, { ...ctx.cloud.config, ...flags });
    const post = (body, { identity = ctx.identity, suffix = '' } = {}) =>
      fetch(api.url + SALES_PATH + suffix, {
        method: 'POST',
        headers: headersFor(identity),
        body: typeof body === 'string' ? body : JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      });
    const send = async (events) => {
      const response = await post({ events });
      assert.equal(response.status, 200);
      return PosSaleBatchResultSchema.parse(await response.json());
    };
    try {
      await run({ ...ctx, api, post, send });
    } finally {
      await api.app.close();
    }
  }, options);
}
const count = async (pool, table) => {
  assert.match(table, /^cloud_pos_[a-z_]+$/);
  return Number((await pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count);
};
const counts = async (pool) =>
  Object.fromEntries(
    await Promise.all(
      [
        'cloud_pos_sale_inbox',
        'cloud_pos_sales',
        'cloud_pos_tenders',
        'cloud_pos_refunds',
        'cloud_pos_refund_tenders',
        'cloud_pos_fiscal_receipts',
        'cloud_pos_shift_reports',
      ].map(async (table) => [table, await count(pool, table)]),
    ),
  );
const receipts = (events) => events.map((event) => posSaleReceiptFor(event));

test('the synthetic stream projects every sale, all eight methods, refunds, receipts and the Z report; a repeat is a duplicate', async () => {
  await withReceiver(async (ctx) => {
    const events = stream(ctx.branch);
    // Probe first: {events: []} is answered 200 with no receipts.
    assert.deepEqual(await ctx.send([]), { receipts: [] });
    // Two batches: the receiver accepts any prefix boundary.
    const first = await ctx.send(events.slice(0, 5));
    const rest = await ctx.send(events.slice(5));
    assert.deepEqual([...first.receipts, ...rest.receipts], receipts(events));
    assert.equal(first.rejected, undefined);
    assert.equal(rest.rejected, undefined);
    const expected = {
      cloud_pos_sale_inbox: 14,
      cloud_pos_sales: 8,
      cloud_pos_tenders: 9,
      cloud_pos_refunds: 2,
      cloud_pos_refund_tenders: 2,
      cloud_pos_fiscal_receipts: 2,
      cloud_pos_shift_reports: 1,
    };
    assert.deepEqual(await counts(ctx.cloud.pool), expected);
    const tenders = (
      await ctx.cloud.pool.query(
        `SELECT method,sum(amount_minor)::text AS amount,count(*)::integer AS n FROM cloud_pos_tenders
         GROUP BY method ORDER BY method`,
      )
    ).rows;
    // Every method on its own row, summed independently from the wire payloads.
    const methods = new Map();
    for (const event of events.filter((item) => item.kind === 'sale'))
      for (const tender of event.payload.tenders) {
        const row = methods.get(tender.method) ?? { method: tender.method, amount: 0n, n: 0 };
        methods.set(tender.method, {
          ...row,
          amount: row.amount + BigInt(tender.amount_minor),
          n: row.n + 1,
        });
      }
    assert.equal(methods.size, 8);
    assert.deepEqual(
      tenders,
      [...methods.values()]
        .sort((a, b) => (a.method < b.method ? -1 : 1))
        .map((row) => ({ ...row, amount: String(row.amount) })),
    );
    const sale = (
      await ctx.cloud.pool.query(
        `SELECT state,voided_at,business_date::text AS business_date,total_minor::text AS total,
         change_minor::text AS change,lines,release_id,menu_version,last_sequence::text AS last_sequence,
         device_id,branch_id FROM cloud_pos_sales WHERE order_id=$1`,
        [events[0].payload.order_id],
      )
    ).rows[0];
    assert.equal(sale.state, 'voided');
    assert.equal(sale.voided_at.toISOString(), events[8].payload.created_at);
    // 06:01Z is 11:01 in Almaty: the business day of the sale.
    assert.equal(sale.business_date, '2026-11-19');
    assert.equal(sale.total, '350000');
    assert.equal(sale.change, '150000');
    assert.deepEqual(sale.lines, events[0].payload.quote.lines);
    assert.equal(sale.release_id, events[0].payload.quote.release_id);
    assert.equal(sale.menu_version, events[0].payload.quote.menu_version);
    assert.equal(sale.last_sequence, events[8].sequence);
    assert.equal(sale.device_id, ctx.device);
    assert.equal(sale.branch_id, ctx.branch);
    const receipt = (
      await ctx.cloud.pool.query(
        "SELECT state,receipt_number,version FROM cloud_pos_fiscal_receipts WHERE kind='sale'",
      )
    ).rows[0];
    assert.deepEqual(receipt, { state: 'recorded', receipt_number: 'SYN-0001', version: 2 });
    const z = (
      await ctx.cloud.pool.query(
        `SELECT expected_cash_minor::text AS expected,discrepancy_minor::text AS discrepancy,report
         FROM cloud_pos_shift_reports`,
      )
    ).rows[0];
    assert.equal(z.expected, '820000');
    assert.equal(z.discrepancy, '-5000');
    assert.deepEqual(z.report, events[13].payload.report);
    const external = (
      await ctx.cloud.pool.query(
        'SELECT sales_channel,external_order_ref FROM cloud_pos_sales WHERE external_order_ref IS NOT NULL ORDER BY 1,2',
      )
    ).rows.map((row) => `${row.sales_channel}:${row.external_order_ref}`);
    assert.equal(external.length, 3);
    // The whole stream again (a lost response): same receipts, nothing stored twice.
    assert.deepEqual((await ctx.send(events.slice(0, 50))).receipts, receipts(events));
    assert.deepEqual(await counts(ctx.cloud.pool), expected);
  });
});

test('route gates: 404 like an old cloud when disabled, device auth, binding, query and batch shape', async () => {
  await withReceiver(
    async (ctx) => {
      const disabled = await ctx.post({ events: [] });
      const unknown = await fetch(ctx.api.url + '/internal/v1/edge/pos-orders/unknown', {
        method: 'POST',
        headers: headersFor(ctx.identity),
        body: '{"events":[]}',
      });
      assert.equal(disabled.status, 404);
      assert.equal(unknown.status, 404);
      const [a, b] = [await disabled.json(), await unknown.json()];
      assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort());
      assert.deepEqual({ ...a, trace_id: null }, { ...b, trace_id: null });
      assert.equal(a.code, 'NOT_FOUND');
    },
    { flags: { posOrderSyncEnabled: true } },
  );
  await withReceiver(async (ctx) => {
    assert.equal((await ctx.post({ events: [] }, { suffix: '?x=1' })).status, 400);
    assert.equal(
      (await ctx.post({ events: [] }, { identity: { ...ctx.identity, token: 'b'.repeat(64) } }))
        .status,
      401,
    );
    for (const body of [
      { events: [], extra: true },
      { events: Array.from({ length: 51 }, (_, index) => cashSale(ctx.branch, index + 1)) },
      // Sequences must strictly increase inside a batch.
      { events: [cashSale(ctx.branch, 2), cashSale(ctx.branch, 1)] },
      { events: [vectorEvent('sale_glovo', ctx.branch, (p) => (p.unknown = true))] },
    ])
      assert.equal((await ctx.post(body)).status, 400);
    // A batch of another branch is refused before any event.
    const foreign = cashSale(randomUUID(), 1);
    assert.equal((await ctx.post({ events: [foreign] })).status, 403);
    await ctx.cloud.pool.query('UPDATE pos_order_sync_bindings SET active=false');
    assert.equal((await ctx.post({ events: [] })).status, 403);
    assert.equal(await count(ctx.cloud.pool, 'cloud_pos_sale_inbox'), 0);
  });
});

test('a cloud without schema073 answers 404 even with the flag on (new runtime on the old schema)', async () => {
  const old = await migrationsUpTo('cloud', 72);
  try {
    await withReceiver(
      async (ctx) => {
        const response = await ctx.post({ events: [cashSale(ctx.branch, 1)] });
        assert.equal(response.status, 404);
        assert.equal((await response.json()).code, 'NOT_FOUND');
        assert.equal(
          (await ctx.cloud.pool.query("SELECT to_regclass('cloud_pos_sale_inbox') AS t")).rows[0].t,
          null,
        );
      },
      { cloudMigrationDirectory: old.directory },
    );
  } finally {
    await old.remove();
  }
});

test('the same event id with another payload, or the same device sequence with another id, is a CONFLICT', async () => {
  await withReceiver(async (ctx) => {
    const events = stream(ctx.branch);
    await ctx.send(events.slice(0, 3));
    const before = await counts(ctx.cloud.pool);
    const changed = copy(events[1]);
    changed.payload.display_number = 42;
    assert.deepEqual(await ctx.send([events[0], changed]), {
      receipts: receipts([events[0]]),
      rejected: { event_id: changed.event_id, code: 'CONFLICT' },
    });
    const reused = copy(events[3]);
    reused.sequence = events[2].sequence;
    reused.event_id = randomUUID();
    // Sequence 3 is taken by another event of this device.
    assert.deepEqual(await ctx.send([reused]), {
      receipts: [],
      rejected: { event_id: reused.event_id, code: 'CONFLICT' },
    });
    const moved = copy(events[2]);
    moved.sequence = '99';
    assert.equal((await ctx.send([moved])).rejected.code, 'CONFLICT');
    assert.deepEqual(await counts(ctx.cloud.pool), before);
    // The stream continues with the right events.
    assert.deepEqual((await ctx.send(events.slice(3))).receipts, receipts(events.slice(3)));
  });
});

test('arithmetic rejections store nothing and end the batch; the accepted prefix stays acknowledged', async () => {
  await withReceiver(async (ctx) => {
    const events = stream(ctx.branch);
    // sale 1 (cash 350000 with change), sale 2 (cash 20000 + terminal 400000).
    await ctx.send(events.slice(0, 2));
    let sequence = 100;
    const next = (event) => ({ ...event, event_id: randomUUID(), sequence: String(sequence++) });
    const expectInvalid = async (event, label) => {
      const before = await counts(ctx.cloud.pool);
      const result = await ctx.send([event]);
      assert.deepEqual(
        result,
        { receipts: [], rejected: { event_id: event.event_id, code: 'INVALID_EVENT' } },
        label,
      );
      assert.deepEqual(await counts(ctx.cloud.pool), before, label);
    };
    const sale2 = events[1].payload;
    const refund = (change) =>
      next(
        vectorEvent('refund_terminal_part', ctx.branch, (p) => {
          p.refund_id = randomUUID();
          change(p);
        }),
      );
    // Tenders must sum to the total; change = tendered - cash part (wire model).
    await expectInvalid(
      next(
        vectorEvent('sale_cash_with_change', ctx.branch, (p) => {
          p.order_id = randomUUID();
          p.tenders[0].tender_id = randomUUID();
          p.tenders[0].amount_minor = '340000';
        }),
      ),
      'tender sum',
    );
    await expectInvalid(
      next(
        vectorEvent('sale_cash_with_change', ctx.branch, (p) => {
          p.order_id = randomUUID();
          p.tenders[0].tender_id = randomUUID();
          p.change_minor = '140000';
        }),
      ),
      'change',
    );
    // A tender id that already paid another sale.
    await expectInvalid(
      next(
        vectorEvent('sale_cash_with_change', ctx.branch, (p) => {
          p.order_id = randomUUID();
        }),
      ),
      'tender identity',
    );
    // Refund limits per tender, cumulative: 300000 of the 400000 terminal part, then 100001.
    const ok = refund((p) => {
      p.amount_minor = '300000';
      p.tenders[0].amount_minor = '300000';
    });
    assert.deepEqual((await ctx.send([ok])).receipts, receipts([ok]));
    await expectInvalid(
      refund((p) => {
        p.amount_minor = '100100';
        p.tenders[0].amount_minor = '100100';
      }),
      'refund limit',
    );
    await expectInvalid(
      refund((p) => (p.tenders[0].method = 'kaspi_manual')),
      'refund method',
    );
    await expectInvalid(
      refund((p) => (p.tenders[0].tender_id = randomUUID())),
      'refund tender of another sale',
    );
    await expectInvalid(
      refund((p) => (p.order_id = randomUUID())),
      'unknown sale',
    );
    // A void returns the whole sale and is its only refund: sale 2 already has a refund.
    const voidOf = (order, tenders, change = () => {}) =>
      next(
        vectorEvent('void_cash_sale', ctx.branch, (p) => {
          p.refund_id = randomUUID();
          p.order_id = order.order_id;
          p.amount_minor = order.total_minor;
          p.tenders = tenders;
          change(p);
        }),
      );
    await expectInvalid(
      voidOf(
        sale2,
        sale2.tenders.map(({ tender_id, method, amount_minor }) => ({
          tender_id,
          method,
          amount_minor,
        })),
      ),
      'void after refund',
    );
    const sale1 = events[0].payload;
    await expectInvalid(
      voidOf(
        sale1,
        [{ tender_id: sale1.tenders[0].tender_id, method: 'cash', amount_minor: '300000' }],
        (p) => (p.amount_minor = '300000'),
      ),
      'partial void',
    );
    const whole = voidOf(sale1, [
      { tender_id: sale1.tenders[0].tender_id, method: 'cash', amount_minor: '350000' },
    ]);
    assert.deepEqual((await ctx.send([whole])).receipts, receipts([whole]));
    await expectInvalid(
      next(
        vectorEvent('refund_terminal_part', ctx.branch, (p) => {
          p.refund_id = randomUUID();
          p.order_id = sale1.order_id;
          p.tenders = [
            { tender_id: sale1.tenders[0].tender_id, method: 'cash', amount_minor: '100000' },
          ];
        }),
      ),
      'refund of a voided sale',
    );
    // Receipts: amount of the sale, one per sale, only newer versions.
    const fiscal = (name, change) => next(vectorEvent(name, ctx.branch, (p) => change?.(p)));
    await expectInvalid(
      fiscal('fiscal_sale_pending', (p) => (p.amount_minor = '1')),
      'receipt amount',
    );
    const pending = fiscal('fiscal_sale_pending');
    assert.equal((await ctx.send([pending])).rejected, undefined);
    await expectInvalid(fiscal('fiscal_sale_pending'), 'same version again');
    await expectInvalid(
      fiscal('fiscal_sale_pending', (p) => (p.receipt_id = randomUUID())),
      'second sale receipt',
    );
    // Z report: internally consistent but its cash disagrees with the projected tenders.
    const z = (change) => next(vectorEvent('shift_report_z', ctx.branch, (p) => change(p.report)));
    await expectInvalid(
      z((r) => {
        r.cash_sales_minor = '380000';
        r.expected_cash_minor = '830000';
        r.discrepancy_minor = '-15000';
        r.methods[0].sales_minor = '380000';
      }),
      'Z cash against projection',
    );
    await expectInvalid(
      z((r) => (r.expected_cash_minor = '820001')),
      'Z expected cash',
    );
    // Mid-batch: the valid prefix is accepted, the rest of the batch is not looked at.
    const tail = [
      next(cashSale(ctx.branch, 0, 9)),
      next(
        vectorEvent('sale_cash_with_change', ctx.branch, (p) => {
          p.order_id = randomUUID();
          p.tenders[0].tender_id = randomUUID();
          p.cash_tendered_minor = '300000';
          p.change_minor = '0';
        }),
      ),
      next(cashSale(ctx.branch, 0, 10)),
    ];
    const before = await counts(ctx.cloud.pool);
    assert.deepEqual(await ctx.send(tail), {
      receipts: receipts(tail.slice(0, 1)),
      rejected: { event_id: tail[1].event_id, code: 'INVALID_EVENT' },
    });
    const after = await counts(ctx.cloud.pool);
    assert.equal(after.cloud_pos_sales, before.cloud_pos_sales + 1);
    assert.equal(after.cloud_pos_sale_inbox, before.cloud_pos_sale_inbox + 1);
  });
});

test('ACK only after COMMIT: a failed commit returns no receipt and stores nothing of that event', async () => {
  await withReceiver(async (ctx) => {
    const events = [cashSale(ctx.branch, 1), cashSale(ctx.branch, 2), cashSale(ctx.branch, 3)];
    // A pool whose COMMIT fails for the transaction that writes the second event.
    const failing = {
      connect: async () => {
        const client = await ctx.cloud.pool.connect();
        let poisoned = false;
        return new Proxy(client, {
          get(target, key) {
            if (key !== 'query') {
              const value = Reflect.get(target, key);
              return typeof value === 'function' ? value.bind(target) : value;
            }
            return async (sql, params) => {
              if (
                /INSERT INTO cloud_pos_sale_inbox/.test(sql) &&
                params?.[0] === events[1].event_id
              )
                poisoned = true;
              if (sql === 'COMMIT' && poisoned) {
                poisoned = false;
                throw new Error('synthetic commit failure');
              }
              return target.query(sql, params);
            };
          },
        });
      },
    };
    await assert.rejects(
      receivePosSales(failing, authFor(ctx.identity), { events }),
      /synthetic commit failure/,
    );
    const stored = (await ctx.cloud.pool.query('SELECT event_id FROM cloud_pos_sale_inbox')).rows;
    assert.deepEqual(
      stored.map((row) => row.event_id),
      [events[0].event_id],
    );
    assert.equal(await count(ctx.cloud.pool, 'cloud_pos_sales'), 1);
    // The edge sends the same batch again: the first is a duplicate, the rest are new.
    assert.deepEqual(await receivePosSales(ctx.cloud.pool, authFor(ctx.identity), { events }), {
      receipts: receipts(events),
    });
    assert.equal(await count(ctx.cloud.pool, 'cloud_pos_sales'), 3);
    assert.equal(await count(ctx.cloud.pool, 'cloud_pos_sale_inbox'), 3);
  });
});

test('a Z report lists every method its shift took or returned money with; the pinned cash and terminal Z is accepted as is', async () => {
  // The pinned Z vector (cash and Kaspi terminal rows only) on the shift of exactly those sales.
  await withReceiver(async (ctx) => {
    const events = CASH_TERMINAL_VECTORS.map((name) => vectorEvent(name, ctx.branch));
    assert.deepEqual(await ctx.send(events), { receipts: receipts(events) });
    const stored = (await ctx.cloud.pool.query('SELECT report FROM cloud_pos_shift_reports')).rows;
    assert.deepEqual(
      stored.map((row) => row.report),
      [events.at(-1).payload.report],
    );
    assert.deepEqual(
      stored[0].report.methods.map((row) => row.method),
      ['cash', 'kaspi_terminal'],
    );
  });
  // The full stream: every method has sales in the shift. A Z without the Kaspi manual row is
  // refused although each row it lists is right; the edge's own Z (all eight rows) is accepted.
  await withReceiver(async (ctx) => {
    const events = stream(ctx.branch);
    const z = events.at(-1);
    assert.equal(z.kind, 'shift_report');
    assert.equal(z.payload.report.methods.length, 8);
    assert.deepEqual((await ctx.send(events.slice(0, -1))).rejected, undefined);
    const rejections = [];
    const omitted = copy(z);
    omitted.payload.report.methods = omitted.payload.report.methods.filter(
      (row) => row.method !== 'kaspi_manual',
    );
    assert.deepEqual(
      await receivePosSales(
        ctx.cloud.pool,
        authFor(ctx.identity),
        { events: [omitted] },
        { onRejected: (rejection) => rejections.push(rejection) },
      ),
      { receipts: [], rejected: { event_id: omitted.event_id, code: 'INVALID_EVENT' } },
    );
    assert.deepEqual(rejections, [
      {
        event_id: omitted.event_id,
        kind: 'shift_report',
        code: 'INVALID_EVENT',
        reason: 'shift_methods',
      },
    ]);
    assert.equal(await count(ctx.cloud.pool, 'cloud_pos_shift_reports'), 0);
    for (const method of ['aggregator_glovo', 'staff_meal']) {
      const missing = copy(z);
      missing.payload.report.methods = missing.payload.report.methods.filter(
        (row) => row.method !== method,
      );
      assert.equal((await ctx.send([missing])).rejected.code, 'INVALID_EVENT', method);
    }
    assert.deepEqual(await ctx.send([z]), { receipts: receipts([z]) });
    assert.deepEqual(
      (await ctx.cloud.pool.query('SELECT report FROM cloud_pos_shift_reports')).rows[0].report,
      z.payload.report,
    );
  });
});

test('overlapping deliveries of one batch (a request still running after its timeout, a second worker) store one copy; every answer acknowledges every event', async () => {
  await withReceiver(async (ctx) => {
    const events = stream(ctx.branch).slice(0, 10),
      longer = stream(ctx.branch).slice(0, 13);
    // Two HTTP deliveries and one in-process delivery at the same time, plus a longer batch from
    // the same head (a second worker that read more rows): all of them see one committed inbox.
    const answers = await Promise.all([
      ctx.send(events),
      ctx.send(events),
      receivePosSales(ctx.cloud.pool, authFor(ctx.identity), { events }),
      ctx.send(longer),
    ]);
    for (const answer of answers.slice(0, 3))
      assert.deepEqual(answer, { receipts: receipts(events) });
    assert.deepEqual(answers[3], { receipts: receipts(longer) });
    assert.deepEqual(await counts(ctx.cloud.pool), {
      cloud_pos_sale_inbox: 13,
      cloud_pos_sales: 8,
      cloud_pos_tenders: 9,
      cloud_pos_refunds: 2,
      cloud_pos_refund_tenders: 2,
      cloud_pos_fiscal_receipts: 2,
      cloud_pos_shift_reports: 0,
    });
    // One row per entity: the void moved its sale exactly once.
    const voided = (
      await ctx.cloud.pool.query(
        "SELECT order_id,last_sequence::text AS last_sequence FROM cloud_pos_sales WHERE state='voided'",
      )
    ).rows;
    assert.deepEqual(voided, [
      { order_id: events[8].payload.order_id, last_sequence: events[8].sequence },
    ]);
  });
});

/** The vector `name` moved to a cash desk (own shift and terminal) with a new id and sequence. */
function deskEvent(name, ctx, desk, sequence, change = () => {}) {
  return vectorEvent(name, ctx.branch, (p, event) => {
    event.event_id = randomUUID();
    event.sequence = String(sequence);
    p.shift_id = desk.shift;
    p.terminal_id = desk.terminal;
    change(p, event);
  });
}

test('two cash desks of one edge: interleaved sales, a refund paid out at the other desk and both Z reports', async () => {
  await withReceiver(async (ctx) => {
    const [a, b] = [1, 2].map(() => ({ shift: randomUUID(), terminal: randomUUID() }));
    let sequence = 0;
    const sale = (name, desk, number) =>
      deskEvent(name, ctx, desk, ++sequence, (p) => {
        p.order_id = randomUUID();
        p.quote.quote_id = randomUUID();
        p.display_number = number;
        for (const tender of p.tenders) tender.tender_id = randomUUID();
      });
    const a1 = sale('sale_cash_with_change', a, 1); // cash 350000
    const b1 = sale('sale_mixed_cash_kaspi_terminal', b, 2); // cash 20000 + terminal 400000
    const a2 = sale('sale_kaspi_manual', a, 3); // Kaspi manual 150050
    const b2 = sale('sale_cash_with_change', b, 4); // cash 350000
    // Desk 2 pays back part of desk 1's cash sale from its own drawer.
    const cross = deskEvent('refund_terminal_part', ctx, b, ++sequence, (p) => {
      p.refund_id = randomUUID();
      p.order_id = a1.payload.order_id;
      p.amount_minor = '100000';
      p.tenders = [
        { tender_id: a1.payload.tenders[0].tender_id, method: 'cash', amount_minor: '100000' },
      ];
    });
    // Desk 1 voids its own Kaspi manual sale.
    const voided = deskEvent('void_cash_sale', ctx, a, ++sequence, (p) => {
      p.refund_id = randomUUID();
      p.order_id = a2.payload.order_id;
      p.amount_minor = a2.payload.total_minor;
      p.tenders = a2.payload.tenders.map(({ tender_id, method, amount_minor }) => ({
        tender_id,
        method,
        amount_minor,
      }));
    });
    const sales = [a1, b1, a2, b2, cross, voided];
    assert.deepEqual(await ctx.send(sales), { receipts: receipts(sales) });
    const z = (desk, source, change) =>
      deskEvent('shift_report_z', ctx, desk, ++sequence, (p) => {
        p.report = zReportFor(
          source,
          { ...p.report, shift_id: desk.shift, terminal_id: desk.terminal, cash_out_minor: '0' },
          change,
        );
      });
    // Desk 2's Z that books the cross-desk refund at desk 1 (consistent in itself) is refused:
    // a refund belongs to the drawer that paid it out.
    const misbooked = sales.map((event) =>
      event === cross ? { ...cross, payload: { ...cross.payload, shift_id: a.shift } } : event,
    );
    const wrong = z(b, misbooked, {
      counted_cash_minor: '1370000',
      terminal_reported_minor: '400000',
    });
    assert.equal(wrong.payload.report.cash_refunds_minor, '0');
    assert.equal((await ctx.send([wrong])).rejected.code, 'INVALID_EVENT');
    const zA = z(a, sales, {
      counted_cash_minor: '1350000',
      terminal_reported_minor: null,
      terminal_discrepancy_minor: null,
    });
    const zB = z(b, sales, { counted_cash_minor: '1270000', terminal_reported_minor: '400000' });
    assert.deepEqual(await ctx.send([zA, zB]), { receipts: receipts([zA, zB]) });
    const reports = (
      await ctx.cloud.pool.query(
        `SELECT shift_id,terminal_id,expected_cash_minor::text AS expected,
         discrepancy_minor::text AS discrepancy,terminal_reported_minor::text AS terminal
         FROM cloud_pos_shift_reports ORDER BY expected_cash_minor DESC`,
      )
    ).rows;
    assert.deepEqual(reports, [
      {
        shift_id: a.shift,
        terminal_id: a.terminal,
        expected: '1350000',
        discrepancy: '0',
        terminal: null,
      },
      {
        shift_id: b.shift,
        terminal_id: b.terminal,
        expected: '1270000',
        discrepancy: '0',
        terminal: '400000',
      },
    ]);
    const used = (report) =>
      Object.fromEntries(
        report.methods
          .filter((row) => row.count || row.refunds_minor !== '0')
          .map((row) => [row.method, [row.sales_minor, row.refunds_minor, row.count]]),
      );
    assert.deepEqual(used(zA.payload.report), {
      cash: ['350000', '0', 1],
      kaspi_manual: ['150050', '150050', 1],
    });
    assert.deepEqual(used(zB.payload.report), {
      cash: ['370000', '100000', 2],
      kaspi_terminal: ['400000', '0', 1],
    });
    const refund = (
      await ctx.cloud.pool.query(
        'SELECT order_id,shift_id,terminal_id FROM cloud_pos_refunds WHERE refund_id=$1',
        [cross.payload.refund_id],
      )
    ).rows[0];
    assert.deepEqual(refund, {
      order_id: a1.payload.order_id,
      shift_id: b.shift,
      terminal_id: b.terminal,
    });
  });
});

test('the old POS order route answers exactly as before with the posSales flag on or off', async () => {
  const answers = [];
  for (const flags of [{ posOrderSyncEnabled: true }, ON])
    await withReceiver(
      async (ctx) => {
        const response = await fetch(ctx.api.url + '/internal/v1/edge/pos-orders/events', {
          method: 'POST',
          headers: headersFor(ctx.identity),
          body: JSON.stringify({ synthetic: true }),
        });
        const body = await response.json();
        answers.push({ status: response.status, body: { ...body, trace_id: null } });
      },
      { flags },
    );
  assert.equal(answers[0].status, 400);
  assert.deepEqual(answers[1], answers[0]);
  assert.equal(hashJson(answers[0]), hashJson(answers[1]));
});
