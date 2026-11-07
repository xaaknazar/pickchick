import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  createReviewAccess,
  reviewAccessConfigured,
  reviewCodeValid,
} from '../../apps/kiosk/src/review-access.ts';
const code = 'Synthetic-Review-Only';
const hash = async (value) => createHash('sha256').update(value).digest('hex');
const digest = await hash(code);
test('missing verifier and malformed codes cannot open review', async () => {
  for (const value of ['', 'a'.repeat(63), 'g'.repeat(64)]) {
    assert.equal(reviewAccessConfigured(value), false);
    assert.equal(await createReviewAccess(value, hash)(code), false);
  }
  for (const value of ['', '1234', 'x'.repeat(65), 'white space code', ' leading-code'])
    assert.equal(reviewCodeValid(value), false);
});
test('review gate rejects wrong code, throttles and then accepts exact code', async () => {
  let now = 0;
  const verify = createReviewAccess(digest, hash, () => now);
  assert.equal(await verify('Wrong-Code-Only'), false);
  assert.equal(await verify(code), false);
  now = 2000;
  assert.equal(await verify(code), true);
});
test('concurrent checks and hash failures fail closed', async () => {
  let resolve;
  const verify = createReviewAccess(
    digest,
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const pending = verify(code);
  assert.equal(await verify(code), false);
  resolve(digest);
  assert.equal(await pending, true);
  assert.equal(
    await createReviewAccess(digest, async () => {
      throw new Error('unavailable');
    })(code),
    false,
  );
});
