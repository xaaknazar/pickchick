import { TextInput } from './LocalizedText';
import { localize, t, useLocale } from '../i18n';
import { useEffect, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  type TextInput as NativeTextInput,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { CustomerTestPayment } from '@pickchick/contracts';
import {
  CARD_PROBLEM_TEXT,
  cardProblem,
  formatCardNumber,
  formatExpiry,
  tipTopPayResultCopy,
  type CardFields,
  type CardProblem,
} from '../tiptoppay-checkout';
import { colors, font } from '../theme';
import { MotionModal } from './Motion';
import { keyboardAvoidingBehavior } from '../keyboard-avoidance';
import { Body, Button, Caption, CloseButton, Heading, Icon } from './UI';

/**
 * Bank card form of the TipTopPay checkout (owner 18.11.2026, native). The numbers live only in
 * this component's state until they are encrypted on the phone (cardCryptogram); nothing is
 * saved, logged or sent in clear. Closing the sheet forgets them.
 */
export function CardPaymentSheet({
  visible,
  totalText,
  test,
  onPay,
  onClose,
}: {
  visible: boolean;
  totalText: string;
  test: boolean;
  onPay(card: CardFields): void;
  onClose(): void;
}) {
  useLocale();
  const insets = useSafeAreaInsets();
  const [card, setCard] = useState<CardFields>({ number: '', expiry: '', cvv: '' });
  const [problem, setProblem] = useState<CardProblem | null>(null);
  const expiryRef = useRef<NativeTextInput>(null);
  const cvvRef = useRef<NativeTextInput>(null);
  useEffect(() => {
    if (!visible) {
      setCard({ number: '', expiry: '', cvv: '' });
      setProblem(null);
    }
  }, [visible]);
  const submit = () => {
    const found = cardProblem(card, new Date());
    setProblem(found);
    if (!found) onPay(card);
  };
  return (
    <MotionModal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={keyboardAvoidingBehavior(Platform.OS)} style={s.modal}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('Закрыть оплату картой')}
          style={StyleSheet.absoluteFill}
          onPress={onClose}
        />
        <View
          testID="card-payment-sheet"
          role="dialog"
          aria-modal
          accessibilityViewIsModal
          accessibilityLabel={t('Оплата картой')}
          style={[s.sheet, { paddingBottom: Math.max(insets.bottom, 18) }]}
        >
          <ScrollView
            contentContainerStyle={s.content}
            bounces={false}
            keyboardShouldPersistTaps="handled"
          >
            <View style={s.header}>
              <Heading small style={s.title}>
                {t('Оплата картой')}
              </Heading>
              <CloseButton
                label={t('Закрыть оплату картой')}
                testID="card-payment-close"
                onPress={onClose}
              />
            </View>
            {test ? (
              <View style={s.testBadge} testID="card-payment-test">
                <Icon name="flask-outline" size={16} color={colors.warning} />
                <Caption style={s.testText}>{t('Тестовый режим: деньги не спишутся')}</Caption>
              </View>
            ) : null}
            <Field label={t('Номер карты')} error={problem === 'number'}>
              <TextInput
                testID="card-number"
                value={card.number}
                onChangeText={(value) => {
                  const number = formatCardNumber(value);
                  setCard((c) => ({ ...c, number }));
                  if (number.replace(/\D/g, '').length === 16) expiryRef.current?.focus();
                }}
                placeholder="0000 0000 0000 0000"
                placeholderTextColor="#6F82A8"
                keyboardType="number-pad"
                textContentType="creditCardNumber"
                autoComplete="cc-number"
                importantForAutofill="yes"
                maxLength={23}
                style={s.input}
                accessibilityLabel={t('Номер карты')}
              />
            </Field>
            <View style={s.row}>
              <Field label={t('Срок, ММ/ГГ')} error={problem === 'expiry'} style={s.half}>
                <TextInput
                  ref={expiryRef}
                  testID="card-expiry"
                  value={card.expiry}
                  onChangeText={(value) => {
                    const expiry = formatExpiry(value);
                    setCard((c) => ({ ...c, expiry }));
                    if (expiry.length === 5) cvvRef.current?.focus();
                  }}
                  placeholder={t('ММ/ГГ')}
                  placeholderTextColor="#6F82A8"
                  keyboardType="number-pad"
                  autoComplete="cc-exp"
                  maxLength={5}
                  style={s.input}
                  accessibilityLabel={t('Срок действия карты')}
                />
              </Field>
              <Field label="CVV" error={problem === 'cvv'} style={s.half}>
                <TextInput
                  ref={cvvRef}
                  testID="card-cvv"
                  value={card.cvv}
                  onChangeText={(value) =>
                    setCard((c) => ({ ...c, cvv: value.replace(/\D/g, '').slice(0, 4) }))
                  }
                  placeholder="•••"
                  placeholderTextColor="#6F82A8"
                  keyboardType="number-pad"
                  autoComplete="cc-csc"
                  secureTextEntry
                  maxLength={4}
                  style={s.input}
                  accessibilityLabel={t('CVV-код')}
                />
              </Field>
            </View>
            {problem ? (
              <View accessibilityLiveRegion="polite">
                <Body testID="card-payment-problem" style={s.problem}>
                  {localize(CARD_PROBLEM_TEXT[problem])}
                </Body>
              </View>
            ) : null}
            <Button
              testID="card-payment-pay"
              title={t('Оплатить картой · {p0}', { p0: totalText })}
              onPress={submit}
            />
            <View style={s.secure}>
              <Icon name="lock-closed" size={14} color={colors.muted} />
              <Caption style={s.secureText}>
                {t('Данные карты шифруются на телефоне и передаются только банку')}
              </Caption>
            </View>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </MotionModal>
  );
}

