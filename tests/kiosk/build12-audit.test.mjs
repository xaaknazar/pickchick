// Regressions for the iPad kiosk audit fixed in build 12 (commercial controller and polling).
// Synthetic fixture only: no network, bank or device is involved.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CommercialKioskController } from '../../apps/kiosk/src/commercial-controller.ts';
import { KIOSK_IDLE_MS, KIOSK_IDLE_GRACE_MS } from '../../apps/kiosk/src/controller.ts';
import { startKioskPolling } from '../../apps/kiosk/src/polling.ts';
import { KioskError } from '../../apps/kiosk/src/api.ts';
import { dictionariesForTest } from '../../apps/kiosk/src/i18n.ts';
import {
  orderScreenState,
  FAILED_HOLD,
  NUMBER_WAIT_HOLD,
  PAID_HOLD,
} from '../../apps/kiosk/src/orderScreen.ts';
import { cart, fixture, storefront } from './commercial-fixture.mjs';

const defaults = (product) =>
  product.modifier_groups.flatMap((g) =>
    g.options
      .filter((o) => o.default_quantity > 0)
      .map((o) => ({ group_id: g.id, option_id: o.id, quantity: o.default_quantity })),
  );
async function browsing(h) {
  const c = new CommercialKioskController(h.io);
  assert.equal(await c.restore(), true);
  await c.start();
  await c.setMode('takeaway');
  return c;
}
test('a background reload keeps every browsing step (mode, product, upsell, cart, review)', async () => {
  const h = fixture();
  const c = new CommercialKioskController(h.io);
  assert.equal(await c.restore(), true);
  await c.start();
  assert.equal(c.getSnapshot().step, 'mode');
  assert.equal(await c.refresh(), true);
  assert.equal(c.getSnapshot().step, 'mode');
  await c.setMode('takeaway');
  const product = c.getSnapshot().catalog.products[0];
  c.openProduct(product.id);
  assert.equal(await c.refresh(), true);
  assert.equal(c.getSnapshot().step, 'product');
  assert.equal(await c.addToCart(product.id, defaults(product)), true);
  for (const go of ['openUpsell', 'openCart', 'goLoyalty']) {
    c[go]();
    const step = c.getSnapshot().step;
    assert.equal(await c.refresh(), true);
    assert.equal(c.getSnapshot().step, step, go);
  }
});

test('the 60 s poll keeps the mode screen (fake timers, real loop)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.now() });
  const h = fixture();
  const c = new CommercialKioskController(h.io);
  assert.equal(await c.restore(), true);
  const stop = startKioskPolling(c, () => true);
  try {
    t.mock.timers.tick(61000);
    await c.start();
    for (let i = 0; i < 4; i++) {
      t.mock.timers.tick(3000);
      for (let k = 0; k < 20; k++) await Promise.resolve();
    }
    assert.equal(c.getSnapshot().step, 'mode');
  } finally {
    stop();
  }
});

test('a background reload is never busy; a guest tap during it waits and applies', async () => {
  const h = fixture();
  const c = await cart(h);
  c.openCart();
  let release;
  const held = new Promise((resolve) => (release = resolve));
  h.before = async (path) => {
    if (path === '/catalog') await held;
  };
  const busy = [];
  const off = c.subscribe(() => busy.push(c.getSnapshot().busy));
  const reload = c.refresh();
  await Promise.resolve();
  assert.equal(c.getSnapshot().busy, false);
  const line = c.getSnapshot().cart[0].lineId;
  const tap = c.updateQuantity(line, 2);
  // The guest command shows progress while it waits for the reload.
  assert.equal(c.getSnapshot().busy, true);
  h.before = async () => {};
  release();
  assert.equal(await reload, true);
  assert.equal(await tap, true);
  off();
  assert.equal(c.getSnapshot().cart[0].quantity, 2);
  assert.equal(c.getSnapshot().step, 'cart');
  assert.equal(busy.filter(Boolean).length > 0, true);
});

