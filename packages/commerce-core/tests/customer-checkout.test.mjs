import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { customerCheckoutConfig, customerCheckoutStage, maskCustomerPhone } from '../dist/index.js';

const order = (over = {}) => ({
  state: 'awaiting_payment',
  attentionRequired: false,
  totalMinor: '22000',
  kitchenEffectId: null,
  money: { captured: '0' },
  attempts: [{ id: randomUUID(), state: 'pending' }],
  ...over,
});
const invoice = (state, remote_status = null, recent = true) => ({
  state,
  remote_status,
  expires_at: null,
  recent,
});

test('customer stages come only from ledger facts', () => {
  const stage = (o, i = null) => customerCheckoutStage(order(o), i);
  assert.equal(stage({ state: 'awaiting_admission', attempts: [] }).stage, 'accepting');
  assert.equal(stage({ attempts: [] }).stage, 'ready_to_pay');
  assert.equal(stage({}).stage, 'sending_invoice');
  assert.equal(stage({}, invoice('issuing')).stage, 'sending_invoice');
  assert.equal(stage({}, invoice('issued')).stage, 'invoice_sent');
  // A bank "paid" invoice is not payment until the capture is recorded.
  assert.equal(stage({}, invoice('paid')).stage, 'checking');
  assert.equal(stage({ attempts: [{ id: 'a', state: 'succeeded' }] }).stage, 'checking');
  assert.equal(stage({ money: { captured: '22000' } }).stage, 'paid');
  assert.equal(stage({ money: { captured: '21900' } }, invoice('issued')).stage, 'invoice_sent');
  assert.equal(stage({ attentionRequired: true }).stage, 'attention');
  assert.equal(
    stage({ attempts: [{ id: 'a', state: 'unknown' }] }, invoice('unknown')).stage,
    'checking',
  );
  assert.equal(
    stage({ attempts: [{ id: 'a', state: 'unknown' }] }, invoice('unknown', null, false)).stage,
    'unconfirmed',
  );
  const closed = (remote) =>
    customerCheckoutStage(
      order({ attempts: [{ id: 'a', state: 'failed' }] }),
      invoice('failed', remote),
    );
  assert.deepEqual(closed('Expired'), { stage: 'invoice_closed', closedReason: 'expired' });
  assert.equal(closed('RemotePaymentCanceled').closedReason, 'cancelled');
  assert.equal(closed('RemotePaymentRejected').closedReason, 'rejected');
  assert.equal(closed(null).closedReason, 'failed');
});

test('phone is masked for the owner only in a fixed shape', () => {
  assert.equal(maskCustomerPhone('+77011234567'), '+7 701 ••• •• 67');
  assert.equal(maskCustomerPhone('77011234567'), null);
  assert.equal(maskCustomerPhone('+7701123456'), null);
});

test('checkout is off by default and strict when enabled', () => {
  assert.equal(customerCheckoutConfig({}), null);
  assert.equal(customerCheckoutConfig({ CUSTOMER_KASPI_CHECKOUT_ENABLED: 'false' }), null);
  assert.throws(() => customerCheckoutConfig({ CUSTOMER_KASPI_CHECKOUT_ENABLED: 'yes' }));
  const env = {
    CUSTOMER_KASPI_CHECKOUT_ENABLED: 'true',
    CUSTOMER_CHECKOUT_ORGANIZATION_ID: randomUUID(),
    CUSTOMER_CHECKOUT_BRANCH_ID: randomUUID(),
    CUSTOMER_CHECKOUT_FISCAL_ACCOUNT_ID: randomUUID(),
    KASPI_REMOTE_ACCOUNT_ID: randomUUID(),
    CUSTOMER_CHECKOUT_TAX_APPROVAL_REFERENCE: 'Approved by accountant',
    CUSTOMER_CHECKOUT_TAX_VERSION: '1',
    CUSTOMER_CHECKOUT_TAX_CODE: 'VAT-0',
  };
  assert.equal(customerCheckoutConfig(env).taxVersion, 1);
  for (const name of Object.keys(env).slice(1))
    assert.throws(() => customerCheckoutConfig({ ...env, [name]: undefined }), new RegExp(name));
  assert.throws(() => customerCheckoutConfig({ ...env, CUSTOMER_CHECKOUT_TAX_VERSION: '0' }));
});
