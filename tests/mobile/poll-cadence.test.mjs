import test from 'node:test';
import assert from 'node:assert/strict';
import { orderPollDelay } from '../../apps/mobile/src/poll-cadence.ts';

test('active kitchen orders refresh quickly; completed history does not poll every three seconds', () => {
  assert.equal(
    orderPollDelay({ active: true, failures: 0, expired: false }, () => 0),
    3000,
  );
  assert.equal(
    orderPollDelay({ active: false, failures: 0, expired: false }, () => 0),
    60000,
  );
  assert.equal(orderPollDelay({ active: true, failures: 0, expired: true }), null);
});
test('failed polls back off with bounded jitter and success restores active cadence', () => {
  const delays = [1, 2, 3, 4, 5, 99].map((failures) =>
    orderPollDelay({ active: true, failures, expired: false }, () => 1),
  );
  assert.deepEqual(delays, [3600, 7200, 14400, 28800, 57600, 72000]);
  assert.equal(
    orderPollDelay({ active: true, failures: 0, expired: false }, () => 1),
    3600,
  );
});
