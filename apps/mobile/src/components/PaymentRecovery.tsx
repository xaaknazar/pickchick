import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { usePathname, useGlobalSearchParams } from 'expo-router';
import { useAccount } from '../useAccount';
import { useMobile } from '../store';
import {
  CustomerCommerceOrderSchema,
  cartSignature,
  commerceRequest,
  kaspiCheckoutEnabled,
  normalizedOrderComment,
} from '../commerce-checkout';
import { paymentReceived } from '../commerce-presentation';
import { publishActiveOrderCount, publishActiveOrderFloor } from '../active-orders';
import { commerceActiveKind } from '../orders-tab';
import { matchesPaidComboCart } from '../loyalty/combo-progress';
import { cartLineKey } from '../domain';
import {
  closePendingPayment,
  dismissPendingPayment,
  pendingPaymentClosed,
  pendingPaymentKey,
  parsePendingPayment,
  type PendingPayment,
} from '../payment-recovery';
import { paymentLaunch, type PaymentResumeKind } from '../payment-resume';

/** The small banner on the menu (owner 28.10.2026): which saved payment it offers. */
export type PaymentResume = { customerId: string; key: string; kind: PaymentResumeKind };

let shown: PaymentResume | null = null;
const listeners = new Set<() => void>();
function publish(next: PaymentResume | null) {
  if (
    shown === next ||
    (shown &&
      next &&
      shown.customerId === next.customerId &&
      shown.key === next.key &&
      shown.kind === next.kind)
  )
    return;
  shown = next;
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
const snapshot = () => shown;
const present = () => shown !== null;
export function usePaymentResume(): PaymentResume | null {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
/** Only whether a banner is offered (the menu's content inset), without its details. */
export function useHasPaymentResume(): boolean {
  return useSyncExternalStore(subscribe, present, present);
}

/**
 * The banner's X: the same «closed» as the X of the payment screen, kept in the intent, so
 * neither this run nor a restart offers it again. Nothing is cancelled at the bank and nothing
 * is sent; the next explicit pay tap still reopens the same order (no second invoice).
 */
export async function hidePaymentResume(resume: PaymentResume) {
  dismissPendingPayment(resume.key);
  publish(null);
  const key = pendingPaymentKey(resume.customerId);
  try {
    const draft = parsePendingPayment(await AsyncStorage.getItem(key));
    if (draft?.key !== resume.key || draft.closedAt !== undefined) return;
    await AsyncStorage.setItem(key, JSON.stringify(closePendingPayment(draft, Date.now())));
  } catch {
    // Closed for this run in memory; an unreadable intent is never rewritten or discarded here.
  }
}

/** A payment screen or sign-in is open: it owns the saved intent meanwhile. */
const OWNED_PATHS = ['/checkout', '/cart', '/auth', '/order-status'];
/** A read of the intent's order is reused this long while the app stays in the foreground. */
const READ_REUSE_MS = 15_000;
type Order = ReturnType<typeof CustomerCommerceOrderSchema.parse>;
/** A closed intent is read once per close (a pay tap may reopen it and the X close it again). */
const tidyKey = (draft: PendingPayment) => `${draft.key}:${draft.closedAt ?? ''}`;

/**
 * A payment saved by an earlier app run (owner 28.10.2026, TestFlight 26). Before, this pushed
 * the payment screen (/checkout) at every start while a saved intent existed, and the X of that
 * screen closed it only in memory: after a restart the customer landed on «Отправляем счёт».
 * Now the app always opens on the menu; this only reads (GET) the intent's order to tidy up and
 * to offer the small banner on the menu (PaymentResumeBanner). It never navigates, never creates
 * an order and never sends an invoice.
 */
export function PaymentRecovery() {
  const auth = useAccount();
  const customerId = auth.account?.customerId;
  const access = auth.withOrderAccess;
  const model = useMobile();
  const modelRef = useRef(model);
  modelRef.current = model;
  const path = usePathname();
  const params = useGlobalSearchParams();
  const [foreground, setForeground] = useState(AppState.currentState !== 'background');
  // Every return to the app reads the order again (it may have been paid in Kaspi.kz meanwhile).
  const [wake, setWake] = useState(0);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      setForeground(state === 'active');
      if (state === 'active') setWake((value) => value + 1);
    });
    return () => sub.remove();
  }, []);
  // The cart of the previous run is back (restored after the first menu answer): a paid order
  // may now take its lines out of the cart, as the payment screen does.
  const cartSettled = useRef(false);
  if (model.catalogMode !== 'server' || model.connection.status === 'online')
    cartSettled.current = true;
  const settled = cartSettled.current;
  const reads = useRef(new Map<string, { at: number; wake: number; order: Order }>());
  const tidied = useRef(new Set<string>());
  const account = useRef(customerId);
  account.current = customerId;
  useEffect(() => {
    if (!kaspiCheckoutEnabled || !auth.ready || !customerId || !access || params.preview === '1') {
      publish(null);
      return;
    }
    if (!foreground) return;
    if (OWNED_PATHS.includes(path)) {
      // The open screen owns the intent; back on the menu the banner is decided afresh, so a
      // payment closed or paid meanwhile never flashes its old banner.
      publish(null);
      return;
    }
    let active = true;
    const controller = new AbortController();
    const key = pendingPaymentKey(customerId);
    const readOrder = async (orderId: string) => {
      const cached = reads.current.get(orderId);
      if (cached && cached.wake === wake && Date.now() - cached.at < READ_REUSE_MS)
        return cached.order;
      const order = CustomerCommerceOrderSchema.parse(
        await access(customerId, (token) =>
          commerceRequest(
            `/v1/customer-checkout/orders/${orderId}`,
            'GET',
            undefined,
            token,
            controller.signal,
          ),
        ),
      );
      reads.current.set(orderId, { at: Date.now(), wake, order });
      return order;
    };
    // Removes the intent only while it is still the one that was read (a pay tap may have saved
    // a newer one meanwhile) and no payment screen has opened since.
    const remove = async (draft: PendingPayment) => {
      const latest = parsePendingPayment(await AsyncStorage.getItem(key));
      if (!active || latest?.key !== draft.key) return false;
      await AsyncStorage.removeItem(key);
      return true;
    };
    // Paid while the app was closed (review 28.10.2026): no banner, the cart lost its paid lines,
    // and the order is in «Заказы». Its orange counter shows at once, not only after the tab has
    // loaded its list, so the emptied cart is never left without a sign. Read only (GET); the
    // exact number of the list, at least this order when the list cannot be read.
    const countActiveOrders = async (paid: Order) => {
      if (commerceActiveKind(paid.phase) !== null) publishActiveOrderFloor(1);
      const result = (await access(customerId, (token) =>
        commerceRequest('/v1/customer-checkout/orders', 'GET', undefined, token),
      )) as { orders: unknown[] };
      const orders = result.orders.map((value) => CustomerCommerceOrderSchema.parse(value));
      if (account.current !== customerId) return;
      publishActiveOrderCount(
        orders.filter((entry) => commerceActiveKind(entry.phase) !== null).length,
      );
    };
    const run = async () => {
      const draft = parsePendingPayment(await AsyncStorage.getItem(key));
      if (!active) return;
      let decision = paymentLaunch(draft, undefined, Date.now());
      let order: Order | undefined;
      // A closed intent is read once per close, only to tidy it up; an open one at every return
      // (also one that a pay tap of this run opened again after it was read closed).
      if (
        draft?.orderId &&
        decision.read &&
        !(pendingPaymentClosed(draft) && tidied.current.has(tidyKey(draft)))
      ) {
        try {
          order = await readOrder(draft.orderId);
        } catch {
          // Offline or refused: keep the intent as it is and show nothing until the next read.
        }
        if (!active) return;
        decision = paymentLaunch(draft, order, Date.now());
        if (order && !decision.remove && pendingPaymentClosed(draft))
          tidied.current.add(tidyKey(draft));
      }
      if (draft && decision.remove) {
        const paid = !!order && paymentReceived(order.phase);
        // A paid order takes its lines out of the restored cart first, exactly as its payment
        // screen does; until the previous cart is back the intent waits.
        if (paid && !settled) {
          publish(null);
          return;
        }
        if (!(await remove(draft))) return;
        if (paid) {
          const current = modelRef.current;
          const gift = current.comboRewards?.selected
            ? current.comboRewards.giftItemIndex
            : undefined;
          const signature = cartSignature(
            current.cart,
            current.diningMode,
            normalizedOrderComment(current.orderComment),
            gift,
          );
          if (matchesPaidComboCart(draft.signature, signature)) {
            current.clearCart(
              current.cart.map((line) => ({ id: cartLineKey(line), quantity: line.quantity })),
            );
            current.setOrderComment('');
            current.comboRewards?.select(false);
          }
          current.comboRewards?.refresh();
          if (order) void countActiveOrders(order).catch(() => undefined);
        }
      }
      if (!active) return;
      publish(
        draft && decision.banner ? { customerId, key: draft.key, kind: decision.banner } : null,
      );
    };
    void run().catch(() => {
      // Never discard an unreadable payment intent or create an order from this observer.
      if (active) publish(null);
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [customerId, auth.ready, access, foreground, wake, path, params.preview, settled]);
  return null;
}
