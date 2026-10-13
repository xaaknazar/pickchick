// Owner decision 2026-10-13: «Начать заново» on the Kaspi QR. The kiosk starts over for the next
// guest; the QR is not revoked and the server keeps the order (a late payment is still captured).
// The abandoned guest's session is ended in the background once the server allows it.
// Synthetic fixtures only: no network, bank, kitchen or device is involved.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  CommercialKioskController,
  MAX_ABANDONED_GUESTS,
  abandonedRetryMs,
} from '../../apps/kiosk/src/commercial-controller.ts';
import { KioskError } from '../../apps/kiosk/src/api.ts';
import { createDemoKiosk } from '../../apps/kiosk/src/demo.ts';
import { paymentCopy, paymentCopyForTest } from '../../apps/kiosk/src/paymentCopy.ts';
import { cart, fixture } from './commercial-fixture.mjs';

const QR = 'https://qr.kaspi.kz/fixture';
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const stored = (h) => JSON.parse(h.rawFlow);
const currentToken = (h) => (h.rawSession ? JSON.parse(h.rawSession).token : null);

/**
 * The shared commercial fixture plus abandoned guests: /sessions/end with a token that is not
 * the current guest's answers from `h.endAnswers` (CONFLICT, NETWORK, FORBIDDEN, ok).
 */
function restartFixture() {
  const h = fixture();
  const base = h.io.request;
  h.endAnswers = [];
  h.abandonedEnds = [];
  h.io.request = async (path, token, body, key) => {
    if (path === '/sessions/end' && token && token !== currentToken(h)) {
      h.calls.push({ path, token, body, key, abandoned: true });
      h.abandonedEnds.push(token);
      const answer = h.endAnswers.shift() ?? 'ok';
      if (answer === 'CONFLICT') throw new KioskError('CONFLICT', 409);
      if (answer === 'NETWORK') throw new KioskError('NETWORK_UNCERTAIN');
      if (answer === 'FORBIDDEN') throw new KioskError('FORBIDDEN', 403);
      return { ended: true };
    }
    return base(path, token, body, key);
  };
  return h;
}
/** A guest at the Kaspi QR: the order waits for the scan (payment state `state`). */
async function atQr(h, state = 'pending') {
  const c = await cart(h);
  assert.equal(await c.beginPayment(), true);
  h.order = {
    ...h.order,
    payment: {
      kind: 'kaspi_qr',
      state,
      qrPayload: state === 'pending' ? QR : null,
      expiresAt: state === 'pending' ? new Date(h.clock + 180000).toISOString() : null,
    },
  };
  assert.equal(await c.refresh(), true);
  assert.equal(c.getSnapshot().step, 'payment');
  return c;
}
/** The next guest on the same kiosk orders again; the server creates a new order. */
async function nextGuest(h, c) {
  h.order = null;
  assert.equal(await c.start(), true);
  assert.equal(await c.setMode('takeaway'), true);
  const product = c.getSnapshot().catalog.products[0];
  const selections = product.modifier_groups.flatMap((g) =>
    g.options
      .filter((o) => o.default_quantity > 0)
      .map((o) => ({ group_id: g.id, option_id: o.id, quantity: o.default_quantity })),
  );
  assert.equal(await c.addToCart(product.id, selections), true);
  c.goLoyalty();
  assert.equal(await c.beginPayment(), true);
}
const abandonedGuest = () => ({
  sessionId: randomUUID(),
  token: 'e'.repeat(64),
  expiresAt: '2026-10-04T01:00:00.000Z',
});

