import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  FulfillmentController,
  failureCode,
} from '../../services/edge/dist/fulfillment-controller.js';

const secret = 'postgresql://user:secret@127.0.0.1/db';
const coded = (code, message = secret) => Object.assign(new Error(message), { code });

test('the operator log gets a code of the failure, never its text', () => {
  assert.equal(failureCode(coded('57P01')), '57P01');
  assert.equal(failureCode(coded('ECONNREFUSED')), 'ECONNREFUSED');
  assert.equal(failureCode(new TypeError(secret)), 'TypeError');
  for (const error of [coded(secret), Object.assign(new Error(secret), { name: secret })])
    assert.ok(!failureCode(error).includes('secret'));
  for (const error of [null, undefined, 'text', { name: secret }])
    assert.equal(failureCode(error), 'UNKNOWN');
});

test('a paired display whose check fails gets 503 and one log line with the error code', async (t) => {
  const previous = process.env.EDGE_DEVICE_ACCESS_ENABLED;
  process.env.EDGE_DEVICE_ACCESS_ENABLED = 'true';
  t.after(() => {
    if (previous === undefined) delete process.env.EDGE_DEVICE_ACCESS_ENABLED;
    else process.env.EDGE_DEVICE_ACCESS_ENABLED = previous;
  });
  const lines = [];
  t.mock.method(console, 'error', (line) => lines.push(JSON.parse(line)));
  const key = 'k'.repeat(43);
  const controller = new FulfillmentController({
    config: { branchId: randomUUID(), edgeFulfillmentEnabled: true },
    pool: {
      connect: async () => {
        throw coded('ECONNREFUSED', `connect failed ${key}`);
      },
    },
  });
  await assert.rejects(
    controller.display({ 'x-terminal-id': randomUUID(), 'x-terminal-key': key }, {}),
    (error) => error.getStatus() === 503 && error.getResponse().code === 'SERVICE_UNAVAILABLE',
  );
  assert.deepEqual(lines, [{ event: 'fulfillment_display_failed', code: 'ECONNREFUSED' }]);
  assert.ok(!JSON.stringify(lines).includes(key));
});
