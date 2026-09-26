import { MotionPressable as Pressable } from '../components/Motion';
import { useEffect, useRef, useState } from 'react';
import { Keyboard, StyleSheet, Text, TextInput, View } from 'react-native';
import {
  AuthButton,
  AuthLayout,
  authColors,
  useAuthKeyboardVisible,
} from '../components/AuthLayout';
import { Icon } from '../components/UI';
import { DEMO_LOGIN_CODE, formatDemoPhone, normalizeDemoPhone } from '../demo-account';
import type { ScreenProps } from '../model';
import { font } from '../theme';
import { useAccount } from '../useAccount';
import { CUSTOMER_CHANNEL_LABELS, type CustomerChannel } from '../customer-session';

function DemoNote() {
  const account = useAccount();
  if (account.mode === 'server')
    return account.deliveryUnknown ? (
      <Text style={s.demoText}>
        Ожидаем подтверждение отправки. Если код уже пришёл, введите его. Повторная отправка будет
        доступна по таймеру.
      </Text>
    ) : null;
  return (
    <View style={s.demoNote}>
      <Text style={s.demoText}>Код входа {DEMO_LOGIN_CODE}. SMS не отправляется.</Text>
    </View>
  );
}

function phoneDigits(value: string) {
  const canonical = normalizeDemoPhone(value);
  if (canonical) return canonical.slice(2);
  let digits = value.replace(/\D/g, '');
  if (digits.length > 10 && (digits.startsWith('7') || digits.startsWith('8')))
    digits = digits.slice(1);
  return digits.slice(0, 10);
}

function displayPhone(digits: string) {
  return (
    digits.slice(0, 3) +
    (digits.length > 3 ? ` ${digits.slice(3, 6)}` : '') +
    (digits.length > 6 ? `-${digits.slice(6, 8)}` : '') +
    (digits.length > 8 ? `-${digits.slice(8, 10)}` : '')
  );
}

