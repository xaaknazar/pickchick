import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  heroHostVisible,
  heroShouldPlay,
  isSheetRoute,
} from '../../apps/mobile/src/hero-playback.ts';
import {
  CART_EDIT_SETTLE_MS,
  KASPI_PAY,
  brandSlotParts,
  cartEditSettleMs,
  cartPaymentMethods,
  cartPayTitle,
} from '../../apps/mobile/src/cart-payment.ts';
import { translate } from '../../apps/mobile/src/i18n/core.ts';
import { glass, glassSize, glassSurface } from '../../apps/mobile/src/glass.ts';
import { accountDestination, requiresAccount } from '../../apps/mobile/src/account-access.ts';

const tabs = (focused) => ({
  key: 'tabs-1',
  name: '(tabs)',
  state: {
    index: focused,
    routes: [
      { key: 'menu-1', name: 'menu' },
      { key: 'events-1', name: 'events' },
      { key: 'orders-1', name: 'orders' },
    ],
  },
});
// expo-router wraps the app stack in its own root slot.
const root = (...routes) => ({
  index: 0,
  routes: [{ key: 'root', name: '__root', state: { index: routes.length - 1, routes } }],
});

test('hero video keeps playing under the cart, checkout, status and sign-in sheets', () => {
  assert.equal(heroHostVisible(root(tabs(0)), 'menu-1', 'ios'), true);
  for (const sheet of ['cart', 'checkout', 'order-status', 'auth'])
    assert.equal(heroHostVisible(root(tabs(0), { key: 's', name: sheet }), 'menu-1', 'ios'), true);
  // Sign-in over the cart over the menu: still only sheets above the menu.
  assert.equal(
    heroHostVisible(
      root(tabs(0), { key: 'c', name: 'cart' }, { key: 'a', name: 'auth' }),
      'menu-1',
      'web',
    ),
    true,
  );
});

test('hero video pauses for another tab, a full screen or a screen above a sheet', () => {
  assert.equal(heroHostVisible(root(tabs(1)), 'menu-1', 'ios'), false);
  assert.equal(heroHostVisible(root(tabs(2)), 'menu-1', 'android'), false);
  for (const screen of ['screen/[id]', 'notifications', 'profile', 'games/pick-man'])
    assert.equal(
      heroHostVisible(root(tabs(0), { key: 'x', name: screen }), 'menu-1', 'ios'),
      false,
    );
  assert.equal(
    heroHostVisible(
      root(tabs(0), { key: 'c', name: 'cart' }, { key: 'p', name: 'screen/[id]' }),
      'menu-1',
      'ios',
    ),
    false,
  );
  // The product photo page is a card sheet on iOS only; elsewhere it covers the menu.
  const photo = root(tabs(0), { key: 'p', name: 'product-photo' });
  assert.equal(heroHostVisible(photo, 'menu-1', 'ios'), true);
  assert.equal(heroHostVisible(photo, 'menu-1', 'android'), false);
  assert.equal(heroHostVisible(photo, 'menu-1', 'web'), false);
  assert.equal(isSheetRoute('product-photo', 'web'), false);
  // Unknown host or no state yet: never play.
  assert.equal(heroHostVisible(undefined, 'menu-1', 'ios'), false);
  assert.equal(heroHostVisible(root(tabs(0)), 'missing', 'ios'), false);
});

test('a hero hosted on a full screen plays while that screen is on top', () => {
  const product = { key: 'product-1', name: 'screen/[id]' };
  assert.equal(heroHostVisible(root(tabs(0), product), 'product-1', 'ios'), true);
  assert.equal(
    heroHostVisible(root(tabs(0), product, { key: 'c', name: 'cart' }), 'product-1', 'ios'),
    true,
  );
});

test('background, reduced motion and media failure always pause the hero video', () => {
  const on = { reducedMotion: false, appActive: true, failed: false, hostVisible: true };
  assert.equal(heroShouldPlay(on), true);
  assert.equal(heroShouldPlay({ ...on, reducedMotion: true }), false);
  assert.equal(heroShouldPlay({ ...on, appActive: false }), false);
  assert.equal(heroShouldPlay({ ...on, failed: true }), false);
  assert.equal(heroShouldPlay({ ...on, hostVisible: false }), false);
});

