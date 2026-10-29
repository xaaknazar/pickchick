import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { orderingForbidden, paymentRefused } from '../../apps/mobile/src/checkout-preflight.ts';
import { CustomerSessionError } from '../../apps/mobile/src/customer-session.ts';
import {
  ORDERING_FORBIDDEN,
  ORDERING_FORBIDDEN_DEMO,
  checkoutError,
  orderingForbiddenCode,
} from '../../apps/mobile/src/commerce-presentation.ts';
import { guestCanOpen, requiresAccount } from '../../apps/mobile/src/account-access.ts';
import { restaurantCountLabel } from '../../apps/mobile/src/restaurant-hours.ts';
import { orderTimeLabel } from '../../apps/mobile/src/order-status.ts';
import { selectionDescription } from '../../apps/mobile/src/domain.ts';
import { setAppLocale, translate } from '../../apps/mobile/src/i18n/core.ts';

/**
 * Review of the App Store build, 29.10.2026 (tech lead + an Apple-reviewer walk): the App Review
 * account, the guest games, English screens. Browser counterparts: browser_store_walk.py.
 */
const messages = JSON.parse(
  readFileSync(new URL('../../apps/mobile/src/i18n/messages.json', import.meta.url), 'utf8'),
);
const entry = (ru) => messages.find((message) => message.ru === ru);

test('FORBIDDEN (the App Review account) reads as a true, neutral state in three languages', () => {
  // A FORBIDDEN command or read (cart, «Заказы») reaches the customer only through checkoutError:
  // this text and «Как проходит заказ»; there is no separate read-error wording (review 29.10.2026).
  assert.equal(checkoutError(new Error('FORBIDDEN')), ORDERING_FORBIDDEN);
  assert.equal(checkoutError(new CustomerSessionError('FORBIDDEN', 403, true)), ORDERING_FORBIDDEN);
  const copy = entry(ORDERING_FORBIDDEN);
  assert.equal(
    copy.en,
    'Ordering is turned off for this account. You can see how ordering works without payment.',
  );
  assert.ok(copy.kk && !/әлі|әзірге/.test(copy.kk), copy.kk);
  assert.equal(entry(ORDERING_FORBIDDEN_DEMO).en, 'How ordering works');
  assert.equal(orderingForbiddenCode(new Error('FORBIDDEN')), true);
  assert.equal(orderingForbiddenCode(new Error('UNAUTHORIZED')), false);
});

test('only an authoritative 403 FORBIDDEN drops the create intent; nothing else changes', () => {
  assert.equal(orderingForbidden(new CustomerSessionError('FORBIDDEN', 403, true)), true);
  // A guessed or transport-level FORBIDDEN is never trusted to drop an intent.
  assert.equal(orderingForbidden(new CustomerSessionError('FORBIDDEN', 0, false)), false);
  assert.equal(orderingForbidden(new CustomerSessionError('FORBIDDEN', 503, true)), false);
  assert.equal(orderingForbidden(new Error('FORBIDDEN')), false);
  for (const code of ['NOT_READY', 'CONFLICT', 'UNAUTHORIZED', 'NETWORK_UNAVAILABLE'])
    assert.equal(orderingForbidden(new CustomerSessionError(code, 409, true)), false, code);
  // The bank refusal list itself is unchanged.
  assert.equal(paymentRefused(new CustomerSessionError('FORBIDDEN', 403, true)), false);
  assert.equal(paymentRefused(new CustomerSessionError('NOT_READY', 503, true)), true);
});

