/**
 * Light vibration on farm actions, used only when the native haptics module is present.
 *
 * The app binary does not include `expo-haptics` yet: `apps/mobile/ios` is reserved by another
 * task, and a native module needs a new build. Until then every call is a silent no-op. Once
 * `expo-haptics` is added to the next native build, Expo registers `ExpoHaptics` on
 * `globalThis.expo.modules` and these calls start working without further changes here.
 */
type HapticsModule = {
  impactAsync?(style: 'light' | 'medium' | 'heavy'): Promise<void>;
  notificationAsync?(type: 'success' | 'warning' | 'error'): Promise<void>;
  selectionAsync?(): Promise<void>;
};
export type FeedbackTier = 'small' | 'medium' | 'large';

function native(): HapticsModule | null {
  const expo = (globalThis as { expo?: { modules?: Record<string, unknown> } }).expo;
  const module = expo?.modules?.ExpoHaptics;
  return module && typeof module === 'object' ? (module as HapticsModule) : null;
}

/** Small - a tap or harvest, medium - an order or a pen, large - a level or new land. */
export function haptic(tier: FeedbackTier) {
  const h = native();
  if (!h) return;
  try {
    const call =
      tier === 'large'
        ? h.notificationAsync?.('success')
        : h.impactAsync?.(tier === 'medium' ? 'medium' : 'light');
    void call?.catch(() => undefined);
  } catch {
    // Haptics are optional feedback.
  }
}
