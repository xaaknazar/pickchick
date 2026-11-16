// ADR-0018: an iPad kiosk paid on its own Kaspi Smart POS terminal. The iPad drives the terminal;
// the cloud links the terminal to the kiosk and takes the kiosk-attested outcome. Real PostgreSQL,
// the real commerce core, the restricted API role and the real API controller over HTTP.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createPool } from '@pickchick/database';
import { createHttpApplication, RESOURCE } from '@pickchick/platform';
import {
  publishMenu,
  projectCatalogMenu,
  provisionDevice,
  pullMenu,
  applyMenu,
  acknowledgeMenu,
} from '@pickchick/menu-sync';
import { withSyncDatabases, authFor } from '../helpers/sync.mjs';
import {
  KioskCheckout,
  KioskSessions,
  KioskKaspiQrProcessor,
  kioskKaspiTerminalConfig,
} from '../../packages/commerce-core/dist/index.js';
import { publishCatalog } from '../../packages/commerce-core/tests/catalog-fixture.mjs';
import { KioskCheckoutController } from '../../services/api/dist/kiosk-checkout-controller.js';
import {
  kioskTerminalGrants,
  kioskTerminalPrivileges,
  TERMINAL_TABLES,
} from '../../infra/staging/kiosk-terminal-grants.mjs';
import { kioskCheckoutGrants } from '../../infra/staging/commercial-channel-grants.mjs';

const NOW = () => new Date('2026-11-16T10:00:00Z');
const HOURS = { openingTime: '10:00', closingTime: '00:00', timeZone: 'Asia/Almaty' };

async function fixture(run) {
  await withSyncDatabases(async (f) => {
    const pool = f.cloud.pool,
      qrAccount = randomUUID(),
      posAccount = randomUUID(),
      kiosk = randomUUID(),
      deviceKey = randomBytes(32).toString('hex');
    const auth = authFor(await provisionDevice(pool, f.device));
    await pool.query(
      'INSERT INTO fulfillment_transport_bindings(branch_id,organization_id,device_id,producer_id) VALUES($1,$2,$3,$4)',
      [f.branch, f.org, f.device, randomUUID()],
    );
    await pool.query(
      "INSERT INTO cloud_branch_availability(branch_id,device_id,revision,stopped_ids) VALUES($1,$2,1,'{}')",
      [f.branch, f.device],
    );
    for (const [id, provider] of [
      [qrAccount, 'kaspi-qr'],
      [posAccount, 'kaspi-pos'],
    ])
      await pool.query(
        "INSERT INTO commerce_provider_accounts(id,organization_id,branch_id,kind,provider,external_reference,enabled,legal_entity_id) VALUES($1::uuid,$2,$3,'payment',$4,$1::text,true,$5)",
        [id, f.org, f.branch, provider, f.legal],
      );
    const addKiosk = async (id = randomUUID(), key = randomBytes(32).toString('hex')) => {
      await pool.query(
        'INSERT INTO kiosk_devices(id,organization_id,branch_id,token_hash) VALUES($1,$2,$3,$4)',
        [id, f.org, f.branch, createHash('sha256').update(key).digest('hex')],
      );
      return { id, key };
    };
    await addKiosk(kiosk, deviceKey);
    const publication = await publishCatalog({
      pool,
      scope: { organizationId: f.org, branchId: f.branch },
    });
    const menu = projectCatalogMenu(publication.payload, f.branch, 1, new Date().toISOString());
    await publishMenu(pool, menu);
    await pool.query(
      'INSERT INTO catalog_menu_deliveries(branch_id,catalog_version,release_id,device_id) VALUES($1,1,$2,$3)',
      [f.branch, menu.release_id, f.device],
    );
    const pulled = (await pullMenu(pool, auth)).event;
    await acknowledgeMenu(pool, auth, await applyMenu(f.edge.pool, f.branch, pulled));
    const options = {
      organizationId: f.org,
      branchId: f.branch,
      paymentAccountId: qrAccount,
      paymentMethod: 'kaspi_qr',
      fiscalPolicy: 'deferred_pilot',
      approvalReference: 'Synthetic kiosk terminal only',
      taxCode: 'PENDING_PILOT',
      maxOrderMinor: '50000',
      hours: HOURS,
    };
    const piiKey = randomBytes(32);
    const build = (db = pool, terminal = { accountId: posAccount }, now = NOW) => {
      const sessions = new KioskSessions(db, { piiKey });
      return { sessions, checkout: new KioskCheckout(db, options, sessions, now, terminal) };
    };
    const { sessions, checkout } = build();
    const guest = async (device = { id: kiosk, key: deviceKey }) => {
      const token = randomBytes(32).toString('hex');
      await sessions.start(device.id, device.key, { sessionId: randomUUID(), token });
      return sessions.authenticate(device.id, device.key, token, { allowExpired: true });
    };
    const order = async (who) => {
      const quote = await checkout.quote(who, {
        key: randomUUID(),
        branchId: f.branch,
        catalog_version: 1,
        serviceMode: 'takeaway',
        items: [
          {
            productId: 'BURGER',
            quantity: 1,
            selections: [{ group_id: 'extra', option_id: 'sauce', quantity: 1 }],
          },
        ],
      });
      return checkout.create(who, { key: randomUUID(), quoteId: quote.quoteId });
    };
    const device = { deviceId: kiosk, organizationId: f.org, branchId: f.branch };
    const link = (body = {}, d = device, c = checkout) =>
      c.terminal.link(d, { terminal_id: 'T-100', serial: 'SN-1', host: '192.168.2.40', ...body });
    async function admission(orderId) {
      const row = (
          await pool.query('SELECT quote_id,quote_digest FROM commerce_orders WHERE id=$1', [
            orderId,
          ])
        ).rows[0],
        reservation = randomUUID();
      await checkout.repository.confirmAdmission(
        { organizationId: f.org, branchId: f.branch, deviceId: f.device },
        {
          eventId: randomUUID(),
          orderId,
          reservationId: reservation,
          quoteDigest: row.quote_digest,
        },
      );
      await pool.query(
        `INSERT INTO cloud_fulfillment_projection(order_id,branch_id,organization_id,device_id,reservation_id,quote_id,quote_hash,owner_hash,version,state,display_number,routing_version,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$7,1,'held','1',1,'{}')`,
        [orderId, f.branch, f.org, f.device, reservation, row.quote_id, row.quote_digest],
      );
    }
    const count = async (sql, params = []) => (await pool.query(sql, params)).rows[0].n;
    await run({
      ...f,
      pool,
      qrAccount,
      posAccount,
      kiosk,
      deviceKey,
      device,
      options,
      sessions,
      checkout,
      build,
      guest,
      order,
      link,
      addKiosk,
      admission,
      count,
    });
  });
}
const code = (expected) => (error) => error.code === expected;
const started = (attempt, extra = {}) => ({
  attempt_id: attempt.attempt_id,
  kind: 'started',
  process_id: 'P-1',
  terminal_id: 'T-100',
  ...extra,
});
const result = (attempt, extra = {}) => ({
  attempt_id: attempt.attempt_id,
  kind: 'result',
  process_id: 'P-1',
  terminal_id: 'T-100',
  status: 'success',
  transaction_id: 'TX-555',
  method: 'qr',
  amount_tenge: 110,
  ...extra,
});
const pay = (f, who, orderId, requestId = randomUUID()) =>
  f.checkout.pay(who, orderId, { method: 'kaspi_terminal', request_id: requestId });

