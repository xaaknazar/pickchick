import { useSyncExternalStore } from 'react';
import { AccessibilityInfo, AppState } from 'react-native';
let reduced = true;
let active = AppState.currentState === 'active';
let generation = 0;
const listeners = new Set<() => void>();
let detach: (() => void) | undefined;
const snapshot = () => reduced || !active;
const notify = () => listeners.forEach((listener) => listener());
/** One native subscription/query for the whole screen, not one per animated card. */
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!detach) {
    active = AppState.currentState === 'active';
    const request = ++generation;
    void AccessibilityInfo.isReduceMotionEnabled()
      .then((value) => {
        if (generation !== request) return;
        reduced = value;
        notify();
      })
      .catch(() => {});
    const motion = AccessibilityInfo.addEventListener('reduceMotionChanged', (value) => {
      generation += 1;
      reduced = value;
      notify();
    });
    const state = AppState.addEventListener('change', (value) => {
      active = value === 'active';
      notify();
    });
    detach = () => {
      generation += 1;
      motion.remove();
      state.remove();
    };
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      detach?.();
      detach = undefined;
    }
  };
}
/** Start static; honour live preference changes and stop when backgrounded. */
export function useMotionPreference() {
  return useSyncExternalStore(subscribe, snapshot, () => true);
}
