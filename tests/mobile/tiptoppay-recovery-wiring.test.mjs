import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Audit 28.11 P0-2 (mobile side). The decisions, the charge and the settling are tested as real
// functions in tiptoppay-recovery.test.mjs. Only the order of actions that cannot be run without a
// phone is pinned here as source text, and only where it protects money.
const read = (path) =>
  readFileSync(new URL(`../../apps/mobile/src/${path}`, import.meta.url), 'utf8');
const hook = read('useTipTopPayCheckout.tsx');
const screen = read('screens/KaspiCheckoutScreen.tsx');
const between = (source, from, to) => {
  const start = source.indexOf(from);
  assert.ok(start >= 0, `missing: ${from}`);
  const end = source.indexOf(to, start + from.length);
  assert.ok(end > start, `missing: ${to}`);
  return source.slice(start, end);
};

test('a live press reads the saved intent and the orders before any quote or new order', () => {
  const decide = hook.indexOf('startLiveOrder(');
  assert.ok(decide > 0, 'run() must go through startLiveOrder');
  assert.ok(hook.search(/'\/orders',\s*'POST'/) > decide, 'POST /orders only inside the decision');
  assert.equal(hook.slice(0, decide).includes('await newQuote('), false);
});

test('the charge goes through chargeLiveOrder with a signal the screen never aborts', () => {
  const charge = between(hook, 'await chargeLiveOrder(', 'if (charged.kind');
  assert.match(charge, /\/tiptoppay`,\s*'POST',\s*\{ method, cryptogram \},\s*chargeSignal/);
  assert.match(charge, /markSent: saveTipTopPayIntent/);
  assert.match(hook, /const chargeSignal = new AbortController\(\)\.signal/);
});

test('the cart cannot be closed while a TipTopPay payment runs', () => {
  const lock = between(screen, 'useSheetDismissalLock(', 'const autoSends');
  assert.match(lock, /tipTopPayBusy/);
});

test('the saved intent is read once per opening, outside the /config bootstrap', () => {
  const bootstrap = between(screen, 'const run = async () => {', 'const start = () => {');
  assert.equal(bootstrap.includes('resumeTipTopPay'), false);
  assert.match(screen, /resumeTipTopPay\.current\?\.\(controller\.signal\)/);
});