test('config flag: off, true, invalid and a separate account', () => {
  assert.equal(kioskKaspiTerminalConfig({}), null);
  assert.equal(kioskKaspiTerminalConfig({ KIOSK_KASPI_TERMINAL_ENABLED: 'false' }), null);
  const id = randomUUID();
  assert.deepEqual(
    kioskKaspiTerminalConfig({
      KIOSK_KASPI_TERMINAL_ENABLED: 'true',
      KIOSK_KASPI_TERMINAL_ACCOUNT_ID: id,
    }),
    { accountId: id },
  );
  for (const flag of ['1', 'TRUE', 'yes', ''])
    assert.throws(() =>
      kioskKaspiTerminalConfig({
        KIOSK_KASPI_TERMINAL_ENABLED: flag,
        KIOSK_KASPI_TERMINAL_ACCOUNT_ID: id,
      }),
    );
  assert.throws(() => kioskKaspiTerminalConfig({ KIOSK_KASPI_TERMINAL_ENABLED: 'true' }));
  for (const other of ['KIOSK_KASPI_QR_ACCOUNT_ID', 'KASPI_REMOTE_ACCOUNT_ID'])
    assert.throws(
      () =>
        kioskKaspiTerminalConfig({
          KIOSK_KASPI_TERMINAL_ENABLED: 'true',
          KIOSK_KASPI_TERMINAL_ACCOUNT_ID: id,
          [other]: id,
        }),
      /SEPARATE_ACCOUNT/,
    );
});

