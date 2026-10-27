import test from 'node:test';
import assert from 'node:assert/strict';
import { testCompleteCatalog } from '@pickchick/test-order-flow/complete-catalog';
import {
  CART_BAR_PHOTOS,
  RECENT_PRODUCTS_LIMIT,
  cartBarLayout,
  cartCheckoutBlocked,
  noteCartAdditions,
  parseRecentProductIds,
  payableTotalMinor,
  recentCartLines,
  slideToPayAvailable,
} from '../../apps/mobile/src/cart-bar.ts';
import {
  cartTotal,
  defaultSelections,
  parsePreferences,
  updateQuantity,
} from '../../apps/mobile/src/domain.ts';

const products = testCompleteCatalog.products.map((p) => ({
  ...p,
  priceMinor: p.price_minor,
  modifierGroups: p.modifier_groups,
  source: 'server',
}));
const product = (id) => products.find((p) => p.id === id);
const ids = (lines) => lines.map((line) => line.product.id);

// The store's add path: updateQuantity, then the recency note for the accepted basket.
function add(state, id, selections) {
  const item = product(id);
  const chosen = selections ?? defaultSelections(item);
  const current =
    state.cart.find(
      (line) =>
        line.product.id === id && JSON.stringify(line.selections ?? []) === JSON.stringify(chosen),
    )?.quantity ?? 0;
  const cart = updateQuantity(state.cart, item, current + 1, chosen);
  return { cart, recent: noteCartAdditions(state.recent, [id], cart) };
}

test('the bar shows the last three added products, newest first', () => {
  let state = { cart: [], recent: [] };
  for (const id of ['pick-combo', 'burger', 'wedges', 'coleslaw']) state = add(state, id);
  assert.equal(CART_BAR_PHOTOS, 3);
  assert.deepEqual(ids(recentCartLines(state.cart, state.recent)), [
    'coleslaw',
    'wedges',
    'burger',
  ]);
  // Adding a product again moves it to the newest place without a second photo.
  state = add(state, 'pick-combo');
  assert.deepEqual(ids(recentCartLines(state.cart, state.recent)), [
    'pick-combo',
    'coleslaw',
    'wedges',
  ]);
  assert.deepEqual(state.recent, ['pick-combo', 'coleslaw', 'wedges', 'burger']);
  // A removed product leaves the photos; the next newest takes its place.
  const cart = state.cart.filter((line) => line.product.id !== 'coleslaw');
  assert.deepEqual(ids(recentCartLines(cart, state.recent)), ['pick-combo', 'wedges', 'burger']);
  assert.deepEqual(noteCartAdditions(state.recent, [], cart), ['pick-combo', 'wedges', 'burger']);
});

test('one photo per product, distinct lines of the same product share it', () => {
  let state = { cart: [], recent: [] };
  state = add(state, 'cola');
  state = add(state, 'pick-combo');
  state = add(state, 'burger');
  // The same combo with another drink is a second cart line, not a second photo.
  const sprite = defaultSelections(product('pick-combo')).map((selection) =>
    selection.group_id === 'drink' ? { ...selection, option_id: 'sprite' } : selection,
  );
  state = add(state, 'pick-combo', sprite);
  assert.equal(state.cart.filter((line) => line.product.id === 'pick-combo').length, 2);
  assert.deepEqual(ids(recentCartLines(state.cart, state.recent)), [
    'pick-combo',
    'burger',
    'cola',
  ]);
});

test('without add history (restored basket) the cart order decides, newest line first', () => {
  const cart = ['pick-combo', 'burger', 'wedges', 'coleslaw'].map((id) => ({
    product: product(id),
    quantity: 1,
  }));
  assert.deepEqual(ids(recentCartLines(cart, undefined)), ['coleslaw', 'wedges', 'burger']);
  assert.deepEqual(ids(recentCartLines(cart, [])), ['coleslaw', 'wedges', 'burger']);
  // Partial history first, then the remaining lines in reverse cart order.
  assert.deepEqual(ids(recentCartLines(cart, ['burger'])), ['burger', 'coleslaw', 'wedges']);
  // Unknown ids from an older basket are ignored.
  assert.deepEqual(ids(recentCartLines(cart, ['gone', 'pick-combo'], 2)), [
    'pick-combo',
    'coleslaw',
  ]);
  assert.deepEqual(recentCartLines(cart, ['burger'], 0), []);
  assert.deepEqual(recentCartLines([], ['burger']), []);
});

test('recency is bounded, deduplicated and survives the saved preferences', () => {
  const many = Array.from({ length: 30 }, (_, index) => ({
    product: { ...product('cola'), id: `p${index}` },
    quantity: 1,
  }));
  const recent = noteCartAdditions(
    [],
    many.map((line) => line.product.id),
    many,
  );
  assert.equal(recent.length, RECENT_PRODUCTS_LIMIT);
  assert.equal(recent[0], 'p29');
  assert.deepEqual(parseRecentProductIds(['a', 'b', 'a']), ['a', 'b']);
  assert.equal(parseRecentProductIds('a'), undefined);
  assert.equal(parseRecentProductIds([1]), undefined);
  assert.equal(parseRecentProductIds(['']), undefined);
  assert.equal(parseRecentProductIds(['x'.repeat(101)]), undefined);
  assert.equal(parseRecentProductIds(Array.from({ length: 21 }, (_, i) => `p${i}`)), undefined);
  const saved = {
    version: 2,
    catalogMode: 'server',
    diningMode: 'takeaway',
    locale: 'ru',
    nickname: '',
    branchId: null,
    releaseId: 'test:mockup-v0.3',
    lines: [{ id: 'burger', quantity: 1 }],
  };
  const withRecent = parsePreferences(
    JSON.stringify({ ...saved, recentProductIds: ['burger', 'cola'] }),
  );
  assert.deepEqual(withRecent.recentProductIds, ['burger', 'cola']);
  // A damaged list is presentation only: the basket itself is still restored.
  const damaged = parsePreferences(JSON.stringify({ ...saved, recentProductIds: 'burger' }));
  assert.equal(damaged.recentProductIds, undefined);
  assert.deepEqual(damaged.lines, saved.lines);
  assert.equal(parsePreferences(JSON.stringify(saved)).recentProductIds, undefined);
});

