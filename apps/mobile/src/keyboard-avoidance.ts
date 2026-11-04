/**
 * Keyboard avoidance of the sign-in and profile forms (lane android, 05.11.2026).
 *
 * Android builds from Expo SDK 57 are edge-to-edge (mandatory on Android 16 / target API 36):
 * `windowSoftInputMode=adjustResize` no longer shrinks the window, the keyboard is drawn over it
 * and the app gets only its insets. KeyboardAvoidingView therefore pads on Android as on iOS. Its
 * padding is the overlap of the view with the keyboard top that React Native reports
 * (keyboardDidShow `screenY`), so a phone that still resizes the window gets no extra padding.
 * The web has no software keyboard events.
 */
export type KeyboardBehavior = 'padding' | undefined;

export function keyboardAvoidingBehavior(os: string): KeyboardBehavior {
  return os === 'ios' || os === 'android' ? 'padding' : undefined;
}