test('a failed background reload is silent and keeps checkout; the poll retries with back-off', async () => {
  const h = fixture();
  const c = await cart(h);
  assert.equal(c.getSnapshot().checkoutReady, true);
  h.before = async (path) => {
    if (path === '/availability') throw new KioskError('NETWORK_UNCERTAIN');
  };
  assert.equal(await c.refresh(), false);
  assert.equal(c.getSnapshot().error, null);
  assert.equal(c.getSnapshot().checkoutReady, true);
  assert.equal(c.getSnapshot().step, 'loyalty');
});

test('a stop found when paying sends the guest to the cart with a stop message', async () => {
  const h = fixture();
  const c = await cart(h);
  const id = c.getSnapshot().cart[0].productId;
  h.before = async (path) => {
    if (path === '/catalog') storefront.payload.products.find((p) => p.id === id).available = false;
  };
  try {
    assert.equal(await c.beginPayment(), false);
    assert.equal(c.getSnapshot().step, 'cart');
    assert.equal(c.getSnapshot().errorCode, 'CART_CHANGED');
    assert.equal(c.getSnapshot().unavailableCartLines.length, 1);
    assert.equal(c.getSnapshot().recoveryRequired, false);
  } finally {
    storefront.payload.products.find((p) => p.id === id).available = true;
  }
});

test('cart limits have their own message (20 per line, 11 lines) in both controllers', async () => {
  const h = fixture();
  const c = await browsing(h);
  const product = c.getSnapshot().catalog.products[0];
  assert.equal(await c.addToCart(product.id, defaults(product), 20), true);
  assert.equal(await c.addToCart(product.id, defaults(product)), false);
  assert.equal(c.getSnapshot().errorCode, 'CART_LIMIT_LINE');
  const others = c
    .getSnapshot()
    .catalog.products.filter((p) => p.id !== product.id && p.available !== false);
  let added = 1;
  for (const p of others) {
    if (added === 11) break;
    if (await c.addToCart(p.id, defaults(p))) added++;
  }
  assert.equal(c.getSnapshot().cart.length, 11);
  const extra = others[others.length - 1];
  assert.equal(
    await c.addToCart(extra.id, defaults(extra), 1),
    c.getSnapshot().cart.some((l) => l.productId === extra.id),
  );
  const fresh = others.find((p) => !c.getSnapshot().cart.some((l) => l.productId === p.id));
  if (fresh) {
    assert.equal(await c.addToCart(fresh.id, defaults(fresh)), false);
    assert.equal(c.getSnapshot().errorCode, 'CART_LIMIT_LINES');
  }
});

test('the toast follows the line that was added, also when an earlier line grows', async () => {
  const h = fixture();
  const c = await browsing(h);
  const [a, b] = c.getSnapshot().catalog.products.filter((p) => p.available !== false);
  await c.addToCart(a.id, defaults(a));
  await c.addToCart(b.id, defaults(b));
  const first = c.getSnapshot().lastAdded;
  await c.addToCart(a.id, defaults(a));
  const last = c.getSnapshot().lastAdded;
  assert.equal(last.serial, first.serial + 1);
  assert.equal(last.lineId, c.getSnapshot().cart.find((l) => l.productId === a.id).lineId);
});

test('a product opened from upsell or cart returns there after adding or closing', async () => {
  const h = fixture();
  const c = await cart(h);
  const product = c.getSnapshot().catalog.products[1];
  c.openUpsell();
  c.openProduct(product.id);
  assert.equal(c.getSnapshot().step, 'product');
  assert.equal(await c.addToCart(product.id, defaults(product)), true);
  assert.equal(c.getSnapshot().step, 'upsell');
  c.openCart();
  c.openProduct(product.id);
  c.closeProduct();
  assert.equal(c.getSnapshot().step, 'cart');
  c.goMenu();
  c.openProduct(product.id);
  c.closeProduct();
  assert.equal(c.getSnapshot().step, 'menu');
});

