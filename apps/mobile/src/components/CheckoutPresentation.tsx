import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { MotionPressable } from './Motion';
import { Body, Caption, CloseButton, Heading, Icon, IconButton, Row } from './UI';
import { PaymentMark } from './PaymentChoice';
import { colors, font } from '../theme';

/** Layout from the supplied cart/checkout mockup; values always come from the order. */
export function CheckoutSheetHeader({
  title,
  subtitle,
  onBack,
  testID,
  back,
  action,
}: {
  title: string;
  subtitle?: string;
  onBack(): void;
  testID: string;
  back?: boolean;
  action?: ReactNode;
}) {
  return (
    <View style={checkoutStyle.header}>
      <Row style={checkoutStyle.controls}>
        {back ? (
          <IconButton
            name="chevron-back"
            label="Вернуться в корзину"
            onPress={onBack}
            testID={testID}
            style={checkoutStyle.control}
          />
        ) : (
          <CloseButton label="Закрыть корзину" onPress={onBack} testID={testID} />
        )}
        {action}
      </Row>
      <Row style={checkoutStyle.titleRow}>
        <Heading style={checkoutStyle.title}>{title}</Heading>
        {subtitle ? <Caption style={checkoutStyle.branch}>{subtitle}</Caption> : null}
      </Row>
    </View>
  );
}
export function CheckoutAction({
  title,
  amount,
  onPress,
  disabled,
  testID,
  kaspi,
}: {
  title: string;
  amount?: string;
  onPress(): void;
  disabled?: boolean;
  testID: string;
  kaspi?: boolean;
}) {
  return (
    <MotionPressable
      accessibilityRole="button"
      accessibilityLabel={`${title}${amount ? `, ${amount}` : ''}${kaspi ? ' Kaspi' : ''}`}
      accessibilityState={{ disabled }}
      disabled={disabled}
      testID={testID}
      onPress={onPress}
      style={[checkoutStyle.action, disabled && { opacity: 0.45 }]}
    >
      <Body style={checkoutStyle.actionText}>{title}</Body>
      {kaspi ? (
        <View style={checkoutStyle.kaspiWord}>
          <PaymentMark method="kaspi" size={26} />
          <Body style={checkoutStyle.actionText}>Kaspi</Body>
        </View>
      ) : null}
      {amount ? (
        <Body style={[checkoutStyle.actionText, { marginLeft: 'auto' }]}>{amount}</Body>
      ) : null}
    </MotionPressable>
  );
}
export function UpcomingPayments() {
  return (
    <>
      {(['Apple Pay', 'Банковская карта'] as const).map((label, i) => (
        <View
          key={label}
          testID={i ? 'checkout-add-card' : 'checkout-apple-pay'}
          style={checkoutStyle.upcoming}
          accessible
          accessibilityRole="button"
          aria-disabled
          accessibilityLabel={`${label}, скоро`}
          accessibilityState={{ disabled: true }}
        >
          <View style={checkoutStyle.methodIcon}>
            <Icon name={i ? 'card-outline' : 'logo-apple'} size={21} color="#899BBC" />
          </View>
          <Body style={checkoutStyle.upcomingName}>{label}</Body>
          <Caption style={checkoutStyle.soon}>СКОРО</Caption>
        </View>
      ))}
    </>
  );
}
export const checkoutStyle = StyleSheet.create({
  content: { paddingHorizontal: 16, gap: 10 },
  header: { paddingHorizontal: 16, paddingBottom: 18, gap: 12 },
  controls: { justifyContent: 'space-between' },
  control: {
    backgroundColor: '#FFFFFF14',
    borderWidth: 1,
    borderColor: '#FFFFFF1F',
    borderRadius: 24,
  },
  titleRow: { paddingHorizontal: 8, alignItems: 'baseline', flexWrap: 'wrap', gap: 6 },
  title: { fontFamily: font.display, fontSize: 32, lineHeight: 38, letterSpacing: -0.6 },
  branch: { flexShrink: 1, marginLeft: 'auto', fontSize: 14, lineHeight: 20, color: '#A3B4D6' },
  cartFooter: { paddingHorizontal: 16, paddingTop: 12, borderTopWidth: 0 },
  footer: {
    backgroundColor: '#0B2255',
    borderTopLeftRadius: 30,
    borderTopRightRadius: 30,
    padding: 16,
    borderTopColor: '#FFFFFF12',
  },
  action: {
    minHeight: 60,
    paddingVertical: 14,
    paddingHorizontal: 22,
    borderRadius: 30,
    backgroundColor: colors.accent,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    flexWrap: 'wrap',
  },
  actionText: { fontFamily: font.heading, fontSize: 18, lineHeight: 26, color: colors.orangeInk },
  kaspiWord: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  paymentPanel: {
    borderRadius: 22,
    overflow: 'hidden',
    backgroundColor: '#0B2255',
    borderWidth: 1,
    borderColor: '#FFFFFF0F',
  },
  upcoming: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: '#FFFFFF0A',
  },
  methodIcon: {
    width: 36,
    height: 36,
    borderRadius: 11,
    backgroundColor: '#FFFFFF08',
    alignItems: 'center',
    justifyContent: 'center',
  },
  upcomingName: { flex: 1, fontSize: 15, lineHeight: 21, color: '#899BBC' },
  soon: {
    fontSize: 11,
    lineHeight: 16,
    color: '#A3B4D6',
    backgroundColor: '#FFFFFF0A',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
  },
});
