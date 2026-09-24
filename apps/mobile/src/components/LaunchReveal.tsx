import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  AppState,
  Easing,
  Platform,
  StyleSheet,
  Text,
  useWindowDimensions,
} from 'react-native';
import { Image } from 'expo-image';
import * as SplashScreen from 'expo-splash-screen';
import { assets } from '../assets';
import { font } from '../theme';
import { useMotionReady, useReducedMotion } from './Motion';

// Exact background of the supplied logo; avoids a visible square around the artwork.
export const launchBackground = '#0133CC';
export function LaunchReveal({
  ready,
  failed,
  onComplete,
}: {
  ready: boolean;
  failed: boolean;
  onComplete(): void;
}) {
  const { width, height } = useWindowDimensions();
  const reduced = useReducedMotion();
  const motionReady = useMotionReady();
  const [imageReady, setImageReady] = useState(false);
  const [laidOut, setLaidOut] = useState(false);
  const progress = useRef(new Animated.Value(0)).current;
  const opacity = useRef(new Animated.Value(1)).current;
  const complete = useRef(onComplete);
  complete.current = onComplete;
  const started = useRef(false);
  const finished = useRef(false);
  const size = Math.min(320, width);
  const zoom = (Math.max(width, height) / (size * 0.46)) * 1.15;
  const finish = useCallback(() => {
    if (finished.current) return;
    finished.current = true;
    // Also release the OS layer when backgrounding interrupts image preparation.
    void SplashScreen.hideAsync().catch(() => {});
    complete.current();
  }, []);
  useEffect(() => {
    // A missing local image must never trap a guest at launch.
    const timeout = setTimeout(() => setImageReady(true), 1000);
    return () => clearTimeout(timeout);
  }, []);
  useEffect(() => {
    if (laidOut && imageReady) void SplashScreen.hideAsync().catch(() => {});
  }, [laidOut, imageReady]);
  useEffect(() => {
    if (!ready || !laidOut || !imageReady || !motionReady) return;
    // Preference changes interrupt the zoom, never replay it.
    const skipZoom = started.current || reduced || failed;
    started.current = true;
    const animation = skipZoom
      ? Animated.timing(opacity, {
          toValue: 0,
          duration: 160,
          useNativeDriver: Platform.OS !== 'web',
        })
      : Animated.timing(progress, {
          toValue: 1,
          duration: 860,
          easing: Easing.in(Easing.cubic),
          useNativeDriver: Platform.OS !== 'web',
        });
    animation.start(({ finished }) => {
      if (finished) finish();
    });
    const fallback = setTimeout(finish, 1400);
    return () => {
      clearTimeout(fallback);
      animation.stop();
    };
  }, [ready, laidOut, imageReady, motionReady, reduced, failed, progress, opacity, finish]);
  useEffect(() => {
    // Returning from the background should reveal the destination, not replay a logo.
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active' && ready) finish();
    });
    return () => sub.remove();
  }, [finish, ready]);
  return (
    <Animated.View
      testID="launch-reveal"
      onLayout={() => setLaidOut(true)}
      accessibilityLabel="Pick Chick. Твой пик вкуса"
      accessibilityRole="image"
      style={[
        s.overlay,
        {
          opacity: Animated.multiply(
            opacity,
            progress.interpolate({ inputRange: [0, 0.68, 1], outputRange: [1, 1, 0] }),
          ),
        },
      ]}
    >
      <Animated.View
        testID="launch-logo"
        style={{
          transform: [
            {
              scale: reduced
                ? 1
                : progress.interpolate({ inputRange: [0, 1], outputRange: [1, zoom] }),
            },
          ],
        }}
      >
        <Image
          source={assets.logo}
          style={{ width: size, height: size }}
          contentFit="contain"
          onLoadEnd={() => setImageReady(true)}
          onError={() => setImageReady(true)}
          accessible={false}
        />
      </Animated.View>
      {ready && !failed ? (
        <Animated.View
          style={[
            s.tagline,
            {
              top: height / 2 + size * 0.36,
              opacity: progress.interpolate({
                inputRange: [0, 0.02, 0.09],
                outputRange: [1, 1, 0],
                extrapolate: 'clamp',
              }),
            },
          ]}
        >
          <Text style={s.text}>Твой пик вкуса</Text>
        </Animated.View>
      ) : null}
    </Animated.View>
  );
}
const s = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFill,
    backgroundColor: launchBackground,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    zIndex: 100,
  },
  tagline: { position: 'absolute', left: 24, right: 24, alignItems: 'center' },
  text: {
    fontFamily: font.medium,
    fontSize: 22,
    lineHeight: 30,
    color: '#FFFFFF',
    textAlign: 'center',
  },
});
