import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  KioskController,
  KIOSK_FLOW_KEY,
  KIOSK_SESSION_KEY,
  KIOSK_IDLE_MS,
  KIOSK_IDLE_GRACE_MS,
} from '../../apps/kiosk/src/controller.ts';
import { KioskError, kioskRequest } from '../../apps/kiosk/src/api.ts';
import { defaultSelections, selectedPriceMinor, testLineId } from '../../apps/kiosk/src/cart.ts';
import { testCompleteCatalog as catalog } from '@pickchick/test-order-flow/complete-catalog';
const clone = (value) => globalThis.structuredClone(value);
const synthetic = { synthetic: true, namespace: 'pickchick-test' };
const caps = {
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
const iso = (time) => new Date(time).toISOString();
function fixture() {
  const h = {
    catalog: clone(catalog),
    rawSession: null,
    rawFlow: null,
    requests: [],
    effects: [],
    sessions: [],
    orders: new Map(),
    quotes: new Map(),
    results: new Map(),
    clock: Date.parse('2026-09-07T12:00:00Z'),
    before: async () => {},
    after: async () => {},
    failWrite: false,
    failRead: false,
    failRemove: false,
  };
  h.io = {
    readSession: async () => {
      if (h.failRead) throw Error('read unavailable');
      return h.rawSession;
    },
    writeSession: async (raw) => {
      h.effects.push('session.write');
      if (h.failWrite) throw Error('write unavailable');
      h.rawSession = raw;
    },
    removeSession: async () => {
      h.effects.push('session.remove');
      if (h.failRemove) throw Error('remove unavailable');
      h.rawSession = null;
    },
    readFlow: async () => {
      if (h.failRead) throw Error('read unavailable');
      return h.rawFlow;
    },
    writeFlow: async (raw) => {
      h.effects.push('flow.write');
      if (h.failWrite) throw Error('write unavailable');
      h.rawFlow = raw;
    },
    now: () => h.clock,
    uuid: randomUUID,
    request: async (path, token, body, key) => {
      const request = { path, token, body: clone(body), key };
      h.requests.push(request);
      h.effects.push(path);
      if (
        path === '/quotes' ||
        (path === '/orders' && body) ||
        path.endsWith('/simulated-payment') ||
        path.endsWith('/cancel')
      ) {
        assert(h.rawFlow, 'intent must be on disk before network');
        const pending = JSON.parse(h.rawFlow).pending;
        assert(pending, 'every mutation has saved intent');
        assert.equal(pending.sessionId, JSON.parse(h.rawSession).session_id);
        assert([pending.quoteKey, pending.orderKey, pending.key].includes(key));
      }
      await h.before(request);
      let result;
      const previous = key ? h.results.get(path + ':' + key) : null;
      if (previous) {
        assert.deepEqual(body, previous.body, 'exact payload with original idempotency key');
        result = previous.result;
      } else if (path === '/capabilities') result = caps;
      else if (path === '/catalog') result = h.catalog;
      else if (path === '/sessions') {
        assert.deepEqual(body, { channel: 'kiosk' });
        result = {
          ...synthetic,
          session_id: randomUUID(),
          token: (h.sessions.length + 1).toString(16).padStart(64, 'a'),
          expires_at: '9999-12-31T23:59:59.999Z',
          channel: 'kiosk',
        };
        h.sessions.push(result);
      } else if (path === '/quotes') {
        const lines = body.items.map((item) => {
          const p = h.catalog.products.find((p) => p.id === item.product_id);
          const price = selectedPriceMinor(p, item.selections);
          return {
            id: p.id,
            name: p.name,
            description: p.description,
            category: p.category,
            price_minor: price,
            image_id: p.image_id,
            prep_required: p.prep_required,
            serving_label: p.serving_label,
            nutrition: p.nutrition,
            nutrition_provenance: p.nutrition_provenance,
            line_id: testLineId(p.id, item.selections),
            base_price_minor: p.price_minor,
            quantity: item.quantity,
            line_total_minor: (BigInt(price) * BigInt(item.quantity)).toString(),
            selections: item.selections.map((s) => {
              const g = p.modifier_groups.find((g) => g.id === s.group_id),
                o = g.options.find((o) => o.id === s.option_id);
              return {
                ...s,
                group_label: g.title,
                option_label: o.label,
                price_delta_minor: o.price_delta_minor,
              };
            }),
          };
        });
        result = {
          ...synthetic,
          quote_id: randomUUID(),
          branch_id: catalog.branch_id,
          catalog_version: 'mockup-v0.3',
          channel: 'kiosk',
          service_mode: body.service_mode,
          payment_method: body.payment_method,
          currency: 'KZT',
          lines,
          total_minor: lines.reduce((sum, l) => sum + BigInt(l.line_total_minor), 0n).toString(),
          estimated_minutes: { min: 8, max: 12 },
          created_at: iso(h.clock),
          expires_at: iso(h.clock + 300000),
        };
        h.quotes.set(result.quote_id, result);
      } else if (path === '/orders' && body) {
        const quote = h.quotes.get(body.quote_id);
        assert(quote);
        if (Date.parse(quote.expires_at) <= h.clock) throw new KioskError('QUOTE_EXPIRED', 409);
        result = {
          ...synthetic,
          order_id: randomUUID(),
          number: 'T-' + String(h.orders.size + 1).padStart(6, '0'),
          branch_id: catalog.branch_id,
          version: 1,
          state: 'awaiting_test_payment',
          payment_state: 'not_started',
          payment_attempt_id: null,
          fiscal_state: 'not_applicable',
          snapshot: quote,
          tasks: [],
          created_at: iso(h.clock),
          updated_at: iso(h.clock),
          cancellation_reason: null,
        };
        h.orders.set(result.order_id, { token, order: result });
      } else if (path === '/orders')
        result = {
          ...synthetic,
          orders: [...h.orders.values()]
            .filter((entry) => entry.token === token)
            .map((entry) => entry.order),
        };
      else {
        const [, , id, action] = path.split('/');
        const previous = h.orders.get(id);
        assert(previous);
        assert.equal(previous.token, token);
        const order = previous.order;
        if (order.version !== body.expected_version) throw new KioskError('VERSION_CONFLICT', 409);
        if (order.payment_state === 'simulated_unknown')
          throw new KioskError('PAYMENT_UNKNOWN', 409);
        result = {
          ...order,
          version: order.version + 1,
          updated_at: iso(h.clock),
          ...(action === 'cancel'
            ? { state: 'cancelled', cancellation_reason: body.reason }
            : {
                payment_state: 'simulated_' + body.outcome,
                payment_attempt_id: randomUUID(),
                state: body.outcome === 'approved' ? 'preparing' : 'awaiting_test_payment',
              }),
        };
        h.orders.set(id, { token, order: result });
      }
      if (key && !previous)
        h.results.set(path + ':' + key, { body: clone(body), result: clone(result) });
      await h.after(request, result);
      return clone(result);
    },
  };
  h.core = () => new KioskController(h.io);
  h.count = (path) => h.requests.filter((r) => r.path === path);
  return h;
}
async function basket(h) {
  const c = h.core();
  assert.equal(await c.restore(), true);
  assert.equal(await c.start(), true);
  assert.equal(await c.setMode('takeaway'), true);
  const p = catalog.products[0];
  assert.equal(await c.addToCart(p.id, defaultSelections(p)), true);
  return c;
}

// These tests use in-memory storage and a synthetic HTTP boundary, never actual network.
test('complete catalog/options become a durable kiosk quote and approved kitchen order, then a clean guest', async () => {
  const h = fixture(),
    c = await basket(h);
  assert.equal(c.getSnapshot().catalog.products.length, 24);
  assert.equal(h.sessions.length, 0);
  assert.equal(await c.beginPayment('card'), true);
  assert.equal(c.getSnapshot().step, 'payment');
  const order = c.getSnapshot().order;
  assert.equal(order.snapshot.channel, 'kiosk');
  assert.equal(order.snapshot.payment_method, 'card');
  assert.deepEqual(
    order.snapshot.lines[0].selections.map(({ group_id, option_id, quantity }) => ({
      group_id,
      option_id,
      quantity,
    })),
    JSON.parse(h.rawFlow).cart[0].selections,
  );
  assert.equal(await c.pay('approved'), true);
  assert.equal(c.getSnapshot().step, 'order');
  assert.equal(await c.newGuest(), true);
  assert.equal(h.rawSession, null);
  assert.equal(c.getSnapshot().step, 'start');
  assert.equal(c.getSnapshot().cart.length, 0);
  assert.equal(h.orders.get(order.order_id).order.state, 'preparing');
  assert.notEqual(KIOSK_SESSION_KEY, 'pickchick.test.customer.v1');
  assert.notEqual(KIOSK_FLOW_KEY, 'pickchick.mobile.preferences.v1');
  assert(!JSON.stringify(h.requests).includes('phone'));
  assert(!JSON.stringify(h.requests).includes('nickname'));
});

test('safe basket restart restores variants, preserves upsell and rejects invalid selections/limits', async () => {
  const h = fixture(),
    c = await basket(h);
  c.openUpsell();
  const p = catalog.products[0];
  assert.equal(await c.addToCart(p.id, defaultSelections(p)), true);
  assert.equal(c.getSnapshot().step, 'upsell');
  const before = h.rawFlow;
  assert.equal(await c.addToCart(p.id, []), false);
  assert.equal(await c.addToCart(p.id, defaultSelections(p), 20), false);
  assert.equal(h.rawFlow, before);
  const restored = h.core();
  await restored.restore();
  assert.equal(restored.getSnapshot().cart[0].quantity, 2);
  assert.equal(restored.getSnapshot().mode, 'takeaway');
  assert.equal(h.sessions.length, 0);
});

test('failed draft storage never starts HTTP or publishes an unsaved basket', async () => {
  const h = fixture(),
    c = await basket(h),
    before = h.rawFlow,
    count = h.requests.length;
  h.failWrite = true;
  assert.equal(
    await c.addToCart(catalog.products[0].id, defaultSelections(catalog.products[0])),
    false,
  );
  assert.equal(c.getSnapshot().cart[0].quantity, 1);
  assert.equal(h.rawFlow, before);
  assert.equal(h.requests.length, count);
  assert.equal(await c.beginPayment(), false);
  assert.equal(h.count('/quotes').length, 0);
  assert.equal(h.count('/orders').length, 0);
});

for (const lostPath of ['/quotes', '/orders'])
  test(
    'lost ' + lostPath + ' response survives restart without duplicate order or changed keys',
    async () => {
      const h = fixture(),
        c = await basket(h);
      let lose = true;
      h.after = async (r) => {
        if (lose && r.path === lostPath && r.body) {
          lose = false;
          throw Error('response lost');
        }
      };
      assert.equal(await c.beginPayment(), false);
      const saved = JSON.parse(h.rawFlow).pending;
      assert(saved);
      assert.equal(c.getSnapshot().recoveryRequired, true);
      assert.equal(await c.newGuest(), false);
      h.after = async () => {};
      const restored = h.core();
      await restored.restore();
      if (restored.getSnapshot().recoveryRequired) assert.equal(await restored.recover(), true);
      assert.equal(h.orders.size, 1);
      assert.equal(restored.getSnapshot().step, 'payment');
      const attempts = h.count(lostPath).filter((r) => r.body);
      if (attempts.length > 1) {
        assert.equal(attempts[0].key, attempts[1].key);
        assert.deepEqual(attempts[0].body, attempts[1].body);
      }
      assert.equal(JSON.parse(h.rawFlow).pending, null);
    },
  );

test('lost payment before commit retries the exact command after restart; competing outcome is blocked', async () => {
  const h = fixture(),
    c = await basket(h);
  await c.beginPayment();
  let lose = true;
  h.before = async (r) => {
    if (r.path.endsWith('/simulated-payment') && lose) {
      lose = false;
      throw Error('never reached server');
    }
  };
  assert.equal(await c.pay('approved'), false);
  const pending = JSON.parse(h.rawFlow).pending;
  assert.equal(await c.pay('declined'), false);
  assert.equal(await c.newGuest(), false);
  h.before = async () => {};
  const restored = h.core();
  await restored.restore();
  assert.equal(await restored.recover(), true);
  const requests = h.requests.filter((r) => r.path.endsWith('/simulated-payment'));
  assert.equal(requests.length, 2);
  assert.equal(requests[0].key, pending.key);
  assert.equal(requests[1].key, pending.key);
  assert.deepEqual(requests[0].body, requests[1].body);
  assert.equal(restored.getSnapshot().order.payment_state, 'simulated_approved');
});

test('lost committed payment is reconciled by read, without sending a second payment', async () => {
  const h = fixture(),
    c = await basket(h);
  await c.beginPayment();
  h.after = async (r) => {
    if (r.path.endsWith('/simulated-payment')) throw Error('lost after commit');
  };
  assert.equal(await c.pay('approved'), false);
  assert(JSON.parse(h.rawFlow).pending);
  h.after = async () => {};
  const restored = h.core();
  await restored.restore();
  assert.equal(restored.getSnapshot().order.payment_state, 'simulated_approved');
  assert.equal(restored.getSnapshot().recoveryRequired, false);
  assert.equal(h.requests.filter((r) => r.path.endsWith('/simulated-payment')).length, 1);
  assert.equal(await restored.newGuest(), true);
});

test('unknown payment survives idle/restart and can only unlock after authoritative operator resolution', async () => {
  const h = fixture(),
    c = await basket(h);
  await c.beginPayment();
  assert.equal(await c.pay('unknown'), true);
  assert.equal(c.getSnapshot().step, 'recovery');
  const raw = h.rawFlow;
  h.clock += 300000;
  await c.tick();
  assert.equal(h.rawFlow, raw);
  assert.equal(await c.newGuest(), false);
  assert.equal(await c.cancelOrder(), false);
  const restored = h.core();
  await restored.restore();
  assert.equal(await restored.recover(), false);
  assert.equal(await restored.newGuest(), false);
  const entry = [...h.orders.values()][0];
  entry.order = {
    ...entry.order,
    version: entry.order.version + 1,
    payment_state: 'simulated_approved',
    state: 'preparing',
  };
  await restored.refresh();
  assert.equal(restored.getSnapshot().recoveryRequired, false);
  assert.equal(await restored.newGuest(), true);
  assert.equal(h.orders.size, 1);
});

test('cancel persists exact intent and loss before commit retries without silently clearing guest', async () => {
  const h = fixture(),
    c = await basket(h);
  await c.beginPayment();
  h.before = async (r) => {
    if (r.path.endsWith('/cancel')) throw Error('cancel offline');
  };
  assert.equal(await c.cancelOrder(), false);
  const intent = JSON.parse(h.rawFlow).pending;
  assert.equal(await c.newGuest(), false);
  h.before = async () => {};
  const restarted = h.core();
  await restarted.restore();
  assert.equal(await restarted.recover(), true);
  const attempts = h.requests.filter((r) => r.path.endsWith('/cancel'));
  assert.equal(attempts[1].key, intent.key);
  assert.deepEqual(attempts[0].body, attempts[1].body);
  assert.equal(restarted.getSnapshot().order.state, 'cancelled');
  assert.equal(await restarted.newGuest(), true);
});

test('idle 90+15 clears only safe shopping draft; stay restarts timer, unpaid orders remain', async () => {
  const h = fixture(),
    c = await basket(h);
  h.clock += KIOSK_IDLE_MS - 1;
  await c.tick();
  assert.equal(c.getSnapshot().idleWarningSeconds, null);
  h.clock++;
  await c.tick();
  assert.equal(c.getSnapshot().idleWarningSeconds, 15);
  c.stay();
  assert.equal(c.getSnapshot().idleWarningSeconds, null);
  h.clock += KIOSK_IDLE_MS + KIOSK_IDLE_GRACE_MS;
  await c.tick();
  assert.equal(c.getSnapshot().step, 'start');
  assert.equal(c.getSnapshot().cart.length, 0);
  await c.start();
  await c.setMode('dine_in');
  await c.addToCart(catalog.products[0].id, defaultSelections(catalog.products[0]));
  await c.beginPayment();
  const raw = h.rawFlow;
  h.clock += 300000;
  await c.tick();
  assert.equal(h.rawFlow, raw);
  assert.equal(await c.newGuest(), false);
});

test('reset marker recovers removal failure and never affects kitchen order or reuses previous guest token', async () => {
  const h = fixture(),
    c = await basket(h);
  await c.beginPayment();
  await c.pay('approved');
  const token = JSON.parse(h.rawSession).token;
  h.failRemove = true;
  assert.equal(await c.newGuest(), false);
  assert.equal(JSON.parse(h.rawFlow).resetPending, true);
  assert.equal(JSON.parse(h.rawSession).token, token);
  h.failRemove = false;
  const restarted = h.core();
  assert.equal(await restarted.restore(), true);
  assert.equal(restarted.getSnapshot().step, 'start');
  assert.equal(h.rawSession, null);
  assert.equal(h.orders.size, 1);
  await restarted.start();
  await restarted.setMode('takeaway');
  await restarted.addToCart(catalog.products[0].id, defaultSelections(catalog.products[0]));
  await restarted.beginPayment();
  assert.notEqual(JSON.parse(h.rawSession).token, token);
  assert.equal(h.orders.size, 2);
});

test('temporary storage read failure and missing token never discard pending state or create replacement identity', async () => {
  const h = fixture(),
    c = await basket(h);
  h.after = async (r) => {
    if (r.path === '/quotes') throw Error('lost');
  };
  await c.beginPayment();
  const before = h.rawFlow;
  h.failRead = true;
  let restarted = h.core();
  assert.equal(await restarted.restore(), false);
  assert.equal(await restarted.newGuest(), false);
  assert.equal(h.rawFlow, before);
  h.failRead = false;
  h.rawSession = null;
  restarted = h.core();
  assert.equal(await restarted.restore(), false);
  assert.equal(restarted.getSnapshot().recoveryRequired, true);
  assert.equal(await restarted.recover(), false);
  assert.equal(h.sessions.length, 1);
  assert.equal(h.rawFlow, before);
});

test('existing session with missing draft and unreadable order history cannot become a new guest', async () => {
  const h = fixture(),
    c = await basket(h);
  await c.beginPayment();
  h.rawFlow = null;
  h.before = async (r) => {
    if (r.path === '/orders' && !r.body) throw Error('offline');
  };
  const restarted = h.core();
  assert.equal(await restarted.restore(), false);
  assert.equal(restarted.getSnapshot().recoveryRequired, true);
  assert.equal(await restarted.newGuest(), false);
  assert.equal(h.sessions.length, 1);
  h.before = async () => {};
  assert.equal(await restarted.recover(), true);
  assert.equal(restarted.getSnapshot().order.order_id, [...h.orders.keys()][0]);
});

test('stale order poll cannot roll back a confirmed state/version or re-enable payment', async () => {
  const h = fixture(),
    c = await basket(h);
  await c.beginPayment();
  const old = clone(c.getSnapshot().order);
  await c.pay('approved');
  const fresh = clone(c.getSnapshot().order);
  h.orders.get(old.order_id).order = old;
  await c.refresh();
  assert.deepEqual(c.getSnapshot().order, fresh);
  assert.equal(c.getSnapshot().step, 'order');
  assert.equal(await c.pay('approved'), false);
});

test('expired quote replaces intent only after a definitive rejection; transport retries keep original keys', async () => {
  const h = fixture(),
    c = await basket(h);
  let fail = true;
  h.before = async (r) => {
    if (r.path === '/orders' && r.body && fail) {
      fail = false;
      throw Error('not committed');
    }
  };
  await c.beginPayment();
  const original = JSON.parse(h.rawFlow).pending;
  h.clock += 300001;
  h.before = async () => {};
  assert.equal(await c.recover(), false);
  const renewed = JSON.parse(h.rawFlow).pending;
  assert.notEqual(renewed.quoteKey, original.quoteKey);
  assert.notEqual(renewed.orderKey, original.orderKey);
  assert.equal(renewed.quoteId, null);
  assert.equal(await c.recover(), true);
  assert.equal(h.orders.size, 1);
});

test('HTTP adapter only targets kiosk TEST v3, guards redirects and performs no automatic retries', async () => {
  const calls = [];
  const fake = async (url, options) => {
    calls.push({ url, options });
    return Response.json({ ok: true });
  };
  await kioskRequest('/sessions', undefined, { channel: 'kiosk' }, undefined, fake);
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    'https://pickchick.185.129.51.103.nip.io/v1/test/sessions?catalog_version=mockup-v0.3&number_format=daily',
  );
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.credentials, 'omit');
  await assert.rejects(
    kioskRequest('https://other.invalid', undefined, undefined, undefined, fake),
  );
  assert.equal(calls.length, 1);
  await assert.rejects(
    kioskRequest('/orders', 'a'.repeat(64), undefined, undefined, async () => {
      throw Error('network');
    }),
    { code: 'NETWORK_UNCERTAIN' },
  );
});

