import { Text } from './LocalizedText';
import { localize, t, useLocale } from '../i18n';
import { designPreview } from '../store-build';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Keyboard, Platform, Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';
import type { BottomTabBarProps } from 'expo-router/tabs';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, {
  interpolateColor,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  type SharedValue,
} from 'react-native-reanimated';
import { TabIcon } from './UI';
import { TabCartDock } from './TabCartDock';
import { useReducedMotion } from './Motion';
import { TabBarGlass } from './GlassButton';
import { colors, font } from '../theme';
import { haptic } from '../haptics';
import {
  tabAt,
  tabBarMetrics,
  tabBarPalette as palette,
  tabLabelMaxScale,
  tabLabelMinFit,
  tabLabelSize,
  tabLensSpring,
  tabPlatterScale,
  tabSelection,
  tabSelectionSpring,
} from '../tab-bar-metrics';

// Owner 27.10.2026: three tabs; the profile opens from the top header.
type TabName = 'menu' | 'events' | 'orders';

export {
  TabBarInsetContext,
  TabCartDockContext,
  useTabBarInset,
  useTabCartDockHeight,
} from './tab-bar-inset';

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

/**
 * The selection platter (iOS 26 tab bar): one light shape that flows between the tabs on the UI
 * thread, stretching like a drop mid-way, and swells into a brighter lens with a rim while the
 * finger holds or drags it. It never waits for the new tab screen to render.
 */
function SelectionPlatter({
  position,
  lens,
  width,
  height,
  testID,
}: {
  position: SharedValue<number>;
  lens: SharedValue<number>;
  width: number;
  height: number;
  testID: string;
}) {
  const style = useAnimatedStyle(() => {
    const scale = tabPlatterScale(position.value, lens.value);
    return {
      transform: [{ translateX: position.value * width }, { scaleX: scale.x }, { scaleY: scale.y }],
      backgroundColor: interpolateColor(lens.value, [0, 1], [palette.pill, palette.lens]),
      borderColor: interpolateColor(lens.value, [0, 1], ['rgba(255,255,255,0)', palette.lensRim]),
    };
  });
  return (
    <Animated.View
      testID={testID}
      pointerEvents="none"
      accessible={false}
      style={[s.platter, { width, height }, style]}
    />
  );
}

