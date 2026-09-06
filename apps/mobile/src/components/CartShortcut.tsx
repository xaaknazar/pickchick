import { Pressable, StyleSheet } from 'react-native';
import type { MobileModel } from '../model';
import { colors, font } from '../theme';
import { Body, BottomActions, MinorMoney, styles as ui } from './UI';

// The source mockup keeps this pill above the tabs on every main screen.
export function CartShortcut({
  model,
  onPress,
  safeArea = false,
}: {
  model: MobileModel;
  onPress: () => void;
  safeArea?: boolean;
}) {
  const count = model.cart.reduce((sum, line) => sum + line.quantity, 0);
  if (!count) return null;
  const total = model.cart.reduce(
    (sum, line) => sum + BigInt(line.product.priceMinor) * BigInt(line.quantity),
    0n,
  );
  return (
    <BottomActions safeArea={safeArea} style={{ paddingTop: 10, borderTopWidth: 0 }}>
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
