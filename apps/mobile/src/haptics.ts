import * as Haptics from 'expo-haptics';
import { Platform } from 'react-native';
import { ANDROID_HAPTICS, IMPACT_STYLE, type HapticCue } from './haptic-map';

/**
 * Taptic feedback of the payment handle (owner 29.10.2026: «вибрация нужна, когда начал тянуть и
 * назад тоже - процесс, когда тянем, а не в конце»):
 * - `grab`  - the finger starts stretching the pill (heavy tap);
 * - `tick`  - every sixteenth of the track while the finger pulls, forwards and back (medium impact);
 * - `armed` - the pill passed the point where letting go starts the payment (firmer tap).
 * Nothing extra at the release. iOS skips them by itself when the customer turned System Haptics
 * off; Android plays the system constants of haptic-map.ts, which follow «Touch feedback». A
 * native build without the module (an older dev client) only loses the feedback: expo-haptics
 * loads it optionally and the rejected promise is ignored. On the web nothing
 * vibrates; browser tests read the cues from `globalThis.__pickchickHaptics` when they create that
 * array before the app starts.
 */
export type { HapticCue } from './haptic-map';

async function androidFeedback(cue: HapticCue): Promise<void> {
  for (const type of ANDROID_HAPTICS[cue]) {
    try {
      await Haptics.performAndroidHapticsAsync(type as Haptics.AndroidHaptics);
      return;
    } catch {
      // This constant is newer than the phone's Android version: try the next one.
    }
  }
  await Haptics.impactAsync(IMPACT_STYLE[cue] as Haptics.ImpactFeedbackStyle);
}

export function haptic(cue: HapticCue): void {
  if (Platform.OS === 'web') {
    const log = (globalThis as { __pickchickHaptics?: unknown }).__pickchickHaptics;
    if (Array.isArray(log)) log.push(cue);
    return;
  }
  // Owner 29.10: stronger than the previous pull feedback, without extra release pulses.
  // Android: the system constants of haptic-map.ts (lane android, 05.11.2026).
  const feedback =
    Platform.OS === 'android'
      ? androidFeedback(cue)
      : Haptics.impactAsync(IMPACT_STYLE[cue] as Haptics.ImpactFeedbackStyle);
  feedback.catch(() => undefined);
}
