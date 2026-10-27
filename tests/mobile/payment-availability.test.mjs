import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { testCompleteCatalog } from '@pickchick/test-order-flow/complete-catalog';
import { setAppLocale } from '../../apps/mobile/src/i18n/core.ts';
import {
  PAYMENT_AVAILABLE,
  checkoutEnabledFor,
  checkoutSwitchSnapshot,
  msUntilNextMinute,
  noteCheckoutSwitch,
  paymentAvailability,
  paymentStopLabel,
  paymentStopMessage,
  publishedHoursStatus,
  restaurantHoursNow,
  subscribeCheckoutSwitch,
  unavailableCartNames,
} from '../../apps/mobile/src/payment-availability.ts';
import { headerHoursCaption, zonedMinuteOfDay } from '../../apps/mobile/src/restaurant-hours.ts';
import { defaultSelections } from '../../apps/mobile/src/domain.ts';

// Owner 28.10.2026 (Drinkit reference): a closed restaurant or a payment that cannot go through
// shows no payment handle on the cart bar, a red reason in the cart and a grey pay button.
// Screen behaviour is covered end to end by browser_cart_unavailable.py.

const products = testCompleteCatalog.products.map((p) => ({
  ...p,
  priceMinor: p.price_minor,
  modifierGroups: p.modifier_groups,
  source: 'server',
}));
const product = (id, extra = {}) => ({ ...products.find((p) => p.id === id), ...extra });
const line = (id, extra = {}, selections) => {
  const p = product(id, extra);
  return { product: p, quantity: 1, selections: selections ?? defaultSelections(p) };
};
const basket = [line('pick-combo')];
const HOURS = { openingTime: '10:00', closingTime: '00:00', timeZone: 'Asia/Almaty' };
/** An instant at the given Almaty wall clock (UTC+5, no daylight saving). */
const almaty = (clock, day = 28) => {
  const [h, m, s = 0] = clock.split(':').map(Number);
  return new Date(Date.UTC(2026, 9, day, h - 5, m, s));
};
const decide = (extra = {}) =>
  paymentAvailability({
    guarded: true,
    now: almaty('12:00'),
    status: 'current',
    hours: HOURS,
    cart: basket,
    ...extra,
  });

test('an open restaurant with a fresh stop list and a sellable basket can pay', () => {
  assert.deepEqual(decide(), PAYMENT_AVAILABLE);
  // The first read and an unexpected answer are not reasons: the server decides at the press.
  for (const status of ['checking', 'error', undefined])
    assert.deepEqual(decide({ status }), PAYMENT_AVAILABLE, String(status));
  // A server without published hours accepts orders at any time.
  assert.deepEqual(decide({ hours: undefined, now: almaty('03:00') }), PAYMENT_AVAILABLE);
});

test('other builds, the design catalogue and the demonstration keep their own flow', () => {
  for (const extra of [
    { status: 'closed' },
    { now: almaty('03:00') },
    { status: 'offline' },
    { status: 'disabled' },
    { checkoutEnabled: false },
    { cart: [line('pick-combo', { available: false })] },
  ])
    assert.deepEqual(decide({ guarded: false, ...extra }), PAYMENT_AVAILABLE);
});

test('10:00-00:00: closed until 10:00 sharp and from midnight, «откроемся в 10:00»', () => {
  const closed = {
    canPay: false,
    stop: { kind: 'closed', opensAt: '10:00', opensTomorrow: false },
  };
  for (const clock of ['00:00', '00:27', '07:30', '09:59', '09:59:59'])
    assert.deepEqual(decide({ now: almaty(clock) }), closed, clock);
  for (const clock of ['10:00', '10:00:01', '15:00', '23:59', '23:59:59'])
    assert.deepEqual(decide({ now: almaty(clock) }), PAYMENT_AVAILABLE, clock);
  // The same instant read on a phone in another time zone: the published zone decides.
  assert.equal(zonedMinuteOfDay(almaty('09:59'), 'Asia/Almaty'), 9 * 60 + 59);
  assert.equal(zonedMinuteOfDay(almaty('09:59'), 'UTC'), 4 * 60 + 59);
  assert.equal(zonedMinuteOfDay(almaty('09:59'), 'Not/AZone'), null);
  assert.equal(zonedMinuteOfDay(new Date(NaN), 'Asia/Almaty'), null);
});

test('same-day hours open tomorrow after closing; overnight hours open the same day', () => {
  const day = { ...HOURS, openingTime: '09:00', closingTime: '21:00' };
  assert.deepEqual(decide({ hours: day, now: almaty('20:59') }), PAYMENT_AVAILABLE);
  assert.deepEqual(decide({ hours: day, now: almaty('21:00') }).stop, {
    kind: 'closed',
    opensAt: '09:00',
    opensTomorrow: true,
  });
  assert.equal(decide({ hours: day, now: almaty('08:59') }).stop.opensTomorrow, false);
  const night = { ...HOURS, openingTime: '18:00', closingTime: '02:00' };
  assert.deepEqual(decide({ hours: night, now: almaty('01:59') }), PAYMENT_AVAILABLE);
  assert.deepEqual(decide({ hours: night, now: almaty('02:00') }).stop, {
    kind: 'closed',
    opensAt: '18:00',
    opensTomorrow: false,
  });
  assert.deepEqual(decide({ hours: night, now: almaty('17:59') }).stop.kind, 'closed');
  assert.deepEqual(decide({ hours: night, now: almaty('18:00') }), PAYMENT_AVAILABLE);
});

