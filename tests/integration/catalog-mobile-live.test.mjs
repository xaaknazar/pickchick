/* global structuredClone */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  CatalogAdmin,
  CatalogAdminError,
  provisionCatalogManager,
} from '../../packages/catalog-admin/dist/index.js';
import { CustomerCheckout, MenuChangedError } from '../../packages/commerce-core/dist/index.js';
import {
  publishedProductData,
  publishedCartVersion,
} from '../../apps/mobile/src/published-catalog.ts';
import { pricingFixture, product, group, option } from '../helpers/catalog-pricing.mjs';
import { withSyncDatabases } from '../helpers/sync.mjs';

test('mobile storefront and checkout share published products, channel prices and version; legacy/stale requests fail', async () => {
  await withSyncDatabases(async ({ cloud, org, legal, branch, device }) => {
    const pool = cloud.pool,
      customer = randomUUID(),
      account = randomUUID();
    const manager = await provisionCatalogManager(pool, {
      organization_id: org,
      name: 'Synthetic live catalog director',
      branch_ids: [branch],
    });
    const legacy = new CatalogAdmin(pool, { enabled: true });
    let state = await legacy.seed(manager.token, branch, {
      expected_revision: 0,
      request_id: randomUUID(),
    });
    const payload = pricingFixture([
      product('current-burger', {
        name: { ru: 'Current restaurant burger', kk: '' },
        price_minor: '245000',
        image_asset_key: 'shot.jpg',
        modifier_groups: [
          group([option('extra', { price_delta_minor: '15000', max_quantity: 2 })]),
        ],
      }),
      product('current-sauce', { price_minor: '25000' }),
    ]).publication.payload;
    payload.upsell_product_ids = ['current-sauce'];
    const save = async (service, next) =>
      service.save(manager.token, branch, {
        expected_revision: state.draft.revision,
        request_id: randomUUID(),
        payload: next,
      });
    const publish = async (service) =>
      service.publish(manager.token, branch, {
        expected_revision: state.draft.revision,
        expected_published_version: state.published?.version ?? 0,
        request_id: randomUUID(),
        confirmation: 'publish_catalog',
      });
    state = await save(legacy, payload);
    state = await publish(legacy);
    const director = new CatalogAdmin(pool, { enabled: true, mobileStorefrontBranchId: branch });
    assert.equal(
      (await director.read(manager.token, branch)).draft.payload.products[0].id,
      'current-burger',
    );
    assert.equal((await director.read(manager.token, branch)).publication_support.mobile, true);
    const updated = structuredClone(payload);
    updated.products[0].channel_prices_minor = { mobile: '255001' };
    updated.products[0].description.ru = 'Director updated description';
    state = await save(director, updated);
    state = await publish(director);
    await pool.query('UPDATE branches SET ordering_enabled=true WHERE id=$1', [branch]);
    await pool.query("UPDATE devices SET status='active' WHERE id=$1", [device]);
    await pool.query(
      'INSERT INTO fulfillment_transport_bindings(branch_id,organization_id,device_id,producer_id) VALUES($1,$2,$3,$4)',
      [branch, org, device, randomUUID()],
    );
    await pool.query(
      "INSERT INTO cloud_branch_availability(branch_id,device_id,revision,stopped_ids) VALUES($1,$2,1,'{}')",
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
    const storefront = await checkout.catalog(),
      products = publishedProductData(storefront, 'ru');
    assert.deepEqual(
      products.map((p) => p.id),
      ['current-burger', 'current-sauce'],
    );
    assert.equal(products[0].description, 'Director updated description');
    assert.equal(products[0].priceMinor, '255001');
    assert.equal(products[1].priceMinor, '25000');
    assert.equal(storefront.payload.products[0].image_asset_key, 'shot.jpg');
    assert.equal(products[0].modifierGroups[0].options[0].id, 'extra');
    const cart = [
      {
        product: products[0],
        quantity: 2,
        selections: [{ group_id: 'side', option_id: 'extra', quantity: 2 }],
      },
    ];
    const request = {
      key: randomUUID(),
      branchId: branch,
      catalog_version: publishedCartVersion(cart, branch),
      serviceMode: 'takeaway',
      items: cart.map((l) => ({
        productId: l.product.id,
        quantity: l.quantity,
        selections: l.selections,
      })),
    };
    const quote = await checkout.quote(customer, request);
    assert.equal(
      quote.totalMinor,
      (2n * (BigInt(products[0].priceMinor) + 2n * 15000n)).toString(),
    );
    const before = (await pool.query('SELECT count(*)::int n FROM commerce_quotes')).rows[0].n;
    const noVersion = { ...request, key: randomUUID() };
    delete noVersion.catalog_version;
    await assert.rejects(checkout.quote(customer, noVersion), { code: 'CATALOG_UPGRADE_REQUIRED' });
    await assert.rejects(
      checkout.quote(customer, { ...request, key: randomUUID(), catalog_version: 1 }),
      { code: 'CONFLICT' },
    );
    assert.equal(
      (await pool.query('SELECT count(*)::int n FROM commerce_quotes')).rows[0].n,
      before,
    );
    const rollbackCheckout = new CustomerCheckout(pool, {
      organizationId: org,
      branchId: branch,
      paymentAccountId: account,
      customerIds: [customer],
      maxOrderMinor: '10000000',
      approvalReference: 'Synthetic approved pilot',
    });
    await assert.rejects(rollbackCheckout.quote(customer, noVersion), {
      code: 'CATALOG_UPGRADE_REQUIRED',
    });
    for (const channel of ['pos', 'kiosk']) {
      const blocked = structuredClone(updated);
      blocked.products[0].channel_prices_minor[channel] = '999';
      state = await save(director, blocked);
      await assert.rejects(
        publish(director),
        (e) => e instanceof CatalogAdminError && e.code === 'CONFLICT',
      );
    }
    assert.equal((await checkout.catalog()).version, storefront.version);
    const next = structuredClone(updated);
    next.products[0].channel_prices_minor.mobile = '265001';
    state = await save(director, next);
    state = await publish(director);
    const counts = async () => {
      const result = {};
      for (const table of [
        'commerce_orders',
        'commerce_outbox',
        'commerce_payment_attempts',
        'commerce_commands',
      ])
        result[table] = (await pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n;
      return result;
    };
    const beforeCreate = await counts();
    assert.equal(beforeCreate.commerce_orders, 0);
    assert.equal(beforeCreate.commerce_outbox, 0);
    // An issued, unexpired quote pins its publication despite subsequent releases.
    const createKey = randomUUID();
    const created = await checkout.create(customer, { key: createKey, quoteId: quote.quoteId });
    assert.equal(created.totalMinor, quote.totalMinor);
    await assert.rejects(checkout.quote(customer, { ...request, key: randomUUID() }), {
      code: 'CONFLICT',
    });
    state = await save(director, next);
    state = await publish(director);
    const beforeReplay = await counts();
    const replay = await checkout.create(customer, { key: createKey, quoteId: quote.quoteId });
    assert.equal(replay.orderId, created.orderId);
    assert.deepEqual(await counts(), beforeReplay);
    const guarded = new CustomerCheckout(pool, {
      organizationId: org,
      branchId: branch,
      paymentAccountId: account,
      customerIds: [customer],
      maxOrderMinor: '10000000',
      approvalReference: 'Synthetic approved pilot',
      publishedCatalogEnabled: true,
      headGuardEnabled: true,
    });
    await Promise.all(
      [1, 2].map(() => assert.rejects(guarded.pay(customer, created.orderId), MenuChangedError)),
    );
    assert.equal(
      (await pool.query('SELECT count(*)::int n FROM commerce_payment_attempts')).rows[0].n,
      0,
    );
    const cancellation = (
      await pool.query('SELECT reason,state FROM commerce_cancellation_intents WHERE order_id=$1', [
        created.orderId,
      ])
    ).rows;
    assert.equal(cancellation.length, 1, 'retry retains one durable cancellation');
    assert.equal(cancellation[0].reason, 'CATALOG_CHANGED_BEFORE_PAYMENT');
    assert.equal((await guarded.read(customer, created.orderId)).phase, 'failed');
    assert.equal(
      (await guarded.read(customer, created.orderId)).totalMinor,
      quote.totalMinor,
      'saved financial amount is immutable',
    );

    assert.equal(
      (
        await new CustomerCheckout(pool, {
          organizationId: org,
          branchId: branch,
          paymentAccountId: account,
          customerIds: [customer],
          maxOrderMinor: '10000000',
          approvalReference: 'Synthetic approved pilot',
        })
          .catalog()
          .catch((e) => e)
      ).code,
      'NOT_FOUND',
    );
  });
});
