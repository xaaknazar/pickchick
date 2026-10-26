// Stage 2 (24.10.2026), lane pcs: the cashier refuses a combo with a stopped part (audit 1.3,
// 4.2, 6.3; PM decision 1). The rule runs on the edge (quote and order) and in the POS screen,
// only when the active menu carries the optional fields; an old menu behaves as before.
/* global structuredClone */
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createEdge } from '@pickchick/edge';
import {
  createLocalOrder,
  createQuote,
  openCashShift,
  provisionStaff,
  setOrdering,
  setStop,
} from '@pickchick/local-orders';
import { applyMenu, localCatalogId, projectCatalogMenu, publishMenu } from '@pickchick/menu-sync';
import { mockupCatalogDraft } from '../../packages/catalog-admin/dist/seed.js';
import { withSyncDatabases, running } from '../helpers/sync.mjs';
import { staffAuth } from '../helpers/orders.mjs';
import { PosController } from '../../apps/pos/dist/model.js';
import { ApiError, errorMessage } from '../../apps/pos/dist/api.js';
import { itemStopView, stopReasonText } from '../../apps/pos/dist/types.js';

/** Seed catalog plus the owner data the rule needs: fixed components and explicit drink links. */
function ownerCatalog() {
  const catalog = structuredClone(mockupCatalogDraft);
  const product = (id) => catalog.products.find((p) => p.id === id);
  product('pick-combo').combo_components = [
    { product_id: 'fingers', quantity: 3 },
    { product_id: 'toast', quantity: 1 },
  ];
  product('master-combo').combo_components = [{ product_id: 'pick-combo', quantity: 1 }];
  for (const option of product('pick-combo').modifier_groups.find((g) => g.id === 'drink').options)
    if (['cola-bottle', 'cola-can', 'cola-zero'].includes(option.id))
      option.linked_product_id = 'cola';
  return catalog;
}

async function cashier(run, { comboStops = true } = {}) {
  await withSyncDatabases(async ({ cloud, edge, branch }) => {
    const menu = projectCatalogMenu(
      ownerCatalog(),
      branch,
      1,
      new Date().toISOString(),
      undefined,
      { comboStops },
    );
    await applyMenu(edge.pool, branch, await publishMenu(cloud.pool, menu));
    const setup = (role) => ({
      staff_id: randomUUID(),
      terminal_id: randomUUID(),
      name: 'Synthetic staff',
      role,
    });
    const cashierSetup = setup('cashier');
    const cashierCredential = await provisionStaff(edge.pool, branch, cashierSetup);
    const manager = await provisionStaff(edge.pool, branch, {
      ...setup('shift_manager'),
      terminal_id: cashierCredential.terminal_id,
    });
    await openCashShift(edge.pool, branch, staffAuth(manager), randomUUID(), {
      opening_cash_minor: '0',
    });
    await setOrdering(edge.pool, branch, staffAuth(manager), randomUUID(), true, {
      expected_version: 1,
    });
    const variant = (id) => localCatalogId(branch, 'base-preview', id);
    const group = (product, id) => localCatalogId(branch, 'modifier-group', `${product}:${id}`);
    const option = (product, groupId, id) =>
      localCatalogId(branch, 'modifier-option', `${product}:${groupId}:${id}`);
    const versions = new Map();
    const stop = async (variantId, stopped = true) => {
      const state = await setStop(edge.pool, branch, staffAuth(manager), randomUUID(), {
        variant_id: variantId,
        stopped,
        expected_version: versions.get(variantId) ?? 0,
        reason: 'Synthetic stop',
      });
      versions.set(variantId, state.version);
    };
    /** One combo line: drink and sauce are the required groups of every seed combo. */
    const sauces = { 'master-combo': 2 };
    const combo = (product, drink = 'lemonade', sauce = 'pick') => ({
      release_id: menu.release_id,
      service_mode: 'takeaway',
      items: [
        {
          variant_id: variant(product),
          quantity: 1,
          modifiers: [
            { group_id: group(product, 'drink'), option_id: option(product, 'drink', drink) },
            {
              group_id: group(product, 'sauce'),
              option_id: option(product, 'sauce', sauce),
              quantity: sauces[product] ?? 1,
            },
          ],
        },
      ],
    });
    const quote = (cart) => createQuote(edge.pool, branch, staffAuth(cashierCredential), cart);
    await run({
      cloud,
      edge,
      branch,
      menu,
      manager,
      cashier: cashierCredential,
      variant,
      option,
      stop,
      combo,
      quote,
    });
  });
}
const stopped = { code: 'ITEM_STOPPED' };

