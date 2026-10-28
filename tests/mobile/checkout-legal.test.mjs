import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCheckoutLegal, needsCheckoutConsent } from '../../apps/mobile/src/checkout-legal.ts';
const legal = {
  version: 'synthetic-v2',
  terms_url: 'https://example.test/terms',
  privacy_url: 'https://example.test/privacy',
  accepted: false,
};
test('checkout requires an explicit server consent state, never guesses for legacy or invalid responses', () => {
  assert.deepEqual(parseCheckoutLegal({ legal }), legal);
  assert.equal(parseCheckoutLegal({ legal: { ...legal, accepted: true } }).accepted, true);
  for (const bad of [
    null,
    {},
    { legal: { ...legal, accepted: 'true' } },
    { legal: { ...legal, terms_url: 'javascript:alert(1)' } },
    { legal: { ...legal, privacy_url: 'https://user:pass@example.test/' } },
    { legal: { ...legal, version: '' } },
  ])
    assert.throws(() => parseCheckoutLegal(bad));
});
test('only order creation and new bank commands require consent; status and recovery reads stay accessible', () => {
  const path = '/orders/00000000-0000-4000-8000-000000000001';
  assert.equal(needsCheckoutConsent('/orders', 'POST'), true);
  assert.equal(needsCheckoutConsent(path + '/payment', 'POST'), true);
  for (const [p, m] of [
    ['/orders', 'GET'],
    [path, 'GET'],
    [path + '/watch?after=abc', 'GET'],
    ['/quotes', 'POST'],
    ['/config', 'GET'],
  ])
    assert.equal(needsCheckoutConsent(p, m), false);
});