test('any touch during the idle countdown closes it (the snapshot updates)', async () => {
  const h = fixture();
  const c = await browsing(h);
  h.clock += KIOSK_IDLE_MS + 3000;
  await c.tick();
  assert.equal(c.getSnapshot().idleWarningSeconds, 12);
  c.touch();
  assert.equal(c.getSnapshot().idleWarningSeconds, null);
});

test('idle reset without WAN shows the start screen; the reset completes when WAN returns', async () => {
  const h = fixture();
  const c = await cart(h);
  h.endFail = true;
  h.clock += KIOSK_IDLE_MS + KIOSK_IDLE_GRACE_MS + 1;
  await c.tick();
  assert.equal(c.getSnapshot().step, 'start');
  assert.equal(c.getSnapshot().recoveryRequired, false);
  assert.equal(c.getSnapshot().cart.length, 0);
  assert.equal(JSON.parse(h.rawFlow).cart.length, 0);
  assert.equal(c.getSnapshot().syncPending, true);
  // A restart while still offline keeps the kiosk ready on the start screen.
  const relaunched = new CommercialKioskController(h.io);
  assert.equal(await relaunched.restore(), false);
  assert.equal(relaunched.getSnapshot().ready, true);
  assert.equal(relaunched.getSnapshot().step, 'start');
  h.endFail = false;
  assert.equal(await relaunched.refresh(), true);
  assert.equal(relaunched.getSnapshot().syncPending, false);
  assert.equal(JSON.parse(h.rawFlow).resetPending, false);
  assert.equal(await relaunched.start(), true);
  assert.equal(relaunched.getSnapshot().step, 'mode');
});

for (const code of ['EXPIRED', 'RESTAURANT_CLOSED', 'NOT_FOUND'])
  test(`/orders ${code} (no order exists) returns the guest to the review`, async () => {
    const h = fixture();
    const c = await cart(h);
    h.before = async (path) => {
      if (path === '/orders') throw new KioskError(code, code === 'NOT_FOUND' ? 404 : 409);
    };
    assert.equal(await c.beginPayment(), false);
    assert.equal(JSON.parse(h.rawFlow).intent, null);
    assert.equal(c.getSnapshot().step, 'loyalty');
    assert.equal(c.getSnapshot().recoveryRequired, false);
    assert.equal(
      c.getSnapshot().errorCode,
      code === 'RESTAURANT_CLOSED' ? 'NOT_ACCEPTING' : 'RETRY_PAYMENT',
    );
    h.before = async () => {};
    assert.equal(await c.beginPayment(), true);
  });

test('/orders FORBIDDEN may hide an existing order and keeps recovery', async () => {
  const h = fixture();
  const c = await cart(h);
  h.before = async (path) => {
    if (path === '/orders') throw new KioskError('FORBIDDEN', 403);
  };
  assert.equal(await c.beginPayment(), false);
  assert(JSON.parse(h.rawFlow).intent);
  assert.equal(c.getSnapshot().step, 'recovery');
});

test('/quotes FORBIDDEN drops the intent and the refused guest; the next payment uses a new one', async () => {
  const h = fixture();
  const c = await cart(h);
  const before = JSON.parse(h.rawSession).sessionId;
  h.before = async (path) => {
    if (path === '/quotes') throw new KioskError('FORBIDDEN', 403);
  };
  assert.equal(await c.beginPayment(), false);
  assert.equal(JSON.parse(h.rawFlow).intent, null);
  assert.equal(c.getSnapshot().step, 'loyalty');
  assert.equal(c.getSnapshot().errorCode, 'RETRY_PAYMENT');
  assert.equal(h.rawSession, null);
  h.before = async () => {};
  assert.equal(await c.beginPayment(), true);
  assert.notEqual(JSON.parse(h.rawSession).sessionId, before);
});

