import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  SLIDE_PAY_INTENT_TTL_MS,
  createSlidePayIntents,
} from '../../apps/mobile/src/slide-pay-intent.ts';

function registry(start = Date.parse('2026-10-27T10:00:00Z')) {
  let now = start;
  let counter = 0;
  const intents = createSlidePayIntents({
    now: () => now,
    nonce: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`,
  });
  return {
    intents,
    advance: (ms) => {
      now += ms;
    },
  };
}

test('a released slide is taken exactly once', () => {
  const { intents, advance } = registry();
  const raw = intents.issue();
  assert.match(raw, /^\d{13}\.[0-9a-f-]{36}$/);
  advance(400);
  assert.equal(intents.take(raw), true);
  // Re-render, remount, back navigation: the same route parameter never runs again.
  assert.equal(intents.take(raw), false);
  assert.equal(intents.take(raw), false);
});

test('a stale intent is rejected and consumed', () => {
  assert.equal(SLIDE_PAY_INTENT_TTL_MS, 30_000);
  const { intents, advance } = registry();
  const raw = intents.issue();
  advance(SLIDE_PAY_INTENT_TTL_MS + 1);
  assert.equal(intents.take(raw), false);
  advance(-SLIDE_PAY_INTENT_TTL_MS);
  assert.equal(intents.take(raw), false, 'a rejected intent cannot become fresh again');
  const edge = intents.issue();
  advance(SLIDE_PAY_INTENT_TTL_MS);
  assert.equal(intents.take(edge), true);
});

test('a clock moved backwards does not extend an intent', () => {
  const { intents, advance } = registry();
  const raw = intents.issue();
  advance(-5_000);
  assert.equal(intents.take(raw), false);
});

test('only intents issued by this app process are accepted', () => {
  const first = registry();
  const raw = first.intents.issue();
  // App restart, reload, restored navigation state or a deep link: a new registry, same text.
  const restarted = registry();
  assert.equal(restarted.intents.take(raw), false);
  assert.equal(first.intents.take(raw), true);
  const forged = `${Date.parse('2026-10-27T10:00:00Z')}.00000000-0000-4000-8000-000000000099`;
  assert.equal(first.intents.take(forged), false);
  for (const value of [undefined, null, '', 'slide', 42, [raw], { raw }, `${raw} `])
    assert.equal(first.intents.take(value), false);
});

test('two slides are independent, each once', () => {
  const { intents, advance } = registry();
  const a = intents.issue();
  advance(1_000);
  const b = intents.issue();
  assert.notEqual(a, b);
  assert.equal(intents.take(b), true);
  assert.equal(intents.take(a), true);
  assert.equal(intents.take(a) || intents.take(b), false);
});

test('checkout takes the intent after the saved intent is read and only calls submit()', () => {
  // Static guard on the wiring: the intent replaces one press of «Оплатить через Kaspi» and never
  // calls pay() (the invoice step) or bypasses the restored intent, order or running command.
  const source = readFileSync(
    new URL('../../apps/mobile/src/screens/KaspiCheckoutScreen.tsx', import.meta.url),
    'utf8',
  );
  const start = source.indexOf('const slideIntent = useSlidePayIntent(');
  const end = source.indexOf('const pay = useCallback(', start);
  assert.ok(start > 0 && end > start);
  const block = source.slice(start, end);
  assert.match(block, /useSlidePayIntent\(props\.screenId === 'M12' && !props\.preview\)/);
  assert.match(block, /if \(!slideIntent \|\| restoring \|\| !customerId\) return;/);
  assert.match(block, /if \(!slidePayIntents\.take\(slideIntent\)\) return;/);
  assert.match(
    block,
    /if \(lock\.current \|\| pending\.current \|\| orderRef\.current \|\| !cart\.current\.length\) return;/,
  );
  assert.match(block, /void submitRef\.current\(\);/);
  assert.doesNotMatch(block, /pay\(|sendInvoice|AsyncStorage/);
  assert.equal(source.match(/slidePayIntents\.take\(/g)?.length, 1);
});