export function Phone(props: ScreenProps) {
  const demo = useAccount();
  const initial = useRef(demo.challenge?.phone.slice(2) ?? '');
  const input = useRef<TextInput>(null);
  const phoneRef = useRef(initial.current);
  const [phone, setPhone] = useState(initial.current);
  const [selectedChannel, setSelectedChannel] = useState<CustomerChannel>('telegram');
  const channel =
    demo.pendingOtp && demo.activeChannel
      ? demo.activeChannel
      : demo.channels.includes(selectedChannel)
        ? selectedChannel
        : demo.channels[0];
  const [inputSeed, setInputSeed] = useState({ text: initial.current, revision: 0 });
  const [submitted, setSubmitted] = useState(false);
  const [editing, setEditing] = useState(false);
  const keyboardVisible = useAuthKeyboardVisible();

  useEffect(() => {
    const hidden = Keyboard.addListener('keyboardDidHide', () => setEditing(false));
    return () => hidden.remove();
  }, []);
  useEffect(() => {
    if (!demo.account && !demo.challenge) {
      phoneRef.current = '';
      setPhone('');
      setInputSeed((previous) => ({ text: '', revision: previous.revision + 1 }));
    }
  }, [demo.account, demo.challenge]);

  const valid = normalizeDemoPhone(phone) !== null;
  const request = async () => {
    if (props.preview) return;
    setSubmitted(true);
    if (await demo.requestCode(phoneRef.current, channel)) {
      setSubmitted(false);
      Keyboard.dismiss();
      props.navigate('M03');
    }
  };
  const keypad = (key: string) => {
    if (!demo.ready || demo.busy) return;
    const current = phoneDigits(phoneRef.current);
    const digits = key === 'delete' ? current.slice(0, -1) : (current + key).slice(0, 10);
    const text = displayPhone(digits);
    phoneRef.current = text;
    setPhone(text);
    setSubmitted(false);
    // Only keypad edits remount the unfocused field. Native typing/paste stays
    // uncontrolled, avoiding the controlled TextInput fast-keystroke regression.
    setInputSeed((previous) => ({ text, revision: previous.revision + 1 }));
  };
  return (
    <AuthLayout
      props={props}
      topAction={{ label: 'Меню без входа', onPress: () => props.navigate('M06') }}
      title="Ваш номер"
      subtitle={
        demo.mode === 'server'
          ? 'Войдите, чтобы сохранять свой профиль Pick Chick.'
          : 'Номер нужен, чтобы познакомиться с профилем Pick Chick.'
      }
      footer={
        <AuthButton
          title={
            demo.busy
              ? 'Подготавливаем код…'
              : channel
                ? `Получить код ${channel === 'telegram' ? 'в Telegram' : 'по SMS'}`
                : 'Вход пока недоступен'
          }
          testID="request-otp"
          disabled={props.preview || !demo.ready || demo.busy || !valid || !channel}
          onPress={() => void request()}
        />
      }
      bottomContent={
        !editing && !keyboardVisible ? (
          <View testID="phone-keypad" style={s.keypad}>
            {['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'delete'].map((key, index) =>
              key ? (
                <Pressable
                  key={key}
                  testID={`phone-key-${key}`}
                  accessibilityRole="button"
                  accessibilityLabel={key === 'delete' ? 'Удалить последнюю цифру' : key}
                  accessibilityState={{ disabled: !demo.ready || demo.busy }}
                  disabled={!demo.ready || demo.busy}
                  onPress={() => keypad(key)}
                  style={({ pressed }) => [s.key, pressed && s.pressed]}
                >
                  {key === 'delete' ? (
                    <Icon name="backspace-outline" size={26} color={authColors.text} />
                  ) : (
                    <Text style={s.keyText}>{key}</Text>
                  )}
                </Pressable>
              ) : (
                <View key={`blank-${index}`} accessible={false} style={s.key} />
              ),
            )}
          </View>
        ) : undefined
      }
    >
      <View style={s.phoneField}>
        <Text style={s.phonePrefix}>+7</Text>
        <TextInput
          key={inputSeed.revision}
          ref={input}
          testID="phone-input"
          accessibilityLabel="Мобильный номер Казахстана, 10 цифр после +7"
          defaultValue={inputSeed.text}
          editable={demo.ready && !demo.busy}
          onFocus={() => setEditing(true)}
          onBlur={() => setEditing(false)}
          onChangeText={(value) => {
            phoneRef.current = value;
            setPhone(value);
            setSubmitted(false);
          }}
          placeholder="7__ ___ __ __"
          placeholderTextColor={authColors.muted}
          keyboardType="phone-pad"
          textContentType="telephoneNumber"
          autoComplete="tel-national"
          autoCorrect={false}
          spellCheck={false}
          smartInsertDelete={false}
          autoCapitalize="none"
          maxLength={30}
          returnKeyType="done"
          onSubmitEditing={() => valid && void request()}
          underlineColorAndroid="transparent"
          style={s.phoneInput}
        />
      </View>
      {demo.mode === 'server' && demo.channels.length > 0 ? (
        <View style={s.channelGroup}>
          <Text style={s.channelTitle}>Куда прислать код?</Text>
          <View style={s.channelChoices} accessibilityRole="radiogroup">
            {demo.channels.map((option) => (
              <Pressable
                key={option}
                testID={`auth-channel-${option}`}
                accessibilityRole="radio"
                accessibilityLabel={CUSTOMER_CHANNEL_LABELS[option]}
                aria-checked={channel === option}
                accessibilityState={{
                  checked: channel === option,
                  disabled: demo.busy || demo.pendingOtp,
                }}
                disabled={demo.busy || demo.pendingOtp}
                onPress={() => setSelectedChannel(option)}
                style={({ pressed }) => [
                  s.channelChoice,
                  channel === option && s.channelSelected,
                  pressed && s.pressed,
                ]}
              >
                <Text style={s.channelLabel}>{CUSTOMER_CHANNEL_LABELS[option]}</Text>
                {channel === option ? (
                  <Icon name="checkmark-circle" size={20} color={authColors.blueInk} />
                ) : null}
              </Pressable>
            ))}
          </View>
          <Text style={s.channelHint}>
            {channel === 'telegram'
              ? 'Telegram должен быть зарегистрирован на этот номер.'
              : 'Код придёт в SMS на указанный номер.'}
          </Text>
        </View>
      ) : null}
      {demo.mode === 'server' && demo.ready && !demo.busy && demo.channels.length === 0 ? (
        <View style={s.channelGroup}>
          <Text accessibilityRole="alert" style={s.channelHint}>
            {demo.error ?? 'Подтверждение номера пока недоступно. Можно посмотреть меню без входа.'}
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => void demo.retryRestore()}
            style={s.resend}
          >
            <Text style={s.resendText}>Повторить подключение</Text>
          </Pressable>
        </View>
      ) : null}
      {phone.replace(/\D/g, '').length >= 10 && !valid ? (
        <Text style={s.error}>Введите 10 цифр, начиная с 7, после префикса +7.</Text>
      ) : null}
      {submitted && demo.error ? (
        <Text testID="demo-auth-error" accessibilityRole="alert" style={s.error}>
          {demo.error}
        </Text>
      ) : null}
      {demo.mode === 'server' && demo.pendingOtp && demo.error ? (
        <View style={{ gap: 8 }}>
          <Text style={s.demoText}>
            Предыдущий код ещё может прийти. Повторное нажатие «Получить код» проверит тот же
            запрос.
          </Text>
          <Pressable
            accessibilityRole="button"
            disabled={demo.busy}
            onPress={() => demo.cancelChallenge()}
            style={{ minHeight: 44, justifyContent: 'center' }}
            testID="restart-phone-request"
          >
            <Text style={s.legalText}>Начать заново или изменить номер</Text>
          </Pressable>
        </View>
      ) : null}
      <Pressable
        accessibilityRole="button"
        onPress={() => props.navigate('M33')}
        style={({ pressed }) => [s.legalLink, pressed && s.pressed]}
      >
        <Text style={s.legalText}>Условия и конфиденциальность</Text>
      </Pressable>
      <DemoNote />
    </AuthLayout>
  );
}