test('the payment screen source: FORBIDDEN drops the create intent and offers the demo', () => {
  const source = readFileSync(
    new URL('../../apps/mobile/src/screens/KaspiCheckoutScreen.tsx', import.meta.url),
    'utf8',
  );
  // recover(): a refused create (no orderId yet) removes its intent like QUOTE_EXPIRED does.
  assert.match(
    source,
    /e\.code === 'QUOTE_EXPIRED' \|\| \(!draft\.orderId && orderingForbidden\(e\)\)/,
  );
  // pay(): a FORBIDDEN invoice command keeps its order and «Отправить счёт» (unchanged guard).
  assert.doesNotMatch(source, /paymentRefused\(e\) \|\| orderingForbidden\(e\)/);
  assert.equal(source.match(/orderingForbidden\(e\)/g).length, 1);
  // The cart notice: «Как проходит заказ» opens /demo-order; no «Попробовать снова» for it.
  assert.match(
    source,
    /testID="checkout-forbidden-demo"[\s\S]{0,80}router\.push\('\/demo-order'\)/,
  );
  assert.match(
    source,
    /\{forbidden \? \([\s\S]*?checkout-forbidden-demo[\s\S]*?\) : \([\s\S]*?Попробовать снова/,
  );
});

test('App Store build: a guest opens «События» and the mini-games; ordering still needs sign-in', () => {
  for (const destination of ['M26', 'pick-blocks', 'pick-man', 'magic-sort'])
    assert.equal(guestCanOpen(destination, true), true, destination);
  for (const destination of ['pick-farm', 'M30', 'M12', 'M19', 'M27'])
    assert.equal(guestCanOpen(destination, true), false, destination);
  assert.equal(requiresAccount('M26', false, true), false);
  assert.equal(requiresAccount('M30', false, true), true);
  for (let n = 12; n <= 22; n++) assert.equal(requiresAccount('M' + n, false, true), true);
  // Other builds keep the earlier wall.
  for (const destination of ['M26', 'pick-blocks', 'pick-man', 'magic-sort'])
    assert.equal(guestCanOpen(destination, false), false, destination);
  assert.equal(requiresAccount('M26', false, false), true);
});

test('English and Kazakh screens: no Russian in the time chip, modifiers, places and counts', () => {
  const order = {
    order_id: 'o',
    number: '15',
    branch_id: 'b',
    restaurant: 'ТЦ Abay Plaza',
    created_at: '2026-10-29T06:00:00.000Z',
    updated_at: '2026-10-29T06:40:00.000Z',
    state: 'ready',
    cancellation_reason: null,
    tasks: [],
    snapshot: { service_mode: 'takeaway', total_minor: '100', lines: [] },
  };
  const line = {
    product: {
      modifierGroups: [
        { id: 'drink', options: [{ id: 'cola-bottle', label: 'Coca-Cola 0.5 л, бутылка' }] },
        { id: 'sauce', options: [{ id: 'pick', label: 'Фирменный соус Pick Chick' }] },
      ],
    },
    selections: [
      { group_id: 'drink', option_id: 'cola-bottle', quantity: 1 },
      { group_id: 'sauce', option_id: 'pick', quantity: 2 },
    ],
  };
  try {
    setAppLocale('en');
    assert.match(orderTimeLabel(order, Date.parse(order.updated_at)), /^Ready for collection at /);
    assert.match(
      orderTimeLabel({ ...order, state: 'fulfilled' }, Date.parse(order.updated_at)),
      /^Collected at /,
    );
    assert.equal(
      selectionDescription(line),
      'Coca-Cola 0.5 L, bottle · Pick Chick signature sauce ×2',
    );
    assert.equal(restaurantCountLabel(1), '1 restaurant');
    assert.equal(restaurantCountLabel(3), '3 restaurants');
    assert.equal(translate('4-й микрорайон, 10Б', 'en'), '4th microdistrict, 10B');
    assert.equal(translate('ТЦ Abay Plaza', 'en'), 'Abay Plaza shopping centre');
    setAppLocale('kk');
    assert.equal(restaurantCountLabel(2), '2 мейрамхана');
    assert.doesNotMatch(selectionDescription(line), /бутылка|Фирменный/);
  } finally {
    setAppLocale('ru');
  }
  assert.equal(restaurantCountLabel(2), '2 ресторана');
  assert.match(orderTimeLabel(order, Date.parse(order.updated_at)), /^Готов к выдаче в /);
});

test('the one-line game copy of the order carousel is translated before it is joined', () => {
  const carousel = readFileSync(
    new URL('../../apps/mobile/src/components/GameCarousel.tsx', import.meta.url),
    'utf8',
  );
  assert.match(carousel, /oneLine\(t\(game\.description\)\)/);
  for (const ru of [
    'Заполняй ряды.\nВсё сложится.',
    'Бургеры, фингерсы, кола.\nСобери всё в лабиринте.',
  ])
    assert.ok(entry(ru)?.en, ru);
});
