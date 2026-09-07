/* global structuredClone */
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { CatalogAdmin, provisionCatalogManager } from '../../packages/catalog-admin/dist/index.js';
import {
  CatalogPricing,
  CatalogPricingError,
  catalogPayloadHash,
} from '../../packages/catalog-pricing/dist/index.js';
import { CatalogPublicSchema } from '@pickchick/catalog-admin/contracts';
import { withSyncDatabases } from '../helpers/sync.mjs';
const isError = (code) => (error) => error instanceof CatalogPricingError && error.code === code;
async function fixture(run) {
  return withSyncDatabases(async (ctx) => {
    const pool = ctx.cloud.pool,
      service = new CatalogAdmin(pool, { enabled: true });
    const manager = await provisionCatalogManager(pool, {
      organization_id: ctx.org,
      name: 'Synthetic pricing editor',
      branch_ids: [ctx.branch],
    });
    const pricing = new CatalogPricing(pool);
    const scope = {
      organizationId: ctx.org,
      branchId: ctx.branch,
      customerId: randomUUID(),
      channel: 'mobile',
    };
    const save = (state, payload = state.draft.payload) =>
      service.save(manager.token, ctx.branch, {
        expected_revision: state.draft.revision,
        request_id: randomUUID(),
        payload,
      });
    const publish = (state) =>
      service.publish(manager.token, ctx.branch, {
        expected_revision: state.draft.revision,
        expected_published_version: state.published?.version ?? 0,
        request_id: randomUUID(),
        confirmation: 'publish_catalog',
      });
    const seed = () =>
      service.seed(manager.token, ctx.branch, { expected_revision: 0, request_id: randomUUID() });
    const enable = () =>
      pool.query('UPDATE branches SET ordering_enabled=true WHERE id=$1', [ctx.branch]);
    const cart = (catalog, id = 'burger') => {
      const product = catalog.payload.products.find((p) => p.id === id);
      assert.ok(product);
      return {
        catalog_version: catalog.version,
        service_mode: 'takeaway',
        items: [
          {
            sku: product.sku,
            quantity: 2,
            selections: product.modifier_groups.flatMap((g) =>
              g.options
                .filter((o) => o.default_quantity)
                .map((o) => ({
                  group_id: g.id,
                  option_id: o.id,
                  quantity: o.default_quantity,
                })),
            ),
          },
        ],
      };
    };
    await run({
      ...ctx,
      pool,
      service,
      manager,
      scope,
      pricing,
      save,
      publish,
      seed,
      enable,
      cart,
    });
  });
}
test('real publication flow prices current reviewed 24-SKU catalog, leaves draft and TEST/foundation effects isolated', async () =>
  fixture(async (ctx) => {
    const noCatalogCart = {
      catalog_version: 1,
      service_mode: 'takeaway',
      items: [{ sku: 'burger', quantity: 1, selections: [] }],
    };
    await assert.rejects(ctx.pricing.price(ctx.scope, noCatalogCart), isError('CATALOG_NOT_FOUND'));
    let state = await ctx.seed();
    await assert.rejects(ctx.pricing.price(ctx.scope, noCatalogCart), isError('CATALOG_NOT_FOUND'));
    state = await ctx.save(state, { ...state.draft.payload, content_reviewed: true });
    state = await ctx.publish(state);
    const published = CatalogPublicSchema.parse(await ctx.service.publicCatalog(ctx.branch));
    assert.equal(published.payload.products.length, 24);
    const cart = ctx.cart(published);
    await assert.rejects(ctx.pricing.price(ctx.scope, cart), isError('BRANCH_UNAVAILABLE'));
    await ctx.enable();
    const quote = await ctx.pricing.price(ctx.scope, cart);
    assert.equal(quote.catalogReference.version, published.version);
    assert.equal(quote.catalogReference.payloadHash, catalogPayloadHash(published.payload));
    assert.equal(quote.catalogReference.publishedAt, published.published_at);
    assert.equal(quote.customerId, ctx.scope.customerId);
    assert.equal(
      quote.lines[0].baseUnitPriceMinor,
      published.payload.products.find((p) => p.id === 'burger').price_minor,
    );
    assert.equal(quote.lines[0].selectedDetails.nutrition.perServing, null);
    const immutable = structuredClone(quote),
      edited = structuredClone(state.draft.payload);
    edited.products.find((p) => p.id === 'burger').price_minor = '888888';
    await ctx.save(state, edited);
    assert.deepEqual(await ctx.pricing.price(ctx.scope, cart), immutable);
    assert.deepEqual(quote, immutable);
    for (const table of ['test_actors', 'test_orders', 'menu_releases'])
      assert.equal((await ctx.pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count, '0');
    assert.equal(
      (await ctx.pool.query('SELECT count(*) FROM catalog_publications')).rows[0].count,
      '1',
    );
    const comboCart = ctx.cart(published, 'pick-combo');
    const comboQuote = await ctx.pricing.price(
      { ...ctx.scope, channel: 'kiosk', customerId: null },
      comboCart,
    );
    assert.equal(comboQuote.channel, 'kiosk');
    assert.equal(comboQuote.lines[0].selectedDetails.modifiers.length > 0, true);
    await assert.rejects(
      ctx.pricing.price(ctx.scope, {
        ...comboCart,
        items: [{ ...comboCart.items[0], selections: [] }],
      }),
      isError('INVALID_SELECTION'),
    );
  }));
test('publication and concurrent pricing observe whole versions; stale requests cannot silently accept new prices', async () =>
  fixture(async (ctx) => {
    let state = await ctx.seed();
    state = await ctx.save(state, { ...state.draft.payload, content_reviewed: true });
    state = await ctx.publish(state);
    await ctx.enable();
    const first = await ctx.service.publicCatalog(ctx.branch),
      cart = ctx.cart(first);
    const before = await ctx.pricing.price(ctx.scope, cart);
    const edited = structuredClone(state.draft.payload);
    edited.products.find((p) => p.id === 'burger').price_minor = '987654';
    state = await ctx.save(state, edited);
    const operations = await Promise.allSettled([
      ...Array.from({ length: 6 }, () => ctx.pricing.price(ctx.scope, cart)),
      ctx.publish(state),
      ...Array.from({ length: 6 }, () => ctx.pricing.price(ctx.scope, cart)),
    ]);
    assert.equal(operations[6].status, 'fulfilled');
    for (const [index, value] of operations.entries()) {
      if (index === 6) continue;
      if (value.status === 'fulfilled') assert.deepEqual(value.value, before);
      else assert.ok(isError('STALE_CATALOG')(value.reason));
    }
    await assert.rejects(ctx.pricing.price(ctx.scope, cart), isError('STALE_CATALOG'));
    const latest = await ctx.service.publicCatalog(ctx.branch);
    const after = await ctx.pricing.price(ctx.scope, ctx.cart(latest));
    assert.equal(after.catalogReference.version, 2);
    assert.equal(after.lines[0].baseUnitPriceMinor, '987654');
    assert.notEqual(after.catalogReference.payloadHash, before.catalogReference.payloadHash);
    assert.notEqual(after.lines[0].lineId, before.lines[0].lineId);
    assert.equal(
      (
        await ctx.pool.query(
          'SELECT payload FROM catalog_publications WHERE branch_id=$1 AND version=1',
          [ctx.branch],
        )
      ).rows[0].payload.products.find((p) => p.id === 'burger').price_minor,
      before.lines[0].baseUnitPriceMinor,
    );
  }));
test('organization and branch scope cannot cross catalogs; publication of stop-list immediately blocks new calculation', async () =>
  fixture(async (ctx) => {
    let state = await ctx.seed();
    state = await ctx.save(state, { ...state.draft.payload, content_reviewed: true });
    state = await ctx.publish(state);
    await ctx.enable();
    const first = await ctx.service.publicCatalog(ctx.branch),
      cart = ctx.cart(first);
    await assert.rejects(
      ctx.pricing.price({ ...ctx.scope, organizationId: randomUUID() }, cart),
      isError('CATALOG_NOT_FOUND'),
    );
    await assert.rejects(
      ctx.pricing.price({ ...ctx.scope, branchId: randomUUID() }, cart),
      isError('CATALOG_NOT_FOUND'),
    );
    const edited = structuredClone(state.draft.payload);
    edited.products.find((p) => p.id === 'burger').available = false;
    state = await ctx.save(state, edited);
    state = await ctx.publish(state);
    await assert.rejects(
      ctx.pricing.price(ctx.scope, { ...cart, catalog_version: state.published.version }),
      isError('PRODUCT_UNAVAILABLE'),
    );
  }));
test('pricing repository needs SELECT on exactly three catalog/branch tables and performs no row locks or writes', async () =>
  fixture(async (ctx) => {
    let state = await ctx.seed();
    state = await ctx.save(state, { ...state.draft.payload, content_reviewed: true });
    await ctx.publish(state);
    await ctx.enable();
    const catalog = await ctx.service.publicCatalog(ctx.branch),
      cart = ctx.cart(catalog);
    const role = `pricing_${randomUUID().replaceAll('-', '')}`;
    const db = await ctx.pool.connect();
    try {
      await db.query(`CREATE ROLE ${role} NOLOGIN`);
      await db.query(`GRANT USAGE ON SCHEMA ${ctx.cloud.schema} TO ${role}`);
      await db.query(
        `GRANT SELECT ON branches,catalog_branch_heads,catalog_publications TO ${role}`,
      );
      await db.query('BEGIN');
      await db.query(`SET LOCAL ROLE ${role}`);
      const result = await new CatalogPricing(db).price(ctx.scope, cart);
      assert.equal(result.catalogReference.version, 1);
      await assert.rejects(
        db.query('SELECT payload FROM catalog_draft_versions'),
        (e) => e.code === '42501',
      );
      await db.query('ROLLBACK');
    } finally {
      await db.query('ROLLBACK');
      await db.query('RESET ROLE');
      await db.query(`DROP OWNED BY ${role}`);
      await db.query(`DROP ROLE ${role}`);
      db.release();
    }
  }));
