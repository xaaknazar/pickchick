import { useEffect, useState } from 'react';
import {
  AccessibilityInfo,
  Keyboard,
  Platform,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type ViewStyle,
} from 'react-native';
import type { BottomTabBarProps } from 'expo-router/tabs';
import { MotionPressable as Pressable } from './Motion';
import { TabIcon } from './UI';
import { font } from '../theme';
import { tabBarMetrics, tabBarPalette as palette, tabLabelMaxScale } from '../tab-bar-metrics';

type TabName = 'menu' | 'events' | 'orders' | 'profile';

export { TabBarInsetContext, useTabBarInset } from './tab-bar-inset';

// iOS "Reduce Transparency" and the web media query switch the glass to an opaque surface.
function useReducedTransparency() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (Platform.OS === 'web') {
      const query =
        typeof window !== 'undefined' && typeof window.matchMedia === 'function'
          ? window.matchMedia('(prefers-reduced-transparency: reduce)')
          : null;
      if (!query) return;
      const update = () => setReduced(query.matches);
      update();
      query.addEventListener?.('change', update);
      return () => query.removeEventListener?.('change', update);
    }
    let active = true;
    AccessibilityInfo.isReduceTransparencyEnabled()
      .then((value) => active && setReduced(value))
      .catch(() => {});
    const subscription = AccessibilityInfo.addEventListener(
      'reduceTransparencyChanged',
      (value: boolean) => setReduced(value),
    );
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);
  return reduced;
}

function useKeyboardVisible() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (Platform.OS === 'web') return;
    const show = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow',
      () => setVisible(true),
    );
    const hide = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide',
      () => setVisible(false),
    );
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return visible;
}

// Native blur needs an extra native module; the web build gets a CSS backdrop blur and
// native keeps the 0.92 navy glass, which already reads as the Luma capsule.
const webGlass =
  Platform.OS === 'web'
    ? ({
        backdropFilter: 'saturate(180%) blur(20px)',
        WebkitBackdropFilter: 'saturate(180%) blur(20px)',
      } as unknown as ViewStyle)
    : null;

export function FloatingTabBar({ state, descriptors, navigation, insets }: BottomTabBarProps) {
  const { fontScale } = useWindowDimensions();
  const reducedTransparency = useReducedTransparency();
  const keyboardVisible = useKeyboardVisible();
  const metrics = tabBarMetrics(insets, fontScale);
  if (keyboardVisible) return null;
  return (
    <View
      pointerEvents="box-none"
      style={[s.host, { bottom: metrics.bottom, paddingHorizontal: metrics.side }]}
    >
      <View
        testID="floating-tab-bar"
        accessibilityRole="tablist"
        style={[
          s.bar,
          { maxWidth: metrics.maxWidth, padding: metrics.padding },
          reducedTransparency ? s.solid : [s.glass, webGlass],
        ]}
      >
        {state.routes.map((route, index) => {
          const options = descriptors[route.key]?.options ?? {};
          const focused = state.index === index;
          const label = typeof options.title === 'string' ? options.title : route.name;
          const color = focused ? palette.active : palette.inactive;
          const onPress = () => {
            const event = navigation.emit({
              type: 'tabPress',
              target: route.key,
              canPreventDefault: true,
            });
            if (!focused && !event.defaultPrevented) navigation.navigate(route.name, route.params);
          };
          return (
            <Pressable
              key={route.key}
              testID={options.tabBarButtonTestID}
              accessibilityRole="tab"
              accessibilityState={{ selected: focused }}
              aria-selected={focused}
              accessibilityLabel={options.tabBarAccessibilityLabel ?? label}
              feedback="scale"
              onPress={onPress}
              onLongPress={() => navigation.emit({ type: 'tabLongPress', target: route.key })}
              style={[s.item, { minHeight: metrics.itemHeight }]}
            >
              {focused ? (
                <View
                  testID={`${options.tabBarButtonTestID}-pill`}
                  pointerEvents="none"
                  style={s.pill}
                />
              ) : null}
              <TabIcon name={route.name as TabName} color={color} />
              <Text
                numberOfLines={1}
                maxFontSizeMultiplier={tabLabelMaxScale}
                style={[s.label, { color }, focused && s.labelActive]}
              >
                {label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  host: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  bar: {
    width: '100%',
    flexDirection: 'row',
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: palette.border,
    shadowColor: palette.shadow,
    shadowOpacity: 0.35,
    shadowOffset: { width: 0, height: 8 },
    shadowRadius: 18,
    elevation: 12,
  },
  glass: { backgroundColor: palette.glass },
  solid: { backgroundColor: palette.solid },
  item: {
    flex: 1,
    minWidth: 48,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    paddingHorizontal: 4,
    paddingVertical: 6,
    borderRadius: 999,
  },
  pill: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    borderRadius: 999,
    backgroundColor: palette.pill,
  },
  label: {
    fontFamily: font.medium,
    fontSize: 11,
    lineHeight: 16,
    includeFontPadding: false,
    textAlign: 'center',
  },
  labelActive: { fontFamily: font.bold },
});
