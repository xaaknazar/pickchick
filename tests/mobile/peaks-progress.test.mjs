import test from 'node:test';
import assert from 'node:assert/strict';
import { ascentProgress } from '../../apps/mobile/src/loyalty/peaks.ts';

test('the first summit opens at 300 earned Chiki, the combo summit at 1000', () => {
  assert.equal(ascentProgress(0).current, null);
  assert.equal(ascentProgress(299).remaining, 1);
  assert.equal(ascentProgress(300).current.id, 'furmanov');
  assert.equal(ascentProgress(300).fraction, 0);
  assert.equal(ascentProgress(999).next.id, 'kumbel');
  assert.equal(ascentProgress(1000).current.id, 'kumbel');
});

test('the displayed path is based on earned progress, not the spendable wallet', () => {
  const result = ascentProgress(540); // The design example has only 180 spendable Chiki.
  assert.equal(result.current.id, 'furmanov');
  assert.equal(result.remaining, 460);
  assert.equal(result.reached, 1);
  assert.equal(result.fraction, 240 / 700);
  assert.equal(ascentProgress(180).current, null);
});

test('the route completes without overflow and corrections can reduce the level', () => {
  assert.equal(ascentProgress(7999).remaining, 1);
  for (const earned of [8000, 9000, Number.MAX_SAFE_INTEGER]) {
    const result = ascentProgress(earned);
    assert.equal(result.current.id, 'talgar');
    assert.equal(result.next, null);
    assert.equal(result.fraction, 1);
    assert.equal(result.remaining, 0);
  }
  assert.equal(ascentProgress(999).current.id, 'furmanov');
});

test('invalid progress is not displayed as a legitimate earned amount', () => {
  for (const value of [-1, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => ascentProgress(value), /Invalid ascent progress/);
  }
});