test('link, refresh, taken by another kiosk, unlink; config shows the linked terminal', () =>
  fixture(async (f) => {
    const who = await f.guest();
    const before = await f.checkout.kioskConfig(who);
    assert.deepEqual(before.kaspi_terminal, { enabled: true, terminal: null });
    assert.deepEqual(before.paymentMethods, ['kaspi_qr']);
    const linked = await f.link();
    assert.deepEqual(Object.keys(linked).sort(), ['host', 'linked_at', 'serial', 'terminal_id']);
    assert.equal(linked.host, '192.168.2.40');
    // Refresh of the same terminal keeps linked_at and updates the address.
    const moved = await f.link({ host: '10.0.0.7', serial: 'SN-1' });
    assert.equal(moved.linked_at, linked.linked_at);
    assert.equal(moved.host, '10.0.0.7');
    assert.deepEqual((await f.checkout.kioskConfig(who)).kaspi_terminal.terminal, moved);
    // Another kiosk cannot take the terminal while it is linked here.
    const other = await f.addKiosk();
    const otherDevice = { ...f.device, deviceId: other.id };
    await assert.rejects(f.link({}, otherDevice), code('KIOSK_TERMINAL_TAKEN'));
    // Hosts must be private IPv4; identifiers bounded.
    for (const body of [
      { host: '8.8.8.8' },
      { host: '192.168.1.300' },
      { host: '192.168.01.1' },
      { host: 'terminal.local' },
      { terminal_id: 'a b' },
      { serial: '' },
      { extra: 1 },
    ])
      await assert.rejects(f.link(body), code('INVALID'));
    // Linking a new terminal replaces the old link; the old terminal is free for another kiosk.
    await f.link({ terminal_id: 'T-200' });
    assert.equal((await f.link({}, otherDevice)).terminal_id, 'T-100');
    assert.equal(
      await f.count(
        'SELECT count(*)::int n FROM kiosk_terminal_links WHERE device_id=$1 AND unlinked_at IS NULL',
        [f.kiosk],
      ),
      1,
    );
    assert.deepEqual(await f.checkout.terminal.unlink(f.device), { unlinked: true });
    assert.deepEqual(await f.checkout.terminal.unlink(f.device), { unlinked: true });
    assert.equal((await f.checkout.kioskConfig(who)).kaspi_terminal.terminal, null);
    // Links are history: never deleted or rewritten.
    await assert.rejects(f.pool.query('DELETE FROM kiosk_terminal_links'), /never deleted/);
    await assert.rejects(
      f.pool.query("UPDATE kiosk_terminal_links SET terminal_id='X' WHERE device_id=$1", [f.kiosk]),
      /Immutable/,
    );
  }));

test('success: money counted and the order goes to the kitchen exactly like a paid kiosk QR', () =>
  fixture(async (f) => {
    await f.link();
    // Reference: a kiosk QR order paid by the bank before edge admission.
    const qrGuest = await f.guest();
    const qrOrder = await f.order(qrGuest);
    await f.checkout.pay(qrGuest, qrOrder.orderId, { method: 'kaspi_qr' });
    const bank = {
      async checkSession() {
        return true;
      },
      async create(amount) {
        return {
          kind: 'ok',
          data: { QrOperationId: 123, Amount: amount, QrToken: 'https://qr.kaspi.kz/synthetic' },
        };
      },
      async status() {
        return { kind: 'ok', data: { QrOperationId: 123, Amount: 110, Status: 'Processed' } };
      },
    };
    const processor = new KioskKaspiQrProcessor(
      f.pool,
      {
        accountId: f.qrAccount,
        bridgeUrl: 'http://127.0.0.1:1',
        requestTimeoutMs: 1000,
        invoiceTtlSeconds: 180,
        webhookSecret: 'x'.repeat(32),
        session: null,
        latitude: 43,
        longitude: 76,
      },
      bank,
    );
    await processor.tick();
    await f.pool.query(
      "UPDATE commerce_kiosk_kaspi_qr SET next_check_at=clock_timestamp()-interval '1 second'",
    );
    await processor.tick();

    const who = await f.guest();
    const created = await f.order(who);
    const requestId = randomUUID();
    const attempt = await pay(f, who, created.orderId, requestId);
    assert.deepEqual(Object.keys(attempt).sort(), [
      'amount_tenge',
      'attempt_id',
      'expires_at',
      'terminal_id',
    ]);
    assert.equal(attempt.amount_tenge, 110);
    assert.equal(attempt.terminal_id, 'T-100');
    const ttl = Date.parse(attempt.expires_at) - Date.now();
    assert.ok(ttl > 14 * 60_000 && ttl <= 15 * 60_000, String(ttl));
    // Replays: the same request, and any request while the attempt is open.
    assert.deepEqual(await pay(f, who, created.orderId, requestId), attempt);
    assert.deepEqual(await pay(f, who, created.orderId), attempt);
    const open = await f.checkout.read(who, created.orderId);
    assert.equal(open.phase, 'awaiting_payment');
    assert.equal(open.paymentMethod, 'kaspi_terminal');
    assert.deepEqual(open.payment, {
      kind: 'kaspi_terminal',
      state: 'pending',
      attempt_id: attempt.attempt_id,
      amount_tenge: 110,
      terminal_id: 'T-100',
      expires_at: attempt.expires_at,
    });
    // The other rail cannot be started on a terminal order.
    await assert.rejects(
      f.checkout.pay(who, created.orderId, { method: 'kaspi_qr' }),
      code('CONFLICT'),
    );
    // The submit request has no worker on this rail: acknowledged at once.
    assert.equal(
      await f.count(
        "SELECT count(*)::int n FROM commerce_outbox WHERE order_id=$1 AND event_type='payment.submit_requested' AND acknowledged_at IS NULL",
        [created.orderId],
      ),
      0,
    );
    const afterStart = await f.checkout.terminalEvent(who, created.orderId, started(attempt));
    assert.equal(afterStart.phase, 'awaiting_payment');
    const paid = await f.checkout.terminalEvent(who, created.orderId, result(attempt));
    assert.equal(paid.phase, 'paid');
    assert.equal(paid.payment.state, 'paid');
    // Same answers on a replay; another process or changed data is a conflict.
    assert.equal(
      (await f.checkout.terminalEvent(who, created.orderId, result(attempt))).phase,
      'paid',
    );
    assert.equal(
      (await f.checkout.terminalEvent(who, created.orderId, started(attempt))).phase,
      'paid',
    );
    await assert.rejects(
      f.checkout.terminalEvent(who, created.orderId, result(attempt, { transaction_id: 'TX-9' })),
      code('CONFLICT'),
    );
    await assert.rejects(
      f.checkout.terminalEvent(who, created.orderId, result(attempt, { process_id: 'P-2' })),
      code('CONFLICT'),
    );
    await assert.rejects(
      f.checkout.terminalEvent(who, created.orderId, started(attempt, { process_id: 'P-2' })),
      code('CONFLICT'),
    );
    // A paid order answers its paid attempt to any new payment request.
    assert.deepEqual(await pay(f, who, created.orderId), attempt);

    const capture = (
      await f.pool.query('SELECT * FROM commerce_captures WHERE order_id=$1', [created.orderId])
    ).rows;
    assert.equal(capture.length, 1);
    assert.equal(capture[0].operation_id, 'TX-555');
    assert.equal(capture[0].amount_minor, '11000');
    assert.equal(capture[0].account_id, f.posAccount);

    // Both orders are now in the same state with the same effects; admission sends both to
    // the kitchen through the same command.
    const shape = async (orderId) => ({
      order: (
        await f.pool.query(
          'SELECT o.state,o.attention_required,i.state intent FROM commerce_orders o JOIN commerce_payment_intents i ON i.order_id=o.id WHERE o.id=$1',
          [orderId],
        )
      ).rows[0],
      events: (
        await f.pool.query(
          'SELECT event_type FROM commerce_outbox WHERE order_id=$1 ORDER BY sequence',
          [orderId],
        )
      ).rows.map((r) => r.event_type),
      issues: await f.count(
        'SELECT count(*)::int n FROM commerce_reconciliation_issues WHERE order_id=$1',
        [orderId],
      ),
    });
    assert.deepEqual(await shape(created.orderId), await shape(qrOrder.orderId));
    await f.admission(qrOrder.orderId);
    await f.admission(created.orderId);
    const qrShape = await shape(qrOrder.orderId);
    assert.ok(qrShape.events.includes('edge.kitchen_admission_requested'), qrShape.events);
    assert.deepEqual(await shape(created.orderId), qrShape);
    const kitchen = async (orderId) =>
      Object.keys(
        (
          await f.pool.query(
            "SELECT payload FROM commerce_outbox WHERE order_id=$1 AND event_type='edge.kitchen_admission_requested'",
            [orderId],
          )
        ).rows[0].payload,
      ).sort();
    assert.deepEqual(await kitchen(created.orderId), await kitchen(qrOrder.orderId));
    assert.equal((await f.checkout.read(who, created.orderId)).displayNumber, '1');
  }));