test('«Начать заново» is offered only for a Kaspi QR order being prepared or waiting', async () => {
  // Shopping: no order yet, nothing to start over from.
  const h = restartFixture();
  const shopping = await cart(h);
  assert.notEqual(shopping.getSnapshot().canStartOver, true);
  assert.equal(await shopping.startOver(), false);

  for (const state of ['pending', 'preparing']) {
    const ok = restartFixture();
    const c = await atQr(ok, state);
    assert.equal(c.getSnapshot().canStartOver, true, state);
  }

  const blocked = [
    ['payment checking', (o) => ({ ...o, payment: { ...o.payment, state: 'checking' } })],
    ['payment state paid', (o) => ({ ...o, payment: { ...o.payment, state: 'paid' } })],
    ['order checking', (o) => ({ ...o, phase: 'checking' })],
    ['order attention', (o) => ({ ...o, phase: 'attention' })],
    ['paid', (o) => ({ ...o, phase: 'paid' })],
    ['failed', (o) => ({ ...o, phase: 'failed', payment: { ...o.payment, state: 'failed' } })],
  ];
  for (const [name, change] of blocked) {
    const b = restartFixture();
    const c = await atQr(b);
    b.order = change(b.order);
    await c.refresh();
    assert.equal(c.getSnapshot().canStartOver, false, name);
    const order = c.getSnapshot().order;
    const before = b.calls.length;
    assert.equal(await c.startOver(), false, name);
    // A refused restart changes nothing and sends nothing but a status read.
    assert.deepEqual(c.getSnapshot().order, order, name);
    assert.ok(
      b.calls.slice(before).every((r) => r.path === `/orders/${order.order_id}` && !r.body),
      name,
    );
    assert.notEqual(stored(b).order, null, name);
  }

  // A stored intent (the payment answer was lost) stays with recovery.
  const lost = restartFixture();
  const withIntent = await cart(lost);
  lost.failPath = 'payment';
  assert.equal(await withIntent.beginPayment(), false);
  assert.ok(stored(lost).intent);
  assert.notEqual(withIntent.getSnapshot().canStartOver, true);
  assert.equal(await withIntent.startOver(), false);
  assert.ok(stored(lost).intent);

  // A Kaspi invoice is not a QR.
  const invoice = restartFixture();
  invoice.paymentMethods = ['kaspi_qr', 'kaspi_invoice'];
  const phone = await cart(invoice);
  phone.setPaymentMethod('kaspi_invoice');
  phone.setInvoicePhone('8 (701) 123-45-67');
  assert.equal(await phone.beginPayment(), true);
  assert.equal(phone.getSnapshot().paymentMethod, 'kaspi_invoice');
  assert.equal(phone.getSnapshot().canStartOver, false);
  assert.equal(await phone.startOver(), false);

  // A paid order read just before the restart shows its number instead.
  const late = restartFixture();
  const paying = await atQr(late);
  late.order = { ...late.order, phase: 'paid', payment: { ...late.order.payment, state: 'paid' } };
  assert.equal(await paying.startOver(), false);
  assert.equal(paying.getSnapshot().step, 'order');
  assert.equal(paying.getSnapshot().order.payment_state, 'paid');
  assert.equal(stored(late).abandoned, undefined);
});

test('restart clears cart, mode and order, unbinds the guest and shows the start screen', async () => {
  const h = restartFixture();
  const c = await atQr(h);
  const guest = JSON.parse(h.rawSession);
  const orderId = c.getSnapshot().order.order_id;
  const before = h.calls.length;
  assert.equal(await c.startOver(), true);
  const view = c.getSnapshot();
  assert.equal(view.step, 'start');
  assert.equal(view.order, null);
  assert.equal(view.qrPayment, null);
  assert.equal(view.mode, null);
  assert.deepEqual(view.cart, []);
  assert.equal(view.recoveryRequired, false);
  assert.equal(view.canStartOver, false);
  assert.equal(view.error, null);
  // The guest's credential is gone locally and remembered only to end its session.
  assert.equal(h.rawSession, null);
  const flow = stored(h);
  assert.equal(flow.guestId, null);
  assert.equal(flow.order, null);
  assert.equal(flow.intent, null);
  assert.equal(flow.mode, null);
  assert.deepEqual(flow.cart, []);
  assert.equal(flow.resetPending, false);
  assert.deepEqual(flow.abandoned, [
    { sessionId: guest.sessionId, token: guest.token, expiresAt: guest.expiresAt },
  ]);
  // Only the last status read: nothing is cancelled, paid or ended in the guest's way.
  assert.deepEqual(
    h.calls.slice(before).map((r) => [r.path, r.body]),
    [[`/orders/${orderId}`, undefined]],
  );
  // The order is still the server's: the kiosk neither revoked the QR nor paid it.
  assert.equal(h.order.phase, 'awaiting_payment');
});