export function Otp(props: ScreenProps) {
  const demo = useAccount();
  const [consentVersion, setConsentVersion] = useState<string | null>(null);
  const consentAccepted = Boolean(consentVersion && consentVersion === demo.legal?.version);
  const input = useRef<TextInput>(null);
  const [code, setCode] = useState('');
  const [now, setNow] = useState(Date.now);
  const [submitted, setSubmitted] = useState(false);
  const challenge = demo.challenge;
  useEffect(() => {
    setConsentVersion(null);
  }, [demo.legal?.version, challenge?.phone, challenge?.resendAt]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    input.current?.clear();
    setCode('');
    setSubmitted(false);
  }, [challenge?.phone, challenge?.resendAt]);
  const remaining = Math.max(0, Math.ceil(((challenge?.resendAt ?? 0) - now) / 1000));
  const expired = challenge ? now >= challenge.expiresAt && !demo.pendingVerify : false;
  const canVerify = Boolean(
    challenge &&
    !demo.pendingOtp &&
    !expired &&
    challenge.attemptsLeft > 0 &&
    /^\d{6}$/.test(code) &&
    (demo.mode === 'demo' || consentAccepted || demo.pendingVerify),
  );
  const verify = async () => {
    if (props.preview) return;
    setSubmitted(true);
    const phone = challenge?.phone;
    const previousPhone = demo.account?.phone;
    if (await demo.verifyCode(code, consentVersion)) {
      if (phone && phone !== previousPhone) props.model.setNickname('');
      Keyboard.dismiss();
      props.navigate('M04');
    }
  };
  const resend = async (channel: CustomerChannel = demo.activeChannel ?? 'sms') => {
    if (!challenge || props.preview) return;
    setSubmitted(true);
    if (await demo.requestCode(challenge.phone, channel)) {
      setNow(Date.now());
      setSubmitted(false);
    }
  };
  return (
    <AuthLayout
      props={props}
      topAction={{ label: 'Изменить номер', onPress: () => props.navigate('M02') }}
      title={demo.activeChannel === 'telegram' ? 'Код из Telegram' : 'Код из SMS'}
      subtitle={
        challenge
          ? `Для ${formatDemoPhone(challenge.phone)}`
          : demo.mode === 'server'
            ? 'Укажите номер, чтобы войти.'
            : 'Укажите номер, чтобы начать вход.'
      }
      footer={
        <AuthButton
          title={demo.busy ? 'Входим…' : 'Подтвердить'}
          testID="confirm-otp"
          disabled={props.preview || !canVerify || demo.busy || !demo.ready}
          onPress={() => void verify()}
        />
      }
    >
      <View style={s.otpRow}>
        <View pointerEvents="none" accessible={false} style={s.otpCells}>
          {Array.from({ length: 6 }, (_, index) => (
            <View key={index} style={[s.otpCell, index === code.length && s.activeCell]}>
              <Text style={s.otpDigit}>{code[index] ?? ''}</Text>
            </View>
          ))}
        </View>
        <TextInput
          ref={input}
          testID="otp-input"
          accessibilityLabel="Код подтверждения, 6 цифр"
          defaultValue=""
          editable={
            Boolean(challenge) &&
            !demo.pendingOtp &&
            !demo.busy &&
            !expired &&
            (challenge?.attemptsLeft ?? 0) > 0
          }
          onChangeText={(value) => {
            setCode(value);
            setSubmitted(false);
          }}
          keyboardType="number-pad"
          textContentType="oneTimeCode"
          autoComplete="sms-otp"
          autoCorrect={false}
          spellCheck={false}
          smartInsertDelete={false}
          autoCapitalize="none"
          maxLength={6}
          caretHidden
          selectionColor="transparent"
          underlineColorAndroid="transparent"
          returnKeyType="done"
          onSubmitEditing={() => canVerify && void verify()}
          style={s.otpInput}
        />
      </View>
      {demo.mode === 'server' && !demo.pendingVerify ? (
        <View style={{ gap: 8, marginTop: 20 }}>
          <Pressable
            accessibilityRole="checkbox"
            accessibilityState={{ checked: consentAccepted }}
            testID="auth-consent"
            disabled={demo.busy || props.preview}
            onPress={() =>
              setConsentVersion((value) => (value ? null : (demo.legal?.version ?? null)))
            }
            style={({ pressed }) => [
              { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 48 },
              pressed && s.pressed,
            ]}
          >
            <Icon
              name={consentAccepted ? 'checkbox' : 'square-outline'}
              size={28}
              color={authColors.text}
            />
            <Text style={[s.legalText, { flex: 1 }]}>
              Принимаю условия и соглашаюсь на обработку данных для работы аккаунта
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={() => props.navigate('M33')}
            style={{ minHeight: 44, justifyContent: 'center' }}
          >
            <Text style={s.legalText}>Прочитать условия и политику конфиденциальности</Text>
          </Pressable>
        </View>
      ) : null}
      {demo.mode === 'server' && demo.pendingVerify ? (
        <Text style={s.demoText}>
          Повторите код, который уже пришёл на ваш номер. Новый код запрашивать не нужно.
        </Text>
      ) : null}
      <Pressable
        testID="resend-otp"
        accessibilityRole="button"
        accessibilityState={{
          disabled: !challenge || remaining > 0 || demo.busy || demo.pendingVerify,
        }}
        disabled={props.preview || !challenge || remaining > 0 || demo.busy || demo.pendingVerify}
        onPress={() => void resend()}
        style={({ pressed }) => [s.resend, pressed && s.pressed]}
      >
        <Text style={[s.resendText, remaining === 0 && s.resendReady]}>
          {remaining
            ? `Новый код можно запросить через ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`
            : 'Получить код повторно'}
        </Text>
      </Pressable>
      {submitted && demo.error ? (
        <Text testID="demo-auth-error" accessibilityRole="alert" style={s.error}>
          {demo.error}
        </Text>
      ) : null}
      {demo.mode === 'server' && challenge && !demo.pendingVerify && !demo.pendingOtp
        ? demo.channels
            .filter((option) => option !== demo.activeChannel)
            .map((option) => (
              <Pressable
                key={option}
                testID={`otp-fallback-${option}`}
                accessibilityRole="button"
                accessibilityState={{ disabled: remaining > 0 || demo.busy }}
                disabled={props.preview || remaining > 0 || demo.busy}
                onPress={() => void resend(option)}
                style={({ pressed }) => [s.resend, pressed && s.pressed]}
              >
                <Text style={[s.resendText, remaining === 0 && s.resendReady]}>
                  {option === 'sms' ? 'Получить код по SMS' : 'Получить код в Telegram'}
                </Text>
              </Pressable>
            ))
        : null}
      {expired ? <Text style={s.error}>Код истёк. Запросите его повторно.</Text> : null}
      <DemoNote />
    </AuthLayout>
  );
}

