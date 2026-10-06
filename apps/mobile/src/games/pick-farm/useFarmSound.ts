import { useCallback, useEffect, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useVideoPlayer, type VideoPlayer } from 'expo-video';

/** Locally synthesised effects (build-sounds.py), played through the app's media runtime. */
export type FarmSound = 'harvest' | 'water' | 'plant' | 'coin' | 'level' | 'cluck' | 'moo' | 'tap';
const SOUND_KEY = 'pickchick.farm.sound.v1';

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
  useEffect(() => {
    void AsyncStorage.getItem(SOUND_KEY)
      .then((v) => setEnabledState(v === '1'))
      .catch(() => undefined);
  }, []);
  const setEnabled = useCallback((value: boolean) => {
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
  const live = useRef({ players, enabled, active, last: {} as Partial<Record<FarmSound, number>> });
  live.current.players = players;
  live.current.enabled = enabled;
  live.current.active = active;
  useEffect(() => {
    if (enabled && active) return;
    for (const p of Object.values(live.current.players)) p.pause();
  }, [enabled, active]);
  /** Play one effect; a sweep that triggers many in a row plays at most one per 70 ms. */
  const play = useCallback((name: FarmSound) => {
    const L = live.current;
    if (!L.enabled || !L.active) return;
    const now = Date.now();
    if (now - (L.last[name] ?? 0) < 70) return;
    L.last[name] = now;
    const player = L.players[name];
    try {
      player.currentTime = 0;
      player.play();
    } catch {
      // Media can be unavailable (silent mode on web before a gesture); effects are optional.
    }
  }, []);
  return { enabled, setEnabled, play };
}
