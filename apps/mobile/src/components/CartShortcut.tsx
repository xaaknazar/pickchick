import { useCallback, useRef } from 'react';
import { useFocusEffect } from 'expo-router';
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
  const { fontScale } = useWindowDimensions();
  const compact = fontScale > 1.25 || MinorMoney(total).length > 11;
  const feedback = useRef(new Animated.Value(0)).current;
  const previousCount = useRef(0);
  useFocusEffect(
    useCallback(() => {
      const added = count > previousCount.current;
      previousCount.current = count;
      const reset = () => {
        feedback.stopAnimation();
        feedback.setValue(0);
      };
      reset();
      // Option 1: only the quantity responds; the tap target and amount stay still.
      if (added && !reduced && AppState.currentState === 'active') {
        Animated.sequence([
          Animated.timing(feedback, {
            toValue: 1,
            duration: 160,
            easing: Easing.out(Easing.cubic),
            useNativeDriver: Platform.OS !== 'web',
            isInteraction: false,
          }),
          Animated.timing(feedback, {
            toValue: 0,
            duration: 240,
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
    }, [count, reduced, feedback]),
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
          style={s.bag}
        >
          <Icon name="bag-handle-outline" size={20} color={colors.orangeInk} />
        </View>
        <View style={[s.content, compact && s.contentCompact]}>
          <View style={s.labelRow}>
            <Body style={s.label}>Корзина</Body>
            <Animated.View
              testID="cart-count-feedback"
              style={[
                s.count,
                {
                  transform: [
                    { scale: feedback.interpolate({ inputRange: [0, 1], outputRange: [1, 1.22] }) },
                  ],
                },
              ]}
            >
              <Body testID="cart-count" style={s.countText}>
                {count}
              </Body>
            </Animated.View>
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
    minHeight: 58,
    borderRadius: 22,
    backgroundColor: brandColors.brandBlue,
    paddingVertical: 12,
    paddingLeft: 16,
    paddingRight: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    shadowColor: colors.background,
    shadowOpacity: 0.3,
    shadowOffset: { width: 0, height: 5 },
    shadowRadius: 12,
    elevation: 5,
  },
  bag: {
    width: 32,
    height: 32,
    borderRadius: 10,
    backgroundColor: brandColors.brandOrange,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
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
  count: { minWidth: 12, alignItems: 'center', paddingHorizontal: 2 },
  countText: { fontFamily: font.bold, fontSize: 12, lineHeight: 22, color: colors.text },
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
