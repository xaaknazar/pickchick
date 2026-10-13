// Kiosk build 14, owner decision 2026-10-11: the NOT_ACCEPTING notice is removed everywhere, and a
// hidden staff demo mode walks every screen up to the QR and the order number without any real
// order or payment. Synthetic fixtures only: no network, bank, kitchen or device is involved.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { CommercialKioskController } from '../../apps/kiosk/src/commercial-controller.ts';
import { KioskError } from '../../apps/kiosk/src/api.ts';
import { KIOSK_IDLE_MS, KIOSK_IDLE_GRACE_MS } from '../../apps/kiosk/src/controller.ts';
import { copy, dictionariesForTest, LOCALES } from '../../apps/kiosk/src/i18n.ts';
import { guestErrorText, SILENT_ERROR_CODES } from '../../apps/kiosk/src/guestError.ts';
import {
  createDemoKiosk,
  DEMO_AUTO_PAID_MS,
  DEMO_HOLD_MS,
  DEMO_QR_PAYLOAD,
  demoFixtureSeed,
} from '../../apps/kiosk/src/demo.ts';
import { branchId, cart, fixture, storefront } from './commercial-fixture.mjs';

const src = new URL('../../apps/kiosk/src/', import.meta.url);
const read = (path) => readFileSync(new URL(path, src), 'utf8');
const NOT_ACCEPTING_RU = 'не принимает заказы';

/** Any real network call fails the test: the demo must never reach fetch. */
function forbidFetch(t) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (...args) => {
    calls.push(args);
    throw new Error('Network is forbidden in demo mode');
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return calls;
}
function clock(start = Date.parse('2026-10-11T09:00:00Z')) {
  const c = { value: start, now: () => c.value };
  return c;
}
async function fill(c) {
  assert.equal(await c.restore(), true);
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
  return c;
}

// 1. NOT_ACCEPTING is never shown.

test('stale availability keeps NOT_ACCEPTING internal: no guest text in KZ/RU/EN', async () => {
  const h = fixture();
  const request = h.io.request;
  h.io.request = async (path, ...rest) =>
    path === '/availability'
      ? { ...(await request(path, ...rest)), fresh: false }
      : request(path, ...rest);
  const c = new CommercialKioskController(h.io);
  assert.equal(await c.restore(), false);
  const view = c.getSnapshot();
  assert.equal(view.errorCode, 'NOT_ACCEPTING');
  assert.equal(view.error, null);
  for (const locale of LOCALES) assert.equal(guestErrorText(view, copy(locale)), null);
  // The menu stays loaded; checkout stays closed (checkoutReady is unchanged).
  assert.ok(view.catalog);
  assert.equal(view.checkoutReady, false);
});

test('real checkout is not weakened: closed restaurant never reaches /quotes and shows no notice', async () => {
  const h = fixture();
  const c = await cart(h);
  const request = h.io.request;
  h.io.request = async (path, ...rest) => {
    const answer = await request(path, ...rest);
    return path === '/config' ? { ...answer, enabled: false } : answer;
  };
  assert.equal(await c.beginPayment(), false);
  const view = c.getSnapshot();
  assert.equal(view.errorCode, 'NOT_ACCEPTING');
  assert.equal(view.checkoutReady, false);
  assert.equal(view.step, 'loyalty');
  assert.equal(guestErrorText(view, copy('ru')), null);
  assert.equal(h.calls.filter((r) => r.path === '/quotes' || r.path === '/orders').length, 0);
});

test('/orders RESTAURANT_CLOSED keeps the guest on the review without a notice', async () => {
  const h = fixture();
  const c = await cart(h);
  h.before = async (path) => {
    if (path === '/orders') throw new KioskError('RESTAURANT_CLOSED', 409);
  };
  assert.equal(await c.beginPayment(), false);
  assert.equal(c.getSnapshot().step, 'loyalty');
  assert.equal(guestErrorText(c.getSnapshot(), copy('kk')), null);
});

test('other guest errors keep their texts (payment, network, unknown result)', () => {
  for (const code of ['PAYMENT_UNKNOWN', 'NETWORK', 'RETRY_PAYMENT', 'KITCHEN_OFFLINE']) {
    for (const locale of LOCALES) {
      const text = guestErrorText({ errorCode: code, error: 'fallback' }, copy(locale));
      assert.equal(text, dictionariesForTest[locale]['err_' + code], `${locale} ${code}`);
    }
  }
  // The simulator keeps its own text without a code.
  assert.equal(guestErrorText({ errorCode: null, error: 'Тест' }, copy('ru')), 'Тест');
  assert.deepEqual(SILENT_ERROR_CODES, ['NOT_ACCEPTING']);
});