function Field({
  label,
  error,
  style,
  children,
}: {
  label: string;
  error: boolean;
  style?: object;
  children: React.ReactNode;
}) {
  return (
    <View style={[s.field, style]}>
      <Caption style={s.label}>{label}</Caption>
      <View style={[s.inputBox, error && s.inputError]}>{children}</View>
    </View>
  );
}

/** «Оплата прошла» / «Оплата не прошла» / «Проверяем оплату» after a TipTopPay payment. */
export function TipTopPayResultSheet({
  payment,
  test,
  onClose,
  onRetry,
  onKaspi,
  onRefresh,
}: {
  payment: (Pick<CustomerTestPayment, 'state' | 'message'> & { id?: string }) | null;
  test: boolean;
  onClose(): void;
  onRetry(): void;
  onKaspi(): void;
  onRefresh(): void;
}) {
  useLocale();
  const insets = useSafeAreaInsets();
  const copy = payment ? tipTopPayResultCopy(payment, test) : null;
  const icon =
    copy?.tone === 'success'
      ? { name: 'checkmark-circle' as const, color: colors.success }
      : copy?.tone === 'danger'
        ? { name: 'close-circle' as const, color: colors.danger }
        : { name: 'time-outline' as const, color: colors.warning };
  return (
    <MotionModal visible={!!payment} transparent onRequestClose={onClose}>
      <ScrollView
        contentContainerStyle={[
          s.backdrop,
          { paddingTop: Math.max(24, insets.top), paddingBottom: Math.max(24, insets.bottom) },
        ]}
      >
        {copy ? (
          <View
            testID="tiptoppay-result"
            accessibilityViewIsModal
            role="dialog"
            aria-modal
            accessibilityLabel={localize(copy.title)}
            style={s.card}
          >
            <Icon name={icon.name} size={56} color={icon.color} />
            <Heading small testID="tiptoppay-result-title" style={s.center}>
              {localize(copy.title)}
            </Heading>
            <Body muted testID="tiptoppay-result-detail" style={s.center}>
              {localize(copy.detail)}
            </Body>
            {copy.tone === 'success' ? (
              <Button title={t('Готово')} testID="tiptoppay-result-done" onPress={onClose} />
            ) : copy.tone === 'danger' ? (
              <>
                <Button
                  title={t('Попробовать ещё раз')}
                  testID="tiptoppay-result-retry"
                  onPress={onRetry}
                />
                <Button
                  title={t('Оплатить через Kaspi.kz')}
                  secondary
                  testID="tiptoppay-result-kaspi"
                  onPress={onKaspi}
                />
              </>
            ) : (
              <>
                <Button
                  title={t('Проверить ещё раз')}
                  testID="tiptoppay-result-refresh"
                  onPress={onRefresh}
                />
                <Button
                  title={t('Закрыть')}
                  secondary
                  testID="tiptoppay-result-close"
                  onPress={onClose}
                />
              </>
            )}
          </View>
        ) : null}
      </ScrollView>
    </MotionModal>
  );
}

const s = StyleSheet.create({
  modal: { flex: 1, justifyContent: 'flex-end', backgroundColor: '#00000088' },
  sheet: {
    width: '100%',
    maxWidth: 720,
    maxHeight: '92%',
    alignSelf: 'center',
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    backgroundColor: colors.surface,
  },
  content: { padding: 18, gap: 14 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  title: { flex: 1, fontFamily: font.heading, fontSize: 22, lineHeight: 30 },
  testBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    alignSelf: 'flex-start',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: colors.warningSurface,
  },
  testText: { color: colors.warning },
  row: { flexDirection: 'row', gap: 12 },
  half: { flex: 1 },
  field: { gap: 6 },
  label: { color: colors.muted },
  inputBox: {
    minHeight: 56,
    borderRadius: 16,
    borderWidth: 1.5,
    borderColor: '#FFFFFF1F',
    backgroundColor: colors.raised,
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  inputError: { borderColor: colors.danger },
  input: {
    color: colors.white,
    fontFamily: font.medium,
    fontSize: 18,
    letterSpacing: 1,
    paddingVertical: 12,
  },
  problem: { color: colors.danger },
  secure: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  secureText: { color: colors.muted, textAlign: 'center', flexShrink: 1 },
  backdrop: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingHorizontal: 20,
    backgroundColor: '#000000A6',
  },
  card: {
    width: '100%',
    maxWidth: 440,
    alignSelf: 'center',
    alignItems: 'stretch',
    gap: 14,
    padding: 22,
    borderRadius: 26,
    backgroundColor: colors.surface,
  },
  center: { textAlign: 'center', alignSelf: 'center' },
});
