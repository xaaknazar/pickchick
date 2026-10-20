// Release fixes 2026-10-19 (audit 1.1, 1.3/4.2): kiosk checks the cashier before the QR, a
// refused paid order becomes a staff case, and the combo stop rule holds on kiosk sales.
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { transaction } from '@pickchick/database';
import { withSyncDatabases, authFor } from '../../../tests/helpers/sync.mjs';
import {
  publishMenu,
  projectCatalogMenu,
  provisionDevice,
  pullMenu,
  applyMenu,
  acknowledgeMenu,
  localCatalogId,
} from '@pickchick/menu-sync';
import { KioskCheckout, KioskSessions, KioskKaspiQrProcessor } from '../dist/index.js';
import { publishCatalog } from './catalog-fixture.mjs';

// Same explicit localhost fixtures as commerce tests; never read a private server env.
process.env.APP_ENV ??= 'test';
process.env.CLOUD_DATABASE_URL ??=
  process.env.COMMERCE_TEST_DATABASE_URL ??
  'postgresql://pickchick_local:pickchick_local_only@127.0.0.1:55432/pickchick_cloud';
process.env.EDGE_DATABASE_URL ??=
  'postgresql://pickchick_local:pickchick_local_only@127.0.0.1:55433/pickchick_edge';
process.env.EDGE_BRANCH_ID ??= randomUUID();
process.env.REDIS_URL ??= 'redis://127.0.0.1:56379/0';
for (const name of ['CLOUD_DATABASE_URL', 'EDGE_DATABASE_URL'])
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(process.env[name]).hostname));

async function fixture(run) {
  await withSyncDatabases(async (f) => {
    const pool = f.cloud.pool,
      payment = randomUUID(),
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
    await pool.query(
      "INSERT INTO commerce_provider_accounts(id,organization_id,branch_id,kind,provider,external_reference,enabled,legal_entity_id) VALUES($1::uuid,$2,$3,'payment','kaspi-qr',$1::text,true,$4)",
      [payment, f.org, f.branch, f.legal],
    );
    await pool.query(
      'INSERT INTO kiosk_devices(id,organization_id,branch_id,token_hash) VALUES($1,$2,$3,$4)',
      [kiosk, f.org, f.branch, createHash('sha256').update(deviceKey).digest('hex')],
    );
    const sessions = new KioskSessions(pool, { piiKey: randomBytes(32) });
    const token = randomBytes(32).toString('hex');
    await sessions.start(kiosk, deviceKey, { sessionId: randomUUID(), token });
    const who = await sessions.authenticate(kiosk, deviceKey, token);
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
    const checkout = new KioskCheckout(
      pool,
      {
        organizationId: f.org,
        branchId: f.branch,
        paymentAccountId: payment,
        paymentMethod: 'kaspi_qr',
        fiscalPolicy: 'deferred_pilot',
        approvalReference: 'Synthetic kiosk test only',
        taxCode: 'PENDING_PILOT',
        maxOrderMinor: '50000',
        hours: { openingTime: '10:00', closingTime: '00:00', timeZone: 'Asia/Almaty' },
      },
      sessions,
      () => new Date('2026-10-04T10:00:00Z'),
    );
    const cart = (selections = [{ group_id: 'extra', option_id: 'sauce', quantity: 1 }]) => ({
      key: randomUUID(),
      branchId: f.branch,
      catalog_version: 1,
      serviceMode: 'takeaway',
      items: [{ productId: 'BURGER', quantity: 1, selections }],
    });
    const order = async (selections) => {
      const quote = await checkout.quote(who, cart(selections));
      return checkout.create(who, { key: randomUUID(), quoteId: quote.quoteId });
    };
    const stop = (ids) =>
      pool.query('UPDATE cloud_branch_availability SET stopped_ids=$1::uuid[]', [ids]);
    await run({ ...f, pool, payment, who, checkout, cart, order, stop });
  });
}
const code = (expected) => (error) => error.code === expected;

test('kiosk QR is not issued while the cashier has closed ordering', () =>
  fixture(async (f) => {
    const created = await f.order();
    await f.pool.query('UPDATE cloud_branch_availability SET ordering_closed=true');
    assert.equal((await f.checkout.config(f.who)).enabled, false);
    await assert.rejects(
      f.checkout.pay(f.who, created.orderId, { method: 'kaspi_qr' }),
      code('NOT_READY'),
    );
    assert.equal(
      (await f.pool.query('SELECT count(*)::int n FROM commerce_payment_attempts')).rows[0].n,
      0,
    );
    await f.pool.query('UPDATE cloud_branch_availability SET ordering_closed=false');
    assert.equal((await f.checkout.config(f.who)).enabled, true);
    const paying = await f.checkout.pay(f.who, created.orderId, { method: 'kaspi_qr' });
    assert.equal(paying.payment.kind, 'kaspi_qr');
  }));

test('a paid kiosk QR order the cashier refused shows the staff-help state, not a missing number', () =>
  fixture(async (f) => {
    const created = await f.order();
    await f.checkout.pay(f.who, created.orderId, { method: 'kaspi_qr' });
    const bank = {
      creates: 0,
      async checkSession() {
        return true;
      },
      async create(amount) {
        this.creates++;
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
        accountId: f.payment,
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
    const paid = await f.checkout.read(f.who, created.orderId);
    assert.equal(paid.phase, 'paid');
    assert.equal(paid.displayNumber, null);
    // The cashier refused the paid order (ordering closed, item stopped on the POS).
    const event = (
      await f.pool.query(
        "SELECT id FROM commerce_outbox WHERE order_id=$1 AND event_type='edge.admission_requested'",
        [created.orderId],
      )
    ).rows[0].id;
    const outcome = await transaction(f.pool, (client) =>
      f.checkout.repository.recordAdmissionRefusal(
        client,
        { organizationId: f.org, branchId: f.branch, deviceId: f.device },
        { eventId: event, reason: 'NOT_READY' },
      ),
    );
    assert.equal(outcome, 'attention');
    const shown = await f.checkout.read(f.who, created.orderId);
    // Installed kiosk builds show their staff-help screen for 'failed' with a paid QR.
    assert.equal(shown.phase, 'failed');
    assert.equal(shown.payment.state, 'paid');
    const row = (
      await f.pool.query('SELECT state,attention_required FROM commerce_orders WHERE id=$1', [
        created.orderId,
      ])
    ).rows[0];
    assert.deepEqual(row, { state: 'attention_required', attention_required: true });
  }));

test('a stopped linked product hides the option and blocks quote and payment on the kiosk', () =>
  fixture(async (f) => {
    const before = await f.order();
    await f.stop([localCatalogId(f.branch, 'base-preview', 'sauce')]);
    const view = await f.checkout.availability(f.who);
    const burger = view.products.find((p) => p.productId === 'burger');
    assert.equal(burger.available, true);
    assert.deepEqual(burger.stoppedOptions, [{ group_id: 'extra', option_id: 'sauce' }]);
    assert.equal(view.products.find((p) => p.productId === 'sauce').available, false);
    await assert.rejects(f.checkout.quote(f.who, f.cart()), code('ITEM_STOPPED'));
    await assert.rejects(
      f.checkout.pay(f.who, before.orderId, { method: 'kaspi_qr' }),
      code('ITEM_STOPPED'),
    );
    // Without the stopped option the burger is still sold.
    assert.ok((await f.checkout.quote(f.who, f.cart([]))).quoteId);
  }));
