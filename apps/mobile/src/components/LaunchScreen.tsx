import { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  Image,
  Platform,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import * as SplashScreen from 'expo-splash-screen';

// Keep this color in sync with the original logo and the native splash config.
export const launchBackground = '#0133CC';

export function LaunchScreen({ ready, onFinish }: { ready: boolean; onFinish: () => void }) {
  const opacity = useRef(new Animated.Value(1)).current;
  const [laidOut, setLaidOut] = useState(false);
  const [imageReady, setImageReady] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const [reduceMotion, setReduceMotion] = useState<boolean | null>(null);

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
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    if (laidOut && imageReady) SplashScreen.hide();
  }, [laidOut, imageReady]);

  useEffect(() => {
    if (!ready || !laidOut || !imageReady || reduceMotion === null) return;
    if (reduceMotion) {
      onFinish();
      return;
    }
    const animation = Animated.timing(opacity, {
      toValue: 0,
      duration: 260,
      useNativeDriver: Platform.OS !== 'web',
    });
    animation.start(({ finished }) => {
      if (finished) onFinish();
    });
    return () => animation.stop();
  }, [ready, laidOut, imageReady, reduceMotion, opacity, onFinish]);

  return (
    <Animated.View
      testID="launch-screen"
      style={[styles.page, { opacity }]}
      onLayout={() => setLaidOut(true)}
      accessibilityViewIsModal
    >
      <View style={styles.haloTop} pointerEvents="none" accessible={false} />
      <View style={styles.haloBottom} pointerEvents="none" accessible={false} />
      <Image
        testID="launch-artwork"
        source={require('../../assets/launch/artwork.png')}
        style={styles.artwork}
        resizeMode="contain"
        accessibilityLabel="PickChick. Твой пик вкуса"
        onError={() => setImageFailed(true)}
        onLoadEnd={() => setImageReady(true)}
      />
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
  artwork: { width: 320, height: 320, maxWidth: '100%', maxHeight: '65%' },
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
