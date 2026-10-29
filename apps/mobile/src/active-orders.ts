import { useSyncExternalStore } from 'react';

/**
 * Read-only mirror of the active-order count of the live Kaspi order list.
 * The list keeps owning its data and watches; this only lets the tab bar show the
 * same number without another request or poll. The one exception is the start that finds a
 * payment made while the app was closed (PaymentRecovery): it reads the list once.
 */
let count = 0;
const listeners = new Set<() => void>();

export function publishActiveOrderCount(next: number) {
  const value = Number.isInteger(next) && next > 0 ? next : 0;
  if (value === count) return;
  count = value;
  for (const listener of listeners) listener();
}

/**
 * At least `floor`: an order the app has just seen paid (PaymentRecovery at start, review
 * 28.10.2026) shows on the «Заказы» counter before the list itself has been read.
 */
export function publishActiveOrderFloor(floor: number) {
  if (count < floor) publishActiveOrderCount(floor);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
const snapshot = () => count;

export function usePublishedActiveOrderCount(): number {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