function TabItem({
  route,
  index,
  position,
  lens,
  focused,
  label,
  badge,
  testID,
  accessibilityLabel,
  minHeight,
  onPressIn,
  onPressOut,
  onPress,
  onLongPress,
}: {
  route: TabName;
  index: number;
  position: SharedValue<number>;
  lens: SharedValue<number>;
  focused: boolean;
  label: string;
  badge: string | null;
  testID?: string;
  accessibilityLabel: string;
  minHeight: number;
  onPressIn(): void;
  onPressOut(): void;
  onPress(): void;
  onLongPress(): void;
}) {
  // Icon and label colour follow the platter frame by frame (no React render, no image reload):
  // the inactive glyph stays, the orange one fades in over it.
  const activeIcon = useAnimatedStyle(() => ({ opacity: tabSelection(position.value, index) }));
  const icon = useAnimatedStyle(() => {
    const swell = 1 + 0.1 * lens.value * tabSelection(position.value, index);
    return { transform: [{ scale: swell }] };
  });
  const text = useAnimatedStyle(() => ({
    color: interpolateColor(
      tabSelection(position.value, index),
      [0, 1],
      [palette.inactive, palette.active],
    ),
  }));
  return (
    <Pressable
      testID={testID}
      accessibilityRole="tab"
      accessibilityState={{ selected: focused }}
      aria-selected={focused}
      accessibilityLabel={accessibilityLabel}
      onPressIn={onPressIn}
      onPressOut={onPressOut}
      onPress={onPress}
      onLongPress={onLongPress}
      style={[s.item, { minHeight }]}
    >
      <Animated.View style={icon}>
        <TabIcon name={route} color={palette.inactive} />
        <Animated.View style={[StyleSheet.absoluteFill, activeIcon]}>
          <TabIcon name={route} color={palette.active} />
        </Animated.View>
        {badge ? (
          <View testID={`${testID}-badge`} pointerEvents="none" style={s.badge}>
            <Text style={s.badgeText} maxFontSizeMultiplier={1.2} numberOfLines={1}>
              {localize(badge)}
            </Text>
          </View>
        ) : null}
      </Animated.View>
      <Animated.Text
        numberOfLines={1}
        maxFontSizeMultiplier={tabLabelMaxScale}
        // iOS: the longest label (kk «Тапсырыстар») shrinks instead of truncating at
        // 320 pt with the largest supported text size.
        adjustsFontSizeToFit
        minimumFontScale={tabLabelMinFit}
        style={[s.label, text]}
      >
        {localize(label)}
      </Animated.Text>
    </Pressable>
  );
}

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
  const reduced = useReducedMotion();
  const keyboardVisible = useKeyboardVisible();
  const metrics = tabBarMetrics(insets, fontScale);
  const params = state.routes[state.index]?.params as { preview?: unknown } | undefined;
  // The cart's item count the customer last saw on the docked bar. Kept here, not in the bar: the
  // bar unmounts under a sheet and under the keyboard, and a remount is not «an item was added».
  const seenCartCount = useRef(0);
  const count = state.routes.length;
  const [rowWidth, setRowWidth] = useState(0);
  const itemWidth = rowWidth > 0 ? rowWidth / count : 0;
  // The platter's place as a tab index (fractional while it moves) and the lens (0..1).
  const position = useSharedValue(state.index);
  const lens = useSharedValue(0);
  // Where the platter is heading; the navigation state catches up after the screen renders.
  const target = useRef(state.index);
  const dragging = useSharedValue(false);
  const selectedIndex = useRef(state.index);
  selectedIndex.current = state.index;
  // Set when a press ends in a tab press; a press that ends otherwise returns the platter.
  const committed = useRef(false);

  const moveTo = useCallback(
    (index: number) => {
      target.current = index;
      position.value = reduced ? index : withSpring(index, tabSelectionSpring);
    },
    [position, reduced],
  );
  const raiseLens = useCallback(
    (on: boolean) => {
      lens.value = reduced ? 0 : withSpring(on ? 1 : 0, tabLensSpring);
    },
    [lens, reduced],
  );

  // The selected tab changed elsewhere (a link, a gate sent the press away, the first render):
  // the platter follows it.
  useEffect(() => {
    if (target.current !== state.index && !dragging.value) moveTo(state.index);
  }, [state.index, moveTo, dragging]);

  const select = useCallback(
    (index: number) => {
      committed.current = true;
      const route = state.routes[index];
      if (!route) return;
      const focused = state.index === index;
      const event = navigation.emit({
        type: 'tabPress',
        target: route.key,
        canPreventDefault: true,
      });
      if (event.defaultPrevented) {
        // An account gate took the press (sign-in opens): the platter returns.
        moveTo(state.index);
        return;
      }
      if (!focused) navigation.navigate(route.name, route.params);
    },
    [moveTo, navigation, state.index, state.routes],
  );

  // Press and drag along the capsule, as on iOS 26: the lens follows the finger, ticks on each
  // tab it crosses and settles on the tab under the finger when released.
  const lastTick = useSharedValue(-1);
  const pan = Gesture.Pan()
    .activeOffsetX([-10, 10])
    .failOffsetY([-24, 24])
    .enabled(itemWidth > 0)
    .onStart((event) => {
      dragging.value = true;
      lens.value = reduced ? 0 : withSpring(1, tabLensSpring);
      lastTick.value = tabAt(event.x, itemWidth, count);
    })
    .onUpdate((event) => {
      const free = Math.min(count - 1, Math.max(0, event.x / itemWidth - 0.5));
      position.value = free;
      const over = tabAt(event.x, itemWidth, count);
      if (over !== lastTick.value) {
        lastTick.value = over;
        runOnJS(haptic)('tick');
      }
    })
    .onFinalize((event, success) => {
      if (!dragging.value) return;
      dragging.value = false;
      lens.value = reduced ? 0 : withSpring(0, tabLensSpring);
      const index = success ? tabAt(event.x, itemWidth, count) : Math.round(position.value);
      runOnJS(moveTo)(index);
      runOnJS(select)(index);
    });

  const activeRoute = state.routes[state.index];
  // The keyboard hides the tab bar and the cart bar docked on it together.
  if (keyboardVisible) return null;
  // One layer above every tab screen (owner 28.10.2026): the cart bar (quick pay) is laid out
  // right on top of the tab capsule, so it can never slip under the tabs, whatever the tab bar's
  // real height, the safe area or a screen's frame (TabCartDock).
  return (
    <View pointerEvents="box-none" style={[s.host, { bottom: metrics.bottom }]}>
      <TabCartDock
        preview={designPreview(params?.preview)}
        resume={state.routes[state.index]?.name === 'menu'}
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
          style={[s.bar, { maxWidth: metrics.maxWidth, padding: metrics.padding }]}
        >
          <TabBarGlass radius={metrics.height / 2} />
          <GestureHandlerRootView style={s.items}>
            <GestureDetector gesture={pan}>
              <View
                style={s.items}
                onLayout={(event) => setRowWidth(event.nativeEvent.layout.width)}
              >
                {activeRoute && itemWidth > 0 ? (
                  <SelectionPlatter
                    position={position}
                    lens={lens}
                    width={itemWidth}
                    height={metrics.itemHeight}
                    testID={`${descriptors[activeRoute.key]?.options.tabBarButtonTestID}-pill`}
                  />
                ) : null}
                {state.routes.map((route, index) => {
                  const options = descriptors[route.key]?.options ?? {};
                  const label = typeof options.title === 'string' ? options.title : route.name;
                  const badge =
                    options.tabBarBadge === undefined || options.tabBarBadge === ''
                      ? null
                      : Number(options.tabBarBadge) > 9
                        ? '9+'
                        : String(options.tabBarBadge);
                  return (
                    <TabItem
                      key={route.key}
                      route={route.name as TabName}
                      index={index}
                      position={position}
                      lens={lens}
                      focused={state.index === index}
                      label={label}
                      badge={badge}
                      testID={options.tabBarButtonTestID}
                      accessibilityLabel={localize(
                        options.tabBarAccessibilityLabel ??
                          (badge
                            ? t('{p0}, активных заказов: {p1}', { p0: label, p1: badge })
                            : label),
                      )}
                      minHeight={metrics.itemHeight}
                      // The platter starts on touch down and swells into the lens; the screen
                      // switches on release. A slide off the tab without a drag returns it.
                      onPressIn={() => {
                        committed.current = false;
                        raiseLens(true);
                        moveTo(index);
                      }}
                      onPressOut={() => {
                        raiseLens(false);
                        setTimeout(() => {
                          if (!committed.current && !dragging.value) moveTo(selectedIndex.current);
                        }, 0);
                      }}
                      onPress={() => select(index)}
                      onLongPress={() =>
                        navigation.emit({ type: 'tabLongPress', target: route.key })
                      }
                    />
                  );
                })}
              </View>
            </GestureDetector>
          </GestureHandlerRootView>
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
  clip: { overflow: 'hidden' },
  items: { flex: 1, flexDirection: 'row' },
  platter: {
    position: 'absolute',
    left: 0,
    top: 0,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth * 2,
  },
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
  label: {
    fontFamily: font.medium,
    fontSize: tabLabelSize,
    lineHeight: 16,
    includeFontPadding: false,
    textAlign: 'center',
  },
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
