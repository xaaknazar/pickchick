import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { Body, Heading, IconButton, Row } from './UI';
import { colors, font } from '../theme';

/** Scoped to the cart/checkout sheets; storefront display typography stays intact. */
export const orderUI = StyleSheet.create({
  title: { fontFamily: font.heading, fontSize: 24, lineHeight: 32, letterSpacing: -0.3 },
  section: { fontFamily: font.bold, fontSize: 18, lineHeight: 26, letterSpacing: 0 },
  label: { fontFamily: font.medium, fontSize: 16, lineHeight: 24, letterSpacing: 0 },
  detail: { fontFamily: font.body, fontSize: 14, lineHeight: 21 },
  amount: { fontFamily: font.bold, fontSize: 20, lineHeight: 28, fontVariant: ['tabular-nums'] },
  actionText: { fontFamily: font.bold, fontSize: 16, lineHeight: 24 },
  action: { borderRadius: 28, minHeight: 56 },
  header: { paddingHorizontal: 16, paddingBottom: 12, gap: 8 },
  headerTitle: {
    flex: 1,
    textAlign: 'center',
    fontFamily: font.heading,
    fontSize: 22,
    lineHeight: 30,
    letterSpacing: -0.2,
  },
  headerSide: { width: 48, alignItems: 'center' },
  headerButton: { backgroundColor: colors.surface },
  total: { justifyContent: 'space-between', flexWrap: 'wrap', paddingVertical: 4, gap: 8 },
});

export function OrderHeader({
  title,
  onClose,
  testID,
  back = false,
  action,
}: {
  title: string;
  onClose(): void;
  testID: string;
  back?: boolean;
  action?: ReactNode;
}) {
  return (
    <Row style={orderUI.header}>
      <View style={orderUI.headerSide}>
        <IconButton
          name={back ? 'chevron-back' : 'close'}
          label={back ? 'Вернуться в корзину' : 'Закрыть корзину'}
          testID={testID}
          onPress={onClose}
          style={orderUI.headerButton}
        />
      </View>
      <Heading small style={orderUI.headerTitle}>
        {title}
      </Heading>
      <View style={orderUI.headerSide}>{action}</View>
    </Row>
  );
}

export function OrderTotal({ value }: { value: string }) {
  return (
    <Row style={orderUI.total}>
      <Body style={orderUI.label}>Итого</Body>
      <Body style={[orderUI.amount, { fontSize: 24, lineHeight: 32 }]}>{value}</Body>
    </Row>
  );
}
