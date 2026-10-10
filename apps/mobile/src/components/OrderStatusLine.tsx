import { StyleSheet, Text, View } from 'react-native';
import { MotionPressable } from './Motion';
import { Icon, type IconName } from './UI';
import { colors, font } from '../theme';
import { lumaPalette, orderStatusLine } from '../luma-patterns';
import type { OrderStatusData } from '../order-status';

const toneColor = {
  success: '#7FE0B4',
  active: colors.accentText,
  ready: '#7FE0B4',
  muted: colors.muted,
} as const;

/** «✓ Заказ принят · № 342»: one line with an icon that follows the server state. */
export function OrderStatusLine({ order }: { order: OrderStatusData }) {
  const line = orderStatusLine(order);
  return (
    <View
      testID="order-status-line"
      accessible
      accessibilityLabel={line.accessibilityLabel}
      style={s.line}
    >
      <Icon name={line.icon as IconName} size={20} color={toneColor[line.tone]} />
      {/* One text run: «· № 342» stays glued to the last word when the line wraps. */}
      <Text style={s.label} maxFontSizeMultiplier={1.6}>
        {line.label}
        {order.number ? (
          <>
            <Text style={s.dot}>{'\u00A0·\u00A0'}</Text>
            <Text testID="connected-order-number">
              №{'\u00A0'}
              {order.number}
            </Text>
          </>
        ) : null}
      </Text>
    </View>
  );
}

export type OrderAction = {
  key: string;
  label: string;
  accessibilityLabel?: string;
  icon: IconName;
  onPress(): void;
  testID?: string;
};

/** Up to three actions: the first is primary-light, the rest translucent. */
export function OrderActionRow({ actions }: { actions: OrderAction[] }) {
  if (!actions.length) return null;
  return (
    <View testID="order-action-row" style={s.row}>
      {actions.map((action, index) => {
        const primary = index === 0;
        return (
          <MotionPressable
            key={action.key}
            feedback="scale"
            testID={action.testID}
            accessibilityRole="button"
            accessibilityLabel={action.accessibilityLabel ?? action.label}
            onPress={action.onPress}
            style={[s.action, primary ? s.primary : s.translucent]}
          >
            <Icon
              name={action.icon}
              size={22}
              color={primary ? lumaPalette.lightInk : colors.text}
            />
            <Text
              numberOfLines={1}
              maxFontSizeMultiplier={1.3}
              style={[s.actionText, { color: primary ? lumaPalette.lightInk : colors.text }]}
            >
              {action.label}
            </Text>
          </MotionPressable>
        );
      })}
    </View>
  );
}
const s = StyleSheet.create({
  line: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    maxWidth: '100%',
    minHeight: 44,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 22,
    backgroundColor: colors.surface,
  },
  label: {
    flexShrink: 1,
    textAlign: 'center',
    fontFamily: font.bold,
    fontSize: 16,
    lineHeight: 22,
    color: colors.text,
  },
  dot: { color: colors.muted },
  row: { flexDirection: 'row', gap: 10, width: '100%', maxWidth: 420 },
  action: {
    flex: 1,
    minHeight: 64,
    minWidth: 0,
    paddingVertical: 10,
    paddingHorizontal: 6,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  primary: { backgroundColor: lumaPalette.light },
  translucent: {
    backgroundColor: lumaPalette.translucent,
    borderWidth: 1,
    borderColor: lumaPalette.translucentBorder,
  },
  actionText: { fontFamily: font.bold, fontSize: 13, lineHeight: 18 },
});
