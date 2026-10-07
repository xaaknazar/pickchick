import { useEffect, useState } from 'react';
import { AccessibilityInfo, AppState, StyleSheet, View } from 'react-native';
import { Image } from 'expo-image';
import { VideoView, useVideoPlayer } from 'expo-video';
import { assets } from '../assets';
import { HeroShade } from './HeroBackdrop';
/** The native player owns its lifetime; no imperative native call occurs in cleanup. */
export function Hero({ video = true }: { video?: boolean }) {
  const [reduced, setReduced] = useState(true);
  const [active, setActive] = useState(AppState.currentState === 'active');
  const [failed, setFailed] = useState(false);
  const [firstFrame, setFirstFrame] = useState(false);
  const player = useVideoPlayer(assets.hero, (p) => {
    p.loop = true;
    p.muted = true;
  });
  useEffect(() => {
    let live = true;
    void AccessibilityInfo.isReduceMotionEnabled()
      .then((value) => {
        if (live) setReduced(value);
      })
      .catch(() => {
        /* Keep the static cover if this capability cannot be read. */
      });
    const motion = AccessibilityInfo.addEventListener('reduceMotionChanged', (value) => {
      if (live) setReduced(value);
    });
    const state = AppState.addEventListener('change', (value) => {
      if (live) setActive(value === 'active');
    });
    return () => {
      live = false;
      motion.remove();
      state.remove();
    };
  }, []);
  useEffect(() => {
    let live = true;
    try {
      const status = player.addListener('statusChange', ({ status }) => {
        if (live && status === 'error') setFailed(true);
      });
      return () => {
        live = false;
        try {
          status.remove();
        } catch {
          /* SharedObject may already have been released. */
        }
      };
    } catch {
      setFailed(true);
    }
    return () => {
      live = false;
    };
  }, [player]);
  useEffect(() => {
    try {
      if (active && video && !reduced && !failed) player.play();
      else player.pause();
    } catch {
      setFailed(true);
    }
    // useVideoPlayer releases itself on unmount; pausing in cleanup races that release.
  }, [active, video, reduced, failed, player]);
  const poster = (
    <Image
      accessible={false}
      accessibilityLabel=""
      source={assets.poster}
      style={StyleSheet.absoluteFill}
      contentFit="cover"
      pointerEvents="none"
    />
  );
  return (
    <View
      pointerEvents="none"
      style={StyleSheet.absoluteFill}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {poster}
      {video && !reduced && !failed ? (
        <VideoView
          player={player}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          nativeControls={false}
          accessible={false}
          onFirstFrameRender={() => setFirstFrame(true)}
        />
      ) : null}
      {!firstFrame || failed ? poster : null}
      <HeroShade />
    </View>
  );
}