test('amount, terminal or missing transaction: no money, reconciliation, never the kitchen', () =>
  fixture(async (f) => {
    await f.link();
    for (const bad of [
      { amount_tenge: 100 },
      { terminal_id: 'T-999' },
      { transaction_id: null },
      { amount_tenge: null },
    ]) {
      const who = await f.guest();
      const created = await f.order(who);
      const attempt = await pay(f, who, created.orderId);
      const shown = await f.checkout.terminalEvent(who, created.orderId, result(attempt, bad));
      assert.equal(shown.phase, 'checking', JSON.stringify(bad));
      assert.equal(shown.payment.state, 'checking');
      assert.equal(
        await f.count('SELECT count(*)::int n FROM commerce_captures WHERE order_id=$1', [
          created.orderId,
        ]),
        0,
      );
      const issue = (
        await f.pool.query('SELECT code FROM commerce_reconciliation_issues WHERE order_id=$1', [
          created.orderId,
        ])
      ).rows.map((r) => r.code);
      assert.deepEqual(issue, ['KIOSK_TERMINAL_RESULT_MISMATCH']);
      await f.admission(created.orderId);
      assert.equal(
        await f.count(
          "SELECT count(*)::int n FROM commerce_outbox WHERE order_id=$1 AND event_type='edge.kitchen_admission_requested'",
          [created.orderId],
        ),
        0,
      );
      // No second payment while the result is on reconciliation.
      await assert.rejects(pay(f, who, created.orderId), code('CONFLICT'));
    }
    // A start reported from another terminal names a payment this attempt did not make.
    const who = await f.guest();
    const created = await f.order(who);
    const attempt = await pay(f, who, created.orderId);
    await assert.rejects(
      f.checkout.terminalEvent(who, created.orderId, started(attempt, { terminal_id: 'T-9' })),
      code('CONFLICT'),
    );
    // Malformed reports are refused before anything is stored.
    for (const bad of [
      { kind: 'started', status: 'success' },
      { status: undefined },
      { status: 'ok' },
      { amount_tenge: 110.5 },
      { method: 'cash' },
      { attempt_id: 'x' },
      { extra: true },
    ])
      await assert.rejects(
        f.checkout.terminalEvent(who, created.orderId, result(attempt, bad)),
        code('INVALID'),
      );
    await assert.rejects(
      f.checkout.terminalEvent(who, created.orderId, result({ attempt_id: randomUUID() })),
      code('NOT_FOUND'),
    );
    // A result whose process differs from the reported start is a mismatch.
    await f.checkout.terminalEvent(who, created.orderId, started(attempt));
    const shown = await f.checkout.terminalEvent(
      who,
      created.orderId,
      result(attempt, { process_id: 'P-OTHER' }),
    );
    assert.equal(shown.phase, 'checking');
  }));

