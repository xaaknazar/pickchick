import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { desktopFile } from './support.mjs';

const { createJournalStore } = await import(pathToFileURL(desktopFile('journal.mjs')).href);
const id = (last) => `10000000-0000-4000-8000-${String(last).padStart(12, '0')}`;
const session = {
  session_id: id(1),
  staff_id: id(2),
  terminal_id: id(3),
  branch_id: id(4),
  role: 'cashier',
  expires_at: '2030-01-01T01:00:00.000Z',
};
const scope = `${session.branch_id}.${session.staff_id}.${session.terminal_id}`;
const key = `pickchick.pos.journal.v1.${scope}`;
const snapshot = (quantity = 1) =>
  JSON.stringify({
    version: 1,
    scope,
    draft: {
      release_id: id(5),
      service_mode: 'takeaway',
      items: [{ variant_id: id(6), quantity }],
    },
    pending: null,
    known: [],
    selected: null,
  });

async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'pickchick-native-journal-'));
  let clock = Date.parse('2030-01-01T00:00:00.000Z');
  const options = { directory, now: () => clock };
  try {
    await run({
      directory,
      options,
      advance: (ms) => {
        clock += ms;
      },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
function authorize(store) {
  store.setSession(session, session.session_id);
}

test('modifier selections and pending shift commands survive a native journal restart', async () => {
  await fixture(async ({ options }) => {
    const value = JSON.parse(snapshot());
    const option = { group_id: id(20), option_id: id(21), quantity: 2 };
    value.draft.items.push({ variant_id: id(6), quantity: 1, modifiers: [option] });
    for (const pending of [
      { kind: 'shift_open', path: 'cash-shifts', body: { opening_cash_minor: '100000' } },
      {
        kind: 'shift_close',
        path: `cash-shifts/${id(30)}/close`,
        body: {
          expected_version: 1,
          counted_cash_minor: '100000',
          reason: 'End of synthetic shift',
        },
      },
    ]) {
      value.pending = { ...pending, key: id(31), at: '2030-01-01T00:00:00.000Z' };
      const store = createJournalStore(options);
      authorize(store);
      store.setItem(key, JSON.stringify(value));
      const restarted = createJournalStore(options);
      authorize(restarted);
      assert.deepEqual(JSON.parse(restarted.getItem(key)), value);
    }
    const valid = JSON.stringify(value);
    const store = createJournalStore(options);
    authorize(store);
    const invalid = [
      (v) => v.draft.items.push({ variant_id: id(6), quantity: 3 }),
      (v) => v.draft.items[1].modifiers.push({ ...option, quantity: 1 }),
      (v) => {
        v.draft.items[1].modifiers[0].quantity = 0;
      },
      (v) => {
        v.draft.items[1].modifiers[0].quantity = 100;
      },
      (v) => {
        v.pending.path = `orders/${id(30)}/close`;
      },
      (v) => {
        v.pending.body.counted_cash_minor = '-1';
      },
      (v) => {
        v.pending.body.counted_cash_minor = '9223372036854775808';
      },
      (v) => {
        v.pending.body.reason = ' ';
      },
    ];
    for (const change of invalid) {
      const rejected = JSON.parse(valid);
      change(rejected);
      assert.throws(() => store.setItem(key, JSON.stringify(rejected)), /STORAGE_UNAVAILABLE/);
      assert.equal(store.getItem(key), valid, 'Rejected write must preserve pending recovery');
    }
  });
});

test('native journal requires a matching confirmed unexpired staff scope and has no credential fields', async () => {
  await fixture(async ({ options, advance, directory }) => {
    const store = createJournalStore(options);
    assert.throws(() => store.getItem(key));
    assert.throws(() => store.setItem(key, snapshot()));
    store.setSession(session, id(99));
    assert.throws(() => store.getItem(key));
    authorize(store);
    assert.equal(store.getItem(key), null);
    store.setItem(key, snapshot());
    assert.equal(store.getItem(key), snapshot());
    for (const foreign of ['../../config.json', key.replace(session.terminal_id, id(9))]) {
      assert.throws(() => store.getItem(foreign));
      assert.throws(() => store.setItem(foreign, snapshot()));
    }
    assert.throws(() =>
      store.setItem(
        key,
        JSON.stringify({ ...JSON.parse(snapshot()), token: 'synthetic-forbidden' }),
      ),
    );
    assert.equal(store.getItem(key), snapshot());
    const files = await readdir(directory);
    assert.equal(files.length, 1);
    assert.match(files[0], /^[0-9a-f]{64}\.json$/);
    assert.equal(
      (await readFile(join(directory, files[0]), 'utf8')).includes('synthetic-forbidden'),
      false,
    );
    advance(3600000);
    assert.throws(() => store.getItem(key));
    assert.throws(() => store.setItem(key, snapshot(2)));
    advance(-3600000);
    authorize(store);
    assert.equal(store.getItem(key), snapshot());
    store.setSession({ ...session, role: 'kitchen' }, session.session_id);
    assert.throws(() => store.getItem(key));
    assert.equal((await readdir(directory)).length, 1, 'Revocation must preserve the journal');
  });
});

test('failed flush or replacement never acknowledges a new journal and preserves the previously durable snapshot', async () => {
  await fixture(async ({ options, directory }) => {
    const initial = createJournalStore(options);
    authorize(initial);
    initial.setItem(key, snapshot());
    for (const operation of ['fsyncSync', 'renameSync']) {
      const disk = {
        ...fs,
        [operation]: () => {
          throw Object.assign(new Error('SYNTHETIC_DISK_FAILURE'), { code: 'EIO' });
        },
      };
      const failed = createJournalStore({ ...options, fsImpl: disk });
      authorize(failed);
      assert.throws(() => failed.setItem(key, snapshot(2)), /SYNTHETIC_DISK_FAILURE/);
      const restarted = createJournalStore(options);
      authorize(restarted);
      assert.equal(restarted.getItem(key), snapshot());
      assert.equal((await readdir(directory)).length, 1, 'Failed temporary writes must be cleaned');
    }
  });
});

test('a malformed or oversized existing journal blocks reads and replacement instead of silently resetting the order', async () => {
  await fixture(async ({ options, directory }) => {
    const original = createJournalStore(options);
    authorize(original);
    original.setItem(key, snapshot());
    const filename = join(directory, (await readdir(directory))[0]);
    for (const damaged of ['{"version":', 'я'.repeat(60000)]) {
      await writeFile(filename, damaged);
      const restarted = createJournalStore(options);
      authorize(restarted);
      assert.throws(() => restarted.getItem(key));
      assert.throws(() => restarted.setItem(key, snapshot(2)));
      assert.equal(
        await readFile(filename, 'utf8'),
        damaged,
        'Corrupt evidence must not be overwritten',
      );
    }
  });
});

test('atomic unpaid kitchen admission survives restart and rejects altered mode without losing the pending order', async () => {
  await fixture(async ({ options }) => {
    const value = JSON.parse(snapshot());
    value.pending = {
      kind: 'create',
      path: 'orders',
      body: { quote_id: id(9), kitchen_admission: 'unpaid' },
      key: id(10),
      at: '2030-01-01T00:00:00.000Z',
    };
    const store = createJournalStore(options);
    authorize(store);
    const expected = JSON.stringify(value);
    store.setItem(key, expected);
    const restarted = createJournalStore(options);
    authorize(restarted);
    assert.equal(restarted.getItem(key), expected);
    for (const mode of ['paid', null, true]) {
      value.pending.body.kitchen_admission = mode;
      assert.throws(() => restarted.setItem(key, JSON.stringify(value)));
      assert.equal(restarted.getItem(key), expected);
    }
    delete value.pending.body.kitchen_admission;
    restarted.setItem(key, JSON.stringify(value));
    assert.deepEqual(
      JSON.parse(restarted.getItem(key)),
      value,
      'Legacy pending create remains readable',
    );
  });
});

test('v2 held details, timed stops and cash movement survive native restart without expanding authority', async () => {
  await fixture(async ({ options }) => {
    const value = JSON.parse(snapshot());
    value.draft.details = { display_name: 'Әлия', kitchen_comment: 'Соус отдельно' };
    value.held = [globalThis.structuredClone(value.draft)];
    const store = createJournalStore(options);
    store.setSession({ ...session, name: 'Synthetic cashier' }, session.session_id);
    for (const pending of [
      {
        kind: 'stop',
        path: 'availability/stops',
        body: {
          variant_id: id(21),
          stopped: true,
          expected_version: 0,
          reason: 'Test stop',
          duration: 'hour',
        },
      },
      {
        kind: 'shift_move',
        path: `cash-shifts/${id(30)}/movements`,
        body: { direction: 'in', amount_minor: '100000', reason: 'Test float' },
      },
    ]) {
      value.pending = { ...pending, key: id(31), at: '2030-01-01T00:00:00.000Z' };
      store.setItem(key, JSON.stringify(value));
      const restarted = createJournalStore(options);
      authorize(restarted);
      assert.deepEqual(JSON.parse(restarted.getItem(key)), value);
    }
    const tampered = globalThis.structuredClone(value);
    tampered.held[0].details.token = 'must not persist';
    assert.throws(() => store.setItem(key, JSON.stringify(tampered)), /STORAGE_UNAVAILABLE/);
  });
});

test('paid sale, void, refund, Webkassa number and sales close survive a native restart', async () => {
  // Before, main refused every paid command, so a paid desk blocked (STORAGE_UNAVAILABLE)
  // at the save that must precede POST pos/sales.
  await fixture(async ({ options }) => {
    const value = JSON.parse(snapshot());
    const approval = { approval_id: id(40), token: 'c'.repeat(64) };
    const reason = { reason_code: 'quality', reason: 'Synthetic quality reason' };
    const commands = [
      {
        kind: 'sale',
        path: 'pos/sales',
        body: {
          quote_id: id(41),
          service_mode_confirmed: true,
          order_repeated: true,
          tenders: [
            { method: 'cash', amount_minor: '400000' },
            { method: 'kaspi_terminal', amount_minor: '299900', reference: 'TEST-OP-1' },
          ],
          cash_tendered_minor: '500000',
        },
      },
      {
        kind: 'sale',
        path: 'pos/sales',
        body: {
          quote_id: id(41),
          service_mode_confirmed: true,
          order_repeated: true,
          external_order_ref: 'GL-77',
          tenders: [{ method: 'aggregator_glovo', amount_minor: '750000' }],
        },
      },
      {
        kind: 'sale',
        path: 'pos/sales',
        body: {
          quote_id: id(41),
          service_mode_confirmed: true,
          order_repeated: true,
          tenders: [{ method: 'marketing', amount_minor: '699000' }],
          reason: 'Synthetic tasting',
          approval,
        },
      },
      {
        kind: 'void',
        path: `pos/sales/${id(42)}/void`,
        body: { expected_version: 1, ...reason, fiscal_sale_issued: true, approval },
      },
      {
        kind: 'refund',
        path: `pos/sales/${id(42)}/refunds`,
        body: {
          refund_id: id(43),
          tenders: [
            { tender_id: id(44), amount_minor: '100000' },
            { tender_id: id(45), amount_minor: '1000' },
          ],
          ...reason,
          approval,
        },
      },
      {
        kind: 'fiscal_record',
        path: `pos/fiscal-receipts/${id(46)}/record`,
        body: { expected_version: 2, receipt_number: 'TEST-WK-8', approval },
        subject: id(42),
      },
      {
        kind: 'shift_close',
        path: `cash-shifts/${id(30)}/close`,
        body: {
          expected_version: 1,
          counted_cash_minor: '100000',
          reason: 'End of synthetic shift',
          terminal_reported_minor: '299900',
          approval,
        },
      },
    ];
    for (const pending of commands) {
      value.pending = { ...pending, key: id(31), at: '2030-01-01T00:00:00.000Z' };
      const store = createJournalStore(options);
      authorize(store);
      store.setItem(key, JSON.stringify(value));
      const restarted = createJournalStore(options);
      authorize(restarted);
      assert.deepEqual(JSON.parse(restarted.getItem(key)), value, pending.kind);
    }
    // The last one (a sales close) is durable; nothing below may replace it.
    const valid = JSON.stringify(value);
    const store = createJournalStore(options);
    authorize(store);
    const [cashSale, , , voided, refund, receipt, close] = commands;
    const invalid = [
      { ...cashSale, body: { ...cashSale.body, discount_minor: '100' } },
      { ...cashSale, body: { ...cashSale.body, tenders: [] } },
      {
        ...cashSale,
        body: { ...cashSale.body, tenders: [{ method: 'card', amount_minor: '699900' }] },
      },
      { ...cashSale, body: { ...cashSale.body, tenders: [{ method: 'cash', amount_minor: '0' }] } },
      { ...cashSale, body: { ...cashSale.body, order_repeated: false } },
      { ...cashSale, body: { ...cashSale.body, external_order_ref: 'GL 77' } },
      { ...cashSale, body: { ...cashSale.body, approval: { ...approval, pin: '1234' } } },
      { ...cashSale, body: { ...cashSale.body, approval: { ...approval, token: 'short' } } },
      { ...cashSale, path: 'orders' },
      { ...voided, body: { ...voided.body, reason_code: 'mistake' } },
      { ...voided, body: { ...voided.body, reason: ' ab ' } },
      { ...voided, body: { ...voided.body, approval: undefined } },
      { ...voided, path: `pos/sales/${id(42)}/refunds` },
      {
        ...refund,
        body: { ...refund.body, tenders: [refund.body.tenders[0], refund.body.tenders[0]] },
      },
      { ...refund, body: { ...refund.body, lines: [] } },
      { ...refund, path: `pos/sales/${id(42)}/refunds/x` },
      { ...receipt, subject: undefined },
      { ...receipt, body: { ...receipt.body, receipt_number: '' } },
      { ...close, body: { ...close.body, terminal_reported_minor: '-1' } },
      { ...close, body: { ...close.body, pin: '1234' } },
      { ...close, subject: id(42) },
    ];
    for (const pending of invalid) {
      const rejected = JSON.parse(valid);
      rejected.pending = JSON.parse(
        JSON.stringify({ ...pending, key: id(31), at: rejected.pending.at }),
      );
      assert.throws(
        () => store.setItem(key, JSON.stringify(rejected)),
        /STORAGE_UNAVAILABLE/,
        JSON.stringify(pending),
      );
      assert.equal(store.getItem(key), valid, 'Rejected write must preserve pending recovery');
    }
  });
});
