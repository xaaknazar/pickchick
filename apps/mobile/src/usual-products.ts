import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useState } from 'react';

/**
 * «Как обычно» (Drinkit's «тебе как всегда?», owner's iPhone 22.11.2026): the dishes this guest
 * orders most, from their own handed-over Kaspi orders. Saved per customer on this device when the
 * Orders tab reads the history; the menu shows nothing until that has happened once.
 */
const KEY = 'pickchick.usual-products.v1';
const LIMIT = 6;
type Saved = { customerId: string; ids: string[] };
let memory: Saved | null = null;
const listeners = new Set<() => void>();

export function usualProductIds(
  orders: readonly { phase: string; createdAt: string; items: readonly { productId: string; quantity: number }[] }[],
): string[] {
  const score = new Map<string, { count: number; last: string }>();
  for (const order of orders) {
    if (order.phase !== 'handed_over') continue;
    for (const item of order.items) {
      const prior = score.get(item.productId);
      score.set(item.productId, {
        count: (prior?.count ?? 0) + item.quantity,
        last: !prior || order.createdAt > prior.last ? order.createdAt : prior.last,
      });
    }
  }
  return [...score.entries()]
    .sort((a, b) => b[1].count - a[1].count || b[1].last.localeCompare(a[1].last))
    .slice(0, LIMIT)
    .map(([id]) => id);
}

export function rememberUsualProducts(
  customerId: string | null | undefined,
  orders: Parameters<typeof usualProductIds>[0],
) {
  if (!customerId) return;
  const ids = usualProductIds(orders);
  if (memory?.customerId === customerId && memory.ids.join() === ids.join()) return;
  memory = { customerId, ids };
  for (const listener of listeners) listener();
  AsyncStorage.setItem(KEY, JSON.stringify(memory)).catch(() => undefined);
}

export function useUsualProductIds(customerId: string | null | undefined): string[] {
  const [, bump] = useState(0);
  useEffect(() => {
    const listener = () => bump((n) => n + 1);
    listeners.add(listener);
    if (!memory)
      AsyncStorage.getItem(KEY)
        .then((raw) => {
          if (memory || !raw) return;
          const value = JSON.parse(raw) as Saved;
          if (typeof value?.customerId === 'string' && Array.isArray(value.ids)) {
            memory = { customerId: value.customerId, ids: value.ids.filter((id) => typeof id === 'string') };
            listener();
          }
        })
        .catch(() => undefined);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return customerId && memory?.customerId === customerId ? memory.ids : [];
}
