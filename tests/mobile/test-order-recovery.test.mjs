import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  TestCustomerCore,
  TestApiError,
  DRAFT_KEY,
  COMMAND_KEY,
  cartMatchesOrder,
  mergeObservedOrder,
  mergeObservedOrders,
} from '../../apps/mobile/src/test-order-session.ts';

// Deterministic in-memory server/storage boundaries. These tests exercise the actual
// mobile recovery core; the API and PostgreSQL invariants have separate integration tests.
const synthetic = { synthetic: true, namespace: 'pickchick-test' };
const branch = '10000000-0000-4000-8000-000000000003';
const now = Date.parse('2026-09-06T10:00:00Z');
const iso = (milliseconds) => new Date(milliseconds).toISOString();
const cart = (id = 'test-burger', quantity = 1) => [{ product: { id }, quantity }];
const payload = (id = 'test-burger', quantity = 1) => ({
  catalog_version: 'mockup-v0.2',
  service_mode: 'takeaway',
  items: [{ product_id: id, quantity }],
});
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const failure = (code) => (error) => error instanceof TestApiError && error.code === code;

function harness() {
  const session = {
    ...synthetic,
    session_id: randomUUID(),
    token: 'a'.repeat(64),
    expires_at: iso(now + 7_200_000),
    channel: 'mobile',
  };
  const h = {
    session,
    storedSession: null,
    storage: new Map(),
    requests: [],
    quotes: new Map(),
    orders: new Map(),
    results: new Map(),
    clock: now,
    before: async () => {},
    after: async () => {},
    readSession: async () => h.storedSession,
  };
  h.request = async (path, token, body, key) => {
    const request = { path, token, body: globalThis.structuredClone(body), key };
    h.requests.push(request);
    await h.before(request);
    if (path !== '/sessions') assert.equal(token, session.token, 'restored customer identity');
    const resultKey = `${path}:${key}`;
    const previous = key ? h.results.get(resultKey) : undefined;
    let result;
    if (previous) {
      assert.deepEqual(body, previous.body, 'idempotency must replay the original payload');
      result = previous.result;
    } else if (path === '/sessions') {
      result = session;
    } else if (path === '/quotes') {
      const lines = body.items.map(({ product_id, quantity }) => ({
        id: product_id,
        name: product_id,
        description: 'Synthetic fixture',
        category: 'Test',
        price_minor: '349000',
        image_id: 'i7.jpg',
        prep_required: true,
        quantity,
        line_total_minor: String(349000 * quantity),
      }));
      result = {
        ...synthetic,
        quote_id: randomUUID(),
        branch_id: branch,
        catalog_version: 'mockup-v0.2',
        channel: 'mobile',
        service_mode: body.service_mode,
        currency: 'KZT',
        total_minor: String(lines.reduce((sum, line) => sum + Number(line.line_total_minor), 0)),
        lines,
        created_at: iso(h.clock),
        expires_at: iso(h.clock + 300_000),
      };
      h.quotes.set(result.quote_id, result);
    } else if (path === '/orders' && body) {
      const quote = h.quotes.get(body.quote_id);
      assert.ok(quote, 'quote must exist before creation');
      if (Date.parse(quote.expires_at) <= h.clock) throw new TestApiError(409, 'QUOTE_EXPIRED');
      result = {
        ...synthetic,
        order_id: randomUUID(),
        number: `T-${String(h.orders.size + 1).padStart(6, '0')}`,
        branch_id: branch,
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
      h.orders.set(result.order_id, result);
    } else if (path === '/orders') {
      result = { ...synthetic, orders: [...h.orders.values()] };
    } else {
      const [, , orderId, action] = path.split('/');
      const order = h.orders.get(orderId);
      assert.ok(order, 'order must exist');
      if (!action) result = order;
      else {
        if (order.version !== body.expected_version)
          throw new TestApiError(409, 'VERSION_CONFLICT');
        if (order.payment_state === 'simulated_unknown')
          throw new TestApiError(409, 'PAYMENT_UNKNOWN');
        result = {
          ...order,
          version: order.version + 1,
          updated_at: iso(h.clock),
          ...(action === 'cancel'
            ? { state: 'cancelled', cancellation_reason: body.reason }
            : {
                payment_state: `simulated_${body.outcome}`,
                payment_attempt_id: randomUUID(),
                state: body.outcome === 'approved' ? 'preparing' : 'awaiting_test_payment',
              }),
        };
        h.orders.set(orderId, result);
      }
    }
    if (key && !previous)
      h.results.set(resultKey, {
        body: globalThis.structuredClone(body),
        result: globalThis.structuredClone(result),
      });
    await h.after(request, result);
    return globalThis.structuredClone(result);
  };
  h.client = () =>
    new TestCustomerCore({
      readSession: () => h.readSession(),
      saveSession: async (raw) => {
        h.storedSession = raw;
      },
      read: async (key) => h.storage.get(key) ?? null,
      write: async (key, raw) => {
        h.storage.set(key, raw);
      },
      remove: async (key) => {
        h.storage.delete(key);
      },
      request: h.request,
      uuid: randomUUID,
      now: () => h.clock,
    });
  h.count = (path) => h.requests.filter((request) => request.path === path);
  h.persistSession = () => {
    h.storedSession = JSON.stringify(session);
  };
  return h;
}

test('authentication waits for an in-flight restore and never replaces a saved customer', async () => {
  const h = harness();
  const gate = deferred();
  h.persistSession();
  let reads = 0;
  h.readSession = async () => {
    reads++;
    await gate.promise;
    return h.storedSession;
  };
  const client = h.client();
  const restore = client.restore();
  const create = client.create(cart(), 'takeaway');
  await Promise.resolve();
  assert.equal(h.requests.length, 0);
  gate.resolve();
  await Promise.all([restore, create]);
  assert.equal(reads, 1);
  assert.equal(h.count('/sessions').length, 0);
  assert.equal(h.orders.size, 1);
});

test('double submit shares one persisted intent; a different concurrent basket cannot replace it', async () => {
  const h = harness();
  const gate = deferred();
  h.before = async (request) => {
    if (request.path === '/quotes') await gate.promise;
  };
  const client = h.client();
  const first = client.create(cart(), 'takeaway');
  const second = client.create(cart(), 'takeaway');
  assert.equal(first, second);
  await assert.rejects(
    client.create(cart('test-fries'), 'takeaway'),
    failure('COMMAND_IN_PROGRESS'),
  );
  gate.resolve();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.order_id, b.order_id);
  assert.equal(h.count('/sessions').length, 1);
  assert.equal(h.count('/quotes').length, 1);
  assert.equal(h.orders.size, 1);
});

