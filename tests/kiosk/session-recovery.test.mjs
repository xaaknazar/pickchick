// Release audit 19.10.2026, kiosk findings 3.0, 3.1 and 3.7: a kiosk must never stay stuck on
// «Восстанавливаем заказ» or on the start screen because a guest session expired, could not be
// ended or was given up after a refused payment. Synthetic fixtures only: no network or bank.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CommercialKioskController,
  MAX_ABANDONED_GUESTS,
  SESSION_RENEW_MS,
} from '../../apps/kiosk/src/commercial-controller.ts';
import { KioskError } from '../../apps/kiosk/src/api.ts';
import { cart, fixture } from './commercial-fixture.mjs';

const MINUTE = 60000;
const stored = (h) => JSON.parse(h.rawFlow);
const token = (h) => (h.rawSession ? JSON.parse(h.rawSession).token : null);

/**
 * The shared fixture with a real guest TTL (`ttl`), the server's answer to POST /orders for an
 * expired guest without an order (`expiredOrder`: FORBIDDEN before 19.10, NOT_FOUND after) and a
 * scripted /sessions/end per token (`endAnswer(token)`: 'ok' | 'CONFLICT' | 'NETWORK').
 */
function sessionFixture({ ttl = 60 * MINUTE, expiredOrder = 'FORBIDDEN' } = {}) {
  const h = fixture();
  const base = h.io.request;
  h.expiry = new Map();
  h.ended = [];
  h.endAnswer = () => 'ok';
  h.io.request = async (path, tok, body, key) => {
    if (path === '/sessions') {
      const answer = await base(path, tok, body, key);
      const expiresAt = new Date(h.clock + ttl).toISOString();
      h.expiry.set(body.token, Date.parse(expiresAt));
      return { ...answer, expiresAt };
    }
    if (path === '/sessions/end') {
      h.calls.push({ path, token: tok, body, key });
      const answer = h.endAnswer(tok);
      if (answer === 'CONFLICT') throw new KioskError('CONFLICT', 409);
      if (answer === 'NETWORK') throw new KioskError('NETWORK_UNCERTAIN');
      h.ended.push(tok);
      return { ended: true };
    }
    if (path === '/orders' && h.clock >= (h.expiry.get(tok) ?? Infinity) && !h.order) {
      h.calls.push({ path, token: tok, body, key });
      // KioskCheckout.createLocked: no order exists for this guest and it has expired.
      if (expiredOrder === 'NOT_FOUND') throw new KioskError('NOT_FOUND', 404);
      throw new KioskError('FORBIDDEN', 403);
    }
    return base(path, tok, body, key);
  };
  return h;
}
const ordersCalls = (h) => h.calls.filter((r) => r.path === '/orders').length;

for (const expiredOrder of ['FORBIDDEN', 'NOT_FOUND'])
  test(`3.0: a POST /orders retried after the guest expired never loops (server answers ${expiredOrder})`, async () => {
    const h = sessionFixture({ expiredOrder });
    const c = await cart(h);
    const first = token(h);
    // The quote is saved, then POST /orders never reaches the server (Wi-Fi drop, timeout).
    h.failPath = '/orders';
    assert.equal(await c.beginPayment(), false);
    h.order = null;
    assert.ok(stored(h).intent.quoteId);
    assert.equal(c.getSnapshot().step, 'recovery');
    // The network comes back only after the guest TTL.
    h.clock += 61 * MINUTE;
    assert.equal(await c.recover(), false);
    // No order exists and no money moved: the intent is dropped and the guest may pay again.
    assert.equal(stored(h).intent, null);
    assert.equal(c.getSnapshot().recoveryRequired, false);
    assert.notEqual(c.getSnapshot().step, 'recovery');
    assert.equal(c.getSnapshot().errorCode, 'RETRY_PAYMENT');
    assert.equal(stored(h).cart.length, 1);
    // The next attempt runs under a new guest session and creates the order.
    const before = ordersCalls(h);
    assert.equal(await c.beginPayment(), true);
    assert.notEqual(token(h), first);
    assert.equal(ordersCalls(h), before + 1);
    assert.equal(c.getSnapshot().step, 'payment');
  });

