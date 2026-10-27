import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { Platform } from 'react-native';
import { useAccount } from './useAccount';
import {
  createPaymentMethodStore,
  paymentMethods,
  type LastPaymentSource,
  type PaymentMethodId,
} from './payment-method';

/** One store per app process, persisted per account in AsyncStorage (see payment-method.ts). */
export const paymentMethodStore = createPaymentMethodStore({
  storage: AsyncStorage,
  now: Date.now,
});
const methods = paymentMethods(Platform.OS);

/** Remembers the method of a payment that was just sent (or chosen) for this account. */
export function rememberPaymentMethod(
  customerId: string | null | undefined,
  method: PaymentMethodId,
  source: LastPaymentSource,
) {
  paymentMethodStore.record(customerId, method, source, methods);
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
  useEffect(() => {
    void paymentMethodStore.load(customerId);
  }, [customerId]);
  const choose = useCallback(
    (method: PaymentMethodId) => rememberPaymentMethod(customerId, method, 'choice'),
    [customerId],
  );
  return {
    method: paymentMethodStore.active(customerId, methods),
    methods,
    ready: paymentMethodStore.ready(customerId),
    choose,
  };
}