test('lost quote response survives restart and replays the exact quote and order keys', async () => {
  const h = harness();
  let drop = true;
  h.after = async (request) => {
    if (request.path === '/quotes' && drop) {
      drop = false;
      throw new TypeError('connection lost');
    }
  };
  await assert.rejects(h.client().create(cart(), 'takeaway'), /connection lost/);
  const intent = JSON.parse(h.storage.get(DRAFT_KEY));
  assert.equal(intent.quoteId, null);
  const order = await h.client().recoverPending();
  assert.equal(order.snapshot.quote_id, [...h.quotes.keys()][0]);
  assert.deepEqual(
    h.count('/quotes').map((request) => request.key),
    [intent.quoteKey, intent.quoteKey],
  );
  assert.equal(h.count('/orders')[0].key, intent.orderKey);
  assert.equal(h.quotes.size, 1);
  assert.equal(h.orders.size, 1);
  assert.equal(h.storage.has(DRAFT_KEY), false);
});

test('lost committed order response is reconciled by history after restart, unlocking the next cart', async () => {
  const h = harness();
  let drop = true;
  h.after = async (request) => {
    if (request.path === '/orders' && request.body && drop) {
      drop = false;
      throw new TypeError('connection lost');
    }
  };
  await assert.rejects(h.client().create(cart(), 'takeaway'), /connection lost/);
  assert.equal(h.storage.has(DRAFT_KEY), true);
  const restarted = h.client();
  const orders = await restarted.orders();
  assert.equal(orders.length, 1);
  assert.equal(h.storage.has(DRAFT_KEY), false);
  await restarted.create(cart('test-fries'), 'takeaway');
  assert.equal(h.orders.size, 2);
  assert.equal(h.count('/sessions').length, 1);
});

