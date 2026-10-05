import { MotionPressable as Pressable, MotionModal as Modal } from './Motion';
import { Image } from 'expo-image';
import { assets } from '../assets';
import { orderSimulatorEnabled } from '../order-simulator';
import { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { MobileModel } from '../model';
import { paymentNames, type CommercePaymentMethod } from '../payment-methods';
import { Body, Caption, Heading, Icon, CloseButton, Row, styles as ui } from './UI';
import { colors, font } from '../theme';

export function paymentName(method: CommercePaymentMethod) {
  return paymentNames[method];
}
export function PaymentMark({
  method,
  size = 34,
}: {
  method: CommercePaymentMethod;
  size?: number;
}) {
  return method === 'kaspi' ? (
    <Image
      source={assets.kaspi}
      accessibilityLabel="Kaspi"
      testID="kaspi-logo"
      contentFit="contain"
      style={{ width: size, height: size, borderRadius: size * 0.3, backgroundColor: '#FFFFFF' }}
    />
  ) : (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.3,
        backgroundColor: colors.action,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Icon name="card-outline" size={size * 0.6} color={colors.white} />
    </View>
  );
}
export function PaymentChoice({
  model,
  methods = ['kaspi', 'card'],
  selected = model.paymentMethod,
  onSelect,
  disabled = false,
}: {
  model: MobileModel;
  methods?: readonly CommercePaymentMethod[];
  selected?: CommercePaymentMethod;
  onSelect?(method: CommercePaymentMethod): void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const insets = useSafeAreaInsets();
  return (
    <>
      <Pressable
        testID="payment-method"
        accessibilityRole="button"
        accessibilityLabel={`Способ оплаты: ${paymentName(selected)}, изменить`}
        disabled={disabled || methods.length === 0}
        accessibilityState={{ disabled: disabled || methods.length === 0 }}
        onPress={() => setOpen(true)}
        style={s.trigger}
      >
        <Caption style={{ fontSize: 11, lineHeight: 16 }}>Способ оплаты</Caption>
        <Row style={{ gap: 7 }}>
          <PaymentMark method={selected} size={22} />
          <Body style={{ fontFamily: font.bold, fontSize: 14, lineHeight: 21 }}>
            {paymentName(selected)}
          </Body>
          <Icon name="chevron-up" size={16} />
        </Row>
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <View style={s.modal}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Закрыть способы оплаты"
            style={StyleSheet.absoluteFill}
            onPress={() => setOpen(false)}
          />
          <View accessibilityViewIsModal style={s.sheet}>
            <ScrollView
              contentContainerStyle={{
                padding: 18,
                gap: 12,
                paddingBottom: Math.max(insets.bottom, 18),
              }}
            >
              <Row>
                <CloseButton label="Закрыть способы оплаты" onPress={() => setOpen(false)} />
                <Heading small style={ui.flex}>
                  Способ оплаты
                </Heading>
              </Row>
              <Caption>
                {onSelect
                  ? 'Оплата подтверждается банком. Реквизиты вводятся на защищённой странице.'
                  : orderSimulatorEnabled
                    ? 'Оплата и чеки - в процессе подключения. Реквизиты не нужны.'
                    : 'Выберите удобный способ. Онлайн-оплата скоро появится.'}
              </Caption>
              {methods.map((method) => (
                <Pressable
                  key={method}
                  testID={`payment-method-${method}`}
                  accessibilityRole="radio"
                  accessibilityState={{
                    checked: selected === method,
                    selected: selected === method,
                  }}
                  onPress={() => {
                    if (onSelect) onSelect(method);
                    else if (method === 'kaspi' || method === 'card')
                      model.setPaymentMethod(method);
                    setOpen(false);
                  }}
                  style={[
                    s.option,
                    selected === method && {
                      borderColor: colors.action,
                      backgroundColor: colors.raised,
                    },
                  ]}
                >
                  <PaymentMark method={method} size={38} />
                  <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
                    <Body style={{ fontFamily: font.bold }}>{paymentName(method)}</Body>
                    <Caption>
                      {method === 'kaspi'
                        ? 'Оплата в приложении Kaspi.kz'
                        : method === 'card'
                          ? 'Оплата на защищённой странице'
                          : 'Доступность проверит платёжная страница'}
                    </Caption>
                  </View>
                  <Icon
                    name={selected === method ? 'radio-button-on' : 'radio-button-off'}
                    color={colors.accent}
                  />
                </Pressable>
              ))}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </>
  );
}
const s = StyleSheet.create({
  trigger: {
    minHeight: 54,
    paddingHorizontal: 13,
    paddingVertical: 8,
    borderRadius: 15,
    gap: 2,
    backgroundColor: colors.raised,
  },
  modal: { flex: 1, backgroundColor: '#00000088', justifyContent: 'flex-end' },
  sheet: {
    borderTopLeftRadius: 26,
    borderTopRightRadius: 26,
    maxHeight: '90%',
    backgroundColor: colors.surface,
  },
  option: {
    minHeight: 76,
    borderWidth: 2,
    borderColor: colors.border,
    borderRadius: 18,
    padding: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
});