test('3.0: an app restart in the expired-order state recovers instead of looping', async () => {
  const h = sessionFixture();
  const c = await cart(h);
  h.failPath = '/orders';
  assert.equal(await c.beginPayment(), false);
  h.order = null;
  h.clock += 61 * MINUTE;
  const relaunched = new CommercialKioskController(h.io);
  await relaunched.restore();
  assert.equal(stored(h).intent, null);
  assert.equal(relaunched.getSnapshot().recoveryRequired, false);
  assert.equal(relaunched.getSnapshot().errorCode, 'RETRY_PAYMENT');
  assert.equal(await relaunched.beginPayment(), true);
  assert.equal(relaunched.getSnapshot().step, 'payment');
});

test('3.0: a guest close to its expiry is renewed before the payment starts', async () => {
  const h = sessionFixture();
  const c = await cart(h);
  const old = token(h);
  // The guest session was allocated right after the previous guest and has 10 minutes left.
  h.clock += 50 * MINUTE;
  assert.ok(60 * MINUTE - 50 * MINUTE < SESSION_RENEW_MS);
  assert.equal(await c.beginPayment(), true);
  const renewed = token(h);
  assert.notEqual(renewed, old);
  // The old guest is ended before the new one is used; the quote and order use the new one.
  assert.deepEqual(h.ended, [old]);
  const quote = h.calls.find((r) => r.path === '/quotes');
  const order = h.calls.find((r) => r.path === '/orders');
  assert.equal(quote.token, renewed);
  assert.equal(order.token, renewed);
  assert.equal(c.getSnapshot().step, 'payment');
});

test('3.0: a failed early renewal keeps the still valid guest instead of blocking the payment', async () => {
  const h = sessionFixture();
  const c = await cart(h);
  const old = token(h);
  h.clock += 50 * MINUTE;
  h.endAnswer = () => 'NETWORK';
  assert.equal(await c.beginPayment(), true);
  assert.equal(token(h), old);
  assert.equal(c.getSnapshot().step, 'payment');
});

/**
 * Review 19.10, finding 3.0 (phone invoice variant): the order exists, its first
 * POST /orders/:id/payment never reached the server and the guest expired meanwhile. The server
 * refuses an invoice for an expired guest (KioskCheckout.payLocked -> assertActive: FORBIDDEN) but
 * still lets that guest read its order. `read` scripts GET /orders/:id after the expiry.
 */
async function expiredInvoice({ read = 'order' } = {}) {
  const h = sessionFixture();
  h.paymentMethods = ['kaspi_qr', 'kaspi_invoice'];
  const c = await cart(h);
  c.setPaymentMethod('kaspi_invoice');
  c.setInvoicePhone('8 (701) 123-45-67');
  const base = h.io.request;
  const guest = token(h);
  let expired = false;
  h.io.request = async (path, tok, body, key) => {
    if (tok === guest && path.endsWith('/payment')) {
      h.calls.push({ path, token: tok, body, key });
      // Lost before it reached the server: no attempt exists.
      if (!expired) throw new KioskError('NETWORK_UNCERTAIN');
      throw new KioskError('FORBIDDEN', 403);
    }
    if (tok === guest && expired && path.startsWith('/orders/')) {
      h.calls.push({ path, token: tok, body, key });
      if (read === 'refused') throw new KioskError('FORBIDDEN', 403);
      if (read === 'attempt')
        return { ...h.order, phase: 'sending', paymentMethod: 'kaspi_invoice' };
    }
    return base(path, tok, body, key);
  };
  assert.equal(await c.beginPayment(), false);
  const intent = stored(h).intent;
  assert.ok(intent.orderId);
  assert.equal(c.getSnapshot().step, 'recovery');
  h.clock += 61 * MINUTE;
  expired = true;
  return { h, c, intent, guest };
}

test('3.0: a phone invoice whose guest expired before its payment reached the server never loops', async () => {
  const { h, c, guest } = await expiredInvoice();
  assert.equal(await c.recover(), false);
  // The order was read: no attempt, nothing captured, and no invoice can start for an expired
  // guest any more. The unpaid order is given up like a refused first payment (finding 3.7).
  assert.equal(stored(h).intent, null);
  assert.equal(stored(h).order, null);
  assert.equal(c.getSnapshot().recoveryRequired, false);
  assert.equal(c.getSnapshot().errorCode, 'RETRY_PAYMENT');
  assert.equal(stored(h).cart.length, 1);
  assert.deepEqual(
    stored(h).abandoned.map((a) => a.token),
    [guest],
  );
  // The guest pays again under a new session and a new order.
  h.order = null;
  c.setPaymentMethod('kaspi_invoice');
  c.setInvoicePhone('8 (701) 123-45-67');
  assert.equal(await c.beginPayment(), true);
  assert.notEqual(token(h), guest);
  assert.equal(c.getSnapshot().step, 'payment');
});

