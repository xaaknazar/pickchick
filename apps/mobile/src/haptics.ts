import * as Haptics from 'expo-haptics';
import { Platform } from 'react-native';

/**
 * Taptic feedback of the payment handle (owner 29.10.2026: «вибрация нужна, когда начал тянуть и
 * назад тоже - процесс, когда тянем, а не в конце»):
 * - `grab`  - the finger starts stretching the pill (light tap);
 * - `tick`  - every twelfth of the track while the finger pulls, forwards and back (the light
 *             «selection» click of iOS pickers);
 * - `armed` - the pill passed the point where letting go starts the payment (firmer tap).
 * Nothing extra at the release. iOS skips them by itself when the customer turned System Haptics
 * off. A native build without the module (an older dev client) only loses the feedback:
 * expo-haptics loads it optionally and the rejected promise is ignored. On the web nothing
 * vibrates; browser tests read the cues from `globalThis.__pickchickHaptics` when they create that
 * array before the app starts.
 */
export type HapticCue = 'grab' | 'tick' | 'armed';

export function haptic(cue: HapticCue): void {
  if (Platform.OS === 'web') {
    const log = (globalThis as { __pickchickHaptics?: unknown }).__pickchickHaptics;
    if (Array.isArray(log)) log.push(cue);
    return;
  }
  const feedback =
    cue === 'tick'
      ? Haptics.selectionAsync()
      : Haptics.impactAsync(
          cue === 'armed' ? Haptics.ImpactFeedbackStyle.Medium : Haptics.ImpactFeedbackStyle.Light,
        );
  feedback.catch(() => undefined);
}
