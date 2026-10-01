import { MotionPressable as Pressable } from '../components/Motion';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Keyboard,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { AuthButton, AuthLayout, authColors } from '../components/AuthLayout';
import { Icon } from '../components/UI';
import { DEMO_LOGIN_CODE, formatDemoPhone, normalizeDemoPhone } from '../demo-account';
import type { ScreenProps } from '../model';
import { colors, font } from '../theme';
import { useAccount } from '../useAccount';
import { useAuthFlow } from '../auth-flow';

function DemoNote() {
  const account = useAccount();
  if (account.mode === 'server')
    return account.deliveryUnknown ? (
      <Text style={s.hint}>Ожидаем подтверждение отправки. Если код уже пришёл, введите его.</Text>
    ) : null;
  return (
    <Text style={s.hint}>
      Код для локального просмотра: {DEMO_LOGIN_CODE}. Сообщения не отправляются.
    </Text>
  );
}
function phoneDigits(value: string) {
  let digits = value.replace(/\D/g, '');
  if (digits.length > 10 && /^[78]/.test(digits)) digits = digits.slice(1);
  return digits.slice(0, 10);
}
function displayPhone(value: string) {
  return [value.slice(0, 3), value.slice(3, 6), value.slice(6, 8), value.slice(8, 10)]
    .filter(Boolean)
    .join(' ');
}

export function Phone(props: ScreenProps) {
  const account = useAccount();
  const flow = useAuthFlow();
  const [phone, setPhone] = useState(
    (account.pendingPhone ?? account.challenge?.phone)?.slice(2) ?? '',
  );
  const [focused, setFocused] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const input = useRef<TextInput>(null);
  const requestLock = useRef(false);
  const initiallyFocused = useRef(false);
  const readyForInput = flow?.readyForInput !== false;
  useEffect(() => {
    if (account.ready && readyForInput && !props.preview && !initiallyFocused.current) {
      initiallyFocused.current = true;
      input.current?.focus();
    }
  }, [account.ready, props.preview, readyForInput]);
  useEffect(() => {
    if (account.pendingPhone) setPhone(account.pendingPhone.slice(2));
  }, [account.pendingPhone]);
  const live = useRef(true);
  const { width } = useWindowDimensions();
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  // The server owns the delivery sequence. A pending request keeps its original intent.
  const channel = account.pendingOtp
    ? account.pendingRequestChannel
    : account.automaticSelection
      ? 'auto'
      : account.channels.find((c) => c === 'telegram');
  const available = account.mode === 'demo' || !!channel;
  const canonical = normalizeDemoPhone(phone);
  const valid = !!canonical;
  const canContinue =
    account.ready &&
    readyForInput &&
    !account.busy &&
    valid &&
    available &&
    (account.mode === 'demo' || !!account.legal);
  const request = async () => {
    if (props.preview || !canContinue || requestLock.current) return;
    requestLock.current = true;
    setSubmitted(true);
    // This button explicitly accepts the linked policy and delivery wording below.
    if (canonical && account.legal) flow?.accept(canonical, account.legal.version);
    const ok = await account.requestCode(phone, channel ?? undefined, account.legal?.version);
    requestLock.current = false;
    if (ok && live.current) {
      Keyboard.dismiss();
      props.navigate('M03');
    }
  };
  return (
    <AuthLayout
      props={props}
      title={'Укажите телефон,\nчтобы войти в профиль'}
      footer={
        <>
          <Text style={s.legal}>
            Нажимая «Продолжить», принимаю{' '}
            <Text accessibilityRole="link" onPress={() => props.navigate('M33')} style={s.link}>
              условия и политику
            </Text>
            {account.mode === 'server'
              ? account.automaticSelection && account.whatsappFallbackEnabled
                ? ' и даю согласие на обработку данных и передачу номера и кода в Telegram или WhatsApp для входа.'
                : ' и даю согласие на обработку данных и передачу номера и кода Telegram для входа.'
              : '.'}
          </Text>
          <AuthButton
            title={account.busy ? 'Подготавливаем код…' : 'Продолжить'}
            testID="request-otp"
            disabled={props.preview || !canContinue}
            onPress={() => void request()}
          />
        </>
      }
    >
      <View style={[s.phoneField, focused && s.focused]}>
        <Text style={s.phonePrefix}>+7</Text>
        <View style={s.divider} />
        <TextInput
          ref={input}
          testID="phone-input"
          accessibilityLabel="Мобильный номер Казахстана, 10 цифр после +7"
          value={displayPhone(phone)}
          editable={account.ready && !account.busy && !account.pendingOtp}
          autoFocus={!props.preview && readyForInput}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChangeText={(value) => {
            const next = phoneDigits(value);
            setPhone(next);
            setSubmitted(false);
            if (next.length === 10 && normalizeDemoPhone(next)) Keyboard.dismiss();
          }}
          placeholder="000 000 00 00"
          placeholderTextColor={authColors.muted}
          keyboardType="phone-pad"
          textContentType="telephoneNumber"
          autoComplete="tel-national"
          autoCorrect={false}
          spellCheck={false}
          smartInsertDelete={false}
          autoCapitalize="none"
          maxLength={24}
          returnKeyType="done"
          onSubmitEditing={() => void request()}
          selectionColor={colors.accent}
          underlineColorAndroid="transparent"
          style={[s.phoneInput, width < 360 && { fontSize: 18 }]}
        />
        {valid ? <Icon name="checkmark-circle" size={24} color="#20BA62" /> : null}
      </View>
      <View style={s.delivery}>
        <Icon name="paper-plane" size={16} color="#74C8F0" />
        <Text style={s.hint}>
          {account.mode === 'demo'
            ? 'Предпросмотр входа'
            : channel === 'auto'
              ? 'Отправим код в доступный мессенджер'
              : channel === 'telegram'
                ? 'Пришлём код в Telegram'
                : 'Подтверждение номера пока недоступно'}
        </Text>
      </View>
      {phone.length === 10 && !valid ? (
        <Text accessibilityRole="alert" style={s.error}>
          Проверьте мобильный номер Казахстана.
        </Text>
      ) : null}
      {!available && account.ready ? (
        <Pressable
          accessibilityRole="button"
          style={s.textButton}
          onPress={() => void account.retryRestore()}
        >
          <Text style={s.orange}>Повторить подключение</Text>
        </Pressable>
      ) : null}
      {submitted && account.error ? (
        <Text testID="demo-auth-error" accessibilityRole="alert" style={s.error}>
          {account.error}
        </Text>
      ) : null}
      {account.pendingOtp ? (
        <Pressable
          testID="restart-phone-request"
          accessibilityRole="button"
          disabled={account.busy}
          style={s.textButton}
          onPress={() => account.cancelChallenge()}
        >
          <Text style={s.hint}>Начать заново или изменить номер</Text>
        </Pressable>
      ) : null}
      <DemoNote />
    </AuthLayout>
  );
}