test('unanswered order request before commit retries the same intent after restart', async () => {
  const h = harness();
  let drop = true;
  h.before = async (request) => {
    if (request.path === '/orders' && request.body && drop) {
      drop = false;
      throw new TypeError('timeout');
    }
  };
  await assert.rejects(h.client().create(cart(), 'takeaway'), /timeout/);
  const intent = JSON.parse(h.storage.get(DRAFT_KEY));
  assert.equal(h.orders.size, 0);
  await h.client().recoverPending();
  assert.deepEqual(
    h.count('/orders').map((request) => request.key),
    [intent.orderKey, intent.orderKey],
  );
  assert.equal(h.orders.size, 1);
  assert.equal(h.quotes.size, 1);
});

test('only an authoritative quote-expired rejection permits a new quote and order intent', async () => {
  const h = harness();
  let expire = true;
  h.before = async (request) => {
    if (request.path === '/orders' && request.body && expire) {
      expire = false;
      h.clock += 300_001;
    }
  };
  await h.client().create(cart(), 'takeaway');
  const requests = h.count('/orders');
  assert.equal(requests.length, 2);
  assert.notEqual(requests[0].key, requests[1].key);
  assert.notEqual(requests[0].body.quote_id, requests[1].body.quote_id);
  assert.equal(h.quotes.size, 2);
  assert.equal(h.orders.size, 1);
});

test('a committed order replays after quote expiry without creating a second order', async () => {
  const h = harness();
  let drop = true;
  h.after = async (request) => {
    if (request.path === '/orders' && request.body && drop) {
      drop = false;
      throw new TypeError('timeout');
    }
  };
  await assert.rejects(h.client().create(cart(), 'takeaway'), /timeout/);
  h.clock += 300_001;
  await h.client().recoverPending();
  assert.equal(h.orders.size, 1);
  assert.equal(h.quotes.size, 1);
  assert.equal(new Set(h.count('/orders').map((request) => request.key)).size, 1);
});

test('legacy v1 recovery preserves the original unsorted quote payload for its existing key', async () => {
  const h = harness();
  h.persistSession();
  const original = {
    ...payload(),
    items: [
      { product_id: 'z', quantity: 1 },
      { product_id: 'a', quantity: 2 },
    ],
  };
  const quoteKey = randomUUID();
  const orderKey = randomUUID();
  await h.request('/quotes', h.session.token, original, quoteKey);
  h.storage.set(
    DRAFT_KEY,
    JSON.stringify({
      version: 1,
      sessionId: h.session.session_id,
      fingerprint: JSON.stringify(original),
      quoteKey,
      orderKey,
      quoteId: null,
    }),
  );
  await h.client().create([...cart('a', 2), ...cart('z')], 'takeaway');
  assert.equal(h.quotes.size, 1);
  assert.deepEqual(h.count('/quotes')[1].body, original);
  assert.equal(h.count('/orders')[0].key, orderKey);
});

test('lost simulated approval response is reconciled without another payment command', async () => {
  const h = harness();
  const client = h.client();
  const order = await client.create(cart(), 'takeaway');
  let drop = true;
  const path = `/orders/${order.order_id}/simulated-payment`;
  h.after = async (request) => {
    if (request.path === path && drop) {
      drop = false;
      throw new TypeError('timeout');
    }
  };
  await assert.rejects(
    client.command(order, 'simulated-payment', { outcome: 'approved' }),
    /timeout/,
  );
  assert.equal(h.storage.has(COMMAND_KEY), true);
  const restarted = h.client();
  const [observed] = await restarted.orders();
  assert.equal(observed.payment_state, 'simulated_approved');
  assert.equal(observed.version, 2);
  assert.equal(h.storage.has(COMMAND_KEY), false);
  assert.equal(h.count(path).length, 1);
});

test('unknown simulated result stays unresolved after a lost response and restart', async () => {
  const h = harness();
  const client = h.client();
  const order = await client.create(cart(), 'takeaway');
  const path = `/orders/${order.order_id}/simulated-payment`;
  h.after = async (request) => {
    if (request.path === path) throw new TypeError('timeout');
  };
  await assert.rejects(
    client.command(order, 'simulated-payment', { outcome: 'unknown' }),
    /timeout/,
  );
  const observed = await h.client().recoverPending();
  assert.equal(observed.payment_state, 'simulated_unknown');
  assert.equal(observed.state, 'awaiting_test_payment');
  assert.equal(h.count(path).length, 1);
  assert.equal(h.storage.has(COMMAND_KEY), false);
});

