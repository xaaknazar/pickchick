import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AUTO_SEND_WINDOW_MS,
  BANK_RESUME_WINDOW_MS,
  INVOICE_GRACE_MS,
  STUCK_AFTER_MS,
  STUCK_NOTICE_MS,
  closeDelay,
  closeNeedsConfirm,
  closedIntent,
  draftCanAutoSend,
  draftIsFinal,
  draftOwns,
  liveBankAction,
  noteBankCommand,
  paymentStuck,
  paymentWaitPhase,
  resumableOrder,
  staleBankAction,
  supportAtOnce,
  waitSince,
} from '../../apps/mobile/src/checkout-resume.ts';
import {
  closePendingPayment,
  dismissPendingPayment,
  parsePendingPayment,
  pendingPaymentClosed,
  reopenPendingPayment,
} from '../../apps/mobile/src/payment-recovery.ts';

// Audit 0.2 / 2.0 / 2.1 / 2.4: a saved payment draft or an old unpaid order must never trap
// the customer, while an order that may still take money keeps blocking a second invoice.
const now = Date.parse('2026-10-19T12:00:00.000Z');
const iso = (offset) => new Date(now + offset).toISOString();
const order = (phase, changes = {}) => ({
  orderId: '40000000-0000-4000-8000-000000000006',
  phase,
  createdAt: iso(-60_000),
  updatedAt: iso(-60_000),
  expiresAt: null,
  ...changes,
});
const draft = {
  key: '40000000-0000-4000-8000-000000000004',
  quoteId: '40000000-0000-4000-8000-000000000005',
  signature: '{"items":[]}',
  sendInvoice: true,
};

test('only an order that may still take money blocks a new checkout', () => {
  for (const phase of ['sending', 'checking', 'awaiting_payment'])
    assert.equal(liveBankAction(order(phase), now), true, phase);
  for (const phase of [
    'awaiting_restaurant',
    'ready_to_pay',
    'failed',
    'attention',
    'paid',
    'preparing',
    'ready',
    'handed_over',
  ])
    assert.equal(liveBankAction(order(phase), now), false, phase);
  // A known invoice deadline bounds the wait (plus grace for a late bank answer).
  assert.equal(
    liveBankAction(order('awaiting_payment', { expiresAt: iso(-INVOICE_GRACE_MS + 1000) }), now),
    true,
  );
  assert.equal(
    liveBankAction(order('awaiting_payment', { expiresAt: iso(-INVOICE_GRACE_MS - 1000) }), now),
    false,
  );
  // Without a deadline the last observed change (or the customer's own tap) bounds it.
  const old = { createdAt: iso(-BANK_RESUME_WINDOW_MS - 1000) };
  assert.equal(liveBankAction(order('checking', { ...old, updatedAt: old.createdAt }), now), false);
  assert.equal(
    liveBankAction(order('checking', { ...old, updatedAt: old.createdAt }), now, now - 1000),
    true,
  );
  assert.equal(liveBankAction(order('sending', { ...old, updatedAt: iso(-1000) }), now), true);
});

test('the resumed order is the newest live one; unbilled and settled orders are left alone', () => {
  const live = order('awaiting_payment', { orderId: '40000000-0000-4000-8000-000000000007' });
  assert.equal(resumableOrder([order('attention'), order('ready_to_pay'), live], now), live);
  assert.equal(
    resumableOrder([order('ready_to_pay'), order('awaiting_restaurant'), order('attention')], now),
    undefined,
  );
});

test('a draft ends with the order: paid, failed, refused and attention clear it', () => {
  for (const phase of ['paid', 'preparing', 'ready', 'handed_over', 'failed', 'attention'])
    assert.equal(draftIsFinal(order(phase), draft, now), true, phase);
  for (const phase of ['sending', 'checking', 'awaiting_payment'])
    assert.equal(draftIsFinal(order(phase), draft, now), false, phase);
  // An unbilled order keeps a fresh draft (the invoice is sent on admission), not a stale one.
  const fresh = { ...draft, createdAt: now - 1000 };
  for (const phase of ['ready_to_pay', 'awaiting_restaurant']) {
    assert.equal(draftIsFinal(order(phase), fresh, now), false, phase);
    assert.equal(draftIsFinal(order(phase), draft, now), true, `${phase} legacy draft`);
    assert.equal(
      draftIsFinal(order(phase), { ...draft, createdAt: now - AUTO_SEND_WINDOW_MS - 1 }, now),
      true,
    );
  }
});

