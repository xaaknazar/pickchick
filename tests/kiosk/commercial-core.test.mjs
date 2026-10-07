import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  CommercialKioskController,
  invoicePhone,
  publishedKioskCatalog,
} from '../../apps/kiosk/src/commercial-controller.ts';
import { commercialKioskRequest } from '../../apps/kiosk/src/commercial-api.ts';
import { KioskError } from '../../apps/kiosk/src/api.ts';
import { mockupCatalogDraft } from '@pickchick/catalog-admin/seed';
const branchId = '7a6f6d98-395d-4462-b5e4-b0364a4a8ec1';
const iso = '2026-10-04T00:00:00Z';
const storefront = {
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
function fixture() {
  const h = {
    rawSession: null,
    rawFlow: null,
    clock: Date.parse(iso),
    calls: [],
    failPath: null,
    failWrite: false,
    endFail: false,
    order: null,
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
          expiresAt: '2026-10-05T00:00:00Z',
        };
      }
      assert.equal(token, JSON.parse(h.rawSession).token);
      if (path === '/config')
        return { enabled: true, branchId, restaurant: 'PickChick', paymentMethod: 'kaspi_qr' };
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
        assert.deepEqual(body, { method: 'kaspi_qr' });
        assert.equal('phone' in intent, false);
        assert.equal(key, intent.paymentKey);
        h.order = { ...h.order, phase: 'awaiting_payment' };
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
async function cart(h) {
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
test('commercial catalog retains authored content and kiosk price, SKU and stops', () => {
  const data = globalThis.structuredClone(storefront);
  data.payload.products[0].sku = 'POS.101';
  data.payload.products[0].channel_prices_minor = { mobile: '100', kiosk: '200' };
  data.payload.products[0].available = false;
  const menu = publishedKioskCatalog(data);
  assert.equal(menu.products[0].price_minor, '200');
  assert.equal(menu.products[0].sku, 'POS.101');
  assert.equal(menu.products[0].available, false);
  assert.equal(menu.products[0].name, data.payload.products[0].name.ru);
  assert.equal('synthetic' in menu, false);
});
test('phone accepts Kazakhstan mobile only', () => {
  assert.equal(invoicePhone('8 (701) 123-45-67'), '+77011234567');
  assert.equal(invoicePhone('+7 701 1234567'), '+77011234567');
  assert.equal(invoicePhone('+7 495 1234567'), null);
});
test('real waiting cannot simulate payment or free guest; authoritative paid permits clean reset', async () => {
  const h = fixture(),
    c = await cart(h);
  assert.equal(await c.beginPayment(), true);
  assert.equal(c.getSnapshot().invoicePhone, undefined);
  assert.equal(c.getSnapshot().order.payment_state, 'pending');
  assert.equal(await c.pay('approved'), false);
  assert.equal(await c.newGuest(), false);
  h.order = { ...h.order, phase: 'preparing', receipt: 'issued', kitchenStage: 'cooking' };
  await c.refresh();
  assert.equal(c.getSnapshot().order.payment_state, 'paid');
  assert.equal(await c.newGuest(), true);
  assert.equal(h.rawSession, null);
  assert.equal(JSON.parse(h.rawFlow).order, null);
  assert.equal(
    h.calls.some((r) => r.path.includes('simulated')),
    false,
  );
});
for (const path of ['/quotes', '/orders', 'payment'])
  test(`lost ${path} keeps stable saved intent across restart`, async () => {
    const h = fixture(),
      c = await cart(h);
    h.failPath = path;
    assert.equal(await c.beginPayment(), false);
    const intent = JSON.parse(h.rawFlow).intent;
    assert(intent);
    assert.equal(await c.newGuest(), false);
    const restored = new CommercialKioskController(h.io);
    assert.equal(await restored.restore(), true);
    assert.equal(JSON.parse(h.rawFlow).intent, null);
    assert.equal(restored.getSnapshot().invoicePhone, undefined);
    const requests = h.calls.filter((r) =>
      path === 'payment' ? r.path.endsWith('/payment') : r.path === path,
    );
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0].body, requests[1].body);
    assert.equal(requests[0].key, requests[1].key);
  });
