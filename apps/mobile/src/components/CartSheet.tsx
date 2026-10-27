import { localize, t, useLocale } from '../i18n';
import { useState, type ReactNode } from 'react';
import {
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { DiningMode, MobileModel } from '../model';
import { KASPI_PAY, brandSlotParts, cartPaymentMethods, cartPayTitle } from '../cart-payment';
import { MotionModal, MotionPressable } from './Motion';
import { PaymentMark } from './PaymentChoice';
import { Body, Caption, CloseButton, Heading, Icon, IconButton, type IconName } from './UI';
import { colors, font } from '../theme';

/**
 * Cart sheet, owner 27.10.2026 (Drinkit reference): red glass trash on the left, glass close
 * on the right, the restaurant point with a pin in the centre. No big «Корзина» title: the
 * sheet keeps its name for accessibility.
 */
export function CartTopBar({
  restaurant,
  onClose,
  onClear,
  clearDisabled,
}: {
  restaurant?: string;
  onClose(): void;
  onClear(): void;
  clearDisabled: boolean;
}) {
  useLocale();
  const name = localize(restaurant ?? 'Ресторан PickChick');
  return (
    <View style={s.topBar}>
      <IconButton
        name="trash-outline"
        tone="danger"
        label={t('Очистить корзину')}
        testID="cart-clear"
        disabled={clearDisabled}
        onPress={onClear}
      />
      <View
        testID="cart-restaurant"
        style={s.point}
        accessible
        accessibilityLabel={localize(t('Заказ в ресторане {p0}', { p0: name }))}
      >
        <Icon name="location-sharp" size={20} color={colors.accent} />
        <Text style={s.pointName} numberOfLines={1} maxFontSizeMultiplier={1.4}>
          {name}
        </Text>
      </View>
      <CloseButton label={t('Закрыть корзину')} onPress={onClose} testID="cart-close" />
    </View>
  );
}

const diningModes: { mode: DiningMode; label: string; icon: IconName }[] = [
  { mode: 'dine_in', label: 'В зале', icon: 'restaurant-outline' },
  { mode: 'takeaway', label: 'С собой', icon: 'bag-handle-outline' },
];

/** Where the order is served, in place of Drinkit's «приготовим за N мин». Also the switch. */
export function DiningModePill({
  value,
  onChange,
  disabled = false,
}: {
  value: DiningMode;
  onChange(mode: DiningMode): void;
  disabled?: boolean;
}) {
  useLocale();
  const { width, fontScale } = useWindowDimensions();
  // 320 pt or large text: the words need the room (Kazakh «Мейрамханада»), icons step aside.
  const icons = width >= 360 && fontScale <= 1.3;
  return (
    <View
      testID="cart-dining-mode"
      style={s.pill}
      accessibilityRole="radiogroup"
      accessibilityLabel={t('Способ получения')}
    >
      {diningModes.map(({ mode, label, icon }) => {
        const selected = value === mode;
        return (
          <MotionPressable
            key={mode}
            testID={`cart-dining-${mode}`}
            accessibilityRole="radio"
            accessibilityLabel={localize(label)}
            aria-checked={selected}
            accessibilityState={{ selected, checked: selected, disabled }}
            disabled={disabled}
            onPress={() => onChange(mode)}
            style={[s.segment, selected && s.segmentSelected]}
          >
            {icons ? (
              <Icon name={icon} size={18} color={selected ? colors.white : colors.muted} />
            ) : null}
            <Text
              style={[s.segmentText, selected && s.segmentTextSelected]}
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.75}
              maxFontSizeMultiplier={1.6}
            >
              {localize(label)}
            </Text>
          </MotionPressable>
        );
      })}
    </View>
  );
}

