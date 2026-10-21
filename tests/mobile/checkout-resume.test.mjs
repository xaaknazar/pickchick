import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AUTO_SEND_WINDOW_MS,
  BANK_RESUME_WINDOW_MS,
  INVOICE_GRACE_MS,
  STUCK_AFTER_MS,
  closeDelay,
  draftCanAutoSend,
  draftIsFinal,
  draftOwns,
  liveBankAction,
  noteBankCommand,
  resumableOrder,
  staleBankAction,
  supportAtOnce,
} from '../../apps/mobile/src/checkout-resume.ts';
import {
  dismissPendingPayment,
  parsePendingPayment,
  pendingPaymentDismissed,
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

test('drafts record their time; a customer close is remembered for this app session', () => {
  const timed = { ...draft, createdAt: now };
  assert.deepEqual(parsePendingPayment(JSON.stringify(timed)), timed);
  for (const createdAt of ['now', -1, 1.5])
    assert.throws(() => parsePendingPayment(JSON.stringify({ ...draft, createdAt })));
  assert.equal(pendingPaymentDismissed(timed), false);
  dismissPendingPayment(timed.key);
  assert.equal(pendingPaymentDismissed(timed), true);
  assert.equal(pendingPaymentDismissed({ ...timed, key: draft.quoteId }), false);
  assert.equal(pendingPaymentDismissed(null), false);
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