test('failed secure intent write makes no quote or payment request', async () => {
  const h = fixture(),
    c = await cart(h);
  h.failWrite = true;
  assert.equal(await c.beginPayment(), false);
  assert.equal(
    h.calls.some(
      (r) => r.path === '/quotes' || r.path === '/orders' || r.path.endsWith('/payment'),
    ),
    false,
  );
});
test('idle clears draft phone but preserves unresolved order; end network failure retains identity', async () => {
  const h = fixture(),
    c = await cart(h);
  h.clock += 105001;
  await c.tick();
  assert.equal(c.getSnapshot().invoicePhone, undefined);
  assert.equal(c.getSnapshot().step, 'start');
  const c2 = await cart(h);
  await c2.beginPayment();
  h.clock += 105001;
  await c2.tick();
  assert(c2.getSnapshot().order);
  assert.equal(await c2.newGuest(), false);
  h.order = { ...h.order, phase: 'failed' };
  await c2.refresh();
  h.endFail = true;
  assert.equal(await c2.newGuest(), false);
  assert(h.rawSession);
  assert.equal(JSON.parse(h.rawFlow).resetPending, true);
});
test('commercial HTTP requires device scope and guest; rejects test and customer endpoints', async () => {
  let calls = 0;
  const fetcher = async (url, options) => {
    calls++;
    assert(url.endsWith('/v1/kiosk-checkout/config'));
    assert.equal(options.headers['X-Kiosk-Key'], 'c'.repeat(64));
    assert.equal(options.headers.Authorization, 'Bearer ' + 'd'.repeat(64));
    return new Response('{}', { headers: { 'content-type': 'application/json' } });
  };
  const device = { deviceId: branchId, key: 'c'.repeat(64) };
  await commercialKioskRequest('/config', 'd'.repeat(64), undefined, undefined, fetcher, device);
  assert.equal(calls, 1);
  for (const path of ['/simulated-payment', '/test/orders', '/customer-checkout/orders'])
    await assert.rejects(
      commercialKioskRequest(path, 'd'.repeat(64), undefined, undefined, fetcher, device),
      /INVALID_PATH/,
    );
  await assert.rejects(
    commercialKioskRequest('/config', undefined, undefined, undefined, fetcher, device),
    /GUEST_IDENTITY_UNAVAILABLE/,
  );
  assert.equal(calls, 1);
});
test('reset marker recovers after secure guest removal and final flow write failure', async () => {
  const h = fixture(),
    c = await cart(h);
  await c.beginPayment();
  h.order = { ...h.order, phase: 'paid' };
  await c.refresh();
  h.io.removeSession = async () => {
    h.rawSession = null;
    h.failWrite = true;
  };
  assert.equal(await c.newGuest(), false);
  assert.equal(h.rawSession, null);
  assert.equal(JSON.parse(h.rawFlow).resetPending, true);
  h.failWrite = false;
  h.io.removeSession = async () => {
    h.rawSession = null;
  };
  const recovered = new CommercialKioskController(h.io);
  assert.equal(await recovered.restore(), true);
  assert.equal(recovered.getSnapshot().order, null);
  assert.equal(recovered.getSnapshot().step, 'start');
});
test('tampered payment intent blocks all remote recovery requests', async () => {
  const h = fixture(),
    c = await cart(h);
  h.failPath = '/quotes';
  await c.beginPayment();
  const stored = JSON.parse(h.rawFlow);
  stored.intent.payload.items[0].quantity = -1;
  h.rawFlow = JSON.stringify(stored);
  h.calls = [];
  const recovered = new CommercialKioskController(h.io);
  assert.equal(await recovered.restore(), false);
  assert.equal(h.calls.length, 0);
  assert.equal(await recovered.newGuest(), false);
});
test('stopped published product stays removable and cannot be quoted', async () => {
  const h = fixture(),
    c = await cart(h);
  const id = c.getSnapshot().cart[0].productId;
  h.before = async (path) => {
    if (path === '/catalog') storefront.payload.products.find((p) => p.id === id).available = false;
  };
  try {
    assert.equal(await c.beginPayment(), false);
    assert.equal(c.getSnapshot().cartValid, false);
    assert.equal(
      h.calls.some((r) => r.path === '/quotes'),
      false,
    );
    assert.equal(c.getSnapshot().unavailableCartLines.length, 1);
  } finally {
    storefront.payload.products.find((p) => p.id === id).available = true;
  }
});
test('fresh edge option stop invalidates existing selections without shrinking the cart', async () => {
  const h = fixture(),
    c = await cart(h);
  const original = h.io.request;
  const chosen = c.getSnapshot().cart[0].selections[0];
  h.io.request = async (path, ...args) =>
    path === '/availability'
      ? {
          fresh: true,
          products: storefront.payload.products.map((p) => ({
            productId: p.id,
            available: true,
            stoppedOptions:
              p.id === c.getSnapshot().cart[0]?.productId
                ? [{ group_id: chosen.group_id, option_id: chosen.option_id }]
                : [],
          })),
        }
      : original(path, ...args);
  assert.equal(await c.beginPayment(), false);
  assert.equal(c.getSnapshot().unavailableCartLines.length, 1);
  assert.equal(
    h.calls.some((r) => r.path === '/quotes'),
    false,
  );
  assert.equal(JSON.parse(h.rawFlow).cart.length, 1);
});
test('price refresh before quote cannot silently increase the confirmed total', async () => {
  const h = fixture(),
    c = await cart(h);
  const original = h.io.request;
  const first = storefront.payload.products[0],
    old = first.price_minor;
  h.before = async (path) => {
    if (path === '/catalog') first.price_minor = '499000';
  };
  h.io.request = async (path, ...args) =>
    path === '/quotes'
      ? {
          quoteId: randomUUID(),
          totalMinor: '499000',
          expiresAt: '2026-10-04T00:02:00Z',
          serviceMode: 'takeaway',
        }
      : original(path, ...args);
  try {
    assert.equal(await c.beginPayment(), false);
    assert.equal(c.getSnapshot().step, 'loyalty');
    assert.equal(JSON.parse(h.rawFlow).intent, null);
    assert.equal(
      h.calls.some((r) => r.path === '/orders' || r.path.endsWith('/payment')),
      false,
    );
    assert.match(c.getSnapshot().error, /Сумма изменилась/);
  } finally {
    first.price_minor = old;
  }
});
for (const code of [
  'INVALID',
  'CONFLICT',
  'NOT_READY',
  'ITEM_STOPPED',
  'AVAILABILITY_STALE',
  'RESTAURANT_CLOSED',
])
  test(`definitive quote ${code} returns review, while order errors retain recovery`, async () => {
    const h = fixture(),
      c = await cart(h);
    h.before = async (path) => {
      if (path === '/quotes') throw new KioskError(code, 409);
    };
    assert.equal(await c.beginPayment(), false);
    assert.equal(JSON.parse(h.rawFlow).intent, null);
    assert.equal(c.getSnapshot().step, 'loyalty');
    assert.equal(c.getSnapshot().recoveryRequired, false);
    assert.equal(
      h.calls.some((r) => r.path === '/orders'),
      false,
    );
    h.before = async (path) => {
      if (path === '/orders') throw new KioskError(code, 409);
    };
    c.setInvoicePhone('+77011234567');
    assert.equal(await c.beginPayment(), false);
    assert(JSON.parse(h.rawFlow).intent);
    assert.equal(c.getSnapshot().recoveryRequired, true);
  });
