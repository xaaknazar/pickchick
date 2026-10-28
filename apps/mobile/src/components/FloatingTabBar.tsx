import { localize, t, useLocale } from '../i18n';
import { useEffect, useRef, useState } from 'react';
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
import { TabCartDock } from './TabCartDock';
import { colors, font } from '../theme';
import {
  tabBarMetrics,
  tabBarPalette as palette,
  tabLabelMaxScale,
  tabLabelMinFit,
  tabLabelSize,
} from '../tab-bar-metrics';

// Owner 27.10.2026: three tabs; the profile opens from the top header.
type TabName = 'menu' | 'events' | 'orders';

export {
  TabBarInsetContext,
  TabCartDockContext,
  useTabBarInset,
  useTabCartDockHeight,
} from './tab-bar-inset';

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

export function FloatingTabBar({
  state,
  descriptors,
  navigation,
  insets,
  onTabBarHeight,
  onCartDockHeight,
}: BottomTabBarProps & {
  /** The tab capsule's measured height (the tab layout derives the screens' inset from it). */
  onTabBarHeight?: (height: number) => void;
  /** The docked cart bar's measured height, 0 while the cart is empty. */
  onCartDockHeight?: (height: number) => void;
}) {
  useLocale();
  const { fontScale } = useWindowDimensions();
  const reducedTransparency = useReducedTransparency();
  const keyboardVisible = useKeyboardVisible();
  const metrics = tabBarMetrics(insets, fontScale);
  const params = state.routes[state.index]?.params as { preview?: unknown } | undefined;
  // The cart's item count the customer last saw on the docked bar. Kept here, not in the bar: the
  // bar unmounts under a sheet and under the keyboard, and a remount is not «an item was added».
  const seenCartCount = useRef(0);
  // The keyboard hides the tab bar and the cart bar docked on it together.
  if (keyboardVisible) return null;
  // One layer above every tab screen (owner 28.10.2026): the cart bar (quick pay) is laid out
  // right on top of the tab capsule, so it can never slip under the tabs, whatever the tab bar's
  // real height, the safe area or a screen's frame (TabCartDock).
  return (
    <View pointerEvents="box-none" style={[s.host, { bottom: metrics.bottom }]}>
      <TabCartDock
        preview={params?.preview === '1'}
        onHeightChange={onCartDockHeight}
        seenCount={seenCartCount}
      />
      <View
        pointerEvents="box-none"
        style={[s.barRow, { paddingHorizontal: metrics.side }]}
        onLayout={(event) => onTabBarHeight?.(event.nativeEvent.layout.height)}
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
            const badge =
              options.tabBarBadge === undefined || options.tabBarBadge === ''
                ? null
                : Number(options.tabBarBadge) > 9
                  ? '9+'
                  : String(options.tabBarBadge);
            const onPress = () => {
              const event = navigation.emit({
                type: 'tabPress',
                target: route.key,
                canPreventDefault: true,
              });
              if (!focused && !event.defaultPrevented)
                navigation.navigate(route.name, route.params);
            };
            return (
              <Pressable
                key={route.key}
                testID={options.tabBarButtonTestID}
                accessibilityRole="tab"
                accessibilityState={{ selected: focused }}
                aria-selected={focused}
                accessibilityLabel={localize(
                  options.tabBarAccessibilityLabel ??
                    (badge ? t('{p0}, активных заказов: {p1}', { p0: label, p1: badge }) : label),
                )}
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
                <View>
                  <TabIcon name={route.name as TabName} color={color} />
                  {badge ? (
                    <View
                      testID={`${options.tabBarButtonTestID}-badge`}
                      pointerEvents="none"
                      style={s.badge}
                    >
                      <Text style={s.badgeText} maxFontSizeMultiplier={1.2} numberOfLines={1}>
                        {localize(badge)}
                      </Text>
                    </View>
                  ) : null}
                </View>
                <Text
                  numberOfLines={1}
                  maxFontSizeMultiplier={tabLabelMaxScale}
                  // iOS: the longest label (kk «Тапсырыстар») shrinks instead of truncating at
                  // 320 pt with the largest supported text size.
                  adjustsFontSizeToFit
                  minimumFontScale={tabLabelMinFit}
                  style={[s.label, { color }, focused && s.labelActive]}
                >
                  {localize(label)}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  // The tab layer: the docked cart bar, then the tab capsule, stacked from the bottom inset up.
  host: { position: 'absolute', left: 0, right: 0, alignItems: 'stretch' },
  barRow: { alignItems: 'center' },
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
    fontSize: tabLabelSize,
    lineHeight: 16,
    includeFontPadding: false,
    textAlign: 'center',
  },
  labelActive: { fontFamily: font.bold },
  // Active-order counter on «Заказы»: brand orange with dark ink, like primary buttons.
  badge: {
    position: 'absolute',
    top: -6,
    left: 13,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    paddingHorizontal: 4,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accent,
  },
  badgeText: {
    fontFamily: font.bold,
    fontSize: 11,
    lineHeight: 14,
    color: colors.orangeInk,
    includeFontPadding: false,
    textAlign: 'center',
  },
});
