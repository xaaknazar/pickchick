// Cutover CC-3 (contracts 5.3): back-office aggregator price fields. The editor writes only the
// channel key it shows and keeps every other product field as it came from the server.
/* global structuredClone */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  AGGREGATOR_CHANNELS,
  OWN_CHANNELS,
  aggregatorPriceLine,
  catalogHasBlockedAggregatorPrices,
  catalogHasChannelPrices,
  channelPriceInput,
  hasAggregatorPrice,
  parsePayload,
  parseState,
  productIssues,
  publicationCopy,
  setChannelPrice,
} from '../../apps/backoffice/dist/domain.js';
import { CatalogModel } from '../../apps/backoffice/dist/model.js';
import { mockupCatalogDraft } from '../../packages/catalog-admin/dist/seed.js';
import { CatalogPayloadSchema } from '../../packages/catalog-admin/dist/contracts.js';
import { storage } from './helpers.mjs';

const branch = '10000000-0000-4000-8000-000000000003';
/** A product carrying every optional field the editor does not show next to the prices. */
function fullProduct() {
  const payload = structuredClone(mockupCatalogDraft);
  const p = payload.products.find((v) => v.id === 'pick-combo');
  p.channel_prices_minor = {
    mobile: '429000',
    pos: '419000',
    kiosk: '439000',
    yandex_eda: '459000',
    glovo: '469050',
  };
  p.kitchen_route = 'prep';
  p.image = {
    asset_id: randomUUID(),
    sha256: 'ab'.repeat(32),
    tile_color: '#FFAA00',
    cutout: true,
  };
  p.combo_components = [{ product_id: 'fingers', quantity: 3 }];
  p.modifier_groups[0].options[0].linked_product_id = 'cola';
  p.modifier_groups[0].options[1].nutrition_multiplier = 1.5;
  return { payload, p };
}

test('round trip: every displayed price field applied unchanged leaves the product byte-identical', () => {
  const { payload, p } = fullProduct();
  assert.equal(CatalogPayloadSchema.safeParse(payload).success, true);
  const original = JSON.stringify(p);
  const edited = structuredClone(p);
  for (const channel of [...OWN_CHANNELS, ...AGGREGATOR_CHANNELS])
    assert.equal(setChannelPrice(edited, channel, channelPriceInput(edited, channel)), true);
  assert.equal(JSON.stringify(edited), original);
  // Same for a product without any channel price (no empty object appears).
  const plain = structuredClone(payload.products.find((v) => v.id === 'burger'));
  const before = JSON.stringify(plain);
  for (const channel of [...OWN_CHANNELS, ...AGGREGATOR_CHANNELS])
    setChannelPrice(plain, channel, channelPriceInput(plain, channel));
  assert.equal(JSON.stringify(plain), before);
  assert.equal('channel_prices_minor' in plain, false);
});

test('editing one aggregator price changes only that key; clearing removes it', () => {
  const { p } = fullProduct();
  assert.equal(channelPriceInput(p, 'yandex_eda'), '4590');
  assert.equal(channelPriceInput(p, 'glovo'), '4690,50');
  const edited = structuredClone(p);
  assert.equal(setChannelPrice(edited, 'yandex_eda', ' 4 690 '), true);
  assert.equal(setChannelPrice(edited, 'glovo', ''), true);
  const expected = structuredClone(p);
  expected.channel_prices_minor.yandex_eda = '469000';
  delete expected.channel_prices_minor.glovo;
  assert.deepEqual(edited, expected);
  assert.equal(JSON.stringify(edited), JSON.stringify(expected));
  // Invalid input never reaches the product.
  for (const bad of ['abc', '-1', '1,999', '1e3'])
    assert.equal(setChannelPrice(edited, 'yandex_eda', bad), false, bad);
  assert.deepEqual(edited, expected);
  // Clearing every channel removes the object itself.
  for (const channel of [...OWN_CHANNELS, ...AGGREGATOR_CHANNELS])
    setChannelPrice(edited, channel, '');
  assert.equal('channel_prices_minor' in edited, false);
  assert.deepEqual({ ...edited, channel_prices_minor: expected.channel_prices_minor }, expected);
  // A new price on a product without channel prices creates just that key.
  const fresh = structuredClone(mockupCatalogDraft.products.find((v) => v.id === 'burger'));
  setChannelPrice(fresh, 'glovo', '2790');
  assert.deepEqual(fresh.channel_prices_minor, { glovo: '279000' });
});

test('client validation, parsing and the catalog table line know the aggregator channels', () => {
  const { payload, p } = fullProduct();
  assert.deepEqual(productIssues(p, payload), []);
  assert.equal(parsePayload(payload).products.length, 24);
  const unknown = structuredClone(p);
  unknown.channel_prices_minor = { wolt: '1' };
  assert.deepEqual(productIssues(unknown, payload), ['Цены каналов: неизвестный канал.']);
  assert.equal(hasAggregatorPrice(p), true);
  assert.equal(hasAggregatorPrice(mockupCatalogDraft.products[0]), false);
  assert.equal(aggregatorPriceLine(p), 'Яндекс Еда: 4 590 ₸ · Glovo: 4 690,50 ₸');
  assert.equal(aggregatorPriceLine(mockupCatalogDraft.products[0]), 'Яндекс Еда: - · Glovo: -');
});