test('abandoned session ends in the background after CONFLICT and network refusals', async () => {
  const h = restartFixture();
  const c = await atQr(h);
  const guest = JSON.parse(h.rawSession);
  assert.equal(await c.startOver(), true);
  // The server refuses while the QR attempt is pending, then the network fails.
  h.endAnswers = ['CONFLICT', 'NETWORK', 'ok'];
  await c.tick();
  await flush();
  assert.deepEqual(h.abandonedEnds, [guest.token]);
  assert.equal(stored(h).abandoned.length, 1);
  assert.equal(c.getSnapshot().error, null);
  // Not due yet: no second request within the back-off.
  await c.endAbandoned();
  assert.equal(h.abandonedEnds.length, 1);
  h.clock += abandonedRetryMs(0);
  await c.endAbandoned();
  assert.equal(h.abandonedEnds.length, 2);
  assert.equal(stored(h).abandoned.length, 1);
  h.clock += abandonedRetryMs(1) - 1;
  await c.endAbandoned();
  assert.equal(h.abandonedEnds.length, 2);
  h.clock += 1;
  await c.endAbandoned();
  assert.equal(h.abandonedEnds.length, 3);
  // Ended: dropped, and the stored flow is again the shape installed builds read.
  assert.equal('abandoned' in stored(h), false);
  h.clock += 60000;
  await c.endAbandoned();
  assert.equal(h.abandonedEnds.length, 3);
  // Every request with the abandoned token was /sessions/end, with an empty body.
  const old = h.calls.filter((r) => r.token === guest.token && r.abandoned);
  assert.deepEqual(
    old.map((r) => [r.path, r.body, r.key]),
    Array(3).fill(['/sessions/end', {}, undefined]),
  );
  assert.equal(abandonedRetryMs(0), 5000);
  assert.equal(abandonedRetryMs(1), 10000);
  assert.equal(abandonedRetryMs(2), 20000);
  assert.equal(abandonedRetryMs(9), 30000);
});

test('FORBIDDEN or an expired session drops the abandoned guest', async () => {
  const h = restartFixture();
  const c = await atQr(h);
  assert.equal(await c.startOver(), true);
  h.endAnswers = ['FORBIDDEN'];
  await c.endAbandoned();
  assert.equal(h.abandonedEnds.length, 1);
  assert.equal('abandoned' in stored(h), false);

  const e = restartFixture();
  const d = await atQr(e);
  const expiry = Date.parse(JSON.parse(e.rawSession).expiresAt);
  assert.equal(await d.startOver(), true);
  e.endAnswers = ['CONFLICT'];
  await d.endAbandoned();
  assert.equal(stored(e).abandoned.length, 1);
  // Past its expiry the server has closed it already: no request, just dropped.
  e.clock = expiry;
  await d.endAbandoned();
  assert.equal(e.abandonedEnds.length, 1);
  assert.equal('abandoned' in stored(e), false);
});

test('a restored kiosk keeps the abandoned guests and ends them; an interrupted restart is not adopted', async () => {
  const h = restartFixture();
  const c = await atQr(h);
  const guest = JSON.parse(h.rawSession);
  assert.equal(await c.startOver(), true);
  h.endAnswers = ['CONFLICT'];
  await c.endAbandoned();
  const restored = new CommercialKioskController(h.io);
  assert.equal(await restored.restore(), true);
  assert.equal(restored.getSnapshot().step, 'start');
  assert.equal(restored.getSnapshot().order, null);
  assert.deepEqual(
    stored(h).abandoned.map((a) => a.sessionId),
    [guest.sessionId],
  );
  // After a restart every abandoned guest is due at once.
  await restored.endAbandoned();
  assert.equal(h.abandonedEnds.length, 2);
  assert.equal('abandoned' in stored(h), false);

  // The app stopped between the flow write and the credential removal.
  const i = restartFixture();
  const d = await atQr(i);
  const session = i.rawSession;
  assert.equal(await d.startOver(), true);
  i.rawSession = session;
  const again = new CommercialKioskController(i.io);
  assert.equal(await again.restore(), true);
  assert.equal(i.rawSession === session, false);
  assert.notEqual(stored(i).guestId, JSON.parse(session).sessionId);
  assert.equal(again.getSnapshot().order, null);
  assert.equal(stored(i).abandoned[0].sessionId, JSON.parse(session).sessionId);
});