test('/payment refused before any attempt frees the kiosk and keeps the cart under a new guest', async () => {
  const h = fixture();
  const c = await cart(h);
  const before = JSON.parse(h.rawSession).sessionId;
  h.before = async (path) => {
    if (path.endsWith('/payment')) throw new KioskError('ITEM_STOPPED', 409);
  };
  assert.equal(await c.beginPayment(), false);
  const flow = JSON.parse(h.rawFlow);
  assert.equal(flow.intent, null);
  assert.equal(flow.order, null);
  assert.equal(flow.cart.length, 1);
  assert.equal(c.getSnapshot().step, 'cart');
  assert.equal(c.getSnapshot().errorCode, 'CART_CHANGED');
  assert.equal(c.getSnapshot().recoveryRequired, false);
  h.before = async () => {};
  h.order = null;
  c.goLoyalty();
  assert.equal(await c.beginPayment(), true);
  assert.notEqual(JSON.parse(h.rawSession).sessionId, before);
});

test('a missed QR status read keeps the payment screen with a soft connection notice', async () => {
  const h = fixture();
  const c = await cart(h);
  assert.equal(await c.beginPayment(), true);
  assert.equal(c.getSnapshot().step, 'payment');
  const orderId = c.getSnapshot().order.order_id;
  h.before = async (path) => {
    if (path === `/orders/${orderId}`) throw new KioskError('NETWORK_UNCERTAIN');
  };
  assert.equal(await c.refresh(), false);
  assert.equal(c.getSnapshot().step, 'payment');
  assert.equal(c.getSnapshot().errorCode, 'CONNECTION');
  h.before = async () => {};
  assert.equal(await c.refresh(), true);
  assert.equal(c.getSnapshot().error, null);
  assert.equal(c.getSnapshot().step, 'payment');
});

test('a guest the server forgot (403) is replaced without an order or intent', async () => {
  const h = fixture();
  const original = await cart(h);
  const stale = JSON.parse(h.rawSession).token;
  const request = h.io.request;
  h.io.request = async (path, token, ...rest) => {
    if (token === stale && path !== '/sessions') {
      h.calls.push({ path, token });
      throw new KioskError('FORBIDDEN', 403);
    }
    return request(path, token, ...rest);
  };
  const c = new CommercialKioskController(h.io);
  assert.equal(await c.restore(), true);
  assert(c.getSnapshot().catalog);
  assert.notEqual(JSON.parse(h.rawSession).token, stale);
  assert.equal(c.getSnapshot().cart.length, original.getSnapshot().cart.length);
});

test('stale then fresh availability gives checkout back without a reload', async () => {
  const h = fixture();
  let fresh = false;
  let signature = 'a'.repeat(64);
  const body = () => ({
    fresh,
    products: storefront.payload.products.map((p) => ({
      productId: p.id,
      available: p.available,
      stoppedOptions: [],
    })),
  });
  const request = h.io.request;
  h.io.request = async (path, ...rest) =>
    path === '/availability' ? body() : request(path, ...rest);
  h.io.read = async (path) => {
    if (path.startsWith('/catalog/media')) throw new KioskError('NOT_FOUND', 404);
    return { data: body(), catalogVersion: null, signature };
  };
  const c = new CommercialKioskController(h.io);
  assert.equal(await c.restore(), false);
  assert.equal(c.getSnapshot().errorCode, 'NOT_ACCEPTING');
  assert.equal(c.getSnapshot().checkoutReady, false);
  assert.equal(c.getSnapshot().menuUpdating, true);
  fresh = true;
  signature = 'b'.repeat(64);
  assert.equal(await c.watchAvailability(), 'changed');
  assert.equal(c.getSnapshot().error, null);
  assert.equal(c.getSnapshot().checkoutReady, true);
  assert.equal(c.getSnapshot().menuUpdating, false);
});

test('every guest error code has a text in KZ, RU and EN', () => {
  const codes = [
    'PRICE_CHANGED',
    'CART_CHANGED',
    'NOT_ACCEPTING',
    'DEVICE',
    'PHONE',
    'CART_LIMIT_LINE',
    'CART_LIMIT_LINES',
    'RETRY_PAYMENT',
    'PAYMENT_UNKNOWN',
    'MENU_LOAD',
    'NETWORK',
    'CONNECTION',
    'OFFLINE',
  ];
  for (const [locale, strings] of Object.entries(dictionariesForTest))
    for (const code of codes) {
      const key = 'err_' + code;
      assert.equal(typeof strings[key], 'string', `${locale} ${key}`);
      assert.doesNotMatch(strings[key], /[–—]/, `${locale} ${key}`);
    }
});

