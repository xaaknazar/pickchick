import { useEffect, useRef, useState } from 'react';
import { AppState, Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Directory, File, Paths } from 'expo-file-system';
import type { Locale } from '../i18n';
import { photoCopy } from '../photobooth/copy';
import { colors, fonts } from '../theme';
import { fixedText } from './Body';

export function PhotoCamera({
  locale,
  shot,
  onReady,
  onCapture,
  onError,
}: {
  locale: Locale;
  shot: number;
  onReady: (ready: boolean) => void;
  onCapture: (base64: string, uri: string, dispose: () => void) => void;
  onError: () => void;
}) {
  const [permission, requestPermission] = useCameraPermissions();
  const [active, setActive] = useState(AppState.currentState === 'active');
  const [cacheReady, setCacheReady] = useState(Platform.OS === 'web');
  const camera = useRef<CameraView>(null);
  const callbacks = useRef({ onReady, onCapture, onError });
  callbacks.current = { onReady, onCapture, onError };
  const ready = useRef(false);
  const mounted = useRef(true);
  const last = useRef(shot);
  const t = photoCopy(locale);
  useEffect(() => {
    mounted.current = true;
    // Camera is used only by this booth in the kiosk. Remove orphaned capture files after a crash.
    if (Platform.OS !== 'web') {
      try {
        const cache = new Directory(Paths.cache, 'Camera');
        if (cache.exists)
          for (const file of cache.list())
            if (file instanceof File && /\.(jpg|jpeg|png)$/i.test(file.name)) file.delete();
        setCacheReady(true);
      } catch {
        callbacks.current.onError();
      }
    }
    const sub = AppState.addEventListener('change', (s) => {
      setActive(s === 'active');
      ready.current = false;
      callbacks.current.onReady(false);
    });
    return () => {
      mounted.current = false;
      sub.remove();
      callbacks.current.onReady(false);
    };
  }, []);
  useEffect(() => {
    if (last.current === shot) return;
    last.current = shot;
    if (!ready.current || !camera.current) return;
    ready.current = false;
    callbacks.current.onReady(false);
    void camera.current
      .takePictureAsync({ quality: 0.4, base64: true, exif: false })
      .then((photo) => {
        // The original is needed only long enough to read its base64. Never save to Photos.
        if (photo?.uri && Platform.OS !== 'web') {
          new File(photo.uri).delete();
        }
        if (!mounted.current) return;
        if (!photo?.base64) {
          throw new Error('Missing photograph');
        }
        // Expo web includes the data-URI prefix; native returns bare base64.
        const uri = photo.base64.startsWith('data:image/')
          ? photo.base64
          : 'data:image/jpeg;base64,' + photo.base64;
        const base64 = uri.slice(uri.indexOf(',') + 1);
        callbacks.current.onCapture(base64, uri, () => {});
      })
      .catch(() => {
        if (mounted.current) {
          ready.current = true;
          callbacks.current.onReady(true);
          callbacks.current.onError();
        }
      });
  }, [shot]);
  if (!permission?.granted)
    return (
      <View style={styles.permission}>
        <Text {...fixedText} style={styles.label}>
          {t.permission}
        </Text>
        <Pressable
          accessibilityRole="button"
          testID="photo-camera-permission"
          onPress={() =>
            void (
              permission?.canAskAgain === false ? Linking.openSettings() : requestPermission()
            ).catch(onError)
          }
          style={styles.button}
        >
          <Text {...fixedText} style={styles.action}>
            {permission?.canAskAgain === false ? t.settings : t.allow}
          </Text>
        </Pressable>
      </View>
    );
  return (
    <View style={styles.frame}>
      {active && cacheReady ? (
        <CameraView
          ref={camera}
          style={styles.camera}
          facing="front"
          mode="picture"
          mirror
          mute
          flash="off"
          responsiveOrientationWhenOrientationLocked={false}
          onCameraReady={() => {
            ready.current = true;
            callbacks.current.onReady(true);
          }}
          onMountError={() => callbacks.current.onError()}
        />
      ) : null}
    </View>
  );
}
const styles = StyleSheet.create({
  frame: {
    width: '100%',
    aspectRatio: 4 / 3,
    borderRadius: 16,
    overflow: 'hidden',
    backgroundColor: colors.navy,
  },
  camera: { flex: 1 },
  permission: {
    aspectRatio: 4 / 3,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 24,
    padding: 24,
    backgroundColor: colors.navy,
    borderRadius: 16,
  },
  label: { fontFamily: fonts.bold, fontSize: 22, textAlign: 'center', color: colors.white },
  button: { minHeight: 56, padding: 18, borderRadius: 16, backgroundColor: colors.white },
  action: { fontFamily: fonts.bold, fontSize: 18, color: colors.blue },
});
