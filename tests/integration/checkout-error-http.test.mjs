import assert from 'node:assert/strict';
import test from 'node:test';
import { createApi } from '@pickchick/api';
import { loadConfig } from '@pickchick/platform';
import { ErrorSchema } from '@pickchick/contracts';
import { CustomerCheckoutController } from '../../services/api/dist/customer-checkout-controller.js';
import { AvailabilityError } from '../../packages/commerce-core/dist/index.js';

// Finding 2.5 (audit 19.10): the kitchen-offline refusal must reach new mobile clients as its own
// code through the real HTTP stack (controller + global exception filter), while installed
// clients whose bundled ErrorSchema does not know the code keep receiving SERVICE_UNAVAILABLE.
const V1 = 'application/json; profile=pickchick.checkout-errors-v1';
const V2 = 'application/json; profile=pickchick.checkout-errors-v2';

async function withRefusal(error, run) {
  const app = await createApi(loadConfig('api'));
  try {
    await app.listen(0, '127.0.0.1');
    const controller = app.get(CustomerCheckoutController);
    // Identity and checkout are replaced in memory only: the request never touches customers.
    controller.identity = { me: async () => ({ customer: { id: 'synthetic' } }) };
    controller.checkout = {
      quote: async () => {
        throw error;
      },
    };
    await run(await app.getUrl());
  } finally {
    await app.close();
  }
}

async function quote(url, accept) {
  const response = await fetch(`${url}/v1/customer-checkout/quotes`, {
    method: 'POST',
    headers: {
      Accept: accept,
      Authorization: `Bearer ${'a'.repeat(64)}`,
      'Content-Type': 'application/json',
    },
    body: '{}',
    signal: AbortSignal.timeout(5000),
  });
  return { status: response.status, body: ErrorSchema.parse(await response.json()) };
}

test('KITCHEN_OFFLINE is part of the shared error contract', () => {
  assert.equal(ErrorSchema.shape.code.safeParse('KITCHEN_OFFLINE').success, true);
});

test('kitchen offline reaches opted-in clients over HTTP; installed clients keep their code', async () => {
  await withRefusal(new AvailabilityError('KITCHEN_OFFLINE'), async (url) => {
    for (const [accept, code] of [
      [`${V1}, ${V2}`, 'KITCHEN_OFFLINE'],
      // TestFlight build 20 sends only v1 and parses errors with its bundled schema.
      [V1, 'SERVICE_UNAVAILABLE'],
      // Kiosk and other plain JSON clients.
      ['application/json', 'SERVICE_UNAVAILABLE'],
    ]) {
      const { status, body } = await quote(url, accept);
      assert.equal(status, 503, accept);
      assert.equal(body.code, code, accept);
      assert.equal(body.message_key, `errors.${code.toLowerCase()}`);
      assert.equal(body.retryable, true);
    }
  });
});

test('the opt-in profile does not change stop-list or freshness refusals', async () => {
  await withRefusal(new AvailabilityError('ITEM_STOPPED'), async (url) => {
    for (const accept of [`${V1}, ${V2}`, V1, 'application/json']) {
      const { status, body } = await quote(url, accept);
      assert.equal(status, 409);
      assert.equal(body.code, 'ITEM_STOPPED');
    }
  });
  await withRefusal(new AvailabilityError('AVAILABILITY_STALE'), async (url) => {
    assert.equal((await quote(url, `${V1}, ${V2}`)).body.code, 'AVAILABILITY_STALE');
    assert.equal((await quote(url, 'application/json')).body.code, 'SERVICE_UNAVAILABLE');
  });
});
