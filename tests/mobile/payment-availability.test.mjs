import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { testCompleteCatalog } from '@pickchick/test-order-flow/complete-catalog';
import { setAppLocale } from '../../apps/mobile/src/i18n/core.ts';
import {
  CLOCK_SKEW_MINUTES,
  PAYMENT_AVAILABLE,
  bannerAnnouncement,
  checkoutEnabledFor,
  checkoutSwitchSnapshot,
  headerHoursNow,
  joinSentences,
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
import {
  appHeaderCaptionMinScale,
  appHeaderMetrics,
} from '../../apps/mobile/src/app-header-metrics.ts';
import { defaultSelections } from '../../apps/mobile/src/domain.ts';

// Owner 28.10.2026 (Drinkit reference): a closed restaurant or a payment that cannot go through
// shows no payment handle on the cart bar, a red reason in the cart and a grey pay button.
// Screen behaviour is covered end to end by browser_cart_unavailable.py.

afterEach(() => setAppLocale('ru'));

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
/** The restaurant directory's hours (config/restaurant-locations.json, Almaty). */
const LOCATION = { opening_time: '10:00', closing_time: '00:00' };
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
  // A re-read (the menu refreshes) keeps the last answer: the handle does not blink.
  assert.deepEqual(decide({ status: 'checking', known: true }), PAYMENT_AVAILABLE);
  // A server without published hours accepts orders at any time.
  assert.deepEqual(decide({ hours: undefined, now: almaty('03:00') }), PAYMENT_AVAILABLE);
  assert.deepEqual(
    decide({ hours: undefined, known: true, directory: LOCATION, now: almaty('03:00') }),
    PAYMENT_AVAILABLE,
    'the directory never closes what the server has answered open',
  );
});

test('before the first availability answer nothing is payable (QA 28.10, launch)', () => {
  // The app starts with a saved cart and the long-poll has not answered yet: no handle, no pay.
  const launch = { status: 'checking', hours: undefined, known: false };
  assert.deepEqual(decide(launch), { canPay: false, stop: { kind: 'checking' } });
  assert.deepEqual(decide({ ...launch, status: undefined, known: undefined }).stop, {
    kind: 'checking',
  });
  // Closed by the directory hours the header already shows: the same reason as the header.
  assert.deepEqual(decide({ ...launch, directory: LOCATION, now: almaty('09:30') }).stop, {
    kind: 'closed',
    opensAt: '10:00',
    opensTomorrow: false,
  });
  assert.deepEqual(decide({ ...launch, directory: LOCATION, now: almaty('12:00') }).stop, {
    kind: 'checking',
  });
  // The first read fails with an unexpected answer (a captive portal page, a broken proxy): no
  // connection to the server, still closed first by the directory.
  assert.deepEqual(decide({ ...launch, status: 'error' }).stop, { kind: 'offline' });
  assert.equal(
    decide({ ...launch, status: 'error', directory: LOCATION, now: almaty('03:00') }).stop.kind,
    'closed',
  );
  // An unexpected answer after earlier answers: the kept hours still close, then no connection.
  assert.deepEqual(decide({ status: 'error', known: true }).stop, { kind: 'offline' });
  assert.equal(decide({ status: 'error', known: true, now: almaty('09:00') }).stop.kind, 'closed');
  // The switch the cart has seen and the phone's own offline state still say why.
  assert.equal(decide({ ...launch, status: 'offline' }).stop.kind, 'offline');
  assert.equal(decide({ ...launch, checkoutEnabled: false }).stop.kind, 'switched_off');
  // No banner for the first read (it usually takes a second), a grey «Проверяем…».
  assert.equal(paymentStopMessage({ kind: 'checking' }), null);
  assert.equal(paymentStopLabel({ kind: 'checking' }), 'Проверяем…');
  // Other builds keep their own flow.
  assert.deepEqual(decide({ ...launch, guarded: false }), PAYMENT_AVAILABLE);
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
  // One short line without a closing period, like every other reason (QA 28.10).
  assert.equal(paymentStopMessage(bare.stop), 'Ресторан сейчас закрыт');
  // Hours open around the clock and the server still says closed: no opening time to promise.
  const always = { ...HOURS, openingTime: '00:00', closingTime: '00:00' };
  assert.deepEqual(decide({ hours: always, status: 'closed' }).stop, bare.stop);
  // Unknown published zone: no local verdict, the server's status still counts.
  assert.equal(publishedHoursStatus({ ...HOURS, timeZone: 'Not/AZone' }, almaty('03:00')), null);
  assert.deepEqual(
    decide({ hours: { ...HOURS, timeZone: 'Not/AZone' }, now: almaty('03:00') }),
    PAYMENT_AVAILABLE,
  );
});