test('the next guest gets a new session and order; nothing else is sent for the old one', async () => {
  const h = restartFixture();
  const c = await atQr(h);
  const old = JSON.parse(h.rawSession);
  const oldOrder = c.getSnapshot().order.order_id;
  assert.equal(await c.startOver(), true);
  const from = h.calls.length;
  h.endAnswers = ['CONFLICT'];
  await nextGuest(h, c);
  await c.tick();
  await flush();
  const fresh = JSON.parse(h.rawSession);
  assert.notEqual(fresh.sessionId, old.sessionId);
  assert.notEqual(fresh.token, old.token);
  const view = c.getSnapshot();
  assert.equal(view.step, 'payment');
  assert.notEqual(view.order.order_id, oldOrder);
  assert.equal(stored(h).guestId, fresh.sessionId);
  const after = h.calls.slice(from);
  assert.ok(after.some((r) => r.path === '/sessions' && r.body.sessionId === fresh.sessionId));
  // The old order is never read, quoted, ordered or paid again.
  assert.equal(
    after.some((r) => r.path.includes(oldOrder)),
    false,
  );
  assert.deepEqual(
    after.filter((r) => r.token === old.token).map((r) => r.path),
    ['/sessions/end'],
  );
  for (const path of ['/quotes', '/orders'])
    assert.ok(after.filter((r) => r.path === path).every((r) => r.token === fresh.token));
  assert.ok(after.filter((r) => r.path.endsWith('/payment')).every((r) => r.token === fresh.token));
  // The new guest's restart is possible too, with one guest still waiting to be ended.
  h.order = {
    ...h.order,
    payment: { kind: 'kaspi_qr', state: 'preparing', qrPayload: null, expiresAt: null },
  };
  await c.refresh();
  assert.equal(c.getSnapshot().canStartOver, true);
  assert.equal(stored(h).abandoned.length, 1);
});

test('the bounded list stops offering a restart when full', async () => {
  const h = restartFixture();
  const c = await atQr(h);
  const flow = stored(h);
  flow.abandoned = Array.from({ length: MAX_ABANDONED_GUESTS }, abandonedGuest);
  h.rawFlow = JSON.stringify(flow);
  const restored = new CommercialKioskController(h.io);
  assert.equal(await restored.restore(), true);
  assert.equal(restored.getSnapshot().step, 'payment');
  assert.equal(restored.getSnapshot().canStartOver, false);
  assert.equal(await restored.startOver(), false);
  assert.equal(stored(h).abandoned.length, MAX_ABANDONED_GUESTS);
  assert.ok(c);
});

test('stored abandoned guests are validated strictly; a flow without them restores as before', async () => {
  const h = restartFixture();
  await atQr(h);
  const good = stored(h);
  assert.equal('abandoned' in good, false);
  const variants = [
    ['not a list', 'x'],
    ['too many', Array.from({ length: MAX_ABANDONED_GUESTS + 1 }, abandonedGuest)],
    ['bad token', [{ ...abandonedGuest(), token: 'A'.repeat(64) }]],
    ['extra key', [{ ...abandonedGuest(), orderId: randomUUID() }]],
    ['bad expiry', [{ ...abandonedGuest(), expiresAt: 'soon' }]],
    ['current guest', [{ ...abandonedGuest(), sessionId: good.guestId }]],
    [
      'duplicate',
      (() => {
        const one = abandonedGuest();
        return [one, { ...one }];
      })(),
    ],
  ];
  for (const [name, abandoned] of variants) {
    h.rawFlow = JSON.stringify({ ...good, abandoned });
    h.calls = [];
    const c = new CommercialKioskController(h.io);
    assert.equal(await c.restore(), false, name);
    assert.equal(h.calls.length, 0, name);
  }
  h.rawFlow = JSON.stringify({ ...good, abandoned: [abandonedGuest()] });
  const ok = new CommercialKioskController(h.io);
  assert.equal(await ok.restore(), true);
  // A flow saved by an installed build (no field) restores and is written back without it.
  h.rawFlow = JSON.stringify(good);
  const legacy = new CommercialKioskController(h.io);
  assert.equal(await legacy.restore(), true);
  assert.equal(legacy.getSnapshot().step, 'payment');
  assert.equal('abandoned' in stored(h), false);
});

