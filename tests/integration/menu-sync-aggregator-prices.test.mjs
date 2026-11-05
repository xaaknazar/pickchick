// Cutover CC-3 (contracts 5.3, R4): aggregator prices reach the cashier edge as
// MenuItem.aggregator_prices_minor only behind CATALOG_AGGREGATOR_PRICES_ENABLED and only for an
// edge that sends menu_features=aggregator_prices. Every other edge (installed edge021, the
// stage-2 runtime with combo_stops only) gets exactly the form it already parses, with its own
// checksum, and its ACK is accepted. Synthetic data only.
/* global structuredClone */
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createApi } from '@pickchick/api';
import {
  acknowledgeMenu,
  applyMenu,
  canonicalJson,
  channelItemPriceMinor,
  hashJson,
  menuDeliveryForm,
  projectCatalogMenu,
  provisionDevice,
  publishMenu,
  pullMenu,
  syncMenuOnce,
  withoutAggregatorPrices,
} from '@pickchick/menu-sync';
import { MenuPullSchema } from '@pickchick/contracts';
import { mockupCatalogDraft } from '../../packages/catalog-admin/dist/seed.js';
import { withSyncDatabases, running, authFor, headersFor, request } from '../helpers/sync.mjs';

/** Combo stop data plus aggregator prices (synthetic tiyn) on three products. */
function ownerCatalog({ aggregator = true } = {}) {
  const catalog = structuredClone(mockupCatalogDraft);
  const product = (id) => catalog.products.find((p) => p.id === id);
  product('pick-combo').combo_components = [
    { product_id: 'fingers', quantity: 3 },
    { product_id: 'toast', quantity: 1 },
  ];
  for (const option of product('pick-combo').modifier_groups.find((g) => g.id === 'drink').options)
    if (option.id === 'cola-bottle') option.linked_product_id = 'cola';
  if (aggregator) {
    product('pick-combo').channel_prices_minor = { yandex_eda: '459000', glovo: '469000' };
    product('burger').channel_prices_minor = { yandex_eda: '269000' };
    product('cola').channel_prices_minor = { glovo: '119000' };
  }
  return catalog;
}
const at = '2026-11-16T05:00:00.000Z';
const comboIn = (value) =>
  /combo_component_variant_ids|linked_variant_id/.test(JSON.stringify(value));
const aggregatorIn = (value) => /aggregator_prices_minor/.test(JSON.stringify(value));
const isConflict = { message: 'CONFLICT' };

