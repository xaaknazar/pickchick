import { useEffect, useState } from 'react';
import { AccessibilityInfo, AppState, StyleSheet, View } from 'react-native';
import { Image } from 'expo-image';
import { VideoView, useVideoPlayer } from 'expo-video';
import { LinearGradient } from 'expo-linear-gradient';
import { assets } from '../assets';
/** No playback controls on the storefront. Reduced motion and background state remain respected. */
export function Hero({ video = true, product = false }: { video?: boolean; product?: boolean }) {
  const [reduced, setReduced] = useState(true);
  const [active, setActive] = useState(AppState.currentState === 'active');
  const [failed, setFailed] = useState(false);
  const player = useVideoPlayer(assets.hero, (p) => {
    p.loop = true;
    p.muted = true;
  });
  useEffect(() => {
    let live = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((v) => {
      if (live) setReduced(v);
    });
    const motion = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    const state = AppState.addEventListener('change', (s) => setActive(s === 'active'));
    const status = player.addListener('statusChange', ({ status }) => {
      if (status === 'error') setFailed(true);
    });
    return () => {
      live = false;
      motion.remove();
      state.remove();
      status.remove();
    };
  }, [player]);
  useEffect(() => {
    if (active && video && !reduced && !failed) player.play();
    else player.pause();
  }, [active, video, reduced, failed, player]);
  return (
    <View
      pointerEvents="none"
      style={StyleSheet.absoluteFill}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Image source={assets.poster} style={StyleSheet.absoluteFill} contentFit="cover" />
      {video && !reduced && !failed ? (
        <VideoView
          player={player}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          nativeControls={false}
          accessible={false}
        />
      ) : null}
      <LinearGradient
        colors={
          product
            ? [
                'rgba(5,10,22,.68)',
                'rgba(5,10,22,.12)',
                'rgba(5,10,22,.52)',
                'rgba(5,10,22,.92)',
                'rgba(5,10,22,.98)',
              ]
            : [
                'rgba(2,20,64,.72)',
                'rgba(2,20,64,.06)',
                'rgba(2,18,58,.32)',
                'rgba(2,14,48,.92)',
                'rgba(2,12,42,.99)',
              ]
        }
        locations={[0, 0.26, 0.54, 0.8, 1]}
        style={StyleSheet.absoluteFill}
      />
    </View>
  );
}
