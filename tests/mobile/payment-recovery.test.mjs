import assert from 'node:assert/strict';
import test from 'node:test';
import { pendingPaymentKey, parsePendingPayment } from '../../apps/mobile/src/payment-recovery.ts';

const draft = {
  key: '40000000-0000-4000-8000-000000000004',
  quoteId: '40000000-0000-4000-8000-000000000005',
  signature: '{"items":[]}',
  sendInvoice: true,
};
test('legacy saved payment retains the exact command and explicit invoice consent', () => {
  assert.deepEqual(parsePendingPayment(JSON.stringify(draft)), draft);
  const withoutConsent = { ...draft };
  delete withoutConsent.sendInvoice;
  assert.equal(parsePendingPayment(JSON.stringify(withoutConsent)).sendInvoice, undefined);
});
test('recovery belongs to the same customer and uses the accepted order when available', () => {
  assert.notEqual(pendingPaymentKey('customer-a'), pendingPaymentKey('customer-b'));
  const accepted = { ...draft, orderId: '40000000-0000-4000-8000-000000000006' };
  assert.deepEqual(parsePendingPayment(JSON.stringify(accepted)), accepted);
  assert.equal(parsePendingPayment(null), null);
});
test('drafts of earlier builds and closed drafts of this build both parse (owner 28.10.2026)', () => {
  // Written before «closed» was stored: no closedAt, read as open.
  const old = {
    ...draft,
    createdAt: 1793180000000,
    orderId: '40000000-0000-4000-8000-000000000006',
  };
  assert.equal(parsePendingPayment(JSON.stringify(old)).closedAt, undefined);
  const closed = { ...old, sendInvoice: false, closedAt: 1793180060000 };
  assert.deepEqual(parsePendingPayment(JSON.stringify(closed)), closed);
  for (const closedAt of ['1793180060000', 0, -5, 1.5, null, true])
    assert.throws(
      () => parsePendingPayment(JSON.stringify({ ...old, closedAt })),
      String(closedAt),
    );
});
test('corrupt storage cannot become a fresh order or inject an order URL', () => {
  for (const value of [
    null,
    [],
    {},
    { ...draft, key: '------' },
    { ...draft, orderId: '../../other' },
    { ...draft, sendInvoice: 'true' },
    { ...draft, signature: {} },
  ])
    assert.throws(() => parsePendingPayment(JSON.stringify(value)));
  assert.throws(() => parsePendingPayment('{'));
});