test('flag on: edges without aggregator_prices get the form they parse and their ACK is accepted', async () => {
  await withSyncDatabases(async ({ cloud, edge, device, branch }) => {
    const identity = await provisionDevice(cloud.pool, device);
    const release = randomUUID();
    const options = (comboStops, aggregatorPrices) => ({ comboStops, aggregatorPrices });
    const projectAs = (catalog, opts) => projectCatalogMenu(catalog, branch, 1, at, release, opts);
    const full = projectAs(ownerCatalog(), options(true, true));
    const installed = projectAs(ownerCatalog({ aggregator: false }), options(false, false));
    const stage2 = projectAs(ownerCatalog({ aggregator: false }), options(true, false));
    const published = await publishMenu(cloud.pool, full);
    assert.equal(published.payload.checksum, hashJson(full));
    const api = await running(createApi, cloud.config);
    try {
      const pull = async (query = '') => {
        const response = await request(`${api.url}/internal/v1/edge/sync/pull${query}`, {
          headers: headersFor(identity),
        });
        assert.equal(response.status, 200);
        const text = await response.text();
        return { text, body: MenuPullSchema.parse(JSON.parse(text)) };
      };
      // Installed edge021: no menu_features at all (with and without its active menu).
      for (const query of ['', `?active_release_id=${randomUUID()}&active_version=1`]) {
        const old = await pull(query);
        assert.equal(comboIn(old.text) || aggregatorIn(old.text), false);
        assert.deepEqual(old.body.event.payload.menu, installed);
        assert.equal(old.body.event.payload.checksum, hashJson(installed));
        assert.equal(old.body.event.event_id, published.event_id);
      }
      // Stage-2 runtime: combo_stops only, never the aggregator prices.
      const stage = await pull('?menu_features=combo_stops');
      assert.equal(comboIn(stage.text), true);
      assert.equal(aggregatorIn(stage.text), false);
      assert.deepEqual(stage.body.event.payload.menu, stage2);
      assert.equal(stage.body.event.payload.checksum, hashJson(stage2));
      // aggregator_prices alone, both features, unknown values: each its exact form.
      const aggregatorOnly = await pull('?menu_features=aggregator_prices,future_thing');
      assert.equal(comboIn(aggregatorOnly.text), false);
      assert.equal(aggregatorIn(aggregatorOnly.text), true);
      assert.deepEqual(
        aggregatorOnly.body.event.payload.menu,
        projectAs(ownerCatalog(), options(false, true)),
      );
      const fresh = await pull('?menu_features=combo_stops,aggregator_prices');
      assert.deepEqual(fresh.body.event, published);
      // The installed edge applies its form; the cloud accepts that checksum and nothing else.
      const event = (await pull()).body.event;
      const ack = await applyMenu(edge.pool, branch, event);
      assert.equal(ack.checksum, hashJson(installed));
      await assert.rejects(
        acknowledgeMenu(cloud.pool, authFor(identity), { ...ack, checksum: 'a'.repeat(64) }),
        isConflict,
      );
      const response = await request(`${api.url}/internal/v1/edge/sync/ack`, {
        method: 'POST',
        headers: headersFor(identity),
        body: JSON.stringify(ack),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(
        (await cloud.pool.query('SELECT release_id FROM branch_menu_activations')).rows,
        [{ release_id: release }],
      );
      // Replay is idempotent; an ACK of another form is not a second ACK.
      await acknowledgeMenu(cloud.pool, authFor(identity), ack);
      await assert.rejects(
        acknowledgeMenu(cloud.pool, authFor(identity), { ...ack, checksum: hashJson(full) }),
        isConflict,
      );
      const stored = (await edge.pool.query('SELECT payload, checksum FROM menu_snapshots'))
        .rows[0];
      assert.equal(aggregatorIn(stored.payload) || comboIn(stored.payload), false);
      assert.equal(stored.checksum, hashJson(installed));
      // The public branch menu (installed mobile parses it strictly) never shows cashier fields.
      const publicMenu = await request(`${api.url}/v1/branches/${branch}/menu`);
      assert.equal(publicMenu.status, 200);
      const text = await publicMenu.text();
      assert.equal(aggregatorIn(text) || comboIn(text), false);
      assert.deepEqual(JSON.parse(text), installed);
    } finally {
      await api.app.close();
    }
  });
});

test('flag on, new edge: the worker advertises aggregator_prices and applies the full form', async () => {
  await withSyncDatabases(async ({ cloud, edge, device, branch }) => {
    const identity = await provisionDevice(cloud.pool, device);
    const full = projectCatalogMenu(ownerCatalog(), branch, 1, at, randomUUID(), {
      comboStops: true,
      aggregatorPrices: true,
    });
    await publishMenu(cloud.pool, full);
    const api = await running(createApi, cloud.config);
    try {
      assert.deepEqual(await syncMenuOnce(edge.pool, branch, api.url, identity), {
        state: 'applied',
      });
      assert.deepEqual(await syncMenuOnce(edge.pool, branch, api.url, identity), { state: 'idle' });
    } finally {
      await api.app.close();
    }
    const stored = (await edge.pool.query('SELECT payload, checksum FROM menu_snapshots')).rows[0];
    assert.equal(canonicalJson(stored.payload), canonicalJson(full));
    assert.equal(stored.checksum, hashJson(full));
    assert.equal(
      (await cloud.pool.query('SELECT release_id FROM branch_menu_activations')).rows[0].release_id,
      full.release_id,
    );
    // The cashier prices aggregator lines from the applied menu (contracts 5.3).
    const item = (slug) => stored.payload.items.find((i) => i.source_id === slug);
    assert.equal(channelItemPriceMinor(item('burger'), 'yandex_eda'), '269000');
    assert.equal(channelItemPriceMinor(item('burger'), 'glovo'), null);
    assert.equal(channelItemPriceMinor(item('cola'), 'glovo'), '119000');
    assert.equal(channelItemPriceMinor(item('fingers'), 'yandex_eda'), null);
    assert.equal(channelItemPriceMinor(item('fingers'), 'hall'), item('fingers').price_minor);
  });
});

test('ACK: the checksum of each of the four forms is accepted, a foreign one never', async () => {
  await withSyncDatabases(async ({ cloud, device, branch }) => {
    const auth = authFor(await provisionDevice(cloud.pool, device));
    const subsets = [
      [],
      ['combo_stops'],
      ['aggregator_prices'],
      ['combo_stops', 'aggregator_prices'],
    ];
    const events = [];
    for (const [index] of subsets.entries())
      events.push(
        await publishMenu(
          cloud.pool,
          projectCatalogMenu(ownerCatalog(), branch, index + 1, at, randomUUID(), {
            comboStops: true,
            aggregatorPrices: true,
          }),
        ),
      );
    for (const [index, features] of subsets.entries()) {
      const event = events[index];
      // The edge pulls the earliest unacknowledged event in the form of its features.
      const pulled = (await pullMenu(cloud.pool, auth, undefined, { features })).event;
      assert.deepEqual(pulled, menuDeliveryForm(event, features));
      const ack = {
        event_id: event.event_id,
        producer_id: event.producer_id,
        producer_sequence: event.producer_sequence,
        branch_id: branch,
        release_id: event.aggregate_id,
        checksum: pulled.payload.checksum,
      };
      await assert.rejects(
        acknowledgeMenu(cloud.pool, auth, { ...ack, checksum: 'b'.repeat(64) }),
        isConflict,
      );
      assert.deepEqual(await acknowledgeMenu(cloud.pool, auth, ack), {
        event_id: event.event_id,
        acknowledged: true,
      });
    }
    assert.equal(
      (
        await cloud.pool.query(
          'SELECT version FROM branch_menu_activations a JOIN menu_releases r ON r.id=a.release_id',
        )
      ).rows[0].version,
      4,
    );
  });
});

test('catalog publication: off refuses aggregator prices and keeps releases as before; on projects them', async () => {
  const { CatalogAdmin, provisionCatalogManager, CatalogAdminError } =
    await import('../../packages/catalog-admin/dist/index.js');
  await withSyncDatabases(async ({ cloud, edge, org, branch, device }) => {
    const auth = authFor(await provisionDevice(cloud.pool, device));
    const manager = await provisionCatalogManager(cloud.pool, {
      organization_id: org,
      name: 'Синтетический управляющий',
      branch_ids: [branch],
    });
    // The edge reports an operator-installed v1 menu (publication bootstrap).
    const local = projectCatalogMenu(mockupCatalogDraft, branch, 1, at);
    await edge.pool.query(
      'INSERT INTO menu_snapshots(id,branch_id,version,schema_version,payload,checksum,published_at) VALUES($1,$2,1,1,$3,$4,$5)',
      [local.release_id, branch, canonicalJson(local), hashJson(local), local.published_at],
    );
    await pullMenu(cloud.pool, auth, { active_release_id: local.release_id, active_version: 1 });
    const base = { enabled: true, edgePublicationBranchId: branch };
    const off = new CatalogAdmin(cloud.pool, base);
    const on = new CatalogAdmin(cloud.pool, { ...base, edgeAggregatorPrices: true });
    // A storefront-only branch never publishes aggregator prices, even with the flag.
    const elsewhere = new CatalogAdmin(cloud.pool, {
      enabled: true,
      edgePublicationBranchId: randomUUID(),
      edgeAggregatorPrices: true,
    });
    let state = await off.seed(manager.token, branch, {
      expected_revision: 0,
      request_id: randomUUID(),
    });
    assert.deepEqual(state.publication_support, { mobile: false, pos: true, kiosk: false });
    assert.deepEqual((await on.read(manager.token, branch)).publication_support, {
      mobile: false,
      pos: true,
      kiosk: false,
      aggregator_prices: true,
    });
    assert.equal(
      'aggregator_prices' in (await elsewhere.read(manager.token, branch)).publication_support,
      false,
    );
    const save = async (service, payload) => {
      payload.content_reviewed = true;
      state = await service.save(manager.token, branch, {
        expected_revision: state.draft.revision,
        request_id: randomUUID(),
        payload,
      });
    };
    const publish = (service) =>
      service.publish(manager.token, branch, {
        expected_revision: state.draft.revision,
        expected_published_version: state.published?.version ?? 0,
        request_id: randomUUID(),
        confirmation: 'publish_catalog',
      });
    const latest = async () =>
      (await cloud.pool.query('SELECT payload FROM menu_releases ORDER BY version DESC LIMIT 1'))
        .rows[0].payload;
    // Flag off: the draft keeps the aggregator prices (like pos/kiosk overrides) but the
    // publication is refused, and nothing was written.
    await save(off, ownerCatalog());
    assert.deepEqual(
      state.draft.payload.products.find((p) => p.id === 'burger').channel_prices_minor,
      { yandex_eda: '269000' },
    );
    for (const service of [off, elsewhere])
      await assert.rejects(
        publish(service),
        (error) =>
          error instanceof CatalogAdminError &&
          error.code === 'CONFLICT' &&
          error.reason === 'CHANNEL_PRICES_NOT_SUPPORTED',
      );
    assert.equal(
      (await cloud.pool.query('SELECT count(*)::int n FROM menu_releases')).rows[0].n,
      0,
    );
    // Flag off without aggregator keys: the release is exactly the historical projection.
    await save(off, ownerCatalog({ aggregator: false }));
    state = await publish(off);
    const plain = await latest();
    assert.equal(aggregatorIn(plain) || comboIn(plain), false);
    assert.equal(
      hashJson(plain),
      hashJson(
        projectCatalogMenu(
          ownerCatalog({ aggregator: false }),
          branch,
          plain.version,
          plain.published_at,
          plain.release_id,
        ),
      ),
    );
    // Flag on: the release carries aggregator_prices_minor and nothing else changes.
    await save(on, ownerCatalog());
    state = await publish(on);
    assert.equal(state.publication_support.aggregator_prices, true);
    const priced = await latest();
    assert.equal(aggregatorIn(priced), true);
    assert.equal(comboIn(priced), false);
    assert.deepEqual(
      priced.items.find((i) => i.source_id === 'pick-combo').aggregator_prices_minor,
      { yandex_eda: '459000', glovo: '469000' },
    );
    assert.equal(hashJson(withoutAggregatorPrices(priced)), hashJson({ ...plain, ...ids(priced) }));
    // Own-channel overrides stay refused with the flag on.
    const own = ownerCatalog();
    own.products.find((p) => p.id === 'fingers').channel_prices_minor = { pos: '1' };
    await save(on, own);
    await assert.rejects(publish(on), (error) => error.reason === 'CHANNEL_PRICES_NOT_SUPPORTED');
    // The published catalog payload keeps the keys for the cloud; the storefront strip drops them.
    const { storefrontPayload } =
      await import('../../packages/commerce-core/dist/catalog-media.js');
    const head = (
      await cloud.pool.query(
        'SELECT p.payload FROM catalog_branch_heads h JOIN catalog_publications p ON p.branch_id=h.branch_id AND p.version=h.published_version WHERE h.branch_id=$1',
        [branch],
      )
    ).rows[0].payload;
    assert.equal(/yandex_eda|glovo/.test(JSON.stringify(head)), true);
    assert.equal(/yandex_eda|glovo/.test(JSON.stringify(storefrontPayload(head))), false);
  });
});
/** Release identity fields differ between two publications; everything else must match. */
const ids = (menu) => ({
  release_id: menu.release_id,
  version: menu.version,
  published_at: menu.published_at,
});