test('server «closed» against a phone clock that still reads open: the nearer boundary', () => {
  // A phone a little behind at 20:59 while the server has closed at 21:00 (same-day hours):
  // the restaurant has just closed, so it opens tomorrow (review 28.10).
  const day = { ...HOURS, openingTime: '09:00', closingTime: '21:00' };
  assert.deepEqual(decide({ hours: day, now: almaty('20:59'), status: 'closed' }).stop, {
    kind: 'closed',
    opensAt: '09:00',
    opensTomorrow: true,
  });
  // The same hours a little after the opening minute: the server opens today at 09:00.
  assert.deepEqual(decide({ hours: day, now: almaty('09:01'), status: 'closed' }).stop, {
    kind: 'closed',
    opensAt: '09:00',
    opensTomorrow: false,
  });
  // 10:00-00:00 at 23:59 on the phone: after midnight the opening is the same day.
  assert.deepEqual(decide({ now: almaty('23:59'), status: 'closed' }).stop, {
    kind: 'closed',
    opensAt: '10:00',
    opensTomorrow: false,
  });
  // Overnight 18:00-02:00 at 01:58 on the phone: it opens again at 18:00 the same day.
  const night = { ...HOURS, openingTime: '18:00', closingTime: '02:00' };
  assert.deepEqual(decide({ hours: night, now: almaty('01:58'), status: 'closed' }).stop, {
    kind: 'closed',
    opensAt: '18:00',
    opensTomorrow: false,
  });
  assert.equal(
    paymentStopMessage(decide({ hours: day, now: almaty('20:59'), status: 'closed' }).stop),
    'откроемся завтра в 09:00',
  );
});