const s = StyleSheet.create({
  channelGroup: { marginTop: 20, gap: 10 },
  channelTitle: { fontFamily: font.body, fontSize: 16, lineHeight: 24, color: authColors.text },
  channelChoices: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  channelChoice: {
    minHeight: 48,
    paddingHorizontal: 16,
    paddingVertical: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: authColors.border,
  },
  channelSelected: { borderColor: authColors.blueInk, backgroundColor: authColors.blueSoft },
  channelLabel: { fontFamily: font.body, fontSize: 16, lineHeight: 24, color: authColors.text },
  channelHint: { fontFamily: font.body, fontSize: 14, lineHeight: 21, color: authColors.muted },
  phoneField: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 20,
    marginTop: 24,
    minHeight: 76,
    borderRadius: 18,
    backgroundColor: authColors.surface,
  },
  phonePrefix: { fontFamily: font.heading, fontSize: 26, lineHeight: 36, color: authColors.muted },
  phoneInput: {
    flex: 1,
    minWidth: 0,
    minHeight: 76,
    paddingVertical: 16,
    paddingHorizontal: 0,
    fontFamily: font.heading,
    fontSize: 26,
    lineHeight: 36,
    letterSpacing: 0.3,
    color: authColors.text,
  },
  legalLink: { minHeight: 48, justifyContent: 'center', marginTop: 4 },
  legalText: { fontFamily: font.body, fontSize: 13.5, lineHeight: 20, color: authColors.blueInk },
  demoNote: {
    borderRadius: 16,
    paddingVertical: 13,
    paddingHorizontal: 16,
    backgroundColor: authColors.blueSoft,
  },
  demoText: { fontFamily: font.body, fontSize: 13.5, lineHeight: 21, color: authColors.blueInk },
  error: {
    fontFamily: font.body,
    fontSize: 14,
    lineHeight: 21,
    color: authColors.danger,
    marginTop: 12,
  },
  keypad: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  key: {
    width: '30%',
    flexGrow: 1,
    minHeight: 56,
    borderRadius: 16,
    backgroundColor: authColors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  keyText: { fontFamily: font.heading, fontSize: 26, lineHeight: 36, color: authColors.text },
  pressed: { opacity: 0.65 },
  otpRow: { marginTop: 26, position: 'relative' },
  otpCells: { flexDirection: 'row', gap: 9 },
  otpCell: {
    flex: 1,
    minWidth: 0,
    minHeight: 64,
    borderRadius: 16,
    borderWidth: 2,
    borderColor: 'transparent',
    backgroundColor: authColors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  activeCell: { borderColor: authColors.blue },
  otpDigit: { fontFamily: font.heading, fontSize: 26, lineHeight: 36, color: authColors.text },
  otpInput: {
    ...StyleSheet.absoluteFill,
    color: 'transparent',
    backgroundColor: 'transparent',
    fontSize: 26,
    padding: 0,
  },
  resend: { marginTop: 8, minHeight: 48, justifyContent: 'center', marginBottom: 14 },
  resendText: { fontFamily: font.body, fontSize: 13.5, lineHeight: 21, color: authColors.muted },
  resendReady: { color: authColors.blueInk },
});