test('a stopped fixed component stops the combo at quote and at order, nested combos too', async () => {
  await cashier(async ({ edge, branch, cashier, variant, stop, combo, quote }) => {
    const before = await quote(combo('pick-combo'));
    assert.equal(before.lines.length, 1);
    await quote(combo('master-combo'));
    await stop(variant('fingers'));
    await assert.rejects(quote(combo('pick-combo')), stopped);
    // master-combo contains pick-combo, which contains fingers.
    await assert.rejects(quote(combo('master-combo')), stopped);
    // The quote taken before the stop cannot become an order.
    await assert.rejects(
      createLocalOrder(edge.pool, branch, staffAuth(cashier), randomUUID(), {
        quote_id: before.quote_id,
      }),
      stopped,
    );
    // Other combos and the drink alone stay on sale.
    await quote(combo('burger-combo'));
    await stop(variant('fingers'), false);
    const after = await quote(combo('pick-combo'));
    const order = await createLocalOrder(edge.pool, branch, staffAuth(cashier), randomUUID(), {
      quote_id: after.quote_id,
    });
    assert.equal(order.state, 'awaiting_payment');
  });
});

test('a stopped drink product stops only that option, by explicit link or by the same id', async () => {
  await cashier(async ({ variant, option, stop, combo, quote }) => {
    await stop(variant('cola'));
    await assert.rejects(quote(combo('pick-combo', 'cola-bottle')), stopped);
    await assert.rejects(quote(combo('pick-combo', 'cola-zero')), stopped);
    await quote(combo('pick-combo', 'lemonade'));
    await stop(variant('lemonade'));
    await assert.rejects(quote(combo('pick-combo', 'lemonade')), stopped);
    await assert.rejects(quote(combo('burger-combo', 'lemonade')), stopped);
    await quote(combo('pick-combo', 'sprite'));
    // The option's own stop keeps working as before.
    await stop(option('pick-combo', 'drink', 'sprite'));
    await assert.rejects(quote(combo('pick-combo', 'sprite')), stopped);
    await quote(combo('burger-combo', 'sprite'));
  });
});

test('every option of a required group stopped: no line of that combo can be sold', async () => {
  await cashier(async ({ option, stop, combo, quote }) => {
    // bbq is published unavailable; pick, hot and cheese are stopped one by one.
    for (const sauce of ['pick', 'hot', 'cheese']) await stop(option('pick-combo', 'sauce', sauce));
    for (const sauce of ['pick', 'hot', 'cheese'])
      await assert.rejects(quote(combo('pick-combo', 'lemonade', sauce)), stopped);
    await assert.rejects(quote(combo('pick-combo', 'lemonade', 'bbq')), {
      code: 'INVALID_REQUEST',
    });
    await quote(combo('burger-combo', 'lemonade', 'pick'));
  });
});

test('an old menu without the fields keeps the old behaviour: only product and options', async () => {
  await cashier(
    async ({ menu, variant, option, stop, combo, quote }) => {
      assert.equal(JSON.stringify(menu).includes('combo_component_variant_ids'), false);
      await stop(variant('fingers'));
      await stop(variant('cola'));
      await quote(combo('pick-combo', 'cola-bottle'));
      await stop(option('pick-combo', 'drink', 'cola-bottle'));
      await assert.rejects(quote(combo('pick-combo', 'cola-bottle')), stopped);
      await stop(variant('pick-combo'));
      await assert.rejects(quote(combo('pick-combo', 'lemonade')), stopped);
    },
    { comboStops: false },
  );
});