test('large text and 320 pt keep the total readable with fewer, smaller photos', () => {
  const base = cartBarLayout({ width: 393, fontScale: 1, totalLength: 7 });
  assert.deepEqual(
    { photos: base.photos, compact: base.compact, handle: base.handleWidth },
    { photos: 3, compact: false, handle: 76 },
  );
  const narrow = cartBarLayout({ width: 320, fontScale: 1, totalLength: 8 });
  assert.equal(narrow.photos, 3);
  assert.equal(narrow.compact, true);
  assert.ok(narrow.photoSize < base.photoSize && narrow.handleWidth < base.handleWidth);
  assert.equal(cartBarLayout({ width: 320, fontScale: 1, totalLength: 12 }).photos, 2);
  assert.equal(cartBarLayout({ width: 393, fontScale: 1.3, totalLength: 7 }).photos, 2);
  assert.equal(cartBarLayout({ width: 393, fontScale: 1.6, totalLength: 7 }).photos, 1);
  assert.equal(cartBarLayout({ width: 320, fontScale: 1.3, totalLength: 12 }).photos, 1);
  assert.equal(cartBarLayout({ width: 393, fontScale: 0.8, totalLength: 7 }).photos, 3);
  // Every photo stays at least 40 pt and the handle a 64 pt wide, 54 pt tall target.
  for (const width of [320, 393])
    for (const fontScale of [1, 1.3, 2]) {
      const layout = cartBarLayout({ width, fontScale, totalLength: 12 });
      assert.ok(layout.photoSize >= 40 && layout.handleWidth >= 64, JSON.stringify(layout));
    }
});

test('the Kaspi handle is a payment control only in the guarded Kaspi checkout build', () => {
  const kaspi = {
    kaspiCheckout: true,
    orderSimulator: false,
    catalogMode: 'server',
    accountMode: 'server',
  };
  assert.equal(slideToPayAvailable(kaspi), true);
  assert.equal(slideToPayAvailable({ ...kaspi, kaspiCheckout: false }), false);
  assert.equal(slideToPayAvailable({ ...kaspi, orderSimulator: true }), false);
  assert.equal(slideToPayAvailable({ ...kaspi, catalogMode: 'design' }), false);
  assert.equal(slideToPayAvailable({ ...kaspi, accountMode: 'demo' }), false);
});

test('a basket the cart would not check out opens the cart instead of checkout', () => {
  const line = { product: product('burger'), quantity: 1 };
  assert.equal(cartCheckoutBlocked({ cart: [line] }), false);
  assert.equal(cartCheckoutBlocked({ cart: [] }), true);
  assert.equal(cartCheckoutBlocked({ cart: [line], catalogUpdatePending: true }), true);
  assert.equal(
    cartCheckoutBlocked({ cart: [{ ...line, product: { ...line.product, available: false } }] }),
    true,
  );
  const gift = { selected: true, giftItemIndex: 0, discountMinor: '419000' };
  assert.equal(cartCheckoutBlocked({ cart: [line], comboRewards: gift }), false);
  assert.equal(
    cartCheckoutBlocked({ cart: [line], comboRewards: { ...gift, discountMinor: '0' } }),
    true,
  );
  assert.equal(
    cartCheckoutBlocked({ cart: [line], comboRewards: { ...gift, giftItemIndex: undefined } }),
    true,
  );
  assert.equal(
    cartCheckoutBlocked({
      cart: [line],
      comboRewards: { ...gift, selected: false, discountMinor: '0' },
    }),
    false,
  );
});

test('the bar amount equals «Оформить заказ» and the invoice, gift discount included', () => {
  let state = { cart: [], recent: [] };
  for (const id of ['pick-combo', 'burger']) state = add(state, id);
  const full = cartTotal(state.cart);
  // Store: a selected gift takes the base Pick Combo price off; otherwise the discount is '0'.
  const gift = product('pick-combo').priceMinor;
  // Cart page (M09) and KaspiCheckoutScreen (localTotal, the quote check and so the invoice).
  const checkout = (discount) => (BigInt(cartTotal(state.cart)) - BigInt(discount)).toString();
  assert.equal(payableTotalMinor(full, gift), checkout(gift));
  assert.equal(payableTotalMinor(full, gift), (BigInt(full) - BigInt(gift)).toString());
  assert.notEqual(payableTotalMinor(full, gift), full);
  assert.equal(payableTotalMinor(full, '0'), full);
  // Builds without the combo programme have no comboRewards at all.
  assert.equal(payableTotalMinor(full, undefined), full);
  // Only the gift in the basket: the bar shows 0, like «Заказать подарок».
  const only = cartTotal([{ product: product('pick-combo'), quantity: 1 }]);
  assert.equal(payableTotalMinor(only, gift), '0');
});