test('fail closes the attempt and a new one may start and succeed', () =>
  fixture(async (f) => {
    await f.link();
    const who = await f.guest();
    const created = await f.order(who);
    const first = await pay(f, who, created.orderId);
    const failed = await f.checkout.terminalEvent(
      who,
      created.orderId,
      result(first, {
        status: 'fail',
        sub_status: 'CancelledByUser',
        transaction_id: null,
        amount_tenge: null,
        message: 'Отменено',
      }),
    );
    assert.equal(failed.phase, 'failed');
    assert.equal(failed.payment.state, 'failed');
    // The failed request id answers the failed attempt; a new request starts a new attempt.
    const second = await pay(f, who, created.orderId);
    assert.notEqual(second.attempt_id, first.attempt_id);
    assert.equal((await f.checkout.read(who, created.orderId)).phase, 'awaiting_payment');
    const paid = await f.checkout.terminalEvent(
      who,
      created.orderId,
      result(second, { process_id: 'P-2' }),
    );
    assert.equal(paid.phase, 'paid');
    // The failed attempt is final.
    await assert.rejects(
      f.checkout.terminalEvent(who, created.orderId, result(first, { process_id: 'P-9' })),
      code('CONFLICT'),
    );
    assert.equal(
      await f.count('SELECT count(*)::int n FROM commerce_captures WHERE order_id=$1', [
        created.orderId,
      ]),
      1,
    );
  }));

test('unknown and a result overdue 15 minutes become incidents, never the kitchen', () =>
  fixture(async (f) => {
    await f.link();
    const who = await f.guest();
    const created = await f.order(who);
    const attempt = await pay(f, who, created.orderId);
    const shown = await f.checkout.terminalEvent(
      who,
      created.orderId,
      result(attempt, { status: 'unknown', transaction_id: null, amount_tenge: null }),
    );
    assert.equal(shown.phase, 'checking');
    const row = (
      await f.pool.query('SELECT * FROM commerce_kiosk_terminal_attempts WHERE attempt_id=$1', [
        attempt.attempt_id,
      ])
    ).rows[0];
    assert.equal(row.state, 'unknown');
    assert.equal(row.incident, 'result_unknown');
    assert.equal(
      (
        await f.pool.query('SELECT state FROM commerce_payment_attempts WHERE id=$1', [
          attempt.attempt_id,
        ])
      ).rows[0].state,
      'unknown',
    );
    assert.deepEqual(
      (
        await f.pool.query('SELECT code FROM commerce_reconciliation_issues WHERE order_id=$1', [
          created.orderId,
        ])
      ).rows.map((r) => r.code),
      ['KIOSK_TERMINAL_RESULT_UNKNOWN'],
    );
    // The unknown result is the attempt's one result.
    await assert.rejects(
      f.checkout.terminalEvent(who, created.orderId, result(attempt, { process_id: 'P-2' })),
      code('CONFLICT'),
    );
    await f.admission(created.orderId);
    assert.equal(
      await f.count(
        "SELECT count(*)::int n FROM commerce_outbox WHERE order_id=$1 AND event_type='edge.kitchen_admission_requested'",
        [created.orderId],
      ),
      0,
    );

    // Overdue: started, then nothing for 15 minutes.
    const late = await f.guest();
    const lateOrder = await f.order(late);
    const lateAttempt = await pay(f, late, lateOrder.orderId);
    await f.checkout.terminalEvent(late, lateOrder.orderId, started(lateAttempt));
    assert.deepEqual(await f.checkout.terminal.reviewOverdue(f.branch), { overdue: 0 });
    // Shift the attempt into the past (test only: as the owner, bypassing the immutable fields).
    await f.pool.query('ALTER TABLE commerce_kiosk_terminal_attempts DISABLE TRIGGER USER');
    await f.pool.query(
      "UPDATE commerce_kiosk_terminal_attempts SET created_at=created_at-interval '16 minutes',expires_at=expires_at-interval '16 minutes' WHERE attempt_id=$1",
      [lateAttempt.attempt_id],
    );
    await f.pool.query('ALTER TABLE commerce_kiosk_terminal_attempts ENABLE TRIGGER USER');
    // Any kiosk read sweeps its branch.
    const overdue = await f.checkout.read(late, lateOrder.orderId);
    assert.equal(overdue.phase, 'checking');
    assert.equal(overdue.payment.state, 'checking');
    assert.deepEqual(await f.checkout.terminal.reviewOverdue(), { overdue: 0 });
    assert.deepEqual(
      (
        await f.pool.query(
          'SELECT a.state,a.incident,p.state attempt FROM commerce_kiosk_terminal_attempts a JOIN commerce_payment_attempts p ON p.id=a.attempt_id WHERE a.attempt_id=$1',
          [lateAttempt.attempt_id],
        )
      ).rows[0],
      { state: 'unknown', incident: 'result_overdue', attempt: 'unknown' },
    );
    assert.deepEqual(
      (
        await f.pool.query('SELECT code FROM commerce_reconciliation_issues WHERE order_id=$1', [
          lateOrder.orderId,
        ])
      ).rows.map((r) => r.code),
      ['KIOSK_TERMINAL_RESULT_OVERDUE'],
    );
    // A late exact result still records the money; the order stays with the manager.
    const settled = await f.checkout.terminalEvent(late, lateOrder.orderId, result(lateAttempt));
    assert.equal(settled.payment.state, 'paid');
    assert.equal(settled.phase, 'attention');
    await f.admission(lateOrder.orderId);
    assert.equal(
      await f.count(
        "SELECT count(*)::int n FROM commerce_outbox WHERE order_id=$1 AND event_type='edge.kitchen_admission_requested'",
        [lateOrder.orderId],
      ),
      0,
    );
    assert.equal(
      (
        await f.pool.query(
          'SELECT incident FROM commerce_kiosk_terminal_attempts WHERE attempt_id=$1',
          [lateAttempt.attempt_id],
        )
      ).rows[0].incident,
      'result_overdue',
    );
  }));

