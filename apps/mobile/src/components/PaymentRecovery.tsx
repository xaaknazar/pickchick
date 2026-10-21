import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { usePathname, useRootNavigationState, useRouter, useGlobalSearchParams } from 'expo-router';
import { useAccount } from '../useAccount';
import { kaspiCheckoutEnabled } from '../commerce-checkout';
import {
  pendingPaymentDismissed,
  pendingPaymentKey,
  parsePendingPayment,
} from '../payment-recovery';

/** Return to the original checkout after an OS/browser restart or a legacy sheet dismissal. */
export function PaymentRecovery() {
  const { account, ready } = useAccount();
  const customerId = account?.customerId;
  const router = useRouter();
  const path = usePathname();
  const params = useGlobalSearchParams();
  const navigationReady = Boolean(useRootNavigationState()?.key);
  const [foreground, setForeground] = useState(AppState.currentState !== 'background');
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => setForeground(state === 'active'));
    return () => sub.remove();
  }, []);
  useEffect(() => {
    if (
      !kaspiCheckoutEnabled ||
      !ready ||
      !navigationReady ||
      !foreground ||
      !customerId ||
      params.preview === '1' ||
      path === '/checkout' ||
      path === '/auth'
    )
      return;
    let active = true;
    void AsyncStorage.getItem(pendingPaymentKey(customerId))
      .then((raw) => {
        // An intent the customer closed stays closed until the next app start (audit 2.0).
        const draft = parsePendingPayment(raw);
        if (active && draft && !pendingPaymentDismissed(draft)) router.push('/checkout');
      })
      .catch(() => {
        // Never discard an unreadable payment intent or create an order from this observer.
        // The normal checkout remains available to recover it explicitly.
      });
    return () => {
      active = false;
    };
  }, [customerId, ready, navigationReady, foreground, path, params.preview, router]);
  return null;
}
