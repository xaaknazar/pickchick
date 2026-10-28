import { useCallback, useEffect, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { createTapGate, pushSettleMs } from '../tap-guard';

/** One press per push: repeats wait until the push settles or this screen is focused again. */
export function useTapGate(windowMs = pushSettleMs) {
  const [gate] = useState(() => createTapGate(windowMs));
  useFocusEffect(useCallback(() => gate.reset(), [gate]));
  return gate;
}

/**
 * False for the first moments after a screen appears, so the second tap of a double tap meant
 * for the previous screen does not press the control that is now under the finger.
 */
export function useTapsSettled(windowMs = pushSettleMs) {
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(true), windowMs);
    return () => clearTimeout(timer);
  }, [windowMs]);
  return settled;
}
