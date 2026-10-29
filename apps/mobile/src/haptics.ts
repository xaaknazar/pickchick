import * as Haptics from 'expo-haptics';
import { Platform } from 'react-native';

/**
 * Taptic feedback of the payment handle (owner 29.10.2026: «нет вибрации, когда тянешь для
 * оплаты»):
 * - `grab`  - the finger starts stretching the pill (light tap);
 * - `armed` - the pill passed the point where letting go starts the payment (firmer tap);
 * - `pay`   - released at the end, the payment starts (iOS «success» pattern).
 * iOS skips them by itself when the customer turned System Haptics off. A native build without the
 * module (an older dev client) only loses the feedback: expo-haptics loads it optionally and the
 * rejected promise is ignored. On the web nothing vibrates; browser tests read the cues from
 * `globalThis.__pickchickHaptics` when they create that array before the app starts.
 */
export type HapticCue = 'grab' | 'armed' | 'pay';

export function haptic(cue: HapticCue): void {
  if (Platform.OS === 'web') {
    const log = (globalThis as { __pickchickHaptics?: unknown }).__pickchickHaptics;
    if (Array.isArray(log)) log.push(cue);
    return;
  }
  const feedback =
    cue === 'pay'
      ? Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
      : Haptics.impactAsync(
          cue === 'armed' ? Haptics.ImpactFeedbackStyle.Medium : Haptics.ImpactFeedbackStyle.Light,
        );
  feedback.catch(() => undefined);
}
