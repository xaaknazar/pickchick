// Release audit 19.10.2026, kiosk findings 3.3, 3.4 and 3.0 (service exit): staff actions on the
// iPad need the staff code, checked by the server (POST /staff/verify). Synthetic fixtures only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  CommercialKioskController,
  FREE_RESTART_MS,
  MAX_ABANDONED_GUESTS,
  STAFF_PIN_ATTEMPTS,
  STAFF_PIN_LOCK_MS,
} from '../../apps/kiosk/src/commercial-controller.ts';
import { KioskError } from '../../apps/kiosk/src/api.ts';
import { createDemoKiosk, demoIdleExpired, DEMO_IDLE_EXIT_MS } from '../../apps/kiosk/src/demo.ts';
import { cart, fixture } from './commercial-fixture.mjs';

const PIN = '4829';
const QR = 'https://qr.kaspi.kz/fixture';
const stored = (h) => JSON.parse(h.rawFlow);
const currentToken = (h) => (h.rawSession ? JSON.parse(h.rawSession).token : null);

/** The shared fixture with the server staff check and abandoned guests that end at once. */
function staffFixture({ verify = true } = {}) {
  const h = fixture();
  const base = h.io.request;
  h.staffCalls = [];
  h.staffAnswer = null;
  h.io.request = async (path, token, body, key) => {
    if (path === '/sessions/end' && token && token !== currentToken(h)) return { ended: true };
    return base(path, token, body, key);
  };
  if (verify)
    h.io.verifyStaff = async (pin) => {
      h.staffCalls.push(pin);
      if (h.staffAnswer) throw h.staffAnswer;
      if (pin !== PIN) throw new KioskError('UNAUTHORIZED', 401);
    };
  return h;
}
/** A guest at the Kaspi QR (shown now). */
async function atQr(h) {
  const c = await cart(h);
  assert.equal(await c.beginPayment(), true);
  h.order = {
    ...h.order,
    payment: {
      kind: 'kaspi_qr',
      state: 'pending',
      qrPayload: QR,
      expiresAt: new Date(h.clock + 180000).toISOString(),
    },
  };
  assert.equal(await c.refresh(), true);
  assert.equal(c.getSnapshot().step, 'payment');
  return c;
}

test('3.3: «Начать заново» is free only in the first seconds of the QR, then needs the staff code', async () => {
  const h = staffFixture();
  const c = await atQr(h);
  assert.equal(c.getSnapshot().canStartOver, true);
  assert.equal(c.getSnapshot().startOverNeedsStaff, false);
  h.clock += FREE_RESTART_MS;
  await c.tick();
  // The audit scenario: the guest scanned the QR and is confirming in Kaspi (still 'pending').
  const view = c.getSnapshot();
  assert.equal(view.canStartOver, true);
  assert.equal(view.startOverNeedsStaff, true);
  const order = view.order;
  for (const pin of [undefined, '12', '1111']) {
    assert.equal(await c.startOver(pin), false, String(pin));
    assert.equal(c.getSnapshot().staffPinError, 'wrong');
    assert.deepEqual(c.getSnapshot().order, order);
    assert.equal(c.getSnapshot().step, 'payment');
    // A refused code is never a guest notice.
    assert.equal(c.getSnapshot().error, null);
  }
  // Format errors are not sent to the server.
  assert.deepEqual(h.staffCalls, ['1111']);
  assert.equal(await c.startOver(PIN), true);
  assert.equal(c.getSnapshot().step, 'start');
  assert.equal(c.getSnapshot().staffPinError, null);
  assert.equal(stored(h).order, null);
});

test('3.3: a QR restored after an app restart counts as shown long ago', async () => {
  const h = staffFixture();
  await atQr(h);
  const relaunched = new CommercialKioskController(h.io);
  await relaunched.restore();
  assert.equal(relaunched.getSnapshot().step, 'payment');
  assert.equal(relaunched.getSnapshot().startOverNeedsStaff, true);
});

test('3.3: never during «Проверяем оплату»: an expired QR or a checking payment cannot start over', async () => {
  const h = staffFixture();
  const c = await atQr(h);
  h.clock += 180000;
  await c.tick();
  assert.equal(c.getSnapshot().canStartOver, false);
  assert.equal(await c.startOver(PIN), false);
  assert.equal(c.getSnapshot().step, 'payment');
  h.order = { ...h.order, payment: { ...h.order.payment, state: 'checking', qrPayload: null } };
  await c.refresh();
  assert.equal(c.getSnapshot().canStartOver, false);
});

test('3.3: without a staff check (demo transport, tests) a late restart is not offered', async () => {
  const h = staffFixture({ verify: false });
  const c = await atQr(h);
  assert.equal(c.getSnapshot().canStartOver, true);
  h.clock += FREE_RESTART_MS;
  await c.tick();
  assert.equal(c.getSnapshot().canStartOver, false);
  assert.equal(await c.startOver(PIN), false);
  assert.equal(c.getSnapshot().step, 'payment');
});

