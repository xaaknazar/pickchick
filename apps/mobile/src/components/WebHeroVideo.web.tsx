import { MediaPoster, useReducedMotion } from './Motion';
import { useEffect, useRef, useState } from 'react';
import { Asset } from 'expo-asset';
import { Image } from 'expo-image';
import { StyleSheet, View, type ViewStyle } from 'react-native';
import { assets } from '../assets';
import { heroShouldPlay } from '../hero-playback';
import { useHeroHostVisible } from './useHeroHostVisible';

// expo-video's current web player discards the HTML play() promise. Own that
// promise here: navigation can pause a still-pending play request (AbortError).
export function WebHeroVideo({ gradient }: { gradient?: string }) {
  const video = useRef<HTMLVideoElement>(null);
  const reduced = useReducedMotion();
  const [visible, setVisible] = useState(false);
  // Same rule as the native player: sheets over the menu keep it playing (27.10.2026).
  const hostVisible = useHeroHostVisible();
  const [firstFrame, setFirstFrame] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const sync = () => {
      setVisible(!document.hidden);
    };
    sync();
    document.addEventListener('visibilitychange', sync);
    return () => {
      document.removeEventListener('visibilitychange', sync);
    };
  }, []);
  useEffect(() => {
    if (reduced) setFirstFrame(false);
  }, [reduced]);
  useEffect(() => {
    const element = video.current;
    if (!element) return;
    let obsolete = false;
    if (heroShouldPlay({ reducedMotion: reduced, appActive: visible, failed, hostVisible })) {
      void element.play().catch((error: unknown) => {
        if (obsolete || (error instanceof DOMException && error.name === 'AbortError')) return;
        // Unsupported media/autoplay rejection keeps the static brand cover.
        setFailed(true);
      });
    } else element.pause();
    return () => {
      obsolete = true;
      element.pause();
    };
  }, [reduced, visible, hostVisible, failed]);
  const poster = (
    <Image
      source={assets.poster}
      style={StyleSheet.absoluteFill}
      contentFit="cover"
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    />
  );
  return (
    <>
      {poster}
      {!reduced && !failed ? (
        <video
          ref={video}
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
      <MediaPoster hidden={firstFrame && !failed && !reduced}>{poster}</MediaPoster>
      {gradient ? (
        <View
          pointerEvents="none"
          style={[StyleSheet.absoluteFill, { backgroundImage: gradient } as ViewStyle]}
        />
      ) : null}
    </>
  );
}
