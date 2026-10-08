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

test('paid order without a number survives idle, restart and outage until kitchen supplies its number', async () => {
  const h = fixture();
  let c = new CommercialKioskController(h.io);
  assert.equal(await c.restore(), true);
  assert.equal(c.getSnapshot().step, 'order');
  assert.equal(c.getSnapshot().order.payment_state, 'paid');
  assert.equal(c.getSnapshot().recoveryRequired, true);
  h.now += 30 * 60 * 1000;
  await c.tick();
  assert.equal(await c.newGuest(), false);
  assert.equal(await c.cancelOrder(), false);
  const savedGuest = h.rawSession;
  c = new CommercialKioskController(h.io);
  assert.equal(await c.restore(), true);
  h.offline = true;
  assert.equal(await c.recover(), false);
  assert.equal(await c.newGuest(), false);
  assert.equal(h.rawSession, savedGuest);
  assert.equal(JSON.parse(h.rawFlow).order.orderId, h.order.orderId);
  assert.equal(h.calls.includes('/sessions/end'), false);
  h.offline = false;
  h.order = { ...h.order, displayNumber: '27', phase: 'preparing', kitchenStage: 'cooking' };
  assert.equal(await c.recover(), true);
  assert.equal(c.getSnapshot().step, 'order');
  assert.equal(c.getSnapshot().order.number, '27');
  assert.equal(c.getSnapshot().recoveryRequired, false);
  assert.equal(await c.newGuest(), true);
  assert.equal(h.calls.filter((p) => p === '/sessions/end').length, 1);
  assert.equal(h.rawSession, null);
  assert.equal(JSON.parse(h.rawFlow).order, null);
  assert.equal(
    h.calls.some((p) => p === '/orders' || p === '/quotes' || p.endsWith('/payment')),
    false,
  );
});
