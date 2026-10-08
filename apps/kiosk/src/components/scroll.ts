import { createContext, useCallback, useContext } from 'react';
import type { Animated, View } from 'react-native';

/** Named sections inside a ScrollArea that it can scroll to (`focus`). */
export interface ScrollTargets {
  register: (id: string, view: View | null) => void;
}
export const ScrollTargetContext = createContext<ScrollTargets | null>(null);
/** Live vertical offset of the enclosing `parallax` ScrollArea (native driven). */
export const ScrollOffsetContext = createContext<Animated.Value | null>(null);

/** Ref callback that makes a view a `focus` target of the enclosing ScrollArea. */
export function useScrollTarget(id: string) {
  const targets = useContext(ScrollTargetContext);
  return useCallback((view: View | null) => targets?.register(id, view), [id, targets]);
}

/** Offset of the enclosing parallax ScrollArea, or null outside one. */
export function useScrollOffset() {
  return useContext(ScrollOffsetContext);
}
