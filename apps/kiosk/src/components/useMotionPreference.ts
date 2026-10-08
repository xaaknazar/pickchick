import { useEffect, useState } from 'react';
import { AccessibilityInfo, AppState } from 'react-native';
let lastReduced = true;
// Ask once at load so screens mounted after boot already know the setting and
// only the very first frames before the answer arrive render statically.
try {
  void AccessibilityInfo.isReduceMotionEnabled()
    .then((value) => {
      lastReduced = value;
    })
    .catch(() => {});
} catch {
  // Keep the static default when the platform cannot answer.
}
/** Start static; follow changes live and suspend motion while backgrounded. */
export function useMotionPreference() {
  const [reduced, setReduced] = useState(lastReduced);
  const [active, setActive] = useState(AppState.currentState === 'active');
  useEffect(() => {
    let live = true;
    const update = (value: boolean) => {
      lastReduced = value;
      if (live) setReduced(value);
    };
    void AccessibilityInfo.isReduceMotionEnabled()
      .then(update)
      .catch(() => {});
    const motion = AccessibilityInfo.addEventListener('reduceMotionChanged', update);
    const state = AppState.addEventListener('change', (v) => setActive(v === 'active'));
    return () => {
      live = false;
      motion.remove();
      state.remove();
    };
  }, []);
  return reduced || !active;
}