test('server «closed» inside its hours, away from a boundary: a pause, no opening promised', () => {
  // Review 29.10.2026: orderingOpen false at 15:30 Almaty read as clock skew, so the header and
  // the cart said «откроемся в 10:00» in the afternoon while «Рестораны» said open until 00:00.
  for (const clock of ['10:16', '15:30', '23:44'])
    assert.deepEqual(
      decide({ now: almaty(clock), status: 'closed' }).stop,
      { kind: 'switched_off' },
      clock,
    );
  const paused = decide({ now: almaty('15:30'), status: 'closed' });
  assert.equal(paymentStopMessage(paused.stop), 'Оплата временно недоступна');
  assert.equal(paymentStopLabel(paused.stop), 'Оплата недоступна');
  // Within CLOCK_SKEW_MINUTES of a boundary it is still the clocks disagreeing.
  assert.equal(CLOCK_SKEW_MINUTES, 15);
  for (const clock of ['10:00:01', '10:15', '23:45', '23:59'])
    assert.deepEqual(
      decide({ now: almaty(clock), status: 'closed' }).stop,
      { kind: 'closed', opensAt: '10:00', opensTomorrow: false },
      clock,
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
    { kind: 'closed', opensAt: null, opensTomorrow: false },
    { kind: 'checking' },
  ];
  assert.deepEqual(stops.map(paymentStopMessage), [
    'откроемся в 10:00',
    'откроемся завтра в 09:00',
    'Оплата временно недоступна',
    // One short line for the banner (review 28.10); the long advice stays in availability.ts.
    'Нет связи с сервером',
    'Нет свежих данных от ресторана. Проверяем связь автоматически.',
    'Нет в наличии: Пик Комбо, Кола',
    'Ресторан сейчас закрыт',
    null,
  ]);
  assert.deepEqual(stops.map(paymentStopLabel), [
    'Пока не работаем',
    'Пока не работаем',
    'Оплата недоступна',
    'Нет связи',
    // A stale restaurant stop list is not the customer's connection (review 28.10).
    'Оплата недоступна',
    'Проверьте корзину',
    'Пока не работаем',
    'Проверяем…',
  ]);
  const messages = JSON.parse(
    readFileSync(new URL('../../apps/mobile/src/i18n/messages.json', import.meta.url), 'utf8'),
  );
  for (const locale of ['ru', 'kk', 'en']) {
    setAppLocale(locale);
    for (const stop of stops) {
      assert.notEqual(paymentStopLabel(stop), '', locale);
      const reason = paymentStopMessage(stop);
      for (const text of [reason, paymentStopLabel(stop)].filter((value) => value !== null)) {
        assert.doesNotMatch(text, /[—–]/, text);
        assert.doesNotMatch(text, /\{p\d\}/, text);
        // Translated: no Cyrillic left in the English text (product names come from the menu).
        if (locale === 'en' && stop.kind !== 'unavailable')
          assert.doesNotMatch(text, /[а-яё]/i, text);
        // English UI text starts with a capital letter (QA 28.10: «opening at 10:00»); Russian
        // keeps Drinkit's lower-case «откроемся».
        if (locale === 'en') assert.match(text, /^\p{Lu}/u, text);
      }
      // Short banner reasons end without a period (QA 28.10); only the two-sentence stale
      // wording, shared with availability.ts, keeps its own.
      if (reason && stop.kind !== 'stale')
        assert.doesNotMatch(reason, /\.$/, `${locale} ${reason}`);
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
    'Нет связи с сервером',
    'Ресторан сейчас закрыт',
    'Проверяем…',
  ]) {
    const entry = messages.find((message) => message.ru === ru);
    assert.ok(entry?.kk && entry.en, ru);
  }
  // Kazakh: a neutral form, no case suffix that would depend on the number (review 28.10).
  setAppLocale('kk');
  assert.equal(paymentStopMessage(stops[0]), 'Ашылады: 10:00');
  assert.equal(paymentStopMessage(stops[1]), 'Ертең ашылады: 09:00');
  assert.equal(paymentStopMessage(stops[3]), 'Сервермен байланыс жоқ');
  assert.equal(
    headerHoursCaption(null, { open: false, opensAt: '7:30', opensTomorrow: false }),
    'Ашылады: 7:30',
  );
  setAppLocale('en');
  assert.equal(paymentStopLabel(stops[0]), 'Closed for now');
  assert.equal(paymentStopMessage(stops[0]), 'Opening at 10:00');
  assert.equal(paymentStopMessage(stops[1]), 'Opening tomorrow at 09:00');
  assert.equal(
    headerHoursCaption(null, { open: false, opensAt: '10:00', opensTomorrow: false }),
    'Opening at 10:00',
  );
  assert.equal(paymentStopMessage(stops[6]), 'The restaurant is closed right now');
  assert.equal(paymentStopLabel(stops[7]), 'Checking…');
  assert.equal(paymentStopMessage(stops[3]), 'No connection to the server');
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
  assert.equal(headerHoursCaption(null, null), 'Часы работы не указаны');
  // At the largest text the caption shrinks on iOS instead of truncating, never below its normal
  // size: what fits at the normal size (browser_cart_unavailable.py H, 320 pt) fits at every size.
  assert.ok(appHeaderCaptionMinScale < 1);
  assert.ok(Math.abs(appHeaderCaptionMinScale * appHeaderMetrics.maxFontScale - 1) < 1e-9);
  assert.equal(headerHoursCaption({ closing_time: '22:00' }, null), 'до 22:00');
});

