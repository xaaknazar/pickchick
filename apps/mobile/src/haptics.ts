import * as Haptics from 'expo-haptics';
import { Platform } from 'react-native';
import { ANDROID_FEEDBACK, IMPACT_STYLE, type HapticCue } from './haptic-map';

/**
 * Taptic feedback of the payment handle (owner 29.10.2026: «вибрация нужна, когда начал тянуть и
 * назад тоже - процесс, когда тянем, а не в конце»):
 * - `grab`  - the finger starts stretching the pill (heavy tap);
 * - `tick`  - every sixteenth of the track while the finger pulls, forwards and back (medium impact);
 * - `armed` - the pill passed the point where letting go starts the payment (firmer tap).
 * Nothing extra at the release. iOS skips them by itself when the customer turned System Haptics
 * off; Android plays the heavy impact for grab and armed and the system slider constant of
 * haptic-map.ts (which follows «Touch feedback») for ticks. A native build without the module
 * (an older dev client) only loses the feedback: expo-haptics
 * loads it optionally and the rejected promise is ignored. On the web nothing
 * vibrates; browser tests read the cues from `globalThis.__pickchickHaptics` when they create that
 * array before the app starts.
 */
export type { HapticCue } from './haptic-map';

async function androidFeedback(cue: HapticCue): Promise<void> {
  const feedback = ANDROID_FEEDBACK[cue];
  if (feedback.kind === 'impact') {
    await Haptics.impactAsync(feedback.style as Haptics.ImpactFeedbackStyle);
    return;
  }
  for (const type of feedback.types) {
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
  // Android: haptic-map.ts (heavy impact for grab/armed, the system slider tick for ticks).
  const feedback =
    Platform.OS === 'android'
      ? androidFeedback(cue)
      : Haptics.impactAsync(IMPACT_STYLE[cue] as Haptics.ImpactFeedbackStyle);
  feedback.catch(() => undefined);
}