test('stale availability closes local quote and retains shopping draft for retry', async () => {
  const h = fixture(),
    c = await cart(h),
    original = h.io.request;
  h.io.request = async (path, ...args) =>
    path === '/availability'
      ? {
          fresh: false,
          products: storefront.payload.products.map((p) => ({
            productId: p.id,
            available: true,
            stoppedOptions: [],
          })),
        }
      : original(path, ...args);
  assert.equal(await c.beginPayment(), false);
  assert.equal(JSON.parse(h.rawFlow).cart.length, 1);
  assert.equal(
    h.calls.some((r) => r.path === '/quotes'),
    false,
  );
  assert.equal(c.getSnapshot().recoveryRequired, false);
});

test('unsupported invoice config blocks new QR checkout', async () => {
  const h = fixture();
  const request = h.io.request;
  h.io.request = async (...args) =>
    args[0] === '/config' ? { enabled: true, branchId, restaurant: 'PickChick' } : request(...args);
  const c = new CommercialKioskController(h.io);
  assert.equal(await c.restore(), false);
  assert.equal(await c.beginPayment(), false);
  assert.equal(
    h.calls.some((r) => r.path === '/orders' || r.path.endsWith('/payment')),
    false,
  );
});

test('QR payload survives restart but payment projection alone cannot confirm payment', async () => {
  const h = fixture(),
    c = await cart(h);
  await c.beginPayment();
  h.order = {
    ...h.order,
    payment: {
      kind: 'kaspi_qr',
      state: 'pending',
      qrPayload: 'https://qr.kaspi.kz/fixture',
      expiresAt: '2026-10-04T00:02:00Z',
    },
  };
  await c.refresh();
  const recovered = new CommercialKioskController(h.io);
  assert.equal(await recovered.restore(), true);
  assert.equal(recovered.getSnapshot().qrPayment.qrPayload, h.order.payment.qrPayload);
  h.order = { ...h.order, payment: { ...h.order.payment, state: 'paid', qrPayload: null } };
  await recovered.refresh();
  assert.equal(recovered.getSnapshot().order.payment_state, 'pending');
  assert.equal(await recovered.newGuest(), false);
  h.order.phase = 'paid';
  await recovered.refresh();
  assert.equal(await recovered.newGuest(), true);
});

