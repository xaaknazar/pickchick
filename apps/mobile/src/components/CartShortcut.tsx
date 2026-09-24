import { useCallback, useRef } from 'react';
import { useFocusEffect } from 'expo-router';
import { Image } from 'expo-image';
import {
  Animated,
  AppState,
  Easing,
  Platform,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import { MotionPressable as Pressable, useReducedMotion } from './Motion';
import { assets } from '../assets';
import { cartTotal } from '../domain';
import type { MobileModel } from '../model';
import { brandColors, colors, font } from '../theme';
import { Body, BottomActions, Icon, MinorMoney } from './UI';

// One transparent, measured dock shared by the four tabs and standalone menu.
export function CartShortcut({
  model,
  onPress,
  safeArea = false,
  floating = false,
  onHeightChange,
}: {
  model: MobileModel;
  onPress: () => void;
  safeArea?: boolean;
  floating?: boolean;
  onHeightChange?: (height: number) => void;
}) {
  const count = model.cart.reduce((sum, line) => sum + line.quantity, 0);
  const total = cartTotal(model.cart);
  const reduced = useReducedMotion();
  const { width, fontScale } = useWindowDimensions();
  const compact = width < 360 || fontScale > 1.25 || MinorMoney(total).length > 11;
  const nod = useRef(new Animated.Value(0)).current;
  const previousCount = useRef(0);
  useFocusEffect(
    useCallback(() => {
      const added = count > previousCount.current;
      previousCount.current = count;
      const reset = () => {
        nod.stopAnimation();
        nod.setValue(0);
      };
      reset();
      // A single greeting acknowledges a new item; no idle loop or moving tap target.
      if (added && !reduced && AppState.currentState === 'active') {
        Animated.sequence([
          Animated.timing(nod, {
            toValue: 1,
            duration: 180,
            easing: Easing.out(Easing.cubic),
            useNativeDriver: Platform.OS !== 'web',
            isInteraction: false,
          }),
          Animated.timing(nod, {
            toValue: 0,
            duration: 300,
            easing: Easing.inOut(Easing.cubic),
            useNativeDriver: Platform.OS !== 'web',
            isInteraction: false,
          }),
        ]).start();
      }
      const subscription = AppState.addEventListener('change', (state) => {
        if (state !== 'active') reset();
      });
      return () => {
        subscription.remove();
        reset();
      };
    }, [count, reduced, nod]),
  );
  if (!count) return null;
  return (
    <BottomActions
      safeArea={safeArea}
      pointerEvents="box-none"
      onLayout={(event) => onHeightChange?.(Math.ceil(event.nativeEvent.layout.height))}
      style={[s.dock, floating && s.floating]}
    >
      <Pressable
        testID="open-cart"
        accessibilityRole="button"
        accessibilityLabel={`Корзина, ${count} позиций, ${MinorMoney(total)}`}
        accessibilityHint="Открыть состав заказа"
        onPress={onPress}
        style={s.pill}
      >
        <View
          pointerEvents="none"
          accessible={false}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={s.mascotFrame}
        >
          <Animated.View
            testID="cart-mascot"
            style={{
              transform: [
                { translateY: nod.interpolate({ inputRange: [0, 1], outputRange: [0, -3] }) },
                {
                  rotate: nod.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '-10deg'] }),
                },
              ],
            }}
          >
            <Image
              source={assets.pickManChick}
              contentFit="contain"
              cachePolicy="memory-disk"
              style={s.mascot}
            />
          </Animated.View>
        </View>
        <View style={[s.content, compact && s.contentCompact]}>
          <View style={s.labelRow}>
            <Body style={s.label}>Корзина</Body>
            <View style={s.count}>
              <Body testID="cart-count" style={s.countText}>
                {count}
              </Body>
            </View>
          </View>
          <Body testID="cart-total" style={[s.total, compact && s.totalCompact]}>
            {MinorMoney(total)}
          </Body>
        </View>
        <View
          pointerEvents="none"
          accessible={false}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          <Icon name="arrow-forward" size={20} color={colors.white} />
        </View>
      </Pressable>
    </BottomActions>
  );
}
const s = StyleSheet.create({
  dock: { paddingTop: 10, borderTopWidth: 0, backgroundColor: 'transparent' },
  floating: { position: 'absolute', bottom: 0, left: 0, right: 0 },
  pill: {
    minHeight: 64,
    borderRadius: 28,
    backgroundColor: brandColors.brandBlue,
    paddingVertical: 10,
    paddingLeft: 10,
    paddingRight: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    shadowColor: colors.background,
    shadowOpacity: 0.3,
    shadowOffset: { width: 0, height: 5 },
    shadowRadius: 12,
    elevation: 5,
  },
  mascotFrame: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.background,
    overflow: 'hidden',
    flexShrink: 0,
  },
  mascot: { width: 44, height: 44 },
  content: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  contentCompact: { flexDirection: 'column', alignItems: 'flex-start', gap: 0 },
  labelRow: { flexDirection: 'row', alignItems: 'center', flexShrink: 1, flexWrap: 'wrap', gap: 6 },
  label: { fontFamily: font.heading, fontSize: 16, lineHeight: 23, color: colors.white },
  count: {
    minWidth: 24,
    borderRadius: 12,
    paddingHorizontal: 6,
    backgroundColor: brandColors.brandOrange,
    alignItems: 'center',
  },
  countText: { fontFamily: font.bold, fontSize: 12, lineHeight: 22, color: colors.orangeInk },
  total: {
    fontFamily: font.display,
    fontSize: 18,
    lineHeight: 25,
    color: colors.white,
    flexShrink: 1,
    textAlign: 'right',
    fontVariant: ['tabular-nums'],
  },
  totalCompact: { textAlign: 'left' },
});
