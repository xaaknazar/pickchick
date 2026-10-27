import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  SLIDE_PAY_INTENT_TTL_MS,
  createSlidePayIntents,
  runSlidePayIntent,
  savedIntentHoldsCheckout,
} from '../../apps/mobile/src/slide-pay-intent.ts';
import { AUTO_SEND_WINDOW_MS } from '../../apps/mobile/src/checkout-resume.ts';

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

const NOW = Date.parse('2026-10-27T10:00:00Z');
const free = {
  restoring: false,
  signedIn: true,
  busy: false,
  saved: null,
  order: false,
  cartLines: 1,
  now: NOW,
};
const draft = (extra) => ({
  key: '00000000-0000-4000-8000-0000000000a1',
  quoteId: '00000000-0000-4000-8000-0000000000a2',
  signature: '{}',
  sendInvoice: true,
  ...extra,
});

function slide(checkout, intents = registry(NOW).intents, raw = intents.issue()) {
  let presses = 0;
  const outcome = runSlidePayIntent(intents, raw, checkout, () => presses++);
  return { outcome, presses, intents, raw };
}

test('a slide on a free checkout is one press, never a second one', () => {
  const first = slide(free);
  assert.deepEqual([first.outcome, first.presses], ['pressed', 1]);
  // Re-render, remount, back/forward with the same route parameter: nothing runs again.
  for (let i = 0; i < 3; i++) {
    let presses = 0;
    assert.equal(
      runSlidePayIntent(first.intents, first.raw, free, () => presses++),
      'dropped',
    );
    assert.equal(presses, 0);
  }
  assert.equal(
    runSlidePayIntent(first.intents, null, free, () => assert.fail('no intent')),
    'wait',
  );
});

test('the intent waits, unconsumed, for the saved intent and the sign-in', () => {
  const { intents } = registry(NOW);
  const raw = intents.issue();
  for (const checkout of [
    { ...free, restoring: true },
    { ...free, signedIn: false },
  ]) {
    assert.equal(
      runSlidePayIntent(intents, raw, checkout, () => assert.fail('pressed too early')),
      'wait',
    );
  }
  let presses = 0;
  assert.equal(
    runSlidePayIntent(intents, raw, free, () => presses++),
    'pressed',
  );
  assert.equal(presses, 1);
});

test('a running command, an order, a holding intent or an empty basket drop the slide for good', () => {
  for (const checkout of [
    { ...free, busy: true },
    { ...free, order: true },
    { ...free, cartLines: 0 },
    // A fresh saved intent (its create command may be in flight) or one that knows its order.
    { ...free, saved: draft({ createdAt: NOW - 1_000 }) },
    { ...free, saved: draft({ orderId: '00000000-0000-4000-8000-0000000000a3' }) },
    {
      ...free,
      saved: draft({ orderId: '00000000-0000-4000-8000-0000000000a3', createdAt: NOW - 3_600_000 }),
    },
  ]) {
    const result = slide(checkout);
    assert.deepEqual([result.outcome, result.presses], ['dropped', 0], JSON.stringify(checkout));
    // Consumed: the same intent never runs later, even when the checkout becomes free.
    assert.equal(
      runSlidePayIntent(result.intents, result.raw, free, () => assert.fail('replayed')),
      'dropped',
    );
  }
});

test('a restaurant that cannot take the payment now drops the slide for good (owner 28.10)', () => {
  // Closed, server switch off, no connection or a stop-listed line (payment-availability.ts).
  const result = slide({ ...free, blocked: true });
  assert.deepEqual([result.outcome, result.presses], ['dropped', 0]);
  // When the restaurant opens a minute later the old slide is not replayed: a new slide is needed.
  assert.equal(
    runSlidePayIntent(result.intents, result.raw, free, () => assert.fail('replayed')),
    'dropped',
  );
  // While the saved intent is still read, a blocked checkout keeps the intent waiting as before.
  const { intents } = registry(NOW);
  const raw = intents.issue();
  assert.equal(
    runSlidePayIntent(intents, raw, { ...free, restoring: true, blocked: true }, () =>
      assert.fail('pressed while restoring'),
    ),
    'wait',
  );
});

