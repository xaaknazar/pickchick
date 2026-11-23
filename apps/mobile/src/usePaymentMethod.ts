import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { Platform } from 'react-native';
import { useAccount } from './useAccount';
import {
  createPaymentMethodStore,
  launchPaymentMethod,
  paymentMethods,
  type LastPaymentSource,
  type PaymentMethodId,
} from './payment-method';
import { createConnectedMethodsStore } from './tiptoppay-checkout';
import { phoneWallets } from './useTipTopPayCheckout';

/**
 * TipTopPay methods this phone could pay with, before any /config answer. A saved method exists
 * only if it was available when it was recorded, so this list only confirms the phone still can.
 */
let phoneCanCache: PaymentMethodId[] | null = null;
function phoneCan(): PaymentMethodId[] {
  if (phoneCanCache) return phoneCanCache;
  const phone = phoneWallets();
  phoneCanCache = phone.module
    ? [
        'card',
        ...(phone.applePay ? (['apple_pay'] as const) : []),
        ...(Platform.OS === 'android' ? (['google_pay'] as const) : []),
      ]
    : [];
  return phoneCanCache;
}

/** One store per app process, persisted per account in AsyncStorage (see payment-method.ts). */
export const paymentMethodStore = createPaymentMethodStore({
  storage: AsyncStorage,
  now: Date.now,
});
/** TipTopPay methods this cart may offer now (updated by the cart's /config read). */
export const connectedMethodsStore = createConnectedMethodsStore(AsyncStorage);
void connectedMethodsStore.restore();
let cachedMethods = { version: -1, value: paymentMethods(Platform.OS) };
function currentMethods() {
  const version = connectedMethodsStore.version();
  if (cachedMethods.version !== version)
    cachedMethods = {
      version,
      value: paymentMethods(Platform.OS, undefined, connectedMethodsStore.methods()),
    };
  return cachedMethods.value;
}

/** Remembers the method of a payment that was just sent (or chosen) for this account. */
export function rememberPaymentMethod(
  customerId: string | null | undefined,
  method: PaymentMethodId,
  source: LastPaymentSource,
) {
  paymentMethodStore.record(customerId, method, source, currentMethods());
}

/**
 * The signed-in customer's active payment method: the cart bar handle shows it, the slide pays
 * with it and «Способ оплаты» opens preselected with it. `choose` records a choice in the cart.
 */
export function usePaymentMethod() {
  const { account } = useAccount();
  const customerId = account?.customerId;
  useSyncExternalStore(
    paymentMethodStore.subscribe,
    paymentMethodStore.version,
    paymentMethodStore.version,
  );
  useSyncExternalStore(
    connectedMethodsStore.subscribe,
    connectedMethodsStore.version,
    connectedMethodsStore.version,
  );
  const methods = currentMethods();
  useEffect(() => {
    void paymentMethodStore.load(customerId);
  }, [customerId]);
  const choose = useCallback(
    (method: PaymentMethodId) => rememberPaymentMethod(customerId, method, 'choice'),
    [customerId],
  );
  const { ready: accountReady } = useAccount();
  return {
    method: launchPaymentMethod(paymentMethodStore.saved(customerId), methods, {
      fresh: connectedMethodsStore.fresh(),
      phoneCan: phoneCan(),
    }),
    methods,
    ready: paymentMethodStore.ready(customerId),
    /**
     * The account, its saved method and the last known TipTopPay methods are all read: only then
     * is `method` the customer's real method (owner 23.11.2026: no Kaspi flash before Apple Pay).
     */
    settled:
      accountReady && paymentMethodStore.ready(customerId) && connectedMethodsStore.restored(),
    choose,
  };
}