test('an invoice is sent automatically only from a fresh explicit tap', () => {
  assert.equal(draftCanAutoSend({ ...draft, createdAt: now - 1000 }, now), true);
  assert.equal(
    draftCanAutoSend({ ...draft, createdAt: now - AUTO_SEND_WINDOW_MS - 1 }, now),
    false,
  );
  // Drafts written by build 20 carry no time: never resent without a new tap.
  assert.equal(draftCanAutoSend(draft, now), false);
  assert.equal(draftCanAutoSend({ ...draft, sendInvoice: false, createdAt: now }, now), false);
  assert.equal(draftCanAutoSend(null, now), false);
});

test('every non-final payment screen offers a way out', () => {
  for (const phase of ['attention', 'ready_to_pay', 'awaiting_restaurant'])
    assert.equal(closeDelay(order(phase), now), 0, phase);
  for (const phase of ['sending', 'checking', 'awaiting_payment'])
    assert.equal(closeDelay(order(phase), now), STUCK_AFTER_MS, phase);
  assert.equal(
    closeDelay(order('checking', { expiresAt: iso(-INVOICE_GRACE_MS - 1) }), now),
    0,
    'a dead invoice is closable at once',
  );
  assert.equal(closeDelay(undefined, now), STUCK_AFTER_MS);
  for (const phase of ['paid', 'failed']) assert.equal(closeDelay(order(phase), now), null);
});

test('drafts record their time; a customer close is remembered, also after a restart', () => {
  const timed = { ...draft, createdAt: now };
  assert.deepEqual(parsePendingPayment(JSON.stringify(timed)), timed);
  for (const createdAt of ['now', -1, 1.5])
    assert.throws(() => parsePendingPayment(JSON.stringify({ ...draft, createdAt })));
  assert.equal(pendingPaymentClosed(timed), false);
  // A storage write that failed still keeps it closed for the rest of this run.
  dismissPendingPayment(timed.key);
  assert.equal(pendingPaymentClosed(timed), true);
  assert.equal(pendingPaymentClosed({ ...timed, key: draft.quoteId }), false);
  assert.equal(pendingPaymentClosed(null), false);
  // Owner 28.10.2026 (TestFlight 26): «closed» is written into the intent itself, so an intent
  // read back by a new app run (another key, nothing in this run's memory) is still closed.
  const other = { ...timed, key: '40000000-0000-4000-8000-0000000000c1', sendInvoice: true };
  const closed = closePendingPayment(other, now + 1_000);
  assert.deepEqual(closed, { ...other, sendInvoice: false, closedAt: now + 1_000 });
  const restarted = parsePendingPayment(JSON.stringify(closed));
  assert.equal(restarted.closedAt, now + 1_000);
  assert.equal(draftCanAutoSend(restarted, now + 2_000), false, 'no automatic invoice');
  // Closing again keeps the first time; an explicit pay tap reopens it (no auto invoice back).
  assert.equal(closePendingPayment(restarted, now + 9_000).closedAt, now + 1_000);
  const reopened = reopenPendingPayment(restarted, now + 10_000);
  assert.equal(pendingPaymentClosed(reopened), false);
  assert.equal(reopened.closedAt, undefined);
  assert.equal(reopened.sendInvoice, false);
  assert.equal(reopened.reopenedAt, now + 10_000);
  assert.equal(pendingPaymentClosed(parsePendingPayment(JSON.stringify(reopened))), false);
  assert.equal(
    reopenPendingPayment(reopened, now + 20_000),
    reopened,
    'an open intent is not rewritten',
  );
  // Closed again: closed by its new time, the reopen time goes.
  const again = closePendingPayment(reopened, now + 30_000);
  assert.equal(again.closedAt, now + 30_000);
  assert.equal('reopenedAt' in again, false);
});

