import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import type { CartLine, DiningMode } from './model';
import { useAccount } from './useAccount';
import { orderPollDelay } from './poll-cadence';
import {
  KASPI_ACTIVE_STAGES,
  kaspiCart,
  kaspiErrorMessage,
  type KaspiCheckoutView,
} from './kaspi-checkout';
import { createKaspiCheckout, kaspiCheckoutBuildEnabled } from './kaspi-checkout-client';

export interface KaspiCheckoutModel {
  /** Build flag, signed-in account and the server all allow Kaspi checkout. */
  available: boolean;
  phoneMasked: string | null;
  view: KaspiCheckoutView | null;
  busy: boolean;
  error: string | null;
  checkout(): Promise<void>;
  retry(): Promise<void>;
  refresh(): Promise<void>;
  dismiss(): Promise<void>;
}

/**
 * Drives one Kaspi-paid order: create, request the invoice when the restaurant has
 * accepted, then poll until the server reports a final state. Polling pauses in the
 * background and resumes on return (returning from Kaspi is not a payment signal).
 */
export function useKaspiCheckout(cart: CartLine[], mode: DiningMode): KaspiCheckoutModel {
  const account = useAccount();
  const customerId = account.mode === 'server' ? (account.account?.customerId ?? null) : null;
  const authorize = account.withOrderAccess;
  const core = useMemo(
    () =>
      kaspiCheckoutBuildEnabled && customerId && authorize
        ? createKaspiCheckout(customerId, authorize)
        : null,
    [customerId, authorize],
  );
  const [enabled, setEnabled] = useState(false);
  const [phoneMasked, setPhoneMasked] = useState<string | null>(null);
  const [view, setView] = useState<KaspiCheckoutView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const failures = useRef(0);

  useEffect(() => {
    let active = true;
    setEnabled(false);
    setView(null);
    if (!core) return;
    void (async () => {
      try {
        const status = await core.status();
        if (!active) return;
        setEnabled(status.enabled);
        setPhoneMasked(status.phoneMasked);
        if (!status.enabled) return;
        // Resume an order started before the app was closed.
        const orderId = await core.currentOrderId();
        if (orderId && active) setView(await core.read(orderId));
      } catch {
        // Unavailable checkout keeps the existing order flow untouched.
      }
    })();
    return () => {
      active = false;
    };
  }, [core]);

  const run = useCallback(async (task: () => Promise<KaspiCheckoutView>) => {
    setBusy(true);
    setError(null);
    try {
      const next = await task();
      failures.current = 0;
      setView(next);
    } catch (cause) {
      failures.current++;
      setError(kaspiErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }, []);

  const checkout = useCallback(async () => {
    if (!core) return;
    await run(() => core.checkout(kaspiCart(cart, mode)));
  }, [core, run, cart, mode]);

  const refresh = useCallback(async () => {
    if (!core || !view) return;
    try {
      let next = await core.read(view.order_id);
      // The customer already asked to pay; request the invoice once accepted.
      if (next.stage === 'ready_to_pay') next = await core.pay(next.order_id);
      failures.current = 0;
      setView(next);
      setError(null);
    } catch (cause) {
      failures.current++;
      setError(kaspiErrorMessage(cause));
    }
  }, [core, view]);

  const retry = useCallback(async () => {
    if (!core || !view?.can_retry) return;
    await run(() => core.pay(view.order_id, true));
  }, [core, view, run]);

  const dismiss = useCallback(async () => {
    if (core && view) await core.finish(view);
    setView(null);
  }, [core, view]);

  const polling = view !== null && KASPI_ACTIVE_STAGES.includes(view.stage);
  useEffect(() => {
    if (!polling) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let foreground = AppState.currentState === 'active';
    const schedule = () => {
      if (timer) clearTimeout(timer);
      const delay = orderPollDelay({
        active: foreground,
        failures: failures.current,
        expired: false,
      });
      if (delay !== null) timer = setTimeout(() => void refresh(), delay);
    };
    schedule();
    const subscription = AppState.addEventListener('change', (state) => {
      foreground = state === 'active';
      if (foreground) void refresh();
      else schedule();
    });
    return () => {
      if (timer) clearTimeout(timer);
      subscription.remove();
    };
  }, [polling, refresh]);

  return {
    available: core !== null && enabled,
    phoneMasked,
    view,
    busy,
    error,
    checkout,
    retry,
    refresh,
    dismiss,
  };
}