test('POS screen shows why a combo or an option is out and does not add it', async () => {
  await cashier(async ({ edge, menu, cashier, variant, option, stop }) => {
    const server = await running(createEdge, edge.config);
    try {
      const api = async (path, c, o = {}) => {
        const response = await fetch(`${server.url}/edge/v1/${path}`, {
          method: o.method ?? 'GET',
          headers: {
            Authorization: `Bearer ${c.token}`,
            'X-Staff-Session-Id': c.session_id,
            'Content-Type': 'application/json',
            ...(o.key ? { 'Idempotency-Key': o.key } : {}),
          },
          ...(o.body === undefined ? {} : { body: JSON.stringify(o.body) }),
        });
        const value = await response.json();
        if (!response.ok) throw new ApiError(value.code, response.status);
        return value;
      };
      const memory = () => {
        const data = new Map();
        return {
          getItem: (k) => data.get(k) ?? null,
          setItem: (k, v) => data.set(k, v),
          removeItem: (k) => data.delete(k),
        };
      };
      await stop(variant('fingers'));
      await stop(variant('cola'));
      const pos = new PosController(api, memory(), memory(), randomUUID);
      await pos.login(JSON.stringify(cashier));
      await pos.refreshStops();
      assert.equal(pos.state.error, null);
      const item = (id) => pos.state.menu.items.find((i) => i.variant_id === variant(id));
      // The edge serves the new fields to the POS screen.
      assert.deepEqual(item('pick-combo').combo_component_variant_ids, [
        variant('fingers'),
        variant('toast'),
      ]);
      const pick = itemStopView(pos.state.menu, item('pick-combo'), pos.state.stops);
      assert.equal(pick.available, false);
      assert.equal(stopReasonText(pick), 'Комбо недоступно: «Фингерс, 1 шт» в стоп-листе');
      assert.equal(pick.stoppedOptions.has(option('pick-combo', 'drink', 'cola-bottle')), true);
      const burger = itemStopView(pos.state.menu, item('burger-combo'), pos.state.stops);
      assert.equal(burger.available, true);
      // Owner data matters: burger-combo has no explicit cola link and 'cola-bottle' names no
      // product, so the cola stop does not reach that option.
      assert.equal(
        burger.stoppedOptions.has(option('burger-combo', 'drink', 'cola-bottle')),
        false,
      );
      const drink = item('burger-combo').modifier_groups.find((g) =>
        g.options.some((o) => o.id === option('burger-combo', 'drink', 'lemonade')),
      );
      const sauce = item('burger-combo').modifier_groups.find((g) =>
        g.options.some((o) => o.id === option('burger-combo', 'sauce', 'pick')),
      );
      // Adding the blocked combo is refused locally with a clear message.
      pos.configure(item('pick-combo').variant_id, [], 1);
      assert.equal(pos.state.error.message, 'COMBO_STOPPED');
      assert.match(errorMessage(pos.state.error), /Комбо недоступно/);
      // burger-combo: cola-bottle is not linked there, but lemonade is (same id as the product).
      await stop(variant('lemonade'));
      await pos.refreshStops();
      pos.configure(
        item('burger-combo').variant_id,
        [
          {
            group_id: drink.id,
            option_id: option('burger-combo', 'drink', 'lemonade'),
            quantity: 1,
          },
          { group_id: sauce.id, option_id: option('burger-combo', 'sauce', 'pick'), quantity: 1 },
        ],
        1,
      );
      assert.equal(pos.state.error.message, 'OPTION_STOPPED');
      assert.match(errorMessage(pos.state.error), /в стоп-листе/);
      assert.equal(pos.state.draft.items.length, 0);
      pos.configure(
        item('burger-combo').variant_id,
        [
          { group_id: drink.id, option_id: option('burger-combo', 'drink', 'water'), quantity: 1 },
          { group_id: sauce.id, option_id: option('burger-combo', 'sauce', 'pick'), quantity: 1 },
        ],
        1,
      );
      assert.equal(pos.state.error, null);
      assert.equal(pos.state.draft.items.length, 1);
      await pos.calculate();
      assert.equal(pos.state.error, null);
      assert.equal(pos.state.quote.release_id, menu.release_id);
      // Review: every sauce of burger-combo out (bbq is published unavailable). The reason names
      // the group, not a combo part, since a plain item (sauce size) can hit the same rule.
      for (const id of ['pick', 'hot', 'cheese']) await stop(option('burger-combo', 'sauce', id));
      await pos.refreshStops();
      const noSauce = itemStopView(pos.state.menu, item('burger-combo'), pos.state.stops);
      assert.equal(noSauce.available, false);
      assert.match(stopReasonText(noSauce), /^Недоступно: нет доступных вариантов в группе «/);
      pos.configure(item('burger-combo').variant_id, [], 1);
      assert.equal(pos.state.error.message, 'CHOICE_STOPPED');
      assert.match(errorMessage(pos.state.error), /обязательного выбора в стоп-листе/);
      assert.equal(pos.state.draft.items.length, 1);
    } finally {
      await server.app.close();
    }
  });
});
