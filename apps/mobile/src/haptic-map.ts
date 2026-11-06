/**
 * Which feedback each slide-to-pay cue plays on each platform (haptics.ts plays it).
 *
 * iOS: UIImpactFeedbackGenerator styles (owner 29.10.2026: heavy grab, medium ticks, heavy at the
 * point where letting go pays).
 * Android (lane android, 05.11.2026, tech-lead review the same day):
 * - `grab` and `armed` keep the heavy expo-haptics impact (a 60 ms vibrator pulse, as before the
 *   lane): the owner asked for firmer feedback, and the system DRAG_START / CONFIRM / LONG_PRESS
 *   constants are short and often weaker than that pulse on real phones;
 * - `tick` plays the system's own slider constant (View.performHapticFeedback, expo-haptics
 *   `performAndroidHapticsAsync`): it is tuned per device and short enough for a tick every
 *   sixteenth of the track, where a 43 ms vibrator buzz per tick blurs into one hum. It follows
 *   the phone's «Touch feedback» setting as iOS follows System Haptics. SEGMENT_TICK (API 34)
 *   comes first; on an older Android CLOCK_TICK (every version) plays, and only when neither is
 *   available the medium impact is used.
 * The strength still has to be felt on 2-3 real phones before production (lane note).
 */
export type HapticCue = 'grab' | 'tick' | 'armed';

export type AndroidFeedback =
  { kind: 'impact'; style: 'medium' | 'heavy' } | { kind: 'system'; types: readonly string[] };

/** What Android plays for each cue; `types` are expo-haptics `AndroidHaptics` values, preferred first. */
export const ANDROID_FEEDBACK: Record<HapticCue, AndroidFeedback> = {
  grab: { kind: 'impact', style: 'heavy' },
  // SEGMENT_TICK (34): a discrete point on a slider; CLOCK_TICK (all versions).
  tick: { kind: 'system', types: ['segment-tick', 'clock-tick'] },
  armed: { kind: 'impact', style: 'heavy' },
};

/** expo-haptics `ImpactFeedbackStyle` values: iOS always, Android for impacts and as the last fallback. */
export const IMPACT_STYLE: Record<HapticCue, 'medium' | 'heavy'> = {
  grab: 'heavy',
  tick: 'medium',
  armed: 'heavy',
};
