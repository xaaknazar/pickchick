/**
 * Which feedback each slide-to-pay cue plays on each platform (haptics.ts plays it).
 *
 * iOS: UIImpactFeedbackGenerator styles (owner 29.10.2026: heavy grab, medium ticks, heavy at the
 * point where letting go pays).
 * Android (lane android, 05.11.2026): the system's own haptic constants
 * (View.performHapticFeedback, expo-haptics `performAndroidHapticsAsync`) instead of a fixed
 * vibration: they are tuned per device, short enough for a tick every sixteenth of the track
 * (a 43 ms vibrator buzz per tick blurs into one hum) and follow the phone's «Touch feedback»
 * setting as iOS follows System Haptics. Newer constants come first; on an older Android the
 * next one plays, and only when none is available the vibrator impact is used.
 */
export type HapticCue = 'grab' | 'tick' | 'armed';

/** expo-haptics `AndroidHaptics` values, preferred first (API level in the comment). */
export const ANDROID_HAPTICS: Record<HapticCue, readonly string[]> = {
  // DRAG_START (34): the handle was picked up; LONG_PRESS (all versions).
  grab: ['drag-start', 'long-press'],
  // SEGMENT_TICK (34): a discrete point on a slider; CLOCK_TICK (all versions).
  tick: ['segment-tick', 'clock-tick'],
  // CONFIRM (30): letting go now pays; LONG_PRESS (all versions).
  armed: ['confirm', 'long-press'],
};

/** expo-haptics `ImpactFeedbackStyle` values; Android uses them only as the last fallback. */
export const IMPACT_STYLE: Record<HapticCue, 'medium' | 'heavy'> = {
  grab: 'heavy',
  tick: 'medium',
  armed: 'heavy',
};
