import { useContext, useEffect, useRef, useState } from 'react';
import { useIsFocused, useLocalSearchParams } from 'expo-router';
import { Keyboard, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ScreenHost } from '../ScreenHost';
import { designPreview } from '../store-build';
import { colors } from '../theme';
import { NativeTabCartSeenContext } from './NativeTabLayout';
import { TabBarInsetContext, TabCartDockContext } from './tab-bar-inset';
import { TabCartDock } from './TabCartDock';

/** NativeTabs supplies the actual tab-bar safe area inside each screen, including Dynamic Type. */
export function NativeTabScreen({ id }: { id: 'M06' | 'M26' | 'M19' }) {
  const insets = useSafeAreaInsets();
  const focused = useIsFocused();
  const [visited, setVisited] = useState(focused);
  const [dockHeight, setDockHeight] = useState<number | null>(null);
  const [keyboardVisible, setKeyboardVisible] = useState(() => Keyboard.isVisible());
  const params = useLocalSearchParams<{ preview?: string }>();
  const fallbackSeen = useRef(0);
  const seenCartCount = useContext(NativeTabCartSeenContext) ?? fallbackSeen;
  useEffect(() => {
    if (focused) setVisited(true);
  }, [focused]);
  useEffect(() => {
    const show = Keyboard.addListener('keyboardWillShow', () => setKeyboardVisible(true));
    const hide = Keyboard.addListener('keyboardWillHide', () => setKeyboardVisible(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  // Retain a visited screen and its scroll state. Never key/remount it on tab selection.
  // A nonzero initial inset also identifies the tab layout before the first native measurement.
  const tabInset = Math.max(1, insets.bottom);
  return (
    <TabBarInsetContext.Provider value={tabInset}>
      <TabCartDockContext.Provider value={dockHeight}>
        <View style={styles.screen}>
          {visited || focused ? <ScreenHost id={id} /> : null}
          {!keyboardVisible ? (
            <View pointerEvents="box-none" style={[styles.dock, { bottom: tabInset }]}>
              <TabCartDock
                preview={designPreview(params.preview)}
                resume={id === 'M06'}
                onHeightChange={setDockHeight}
                seenCount={seenCartCount}
              />
            </View>
          ) : null}
        </View>
      </TabCartDockContext.Provider>
    </TabBarInsetContext.Provider>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  dock: { position: 'absolute', left: 0, right: 0 },
});