test('an intent closed by the X of TestFlight 26 stays closed after the update (review 28.10)', () => {
  // TestFlight 26 wrote only `sendInvoice: false` on X (no closedAt): read by TestFlight 27 in a
  // new run (nothing in memory) it is closed, not offered again.
  const legacy = {
    ...draft,
    key: '40000000-0000-4000-8000-0000000000c2',
    orderId: '40000000-0000-4000-8000-000000000006',
    sendInvoice: false,
    createdAt: now - 60_000,
  };
  const restarted = parsePendingPayment(JSON.stringify(legacy));
  assert.equal(pendingPaymentClosed(restarted), true);
  // An open intent of this build (a fresh tap) and a build-20 draft without the flag are open.
  assert.equal(
    pendingPaymentClosed({
      ...legacy,
      key: '40000000-0000-4000-8000-0000000000c3',
      sendInvoice: true,
    }),
    false,
  );
  const build20 = { ...legacy, key: '40000000-0000-4000-8000-0000000000c4' };
  delete build20.sendInvoice;
  assert.equal(pendingPaymentClosed(build20), false);
  // The next explicit pay tap opens it again, without its automatic invoice.
  const reopened = reopenPendingPayment(restarted, now);
  assert.notEqual(reopened, restarted);
  assert.deepEqual(reopened, { ...legacy, reopenedAt: now });
  assert.equal(pendingPaymentClosed(reopened), false);
  assert.equal(draftCanAutoSend(reopened, now), false);
});

test('an invoice requested now for an older unpaid order still holds a new checkout', () => {
  // Review 20.10: the order view carries no attempt time. An order created long ago and paid
  // from «Заказы» just now must not look stale while its invoice is being issued.
  const old = order('sending', {
    orderId: '40000000-0000-4000-8000-000000000031',
    createdAt: iso(-BANK_RESUME_WINDOW_MS - 60_000),
    updatedAt: iso(-BANK_RESUME_WINDOW_MS - 60_000),
  });
  assert.equal(liveBankAction(old, now), false);
  assert.equal(resumableOrder([old], now), undefined);
  noteBankCommand(old.orderId, now - 5_000);
  assert.equal(liveBankAction(old, now), true);
  assert.equal(resumableOrder([old], now), old);
  assert.equal(closeDelay(old, now), STUCK_AFTER_MS);
  // Bounded like any other bank wait.
  assert.equal(liveBankAction(old, now + BANK_RESUME_WINDOW_MS), false);
  // Another order with the same age is not affected.
  assert.equal(
    liveBankAction({ ...old, orderId: '40000000-0000-4000-8000-000000000032' }, now),
    false,
  );
});

test('a saved intent belongs only to the order it created', () => {
  // Review 20.10: «Заказы» may show an older order while an intent is pending; that order must
  // never auto-send, settle or clear the intent of another one.
  const own = { ...draft, orderId: '40000000-0000-4000-8000-000000000006', createdAt: now };
  assert.equal(draftOwns(own, own.orderId), true);
  assert.equal(draftOwns(own, '40000000-0000-4000-8000-000000000013'), false);
  // An intent whose create command has not answered yet belongs to no listed order.
  assert.equal(draftOwns({ ...draft, createdAt: now }, own.orderId), false);
  assert.equal(draftOwns(null, own.orderId), false);
});

test('a bank wait past its window offers the support contact at once', () => {
  // Lane 0.2: «checking too long», a stuck sending or an expired invoice needs a person.
  const old = {
    createdAt: iso(-BANK_RESUME_WINDOW_MS - 1000),
    updatedAt: iso(-BANK_RESUME_WINDOW_MS - 1000),
  };
  assert.equal(staleBankAction(order('checking', old), now), true);
  assert.equal(staleBankAction(order('sending', old), now), true);
  assert.equal(
    staleBankAction(order('awaiting_payment', { expiresAt: iso(-INVOICE_GRACE_MS - 1) }), now),
    true,
  );
  for (const phase of ['checking', 'sending', 'awaiting_payment'])
    assert.equal(staleBankAction(order(phase), now), false, `${phase} still live`);
  for (const phase of ['attention', 'ready_to_pay', 'awaiting_restaurant', 'paid', 'failed'])
    assert.equal(staleBankAction(order(phase, old), now), false, phase);
});

test('a restaurant that does not admit the order for long offers the support contact', () => {
  // Lane 0.2: «awaiting_restaurant» is closable at once; after the waiting time a person helps.
  const silent = { createdAt: iso(-STUCK_AFTER_MS - 1000), updatedAt: iso(-STUCK_AFTER_MS - 1000) };
  assert.equal(supportAtOnce(order('awaiting_restaurant', silent), now), true);
  assert.equal(supportAtOnce(order('awaiting_restaurant'), now), false, 'still being admitted');
  // A stale bank wait keeps its own rule; an unbilled or settled order needs no contact.
  const old = {
    createdAt: iso(-BANK_RESUME_WINDOW_MS - 1000),
    updatedAt: iso(-BANK_RESUME_WINDOW_MS - 1000),
  };
  assert.equal(supportAtOnce(order('checking', old), now), true);
  assert.equal(supportAtOnce(order('checking'), now), false);
  for (const phase of ['ready_to_pay', 'paid', 'failed'])
    assert.equal(supportAtOnce(order(phase, old), now), false, phase);
});

