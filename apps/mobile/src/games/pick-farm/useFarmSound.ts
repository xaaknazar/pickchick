import { useCallback, useEffect, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useVideoPlayer, type VideoPlayer } from 'expo-video';

/** Locally synthesised effects (build-sounds.py), played through the app's media runtime. */
export type FarmSound = 'harvest' | 'water' | 'plant' | 'coin' | 'level' | 'cluck' | 'moo' | 'tap';
const SOUND_KEY = 'pickchick.farm.sound.v1';
const BIRDS_KEY = 'pickchick.farm.birds.v1';
/** Effects that rise in pitch when repeated quickly (a sweep along a row). */
const COMBO = new Set<FarmSound>(['harvest', 'water', 'plant', 'cluck', 'coin']);
/** Pitch of the n-th quick repeat: a whole-tone ladder, capped at a fifth above. */
export function comboRate(streak: number) {
  return Math.min(1.5, 2 ** ((2 * Math.min(streak, 7)) / 12));
}

function useEffectPlayer(source: number, volume: number) {
  return useVideoPlayer(source, (p) => {
    p.loop = false;
    p.volume = volume;
    p.audioMixingMode = 'mixWithOthers';
  });
}

/**
 * Sound effects for the farm. Off by default; the player's choice is kept on the device.
 * Nothing plays while the app is in the background or the switch is off.
 */
export function useFarmSounds(active: boolean) {
  const [enabled, setEnabledState] = useState(false);
  // A switch flipped before the saved value loads wins over that value.
  const touched = useRef(false);
  useEffect(() => {
    void AsyncStorage.getItem(SOUND_KEY)
      .then((v) => {
        if (!touched.current) setEnabledState(v === '1');
      })
      .catch(() => undefined);
  }, []);
  const setEnabled = useCallback((value: boolean) => {
    touched.current = true;
    setEnabledState(value);
    void AsyncStorage.setItem(SOUND_KEY, value ? '1' : '0').catch(() => undefined);
  }, []);
  const players: Record<FarmSound, VideoPlayer> = {
    harvest: useEffectPlayer(require('../../../assets/games/pick-farm/garden-harvest.wav'), 0.35),
    water: useEffectPlayer(require('../../../assets/games/pick-farm/water.wav'), 0.4),
    plant: useEffectPlayer(require('../../../assets/games/pick-farm/plant.wav'), 0.45),
    coin: useEffectPlayer(require('../../../assets/games/pick-farm/coin.wav'), 0.35),
    level: useEffectPlayer(require('../../../assets/games/pick-farm/level.wav'), 0.45),
    cluck: useEffectPlayer(require('../../../assets/games/pick-farm/cluck.wav'), 0.4),
    moo: useEffectPlayer(require('../../../assets/games/pick-farm/moo.wav'), 0.4),
    tap: useEffectPlayer(require('../../../assets/games/pick-farm/tap.wav'), 0.3),
  };
  const birdsPlayer = useVideoPlayer(require('../../../assets/games/pick-farm/birds.wav'), (p) => {
    p.loop = true;
    p.volume = 0.18;
    p.audioMixingMode = 'mixWithOthers';
  });
  const [birds, setBirdsState] = useState(true);
  useEffect(() => {
    void AsyncStorage.getItem(BIRDS_KEY)
      .then((v) => {
        if (v !== null) setBirdsState(v === '1');
      })
      .catch(() => undefined);
  }, []);
  const setBirds = useCallback((value: boolean) => {
    setBirdsState(value);
    void AsyncStorage.setItem(BIRDS_KEY, value ? '1' : '0').catch(() => undefined);
  }, []);
  // A quiet meadow loop under the effects: only with sound on and the app in front.
  useEffect(() => {
    try {
      if (enabled && birds && active) birdsPlayer.play();
      else birdsPlayer.pause();
    } catch {
      // Optional ambience.
    }
  }, [enabled, birds, active, birdsPlayer]);
  const live = useRef({
    players,
    enabled,
    active,
    last: {} as Partial<Record<FarmSound, number>>,
    streak: {} as Partial<Record<FarmSound, number>>,
  });
  live.current.players = players;
  live.current.enabled = enabled;
  live.current.active = active;
  useEffect(() => {
    if (enabled && active) return;
    for (const p of Object.values(live.current.players)) p.pause();
  }, [enabled, active]);
  /**
   * Play one effect. Repeats within a sweep rise in pitch like a combo (up to +50%), and a
   * sweep plays at most one per 70 ms.
   */
  const play = useCallback((name: FarmSound) => {
    const L = live.current;
    if (!L.enabled || !L.active) return;
    const now = Date.now();
    const gap = now - (L.last[name] ?? 0);
    if (gap < 70) return;
    L.last[name] = now;
    const streak = COMBO.has(name) && gap < 900 ? (L.streak[name] ?? 0) + 1 : 0;
    L.streak[name] = streak;
    const player = L.players[name];
    try {
      player.preservesPitch = false;
      player.playbackRate = comboRate(streak);
      player.currentTime = 0;
      player.play();
    } catch {
      // Media can be unavailable (silent mode on web before a gesture); effects are optional.
    }
  }, []);
  return { enabled, setEnabled, play, birds, setBirds };
}
