import { useRef, type RefObject } from 'react';
import { useScrollToTop } from 'expo-router';
import type { ScrollView } from 'react-native';
import { useReducedMotion } from './Motion';

/** The navigator handles focused-tab / prevented-press checks; only the scroll is adapted. */
export function useTabScrollToTop(scroll: RefObject<ScrollView | null>, beforeScroll?: () => void) {
  const reduced = useReducedMotion();
  const latest = useRef({ reduced, beforeScroll });
  latest.current = { reduced, beforeScroll };
  const target = useRef({
    scrollToTop() {
      if (!scroll.current) return;
      latest.current.beforeScroll?.();
      scroll.current.scrollTo({ y: 0, animated: !latest.current.reduced });
    },
  });
  useScrollToTop(target);
}
