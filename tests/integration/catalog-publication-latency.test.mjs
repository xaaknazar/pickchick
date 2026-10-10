/* global structuredClone */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { CatalogAdmin, provisionCatalogManager } from '../../packages/catalog-admin/dist/index.js';
import { CustomerCheckout } from '../../packages/commerce-core/dist/index.js';
import { CatalogPublicationListener } from '../../services/api/dist/catalog-publication-listener.js';
import { CustomerCheckoutController } from '../../services/api/dist/customer-checkout-controller.js';
import { pricingFixture, product } from '../helpers/catalog-pricing.mjs';
import { withSyncDatabases } from '../helpers/sync.mjs';

// The real controller long-poll, the real LISTEN connection and CatalogAdmin.publish on the
// local PostgreSQL. Synthetic schema only: no order, payment or provider call is made.
const response = () => ({
  destroyed: false,
  headers: {},
  setHeader(name, value) {
    this.headers[name.toLowerCase()] = value;
  },
});

test('publish wakes the controller long-poll with the new signature in under a second; save does not', () =>
  withSyncDatabases(async ({ cloud, org, legal, branch, device }) => {
    const pool = cloud.pool,
      customer = randomUUID(),
      account = randomUUID();
    const manager = await provisionCatalogManager(pool, {
      organization_id: org,
      name: 'Synthetic latency director',
      branch_ids: [branch],
    });
    let state = await new CatalogAdmin(pool, { enabled: true }).seed(manager.token, branch, {
      expected_revision: 0,
      request_id: randomUUID(),
    });
    let payload = pricingFixture([
      product('burger', { price_minor: '245000', channel_prices_minor: { mobile: '255001' } }),
      product('side', { price_minor: '25000' }),
    ]).publication.payload;
    const director = new CatalogAdmin(pool, { enabled: true, mobileStorefrontBranchId: branch });
    const save = async () => {
      state = await director.save(manager.token, branch, {
        expected_revision: state.draft.revision,
        request_id: randomUUID(),
        payload,
      });
    };
    const publish = async () => {
      await save();
      state = await director.publish(manager.token, branch, {
        expected_revision: state.draft.revision,
        expected_published_version: state.published?.version ?? 0,
        request_id: randomUUID(),
        confirmation: 'publish_catalog',
      });
    };
    await publish();
    await pool.query('UPDATE branches SET ordering_enabled=true WHERE id=$1', [branch]);
    await pool.query("UPDATE devices SET status='active' WHERE id=$1", [device]);
    await pool.query(
      'INSERT INTO fulfillment_transport_bindings(branch_id,organization_id,device_id,producer_id) VALUES($1,$2,$3,$4)',
      [branch, org, device, randomUUID()],
    );
    await pool.query(
      "INSERT INTO cloud_branch_availability(branch_id,device_id,revision,stopped_ids,observed_at) VALUES($1,$2,1,'{}',now() + interval '1 hour')",
      [branch, device],
    );
    await pool.query(
      "INSERT INTO commerce_provider_accounts(id,organization_id,branch_id,legal_entity_id,kind,provider,external_reference,enabled) VALUES($1,$2,$3,$4,'payment','kaspi-remote','synthetic-no-payment',true)",
      [account, org, branch, legal],
    );
    const checkout = new CustomerCheckout(pool, {
      organizationId: org,
      branchId: branch,
      paymentAccountId: account,
      customerIds: [customer],
      maxOrderMinor: '10000000',
      approvalReference: 'Synthetic approved pilot',
      publishedCatalogEnabled: true,
    });
    // Reads that start before the publish commits are held back, so the woken waiters find a
    // shared in-flight read of the old head (the race this test guards against).
    let holdNextRead = false;
    const read = checkout.availabilityState.bind(checkout);
    checkout.availabilityState = async () => {
      const hold = holdNextRead;
      holdNextRead = false;
      const value = await read();
      if (hold) await delay(700);
      return value;
    };
    const listener = new CatalogPublicationListener({ pool });
    await listener.onModuleInit();
    const controller = new CustomerCheckoutController(
      { me: async () => assert.fail('identity is not used by availability') },
      { pool },
      listener,
    );
    controller.checkout = checkout;
    try {
      const first = response();
      await controller.availability(first, undefined);
      const before = first.headers['x-availability-signature'];
      assert.ok(before);
      assert.equal(first.headers['x-catalog-version'], '1');
      const waiters = Array.from({ length: 20 }, () => {
        const res = response();
        return controller.availability(res, before).then(() => ({ res, at: Date.now() }));
      });
      let settled = 0;
      for (const waiter of waiters) void waiter.then(() => settled++);
      await delay(200);

      // A draft save never wakes the storefront.
      payload = structuredClone(payload);
      payload.products[0].channel_prices_minor.mobile = '265001';
      await save();
      await delay(600);
      assert.equal(settled, 0, 'save must not wake waiters');

      // An unrelated reader starts a slow shared read of the old head just before publish.
      holdNextRead = true;
      const stale = controller.availability(response(), undefined);
      await delay(20);
      await publish();
      const published = Date.now();
      const results = await Promise.all(waiters);
      await stale;
      const slowest = Math.max(...results.map(({ at }) => at - published));
      assert.ok(slowest < 1000, `long-poll returned after ${slowest} ms`);
      for (const { res } of results) {
        assert.notEqual(res.headers['x-availability-signature'], before);
        assert.equal(res.headers['x-catalog-version'], '2');
      }
      for (const table of ['commerce_orders', 'commerce_payment_attempts'])
        assert.equal((await pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n, 0);
    } finally {
      await listener.onModuleDestroy();
    }
  }));