export function Otp(props: ScreenProps) {
  const account = useAccount();
  const flow = useAuthFlow();
  const input = useRef<TextInput>(null);
  const readyForInput = flow?.readyForInput !== false;
  const initiallyFocused = useRef(false);
  useEffect(() => {
    if (readyForInput && !props.preview && !initiallyFocused.current) {
      initiallyFocused.current = true;
      input.current?.focus();
    }
  }, [props.preview, readyForInput]);
  const [code, setCode] = useState('');
  const [now, setNow] = useState(Date.now);
  const [submitted, setSubmitted] = useState(false);
  const [fallbackConsent, setFallbackConsent] = useState<string | null>(null);
  const attempted = useRef<string | null>(null);
  const lock = useRef(false);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const challenge = account.challenge;
  const policy =
    flow?.accepted?.phone === challenge?.phone ? flow?.accepted?.version : fallbackConsent;
  const accepted =
    account.mode === 'demo' ||
    account.pendingVerify ||
    (!!policy && policy === account.legal?.version);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    setCode('');
    attempted.current = null;
    setSubmitted(false);
  }, [challenge?.phone, challenge?.resendAt]);
  const remaining = Math.max(0, Math.ceil(((challenge?.resendAt ?? 0) - now) / 1000));
  const expired = !!challenge && now >= challenge.expiresAt && !account.pendingVerify;
  const codeLength = challenge?.codeLength ?? 4;
  const canVerify =
    !!challenge &&
    !account.pendingOtp &&
    !expired &&
    challenge.attemptsLeft > 0 &&
    /^\d+$/.test(code) &&
    code.length === codeLength &&
    accepted;
  const verify = useCallback(async () => {
    if (props.preview || !canVerify || account.busy || lock.current) return;
    lock.current = true;
    attempted.current = code;
    setSubmitted(true);
    const phone = challenge?.phone;
    const previousPhone = account.account?.phone;
    const ok = await account.verifyCode(code, policy ?? null);
    lock.current = false;
    if (ok && live.current) {
      if (phone && phone !== previousPhone) props.model.setNickname('');
      Keyboard.dismiss();
      props.navigate('M04');
    }
  }, [account, canVerify, challenge?.phone, code, policy, props]);
  useEffect(() => {
    if (canVerify && !account.busy && attempted.current !== code) void verify();
  }, [canVerify, account.busy, code, verify]);
  const resend = async () => {
    if (!challenge || props.preview || remaining || account.busy || account.pendingVerify) return;
    if (account.mode === 'server' && account.deliveryConsentVersion !== account.legal?.version) {
      props.navigate('M02');
      return;
    }
    setSubmitted(true);
    if (
      await account.requestCode(
        challenge.phone,
        account.automaticSelection || account.activeChannel === 'whatsapp'
          ? 'auto'
          : (account.activeChannel ?? undefined),
        account.deliveryConsentVersion,
      )
    ) {
      setNow(Date.now());
      setSubmitted(false);
      input.current?.focus();
    }
  };
  return (
    <AuthLayout
      props={props}
      topAction={{ label: 'Изменить номер', onPress: () => props.navigate('M02') }}
      title="Введите код"
      subtitle={
        <View style={s.channelLine}>
          <View style={s.channelChip}>
            <Icon
              name={
                account.deliveryUnknown
                  ? 'time-outline'
                  : account.activeChannel === 'whatsapp'
                    ? 'logo-whatsapp'
                    : 'paper-plane'
              }
              color="#7FCFF5"
              size={15}
            />
            <Text style={s.channelText}>
              {account.mode === 'demo'
                ? 'Локальный просмотр'
                : account.deliveryUnknown
                  ? 'Проверяем отправку'
                  : account.activeChannel === 'telegram'
                    ? 'Код в Telegram'
                    : account.activeChannel === 'whatsapp'
                      ? 'Код в WhatsApp'
                      : 'Код запрошен'}
            </Text>
          </View>
          <Text style={s.hint}>
            {challenge ? `на ${formatDemoPhone(challenge.phone)}` : 'Сначала укажите номер'}
          </Text>
        </View>
      }
      footer={
        submitted && account.error ? (
          <AuthButton
            title="Проверить ещё раз"
            testID="confirm-otp"
            disabled={!canVerify || account.busy}
            onPress={() => void verify()}
          />
        ) : null
      }
    >
      <View style={s.otpRow}>
        <View pointerEvents="none" accessible={false} style={s.otpCells}>
          {Array.from({ length: codeLength }, (_, index) => (
            <View key={index} style={[s.otpCell, index === code.length && s.focused]}>
              <Text style={s.otpDigit}>{code[index] ?? (index === code.length ? '│' : '')}</Text>
            </View>
          ))}
        </View>
        <TextInput
          ref={input}
          testID="otp-input"
          accessibilityLabel={`Код подтверждения, ${codeLength} цифр`}
          value={code}
          autoFocus={!props.preview && readyForInput}
          editable={
            !!challenge &&
            !account.pendingOtp &&
            !account.busy &&
            !expired &&
            challenge.attemptsLeft > 0
          }
          onChangeText={(value) => {
            const next = value.replace(/\D/g, '').slice(0, codeLength);
            setCode(next);
            setSubmitted(false);
            if (next.length < codeLength) attempted.current = null;
          }}
          keyboardType="number-pad"
          textContentType="oneTimeCode"
          autoComplete="sms-otp"
          autoCorrect={false}
          spellCheck={false}
          autoCapitalize="none"
          maxLength={codeLength}
          caretHidden
          selectionColor="transparent"
          underlineColorAndroid="transparent"
          style={[s.otpInput, Platform.OS === 'web' && { outlineWidth: 0 }]}
        />
      </View>
      <View style={s.actions}>
        <Pressable
          testID="resend-otp"
          accessibilityRole="button"
          disabled={
            props.preview || !challenge || remaining > 0 || account.busy || account.pendingVerify
          }
          style={s.textButton}
          onPress={() => void resend()}
        >
          <Text style={remaining ? s.hint : s.orange}>
            {remaining
              ? `Новый код через ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`
              : 'Отправить ещё раз'}
          </Text>
        </Pressable>
        <Pressable
          testID="change-phone"
          accessibilityRole="button"
          disabled={account.busy}
          onPress={() => props.navigate('M02')}
          style={s.textButton}
        >
          <Text style={s.orange}>Изменить номер</Text>
        </Pressable>
      </View>
      {!accepted && account.mode === 'server' ? (
        <View>
          <Text style={s.legal}>Для входа примите условия и согласие на обработку данных.</Text>
          <Pressable
            accessibilityRole="link"
            onPress={() => props.navigate('M33')}
            style={s.textButton}
          >
            <Text style={s.link}>Юридические документы</Text>
          </Pressable>
          <AuthButton
            title="Принимаю и продолжаю"
            onPress={() => setFallbackConsent(account.legal?.version ?? null)}
            disabled={!account.legal || account.busy}
          />
        </View>
      ) : null}
      {account.busy ? (
        <Text accessibilityLiveRegion="polite" style={s.hint}>
          Проверяем код…
        </Text>
      ) : null}
      {submitted && account.error ? (
        <Text testID="demo-auth-error" accessibilityRole="alert" style={s.error}>
          {account.error}
        </Text>
      ) : null}
      {expired ? (
        <Text accessibilityRole="alert" style={s.error}>
          Код истёк. Запросите новый.
        </Text>
      ) : null}
      <DemoNote />
    </AuthLayout>
  );
}
const s = StyleSheet.create({
  phoneField: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 18,
    marginTop: 24,
    minHeight: 68,
    borderRadius: 20,
    backgroundColor: authColors.surface,
    borderWidth: 1.5,
    borderColor: authColors.border,
  },
  phonePrefix: { fontFamily: font.heading, fontSize: 26, color: authColors.text },
  divider: { width: 1, height: 28, backgroundColor: '#344A75' },
  phoneInput: {
    flex: 1,
    minWidth: 0,
    paddingVertical: 15,
    paddingHorizontal: 0,
    fontFamily: font.heading,
    fontSize: 26,
    color: authColors.text,
  },
  focused: { borderColor: colors.accent },
  delivery: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12, marginBottom: 12 },
  hint: { fontFamily: font.body, fontSize: 13, lineHeight: 19, color: authColors.muted },
  legal: {
    fontFamily: font.body,
    fontSize: 12,
    lineHeight: 18,
    color: authColors.muted,
    textAlign: 'center',
  },
  link: { color: authColors.muted, textDecorationLine: 'underline' },
  orange: { fontFamily: font.medium, fontSize: 14, lineHeight: 20, color: colors.accentText },
  error: {
    fontFamily: font.body,
    fontSize: 14,
    lineHeight: 21,
    color: authColors.danger,
    marginTop: 12,
  },
  otpRow: { marginTop: 28, position: 'relative' },
  otpCells: { flexDirection: 'row', gap: 8 },
  otpCell: {
    flex: 1,
    minWidth: 0,
    height: 64,
    borderRadius: 16,
    borderWidth: 1.5,
    borderColor: '#344A75',
    backgroundColor: authColors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  otpDigit: { fontFamily: font.heading, fontSize: 28, color: authColors.text },
  otpInput: {
    ...StyleSheet.absoluteFill,
    color: 'transparent',
    backgroundColor: 'transparent',
    fontSize: 26,
    padding: 0,
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    gap: 8,
    marginTop: 12,
  },
  textButton: { minHeight: 48, justifyContent: 'center' },
  channelLine: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  channelChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#103565',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 20,
  },
  channelText: { color: '#7FCFF5', fontFamily: font.medium, fontSize: 13 },
});
