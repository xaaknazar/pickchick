// Smoothness (owner 23.11.2026, «чтобы не было на секунды какие-то зависания»): a server re-read
// that brings the same data must not hand React new objects. A new object makes every memoised
// menu card, cart line and screen below the provider render again: on a phone that is a visible
// hitch every long-poll answer (20 s) and every menu re-read (60 s), often in the middle of a
// scroll or an animation. These helpers keep the previous value while the content is the same.

import { useCallback, useLayoutEffect, useRef } from 'react';

/** Same JSON content (plain server data: no functions, no cycles). */
export function sameContent(previous: unknown, next: unknown): boolean {
  if (previous === next) return true;
  if (previous === null || next === null || previous === undefined || next === undefined)
    return false;
  if (typeof previous !== 'object' || typeof next !== 'object') return false;
  try {
    return JSON.stringify(previous) === JSON.stringify(next);
  } catch {
    return false;
  }
}

/** For a state setter: keeps the previous value when the next one has the same content. */
export function keepIfSame<T>(next: T) {
  return <S>(previous: S): S | T => (sameContent(previous, next) ? previous : next);
}

/**
 * Structural sharing for a list of records: each item that did not change keeps its previous
 * object (by `key`), and an unchanged list keeps the previous array itself.
 */
export function shareItems<T>(
  previous: readonly T[] | null | undefined,
  next: T[],
  key: (item: T) => string,
): T[] {
  if (!previous || previous === next) return next;
  const old = new Map<string, T>();
  for (const item of previous) old.set(key(item), item);
  let changed = previous.length !== next.length;
  const shared = next.map((item, index) => {
    const before = old.get(key(item));
    const kept = before !== undefined && sameContent(before, item) ? before : item;
    if (kept !== previous[index]) changed = true;
    return kept;
  });
  return changed ? shared : (previous as T[]);
}

/** A list that keeps the identity of unchanged items between renders (see shareItems). */
export function useSharedItems<T>(next: T[], key: (item: T) => string): T[] {
  const last = useRef<T[] | null>(null);
  const shared = shareItems(last.current, next, key);
  last.current = shared;
  return shared;
}

/**
 * A callback with a stable identity that always runs the latest closure. Memoised children that
 * receive it (menu cards, cart lines) do not render again when their parent does.
 */
export function useStableCallback<A extends unknown[], R>(callback: (...args: A) => R) {
  const latest = useRef(callback);
  useLayoutEffect(() => {
    latest.current = callback;
  });
  return useCallback((...args: A) => latest.current(...args), []);
}
