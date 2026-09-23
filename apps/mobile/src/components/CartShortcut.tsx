import { MotionPressable as Pressable } from './Motion';
import { StyleSheet } from 'react-native';
import { cartTotal } from '../domain';
import type { MobileModel } from '../model';
import { colors, font } from '../theme';
import { Body, BottomActions, MinorMoney, styles as ui } from './UI';

// The source mockup keeps this pill above the tabs on every main screen.
export function CartShortcut({
  model,
  onPress,
  safeArea = false,
  floating = false,
}: {
  model: MobileModel;
  onPress: () => void;
  safeArea?: boolean;
  floating?: boolean;
}) {
  const count = model.cart.reduce((sum, line) => sum + line.quantity, 0);
  if (!count) return null;
  const total = cartTotal(model.cart);
  return (
    <BottomActions
      safeArea={safeArea}
      pointerEvents={floating ? 'box-none' : 'auto'}
      style={[
        { paddingTop: 10, borderTopWidth: 0 },
        floating && {
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          backgroundColor: 'transparent',
        },
      ]}
    >
      <Pressable
        testID="open-cart"
        accessibilityRole="button"
        accessibilityLabel={`Корзина, ${count} позиций, ${MinorMoney(total)}`}
        onPress={onPress}
        style={({ pressed }) => [s.pill, pressed && ui.pressed]}
      >
        <Body style={{ fontFamily: font.heading, fontSize: 16 }}>Корзина · {count}</Body>
        <Body style={[ui.flex, { textAlign: 'right', fontFamily: font.display, fontSize: 18 }]}>
          {MinorMoney(total)}
        </Body>
      </Pressable>
    </BottomActions>
  );
}
const s = StyleSheet.create({
  pill: {
    minHeight: 54,
    borderRadius: 27,
    backgroundColor: colors.action,
    paddingVertical: 12,
    paddingHorizontal: 20,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    shadowColor: '#000000',
    shadowOpacity: 0.25,
    shadowOffset: { width: 0, height: 5 },
    shadowRadius: 14,
    elevation: 5,
  },
});