test('K4: a paid order without a display number is final; the next guest is allowed', async () => {
  const h = fixture();
  const c = await cart(h);
  assert.equal(await c.beginPayment(), true);
  assert.equal(c.getSnapshot().order.payment_state, 'pending');
  // While the payment is open the guest cannot be reset.
  assert.equal(await c.newGuest(), false);
  // Paid, but the kitchen number has not arrived yet (edge or bridge without WAN).
  h.order = { ...h.order, phase: 'paid', displayNumber: null, receipt: 'pending' };
  await c.refresh();
  const paid = c.getSnapshot();
  assert.equal(paid.step, 'order');
  assert.equal(paid.order.payment_state, 'paid');
  assert.equal(paid.order.number, '-');
  // Financially final: no recovery, nothing blocks the next guest.
  assert.equal(paid.recoveryRequired, false);
  const orders = h.calls.filter((r) => r.path === '/orders').length;
  const payments = h.calls.filter((r) => r.path.endsWith('/payment')).length;
  assert.equal(await c.newGuest(), true);
  assert.equal(c.getSnapshot().step, 'start');
  assert.equal(c.getSnapshot().order, null);
  assert.equal(JSON.parse(h.rawFlow).order, null);
  assert.equal(JSON.parse(h.rawFlow).resetPending, false);
  // Leaving never re-submits the order or the payment.
  assert.equal(h.calls.filter((r) => r.path === '/orders').length, orders);
  assert.equal(h.calls.filter((r) => r.path.endsWith('/payment')).length, payments);
});

test('cart "edit" opens the line with its choice and saving replaces it in place', async () => {
  const h = fixture();
  const c = await browsing(h);
  const [first, second] = c
    .getSnapshot()
    .catalog.products.filter((p) =>
      p.modifier_groups.some((g) => g.options.length > 1 && g.max === 1 && g.min === 1),
    );
  assert.equal(await c.addToCart(first.id, defaults(first)), true);
  assert.equal(await c.addToCart(second.id, defaults(second), 2), true);
  c.openCart();
  const line = c.getSnapshot().cart[1];
  const serial = c.getSnapshot().lastAdded.serial;
  c.editLine(line.lineId);
  let view = c.getSnapshot();
  assert.equal(view.step, 'product');
  assert.equal(view.selectedProduct.id, second.id);
  assert.deepEqual(view.editingLine.selections, line.selections);
  assert.equal(view.editingLine.quantity, 2);
  // Another choice in the single-choice group, saved with quantity 3.
  const group = second.modifier_groups.find(
    (g) => g.options.length > 1 && g.max === 1 && g.min === 1,
  );
  const chosen = line.selections.find((s) => s.group_id === group.id).option_id;
  const other = group.options.find((o) => o.id !== chosen && o.available);
  const next = [
    ...line.selections.filter((s) => s.group_id !== group.id),
    { group_id: group.id, option_id: other.id, quantity: 1 },
  ];
  assert.equal(await c.addToCart(second.id, next, 3, line.lineId), true);
  view = c.getSnapshot();
  assert.equal(view.step, 'cart');
  assert.equal(view.editingLine, null);
  assert.equal(view.cart.length, 2);
  assert.equal(view.cart[1].productId, second.id);
  assert.equal(view.cart[1].quantity, 3);
  assert.equal(view.cart[1].selections.find((s) => s.group_id === group.id).option_id, other.id);
  // An edit is not a new add: no "added" toast in the menu.
  assert.equal(view.lastAdded.serial, serial);
  // A line keeps its product; saving the original choice back replaces it again.
  c.editLine(view.cart[1].lineId);
  assert.equal(
    await c.addToCart(first.id, defaults(first), 1, view.cart[1].lineId),
    false,
    'a line cannot be swapped for another product',
  );
  assert.equal(await c.addToCart(second.id, defaults(second), 1, view.cart[1].lineId), true);
  view = c.getSnapshot();
  assert.equal(view.cart.length, 2);
  assert.equal(view.cart[1].quantity, 1);
  // Closing without saving keeps the line and forgets the edit.
  c.editLine(view.cart[0].lineId);
  c.closeProduct();
  assert.equal(c.getSnapshot().editingLine, null);
  assert.equal(c.getSnapshot().step, 'cart');
});