test('payment selector: the App Store build lists Kaspi.kz only (owner 29.10.2026)', () => {
  for (const platform of ['ios', 'android', 'web']) {
    assert.deepEqual(
      cartPaymentMethods(platform).map((m) => [m.id, m.available]),
      [['kaspi', true]],
    );
    // No Apple Pay, Google Pay or card name anywhere in the list.
    assert.ok(
      cartPaymentMethods(platform).every((m) => !/Apple|Google|карта/.test(m.label)),
      platform,
    );
  }
  // EXPO_PUBLIC_UPCOMING_PAYMENTS=1: the earlier list with disabled «скоро» rows.
  for (const platform of ['ios', 'web'])
    assert.deepEqual(
      cartPaymentMethods(platform, true).map((m) => [m.id, m.available]),
      [
        ['kaspi', true],
        ['apple_pay', false],
        ['card', false],
      ],
    );
  assert.deepEqual(
    cartPaymentMethods('android', true).map((m) => m.label),
    ['Kaspi.kz', 'Google Pay', 'Банковская карта'],
  );
  // Only Kaspi.kz is available on every platform; the selector has nothing else to choose.
  for (const platform of ['ios', 'android', 'web'])
    assert.deepEqual(
      cartPaymentMethods(platform, true)
        .filter((m) => m.available)
        .map((m) => m.id),
      ['kaspi'],
    );
});

test('pay button wording: busy, gift-only order and the Kaspi action', () => {
  assert.equal(cartPayTitle({ busy: true, totalMinor: '419000' }), 'Оформляем заказ…');
  assert.equal(cartPayTitle({ busy: false, totalMinor: '0' }), 'Заказать подарок');
  assert.equal(cartPayTitle({ busy: false, totalMinor: '419000' }), KASPI_PAY);
});

test('pay button keeps each language word order around the Kaspi.kz mark', () => {
  const words = (language) => brandSlotParts(translate(KASPI_PAY, language));
  assert.deepEqual(words('ru'), { before: 'Оплатить с', after: '' });
  // Kazakh: «[Kaspi.kz] арқылы төлеу», not «Төлеу [Kaspi.kz]».
  assert.deepEqual(words('kk'), { before: '', after: 'арқылы төлеу' });
  assert.deepEqual(words('en'), { before: 'Pay with', after: '' });
  assert.deepEqual(brandSlotParts('Заказать подарок'), { before: 'Заказать подарок', after: '' });
});

test('a burst of cart edits re-reads the Kaspi session once, other screens at once', () => {
  const a = '{"items":[1]}',
    b = '{"items":[2]}';
  assert.equal(cartEditSettleMs('M09', null, a), 0, 'opening the cart reads at once');
  assert.equal(cartEditSettleMs('M09', a, a), 0, 'return, refresh, foreground: at once');
  assert.equal(cartEditSettleMs('M09', a, b), CART_EDIT_SETTLE_MS);
  assert.ok(CART_EDIT_SETTLE_MS > 0 && CART_EDIT_SETTLE_MS <= 500);
  for (const screen of ['M12', 'M19']) assert.equal(cartEditSettleMs(screen, a, b), 0);
});

test('glass buttons blur where a blur exists and never shrink below 44 pt', () => {
  // Older iOS (no Liquid Glass); the full decision is in liquid-glass.test.mjs.
  const env = (platform, nativeBlur) => ({
    platform,
    osVersion: platform === 'ios' ? '18.6' : 34,
    liquidGlass: false,
    nativeBlur,
    reducedTransparency: false,
  });
  assert.equal(glassSurface(env('web', false)), 'blur');
  assert.equal(glassSurface(env('ios', true)), 'blur');
  // A binary built before expo-blur, and Android: tinted fill with a rim, no crash.
  assert.equal(glassSurface(env('ios', false)), 'tint');
  assert.equal(glassSurface(env('android', true)), 'tint');
  assert.equal(glassSize(), 48);
  assert.equal(glassSize(30), 44);
  assert.equal(glassSize(52), 52);
  assert.match(glass.danger, /^#[0-9A-F]{6}$/i);
});

test('the guest cart returns to itself after sign-in; browsing it never requires an account', () => {
  assert.equal(accountDestination('M09'), 'M09');
  assert.equal(requiresAccount('M09', false), false);
});

test('new cart texts are translated to Kazakh and English', () => {
  const messages = JSON.parse(
    readFileSync(new URL('../../apps/mobile/src/i18n/messages.json', import.meta.url), 'utf8'),
  );
  for (const ru of [KASPI_PAY, 'Оплатить с Kaspi.kz, {p0}', 'Заказ в ресторане {p0}']) {
    const entry = messages.find((message) => message.ru === ru);
    assert.ok(entry && entry.kk && entry.en, ru);
  }
});
