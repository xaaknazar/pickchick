import { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  AppState,
  Easing,
  Platform,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import * as SplashScreen from 'expo-splash-screen';

// Keep this color in sync with the original logo and the native splash config.
export const launchBackground = '#0133CC';

export function LaunchScreen({ ready, onFinish }: { ready: boolean; onFinish: () => void }) {
  const progress = useRef(new Animated.Value(0)).current;
  const { width, height } = useWindowDimensions();
  const artworkSize = Math.min(320, width, height * 0.65);
  const [laidOut, setLaidOut] = useState(false);
  const [imagesReady, setImagesReady] = useState<string[]>([]);
  const [imageFailed, setImageFailed] = useState(false);
  const [reduceMotion, setReduceMotion] = useState<boolean | null>(null);
  const [active, setActive] = useState(AppState.currentState !== 'background');
  const imageReady = imagesReady.length === 3;
  const imageLoaded = (name: string) =>
    setImagesReady((names) => (names.includes(name) ? names : [...names, name]));

  useEffect(() => {
    let mounted = true;
    void AccessibilityInfo.isReduceMotionEnabled().then(
      (value) => {
        if (mounted) setReduceMotion(value);
      },
      () => {
        if (mounted) setReduceMotion(true);
      },
    );
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    const appState = AppState.addEventListener('change', (state) => setActive(state === 'active'));
    return () => {
      mounted = false;
      subscription.remove();
      appState.remove();
    };
  }, []);

  useEffect(() => {
    if (laidOut && imageReady && active) SplashScreen.hide();
  }, [laidOut, imageReady, active]);

  useEffect(() => {
    if (!laidOut || !imageReady || !active || reduceMotion === null) return;
    if (reduceMotion || imageFailed) {
      progress.setValue(0);
      if (ready) onFinish();
      return;
    }
    // Start growing as soon as the native screen hands over. Slow fonts only
    // hold the early part of the movement; never reveal an unmounted page.
    const animation = Animated.timing(progress, {
      toValue: ready ? 1 : 0.14,
      duration: ready ? 640 : 900,
      easing: ready ? Easing.bezier(0.32, 0, 0.2, 1) : Easing.out(Easing.cubic),
      useNativeDriver: Platform.OS !== 'web',
    });
    animation.start(({ finished }) => {
      if (finished && ready) onFinish();
    });
    // Animated keeps its current value, including across background/foreground.
    return () => animation.stop();
  }, [laidOut, imageReady, active, reduceMotion, imageFailed, ready, progress, onFinish]);

  const opacity = progress.interpolate({
    inputRange: [0, 0.32, 0.82, 1],
    outputRange: [1, 1, 0.12, 0],
    extrapolate: 'clamp',
  });
  const detailOpacity = progress.interpolate({
    inputRange: [0, 0.14, 0.3, 1],
    outputRange: [1, 1, 0, 0],
    extrapolate: 'clamp',
  });
  const logoScale = progress.interpolate({
    inputRange: [0, 0.14, 0.45, 0.75, 1],
    outputRange: [1, 1.15, 2.4, 5, Math.max(8, (height / artworkSize) * 3)],
    extrapolate: 'clamp',
  });

  return (
    <Animated.View
      testID="launch-screen"
      style={[styles.page, { opacity }]}
      onLayout={() => setLaidOut(true)}
      accessibilityViewIsModal
    >
      <View style={styles.haloTop} pointerEvents="none" accessible={false} />
      <View style={styles.haloBottom} pointerEvents="none" accessible={false} />
      <View
        testID="launch-artwork"
        style={{ width: artworkSize, height: artworkSize }}
        accessible
        accessibilityLabel="PickChick. Твой пик вкуса"
        accessibilityRole="image"
      >
        <Animated.Image
          testID="launch-logo"
          source={require('../../assets/launch/logo.png')}
          style={[
            styles.layer,
            {
              zIndex: 1,
              transform: [{ scale: logoScale }],
            },
          ]}
          resizeMode="contain"
          accessible={false}
          onError={() => setImageFailed(true)}
          onLoadEnd={() => imageLoaded('logo')}
        />
        <Animated.Image
          testID="launch-accents"
          source={require('../../assets/launch/accents.png')}
          style={[
            styles.layer,
            {
              zIndex: 2,
              opacity: detailOpacity,
            },
          ]}
          resizeMode="contain"
          accessible={false}
          onError={() => setImageFailed(true)}
          onLoadEnd={() => imageLoaded('accents')}
        />
        <Animated.Image
          testID="launch-tagline"
          source={require('../../assets/launch/tagline.png')}
          style={[styles.layer, { zIndex: 3, opacity: detailOpacity }]}
          resizeMode="contain"
          accessible={false}
          onError={() => setImageFailed(true)}
          onLoadEnd={() => imageLoaded('tagline')}
        />
      </View>
      {imageFailed ? <Text style={styles.fallback}>PickChick</Text> : null}
      {!ready ? (
        <View
          style={styles.loading}
          accessibilityRole="progressbar"
          accessibilityLabel="Загрузка PickChick"
        >
          {reduceMotion === false ? <ActivityIndicator color="#FFFFFF" size="small" /> : null}
          <Text style={styles.loadingText}>Открываем PickChick</Text>
        </View>
      ) : null}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  page: {
    ...StyleSheet.absoluteFill,
    backgroundColor: launchBackground,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    zIndex: 10,
  },
  layer: { ...StyleSheet.absoluteFill, width: '100%', height: '100%' },
  haloTop: {
    position: 'absolute',
    width: 390,
    height: 390,
    borderRadius: 195,
    borderWidth: 1,
    borderColor: '#FFFFFF12',
    top: -260,
    right: -110,
  },
  haloBottom: {
    position: 'absolute',
    width: 520,
    height: 520,
    borderRadius: 260,
    borderWidth: 1,
    borderColor: '#FFFFFF12',
    bottom: -390,
    left: -130,
  },
  loading: {
    position: 'absolute',
    bottom: '9%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  loadingText: { color: '#FFFFFFCC', fontSize: 14, lineHeight: 22 },
  fallback: { position: 'absolute', color: '#FFFFFF', fontSize: 32, fontWeight: '700' },
});