test('publication support: aggregator_prices only when the server says true; copy only then', () => {
  const state = (support) =>
    parseState({
      branch: { id: branch, code: 'SYN', name: 'Synthetic' },
      publication_support: support,
      draft: null,
      published: null,
    }).publication_support;
  const base = { mobile: true, pos: true, kiosk: true };
  assert.deepEqual(state(base), base);
  assert.deepEqual(state({ ...base, aggregator_prices: true }), {
    ...base,
    aggregator_prices: true,
  });
  for (const value of [false, 'true', 1])
    assert.deepEqual(state({ ...base, aggregator_prices: value }), base);
  // The publish dialog text is unchanged without the flag.
  assert.equal(publicationCopy({ ...base, aggregator_prices: true }).includes('Glovo'), true);
  assert.equal(publicationCopy(base).includes('Glovo'), false);
  assert.equal(
    publicationCopy({ ...base, pos: false, aggregator_prices: true }).includes('Glovo'),
    false,
  );
});

test('client publish guard: aggregator prices block only while their publication is off', () => {
  const { payload } = fullProduct();
  delete payload.products.find((v) => v.id === 'pick-combo').channel_prices_minor;
  payload.products.find((v) => v.id === 'burger').channel_prices_minor = { yandex_eda: '269000' };
  assert.equal(catalogHasChannelPrices(payload), true);
  assert.equal(catalogHasChannelPrices(payload, false, true), false);
  assert.equal(catalogHasBlockedAggregatorPrices(payload), true);
  assert.equal(catalogHasBlockedAggregatorPrices(payload, true), false);
  // Historical calls are unchanged for own channels.
  payload.products[2].channel_prices_minor = { mobile: '1' };
  assert.equal(catalogHasChannelPrices(payload, true, true), false);
  assert.equal(catalogHasChannelPrices(payload, false, true), true);
});

/** In-memory catalog API: one branch, a reviewed draft, publication answered with the state. */
function fakeApi(payload, support) {
  const actor = { id: randomUUID(), name: 'Синтетический управляющий' };
  let state = {
    branch: { id: branch, code: 'SYN', name: 'Synthetic' },
    publication_support: support,
    draft: {
      revision: 1,
      base_version: 0,
      updated_at: '2026-11-16T05:00:00.000Z',
      updated_by: actor.id,
      payload,
    },
    published: null,
  };
  const calls = [];
  const transport = async (path, _token, options = {}) => {
    calls.push([options.method ?? 'GET', path]);
    if (path === 'branches') return { actor, branches: [state.branch] };
    if (path === `branches/${branch}`) return structuredClone(state);
    if (path === `branches/${branch}/publish`) {
      state = {
        ...state,
        draft: { ...state.draft, revision: 2, base_version: 1 },
        published: {
          version: 1,
          published_at: '2026-11-16T05:01:00.000Z',
          published_by: actor.id,
          payload,
        },
      };
      return structuredClone(state);
    }
    throw new Error(`unexpected ${path}`);
  };
  return { transport, calls };
}

test('model publish: aggregator prices with the flag off are refused locally, with the flag on sent', async () => {
  const payload = structuredClone(mockupCatalogDraft);
  payload.content_reviewed = true;
  payload.products.find((v) => v.id === 'burger').channel_prices_minor = { yandex_eda: '269000' };
  const off = fakeApi(payload, { mobile: false, pos: true, kiosk: false });
  const blocked = new CatalogModel(off.transport, storage());
  assert.equal(await blocked.login(JSON.stringify({ token: 'a'.repeat(64) })), true);
  assert.equal(await blocked.publish(), false);
  assert.match(String(blocked.error?.message), /Цены Яндекс Еды и Glovo пока нельзя публиковать/);
  assert.equal(
    off.calls.some(([method]) => method === 'POST'),
    false,
  );
  const on = fakeApi(payload, { mobile: false, pos: true, kiosk: false, aggregator_prices: true });
  const allowed = new CatalogModel(on.transport, storage());
  assert.equal(await allowed.login(JSON.stringify({ token: 'a'.repeat(64) })), true);
  assert.equal(await allowed.publish(), true, String(allowed.error));
  assert.deepEqual(
    on.calls.filter(([method]) => method === 'POST'),
    [['POST', `branches/${branch}/publish`]],
  );
  assert.equal(allowed.state.published.version, 1);
  // Own-channel prices keep the historical message.
  const own = structuredClone(payload);
  own.products.find((v) => v.id === 'fingers').channel_prices_minor = { pos: '1' };
  const legacy = new CatalogModel(
    fakeApi(own, { mobile: false, pos: true, kiosk: false, aggregator_prices: true }).transport,
    storage(),
  );
  assert.equal(await legacy.login(JSON.stringify({ token: 'a'.repeat(64) })), true);
  assert.equal(await legacy.publish(), false);
  assert.match(String(legacy.error?.message), /одну базовую цену/);
});