test('a sending or restaurant wait says it is stuck after 20 s, on the phone clock of this screen', () => {
  // Owner 28.10.2026 (TestFlight 25): «Отправляем счёт» stayed with a spinner and nothing to press.
  assert.equal(STUCK_NOTICE_MS, 20_000);
  assert.equal(paymentStuck('sending', now, now + STUCK_NOTICE_MS - 1), null);
  assert.equal(paymentStuck('sending', now, now + STUCK_NOTICE_MS), 'bank');
  assert.equal(paymentStuck('awaiting_restaurant', now, now + 60_000), 'restaurant');
  // Every other phase has its own actions; the connecting scene (no order) has its own button.
  for (const phase of [
    undefined,
    'ready_to_pay',
    'awaiting_payment',
    'checking',
    'failed',
    'attention',
    'paid',
  ])
    assert.equal(paymentStuck(phase, now, now + 10 * 60_000), null, String(phase));
  // A clock moved backwards never claims a stuck wait.
  assert.equal(paymentStuck('sending', now, now - 60_000), null);
  assert.equal(paymentStuck('sending', now, Number.NaN), null);
});

test('a running payment command waits as «sending», a create command as the restaurant', () => {
  // Review 28.10.2026: POST /payment may run up to 60 s while the order still reads ready_to_pay,
  // and POST /orders may retry NOT_READY up to 60 s on the connecting scene.
  assert.equal(paymentWaitPhase('ready_to_pay', { commandRunning: true }), 'sending');
  assert.equal(paymentWaitPhase('ready_to_pay'), 'ready_to_pay');
  assert.equal(paymentWaitPhase(undefined, { creating: true }), 'awaiting_restaurant');
  // A connecting scene without a create command (a quote, a known order being read) has none.
  assert.equal(paymentWaitPhase(undefined), undefined);
  assert.equal(paymentWaitPhase(undefined, { commandRunning: true }), undefined);
  // The order's own phase wins everywhere else, also while a command still runs.
  for (const phase of ['sending', 'awaiting_payment', 'checking', 'failed', 'paid', 'attention'])
    assert.equal(paymentWaitPhase(phase, { commandRunning: true, creating: true }), phase);
  assert.equal(
    paymentStuck(paymentWaitPhase('ready_to_pay', { commandRunning: true }), now, now + 20_000),
    'bank',
  );
  assert.equal(
    paymentStuck(paymentWaitPhase(undefined, { creating: true }), now, now + 20_000),
    'restaurant',
  );
});

test('a wait keeps its first time in this app run, per order and phase, on the phone clock', () => {
  // Review 28.10.2026: X, then «Оплатить» again reopens an order that has been «sending» for
  // minutes: the honest text comes at once instead of after another 20 s.
  const id = 'wait-order-1';
  assert.equal(waitSince(id, 'sending', now), now);
  assert.equal(waitSince(id, 'sending', now + 5 * 60_000), now);
  assert.equal(
    paymentStuck('sending', waitSince(id, 'sending', now + 5 * 60_000), now + 5 * 60_000),
    'bank',
  );
  // Another phase of the same order starts again; so does a clock that moved backwards.
  assert.equal(waitSince(id, 'awaiting_payment', now + 6 * 60_000), now + 6 * 60_000);
  assert.equal(waitSince(id, 'sending', now + 7 * 60_000), now + 7 * 60_000);
  assert.equal(waitSince(id, 'sending', now + 60_000), now + 60_000);
  // Another order has its own wait.
  assert.equal(waitSince('wait-order-2', 'sending', now + 8 * 60_000), now + 8 * 60_000);
  // A create intent hands its restaurant wait to the order it became, never another phase.
  assert.equal(waitSince('intent:k1', 'awaiting_restaurant', now), now);
  assert.equal(waitSince('wait-order-3', 'awaiting_restaurant', now + 30_000, 'intent:k1'), now);
  assert.equal(waitSince('wait-order-4', 'sending', now + 30_000, 'intent:k1'), now + 30_000);
  assert.equal(
    waitSince('wait-order-5', 'awaiting_restaurant', now + 30_000, 'intent:none'),
    now + 30_000,
  );
  // Memory stays small: old waits are forgotten (and then start again).
  for (let i = 0; i < 40; i += 1) waitSince(`wait-filler-${i}`, 'sending', now);
  assert.equal(waitSince(id, 'sending', now + 9 * 60_000), now + 9 * 60_000);
});

