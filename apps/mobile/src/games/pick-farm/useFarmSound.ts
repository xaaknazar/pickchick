import { useEffect } from 'react';
import { useVideoPlayer } from 'expo-video';

/** Optional, locally generated harvest chime. Reuses the app's existing media runtime. */
export function useFarmSound(receiptId: number | undefined, enabled: boolean, active: boolean) {
  const player = useVideoPlayer(
    require('../../../assets/games/pick-farm/garden-harvest.wav'),
    (p) => {
      p.loop = false;
      p.volume = 0.35;
      p.audioMixingMode = 'mixWithOthers';
    },
  );
  useEffect(() => {
    if (!enabled || !active || !receiptId) {
      player.pause();
      return;
    }
    player.currentTime = 0;
    player.play();
  }, [receiptId, enabled, active, player]);
}