test("the server's own «closed» wins over the device clock (opening minute, clock skew)", () => {
  // Hours say open at 10:00:01, the last long-poll still says closed: wait for the server.
  assert.deepEqual(decide({ now: almaty('10:00:01'), status: 'closed' }).stop, {
    kind: 'closed',
    opensAt: '10:00',
    opensTomorrow: false,
  });
  // Closed without published hours: the reason without a time.
  const bare = decide({ hours: undefined, status: 'closed' });
  assert.deepEqual(bare.stop, { kind: 'closed', opensAt: null, opensTomorrow: false });
  assert.equal(paymentStopMessage(bare.stop), 'Ресторан сейчас закрыт.');
  // Unknown published zone: no local verdict, the server's status still counts.
  assert.equal(publishedHoursStatus({ ...HOURS, timeZone: 'Not/AZone' }, almaty('03:00')), null);
  assert.deepEqual(
    decide({ hours: { ...HOURS, timeZone: 'Not/AZone' }, now: almaty('03:00') }),
    PAYMENT_AVAILABLE,
  );
});

test('server switch, connection, freshness and the stop list each stop the payment', () => {
  assert.deepEqual(decide({ status: 'disabled' }).stop, { kind: 'switched_off' });
  assert.deepEqual(decide({ checkoutEnabled: false }).stop, { kind: 'switched_off' });
  assert.deepEqual(decide({ checkoutEnabled: true }), PAYMENT_AVAILABLE);
  assert.deepEqual(decide({ checkoutEnabled: null }), PAYMENT_AVAILABLE);
  assert.deepEqual(decide({ status: 'offline' }).stop, { kind: 'offline' });
  assert.deepEqual(decide({ status: 'stale' }).stop, { kind: 'stale' });
  const stopped = [line('pick-combo', { available: false }), line('cola'), line('pick-combo')];
  assert.deepEqual(decide({ cart: stopped }).stop, {
    kind: 'unavailable',
    names: [product('pick-combo').name],
  });
});

test('a selected option that ran out also counts as not in stock', () => {
  const combo = product('pick-combo');
  const group = combo.modifierGroups.find((g) => g.options.length > 1);
  const option = group.options[0];
  const withStoppedOption = {
    ...combo,
    modifierGroups: combo.modifierGroups.map((g) =>
      g.id === group.id
        ? {
            ...g,
            options: g.options.map((o) => (o.id === option.id ? { ...o, available: false } : o)),
          }
        : g,
    ),
  };
  const cart = [
    {
      product: withStoppedOption,
      quantity: 1,
      selections: [{ group_id: group.id, option_id: option.id, quantity: 1 }],
    },
  ];
  assert.deepEqual(unavailableCartNames(cart), [combo.name]);
  assert.deepEqual(unavailableCartNames(basket), []);
});

test('the most useful reason comes first: closed, switch, connection, freshness, basket', () => {
  const everything = {
    now: almaty('03:00'),
    status: 'offline',
    checkoutEnabled: false,
    cart: [line('pick-combo', { available: false })],
  };
  assert.equal(decide(everything).stop.kind, 'closed');
  assert.equal(decide({ ...everything, now: almaty('12:00') }).stop.kind, 'switched_off');
  assert.equal(
    decide({ ...everything, now: almaty('12:00'), checkoutEnabled: null }).stop.kind,
    'offline',
  );
  assert.equal(
    decide({ ...everything, now: almaty('12:00'), checkoutEnabled: null, status: 'stale' }).stop
      .kind,
    'stale',
  );
  assert.equal(
    decide({ ...everything, now: almaty('12:00'), checkoutEnabled: null, status: 'current' }).stop
      .kind,
    'unavailable',
  );
});