test('token saved but guest binding write failed repairs the boundary before persisting a create intent', async () => {
  const h = fixture(),
    c = await basket(h);
  const original = h.io.writeFlow;
  let fail = true;
  h.io.writeFlow = async (raw) => {
    const flow = JSON.parse(raw);
    if (fail && flow.guestId && !flow.pending) {
      fail = false;
      throw Error('guest binding failed');
    }
    await original(raw);
  };
  assert.equal(await c.beginPayment(), false);
  assert(h.rawSession);
  assert.equal(JSON.parse(h.rawFlow).guestId, null);
  assert.equal(h.count('/quotes').length, 0);
  assert.equal(await c.beginPayment(), true);
  assert.equal(JSON.parse(h.rawFlow).guestId, JSON.parse(h.rawSession).session_id);
  assert.equal(h.sessions.length, 1);
  const restarted = h.core();
  assert.equal(await restarted.restore(), true);
  assert.equal(restarted.getSnapshot().order.order_id, c.getSnapshot().order.order_id);
});

test('missing SKU after catalog change stays visibly unavailable and removable, never becomes a smaller quoted cart', async () => {
  const h = fixture(),
    c = await basket(h);
  const missing = c.getSnapshot().cart[0];
  h.catalog.products = h.catalog.products.filter((p) => p.id !== missing.productId);
  assert.equal(await c.beginPayment(), false);
  assert.equal(h.sessions.length, 0);
  assert.equal(c.getSnapshot().cartValid, false);
  assert.deepEqual(c.getSnapshot().unavailableCartLines, [
    { lineId: missing.lineId, productId: missing.productId, quantity: 1 },
  ]);
  assert.equal(JSON.parse(h.rawFlow).cart.length, 1);
  assert.equal(await c.updateQuantity(missing.lineId, 0), true);
  assert.equal(c.getSnapshot().cartValid, true);
  assert.equal(c.getSnapshot().unavailableCartLines.length, 0);
  const next = h.catalog.products[0];
  assert.equal(await c.addToCart(next.id, defaultSelections(next)), true);
  assert.equal(await c.beginPayment(), true);
});

