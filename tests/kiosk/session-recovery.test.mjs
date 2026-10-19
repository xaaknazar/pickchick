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
