import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { CommercialKioskController } from '../../apps/kiosk/src/commercial-controller.ts';

// Restore the persisted paid order without a menu/network dependency. No endpoint
// in this fixture can create an order or payment: an unexpected request fails.
function fixture() {
  const branchId = randomUUID(),
    sessionId = randomUUID();
  const now = Date.parse('2026-10-08T12:00:00Z');
  const h = {
    calls: [],
    now,
    offline: false,
    order: {
      orderId: randomUUID(),
      branchId,
      restaurant: 'PickChick',
      revision: 'b'.repeat(64),
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
      kitchenStage: null,
      displayNumber: null,
      totalMinor: '10000',
      serviceMode: 'takeaway',
      phase: 'paid',
      expiresAt: null,
      receipt: 'pending',
      receiptUrl: null,
      items: [],
    },
  };
  h.rawSession = JSON.stringify({
    sessionId,
    branchId,
    token: 'a'.repeat(64),
    expiresAt: new Date(now + 86400000).toISOString(),
  });
  h.rawFlow = JSON.stringify({
    version: 1,
    guestId: sessionId,
    mode: 'takeaway',
    cart: [],
    intent: null,
    order: h.order,
    lastActivityAt: now,
    resetPending: false,
  });
  h.io = {
    readDevice: async () => JSON.stringify({ deviceId: randomUUID(), key: 'a'.repeat(64) }),
    readSession: async () => h.rawSession,
    writeSession: async (raw) => {
      h.rawSession = raw;
    },
    removeSession: async () => {
      h.rawSession = null;
    },
    readFlow: async () => h.rawFlow,
    writeFlow: async (raw) => {
      h.rawFlow = raw;
    },
    now: () => h.now,
    uuid: randomUUID,
    request: async (path) => {
      h.calls.push(path);
      if (path === '/config')
        return {
          enabled: false,
          branchId,
          paymentMethod: 'kaspi_qr',
          paymentMethods: ['kaspi_qr'],
        };
      if (path === '/catalog' || path === '/availability' || h.offline)
        throw Error('Offline fixture');
      if (path === `/orders/${h.order.orderId}`) return h.order;
      if (path === '/sessions/end') return { ended: true };
      throw Error('Unexpected request: ' + path);
    },
  };
  return h;
}

test('paid order without a number is final: the kiosk is free, the number arrives later', async () => {
  const h = fixture();
  let c = new CommercialKioskController(h.io);
  assert.equal(await c.restore(), true);
  assert.equal(c.getSnapshot().step, 'order');
  assert.equal(c.getSnapshot().order.payment_state, 'paid');
  // Paid is financially final: waiting for the kitchen number blocks nobody.
  assert.equal(c.getSnapshot().recoveryRequired, false);
  h.now += 30 * 60 * 1000;
  await c.tick();
  assert.equal(c.getSnapshot().step, 'order');
  c = new CommercialKioskController(h.io);
  assert.equal(await c.restore(), true);
  // A missed status read keeps the order screen instead of the recovery screen.
  h.offline = true;
  assert.equal(await c.recover(), false);
  assert.equal(c.getSnapshot().step, 'order');
  assert.equal(c.getSnapshot().errorCode, 'CONNECTION');
  assert.equal(await c.refresh(), false);
  assert.equal(c.getSnapshot().step, 'order');
  h.offline = false;
  h.order = { ...h.order, displayNumber: '27', phase: 'preparing', kitchenStage: 'cooking' };
  assert.equal(await c.recover(), true);
  assert.equal(c.getSnapshot().order.number, '27');
  assert.equal(c.getSnapshot().error, null);
  assert.equal(
    h.calls.some((p) => p === '/orders' || p === '/quotes' || p.endsWith('/payment')),
    false,
  );
});

test('next guest after a paid order without a number; offline reset finishes in the background', async () => {
  const h = fixture();
  const c = new CommercialKioskController(h.io);
  assert.equal(await c.restore(), true);
  h.offline = true;
  // The paid guest is cleared locally at once; ending the session waits for the network.
  assert.equal(await c.newGuest(), false);
  assert.equal(JSON.parse(h.rawFlow).order, null);
  assert.equal(JSON.parse(h.rawFlow).resetPending, true);
  assert.equal(c.getSnapshot().step, 'start');
  assert.equal(c.getSnapshot().order, null);
  assert.equal(c.getSnapshot().recoveryRequired, false);
  assert.equal(c.getSnapshot().syncPending, true);
  assert.equal(c.getSnapshot().errorCode, 'OFFLINE');
  h.offline = false;
  await c.refresh();
  // One failed offline attempt, then the background retry.
  assert.equal(h.calls.filter((p) => p === '/sessions/end').length, 2);
  // The ended guest's credential is gone (the next menu load may allocate a new one).
  assert.equal(h.rawSession?.includes('a'.repeat(64)) ?? false, false);
  assert.equal(JSON.parse(h.rawFlow).resetPending, false);
  assert.equal(c.getSnapshot().syncPending, false);
  assert.equal(
    h.calls.some((p) => p === '/orders' || p === '/quotes' || p.endsWith('/payment')),
    false,
  );
});