test('catalog-only outage can recover without creating an unused guest session; catalog refresh checks changed price before quote', async () => {
  const h = fixture();
  h.before = async (r) => {
    if (r.path === '/catalog') throw Error('catalog offline');
  };
  const c = h.core();
  assert.equal(await c.restore(), true);
  assert.equal(c.getSnapshot().catalog, null);
  h.before = async () => {};
  assert.equal(await c.recover(), true);
  assert.equal(h.sessions.length, 0);
  assert(c.getSnapshot().catalog);
  await c.start();
  await c.setMode('takeaway');
  const p = h.catalog.products[0];
  await c.addToCart(p.id, defaultSelections(p));
  const oldPrice = c.getSnapshot().cart[0].unitPriceMinor;
  h.catalog.products[0].price_minor = (BigInt(p.price_minor) + 10000n).toString();
  await c.beginPayment();
  assert.equal(
    c.getSnapshot().order.snapshot.lines[0].price_minor,
    (BigInt(oldPrice) + 10000n).toString(),
  );
});

test('catalog refresh keeps current product and selection while ordinary touch does not rerender root', async () => {
  const h = fixture(),
    c = await basket(h);
  c.openProduct(catalog.products[0].id);
  let renders = 0;
  const off = c.subscribe(() => renders++);
  for (let i = 0; i < 100; i++) c.touch();
  assert.equal(renders, 0);
  h.catalog.products[0].description = 'Changed synthetic description';
  h.clock += 60000;
  await c.refresh();
  assert.equal(c.getSnapshot().step, 'product');
  assert.equal(c.getSnapshot().selectedProduct.description, 'Changed synthetic description');
  h.clock += KIOSK_IDLE_MS - 60000;
  await c.tick();
  const count = renders;
  c.stay();
  assert.equal(renders, count + 1);
  assert.equal(c.getSnapshot().idleWarningSeconds, null);
  off();
});