test('staff code: wrong codes lock the kiosk itself; server lock, missing route and network differ', async () => {
  const h = staffFixture();
  const c = await cart(h);
  for (let i = 1; i < STAFF_PIN_ATTEMPTS; i++) {
    assert.equal(await c.verifyStaff('0000'), false);
    assert.equal(c.getSnapshot().staffPinError, 'wrong');
  }
  assert.equal(await c.verifyStaff('0000'), false);
  assert.equal(c.getSnapshot().staffPinError, 'locked');
  const calls = h.staffCalls.length;
  assert.equal(await c.verifyStaff(PIN), false);
  assert.equal(h.staffCalls.length, calls);
  h.clock += STAFF_PIN_LOCK_MS;
  assert.equal(await c.verifyStaff(PIN), true);
  assert.equal(c.getSnapshot().staffPinError, null);
  for (const [answer, expected] of [
    [new KioskError('NOT_READY', 503), 'unavailable'],
    [new KioskError('NOT_FOUND', 404), 'unavailable'],
    [new KioskError('FORBIDDEN', 403), 'unavailable'],
    [new KioskError('NETWORK_UNCERTAIN'), 'network'],
    [new KioskError('RATE_LIMITED', 429), 'locked'],
  ]) {
    h.staffAnswer = answer;
    assert.equal(await c.verifyStaff(PIN), false);
    assert.equal(c.getSnapshot().staffPinError, expected, answer.code);
  }
  c.clearStaff();
  assert.equal(c.getSnapshot().staffPinError, null);
});

test('3.0: staff can reset a kiosk stuck on an intent that never reached an order', async () => {
  const h = staffFixture();
  await cart(h);
  // An old phone-invoice intent without an order: «требует разбора сотрудником», for ever.
  const flow = stored(h);
  flow.intent = {
    guestId: flow.guestId,
    quoteKey: randomUUID(),
    orderKey: randomUUID(),
    paymentKey: randomUUID(),
    quoteId: null,
    orderId: null,
    phone: '+77011234567',
    expectedTotalMinor: '419000',
    payload: {
      items: [{ productId: 'X1', quantity: 1, selections: [] }],
      serviceMode: 'takeaway',
      catalogVersion: 2,
    },
  };
  h.rawFlow = JSON.stringify(flow);
  const stuck = new CommercialKioskController(h.io);
  await stuck.restore();
  assert.equal(stuck.getSnapshot().step, 'recovery');
  assert.equal(await stuck.recover(), false);
  assert.equal(stuck.getSnapshot().step, 'recovery');
  assert.equal(stuck.getSnapshot().staffResetAvailable, true);
  const guest = currentToken(h);
  assert.equal(await stuck.staffReset('1111'), false);
  assert.equal(stuck.getSnapshot().step, 'recovery');
  assert.ok(stored(h).intent);
  assert.equal(await stuck.staffReset(PIN), true);
  assert.equal(stuck.getSnapshot().step, 'start');
  assert.equal(stuck.getSnapshot().recoveryRequired, false);
  assert.equal(stored(h).intent, null);
  assert.deepEqual(
    stored(h).abandoned.map((a) => a.token),
    [guest],
  );
  // No order, quote or payment request was sent by the reset.
  assert.equal(await stuck.start(), true);
});

test('3.0: a known order (a payment may exist) is never offered a service reset', async () => {
  const h = staffFixture();
  const c = await cart(h);
  h.failPath = 'payment';
  assert.equal(await c.beginPayment(), false);
  assert.ok(stored(h).intent.orderId);
  assert.equal(c.getSnapshot().staffResetAvailable, false);
  assert.equal(await c.staffReset(PIN), false);
  assert.ok(stored(h).intent);
  assert.deepEqual(h.staffCalls, []);
});

test('3.1: a finished guest the server will not end and no room left: staff reset frees the kiosk', async () => {
  const h = staffFixture();
  const base = h.io.request;
  const c = await cart(h);
  assert.equal(await c.beginPayment(), true);
  h.order = { ...h.order, phase: 'paid', displayNumber: '41' };
  await c.refresh();
  const flow = stored(h);
  flow.abandoned = Array.from({ length: MAX_ABANDONED_GUESTS }, (_, i) => ({
    sessionId: `0000000${i}-0000-4000-8000-000000000000`,
    token: String(i).repeat(64),
    expiresAt: new Date(h.clock + 1800000).toISOString(),
  }));
  h.rawFlow = JSON.stringify(flow);
  h.io.request = async (path, token, body, key) => {
    if (path === '/sessions/end') throw new KioskError('CONFLICT', 409);
    return base(path, token, body, key);
  };
  const relaunched = new CommercialKioskController(h.io);
  await relaunched.restore();
  assert.equal(await relaunched.newGuest(), false);
  assert.equal(relaunched.getSnapshot().errorCode, 'STAFF');
  assert.equal(relaunched.getSnapshot().staffResetAvailable, true);
  assert.equal(await relaunched.staffReset(PIN), true);
  assert.equal(relaunched.getSnapshot().syncPending, false);
  assert.equal(relaunched.getSnapshot().step, 'start');
  assert.equal(stored(h).resetPending, false);
});

test('3.4: the demo transport cannot verify staff codes and the demo leaves after inactivity', async () => {
  const demo = createDemoKiosk(null, { uuid: randomUUID });
  assert.equal(demo.transport.io.verifyStaff, undefined);
  assert.equal(await demo.controller.restore(), true);
  assert.equal(demo.controller.getSnapshot().staffResetAvailable, false);
  assert.equal(await demo.controller.verifyStaff(PIN), false);
  assert.equal(demo.controller.getSnapshot().staffPinError, 'unavailable');
  assert.equal(demoIdleExpired(0, DEMO_IDLE_EXIT_MS - 1), false);
  assert.equal(demoIdleExpired(0, DEMO_IDLE_EXIT_MS), true);
  assert.ok(DEMO_IDLE_EXIT_MS <= 5 * 60000);
});
