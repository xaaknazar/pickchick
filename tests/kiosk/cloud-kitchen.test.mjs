// Kiosk build 13: branch in mode 'cloud' (ADR-0014). The kitchen gate (KITCHEN_OFFLINE) and the
// cloud order number (300-599). Synthetic fixture only: no network, bank or device is involved.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CommercialKioskController } from '../../apps/kiosk/src/commercial-controller.ts';
import { KioskError } from '../../apps/kiosk/src/api.ts';
import { dictionariesForTest } from '../../apps/kiosk/src/i18n.ts';
import { cart, fixture, storefront } from './commercial-fixture.mjs';

const OFFLINE_RU = 'Кухня сейчас не на связи - заказ оформить нельзя. Пригласите сотрудника.';

/** A branch in mode 'cloud': `/config` names the kitchen, availability.fresh is the gate. */
function cloud(h, state) {
  let signature = 'a'.repeat(64);
  const body = () => ({
    fresh: state.kitchen === 'online',
    products: storefront.payload.products.map((p) => ({
      productId: p.id,
      available: p.available,
      stoppedOptions: [],
    })),
  });
  const request = h.io.request;
  h.io.request = async (path, ...rest) => {
    if (path === '/availability') return body();
    const answer = await request(path, ...rest);
    return path === '/config'
      ? { ...answer, enabled: state.kitchen === 'online', kitchen: state.kitchen }
      : answer;
  };
  h.io.read = async (path) => {
    if (path.startsWith('/catalog/media')) throw new KioskError('NOT_FOUND', 404);
    return { data: body(), catalogVersion: null, signature };
  };
  return { next: () => (signature = String.fromCharCode(signature.charCodeAt(0) + 1).repeat(64)) };
}

test('KITCHEN_OFFLINE has its own text in KZ, RU and EN', () => {
  for (const [locale, strings] of Object.entries(dictionariesForTest)) {
    assert.equal(typeof strings.err_KITCHEN_OFFLINE, 'string', locale);
    assert.doesNotMatch(strings.err_KITCHEN_OFFLINE, /[–—]/, locale);
  }
  assert.equal(dictionariesForTest.ru.err_KITCHEN_OFFLINE, OFFLINE_RU);
});

test('cloud kitchen offline at start: menu visible, checkout closed, KITCHEN_OFFLINE notice', async () => {
  const h = fixture();
  const state = { kitchen: 'offline' };
  const poll = cloud(h, state);
  const c = new CommercialKioskController(h.io);
  assert.equal(await c.restore(), false);
  const view = c.getSnapshot();
  assert.equal(view.errorCode, 'KITCHEN_OFFLINE');
  assert.equal(view.error, OFFLINE_RU);
  assert.equal(view.checkoutReady, false);
  assert.ok(view.catalog.products.length > 0);
  // The kitchen screens poll again: the next long-poll is fresh, /config is read again.
  state.kitchen = 'online';
  poll.next();
  const configs = h.calls.filter((r) => r.path === '/config').length;
  assert.equal(await c.watchAvailability(), 'reloaded');
  assert.equal(h.calls.filter((r) => r.path === '/config').length, configs + 1);
  assert.equal(c.getSnapshot().errorCode, null);
  assert.equal(c.getSnapshot().checkoutReady, true);
});

test('the cloud kitchen goes offline mid-session: notice at once, checkout back after it returns', async () => {
  const h = fixture();
  const state = { kitchen: 'online' };
  const poll = cloud(h, state);
  const c = await cart(h);
  assert.equal(c.getSnapshot().checkoutReady, true);
  state.kitchen = 'offline';
  poll.next();
  assert.equal(await c.watchAvailability(), 'changed');
  assert.equal(c.getSnapshot().errorCode, 'KITCHEN_OFFLINE');
  assert.equal(c.getSnapshot().checkoutReady, false);
  // Every product shows unavailable while the gate is closed; the guest's line is kept.
  assert.equal(c.getSnapshot().unavailableCartLines.length, 1);
  state.kitchen = 'online';
  poll.next();
  assert.equal(await c.watchAvailability(), 'reloaded');
  assert.equal(c.getSnapshot().errorCode, null);
  assert.equal(c.getSnapshot().checkoutReady, true);
  assert.equal(c.getSnapshot().cart.length, 1, 'the cart survives the reload');
});

test('a KITCHEN_OFFLINE refusal of the quote shows the kitchen notice, never a payment', async () => {
  const h = fixture();
  cloud(h, { kitchen: 'online' });
  const request = h.io.request;
  h.io.request = async (path, ...rest) => {
    if (path === '/quotes') throw new KioskError('KITCHEN_OFFLINE', 503);
    return request(path, ...rest);
  };
  const c = await cart(h);
  await c.beginPayment();
  assert.equal(c.getSnapshot().errorCode, 'KITCHEN_OFFLINE');
  assert.equal(h.calls.filter((r) => r.path.endsWith('/payment')).length, 0);
});

test('mode edge keeps its answers: stale availability is still NOT_ACCEPTING', async () => {
  const h = fixture();
  const request = h.io.request;
  h.io.request = async (path, ...rest) =>
    path === '/availability'
      ? { ...(await request(path, ...rest)), fresh: false }
      : request(path, ...rest);
  const c = new CommercialKioskController(h.io);
  assert.equal(await c.restore(), false);
  assert.equal(c.getSnapshot().errorCode, 'NOT_ACCEPTING');
});

test('a paid cloud order shows its number from the server (300-599) and its kitchen status', async () => {
  const h = fixture();
  cloud(h, { kitchen: 'online' });
  const c = await cart(h);
  assert.equal(await c.beginPayment(), true);
  h.order = {
    ...h.order,
    phase: 'preparing',
    kitchenStage: 'cooking',
    displayNumber: '342',
    receipt: 'deferred',
  };
  await c.refresh();
  let view = c.getSnapshot();
  assert.equal(view.step, 'order');
  assert.equal(view.order.payment_state, 'paid');
  assert.equal(view.order.number, '342');
  assert.equal(view.recoveryRequired, false);
  h.order = { ...h.order, phase: 'ready', kitchenStage: null };
  await c.refresh();
  view = c.getSnapshot();
  assert.equal(view.order.number, '342');
  assert.equal(view.order.state, 'ready');
});
