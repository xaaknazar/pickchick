import { useSyncExternalStore } from 'react';
import { AccessibilityInfo, Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo';
import { isGlassEffectAPIAvailable, isLiquidGlassAvailable } from 'expo-glass-effect';
import { glassSurface, type GlassEnvironment, type GlassSurface } from '../glass';

/**
 * Liquid Glass needs the expo-glass-effect module in this binary (builds from 24 on; a dev client
 * built earlier lacks it), the iOS 26 SDK (`isLiquidGlassAvailable`) and the runtime API (missing
 * on some iOS 26 betas, `isGlassEffectAPIAvailable`). Anything else keeps the fallback glass.
 */
function liquidGlassInBinary(): boolean {
  if (Platform.OS !== 'ios') return false;
  if (requireOptionalNativeModule('ExpoGlassEffect') == null) return false;
  try {
    return isLiquidGlassAvailable() && isGlassEffectAPIAvailable();
  } catch {
    return false;
  }
}

/** What this binary on this OS can draw; checked once per process. */
export const glassEnvironment: Omit<GlassEnvironment, 'reducedTransparency'> = {
  platform: Platform.OS,
  osVersion: Platform.Version,
  liquidGlass: liquidGlassInBinary(),
  // A binary built before expo-blur keeps the tinted fallback.
  nativeBlur: Platform.OS === 'ios' && requireOptionalNativeModule('ExpoBlur') != null,
};

// One listener for the whole app (dozens of -/+ buttons in a long cart share it).
let reducedTransparency = false;
const listeners = new Set<() => void>();
let stopListening: (() => void) | null = null;

function publish(value: boolean) {
  if (value === reducedTransparency) return;
  reducedTransparency = value;
  listeners.forEach((listener) => listener());
}

function startListening(): () => void {
  if (Platform.OS === 'web') {
    const query =
      typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-reduced-transparency: reduce)')
        : null;
    if (!query) return () => {};
    const update = () => publish(query.matches);
    update();
    query.addEventListener?.('change', update);
    return () => query.removeEventListener?.('change', update);
  }
  let active = true;
  AccessibilityInfo.isReduceTransparencyEnabled()
    .then((value) => {
      if (active) publish(value);
    })
    .catch(() => {});
  const subscription = AccessibilityInfo.addEventListener(
    'reduceTransparencyChanged',
    (value: boolean) => publish(value),
  );
  return () => {
    active = false;
    subscription.remove();
  };
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  stopListening ??= startListening();
  return () => {
    listeners.delete(listener);
    if (!listeners.size && stopListening) {
      stopListening();
      stopListening = null;
    }
  };
}

/** iOS «Reduce Transparency» / the web media query; shared by every glass control. */
export function useReducedTransparency(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => reducedTransparency,
    () => false,
  );
}

/** The glass this control draws now: Liquid Glass, blur, tint or solid (see glass.ts). */
export function useGlassSurface(): GlassSurface {
  const reduced = useReducedTransparency();
  return glassSurface({ ...glassEnvironment, reducedTransparency: reduced });
}
