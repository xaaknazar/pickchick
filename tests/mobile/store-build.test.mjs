import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STORE_BUILD,
  STORE_HIDDEN_SCREENS,
  UPCOMING_PAYMENTS,
  comboCardShown,
  pushSettingsShown,
  receiptShown,
  storeHidesScreen,
  upcomingFeaturesShown,
} from '../../apps/mobile/src/store-build.ts';
import { paymentMethods, activePaymentMethod } from '../../apps/mobile/src/payment-method.ts';

// Owner 29.10.2026 («устрани это все»): what the App Store build (the Kaspi customer build)
// shows. Node runs without EXPO_PUBLIC_* values: both switches read as off.
const commercial = {
  enabled: true,
  programId: '40000000-0000-4000-8000-000000000010',
  giftProductId: 'pick-combo',
  earnedUnits: 2,
  completedCycles: 0,
  currentStamps: 2,
  availableGifts: 0,
  usedGifts: 0,
  reservedGifts: 0,
  reconciliationRequired: false,
  visibleStamps: 2,
  remainingToNextGift: 4,
};

test('the switches are explicit build values and default to off', () => {
  assert.equal(STORE_BUILD, process.env.EXPO_PUBLIC_KASPI_CHECKOUT === '1');
  assert.equal(UPCOMING_PAYMENTS, process.env.EXPO_PUBLIC_UPCOMING_PAYMENTS === '1');
});

test('App Store build: preview-only screens open the menu; previews and test builds keep them', () => {
  assert.deepEqual([...STORE_HIDDEN_SCREENS], ['M22', 'M23', 'M24', 'M25', 'M35']);
  for (const id of STORE_HIDDEN_SCREENS) {
    assert.equal(storeHidesScreen(id, true), true, id);
    assert.equal(storeHidesScreen(id, true, true), false, `${id} in the design preview`);
    assert.equal(storeHidesScreen(id, false), false, `${id} outside the App Store build`);
  }
  // Real screens of the App Store build stay reachable.
  for (const id of ['M05', 'M06', 'M09', 'M12', 'M19', 'M20', 'M21', 'M26', 'M30', 'M31', 'M33'])
    assert.equal(storeHidesScreen(id, true), false, id);
});

test('App Store build: the Chiki programme, missions and «скоро» sections have no entry point', () => {
  assert.equal(upcomingFeaturesShown(true), false);
  assert.equal(upcomingFeaturesShown(true, true), true, 'design preview');
  assert.equal(upcomingFeaturesShown(false), true, 'simulator and test builds');
});

test('the 6 + 1 card follows the server programme in the App Store build', () => {
  const states = {
    signed_out: { status: 'signed_out', data: null },
    loading: { status: 'loading', data: null },
    // `/combo-rewards` answers enabled:false: switched off on the server (29.10.2026).
    unavailable: { status: 'unavailable', data: null },
    error: { status: 'error', data: null },
  };
  for (const [name, state] of Object.entries(states)) {
    assert.equal(comboCardShown(state, true), false, name);
    assert.equal(comboCardShown(state, false), true, `${name} outside the App Store build`);
    assert.equal(comboCardShown(state, true, true), true, `${name} in the design preview`);
  }
  assert.equal(comboCardShown(undefined, true), false);
  // The programme runs: the card with the customer's own stamps.
  assert.equal(comboCardShown({ status: 'ready', data: null, commercial }, true), true);
  // A practice counter (test builds only) never shows in the App Store build.
  assert.equal(
    comboCardShown({ status: 'ready', data: { mode: 'practice', earned_units: 3 } }, true),
    false,
  );
});

test('push settings only once the server push service is connected (App Store build)', () => {
  assert.equal(pushSettingsShown(false, true), false);
  assert.equal(pushSettingsShown(true, true), true);
  assert.equal(pushSettingsShown(false, false), true, 'other builds keep the section');
});

test('a deferred receipt (every app order today) has no receipt block', () => {
  assert.equal(receiptShown('deferred'), false);
  assert.equal(receiptShown('pending'), true);
  assert.equal(receiptShown('issued'), true);
});

test('App Store build pays with Kaspi.kz only; a saved wallet falls back to Kaspi', () => {
  for (const platform of ['ios', 'android', 'web']) {
    const methods = paymentMethods(platform);
    assert.deepEqual(
      methods.map((method) => method.id),
      ['kaspi'],
    );
    for (const saved of ['apple_pay', 'google_pay', 'card'])
      assert.equal(
        activePaymentMethod({ method: saved, source: 'payment', at: 1 }, methods),
        'kaspi',
      );
  }
});