test('an unapplied lost command recovers its original key; competing commands remain blocked', async () => {
  const h = harness();
  const client = h.client();
  const order = await client.create(cart(), 'takeaway');
  const path = `/orders/${order.order_id}/simulated-payment`;
  let drop = true;
  h.before = async (request) => {
    if (request.path === path && drop) {
      drop = false;
      throw new TypeError('timeout');
    }
  };
  await assert.rejects(
    client.command(order, 'simulated-payment', { outcome: 'approved' }),
    /timeout/,
  );
  const key = JSON.parse(h.storage.get(COMMAND_KEY)).key;
  const restarted = h.client();
  await assert.rejects(
    restarted.command(order, 'cancel', { reason: 'test cleanup' }),
    failure('PREVIOUS_COMMAND_PENDING'),
  );
  await assert.rejects(
    restarted.create(cart('test-fries'), 'takeaway'),
    failure('PREVIOUS_COMMAND_PENDING'),
  );
  const observed = await restarted.recoverPending();
  assert.equal(observed.version, 2);
  assert.deepEqual(
    h.count(path).map((request) => request.key),
    [key, key],
  );
});

test('expired, missing or corrupt customer identity never creates a replacement session for pending work', async () => {
  for (const kind of ['expired', 'missing', 'corrupt']) {
    const h = harness();
    let drop = true;
    h.before = async (request) => {
      if (request.path === '/quotes' && drop) {
        drop = false;
        throw new TypeError('timeout');
      }
    };
    await assert.rejects(h.client().create(cart(), 'takeaway'), /timeout/);
    if (kind === 'expired') h.clock += 7_200_001;
    if (kind === 'missing') h.storedSession = null;
    if (kind === 'corrupt') h.storedSession = '{';
    const previousRequests = h.requests.length;
    await assert.rejects(
      h.client().recoverPending(),
      failure(
        {
          expired: 'SESSION_EXPIRED',
          missing: 'PREVIOUS_SESSION_PENDING',
          corrupt: 'STORED_SESSION_INVALID',
        }[kind],
      ),
    );
    assert.equal(h.requests.length, previousRequests, kind);
    assert.equal(h.count('/sessions').length, 1, kind);
    assert.equal(h.storage.has(DRAFT_KEY), true, kind);
  }
});

test('corrupt saved intent fails closed and cannot be replaced by a fresh cart', async () => {
  const h = harness();
  h.persistSession();
  for (const raw of ['{', JSON.stringify({ version: [2] }), 'x'.repeat(20_001)]) {
    h.storage.set(DRAFT_KEY, raw);
    await assert.rejects(h.client().create(cart(), 'takeaway'), failure('RECOVERY_DATA_INVALID'));
    assert.equal(h.storage.get(DRAFT_KEY), raw);
  }
  assert.equal(h.requests.length, 0);
});

test('unmatched cart cannot overwrite a saved draft but explicit recovery can resolve it', async () => {
  const h = harness();
  let drop = true;
  h.before = async (request) => {
    if (request.path === '/orders' && request.body && drop) {
      drop = false;
      throw new TypeError('timeout');
    }
  };
  await assert.rejects(h.client().create(cart(), 'takeaway'), /timeout/);
  const saved = h.storage.get(DRAFT_KEY);
  const restarted = h.client();
  await assert.rejects(
    restarted.create(cart('test-fries'), 'takeaway'),
    failure('PREVIOUS_ORDER_PENDING'),
  );
  assert.equal(h.storage.get(DRAFT_KEY), saved);
  const recovered = await restarted.recoverPending();
  assert.equal(recovered.snapshot.lines[0].id, 'test-burger');
});

test('order observations are monotonic and checkout resumes only the matching basket and mode', async () => {
  const h = harness();
  const order = await h.client().create(cart(), 'takeaway');
  const ready = { ...order, version: 4, state: 'ready', payment_state: 'simulated_approved' };
  assert.deepEqual(mergeObservedOrder([ready], order), [ready]);
  assert.deepEqual(mergeObservedOrders([ready], [order]), [ready]);
  assert.equal(cartMatchesOrder(order, cart(), 'takeaway'), true);
  assert.equal(cartMatchesOrder(order, cart(), 'dine_in'), false);
  assert.equal(cartMatchesOrder(order, cart('test-fries'), 'takeaway'), false);
  assert.equal(cartMatchesOrder(order, cart('test-burger', 2), 'takeaway'), false);
  assert.equal(cartMatchesOrder(order, [], 'takeaway'), false);
});
