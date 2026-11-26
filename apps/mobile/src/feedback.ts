import { useEffect } from 'react';
import { AppState, Platform } from 'react-native';
import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from 'expo-audio';
import { paidHaptic } from './haptics';

/**
 * The «оплачено» moment (owner 25.11.2026): one success haptic and one soft chime, once per order,
 * whichever screen shows the result first (the Kaspi wait scene or the TipTopPay result sheet).
 *
 * The chime is polite by design:
 * - `playsInSilentMode: false`: on iOS the ring/silent switch silences it (ambient category), the
 *   haptic still plays; on Android the phone's media volume decides;
 * - `interruptionMode: 'mixWithOthers'`: the customer's music keeps playing, nothing is ducked;
 * - quiet (volume 0.5 of a −6 dBFS file) and short (0.6 s);
 * - only while the app is in the foreground, never for an order reopened later from history
 *   (the caller passes `fresh`).
 * Web plays nothing; browser tests read `globalThis.__pickchickSounds` when they create it.
 */
const celebrated = new Set<string>();
let player: AudioPlayer | null = null;
let modeSet: Promise<unknown> | null = null;

function playPaidChime(): void {
  if (Platform.OS === 'web') {
    const log = (globalThis as { __pickchickSounds?: unknown }).__pickchickSounds;
    if (Array.isArray(log)) log.push('paid');
    return;
  }
  try {
    modeSet ??= setAudioModeAsync({
      playsInSilentMode: false,
      allowsRecording: false,
      shouldPlayInBackground: false,
      interruptionMode: 'mixWithOthers',
    }).catch(() => undefined);
    void modeSet.then(() => {
      try {
        player ??= createAudioPlayer(require('../assets/sounds/paid.wav'));
        player.volume = 0.5;
        void player.seekTo(0).catch(() => undefined);
        player.play();
      } catch {
        // An older native build without the audio module only loses the chime.
      }
    });
  } catch {
    // Same: the haptic already told the customer.
  }
}

/** Celebrates a paid order once. Returns false when it was already celebrated. */
export function celebratePaid(orderId: string): boolean {
  if (!orderId || celebrated.has(orderId)) return false;
  celebrated.add(orderId);
  if (AppState.currentState !== 'active') return false;
  paidHaptic();
  playPaidChime();
  return true;
}

/**
 * Marks an order as already celebrated without any feedback: a result that was paid before this
 * screen opened (history, a restart) must not chime.
 */
export function markPaidSeen(orderId: string | null | undefined): void {
  if (orderId) celebrated.add(orderId);
}

/** Plays the paid feedback when `paid` turns true for `orderId` on a mounted screen. */
export function usePaidFeedback(paid: boolean, orderId: string | null | undefined): void {
  useEffect(() => {
    if (paid && orderId) celebratePaid(orderId);
  }, [paid, orderId]);
}

/** Test hook: forget what was celebrated. */
export function resetPaidFeedbackForTests(): void {
  celebrated.clear();
}
