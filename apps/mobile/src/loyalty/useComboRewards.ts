import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { CustomerComboRewardsSchema } from '@pickchick/contracts';
import { useAccount } from '../useAccount';
import { commerceRequest, kaspiCheckoutEnabled } from '../commerce-checkout';
import type { ComboProgressState } from './combo-progress';
import { keepIfSame } from '../stable-values';

// One object per state without data: the app model above compares it by identity.
const SIGNED_OUT: ComboProgressState = { status: 'signed_out', data: null };
const LOADING: ComboProgressState = { status: 'loading', data: null };

/** One account-bound source shared by profile, events and cart; never stored as a balance. */
export function useComboRewards() {
  const account = useAccount();
  const customerId = account.mode === 'server' ? account.account?.customerId : undefined;
  const access = account.withOrderAccess;
  const [snapshot, setSnapshot] = useState<{
    customerId: string;
    state: ComboProgressState;
  } | null>(null);
  const refreshRef = useRef<() => void>(() => {});
  const refresh = useCallback(() => refreshRef.current(), []);
  useEffect(() => {
    if (!customerId || !access || !kaspiCheckoutEnabled) return;
    let stopped = false;
    let request: AbortController | null = null;
    const load = async () => {
      if (stopped || request || AppState.currentState === 'background') return;
      const controller = new AbortController();
      request = controller;
      try {
        const data = CustomerComboRewardsSchema.parse(
          await access(customerId, (token) =>
            commerceRequest(
              '/v1/customer-checkout/combo-rewards',
              'GET',
              undefined,
              token,
              controller.signal,
            ),
          ),
        );
        if (!stopped && !controller.signal.aborted)
          // Same answer every 15 s: keep the object, the whole app is below this state.
          setSnapshot(
            keepIfSame({
              customerId,
              state: data.enabled
                ? ({ status: 'ready', data: null, commercial: data } as const)
                : ({ status: 'unavailable', data: null } as const),
            }),
          );
      } catch {
        if (!stopped && !controller.signal.aborted)
          setSnapshot(keepIfSame({ customerId, state: { status: 'error', data: null } as const }));
      } finally {
        if (request === controller) request = null;
      }
    };
    refreshRef.current = () => {
      void load();
    };
    void load();
    const timer = setInterval(() => void load(), 15000);
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void load();
      else {
        request?.abort();
        request = null;
      }
    });
    return () => {
      stopped = true;
      request?.abort();
      clearInterval(timer);
      subscription.remove();
      refreshRef.current = () => {};
    };
  }, [customerId, access]);
  const progress: ComboProgressState = !customerId
    ? SIGNED_OUT
    : snapshot && snapshot.customerId === customerId
      ? snapshot.state
      : LOADING;
  return {
    progress,
    refresh,
    customerId,
    enabled: kaspiCheckoutEnabled && account.mode === 'server',
  };
}