test('demo: start over, then the next demo guest gets a new QR order', async () => {
  const demo = createDemoKiosk(null, { uuid: randomUUID });
  const c = demo.controller;
  assert.equal(await c.restore(), true);
  const order = async () => {
    assert.equal(await c.start(), true);
    assert.equal(await c.setMode('takeaway'), true);
    const product = c.getSnapshot().catalog.products[0];
    const selections = product.modifier_groups.flatMap((g) =>
      g.options
        .filter((o) => o.default_quantity > 0)
        .map((o) => ({ group_id: g.id, option_id: o.id, quantity: o.default_quantity })),
    );
    assert.equal(await c.addToCart(product.id, selections), true);
    c.goLoyalty();
    assert.equal(await c.beginPayment(), true);
  };
  await order();
  const first = c.getSnapshot().order.order_id;
  assert.equal(c.getSnapshot().canStartOver, true);
  assert.equal(await c.startOver(), true);
  assert.equal(c.getSnapshot().step, 'start');
  await order();
  const second = c.getSnapshot().order.order_id;
  assert.notEqual(second, first);
  // The abandoned guest's late end leaves the new order alone.
  await c.endAbandoned();
  assert.equal(await c.refresh(), true);
  assert.equal(c.getSnapshot().order.order_id, second);
  assert.equal(c.getSnapshot().qrPayment.state, 'pending');
  assert.equal(await demo.pay('approved'), true);
  assert.equal(c.getSnapshot().order.number, 'Д-123');
});

test('payment copy: «Начать заново» texts in RU, KZ and EN with a plain hyphen', () => {
  const ru = paymentCopy('ru');
  assert.equal(ru.startOver, 'Начать заново');
  assert.equal(ru.startOverTitle, 'Начать заново?');
  assert.equal(
    ru.startOverBody,
    'Заказ не будет оплачен, корзина очистится. Если вы уже оплатили - не нажимайте, позовите сотрудника.',
  );
  assert.equal(ru.backToPayment, 'Вернуться к оплате');
  assert.equal(paymentCopy('kk').startOver, 'Басынан бастау');
  assert.equal(paymentCopy('en').startOver, 'Start over');
  assert.equal(paymentCopy('xx'), ru);
  const keys = Object.keys(paymentCopyForTest.ru).sort();
  for (const [locale, table] of Object.entries(paymentCopyForTest)) {
    assert.deepEqual(Object.keys(table).sort(), keys, locale);
    for (const [key, value] of Object.entries(table)) {
      const text = Array.isArray(value) ? value.join(' ') : value;
      assert.ok(text.trim(), `${locale}.${key}`);
      assert.doesNotMatch(text, /[–—]/, `${locale}.${key}`);
      if (locale === 'en') assert.doesNotMatch(text, /[А-Яа-яЁёӘәҒғҚқҢңӨөҰұҮүҺһІі]/, `en.${key}`);
    }
  }
});

test('the QR plate keeps the standard 4-module quiet zone with its own padding', async () => {
  const { paymentQrModules, paymentQrSvg, plateQuietZone } =
    await import('../../apps/kiosk/src/qr.ts');
  const modules = paymentQrModules(QR);
  assert.ok(modules >= 21);
  assert.match(paymentQrSvg(QR, 2), new RegExp(`viewBox="0 0 ${modules + 4} `));
  assert.equal(paymentQrSvg(QR, 5), null);
  for (const [fit, padding] of [
    [400, 30],
    [320, 24],
    [288, 24],
    [120, 4],
  ]) {
    const quiet = plateQuietZone(modules, fit, padding);
    const module = Math.max(1, Math.round(fit / (modules + quiet * 2)));
    assert.ok(padding + quiet * module >= 4 * module, `${fit}/${padding}`);
    assert.ok(quiet <= 4);
  }
  // On the 13-inch plate the padding already holds two of the four modules.
  assert.equal(plateQuietZone(modules, 400, 30), 2);
  assert.equal(plateQuietZone(0, 400, 30), 4);
});

test('a failed credential removal never hands the abandoned guest to the next one', async () => {
  const h = restartFixture();
  const c = await atQr(h);
  const old = JSON.parse(h.rawSession);
  const remove = h.io.removeSession;
  h.io.removeSession = async () => {
    throw new Error('keychain busy');
  };
  assert.equal(await c.startOver(), true);
  h.io.removeSession = remove;
  assert.equal(c.getSnapshot().step, 'start');
  assert.equal(JSON.parse(h.rawSession).sessionId, old.sessionId);
  h.endAnswers = ['CONFLICT'];
  await nextGuest(h, c);
  assert.notEqual(JSON.parse(h.rawSession).sessionId, old.sessionId);
  assert.notEqual(stored(h).guestId, old.sessionId);
  assert.deepEqual(
    stored(h).abandoned.map((a) => a.sessionId),
    [old.sessionId],
  );
});