test('header caption follows the payment decision; other builds keep their hours', () => {
  const caption = (input) => {
    const { hours, status } = headerHoursNow({ location: LOCATION, ...input });
    return headerHoursCaption(hours, status);
  };
  const night = almaty('03:00');
  const at = (now, extra = {}) => ({ now, ...extra });
  const closed = decide({ now: night });
  assert.equal(
    caption({ ...at(night), guarded: true, availability: closed, published: HOURS }),
    'откроемся в 10:00',
  );
  // Builds without the Kaspi checkout (the simulator, the design catalogue): today's hours, as
  // before 28.10 (QA 28.10), even at night.
  assert.equal(
    caption({ ...at(night), guarded: false, availability: PAYMENT_AVAILABLE }),
    '10:00-00:00',
  );
  // A server that publishes no hours takes orders at night: the bar has its handle, so the header
  // shows today's hours, never «откроемся» next to a handle (QA 28.10, owner question Q4).
  const noHours = decide({ hours: undefined, known: true, directory: LOCATION, now: night });
  assert.deepEqual(noHours, PAYMENT_AVAILABLE);
  assert.equal(caption({ ...at(night), guarded: true, availability: noHours }), '10:00-00:00');
  // Before the first answer at 09:30: closed by the directory, the header and the cart agree.
  const launch = decide({
    status: 'checking',
    hours: undefined,
    directory: LOCATION,
    now: almaty('09:30'),
  });
  assert.equal(
    caption({ ...at(almaty('09:30')), guarded: true, availability: launch }),
    'откроемся в 10:00',
  );
  // The server's own «closed» against a phone clock still open: the header says it too.
  const skew = decide({ now: almaty('23:59'), status: 'closed' });
  assert.equal(
    caption({ ...at(almaty('23:59')), guarded: true, availability: skew, published: HOURS }),
    'откроемся в 10:00',
  );
  // Closed without an opening time of the server's own: the directory's when it says closed.
  const bare = { canPay: false, stop: { kind: 'closed', opensAt: null, opensTomorrow: false } };
  assert.equal(caption({ ...at(night), guarded: true, availability: bare }), 'откроемся в 10:00');
  assert.equal(
    caption({ ...at(almaty('12:00')), guarded: true, availability: bare }),
    '10:00-00:00',
  );
  // Other reasons (no connection, the switch, the first read) keep today's hours.
  for (const kind of ['offline', 'switched_off', 'checking', 'stale'])
    assert.equal(
      caption({
        ...at(almaty('12:00')),
        guarded: true,
        availability: { canPay: false, stop: { kind } },
      }),
      '10:00-00:00',
      kind,
    );
});

test('the minute clock wakes right after the next minute boundary', () => {
  const at = almaty('09:59:59').getTime();
  assert.equal(msUntilNextMinute(at), 1_050);
  assert.equal(msUntilNextMinute(almaty('10:00').getTime()), 60_050);
  assert.ok(msUntilNextMinute(at + 999) > 0);
  const woke = new Date(at + msUntilNextMinute(at));
  assert.deepEqual(
    paymentAvailability({
      guarded: true,
      now: woke,
      status: 'current',
      known: true,
      hours: HOURS,
      cart: basket,
    }),
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

test('screen reader texts: one period between sentences, a changed reason announced once', () => {
  const hint = 'Открыть состав заказа';
  assert.equal(joinSentences('Ресторан сейчас закрыт.', hint), 'Ресторан сейчас закрыт. ' + hint);
  assert.equal(
    joinSentences('Нет свежих данных от ресторана. Проверяем связь автоматически.', hint),
    'Нет свежих данных от ресторана. Проверяем связь автоматически. ' + hint,
  );
  assert.equal(joinSentences('откроемся в 10:00', hint), 'откроемся в 10:00. ' + hint);
  assert.equal(joinSentences('Нет связи с сервером!  ', hint), 'Нет связи с сервером. ' + hint);
  assert.equal(joinSentences('', hint), hint);
  for (const stop of [
    { kind: 'closed', opensAt: null, opensTomorrow: false },
    { kind: 'offline' },
    { kind: 'stale' },
  ])
    assert.doesNotMatch(joinSentences(paymentStopMessage(stop), hint), /\.\./);
  // The banner mounts with the cart: its first reason is read with the screen, not announced.
  assert.equal(bannerAnnouncement(undefined, 'откроемся в 10:00'), null);
  assert.equal(bannerAnnouncement(undefined, null), null);
  // 00:00 while the cart is open: the reason appears and is announced once.
  assert.equal(bannerAnnouncement(null, 'откроемся в 10:00'), 'откроемся в 10:00');
  assert.equal(bannerAnnouncement('откроемся в 10:00', 'откроемся в 10:00'), null);
  assert.equal(
    bannerAnnouncement('откроемся в 10:00', 'Нет связи с сервером'),
    'Нет связи с сервером',
  );
  // Paying possible again: the banner goes away silently (the button speaks for itself).
  assert.equal(bannerAnnouncement('Нет связи с сервером', null), null);
});
