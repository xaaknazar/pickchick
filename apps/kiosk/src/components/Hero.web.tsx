import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Asset } from 'expo-asset';
import { Image } from 'expo-image';
import { assets } from '../assets';
import { HeroShade } from './HeroBackdrop';
/** Own the browser play() promise: expo-video's web adapter discards AbortError. */
export function Hero({ video = true }: { video?: boolean }) {
  const element = useRef<HTMLVideoElement>(null);
  const [reduced, setReduced] = useState(true);
  const [visible, setVisible] = useState(false);
  const [failed, setFailed] = useState(false);
  const [firstFrame, setFirstFrame] = useState(false);
  useEffect(() => {
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => {
      setReduced(motion.matches);
      setVisible(!document.hidden);
    };
    sync();
    motion.addEventListener('change', sync);
    document.addEventListener('visibilitychange', sync);
    return () => {
      motion.removeEventListener('change', sync);
      document.removeEventListener('visibilitychange', sync);
    };
  }, []);
  useEffect(() => {
    const player = element.current;
    if (!player) return;
    let obsolete = false;
    if (video && visible && !reduced && !failed)
      void player.play().catch((error: unknown) => {
        if (obsolete || (error instanceof DOMException && error.name === 'AbortError')) return;
        setFailed(true);
      });
    else player.pause();
    return () => {
      obsolete = true;
      player.pause();
    };
  }, [video, visible, reduced, failed]);
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
        <video
          ref={element}
          src={Asset.fromModule(assets.hero).uri}
          muted
          loop
          playsInline
          controls={false}
          disablePictureInPicture
          aria-hidden="true"
          tabIndex={-1}
          preload="metadata"
          onLoadedData={() => setFirstFrame(true)}
          onError={() => setFailed(true)}
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            pointerEvents: 'none',
          }}
        />
      ) : null}
      {!firstFrame || failed ? poster : null}
      <HeroShade />
    </View>
  );
}
