import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  AUTO_SEND_WINDOW_MS,
  BANK_RESUME_WINDOW_MS,
} from '../../apps/mobile/src/checkout-resume.ts';
import {
  closePendingPayment,
  parsePendingPayment,
} from '../../apps/mobile/src/payment-recovery.ts';
import { PAYMENT_RESUME_TITLE, paymentLaunch } from '../../apps/mobile/src/payment-resume.ts';
import { setAppLocale, t } from '../../apps/mobile/src/i18n/core.ts';

// Owner 28.10.2026 (TestFlight 26): «закрыли оплату, закрыли приложение, обратно заходим - сразу
// выходит окно "Отправляется счёт"». The app opens on the menu; a saved payment of an earlier run
// is tidied up or offered by a small banner, never pushed onto the screen.
const now = Date.parse('2026-10-28T12:00:00.000Z');
const iso = (offset) => new Date(now + offset).toISOString();
const ORDER = '40000000-0000-4000-8000-000000000006';
let keys = 0;
const intent = (changes = {}) => ({
  key: `40000000-0000-4000-8000-${String(0xd00 + ++keys).padStart(12, '0')}`,
  quoteId: '40000000-0000-4000-8000-000000000005',
  signature: '{"items":[]}',
  orderId: ORDER,
  sendInvoice: true,
  createdAt: now - 60_000,
  ...changes,
});
const order = (phase, changes = {}) => ({
  orderId: ORDER,
  phase,
  createdAt: iso(-60_000),
  updatedAt: iso(-60_000),
  expiresAt: null,
  ...changes,
});
const read = (path) =>
  readFileSync(new URL(`../../apps/mobile/src/${path}`, import.meta.url), 'utf8');
const squash = (value) => value.replace(/\s+/g, '');

test('no saved intent: nothing to read, remove or offer', () => {
  assert.deepEqual(paymentLaunch(null, undefined, now), {
    remove: false,
    banner: null,
    read: false,
  });
});

test('an open intent whose order the bank may still act on is offered by its phase', () => {
  const draft = intent();
  // The order is read first (GET only); until then nothing is shown or removed.
  assert.deepEqual(paymentLaunch(draft, undefined, now), {
    remove: false,
    banner: null,
    read: true,
  });
  assert.equal(paymentLaunch(draft, { ...order('sending'), orderId: draft.key }, now).read, true);
  const banner = (phase, changes) => paymentLaunch(draft, order(phase, changes), now);
  assert.deepEqual(banner('awaiting_payment', { expiresAt: iso(10 * 60_000) }), {
    remove: false,
    banner: 'kaspi',
    read: false,
  });
  // Honest at start: never «Отправляем счёт», the app only checks the order.
  assert.equal(banner('sending').banner, 'checking');
  assert.equal(banner('checking').banner, 'checking');
  // A fresh tap whose order is not billed yet (iOS closed the app right after it).
  assert.equal(banner('ready_to_pay').banner, 'unfinished');
  assert.equal(banner('awaiting_restaurant').banner, 'unfinished');
});

test('paid, failed, attention, stale and old unbilled orders are tidied up without a banner', () => {
  for (const phase of ['paid', 'preparing', 'ready', 'handed_over', 'failed', 'attention'])
    assert.deepEqual(
      paymentLaunch(intent(), order(phase), now),
      {
        remove: true,
        banner: null,
        read: false,
      },
      phase,
    );
  // Not billed and the tap is older than the automatic invoice window: never billed later.
  const old = intent({ createdAt: now - AUTO_SEND_WINDOW_MS - 1 });
  assert.equal(paymentLaunch(old, order('ready_to_pay'), now).remove, true);
  // A bank wait that outlived its window, an invoice past its deadline.
  const long = intent({ createdAt: now - BANK_RESUME_WINDOW_MS - 120_000 });
  const stale = iso(-BANK_RESUME_WINDOW_MS - 60_000);
  assert.equal(
    paymentLaunch(long, order('sending', { createdAt: stale, updatedAt: stale }), now).remove,
    true,
  );
  assert.equal(
    paymentLaunch(long, order('awaiting_payment', { expiresAt: iso(-10 * 60_000) }), now).remove,
    true,
  );
});

test('an intent that never became a known order: an old one goes, a fresh one is offered', () => {
  const fresh = intent({ orderId: undefined });
  delete fresh.orderId;
  assert.deepEqual(paymentLaunch(fresh, undefined, now), {
    remove: false,
    banner: 'unfinished',
    read: false,
  });
  assert.equal(
    paymentLaunch({ ...fresh, createdAt: now - AUTO_SEND_WINDOW_MS - 1 }, undefined, now).remove,
    true,
  );
  const legacy = { ...fresh };
  delete legacy.createdAt;
  assert.equal(paymentLaunch(legacy, undefined, now).remove, true, 'build 20 drafts carry no time');
  // Closed: no automatic invoice is left, nothing was billed - it goes.
  assert.equal(paymentLaunch(closePendingPayment(fresh, now), undefined, now).remove, true);
});