test('not linked, whole tenge and flag off', () =>
  fixture(async (f) => {
    const who = await f.guest();
    const created = await f.order(who);
    await assert.rejects(pay(f, who, created.orderId), code('KIOSK_TERMINAL_NOT_LINKED'));
    // Flag off: every terminal action is refused, config keeps its earlier exact answer.
    const off = f.build(f.pool, null).checkout;
    const offConfig = await off.kioskConfig(who);
    assert.equal('kaspi_terminal' in offConfig, false);
    assert.deepEqual(Object.keys(offConfig).sort(), [
      'branchId',
      'enabled',
      'paymentMethod',
      'paymentMethods',
      'restaurant',
    ]);
    await assert.rejects(f.link({}, f.device, off), code('KIOSK_TERMINAL_DISABLED'));
    await assert.rejects(off.terminal.unlink(f.device), code('KIOSK_TERMINAL_DISABLED'));
    await assert.rejects(
      off.pay(who, created.orderId, { method: 'kaspi_terminal', request_id: randomUUID() }),
      code('KIOSK_TERMINAL_DISABLED'),
    );
    await assert.rejects(
      off.terminalEvent(who, created.orderId, result({ attempt_id: randomUUID() })),
      code('KIOSK_TERMINAL_DISABLED'),
    );
    // Disabled account: config off, payment refused.
    await f.link();
    await f.pool.query('UPDATE commerce_provider_accounts SET enabled=false WHERE id=$1', [
      f.posAccount,
    ]);
    assert.equal((await f.checkout.kioskConfig(who)).kaspi_terminal.enabled, false);
    await assert.rejects(pay(f, who, created.orderId), code('KIOSK_TERMINAL_DISABLED'));
    await f.pool.query('UPDATE commerce_provider_accounts SET enabled=true WHERE id=$1', [
      f.posAccount,
    ]);
    // Whole tenge only (a priced order with tiyn never reaches the terminal).
    await f.pool.query('ALTER TABLE commerce_orders DISABLE TRIGGER USER');
    await f.pool.query('UPDATE commerce_orders SET total_minor=total_minor+50 WHERE id=$1', [
      created.orderId,
    ]);
    await f.pool.query('ALTER TABLE commerce_orders ENABLE TRIGGER USER');
    await assert.rejects(pay(f, who, created.orderId), code('KIOSK_TERMINAL_WHOLE_TENGE'));
    assert.equal(await f.count('SELECT count(*)::int n FROM commerce_kiosk_terminal_attempts'), 0);
  }));