test('authoritative invalid quote returns to editable cart; no order was attempted', async () => {
  const h = fixture(),
    c = await basket(h);
  h.before = async (r) => {
    if (r.path === '/quotes') throw new KioskError('INVALID_REQUEST', 400);
  };
  assert.equal(await c.beginPayment(), false);
  assert.equal(c.getSnapshot().recoveryRequired, false);
  assert.equal(c.getSnapshot().step, 'cart');
  assert.equal(JSON.parse(h.rawFlow).pending, null);
  assert.equal(h.count('/orders').filter((r) => r.body).length, 0);
  assert.equal(await c.updateQuantity(c.getSnapshot().cart[0].lineId, 0), true);
  assert.equal(await c.newGuest(), true);
});

test('reset final write failure resumes from marker even after the secure token has been deleted', async () => {
  const h = fixture(),
    c = await basket(h);
  await c.beginPayment();
  await c.pay('approved');
  const original = h.io.writeFlow;
  let fail = true;
  h.io.writeFlow = async (raw) => {
    if (fail && h.rawSession === null && JSON.parse(raw).guestId === null) {
      fail = false;
      throw Error('empty state write failed');
    }
    await original(raw);
  };
  assert.equal(await c.newGuest(), false);
  assert.equal(h.rawSession, null);
  assert.equal(JSON.parse(h.rawFlow).resetPending, true);
  const restarted = h.core();
  assert.equal(await restarted.restore(), true);
  assert.equal(restarted.getSnapshot().step, 'start');
  assert.equal(restarted.getSnapshot().order, null);
  assert.equal(h.orders.size, 1);
});