for (const read of ['refused', 'attempt'])
  test(`3.0: a refused invoice payment keeps its recovery when the order read is ${read}`, async () => {
    // 'refused': an ended guest or a disabled device; 'attempt': a payment may exist.
    const { h, c, intent } = await expiredInvoice({ read });
    assert.equal(await c.recover(), false);
    assert.deepEqual(stored(h).intent, intent);
    assert.equal(c.getSnapshot().step, 'recovery');
    assert.equal(c.getSnapshot().staffResetAvailable, false);
  });

/** A paid guest on the order screen; the kitchen then cancels the order (end -> CONFLICT). */
async function paidGuest(h) {
  const c = await cart(h);
  assert.equal(await c.beginPayment(), true);
  h.order = { ...h.order, phase: 'paid', displayNumber: '41' };
  assert.equal(await c.refresh(), true);
  assert.equal(c.getSnapshot().step, 'order');
  return c;
}

test('3.1: CONFLICT on /sessions/end after a paid order never gates the next guest', async () => {
  const h = sessionFixture();
  const c = await paidGuest(h);
  const paidToken = token(h);
  h.endAnswer = (tok) => (tok === paidToken ? 'CONFLICT' : 'ok');
  assert.equal(await c.newGuest(), true);
  const mark = h.calls.length;
  const view = c.getSnapshot();
  assert.equal(view.step, 'start');
  assert.equal(view.syncPending, false);
  assert.equal(view.error, null);
  assert.notEqual(view.errorCode, 'CART_CHANGED');
  // The old guest is ended in the background; its token is never used for anything else.
  assert.deepEqual(
    stored(h).abandoned.map((a) => a.token),
    [paidToken],
  );
  assert.equal(stored(h).resetPending, false);
  // The next guest starts at once under a new session.
  h.order = null;
  assert.equal(await c.start(), true);
  assert.equal(c.getSnapshot().step, 'mode');
  assert.equal(await c.setMode('takeaway'), true);
  assert.equal(await c.refresh(), true);
  assert.notEqual(token(h), paidToken);
  // Once the server allows it (refund settled), the background retry ends the old guest.
  h.endAnswer = () => 'ok';
  h.clock += 60000;
  await c.endAbandoned();
  await c.tick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(h.ended.includes(paidToken));
  assert.equal(stored(h).abandoned, undefined);
  // Only /sessions/end ever used the old token after the reset.
  assert.ok(
    h.calls
      .slice(mark)
      .filter((r) => r.token === paidToken)
      .every((r) => r.path === '/sessions/end'),
  );
});

test('3.1: an app restart with a pending reset refused by CONFLICT reaches a usable start screen', async () => {
  const h = sessionFixture();
  const c = await paidGuest(h);
  const paidToken = token(h);
  h.endAnswer = (tok) => (tok === paidToken ? 'NETWORK' : 'ok');
  // Offline first: the reset stays pending, as before (OFFLINE notice, retried in the background).
  assert.equal(await c.newGuest(), false);
  assert.equal(stored(h).resetPending, true);
  assert.equal(c.getSnapshot().errorCode, 'OFFLINE');
  // Back online, the server refuses: the guest moves to the background list.
  h.endAnswer = (tok) => (tok === paidToken ? 'CONFLICT' : 'ok');
  const relaunched = new CommercialKioskController(h.io);
  await relaunched.restore();
  assert.equal(relaunched.getSnapshot().syncPending, false);
  assert.notEqual(relaunched.getSnapshot().errorCode, 'CART_CHANGED');
  assert.equal(await relaunched.start(), true);
  assert.equal(relaunched.getSnapshot().step, 'mode');
});

test('3.1: with no room left for another background guest a refusal shows a neutral staff notice', async () => {
  const h = sessionFixture();
  await paidGuest(h);
  const paidToken = token(h);
  // Fill the background list with guests the server still refuses to end.
  const flow = stored(h);
  flow.abandoned = Array.from({ length: MAX_ABANDONED_GUESTS }, (_, i) => ({
    sessionId: `0000000${i}-0000-4000-8000-000000000000`,
    token: String(i).repeat(64),
    expiresAt: new Date(h.clock + 30 * MINUTE).toISOString(),
  }));
  h.rawFlow = JSON.stringify(flow);
  h.endAnswer = () => 'CONFLICT';
  const relaunched = new CommercialKioskController(h.io);
  await relaunched.restore();
  assert.equal(await relaunched.newGuest(), false);
  const view = relaunched.getSnapshot();
  assert.equal(view.step, 'start');
  assert.equal(view.errorCode, 'STAFF');
  assert.notEqual(view.errorCode, 'CART_CHANGED');
  assert.match(view.error, /сотрудника/);
  assert.equal(token(h), paidToken);
});