test('banner and pay button texts in RU, KK and EN, plain hyphen only', () => {
  const stops = [
    { kind: 'closed', opensAt: '10:00', opensTomorrow: false },
    { kind: 'closed', opensAt: '09:00', opensTomorrow: true },
    { kind: 'switched_off' },
    { kind: 'offline' },
    { kind: 'stale' },
    { kind: 'unavailable', names: ['Пик Комбо', 'Кола'] },
  ];
  assert.deepEqual(stops.map(paymentStopMessage), [
    'откроемся в 10:00',
    'откроемся завтра в 09:00',
    'Оплата временно недоступна',
    'Не удалось связаться с сервером. Проверьте интернет - связь проверяется автоматически.',
    'Нет свежих данных от ресторана. Проверяем связь автоматически.',
    'Нет в наличии: Пик Комбо, Кола',
  ]);
  assert.deepEqual(stops.map(paymentStopLabel), [
    'Пока не работаем',
    'Пока не работаем',
    'Оплата недоступна',
    'Нет связи',
    'Нет связи',
    'Проверьте корзину',
  ]);
  const messages = JSON.parse(
    readFileSync(new URL('../../apps/mobile/src/i18n/messages.json', import.meta.url), 'utf8'),
  );
  for (const locale of ['kk', 'en']) {
    setAppLocale(locale);
    for (const stop of stops) {
      assert.notEqual(paymentStopLabel(stop), '', locale);
      for (const text of [paymentStopMessage(stop), paymentStopLabel(stop)]) {
        assert.doesNotMatch(text, /[—–]/, text);
        assert.doesNotMatch(text, /\{p\d\}/, text);
        // Translated: no Cyrillic left in the English text (product names come from the menu).
        if (locale === 'en' && stop.kind !== 'unavailable')
          assert.doesNotMatch(text, /[а-яё]/i, text);
      }
    }
    setAppLocale('ru');
  }
  for (const ru of [
    'откроемся в {p0}',
    'откроемся завтра в {p0}',
    'Оплата временно недоступна',
    'Нет в наличии: {p0}',
    'Пока не работаем',
    'Оплата недоступна',
    'Нет связи',
    'Проверьте корзину',
  ]) {
    const entry = messages.find((message) => message.ru === ru);
    assert.ok(entry?.kk && entry.en, ru);
  }
  setAppLocale('kk');
  assert.equal(paymentStopMessage(stops[0]), '10:00 ашыламыз');
  setAppLocale('en');
  assert.equal(paymentStopLabel(stops[0]), 'Closed for now');
  setAppLocale('ru');
});

test("header caption: today's hours while open, «откроемся в HH:MM» while closed", () => {
  const location = { opening_time: '10:00', closing_time: '00:00' };
  const open = restaurantHoursNow({ location, now: almaty('12:00') });
  assert.equal(headerHoursCaption(open.hours, open.status), '10:00-00:00');
  const night = restaurantHoursNow({ location, now: almaty('00:40') });
  assert.equal(headerHoursCaption(night.hours, night.status), 'откроемся в 10:00');
  // The server's hours win over the directory (the same hours the payment decision uses).
  const published = restaurantHoursNow({
    published: { openingTime: '09:00', closingTime: '21:00', timeZone: 'Asia/Almaty' },
    location,
    now: almaty('21:30'),
  });
  assert.equal(headerHoursCaption(published.hours, published.status), 'откроемся завтра в 09:00');
  const daytime = restaurantHoursNow({
    published: { openingTime: '09:00', closingTime: '21:00', timeZone: 'Asia/Almaty' },
    location,
    now: almaty('12:00'),
  });
  assert.equal(headerHoursCaption(daytime.hours, daytime.status), '09:00-21:00');
  // An unknown published zone falls back to the directory.
  const fallback = restaurantHoursNow({
    published: { ...HOURS, timeZone: 'Not/AZone' },
    location,
    now: almaty('12:00'),
  });
  assert.equal(headerHoursCaption(fallback.hours, fallback.status), '10:00-00:00');
  assert.equal(headerHoursCaption(null, null), 'Часы уточняются');
  assert.equal(headerHoursCaption({ closing_time: '22:00' }, null), 'до 22:00');
});

test('the minute clock wakes right after the next minute boundary', () => {
  const at = almaty('09:59:59').getTime();
  assert.equal(msUntilNextMinute(at), 1_050);
  assert.equal(msUntilNextMinute(almaty('10:00').getTime()), 60_050);
  assert.ok(msUntilNextMinute(at + 999) > 0);
  const woke = new Date(at + msUntilNextMinute(at));
  assert.deepEqual(
    paymentAvailability({ guarded: true, now: woke, hours: HOURS, cart: basket }),
    PAYMENT_AVAILABLE,
  );
});

test('the server switch seen by the cart reaches the bar for the same customer only', () => {
  const a = '40000000-0000-4000-8000-000000000001';
  const b = '40000000-0000-4000-8000-000000000002';
  let calls = 0;
  const unsubscribe = subscribeCheckoutSwitch(() => calls++);
  noteCheckoutSwitch(a, false);
  noteCheckoutSwitch(a, false);
  assert.equal(calls, 1, 'the same answer notifies once');
  assert.equal(checkoutEnabledFor(checkoutSwitchSnapshot(), a), false);
  assert.equal(checkoutEnabledFor(checkoutSwitchSnapshot(), b), null);
  assert.equal(checkoutEnabledFor(checkoutSwitchSnapshot(), undefined), null);
  noteCheckoutSwitch(null, true);
  assert.equal(calls, 1, 'a guest never writes an observation');
  noteCheckoutSwitch(a, true);
  assert.equal(checkoutEnabledFor(checkoutSwitchSnapshot(), a), true);
  assert.equal(calls, 2);
  unsubscribe();
  noteCheckoutSwitch(a, false);
  assert.equal(calls, 2);
});