/** Kitchen comment, moved from the old checkout page to the bottom of the cart. */
export function CartOrderComment({
  model,
  editable = true,
}: {
  model: Pick<MobileModel, 'orderComment' | 'setOrderComment'>;
  editable?: boolean;
}) {
  useLocale();
  const [focused, setFocused] = useState(false);
  return (
    <View style={s.comment}>
      <View style={s.commentHeading}>
        <Icon name="chatbubble-outline" size={20} color={colors.muted} />
        <Body style={s.commentLabel}>{t('Комментарий к заказу')}</Body>
      </View>
      <TextInput
        testID="checkout-comment-input"
        accessibilityLabel={t('Комментарий к заказу')}
        accessibilityHint={t('Необязательно, до 60 символов')}
        value={model.orderComment}
        onChangeText={model.setOrderComment}
        editable={editable}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        maxLength={60}
        multiline
        returnKeyType="done"
        submitBehavior="blurAndSubmit"
        onSubmitEditing={Keyboard.dismiss}
        numberOfLines={3}
        textAlignVertical="top"
        placeholder={t('Например, соус отдельно')}
        placeholderTextColor={colors.muted}
        style={[
          s.commentInput,
          focused && { borderColor: colors.accent },
          !editable && { opacity: 0.6 },
        ]}
      />
      <Caption testID="checkout-comment-count" style={s.commentCount}>
        {localize(model.orderComment.length)}/60
      </Caption>
    </View>
  );
}

function methodIcon(id: string): IconName {
  return id === 'card' ? 'card-outline' : id === 'google_pay' ? 'logo-google' : 'logo-apple';
}

/** «Способ оплаты»: Kaspi.kz is selected; wallets and cards are listed as «скоро». */
export function PaymentMethodSelector() {
  useLocale();
  const [open, setOpen] = useState(false);
  const insets = useSafeAreaInsets();
  const close = () => setOpen(false);
  return (
    <>
      <MotionPressable
        testID="cart-payment-method"
        accessibilityRole="button"
        accessibilityLabel={localize(t('Способ оплаты: {p0}, изменить', { p0: 'Kaspi.kz' }))}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(true)}
        style={s.method}
      >
        <Caption style={s.methodCaption} maxFontSizeMultiplier={1.4}>
          {t('Способ оплаты')}
        </Caption>
        <View style={s.methodRow}>
          <PaymentMark method="kaspi" size={24} />
          <Text style={s.methodName} numberOfLines={1} maxFontSizeMultiplier={1.4}>
            Kaspi.kz
          </Text>
          <Icon name="chevron-down" size={18} color={colors.muted} />
        </View>
      </MotionPressable>
      <MotionModal visible={open} transparent animationType="slide" onRequestClose={close}>
        <View style={s.modal}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('Закрыть способы оплаты')}
            style={StyleSheet.absoluteFill}
            onPress={close}
          />
          <View
            testID="cart-payment-sheet"
            role="dialog"
            aria-modal
            accessibilityViewIsModal
            accessibilityLabel={t('Способ оплаты')}
            style={[s.sheet, { paddingBottom: Math.max(insets.bottom, 18) }]}
          >
            <ScrollView contentContainerStyle={s.sheetContent} bounces={false}>
              <View style={s.sheetHeader}>
                <Heading small style={s.sheetTitle}>
                  {t('Способ оплаты')}
                </Heading>
                <CloseButton
                  label={t('Закрыть способы оплаты')}
                  testID="cart-payment-close"
                  onPress={close}
                />
              </View>
              <View accessibilityRole="radiogroup" style={s.options}>
                {cartPaymentMethods(Platform.OS).map((method) =>
                  method.available ? (
                    <MotionPressable
                      key={method.id}
                      testID={`cart-payment-${method.id}`}
                      accessibilityRole="radio"
                      accessibilityLabel={method.label}
                      aria-checked
                      accessibilityState={{ checked: true, selected: true }}
                      onPress={close}
                      style={[s.option, s.optionSelected]}
                    >
                      <PaymentMark method="kaspi" size={36} />
                      <Body style={s.optionName}>{method.label}</Body>
                      <Icon name="checkmark-circle" size={24} color={colors.accent} />
                    </MotionPressable>
                  ) : (
                    <View
                      key={method.id}
                      testID={`cart-payment-${method.id}`}
                      accessible
                      accessibilityRole="radio"
                      aria-disabled
                      aria-checked={false}
                      accessibilityState={{ disabled: true, checked: false }}
                      accessibilityLabel={localize(t('{p0}, скоро', { p0: t(method.label) }))}
                      style={[s.option, s.optionDisabled]}
                    >
                      <View style={s.optionIcon}>
                        <Icon name={methodIcon(method.id)} size={21} color="#899BBC" />
                      </View>
                      <Body style={[s.optionName, s.optionNameDisabled]}>
                        {localize(t(method.label))}
                      </Body>
                      <Text style={s.soon}>{t('СКОРО')}</Text>
                    </View>
                  ),
                )}
              </View>
            </ScrollView>
          </View>
        </View>
      </MotionModal>
    </>
  );
}