test('3.7: a guest given up after a refused payment is ended and counted, never leaked', async () => {
  const h = sessionFixture();
  const c = await cart(h);
  const base = h.io.request;
  h.io.request = async (path, tok, body, key) => {
    // The first payment attempt is refused before any attempt exists (stop since the review).
    if (path.endsWith('/payment')) {
      h.calls.push({ path, token: tok, body, key });
      throw new KioskError('ITEM_STOPPED', 409);
    }
    return base(path, tok, body, key);
  };
  const refused = token(h);
  assert.equal(await c.beginPayment(), false);
  assert.equal(c.getSnapshot().step, 'cart');
  assert.equal(stored(h).order, null);
  // The abandoned unpaid guest is remembered so its session is ended, not left until its TTL.
  assert.deepEqual(
    stored(h).abandoned.map((a) => a.token),
    [refused],
  );
  await c.endAbandoned();
  assert.ok(h.ended.includes(refused));
});

// QA 20.10 (release-fixes-1019), audit S15 (3.0) x S11 (1.1) x S16 (3.1): the guest pays the QR and
// walks away, the guest session expires, then the cashier refuses the paid order. The kiosk is not
// held, the refused guest goes to the background list, the next guest starts under a new session,
// and the expired token is never used for anything but /sessions/end.
test('QA S15: a guest session that expires while the cashier refuses the paid order', async () => {
  const h = sessionFixture({ ttl: 20 * MINUTE, expiredOrder: 'NOT_FOUND' });
  const c = await cart(h);
  assert.equal(await c.beginPayment(), true);
  const qr = (state) => ({
    kind: 'kaspi_qr',
    state,
    qrPayload: null,
    expiresAt: new Date(h.clock + 3 * MINUTE).toISOString(),
  });
  // Paid; the cashier has not admitted it yet (no number), the guest leaves.
  h.order = { ...h.order, phase: 'paid', displayNumber: null, payment: qr('paid') };
  assert.equal(await c.refresh(), true);
  assert.equal(c.getSnapshot().step, 'order');
  assert.equal(c.getSnapshot().recoveryRequired, false);
  const paidToken = token(h);
  h.clock += 21 * MINUTE;
  // The cashier refused it: the server shows installed builds 'failed' with a paid QR.
  h.order = { ...h.order, phase: 'failed', payment: qr('paid') };
  await c.refresh();
  const shown = c.getSnapshot();
  // Paid is already final for the kiosk (number «-», staff-help copy if it reads again); either
  // way the device is not held: no recovery, the money stays a manager case on the server.
  assert.ok(['paid', 'failed'].includes(shown.order.state), shown.order.state);
  assert.equal(shown.qrPayment.state, 'paid');
  assert.equal(shown.recoveryRequired, false);
  // The refused paid order is unresolved on the server: ending the guest answers CONFLICT.
  h.endAnswer = (tok) => (tok === paidToken ? 'CONFLICT' : 'ok');
  const mark = h.calls.length;
  assert.equal(await c.newGuest(), true);
  assert.equal(c.getSnapshot().step, 'start');
  assert.notEqual(c.getSnapshot().errorCode, 'CART_CHANGED');
  h.order = null;
  assert.equal(await c.start(), true);
  assert.equal(c.getSnapshot().step, 'mode');
  assert.notEqual(token(h), paidToken);
  // Its expiry has passed: the background list drops it without another request.
  await c.endAbandoned();
  assert.equal(stored(h).abandoned, undefined);
  assert.ok(
    h.calls
      .slice(mark)
      .filter((r) => r.token === paidToken)
      .every((r) => r.path === '/sessions/end'),
  );
  // The next guest pays normally under its own session.
  await c.setMode('takeaway');
  const product = c.getSnapshot().catalog.products[0];
  const selections = product.modifier_groups.flatMap((g) =>
    g.options
      .filter((o) => o.default_quantity > 0)
      .map((o) => ({ group_id: g.id, option_id: o.id, quantity: o.default_quantity })),
  );
  assert.equal(await c.addToCart(product.id, selections), true);
  c.goLoyalty();
  assert.equal(await c.beginPayment(), true);
  assert.equal(c.getSnapshot().step, 'payment');
});