test('payment result unknown (incident): "Отменить" and the 30 s auto-reset take the same safe path', async () => {
  const h = fixture();
  const c = await cart(h);
  assert.equal(await c.beginPayment(), true);
  // A manager-accepted incident: the order failed on the device side while the QR payment is
  // still being reconciled.
  h.order = {
    ...h.order,
    phase: 'failed',
    payment: { kind: 'kaspi_qr', state: 'pending', qrPayload: null, expiresAt: null },
  };
  await c.refresh();
  const view = c.getSnapshot();
  const screen = orderScreenState(view);
  assert.equal(view.step, 'order');
  assert.equal(screen.incident, true);
  assert.equal(screen.cancel, true, 'the incident screen shows "Отменить"');
  assert.equal(screen.hold, FAILED_HOLD);
  assert.equal(FAILED_HOLD, 30);
  // A plain decline (QR payment failed) is not an incident: no cancel, the usual next guest.
  assert.equal(
    orderScreenState({ ...view, qrPayment: { ...view.qrPayment, state: 'failed' } }).cancel,
    false,
  );
  const before = h.calls.length;
  // "Отменить" calls the same newGuest() the auto-reset calls: the kiosk only forgets the
  // guest locally; it sends nothing that could mark the payment paid or failed.
  assert.equal(await c.newGuest(), true);
  assert.equal(c.getSnapshot().step, 'start');
  assert.equal(c.getSnapshot().order, null);
  assert.deepEqual(
    h.calls.slice(before).map((r) => r.path),
    ['/sessions/end'],
  );
  for (const { locale, text } of [
    { locale: 'ru', text: 'Отменить' },
    { locale: 'kk', text: 'Бас тарту' },
    { locale: 'en', text: 'Cancel' },
  ])
    assert.equal(dictionariesForTest[locale].cancel, text);
});

test('paid without a number waits two minutes with polling; the number shows as soon as it arrives', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.now() });
  const h = fixture();
  const c = await cart(h);
  assert.equal(await c.beginPayment(), true);
  h.order = { ...h.order, phase: 'paid', displayNumber: null };
  await c.refresh();
  let screen = orderScreenState(c.getSnapshot());
  assert.equal(screen.waitingForNumber, true);
  assert.equal(screen.canReset, true);
  assert.equal(screen.hold, NUMBER_WAIT_HOLD);
  assert.equal(NUMBER_WAIT_HOLD, 120);
  const texts = dictionariesForTest;
  assert.equal(texts.ru.paidNumberPending, 'Оплачено, номер появится на табло');
  assert.ok(texts.kk.paidNumberPending && texts.en.paidNumberPending);
  // The background poll keeps reading the order; the number arrives from the kitchen.
  const stop = startKioskPolling(c, () => true);
  try {
    h.order = { ...h.order, displayNumber: '27', phase: 'preparing', kitchenStage: 'cooking' };
    for (let i = 0; i < 6; i++) {
      t.mock.timers.tick(3000);
      for (let k = 0; k < 20; k++) await Promise.resolve();
    }
  } finally {
    stop();
  }
  const view = c.getSnapshot();
  assert.equal(view.step, 'order');
  assert.equal(view.order.number, '27');
  screen = orderScreenState(view);
  assert.equal(screen.waitingForNumber, false);
  // With the number on screen the usual 40 s hold applies.
  assert.equal(screen.hold, PAID_HOLD);
});
