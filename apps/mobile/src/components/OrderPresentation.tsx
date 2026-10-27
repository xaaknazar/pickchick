import { t, localize, useLocale } from '../i18n';
import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { Body, CloseButton, Heading, IconButton, Row } from './UI';
import { font } from '../theme';

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
  useLocale();
  return (
    <Row style={orderUI.header}>
      <View style={orderUI.headerSide}>
        {back ? (
          <IconButton
            name="chevron-back"
            label={t('Вернуться в корзину')}
            testID={testID}
            onPress={onClose}
          />
        ) : (
          <CloseButton label={t('Закрыть корзину')} testID={testID} onPress={onClose} />
        )}
      </View>
      <Heading small style={orderUI.headerTitle}>
        {localize(title)}
      </Heading>
      <View style={orderUI.headerSide}>{action}</View>
    </Row>
  );
}

export function OrderTotal({ value }: { value: string }) {
  useLocale();
  return (
    <Row style={orderUI.total}>
      <Body style={orderUI.label}>{t('Итого')}</Body>
      <Body style={[orderUI.amount, { fontSize: 24, lineHeight: 32 }]}>{localize(value)}</Body>
    </Row>
  );
}