test('pending payment can recover while the separate catalog endpoint remains unavailable', async () => {
  const h = fixture(),
    c = await basket(h);
  await c.beginPayment();
  let lose = true;
  h.before = async (r) => {
    if (lose && r.path.endsWith('/simulated-payment')) {
      lose = false;
      throw Error('lost before apply');
    }
  };
  await c.pay('approved');
  h.before = async (r) => {
    if (r.path === '/catalog') throw Error('catalog unavailable');
  };
  const restarted = h.core();
  await restarted.restore();
  assert.equal(restarted.getSnapshot().catalog, null);
  assert.equal(await restarted.recover(), true);
  assert.equal(restarted.getSnapshot().order.payment_state, 'simulated_approved');
  assert.equal(await restarted.newGuest(), true);
});

test('corrupt command value cannot override saved version or mutate the original intent', async () => {
  const h = fixture(),
    c = await basket(h);
  await c.beginPayment();
  h.before = async (r) => {
    if (r.path.endsWith('/simulated-payment')) throw Error('offline before apply');
  };
  await c.pay('approved');
  const flow = JSON.parse(h.rawFlow);
  flow.pending.value.expected_version = 100;
  h.rawFlow = JSON.stringify(flow);
  const raw = h.rawFlow,
    requests = h.requests.length,
    restarted = h.core();
  assert.equal(await restarted.restore(), false);
  assert.equal(await restarted.recover(), false);
  assert.equal(await restarted.newGuest(), false);
  assert.equal(h.rawFlow, raw);
  assert.equal(h.requests.length, requests);
  assert.equal(h.sessions.length, 1);
  assert.equal(restarted.getSnapshot().recoveryRequired, true);
});
