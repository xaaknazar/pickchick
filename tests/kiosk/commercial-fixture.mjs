// Shared synthetic commercial kiosk fixture (no network): the same double as
// commercial-core.test.mjs, exported for the build 12 audit regressions.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { CommercialKioskController } from '../../apps/kiosk/src/commercial-controller.ts';
import { KioskError } from '../../apps/kiosk/src/api.ts';
import { mockupCatalogDraft } from '@pickchick/catalog-admin/seed';
export const branchId = '7a6f6d98-395d-4462-b5e4-b0364a4a8ec1';
const iso = '2026-10-04T00:00:00Z';
export const storefront = {
  branch: {
    id: branchId,
    code: 'pilot',
    name: 'PickChick',
    timezone: 'Asia/Almaty',
    ordering_enabled: true,
  },
  channel: 'kiosk',
  version: 2,
  published_at: iso,
  payload: globalThis.structuredClone(mockupCatalogDraft),
};
export function fixture() {
  const h = {
    rawSession: null,
    rawFlow: null,
    clock: Date.parse(iso),
    calls: [],
    failPath: null,
    failWrite: false,
    endFail: false,
    order: null,
    paymentMethods: ['kaspi_qr'],
    orders: new Map(),
    before: async () => {},
  };
  h.io = {
    readDevice: async () => JSON.stringify({ deviceId: randomUUID(), key: 'a'.repeat(64) }),
    readSession: async () => h.rawSession,
    writeSession: async (raw) => {
      if (h.failWrite) throw Error();
      h.rawSession = raw;
    },
    removeSession: async () => {
      h.rawSession = null;
    },
    readFlow: async () => h.rawFlow,
    writeFlow: async (raw) => {
      if (h.failWrite) throw Error();
      h.rawFlow = raw;
    },
    now: () => h.clock,
    uuid: randomUUID,
    request: async (path, token, body, key) => {
      h.calls.push({ path, token, body, key });
      await h.before(path);
      if (path === '/sessions') {
        const stored = JSON.parse(h.rawSession);
        assert.equal(body.sessionId, stored.sessionId);
        assert.equal(body.token, stored.token);
        assert.equal(JSON.parse(h.rawFlow).guestId, body.sessionId);
        return {
          sessionId: body.sessionId,
          branchId,
          organizationId: randomUUID(),
          expiresAt: new Date(h.clock + 86400000).toISOString(),
        };
      }
      assert.equal(token, JSON.parse(h.rawSession).token);
      if (path === '/config')
        return {
          enabled: true,
          branchId,
          restaurant: 'PickChick',
          paymentMethod: 'kaspi_qr',
          paymentMethods: h.paymentMethods,
        };
      if (path === '/catalog') return storefront;
      if (path === '/availability')
        return {
          fresh: true,
          products: storefront.payload.products.map((p) => ({
            productId: p.id,
            available: p.available,
            stoppedOptions: [],
          })),
        };
      if (path === '/sessions/end') {
        if (h.endFail) throw new KioskError('NETWORK_UNCERTAIN');
        return { ended: true };
      }
      if (path === '/quotes') {
        const intent = JSON.parse(h.rawFlow).intent;
        assert.equal(key, intent.quoteKey);
        assert.equal(body.key, key);
        assert.equal(body.catalog_version, 2);
        assert.equal(body.items[0].productId, storefront.payload.products[0].sku);
        if (h.failPath === path) {
          h.failPath = null;
          throw new KioskError('NETWORK_UNCERTAIN');
        }
        return {
          quoteId: '11111111-1111-4111-8111-111111111111',
          totalMinor: '419000',
          expiresAt: '2026-10-04T00:02:00Z',
          serviceMode: 'takeaway',
        };
      }
      if (path === '/orders') {
        assert.equal(body.key, JSON.parse(h.rawFlow).intent.orderKey);
        h.order ??= {
          orderId: randomUUID(),
          branchId,
          restaurant: 'PickChick',
          revision: 'b'.repeat(64),
          createdAt: iso,
          updatedAt: iso,
          kitchenStage: null,
          displayNumber: '12',
          totalMinor: '419000',
          serviceMode: 'takeaway',
          phase: 'ready_to_pay',
          expiresAt: null,
          receipt: 'pending',
          receiptUrl: null,
          items: [],
        };
        if (h.failPath === path) {
          h.failPath = null;
          throw new KioskError('NETWORK_UNCERTAIN');
        }
        return h.order;
      }
      if (path.endsWith('/payment')) {
        const intent = JSON.parse(h.rawFlow).intent;
        if (intent.method === 'kaspi_invoice') {
          assert.deepEqual(body, { method: 'kaspi_invoice', phone: '+77011234567' });
        } else {
          assert.deepEqual(body, { method: 'kaspi_qr' });
          assert.equal('phone' in intent, false);
        }
        assert.equal(key, intent.paymentKey);
        h.order = { ...h.order, phase: 'awaiting_payment', paymentMethod: body.method };
        if (h.failPath === 'payment') {
          h.failPath = null;
          throw new KioskError('NETWORK_UNCERTAIN');
        }
        return h.order;
      }
      if (path.startsWith('/orders/')) return h.order;
      throw Error(path);
    },
  };
  return h;
}
export async function cart(h) {
  const c = new CommercialKioskController(h.io);
  assert.equal(await c.restore(), true);
  await c.start();
  await c.setMode('takeaway');
  const product = c.getSnapshot().catalog.products[0];
  const selections = product.modifier_groups.flatMap((g) =>
    g.options
      .filter((o) => o.default_quantity > 0)
      .map((o) => ({ group_id: g.id, option_id: o.id, quantity: o.default_quantity })),
  );
  assert.equal(await c.addToCart(product.id, selections), true);
  c.goLoyalty();
  c.setInvoicePhone('8 (701) 123-45-67');
  return c;
}