test('the NOT_ACCEPTING text is gone from every dictionary and kiosk source', () => {
  for (const [locale, strings] of Object.entries(dictionariesForTest))
    assert.equal('err_NOT_ACCEPTING' in strings, false, locale);
  const files = (dir) =>
    readdirSync(new URL(dir, src), { withFileTypes: true }).flatMap((e) =>
      e.isDirectory()
        ? files(`${dir}${e.name}/`)
        : /\.(ts|tsx)$/.test(e.name)
          ? [`${dir}${e.name}`]
          : [],
    );
  for (const file of files('')) {
    const text = read(file);
    assert.doesNotMatch(text, new RegExp(NOT_ACCEPTING_RU, 'i'), file);
    assert.doesNotMatch(text, /not taking orders/i, file);
    assert.doesNotMatch(text, /тапсырыс қабылдамайды/i, file);
  }
  // Screens read errors only through guestErrorText.
  for (const file of ['screens/GuestScreen.tsx', 'components/CloudKitchen.stories.tsx'])
    assert.match(read(file), /guestErrorText\(/, file);
});

// 2. Demo mode: in-memory transport, no network, demo QR and number.

test('demo cancellation keeps the cart and permits a fresh demo payment without network', async (t) => {
  const fetchCalls = forbidFetch(t);
  const time = clock();
  const demo = createDemoKiosk(null, { uuid: randomUUID, now: time.now });
  const c = await fill(demo.controller);
  const before = c.getSnapshot();
  await c.beginPayment();
  const firstOrder = c.getSnapshot().order.order_id;
  assert.equal(await demo.cancelPayment(), true);
  const after = c.getSnapshot();
  assert.equal(after.step, 'cart');
  assert.equal(after.order, null);
  assert.equal(after.qrPayment, null);
  assert.equal(after.mode, before.mode);
  assert.deepEqual(after.cart, before.cart);
  assert.equal(await c.beginPayment(), true);
  assert.notEqual(c.getSnapshot().order.order_id, firstOrder);
  assert.equal(fetchCalls.length, 0);
});

test('demo cancellation loses to an elapsed auto-payment and never clears a paid order', async (t) => {
  forbidFetch(t);
  const time = clock();
  const demo = createDemoKiosk(null, { uuid: randomUUID, now: time.now });
  const c = await fill(demo.controller);
  await c.beginPayment();
  const id = c.getSnapshot().order.order_id;
  time.value += DEMO_AUTO_PAID_MS;
  assert.equal(await demo.cancelPayment(), false);
  assert.equal(c.getSnapshot().step, 'order');
  assert.equal(c.getSnapshot().order.payment_state, 'paid');
  assert.equal(c.getSnapshot().order.order_id, id);
  assert.equal(demo.transport.calls.includes('/sessions/end'), false);
});

test('unknown demo payment cannot be cancelled or turned into a new draft', async (t) => {
  forbidFetch(t);
  const demo = createDemoKiosk(null, { uuid: randomUUID });
  const c = await fill(demo.controller);
  await c.beginPayment();
  await demo.pay('unknown');
  const id = c.getSnapshot().order.order_id;
  assert.equal(await demo.cancelPayment(), false);
  assert.equal(await c.returnAfterFailedPayment(), false);
  assert.equal(c.getSnapshot().order.order_id, id);
  assert.equal(c.getSnapshot().order.payment_state, 'unknown');
  assert.equal(demo.transport.calls.includes('/sessions/end'), false);
});

test('repeated demo cancellation clears only one failed order and keeps the draft', async (t) => {
  forbidFetch(t);
  const demo = createDemoKiosk(null, { uuid: randomUUID });
  const c = await fill(demo.controller);
  await c.beginPayment();
  const answers = await Promise.all([demo.cancelPayment(), demo.cancelPayment()]);
  assert.equal(answers.filter(Boolean).length, 1);
  assert.equal(c.getSnapshot().step, 'cart');
  assert.equal(c.getSnapshot().cart.length, 1);
  assert.equal(demo.transport.calls.filter((p) => p === '/sessions/end').length, 1);
});

test('demo walks to a non-payable QR and a "Д-123" number without any network call', async (t) => {
  const fetchCalls = forbidFetch(t);
  const time = clock();
  const demo = createDemoKiosk(null, { uuid: randomUUID, now: time.now });
  const c = await fill(demo.controller);
  assert.equal(c.getSnapshot().checkoutReady, true);
  assert.equal(await c.beginPayment(), true);
  let view = c.getSnapshot();
  assert.equal(view.step, 'payment');
  assert.equal(view.qrPayment.qrPayload, DEMO_QR_PAYLOAD);
  assert.doesNotMatch(DEMO_QR_PAYLOAD, /kaspi|https?:/i);
  assert.equal(view.order.payment_state, 'pending');
  assert.equal(view.order.snapshot.total_minor, view.cartTotalMinor);
  // Before the delay a status read keeps the QR.
  time.value += DEMO_AUTO_PAID_MS - 1000;
  await c.refresh();
  assert.equal(c.getSnapshot().step, 'payment');
  time.value += 1000;
  await c.refresh();
  view = c.getSnapshot();
  assert.equal(view.step, 'order');
  assert.equal(view.order.payment_state, 'paid');
  assert.equal(view.order.number, 'Д-123');
  assert.equal(view.error, null);
  // The next demo guest gets the next demo number.
  assert.equal(await c.newGuest(), true);
  assert.equal(c.getSnapshot().step, 'start');
  await fill(c);
  await c.beginPayment();
  assert.equal(await demo.pay('approved'), true);
  assert.equal(c.getSnapshot().order.number, 'Д-124');
  assert.equal(fetchCalls.length, 0);
  // Every answer came from the in-memory transport.
  assert.ok(demo.transport.calls.includes('/quotes'));
  assert.ok(demo.transport.calls.includes('/orders'));
});

test('demo reuses the live menu; the live transport is never asked for quotes, orders or payments', async (t) => {
  const fetchCalls = forbidFetch(t);
  const h = fixture();
  const live = new CommercialKioskController(h.io);
  assert.equal(await live.restore(), true);
  const seed = live.demoSeed();
  assert.ok(seed);
  // From now on any live request or read fails the test.
  const liveCalls = [];
  h.io.request = async (path) => {
    liveCalls.push(path);
    throw new Error('live transport must not be used by the demo: ' + path);
  };
  h.io.read = async (path) => {
    liveCalls.push(path);
    throw new Error('live transport must not be used by the demo: ' + path);
  };
  h.io.readDevice = async () => {
    throw new Error('the demo never reads the enrollment');
  };
  const demo = createDemoKiosk(seed, { uuid: randomUUID });
  const c = await fill(demo.controller);
  const view = c.getSnapshot();
  assert.equal(view.catalog.branch_id, branchId);
  assert.equal(view.catalog.catalog_version, String(storefront.version));
  assert.deepEqual(
    view.catalog.products.map((p) => p.id),
    storefront.payload.products.map((p) => p.id),
  );
  assert.equal(await c.beginPayment(), true);
  assert.equal(await demo.pay('approved'), true);
  assert.equal(c.getSnapshot().order.number, 'Д-123');
  assert.deepEqual(liveCalls, []);
  assert.equal(fetchCalls.length, 0);
  // The live kiosk stays on its start screen with its own state.
  assert.equal(live.getSnapshot().step, 'start');
  assert.equal(live.getSnapshot().order, null);
});

test('demo without a loaded menu falls back to the built-in fixture menu', async (t) => {
  forbidFetch(t);
  const demo = createDemoKiosk({ published: { broken: true }, media: null }, { uuid: randomUUID });
  const c = await fill(demo.controller);
  const fixtureProducts = demoFixtureSeed().published.payload.products;
  assert.equal(c.getSnapshot().catalog.products.length, fixtureProducts.length);
});

test('demo outcomes for design: declined, unknown, then paid', async (t) => {
  const fetchCalls = forbidFetch(t);
  const declined = createDemoKiosk(null, { uuid: randomUUID });
  const a = await fill(declined.controller);
  await a.beginPayment();
  assert.equal(await declined.pay('declined'), true);
  assert.equal(a.getSnapshot().step, 'order');
  assert.equal(a.getSnapshot().order.state, 'failed');
  assert.equal(a.getSnapshot().order.payment_state, 'declined');
  // A settled demo payment cannot be settled again.
  assert.equal(await declined.pay('approved'), false);

  const unknown = createDemoKiosk(null, { uuid: randomUUID });
  const b = await fill(unknown.controller);
  await b.beginPayment();
  assert.equal(await unknown.pay('unknown'), true);
  assert.equal(b.getSnapshot().step, 'payment');
  assert.equal(b.getSnapshot().order.payment_state, 'unknown');
  assert.equal(await unknown.pay('approved'), true);
  assert.equal(b.getSnapshot().step, 'order');
  assert.equal(b.getSnapshot().order.number, 'Д-123');
  assert.equal(fetchCalls.length, 0);
});

test('demo Kaspi invoice reaches the invoice screen locally', async (t) => {
  forbidFetch(t);
  const demo = createDemoKiosk(null, { uuid: randomUUID });
  const c = await fill(demo.controller);
  assert.deepEqual(c.getSnapshot().commercialPaymentMethods, ['kaspi', 'kaspi_invoice']);
  c.setPaymentMethod('kaspi_invoice');
  c.setInvoicePhone('8 (701) 000-00-00');
  assert.equal(await c.beginPayment(), true);
  assert.equal(c.getSnapshot().step, 'payment');
  assert.equal(c.getSnapshot().paymentMethod, 'kaspi_invoice');
  assert.equal(c.getSnapshot().qrPayment, null);
  assert.equal(await demo.pay('approved'), true);
  assert.equal(c.getSnapshot().order.number, 'Д-123');
});

test('demo idle returns to the start screen (still in demo)', async (t) => {
  forbidFetch(t);
  const time = clock();
  const demo = createDemoKiosk(null, { uuid: randomUUID, now: time.now });
  const c = await fill(demo.controller);
  time.value += KIOSK_IDLE_MS + KIOSK_IDLE_GRACE_MS;
  await c.tick();
  assert.equal(c.getSnapshot().step, 'start');
  assert.equal(c.getSnapshot().cart.length, 0);
  // The same demo controller serves the next guest.
  await fill(c);
  assert.equal(c.getSnapshot().step, 'loyalty');
});

test('demo transport has no network, storage or enrollment code', () => {
  // Code only: the comments may name what the demo avoids.
  const demo = read('demo.ts')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(demo, /\bfetch\s*\(|commercialKioskRequest|commercialKioskRead|kioskRequest/);
  assert.doesNotMatch(demo, /SecureStore|AsyncStorage|KIOSK_DEVICE_KEY|createCommercialKioskIO/);
  assert.doesNotMatch(demo, /from '\.\/storage'|from '\.\/commercial-api'/);
});

// 3. Gesture, toggle and badge.

test('the 5 s logo hold opens the demo dialog; demo state lives only in memory', () => {
  assert.equal(DEMO_HOLD_MS, 5000);
  const welcome = read('components/WelcomeContent.tsx');
  assert.match(welcome, /export const STAFF_HOLD_MS = 5000;/);
  assert.match(welcome, /delayLongPress=\{STAFF_HOLD_MS\}/);
  assert.match(welcome, /onLongPress=\{onLogoHold\}/);
  assert.match(read('screens/WelcomeMode.tsx'), /onLogoHold=\{context\.onStaffHold\}/);
  const guest = read('screens/GuestScreen.tsx');
  assert.match(guest, /onStaffHold: model\.setDemo \? \(\) => setDemoAsk\(true\)/);
  assert.match(guest, /model\.demo \? t\.demoExitTitle : t\.demoEnterTitle/);
  assert.match(guest, /model\.setDemo\?\.\(!model\.demo\)/);
  // The badge is shown on every screen while the demo is on, with its own exit.
  assert.match(
    guest,
    /\{model\.demo \? \(?\s*<DemoBadge locale=\{locale\} onExit=\{\(\) => model\.setDemo\?\.\(false\)\}/,
  );
  assert.match(read('components/DemoBadge.tsx'), /testID="kiosk-demo-exit"/);
  // React state only: an app restart starts in normal mode; only the idle start screen enters.
  const hook = read('useKioskController.ts');
  assert.match(hook, /useState<DemoKiosk \| null>\(null\)/);
  assert.doesNotMatch(hook, /demo[^\n]*(AsyncStorage|SecureStore|writeFlow)/i);
  assert.match(hook, /current\.step !== 'start'/);
  assert.match(hook, /pay: demo \? demo\.pay : controller\.pay/);
});

test('demo screens: QR caption, demo outcome buttons and demo receipt', () => {
  const screens = read('screens/PaymentOrderScreens.tsx');
  assert.match(screens, /model\.demo\s*\?\s*t\.demoQr/);
  assert.match(screens, /testID="kiosk-demo-paid"/);
  assert.match(screens, /demoWarning=\{model\.demo \? t\.demoQr : null\}/);
  // The Kaspi steps give way to the demo hint under a demo QR.
  assert.match(read('components/PaymentStatus.tsx'), /qrPayload && waiting && !demoWarning/);
  assert.match(screens, /model\.demo\s*\?\s*t\.demoReceipt/);
  assert.match(read('components/DemoMode.stories.tsx'), /createDemoKiosk/);
});

test('demo texts exist in KZ, RU and EN with a plain hyphen', () => {
  const keys = Object.keys(dictionariesForTest.ru).filter((k) => k.startsWith('demo'));
  assert.ok(keys.length >= 14);
  for (const [locale, strings] of Object.entries(dictionariesForTest))
    for (const key of keys) {
      assert.equal(typeof strings[key], 'string', `${locale} ${key}`);
      assert.ok(strings[key].trim(), `${locale} ${key}`);
      assert.doesNotMatch(strings[key], /[–—]/, `${locale} ${key}`);
    }
  assert.match(copy('ru').demoQr, /^ДЕМО - не оплачивать/);
  assert.equal(copy('ru').demoBadge, 'ДЕМО');
  assert.equal(copy('ru').demoEnterTitle, 'Включить демо-режим?');
});