test('grants: exact rights, flag off revokes, and the restricted API role runs the whole flow', () =>
  fixture(async (f) => {
    assert.deepEqual(kioskTerminalPrivileges(false), {});
    for (const role of ['', null, 'Role', 'x;DROP ROLE api', 'a'.repeat(64), '1api'])
      assert.throws(() => kioskTerminalGrants(role, true));
    for (const enabled of [undefined, null, 'true', 1])
      assert.throws(() => kioskTerminalGrants('api', enabled));
    const role = 'kiosk_pos_' + randomUUID().replaceAll('-', '').slice(0, 20);
    await f.cloud.admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE`);
    let runtime;
    const privileges = async () =>
      (
        await f.pool.query(
          `SELECT table_name||':'||privilege_type p FROM information_schema.role_table_grants
           WHERE grantee=$1 AND table_name=ANY($2) UNION
           SELECT c.relname||'.'||a.attname||':'||x.privilege_type FROM pg_attribute a
           JOIN pg_class c ON c.oid=a.attrelid AND c.relnamespace=current_schema()::regnamespace
           CROSS JOIN LATERAL aclexplode(a.attacl) x
           WHERE x.grantee=$1::regrole AND c.relname=ANY($2) ORDER BY 1`,
          [role, [...TERMINAL_TABLES]],
        )
      ).rows.map((r) => r.p);
    try {
      await f.pool.query(`GRANT USAGE ON SCHEMA ${f.cloud.schema} TO ${role}`);
      await f.pool.query(kioskCheckoutGrants(role, true));
      // Before 080 rights the routes fail at the database.
      const url = new URL(f.cloud.config.databaseUrl);
      url.searchParams.set('options', `-c search_path=${f.cloud.schema} -c role=${role}`);
      runtime = createPool(url.toString(), 4);
      const api = f.build(runtime).checkout;
      await assert.rejects(f.link({}, f.device, api), /permission denied/);
      await f.pool.query(kioskTerminalGrants(role, true, f.cloud.schema));
      await f.pool.query(kioskTerminalGrants(role, true, f.cloud.schema));
      assert.deepEqual(await privileges(), [
        'commerce_kiosk_terminal_attempts.incident:UPDATE',
        'commerce_kiosk_terminal_attempts.process_id:UPDATE',
        'commerce_kiosk_terminal_attempts.resolved_at:UPDATE',
        'commerce_kiosk_terminal_attempts.state:UPDATE',
        'commerce_kiosk_terminal_attempts.transaction_id:UPDATE',
        'commerce_kiosk_terminal_attempts:INSERT',
        'commerce_kiosk_terminal_attempts:SELECT',
        'commerce_kiosk_terminal_events:INSERT',
        'commerce_kiosk_terminal_events:SELECT',
        'kiosk_terminal_links.host:UPDATE',
        'kiosk_terminal_links.serial:UPDATE',
        'kiosk_terminal_links.unlinked_at:UPDATE',
        'kiosk_terminal_links.updated_at:UPDATE',
        'kiosk_terminal_links:INSERT',
        'kiosk_terminal_links:SELECT',
      ]);
      // The whole flow under the restricted API role.
      await f.link({}, f.device, api);
      const apiSessions = f.build(runtime).sessions;
      const token = randomBytes(32).toString('hex');
      await apiSessions.start(f.kiosk, f.deviceKey, { sessionId: randomUUID(), token });
      const who = await apiSessions.authenticate(f.kiosk, f.deviceKey, token);
      const created = await f.order(who);
      const runtimeCheckout = new KioskCheckout(runtime, f.options, apiSessions, NOW, {
        accountId: f.posAccount,
      });
      const attempt = await runtimeCheckout.pay(who, created.orderId, {
        method: 'kaspi_terminal',
        request_id: randomUUID(),
      });
      await runtimeCheckout.terminalEvent(who, created.orderId, started(attempt));
      const paid = await runtimeCheckout.terminalEvent(who, created.orderId, result(attempt));
      assert.equal(paid.phase, 'paid');
      // Money and identities stay immutable for the runtime.
      for (const sql of [
        'UPDATE commerce_kiosk_terminal_attempts SET amount_minor=100',
        'UPDATE commerce_kiosk_terminal_attempts SET terminal_id=terminal_id',
        'DELETE FROM commerce_kiosk_terminal_attempts',
        'UPDATE commerce_kiosk_terminal_events SET decision=decision',
        'DELETE FROM commerce_kiosk_terminal_events',
        'DELETE FROM kiosk_terminal_links',
        'UPDATE kiosk_terminal_links SET device_id=device_id',
        'UPDATE commerce_captures SET amount_minor=1',
        'UPDATE commerce_provider_accounts SET enabled=false',
      ])
        await assert.rejects(runtime.query(sql), /permission denied/, sql);
      // Flag off: no right on any 080 table remains.
      await f.pool.query(kioskTerminalGrants(role, false, f.cloud.schema));
      assert.deepEqual(await privileges(), []);
      await assert.rejects(f.link({}, f.device, api), /permission denied/);
    } finally {
      await runtime?.end();
      await f.pool.query(`DROP OWNED BY ${role}`);
      await f.cloud.admin.query(`DROP ROLE ${role}`);
    }
    // Before 080 the helper is a no-op.
    assert.match(
      kioskTerminalGrants('api', true),
      /to_regclass\('public\.commerce_kiosk_terminal_events'\) IS NOT NULL/,
    );
  }));

test('HTTP: routes, codes, no-store and the kiosk headers', () =>
  fixture(async (f) => {
    const saved = { ...process.env };
    Object.assign(process.env, {
      KIOSK_CHECKOUT_ENABLED: 'true',
      KIOSK_CHECKOUT_ORGANIZATION_ID: f.org,
      KIOSK_CHECKOUT_BRANCH_ID: f.branch,
      KIOSK_CHECKOUT_PAYMENT_METHOD: 'kaspi_qr',
      KIOSK_KASPI_QR_ACCOUNT_ID: f.qrAccount,
      KIOSK_CHECKOUT_FISCAL_POLICY: 'deferred_pilot',
      // Open around the clock except one minute, so the real clock never closes it.
      CUSTOMER_KASPI_OPENING_TIME: '00:00',
      CUSTOMER_KASPI_CLOSING_TIME: '23:59',
      CUSTOMER_KASPI_TIMEZONE: 'Asia/Almaty',
      KIOSK_CHECKOUT_APPROVAL_REFERENCE: 'Synthetic approval',
      KIOSK_CHECKOUT_TAX_CODE: 'PENDING_PILOT',
      KIOSK_CHECKOUT_MAX_MINOR: '50000',
      KIOSK_CHECKOUT_PII_KEY: randomBytes(32).toString('hex'),
      KIOSK_KASPI_TERMINAL_ENABLED: 'true',
      KIOSK_KASPI_TERMINAL_ACCOUNT_ID: f.posAccount,
    });
    const require = createRequire(new URL('../../services/api/package.json', import.meta.url));
    const { Module } = require('@nestjs/common');
    class TestModule {}
    Module({
      controllers: [KioskCheckoutController],
      providers: [
        {
          provide: RESOURCE,
          useValue: {
            pool: f.pool,
            config: f.cloud.config,
            admission: {
              intercept(_c, next) {
                return next.handle();
              },
            },
          },
        },
      ],
    })(TestModule);
    let app;
    try {
      app = await createHttpApplication(TestModule);
      await app.listen(0, '127.0.0.1');
      const base = `${await app.getUrl()}/v1/kiosk-checkout`.replace('[::1]', '127.0.0.1');
      const sessions = new KioskSessions(f.pool, {
        piiKey: Buffer.from(process.env.KIOSK_CHECKOUT_PII_KEY, 'hex'),
      });
      const token = randomBytes(32).toString('hex');
      await sessions.start(f.kiosk, f.deviceKey, { sessionId: randomUUID(), token });
      const who = await sessions.authenticate(f.kiosk, f.deviceKey, token);
      const request = async (method, path, body, guest = true, key = f.deviceKey) => {
        const response = await fetch(base + path, {
          method,
          headers: {
            'x-kiosk-device': f.kiosk,
            'x-kiosk-key': key,
            ...(guest ? { Authorization: 'Bearer ' + token } : {}),
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        assert.equal(response.headers.get('cache-control'), 'no-store');
        return { status: response.status, body: await response.json() };
      };
      const config = await request('GET', '/config');
      assert.equal(config.status, 200);
      assert.deepEqual(config.body.kaspi_terminal, { enabled: true, terminal: null });
      const body = { terminal_id: 'T-100', serial: 'SN-1', host: '192.168.2.40' };
      assert.equal((await request('PUT', '/terminal', body, false, 'f'.repeat(64))).status, 403);
      const linked = await request('PUT', '/terminal', body, false);
      assert.equal(linked.status, 200);
      assert.equal(linked.body.terminal_id, 'T-100');
      assert.equal((await request('PUT', '/terminal', { ...body, host: '1.1.1.1' })).status, 400);
      const other = await f.addKiosk();
      const taken = await fetch(base + '/terminal', {
        method: 'PUT',
        headers: {
          'x-kiosk-device': other.id,
          'x-kiosk-key': other.key,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      assert.equal(taken.status, 409);
      assert.equal((await taken.json()).code, 'KIOSK_TERMINAL_TAKEN');
      assert.deepEqual(
        (await request('GET', '/config')).body.kaspi_terminal.terminal.terminal_id,
        'T-100',
      );
      const created = await f.order(who);
      const paying = await request('POST', `/orders/${created.orderId}/payment`, {
        method: 'kaspi_terminal',
        request_id: randomUUID(),
      });
      assert.equal(paying.status, 200);
      assert.equal(paying.body.amount_tenge, 110);
      const events = `/orders/${created.orderId}/terminal-events`;
      const start = await request('POST', events, started(paying.body));
      assert.equal(start.status, 200);
      assert.equal(start.body.phase, 'awaiting_payment');
      const done = await request('POST', events, result(paying.body));
      assert.equal(done.status, 200);
      assert.equal(done.body.phase, 'paid');
      assert.equal(done.body.paymentMethod, 'kaspi_terminal');
      const conflict = await request('POST', events, result(paying.body, { amount_tenge: 1 }));
      assert.equal(conflict.status, 409);
      assert.equal(conflict.body.code, 'CONFLICT');
      assert.equal((await request('GET', `/orders/${created.orderId}`)).body.phase, 'paid');
      const unlinked = await request('DELETE', '/terminal', undefined, false);
      assert.deepEqual(unlinked, { status: 200, body: { unlinked: true } });
      // Second guest of the same kiosk: the terminal is unlinked now.
      const nextToken = randomBytes(32).toString('hex');
      await sessions.start(f.kiosk, f.deviceKey, { sessionId: randomUUID(), token: nextToken });
      const next = await sessions.authenticate(f.kiosk, f.deviceKey, nextToken);
      const second = await f.order(next);
      const notLinked = await fetch(base + `/orders/${second.orderId}/payment`, {
        method: 'POST',
        headers: {
          'x-kiosk-device': f.kiosk,
          'x-kiosk-key': f.deviceKey,
          Authorization: 'Bearer ' + nextToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ method: 'kaspi_terminal', request_id: randomUUID() }),
      });
      assert.equal(notLinked.status, 409);
      assert.equal((await notLinked.json()).code, 'KIOSK_TERMINAL_NOT_LINKED');
    } finally {
      await app?.close();
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  }));