test('a closed intent stays closed after a restart: no banner, only the tidy-up', () => {
  // As the X of «Отправляем счёт» leaves it, read back by a new app run: the key is not in this
  // run's memory, only `closedAt` in storage says it was closed.
  const stored = JSON.stringify({ ...intent(), sendInvoice: false, closedAt: now - 30_000 });
  const restarted = parsePendingPayment(stored);
  for (const phase of ['sending', 'awaiting_payment', 'checking'])
    assert.deepEqual(
      paymentLaunch(restarted, order(phase), now),
      {
        remove: false,
        banner: null,
        read: false,
      },
      phase,
    );
  // Its order needs one read to know whether it can be tidied up.
  assert.equal(paymentLaunch(restarted, undefined, now).read, true);
  // Paid, failed, attention, or not billed (closed: no automatic invoice is left) - it goes.
  for (const phase of ['paid', 'failed', 'attention', 'ready_to_pay', 'awaiting_restaurant'])
    assert.equal(paymentLaunch(restarted, order(phase), now).remove, true, phase);
});

test('banner wording in RU, KK and EN, plain hyphen, never «Отправляем счёт»', () => {
  const messages = JSON.parse(
    readFileSync(new URL('../../apps/mobile/src/i18n/messages.json', import.meta.url), 'utf8'),
  );
  const own = [...Object.values(PAYMENT_RESUME_TITLE), 'Скрыть напоминание об оплате'];
  for (const ru of [...own, 'Открыть заказ']) {
    const entry = messages.find((message) => message.ru === ru);
    assert.ok(entry?.kk && entry.en, ru);
    for (const text of [entry.ru, entry.kk, entry.en]) assert.doesNotMatch(text, /[—–]/, text);
  }
  for (const title of Object.values(PAYMENT_RESUME_TITLE))
    assert.doesNotMatch(title, /Отправляем|Отправляется/);
  setAppLocale('en');
  assert.equal(t(PAYMENT_RESUME_TITLE.kaspi), 'Your order is waiting for payment in Kaspi');
  setAppLocale('kk');
  assert.equal(t(PAYMENT_RESUME_TITLE.checking), 'Тапсырыс төлемін тексеріп жатырмыз');
  setAppLocale('ru');
});

test('the start never navigates to a payment screen and never sends anything', () => {
  const recovery = read('components/PaymentRecovery.tsx');
  // Before 28.10: router.push('/checkout') whenever a saved intent was not closed in memory.
  assert.doesNotMatch(recovery, /useRouter|router\.|\.push\(|navigate\(|dismissTo|Redirect/);
  assert.doesNotMatch(recovery, /'POST'|\}\/payment|\/quotes/);
  assert.match(recovery, /`\/v1\/customer-checkout\/orders\/\$\{orderId\}`,\s*'GET'/);
  // A tidy-up removes only the intent it read (a pay tap may have saved a newer one) and leaves
  // the payment screens and sign-in alone while they are open.
  assert.ok(squash(recovery).includes('if(!active||latest?.key!==draft.key)returnfalse;'));
  assert.ok(squash(recovery).includes("['/checkout','/cart','/auth','/order-status']"));
  // A paid order takes its lines out of the restored cart, as its payment screen does.
  assert.ok(squash(recovery).includes('if(paid&&!settled)'));
  assert.ok(squash(recovery).includes('matchesPaidComboCart(draft.signature,signature)'));
  assert.match(read('app/_layout.tsx'), /<PaymentRecovery \/>/);
  // The menu's tab is the start route.
  assert.match(read('app/index.tsx'), /<Redirect href="\/\(tabs\)\/menu" \/>/);
});

test('the cart and «Заказы» never take over with an intent of an earlier run or a closed one', () => {
  const screen = squash(read('screens/KaspiCheckoutScreen.tsx'));
  assert.ok(
    screen.includes(
      "!pendingPaymentClosed(draft)&&((props.screenId!=='M19'&&props.screenId!=='M09')||pendingPaymentOfThisRun(draft))",
    ),
  );
  // X keeps the intent closed in storage (not only in memory), the next pay tap reopens it.
  assert.ok(screen.includes('constkept=closePendingPayment(draft,Date.now());'));
  assert.ok(screen.includes('saved=AsyncStorage.setItem(key,JSON.stringify(kept));'));
  assert.ok(screen.includes('constdraft=reopenPendingPayment(saved);'));
  assert.ok(screen.includes('adoptPendingPayment(draft.key);setIntentSaved(draft.key);'));
  assert.doesNotMatch(screen, /pendingPaymentDismissed/);
});

test('the banner sits in the dock above the cart bar on the menu only, with a11y and 44 pt X', () => {
  const banner = read('components/PaymentResumeBanner.tsx');
  for (const id of ['payment-resume-banner', 'payment-resume-open', 'payment-resume-close'])
    assert.ok(banner.includes(`testID="${id}"`), id);
  assert.equal(banner.split('accessibilityRole="button"').length - 1, 2);
  assert.ok(squash(banner).includes("adoptPendingPayment(resume.key);router.push('/checkout');"));
  assert.ok(squash(banner).includes('onPress={()=>voidhidePaymentResume(resume)}'));
  assert.ok(squash(banner).includes('width:44,minHeight:44'));
  const dock = squash(read('components/TabCartDock.tsx'));
  assert.ok(
    dock.includes(
      '{focused&&resume&&!preview?(<PaymentResumeBannercartBelow={model.cart.length>0}/>',
    ),
  );
  assert.ok(dock.indexOf('<PaymentResumeBanner') < dock.indexOf('<CartShortcut'));
  assert.ok(
    squash(read('components/FloatingTabBar.tsx')).includes(
      "resume={state.routes[state.index]?.name==='menu'}",
    ),
  );
  // X: the same persisted «closed» as the payment screen's X.
  const recovery = squash(read('components/PaymentRecovery.tsx'));
  assert.ok(recovery.includes('closePendingPayment(draft,Date.now())'));
});