test('an old intent that never became an order does not stop the slide (the press drops it)', () => {
  // Same rule as submit(): no orderId and no automatic invoice left = nothing holds the checkout.
  for (const saved of [
    draft({ createdAt: NOW - AUTO_SEND_WINDOW_MS - 1 }),
    draft({ createdAt: undefined }),
    draft({ sendInvoice: false, createdAt: NOW - 1_000 }),
    draft({ createdAt: NOW + 60_000 }),
  ]) {
    assert.equal(savedIntentHoldsCheckout(saved, NOW), false, JSON.stringify(saved));
    const result = slide({ ...free, saved });
    assert.deepEqual([result.outcome, result.presses], ['pressed', 1], JSON.stringify(saved));
  }
  assert.equal(savedIntentHoldsCheckout(null, NOW), false);
  assert.equal(savedIntentHoldsCheckout(draft({ createdAt: NOW - 1_000 }), NOW), true);
});

test('a stale or foreign intent is dropped without a press', () => {
  const { intents, advance } = registry(NOW);
  const raw = intents.issue();
  advance(SLIDE_PAY_INTENT_TTL_MS + 1);
  let presses = 0;
  assert.equal(
    runSlidePayIntent(intents, raw, free, () => presses++),
    'dropped',
  );
  assert.equal(
    runSlidePayIntent(registry(NOW).intents, raw, free, () => presses++),
    'dropped',
  );
  assert.equal(presses, 0);
});

test('cart wiring: the slide only presses submit() of the Kaspi cart, never pay() or storage', () => {
  // Whitespace-insensitive, so reformatting does not break it; the behaviour itself is covered
  // above and end to end by browser_slide_to_pay.py (B, C, D, H).
  const source = readFileSync(
    new URL('../../apps/mobile/src/screens/KaspiCheckoutScreen.tsx', import.meta.url),
    'utf8',
  ).replace(/\s+/g, '');
  const start = source.indexOf('constslideIntent=useSlidePayIntent(');
  const end = source.indexOf('constpay=useCallback(', start);
  assert.ok(start > 0 && end > start);
  const block = source.slice(start, end);
  // The Kaspi cart is the checkout (27.10.2026): only the cart route (M09) takes an intent.
  assert.ok(block.includes("useSlidePayIntent(props.screenId==='M09'&&!props.preview)"), block);
  assert.ok(block.includes('runSlidePayIntent(slidePayIntents,slideIntent,'), block);
  assert.ok(block.includes('()=>voidsubmitRef.current()'), block);
  assert.ok(block.includes('saved:pending.current'), block);
  assert.ok(!/pay\(|sendInvoice|AsyncStorage|\.take\(/.test(block), block);
  assert.equal(source.split('runSlidePayIntent(').length - 1, 1);
  assert.equal(source.split('slidePayIntents.take(').length - 1, 0);
});

test('the cart bar sends the slide to the cart with payment, guests to sign-in back to the cart', () => {
  const source = readFileSync(
    new URL('../../apps/mobile/src/components/CartShortcut.tsx', import.meta.url),
    'utf8',
  ).replace(/\s+/g, '');
  const start = source.indexOf('constopenPayment=(slide:boolean)=>{');
  const end = source.indexOf('};', start);
  assert.ok(start > 0 && end > start);
  const block = source.slice(start, end);
  assert.ok(block.includes("params:{returnTo:'M09'}"), block);
  assert.ok(block.includes("pathname:'/cart'"), block);
  assert.ok(block.includes('slide?{[SLIDE_PAY_PARAM]:slidePayIntents.issue()}:{}'), block);
  assert.ok(!block.includes('/checkout') && !block.includes("'M12'"), block);
});