test('legacy phone intent recovers existing order without submitting another invoice', async () => {
  const h = fixture(),
    c = await cart(h);
  h.failPath = 'payment';
  await c.beginPayment();
  const flow = JSON.parse(h.rawFlow);
  delete flow.intent.method;
  flow.intent.phone = '+77011234567';
  h.rawFlow = JSON.stringify(flow);
  h.calls = [];
  const recovered = new CommercialKioskController(h.io);
  assert.equal(await recovered.restore(), true);
  assert.equal(
    h.calls.some((r) => r.path.endsWith('/payment')),
    false,
  );
  assert.equal(JSON.parse(h.rawFlow).intent, null);
});

test('enrollment preflight accepts device authentication without guest and keeps other routes protected', async () => {
  const device = { deviceId: randomUUID(), key: 'a'.repeat(64) };
  let call;
  const fetcher = async (url, options) => {
    call = { url, options };
    return new Response(JSON.stringify({ valid: true, branchId, restaurant: 'PickChick' }), {
      headers: { 'content-type': 'application/json' },
    });
  };
  const response = await commercialKioskRequest(
    '/enrollment/check',
    undefined,
    {},
    undefined,
    fetcher,
    device,
  );
  assert.equal(response.valid, true);
  assert.equal(call.options.headers['X-Kiosk-Device'], device.deviceId);
  assert.equal(call.options.headers['X-Kiosk-Key'], device.key);
  assert.equal('Authorization' in call.options.headers, false);
  assert.equal(call.options.method, 'POST');
  await assert.rejects(
    commercialKioskRequest('/config', undefined, undefined, undefined, fetcher, device),
    { code: 'GUEST_IDENTITY_UNAVAILABLE' },
  );
  await assert.rejects(
    commercialKioskRequest('/enrollment/check', undefined, {}, undefined, fetcher),
    { code: 'DEVICE_NOT_PROVISIONED' },
  );
});
