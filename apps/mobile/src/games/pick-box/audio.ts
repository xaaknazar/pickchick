import { useCallback, useEffect, useMemo, useRef } from 'react';
import { setAudioModeAsync, useAudioPlayer } from 'expo-audio';
import type { Cue } from './engine';

/** Short local Foley only. No recording, background session or network requests. */
export function usePickBoxAudio(enabled: boolean) {
  const drop = useAudioPlayer(require('../../../assets/games/pick-box/audio/drop.wav'));
  const impact = useAudioPlayer(require('../../../assets/games/pick-box/audio/impact.wav'));
  const perfect = useAudioPlayer(require('../../../assets/games/pick-box/audio/perfect.wav'));
  const miss = useAudioPlayer(require('../../../assets/games/pick-box/audio/miss.wav'));
  const peak = useAudioPlayer(require('../../../assets/games/pick-box/audio/peak.wav'));
  const collapse = useAudioPlayer(require('../../../assets/games/pick-box/audio/collapse.wav'));
  const players = useMemo(
    () => ({ drop, impact, perfect, miss, peak, collapse }),
    [drop, impact, perfect, miss, peak, collapse],
  );
  const gate = useRef({ enabled, ready: false, generation: 0 });
  gate.current.enabled = enabled;
  const stop = useCallback(() => {
    gate.current.generation++;
    for (const player of Object.values(players)) {
      try {
        player.pause();
      } catch {
        /* The native player may already be released. */
      }
    }
  }, [players]);
  useEffect(() => {
    let live = true;
    void setAudioModeAsync({
      playsInSilentMode: false,
      allowsRecording: false,
      shouldPlayInBackground: false,
      interruptionMode: 'mixWithOthers',
    })
      .then(() => {
        if (live) gate.current.ready = true;
      })
      .catch(() => {});
    for (const player of Object.values(players)) player.volume = 0.55;
    return () => {
      live = false;
      gate.current.ready = false;
      stop();
    };
  }, [players, stop]);
  useEffect(() => {
    if (!enabled) stop();
  }, [enabled, stop]);
  const play = useCallback(
    (kind: Cue['kind'], combo = 0) => {
      if (!gate.current.enabled || !gate.current.ready || kind === 'land') return;
      const player = players[kind];
      const generation = gate.current.generation;
      try {
        player.playbackRate =
          kind === 'perfect' ? 1 + Math.min(5, Math.max(0, combo - 1)) * 0.045 : 1;
        void player
          .seekTo(0)
          .then(() => {
            if (
              gate.current.enabled &&
              gate.current.ready &&
              gate.current.generation === generation
            )
              player.play();
          })
          .catch(() => {});
      } catch {
        /* Missing audio must never block a drop. */
      }
    },
    [players],
  );
  return { play, stop };
}
