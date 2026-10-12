import { useSyncExternalStore } from 'react';

/**
 * Read-only mirror of the active-order count of the live Kaspi order list.
 * The list keeps owning its data and watches; this only lets the tab bar show the
 * same number without another request or poll.
 */
let count = 0;
const listeners = new Set<() => void>();

export function publishActiveOrderCount(next: number) {
  const value = Number.isInteger(next) && next > 0 ? next : 0;
  if (value === count) return;
  count = value;
  for (const listener of listeners) listener();
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
