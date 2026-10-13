import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { KioskController } from '../../apps/kiosk/src/controller.ts';
import { KioskError } from '../../apps/kiosk/src/api.ts';
import { defaultSelections } from '../../apps/kiosk/src/cart.ts';
import { undoUpsellAdds, upsellUndo } from '../../apps/kiosk/src/smartUpsell.ts';
import { testCompleteCatalog as catalog } from '@pickchick/test-order-flow/complete-catalog';

// Owner bug 2026-10-13: extras added on the smart upsell were ordered after «Без допов».
// «Без допов» takes out exactly what was added during the visit; «К оплате» keeps it.

test('the undo returns every line to its quantity when the upsell opened', () => {
  const opened = [
    { lineId: 'pick-combo|a', quantity: 1 },
    { lineId: 'cola', quantity: 2 },
  ];
  assert.deepEqual(upsellUndo(opened, opened), [], 'nothing added, nothing to undo');
  assert.deepEqual(
    upsellUndo(opened, [
      { lineId: 'pick-combo|a', quantity: 2 },
      { lineId: 'cola', quantity: 2 },
      { lineId: 'sauce|size:size-0:1', quantity: 1 },
      { lineId: 'lemonade', quantity: 3 },
    ]),
    [
      { lineId: 'pick-combo|a', quantity: 1 },
      { lineId: 'sauce|size:size-0:1', quantity: 0 },
      { lineId: 'lemonade', quantity: 0 },
    ],
  );
  // A line the guest lowered meanwhile is not raised again.
  assert.deepEqual(upsellUndo(opened, [{ lineId: 'pick-combo|a', quantity: 1 }]), []);
});

/** Simulator controller with an in-memory store; the quote request is recorded, then refused. */
function kiosk() {
  const h = { flow: null, session: null, quotes: [] };
  const io = {
    readSession: async () => h.session,
    writeSession: async (raw) => {
      h.session = raw;
    },
    removeSession: async () => {
      h.session = null;
    },
    readFlow: async () => h.flow,
    writeFlow: async (raw) => {
      h.flow = raw;
    },
    now: () => Date.parse('2026-10-13T12:00:00Z'),
    uuid: randomUUID,
    request: async (path, _token, body) => {
      if (path === '/capabilities')
        return {
          schema_version: 1,
          environment: 'staging',
          data_mode: 'synthetic',
          ordering_enabled: false,
          features: {
            test_order_flow: true,
            phone_auth: false,
            payments: false,
            fiscal: false,
            checkout: false,
            loyalty: false,
          },
        };
      if (path === '/catalog') return globalThis.structuredClone(catalog);
      if (path === '/sessions')
        return {
          synthetic: true,
          namespace: 'pickchick-test',
          session_id: randomUUID(),
          token: 'a'.repeat(64),
          expires_at: '9999-12-31T23:59:59.999Z',
          channel: 'kiosk',
        };
      if (path === '/quotes') {
        h.quotes.push(globalThis.structuredClone(body));
        // An authoritative refusal returns the guest to editing; no order request follows.
        throw new KioskError('INVALID_REQUEST', 400);
      }
      throw new Error('unexpected request ' + path);
    },
  };
  h.core = new KioskController(io);
  return h;
}
const product = (id) => catalog.products.find((p) => p.id === id);
const add = (c, id, quantity = 1) => c.addToCart(id, defaultSelections(product(id)), quantity);
const lines = (c) =>
  [...c.getSnapshot().cart, ...c.getSnapshot().unavailableCartLines].map(
    ({ lineId, quantity }) => ({ lineId, quantity }),
  );
const quoted = (h) =>
  h.quotes
    .at(-1)
    .items.map((item) => [item.product_id, item.quantity])
    .sort();

async function upsellWithExtras() {
  const h = kiosk();
  const c = h.core;
  assert.equal(await c.restore(), true);
  assert.equal(await c.start(), true);
  assert.equal(await c.setMode('takeaway'), true);
  // Brought from the menu: a Pick Combo and a cola.
  assert.equal(await add(c, 'pick-combo'), true);
  assert.equal(await add(c, 'cola'), true);
  c.openUpsell();
  assert.equal(c.getSnapshot().step, 'upsell');
  const opened = lines(c);
  // On the upsell: a sauce and a lemonade (tiles), and one more Pick Combo (the same line).
  assert.equal(await add(c, 'sauce'), true);
  assert.equal(await add(c, 'lemonade'), true);
  assert.equal(await add(c, 'pick-combo'), true);
  assert.equal(c.getSnapshot().step, 'upsell');
  return { h, c, opened };
}

test('«Без допов» orders without the extras added on the upsell', async () => {
  const { h, c, opened } = await upsellWithExtras();
  assert.equal(await undoUpsellAdds(c, opened, lines(c)), true);
  assert.deepEqual(lines(c), opened, 'the cart is back as the guest brought it');
  c.goLoyalty();
  assert.equal(c.getSnapshot().step, 'loyalty');
  assert.equal(await c.beginPayment('kaspi'), false);
  assert.deepEqual(quoted(h), [
    ['cola', 1],
    ['pick-combo', 1],
  ]);
});

test('«К оплате» orders with the extras added on the upsell', async () => {
  const { h, c } = await upsellWithExtras();
  c.goLoyalty();
  assert.equal(await c.beginPayment('kaspi'), false);
  assert.deepEqual(quoted(h), [
    ['cola', 1],
    ['lemonade', 1],
    ['pick-combo', 2],
    ['sauce', 1],
  ]);
});

test('a refused quantity change stops before payment', async () => {
  const opened = [{ lineId: 'a', quantity: 1 }];
  const calls = [];
  const model = {
    updateQuantity: async (lineId, quantity) => {
      calls.push([lineId, quantity]);
      return lineId !== 'b';
    },
  };
  const now = [
    { lineId: 'a', quantity: 1 },
    { lineId: 'b', quantity: 1 },
    { lineId: 'c', quantity: 1 },
  ];
  assert.equal(await undoUpsellAdds(model, opened, now), false);
  assert.deepEqual(calls, [['b', 0]], 'no further change after the refusal');
  assert.equal(await undoUpsellAdds(model, now, now), true);
});