/**
 * Footer of the cart in the Kaspi build: payment method and «Итого» side by side, then the
 * white «Оплатить с Kaspi.kz» button. Pressing it runs the guarded checkout submit.
 */
export function CartPaymentFooter({
  totalMinor,
  totalText,
  busy,
  disabled,
  onPay,
  notices,
}: {
  totalMinor: string;
  totalText: string;
  busy: boolean;
  disabled: boolean;
  onPay(): void;
  notices?: ReactNode;
}) {
  useLocale();
  const title = cartPayTitle({ busy, totalMinor });
  const kaspi = title === KASPI_PAY;
  // The brand stands where the language puts it (KK: «[Kaspi.kz] арқылы төлеу»).
  const words = kaspi ? brandSlotParts(t(KASPI_PAY)) : { before: localize(t(title)), after: '' };
  return (
    <>
      {notices}
      <View style={s.summary}>
        <PaymentMethodSelector />
        <View style={s.total}>
          <Caption style={s.totalLabel} maxFontSizeMultiplier={1.4}>
            {t('Итого')}
          </Caption>
          <Text testID="cart-total" style={s.totalAmount} maxFontSizeMultiplier={1.4}>
            {localize(totalText)}
          </Text>
        </View>
      </View>
      <MotionPressable
        testID="cart-pay"
        feedback="scale"
        accessibilityRole="button"
        accessibilityLabel={localize(
          kaspi ? t('Оплатить с Kaspi.kz, {p0}', { p0: totalText }) : t(title),
        )}
        accessibilityState={{ disabled, busy }}
        disabled={disabled}
        onPress={onPay}
        style={[s.pay, disabled && s.payDisabled]}
      >
        {words.before ? (
          <Text style={s.payText} maxFontSizeMultiplier={1.5}>
            {words.before}
          </Text>
        ) : null}
        {kaspi ? (
          <View style={s.payBrand}>
            <PaymentMark method="kaspi" size={30} />
            <Text style={[s.payText, s.payBrandText]} maxFontSizeMultiplier={1.5}>
              Kaspi.kz
            </Text>
          </View>
        ) : null}
        {words.after ? (
          <Text style={s.payText} maxFontSizeMultiplier={1.5}>
            {words.after}
          </Text>
        ) : null}
      </MotionPressable>
    </>
  );
}