test('the X asks first only while the bank may still act for this order', () => {
  const own = { ...draft, orderId: order('sending').orderId, createdAt: now - 60_000 };
  for (const phase of ['sending', 'awaiting_payment', 'checking'])
    assert.equal(closeNeedsConfirm(order(phase), now, { draft: own }), true, phase);
  // Unbilled, refused, failed and paid orders close at once: nothing can take money there.
  for (const phase of [
    'awaiting_restaurant',
    'ready_to_pay',
    'failed',
    'attention',
    'paid',
    'preparing',
  ])
    assert.equal(closeNeedsConfirm(order(phase), now, { draft: own }), false, phase);
  // A payment command of this screen still running: the screen may still read ready_to_pay.
  assert.equal(closeNeedsConfirm(order('ready_to_pay'), now, { commandRunning: true }), true);
  assert.equal(closeNeedsConfirm(order('failed'), now, { commandRunning: true }), false);
  // A bank wait past its window (dead invoice, sending for long) no longer takes money.
  const old = {
    createdAt: iso(-BANK_RESUME_WINDOW_MS - 1),
    updatedAt: iso(-BANK_RESUME_WINDOW_MS - 1),
  };
  assert.equal(closeNeedsConfirm(order('sending', old), now), false);
  assert.equal(
    closeNeedsConfirm(order('awaiting_payment', { expiresAt: iso(-INVOICE_GRACE_MS - 1) }), now),
    false,
  );
  // The intent's own tap bounds the wait of its order, also for an order created long ago.
  assert.equal(
    closeNeedsConfirm(order('sending', old), now, { draft: { ...own, createdAt: now } }),
    true,
  );
  // No order read yet: a saved intent that names an order may be at the bank; a create command
  // cut short (no order id) or no intent at all created nothing to charge.
  assert.equal(closeNeedsConfirm(undefined, now, { draft: own }), true);
  assert.equal(closeNeedsConfirm(undefined, now, { draft: { ...draft, createdAt: now } }), false);
  assert.equal(closeNeedsConfirm(undefined, now), false);
});

test('closing keeps an intent only while the bank may still act, never with an automatic invoice', () => {
  const id = order('sending').orderId;
  const own = { ...draft, orderId: id, createdAt: now - 60_000 };
  // The bank may act: the intent stays for recovery (the screen withdraws its automatic invoice).
  for (const phase of ['sending', 'awaiting_payment', 'checking'])
    assert.equal(closedIntent(own, order(phase), now), 'keep', phase);
  assert.equal(closedIntent(own, order('ready_to_pay'), now, true), 'keep', 'command running');
  // Unbilled or settled: nothing is left to recover, the intent goes (audit 2.1).
  for (const phase of ['awaiting_restaurant', 'ready_to_pay', 'attention', 'failed', 'paid'])
    assert.equal(closedIntent(own, order(phase), now), 'remove', phase);
  // An order the intent did not create never touches it (audit 2.4).
  assert.equal(closedIntent(own, { ...order('sending'), orderId: draft.quoteId }, now), 'none');
  assert.equal(closedIntent(null, order('sending'), now), 'none');
  // No order on screen: an intent naming its order may be at the bank; a create command cut
  // short never had a payment sent for it (the server cancels such an order unpaid).
  assert.equal(closedIntent(own, undefined, now), 'keep');
  assert.equal(closedIntent({ ...draft, createdAt: now }, undefined, now), 'remove');
  // A kept intent without its automatic invoice: the next tap reopens its order but never sends
  // an invoice for an unbilled one by itself (draftIsFinal), and nothing auto-sends after a restart.
  const kept = { ...own, sendInvoice: false };
  assert.equal(draftCanAutoSend(kept, now), false);
  assert.equal(draftIsFinal(order('ready_to_pay'), kept, now), true);
  assert.equal(draftIsFinal(order('awaiting_restaurant'), kept, now), true);
  assert.equal(draftIsFinal(order('sending'), kept, now), false);
  assert.equal(resumableOrder([order('sending')], now)?.phase, 'sending');
});