const s = StyleSheet.create({
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    paddingBottom: 12,
    width: '100%',
    maxWidth: 760,
    alignSelf: 'center',
  },
  point: {
    flex: 1,
    minWidth: 0,
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  pointName: {
    flexShrink: 1,
    fontFamily: font.medium,
    fontSize: 17,
    lineHeight: 23,
    color: colors.white,
  },
  pill: {
    flexDirection: 'row',
    gap: 4,
    padding: 4,
    borderRadius: 26,
    backgroundColor: '#020C24',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#FFFFFF14',
  },
  segment: {
    flex: 1,
    minWidth: 0,
    minHeight: 44,
    borderRadius: 22,
    paddingHorizontal: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: 'transparent',
  },
  segmentSelected: { backgroundColor: '#FFFFFF1F', borderColor: '#FFFFFF2E' },
  segmentText: {
    flexShrink: 1,
    fontFamily: font.medium,
    fontSize: 15,
    lineHeight: 21,
    color: colors.muted,
  },
  segmentTextSelected: { color: colors.white },
  comment: {
    gap: 8,
    padding: 14,
    marginTop: 6,
    borderRadius: 22,
    backgroundColor: '#0B2255',
    borderWidth: 1,
    borderColor: '#FFFFFF0F',
  },
  commentHeading: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  commentLabel: { flex: 1, fontSize: 15, lineHeight: 21, color: colors.white },
  commentInput: {
    minHeight: 82,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#FFFFFF33',
    backgroundColor: colors.background,
    color: colors.white,
    fontFamily: font.body,
    fontSize: 16,
    lineHeight: 23,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  commentCount: { textAlign: 'right', fontSize: 12, lineHeight: 18, color: colors.muted },
  summary: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  method: {
    flexShrink: 1,
    minWidth: 150,
    minHeight: 60,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 18,
    justifyContent: 'center',
    gap: 2,
    backgroundColor: '#FFFFFF0F',
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: '#FFFFFF1A',
  },
  methodCaption: { fontSize: 12, lineHeight: 17, color: colors.muted },
  methodRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  methodName: {
    flexShrink: 1,
    fontFamily: font.medium,
    fontSize: 16,
    lineHeight: 22,
    color: colors.white,
  },
  total: { marginLeft: 'auto', alignItems: 'flex-end' },
  totalLabel: { fontSize: 14, lineHeight: 20, color: colors.muted },
  totalAmount: {
    fontFamily: font.heading,
    fontSize: 30,
    lineHeight: 40,
    color: colors.white,
    fontVariant: ['tabular-nums'],
  },
  pay: {
    minHeight: 60,
    borderRadius: 30,
    paddingHorizontal: 22,
    paddingVertical: 12,
    backgroundColor: colors.white,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'center',
    columnGap: 10,
    rowGap: 4,
  },
  payDisabled: { opacity: 0.5 },
  payText: { fontFamily: font.heading, fontSize: 19, lineHeight: 26, color: colors.background },
  payBrand: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  payBrandText: { fontFamily: font.display },
  modal: { flex: 1, justifyContent: 'flex-end', backgroundColor: '#00000088' },
  sheet: {
    width: '100%',
    maxWidth: 720,
    maxHeight: '90%',
    alignSelf: 'center',
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    backgroundColor: colors.surface,
  },
  sheetContent: { padding: 18, gap: 14 },
  sheetHeader: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  sheetTitle: { flex: 1, fontFamily: font.heading, fontSize: 22, lineHeight: 30 },
  options: { gap: 10 },
  option: {
    minHeight: 64,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 18,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderWidth: 1.5,
    borderColor: '#FFFFFF14',
    backgroundColor: '#0B2255',
  },
  optionSelected: { borderColor: colors.accent, backgroundColor: '#FF69001A' },
  optionDisabled: { opacity: 0.85 },
  optionIcon: {
    width: 36,
    height: 36,
    borderRadius: 11,
    backgroundColor: '#FFFFFF0A',
    alignItems: 'center',
    justifyContent: 'center',
  },
  optionName: { flex: 1, fontFamily: font.medium, fontSize: 16, lineHeight: 22 },
  optionNameDisabled: { color: '#899BBC' },
  soon: {
    fontFamily: font.bold,
    fontSize: 11,
    lineHeight: 16,
    color: colors.muted,
    backgroundColor: '#FFFFFF0F',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
    overflow: 'hidden',
  },
});
