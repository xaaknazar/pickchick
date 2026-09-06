import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Image } from 'expo-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Alert,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  TextInput,
  View,
} from 'react-native';
import { colors, font } from '../theme';
import type { ScreenProps } from '../model';
import { useDemoAccount } from '../useDemoAccount';
import { DEMO_LOGIN_CODE, formatDemoPhone, normalizeDemoPhone } from '../demo-account';
import {
  Body,
  Button,
  Caption,
  Card,
  Empty,
  Heading,
  Icon,
  Logo,
  NavRow,
  Notice,
  Page,
  Row,
  ReviewBadge,
  type IconName,
  styles as ui,
} from '../components/UI';

export function Phone(props: ScreenProps) {
  const demo = useDemoAccount();
  const input = useRef<TextInput>(null);
  const initialPhone = useRef(demo.challenge?.phone.slice(2) ?? '');
  const [phone, setPhone] = useState(initialPhone.current);
  const [submitted, setSubmitted] = useState(false);
  useEffect(() => {
    if (!demo.account && !demo.challenge) {
      input.current?.clear();
      setPhone('');
    }
  }, [demo.account, demo.challenge]);
  const valid = normalizeDemoPhone(phone) !== null;
  const request = async () => {
    setSubmitted(true);
    if (await demo.requestCode(phone)) {
      setSubmitted(false);
      props.navigate('M03');
    }
  };
  return (
    <Page
      props={props}
      title="Вход"
      footer={
        <Button
          title={demo.busy ? 'Подготавливаем код…' : 'Получить код'}
          disabled={!demo.ready || demo.busy || !valid}
          testID="request-otp"
          style={s.authAction}
          onPress={() => void request()}
        />
      }
    >
      <Heading style={s.authTitle}>Ваш номер</Heading>
      <Body muted>Войдите, чтобы познакомиться со своим профилем Pick Chick.</Body>
      <View style={{ gap: 10, marginTop: 8 }}>
        <Caption>НОМЕР ТЕЛЕФОНА · КАЗАХСТАН</Caption>
        <View style={s.phoneInput}>
          <Body style={s.phonePrefix}>+7</Body>
          <TextInput
            ref={input}
            accessibilityLabel="Мобильный номер Казахстана, 10 цифр после +7"
            testID="phone-input"
            // Native owns edits; reflecting every event back as value can lose fast keystrokes.
            defaultValue={initialPhone.current}
            editable={demo.ready && !demo.busy}
            onChangeText={(value) => {
              setPhone(value);
              setSubmitted(false);
            }}
            placeholder="7__ ___ __ __"
            placeholderTextColor={colors.muted}
            keyboardType="phone-pad"
            underlineColorAndroid="transparent"
            textContentType="telephoneNumber"
            autoComplete="tel-national"
            autoCorrect={false}
            spellCheck={false}
            smartInsertDelete={false}
            autoCapitalize="none"
            maxLength={30}
            returnKeyType="done"
            onSubmitEditing={() => valid && void request()}
            style={s.phoneNumber}
          />
        </View>
        {phone.length >= 10 && !valid ? (
          <Body style={s.authError}>Нужны 10 цифр, начиная с 7, после префикса +7.</Body>
        ) : null}
      </View>
      {submitted && demo.error ? (
        <Body testID="demo-auth-error" style={s.authError}>
          {demo.error}
        </Body>
      ) : null}
      <View style={s.authDemoNote}>
        <Body style={s.authDemoTitle}>Тестовый вход</Body>
        <Body muted style={s.authDemoText}>
          Код {DEMO_LOGIN_CODE}. SMS не отправляется. Номер останется только на этом устройстве;
          владение номером сейчас не проверяется.
        </Body>
      </View>
      <NavRow title="Условия и конфиденциальность" onPress={() => props.navigate('M33')} />
      <Button title="Меню без входа" secondary onPress={() => props.navigate('M06')} />
    </Page>
  );
}
export function Otp(props: ScreenProps) {
  const demo = useDemoAccount();
  const input = useRef<TextInput>(null);
  const [code, setCode] = useState('');
  const [now, setNow] = useState(Date.now);
  const [submitted, setSubmitted] = useState(false);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const challenge = demo.challenge;
  useEffect(() => {
    input.current?.clear();
    setCode('');
    setSubmitted(false);
  }, [challenge?.phone, challenge?.resendAt]);
  const remaining = Math.max(0, Math.ceil(((challenge?.resendAt ?? 0) - now) / 1000));
  const expired = challenge ? now >= challenge.expiresAt : false;
  const canVerify = Boolean(
    challenge && !expired && challenge.attemptsLeft > 0 && code.length === 6,
  );
  const verify = async () => {
    setSubmitted(true);
    if (await demo.verifyCode(code)) props.navigate('M04');
  };
  const resend = async () => {
    if (!challenge) return;
    setSubmitted(true);
    if (await demo.requestCode(challenge.phone)) {
      setNow(Date.now());
      setSubmitted(false);
    }
  };
  return (
    <Page
      props={props}
      title="Подтверждение"
      footer={
        <Button
          title={demo.busy ? 'Входим…' : 'Подтвердить'}
          testID="confirm-otp"
          style={s.authAction}
          disabled={!canVerify || demo.busy || !demo.ready}
          onPress={() => void verify()}
        />
      }
    >
      <Heading style={s.authTitle}>Введите код</Heading>
      <Body muted>
        {challenge
          ? `Тестовый вход для ${formatDemoPhone(challenge.phone)}`
          : 'Укажите номер на предыдущем экране, чтобы начать тестовый вход.'}
      </Body>
      <View style={s.otpRow}>
        <View pointerEvents="none" accessible={false} style={s.otpCells}>
          {Array.from({ length: 6 }, (_, index) => (
            <View key={index} style={[s.otpCell, index === code.length && s.otpCellActive]}>
              <Body style={s.otpDigit}>{code[index] ?? ''}</Body>
            </View>
          ))}
        </View>
        <TextInput
          ref={input}
          testID="otp-input"
          accessibilityLabel="Код подтверждения, 6 цифр"
          defaultValue=""
          editable={
            Boolean(challenge) && !demo.busy && !expired && (challenge?.attemptsLeft ?? 0) > 0
          }
          onChangeText={(value) => {
            setCode(value);
            setSubmitted(false);
          }}
          keyboardType="number-pad"
          underlineColorAndroid="transparent"
          textContentType="oneTimeCode"
          autoComplete="sms-otp"
          autoCorrect={false}
          spellCheck={false}
          smartInsertDelete={false}
          autoCapitalize="none"
          maxLength={6}
          caretHidden
          selectionColor="transparent"
          returnKeyType="done"
          onSubmitEditing={() => canVerify && void verify()}
          style={s.otpInput}
        />
      </View>
      {submitted && demo.error ? (
        <Body testID="demo-auth-error" style={s.authError}>
          {demo.error}
        </Body>
      ) : null}
      {expired ? <Body style={s.authError}>Код истёк. Запросите его повторно.</Body> : null}
      <View style={s.authDemoNote}>
        <Body style={s.authDemoTitle}>Ваш тестовый код: {DEMO_LOGIN_CODE}</Body>
        <Body muted style={s.authDemoText}>
          Введите его вручную. Настоящая SMS и автоматическая подстановка появятся после подключения
          сервиса.
        </Body>
      </View>
      <Button
        title={
          remaining
            ? `Повторить через ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`
            : 'Получить код повторно'
        }
        secondary
        disabled={!challenge || remaining > 0 || demo.busy}
        testID="resend-otp"
        onPress={() => void resend()}
      />
      <Button title="Изменить номер" secondary onPress={() => props.navigate('M02')} />
    </Page>
  );
}
export function Onboarding(props: ScreenProps) {
  const demo = useDemoAccount();
  const [nickname, setNickname] = useState(props.model.nickname);
  const [saved, setSaved] = useState(false);
  useEffect(() => setNickname(props.model.nickname), [props.model.nickname]);
  return (
    <Page
      props={props}
      title="Знакомство"
      footer={
        <>
          <Button
            title="Сохранить и продолжить"
            testID="nickname-save"
            onPress={() => {
              props.model.setNickname(nickname.trim());
              setSaved(true);
              props.navigate('M30');
            }}
          />
          <Button title="Пока пропустить" secondary onPress={() => props.navigate('M06')} />
        </>
      }
    >
      <View style={s.avatar}>
        <Icon name="person-outline" size={36} color={colors.accent} />
      </View>
      <Heading>Как вас{`\n`}называть?</Heading>
      <Body muted>Добавьте ник для своего профиля. Этот шаг можно пропустить.</Body>
      <View style={{ gap: 9 }}>
        <Caption>НИКНЕЙМ · НЕОБЯЗАТЕЛЬНО</Caption>
        <TextInput
          testID="nickname-input"
          accessibilityLabel="Никнейм"
          value={nickname}
          onChangeText={setNickname}
          placeholder="Ваш ник"
          placeholderTextColor={colors.muted}
          autoComplete="nickname"
          autoCapitalize="words"
          maxLength={32}
          style={ui.input}
        />
        <Caption style={{ textAlign: 'right' }}>{nickname.length}/32</Caption>
      </View>
      {demo.account ? (
        <View style={{ gap: 9 }}>
          <Caption>НОМЕР ТЕЛЕФОНА</Caption>
          <Card>
            <Row>
              <Body style={[ui.flex, { fontFamily: font.medium }]}>
                {formatDemoPhone(demo.account.phone)}
              </Body>
              <Icon name="person-circle-outline" color={colors.accent} />
            </Row>
            <Caption>Тестовый профиль на этом устройстве</Caption>
          </Card>
        </View>
      ) : null}
      <Card>
        <Row>
          <View style={ui.flex}>
            <Body>Мой ник на табло</Body>
            <Caption style={{ marginTop: 5 }}>
              По умолчанию в зале виден только номер заказа
            </Caption>
          </View>
          <Switch
            value={false}
            disabled
            accessibilityLabel="Публичный ник на табло, пока недоступно"
            trackColor={{ false: colors.border, true: colors.action }}
          />
        </Row>
      </Card>
      <Notice>
        Сейчас ник сохраняется только на этом устройстве. Публикация на табло откроется после входа
        и отдельного согласия.
      </Notice>
      {saved ? <Body style={{ color: colors.success }}>Ник сохранён на устройстве</Body> : null}
    </Page>
  );
}
export function Qr(props: ScreenProps) {
  return (
    <Page props={props} title="Мой QR">
      <Heading>Ваш Pick Chick{`\n`}под рукой</Heading>
      <Body muted>Показывайте персональный QR на кассе, когда программа Чиков будет доступна.</Body>
      <View style={s.qrCard}>
        <View style={s.qrFrame}>
          <View style={[s.qrCorner, { top: 0, left: 0 }]} />
          <View style={[s.qrCorner, { top: 0, right: 0 }]} />
          <View style={[s.qrCorner, { bottom: 0, left: 0 }]} />
          <View style={[s.qrCorner, { bottom: 0, right: 0 }]} />
          <Icon name="lock-closed-outline" size={58} color={colors.background} />
        </View>
        <Body style={{ color: colors.background, fontFamily: font.bold, textAlign: 'center' }}>
          QR ещё не создан
        </Body>
        <Caption style={{ color: '#56647A', textAlign: 'center' }}>
          Временный QR появится после подключения Чиков
        </Caption>
      </View>
      <Notice warning>
        На экране нет рабочего QR. Код создаётся сервером, действует ограниченное время и
        обновляется при истечении.
      </Notice>
      <Button title="Войти по номеру" secondary onPress={() => props.navigate('M02')} />
    </Page>
  );
}
function ProfileRow({
  title,
  icon,
  value,
  onPress,
  testID,
  orange = false,
  last = false,
}: {
  title: string;
  icon: IconName;
  value?: string;
  onPress?: () => void;
  testID?: string;
  orange?: boolean;
  last?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !onPress }}
      disabled={!onPress}
      testID={testID}
      onPress={onPress}
      style={({ pressed }) => [s.profileRow, !last && s.profileRowDivider, pressed && ui.pressed]}
    >
      <View style={[s.profileRowIcon, orange && s.profileRowIconOrange]}>
        <Icon name={icon} size={18} color={orange ? colors.accent : colors.text} />
      </View>
      <Body style={s.profileRowTitle}>{title}</Body>
      {value ? (
        <Body muted style={s.profileRowValue}>
          {value}
        </Body>
      ) : null}
      {onPress ? <Icon name="chevron-forward" size={16} color={colors.muted} /> : null}
    </Pressable>
  );
}
function ProfileGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={s.profileSection}>
      <Caption style={s.profileSectionTitle}>{title}</Caption>
      <View style={s.profileGroup}>{children}</View>
    </View>
  );
}
export function Profile(props: ScreenProps) {
  const demo = useDemoAccount();
  const insets = useSafeAreaInsets();
  const name = props.model.nickname || (demo.account ? 'Любитель хруста' : 'Гость');
  return (
    <View testID="screen-M30" style={s.profileScreen}>
      <ScrollView
        testID="scroll-M30"
        style={s.profileScroll}
        contentContainerStyle={[
          s.profileContent,
          { paddingTop: insets.top + 10, paddingBottom: Math.max(28, insets.bottom + 16) },
        ]}
        showsVerticalScrollIndicator={false}
      >
        {props.preview ? (
          <View style={{ marginBottom: 16 }}>
            <ReviewBadge />
          </View>
        ) : null}
        <Row style={{ justifyContent: 'space-between' }}>
          <Heading style={s.profileTitle}>Профиль</Heading>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Настройки профиля"
            onPress={() => props.navigate('M34')}
            style={({ pressed }) => [s.profileSettings, pressed && ui.pressed]}
          >
            <Icon name="settings-outline" size={20} />
          </Pressable>
        </Row>
        <View style={s.membershipCard}>
          <Image
            source={require('../../../../design/prototype/assets/mockup/i27.jpg')}
            style={s.membershipImage}
            contentFit="cover"
          />
          <View pointerEvents="none" style={s.membershipShade} />
          <Row style={{ gap: 14 }}>
            <View style={s.membershipAvatar}>
              <Body style={s.membershipInitial}>{name.charAt(0).toUpperCase()}</Body>
            </View>
            <View style={ui.flex}>
              <Body style={s.membershipName}>{name}</Body>
              <Caption style={s.membershipSubtitle}>
                {demo.account ? formatDemoPhone(demo.account.phone) : 'Без входа в аккаунт'}
              </Caption>
              {demo.account ? (
                <Caption style={s.membershipSubtitle}>Тестовый профиль</Caption>
              ) : null}
            </View>
            <View style={s.membershipLogo}>
              <Logo size={42} />
            </View>
          </Row>
          <View style={s.membershipBalanceRow}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Баланс Чиков пока недоступен. Открыть программу лояльности"
              onPress={() => props.navigate('M23')}
              style={{ minHeight: 48 }}
            >
              <Caption style={s.membershipBalanceLabel}>БАЛАНС</Caption>
              <View style={s.membershipBalanceValue}>
                <Body style={s.membershipAmount}>—</Body>
                <Body style={s.membershipCurrency}>Чиков ›</Body>
              </View>
            </Pressable>
            <View style={s.membershipTier}>
              <View style={s.membershipDot} />
              <Body style={s.membershipTierText}>
                {demo.account ? 'Чики скоро' : 'После входа'}
              </Body>
            </View>
          </View>
          <View style={s.membershipProgress} />
          <Body style={s.membershipProgressLabel}>
            Баланс и уровень появятся после подключения Чиков
          </Body>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="QR для кассы. Пока недоступен"
          onPress={() => props.navigate('M29')}
          style={({ pressed }) => [s.profileQrCard, pressed && ui.pressed]}
        >
          <View style={s.profileQrPlaceholder}>
            <Icon name="lock-closed-outline" size={30} color="#56647A" />
            <Caption style={s.profileQrPlaceholderLabel}>Скоро</Caption>
          </View>
          <View style={ui.flex}>
            <Heading style={s.profileQrTitle}>QR для кассы</Heading>
            <Body muted style={s.profileQrDescription}>
              Здесь будет код для начисления Чиков. Программа лояльности пока подключается.
            </Body>
          </View>
        </Pressable>
        <ProfileGroup title="ЛОЯЛЬНОСТЬ">
          <ProfileRow
            title="Мои Чики и уровни"
            icon="ellipse-outline"
            value="—"
            orange
            onPress={() => props.navigate('M23')}
          />
          <ProfileRow
            title="Награды и миссии"
            icon="ribbon-outline"
            onPress={() => props.navigate('M25')}
          />
          <ProfileRow title="Промокоды" icon="ticket-outline" value="Скоро" last />
        </ProfileGroup>
        <View style={s.profileReferral}>
          <Image
            source={require('../../../../design/prototype/assets/mockup/i28.jpg')}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
          />
          <View pointerEvents="none" style={s.profileReferralShade} />
          <View style={ui.flex}>
            <Heading style={s.profileReferralTitle}>Пригласите друга</Heading>
            <Body style={s.profileReferralDescription}>
              Приглашения и подарки появятся с программой Чиков.
            </Body>
          </View>
          <View style={s.profileComingSoon}>
            <Body style={s.profileComingSoonText}>Скоро</Body>
          </View>
        </View>
        <ProfileGroup title="АККАУНТ">
          <ProfileRow
            title="Мои данные"
            icon="person-outline"
            value={props.model.nickname || 'Гость'}
            onPress={() => props.navigate('M04')}
          />
          <ProfileRow
            title="Мои заказы"
            icon="receipt-outline"
            onPress={() => props.navigate('M19')}
          />
          <ProfileRow
            title="Уведомления"
            icon="notifications-outline"
            onPress={() => props.navigate('M34')}
          />
          <ProfileRow
            title="Язык"
            icon="globe-outline"
            value={props.model.locale === 'kk' ? 'Қазақша' : 'Русский'}
            onPress={() => props.navigate('M34')}
            last
          />
        </ProfileGroup>
        <ProfileGroup title="ЕЩЁ">
          <ProfileRow
            title="Наши рестораны"
            icon="location-outline"
            onPress={() => props.navigate('M05')}
          />
          <ProfileRow
            title="Помощь"
            icon="headset-outline"
            onPress={() => props.navigate('M31')}
            last
          />
        </ProfileGroup>
        <Button
          title={demo.account ? 'Выйти из профиля' : 'Войти по номеру'}
          testID={demo.account ? 'demo-sign-out' : 'profile-sign-in'}
          secondary
          disabled={demo.busy || !demo.ready}
          style={s.profileSignIn}
          onPress={() => {
            if (!demo.account) props.navigate('M02');
            else
              void demo.signOut().then((success) => {
                if (success) props.model.setNickname('');
              });
          }}
        />
        {demo.error ? <Body style={[s.authError, { marginTop: 12 }]}>{demo.error}</Body> : null}
        {demo.account ? (
          <Caption style={s.profileVersion}>
            Тестовые заказы привязаны к устройству. Вход по номеру не открывает чужую историю.
          </Caption>
        ) : null}
        <Caption style={s.profileVersion}>Pick Chick · приложение в тестировании</Caption>
        <View style={s.profileLegalLinks}>
          <Pressable
            accessibilityRole="button"
            onPress={() => props.navigate('M33')}
            style={s.profileLegalLink}
          >
            <Caption>Условия и конфиденциальность</Caption>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={() => props.navigate('M32')}
            style={s.profileLegalLink}
          >
            <Caption>Управление данными</Caption>
          </Pressable>
        </View>
        {!props.preview && props.openReview ? (
          <View style={[s.profileGroup, { marginTop: 14 }]}>
            <ProfileRow
              testID="open-design-review"
              title="Все экраны дизайна"
              icon="color-palette-outline"
              onPress={props.openReview}
              last
            />
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}
export function Support(props: ScreenProps) {
  const [message, setMessage] = useState('');
  return (
    <Page props={props} title="Помощь">
      <Heading>Мы рядом</Heading>
      <Body muted>
        Расскажите, что случилось. После подключения поддержки обращение будет связано с вашим
        заказом.
      </Body>
      <Card>
        <Row>
          <View style={s.supportIcon}>
            <Icon name="chatbubbles-outline" color={colors.accent} size={28} />
          </View>
          <View style={ui.flex}>
            <Heading small>Поддержка Pick Chick</Heading>
            <Caption>Отправка сообщений скоро появится</Caption>
          </View>
        </Row>
      </Card>
      <Caption>СООБЩЕНИЕ · ЛОКАЛЬНЫЙ ЧЕРНОВИК</Caption>
      <TextInput
        testID="support-draft"
        accessibilityLabel="Черновик сообщения, отправка недоступна"
        value={message}
        onChangeText={setMessage}
        multiline
        maxLength={2000}
        textAlignVertical="top"
        placeholder="Опишите ситуацию. Не указывайте пароли и данные карты."
        placeholderTextColor={colors.muted}
        style={[ui.input, { minHeight: 148 }]}
      />
      <Caption style={{ textAlign: 'right' }}>{message.length}/2000</Caption>
      <Button title="Отправка пока недоступна" disabled />
      <Notice>
        Этот текст никуда не отправляется и исчезнет после закрытия экрана. Для вопроса о покупке
        обратитесь к сотруднику ресторана.
      </Notice>
      <NavRow
        title="Неясен результат оплаты?"
        subtitle="Не оплачивайте тот же заказ повторно"
        onPress={() => props.navigate('M14')}
      />
    </Page>
  );
}
export function DeleteAccount(props: ScreenProps) {
  const demo = useDemoAccount();
  const [cleared, setCleared] = useState(false);
  const [confirmVisible, setConfirmVisible] = useState(false);
  const clearPreferences = () => {
    void demo.signOut().then((success) => {
      if (!success) return;
      props.model.resetLocalData();
      setConfirmVisible(false);
      setCleared(true);
    });
  };
  const reset = () => {
    if (Platform.OS === 'web') {
      setConfirmVisible(true);
      return;
    }
    Alert.alert(
      'Очистить данные устройства?',
      'Будут удалены тестовый профиль, номер, ник и корзина на устройстве. Тестовые заказы и незавершённые запросы сохранятся.',
      [
        { text: 'Оставить', style: 'cancel' },
        {
          text: 'Очистить',
          style: 'destructive',
          onPress: clearPreferences,
        },
      ],
    );
  };
  return (
    <Page props={props} title="Управление данными">
      {Platform.OS === 'web' ? (
        <Modal
          visible={confirmVisible}
          transparent
          animationType="none"
          onRequestClose={() => setConfirmVisible(false)}
        >
          <View style={s.confirmBackdrop}>
            <View testID="local-clear-confirmation" accessibilityViewIsModal style={s.confirmCard}>
              <Heading small>Очистить данные устройства?</Heading>
              <Body>
                Тестовый профиль, номер, ник, корзина и локальные настройки будут очищены. Тестовый
                сеанс, незавершённые запросы и серверная история заказов останутся.
              </Body>
              <Button title="Оставить данные" secondary onPress={() => setConfirmVisible(false)} />
              <Button
                title="Очистить"
                testID="confirm-clear-local-data"
                onPress={clearPreferences}
              />
            </View>
          </View>
        </Modal>
      ) : null}
      <Heading>Всё под вашим{`\n`}контролем</Heading>
      <Card>
        <Heading small>Аккаунт</Heading>
        <Body muted>
          {demo.account
            ? 'Ваш тестовый профиль хранится на этом устройстве. Можно удалить номер и выйти; заказы этого устройства сохранятся.'
            : 'Тестового профиля на устройстве нет. Регистрация с настоящей SMS готовится.'}
        </Body>
        <Button
          title="Удалить тестовый профиль"
          testID="delete-demo-profile"
          disabled={!demo.account || demo.busy}
          onPress={() =>
            void demo.signOut().then((success) => {
              if (success) props.model.setNickname('');
            })
          }
        />
      </Card>
      <Card>
        <Heading small>На этом устройстве</Heading>
        <Body muted>
          Можно очистить тестовый профиль, номер, ник и корзину. История тестовых заказов и
          незавершённые запросы сохранятся.
        </Body>
        <Button
          title="Очистить локальные данные"
          secondary
          testID="clear-local-data"
          onPress={reset}
        />
      </Card>
      {demo.error ? <Body style={s.authError}>{demo.error}</Body> : null}
      {cleared ? <Notice title="Готово">Локальные данные очищены.</Notice> : null}
      <Caption>
        Когда появится аккаунт, удалить его можно будет здесь после подтверждения личности.
        Обязательные сроки хранения документов будут описаны в политике.
      </Caption>
    </Page>
  );
}
export function Legal(props: ScreenProps) {
  const [opened, setOpened] = useState<string | null>(null);
  const documents = ['Условия заказа', 'Политика конфиденциальности', 'Правила программы Чиков'];
  return (
    <Page props={props} title="Документы">
      <Heading>Открыто{`\n`}и понятно</Heading>
      <Body muted>Здесь будут актуальные документы Pick Chick и дата каждой версии.</Body>
      <View>
        {documents.map((title) => (
          <View key={title}>
            <NavRow
              title={title}
              subtitle="На подготовке"
              icon={opened === title ? 'chevron-up' : 'chevron-down'}
              onPress={() => setOpened(opened === title ? null : title)}
            />
            {opened === title ? (
              <Notice>
                Документ ещё не утверждён и не опубликован компанией Pick Chick. Здесь нет
                действующей оферты или условий программы.
              </Notice>
            ) : null}
          </View>
        ))}
      </View>
      <Notice warning>
        Пока документы, вход и оплата готовятся, приложение доступно для тестирования меню и
        дизайна.
      </Notice>
      <Card>
        <Heading small>Данные этой версии</Heading>
        <Body muted>
          Номер тестового профиля, ник и корзина хранятся только на устройстве. Тестовый код не
          подтверждает владение номером; SMS не отправляется. Тестовые заказы хранятся на сервере
          отдельно от номера. Реальные платежи и бонусные операции не выполняются.
        </Body>
        <NavRow title="Управлять локальными данными" onPress={() => props.navigate('M32')} />
      </Card>
    </Page>
  );
}
export function Settings(props: ScreenProps) {
  return (
    <Page props={props} title="Язык и уведомления">
      <Heading small>Язык приложения</Heading>
      <Card>
        <Pressable
          accessibilityRole="radio"
          accessibilityState={{ selected: true }}
          onPress={() => props.model.setLocale('ru')}
          style={s.settingRow}
        >
          <Body style={ui.flex}>Русский</Body>
          <Icon name="checkmark-circle" color={colors.accent} />
        </Pressable>
        <View style={s.settingDivider} />
        <Pressable
          disabled
          accessibilityRole="radio"
          accessibilityState={{ selected: false, disabled: true }}
          style={s.settingRow}
        >
          <View style={ui.flex}>
            <Body>Қазақша</Body>
            <Caption>Перевод готовится</Caption>
          </View>
          <Icon name="lock-closed-outline" color={colors.muted} />
        </Pressable>
      </Card>
      <Heading small>Уведомления</Heading>
      <Card>
        {[
          { title: 'О моих заказах', detail: 'Статус приготовления и выдачи' },
          { title: 'События и предложения', detail: 'Только с вашего отдельного согласия' },
        ].map((setting) => (
          <Row key={setting.title} style={{ paddingVertical: 8 }}>
            <View style={ui.flex}>
              <Body>{setting.title}</Body>
              <Caption style={{ marginTop: 4 }}>{setting.detail}</Caption>
            </View>
            <Switch
              value={false}
              disabled
              accessibilityLabel={`${setting.title}, пока недоступно`}
              trackColor={{ false: colors.border, true: colors.action }}
            />
          </Row>
        ))}
      </Card>
      <Notice>
        Push-уведомления появятся после подключения сервиса и входа. Сейчас приложение не
        запрашивает разрешение на рекламные уведомления.
      </Notice>
      <NavRow
        title="Конфиденциальность"
        subtitle="Как будут обрабатываться согласия"
        onPress={() => props.navigate('M33')}
      />
    </Page>
  );
}
export function Rating(props: ScreenProps) {
  const [rating, setRating] = useState(0);
  const [message, setMessage] = useState('');
  return (
    <Page props={props} title="Как всё прошло?">
      <View style={s.ratingHero}>
        <Icon name="heart-outline" size={54} color={colors.accent} />
        <Heading style={{ textAlign: 'center' }}>Было хрустяще?</Heading>
        <Body muted style={{ textAlign: 'center' }}>
          {props.preview
            ? 'Оцените пример заказа №083'
            : 'Отзыв появится здесь после получения заказа'}
        </Body>
      </View>
      <Row style={{ justifyContent: 'center', gap: 5 }}>
        {[1, 2, 3, 4, 5].map((value) => (
          <Pressable
            key={value}
            testID={`rating-${value}`}
            accessibilityRole="radio"
            accessibilityState={{ selected: rating === value, disabled: !props.preview }}
            accessibilityLabel={`${value} из 5`}
            disabled={!props.preview}
            onPress={() => setRating(value)}
            style={s.starButton}
          >
            <Icon
              name={value <= rating ? 'star' : 'star-outline'}
              size={32}
              color={colors.accent}
            />
          </Pressable>
        ))}
      </Row>
      <TextInput
        value={message}
        onChangeText={setMessage}
        editable={props.preview}
        testID="rating-comment"
        accessibilityLabel="Комментарий к оценке"
        maxLength={2000}
        multiline
        placeholder="Что особенно понравилось?"
        placeholderTextColor={colors.muted}
        textAlignVertical="top"
        style={[ui.input, { minHeight: 125 }]}
      />
      <Button title="Отправка пока недоступна" disabled />
      <Notice>
        Оценка в просмотре дизайна не отправляется. Реальный отзыв можно оставить только после
        выданного заказа.
      </Notice>
      <Button title="Нужна помощь с заказом" secondary onPress={() => props.navigate('M31')} />
    </Page>
  );
}
export function UnknownScreen(props: ScreenProps) {
  return (
    <Page props={props} title="Pick Chick">
      <Empty
        title="Экран не найден"
        detail="Вернитесь к меню и продолжите знакомство."
        action={<Button title="В меню" onPress={() => props.navigate('M06')} />}
      />
    </Page>
  );
}
const s = StyleSheet.create({
  profileScreen: { flex: 1, minHeight: 0, backgroundColor: colors.background },
  profileScroll: { flex: 1, minHeight: 0 },
  profileContent: { paddingHorizontal: 18 },
  profileTitle: { fontFamily: font.display, fontSize: 34, lineHeight: 44, letterSpacing: -0.68 },
  profileSettings: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  membershipCard: {
    marginTop: 16,
    padding: 20,
    borderRadius: 26,
    overflow: 'hidden',
    backgroundColor: '#0B4FC4',
  },
  membershipImage: {
    position: 'absolute',
    width: 640,
    height: 494,
    left: '50%',
    top: '50%',
    transform: [{ translateX: -320 }, { translateY: -247 }],
  },
  membershipShade: {
    ...StyleSheet.absoluteFill,
    ...(Platform.OS === 'web'
      ? { backgroundImage: 'linear-gradient(rgba(0,40,110,0.74), rgba(0,26,80,0.9))' }
      : {
          experimental_backgroundImage: 'linear-gradient(rgba(0,40,110,0.74), rgba(0,26,80,0.9))',
        }),
  },
  membershipAvatar: {
    width: 54,
    height: 54,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FFFFFF29',
  },
  membershipInitial: { fontFamily: font.display, fontSize: 23, lineHeight: 30, color: '#FFFFFF' },
  membershipName: {
    fontFamily: font.display,
    fontSize: 23,
    lineHeight: 26,
    color: '#FFFFFF',
    letterSpacing: -0.23,
  },
  membershipSubtitle: { marginTop: 3, fontSize: 13, lineHeight: 18, color: '#FFFFFFB3' },
  membershipLogo: {
    width: 42,
    height: 42,
    borderRadius: 13,
    overflow: 'hidden',
    backgroundColor: '#FFFFFF24',
  },
  membershipBalanceRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: 12,
    marginTop: 18,
  },
  membershipBalanceLabel: {
    fontFamily: font.bold,
    fontSize: 11.5,
    lineHeight: 16,
    letterSpacing: 0.92,
    color: '#FFFFFF9E',
  },
  membershipBalanceValue: { flexDirection: 'row', alignItems: 'baseline', gap: 7, marginTop: 5 },
  membershipAmount: {
    fontFamily: font.display,
    fontSize: 34,
    lineHeight: 38,
    color: colors.accent,
  },
  membershipCurrency: {
    fontFamily: font.medium,
    fontSize: 13.5,
    lineHeight: 20,
    color: '#FFFFFFD1',
  },
  membershipTier: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingVertical: 8,
    paddingHorizontal: 13,
    borderRadius: 20,
    backgroundColor: '#FFFFFF29',
  },
  membershipDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.accent },
  membershipTierText: { fontFamily: font.bold, fontSize: 12.5, lineHeight: 18, color: '#FFFFFF' },
  membershipProgress: { height: 8, marginTop: 18, borderRadius: 4, backgroundColor: '#FFFFFF33' },
  membershipProgressLabel: { marginTop: 9, fontSize: 12, lineHeight: 17, color: '#FFFFFFB8' },
  profileQrCard: {
    marginTop: 14,
    padding: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    borderRadius: 22,
    backgroundColor: colors.surface,
  },
  profileQrPlaceholder: {
    width: 94,
    height: 94,
    borderRadius: 14,
    padding: 8,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: '#FFFFFF',
  },
  profileQrPlaceholderLabel: { fontSize: 9, lineHeight: 13, color: '#56647A', textAlign: 'center' },
  profileQrTitle: { fontFamily: font.display, fontSize: 16, lineHeight: 22, letterSpacing: -0.16 },
  profileQrDescription: { marginTop: 5, fontSize: 12.5, lineHeight: 18 },
  profileSection: { marginTop: 22 },
  profileSectionTitle: {
    paddingLeft: 4,
    marginBottom: 9,
    fontFamily: font.bold,
    fontSize: 12,
    lineHeight: 17,
    letterSpacing: 0.72,
  },
  profileGroup: { borderRadius: 20, backgroundColor: colors.surface, overflow: 'hidden' },
  profileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 13,
    paddingVertical: 14,
    paddingHorizontal: 16,
    minHeight: 64,
  },
  profileRowDivider: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  profileRowIcon: {
    width: 36,
    height: 36,
    borderRadius: 12,
    backgroundColor: colors.raised,
    alignItems: 'center',
    justifyContent: 'center',
  },
  profileRowIconOrange: { backgroundColor: '#FF7A3D1F' },
  profileRowTitle: { flex: 1, fontFamily: font.medium, fontSize: 15, lineHeight: 21 },
  profileRowValue: { flexShrink: 1, maxWidth: '35%', fontSize: 13.5, lineHeight: 20 },
  profileReferral: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    padding: 18,
    borderRadius: 22,
    overflow: 'hidden',
    marginTop: 14,
    backgroundColor: '#0B4FC4',
  },
  profileReferralShade: {
    ...StyleSheet.absoluteFill,
    ...(Platform.OS === 'web'
      ? { backgroundImage: 'linear-gradient(rgba(11,79,196,0.55), rgba(11,79,196,0.8))' }
      : {
          experimental_backgroundImage:
            'linear-gradient(rgba(11,79,196,0.55), rgba(11,79,196,0.8))',
        }),
  },
  profileReferralTitle: {
    fontFamily: font.display,
    fontSize: 17,
    lineHeight: 23,
    letterSpacing: -0.17,
    color: '#FFB48A',
  },
  profileReferralDescription: { marginTop: 4, fontSize: 13, lineHeight: 19, color: '#FFFFFFD9' },
  profileComingSoon: {
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderRadius: 21,
    backgroundColor: '#FF7A3D33',
  },
  profileComingSoonText: { fontFamily: font.bold, fontSize: 14, lineHeight: 20, color: '#FFB48A' },
  profileSignIn: { marginTop: 14, borderRadius: 20 },
  profileVersion: { marginTop: 18, textAlign: 'center', fontSize: 12.5, lineHeight: 20 },
  profileLegalLinks: { alignItems: 'center' },
  profileLegalLink: { paddingVertical: 12, minHeight: 44, justifyContent: 'center' },
  confirmBackdrop: {
    flex: 1,
    padding: 24,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#000000AA',
  },
  confirmCard: {
    width: '100%',
    maxWidth: 440,
    padding: 24,
    gap: 20,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  avatar: {
    width: 76,
    height: 76,
    borderRadius: 28,
    backgroundColor: colors.raised,
    alignItems: 'center',
    justifyContent: 'center',
  },
  authAction: { backgroundColor: colors.action },
  authTitle: { fontFamily: font.display, fontSize: 34, lineHeight: 42, letterSpacing: -0.68 },
  authError: { color: '#FFB0AB', fontSize: 14, lineHeight: 21 },
  authDemoNote: { padding: 16, gap: 6, borderRadius: 16, backgroundColor: colors.surface },
  authDemoTitle: { fontFamily: font.bold, fontSize: 14, lineHeight: 20 },
  authDemoText: { fontSize: 13.5, lineHeight: 21 },
  phonePrefix: {
    fontFamily: font.heading,
    fontSize: 26,
    lineHeight: 36,
    color: colors.muted,
  },
  phoneNumber: {
    flex: 1,
    minWidth: 0,
    minHeight: 72,
    paddingVertical: 14,
    fontFamily: font.heading,
    fontSize: 25,
    lineHeight: 36,
    color: colors.text,
  },
  phoneInput: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 16,
    paddingHorizontal: 16,
  },
  phoneDivider: { height: 24, width: 1, backgroundColor: colors.border },
  otpRow: { position: 'relative', marginVertical: 8 },
  otpCells: { flexDirection: 'row', gap: 7 },
  otpDigit: { fontFamily: font.heading, fontSize: 26, lineHeight: 36 },
  otpCellActive: { borderColor: colors.action, borderWidth: 2 },
  otpInput: {
    ...StyleSheet.absoluteFill,
    fontSize: 26,
    color: 'transparent',
    backgroundColor: 'transparent',
  },
  otpCell: {
    flex: 1,
    minHeight: 63,
    backgroundColor: colors.surface,
    borderRadius: 13,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  qrCard: {
    padding: 26,
    backgroundColor: '#F2F6FF',
    borderRadius: 26,
    alignItems: 'center',
    gap: 20,
    marginVertical: 6,
  },
  qrFrame: { width: 180, height: 180, alignItems: 'center', justifyContent: 'center', margin: 5 },
  qrCorner: {
    position: 'absolute',
    width: 46,
    height: 46,
    borderWidth: 6,
    borderRadius: 10,
    borderColor: '#D0D9E8',
  },
  supportIcon: {
    width: 52,
    height: 52,
    borderRadius: 18,
    backgroundColor: colors.raised,
    alignItems: 'center',
    justifyContent: 'center',
  },
  settingRow: { minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: 12 },
  settingDivider: { height: 1, backgroundColor: colors.border },
  ratingHero: { gap: 20, alignItems: 'center', paddingVertical: 20 },
  starButton: { width: 52, minHeight: 56, alignItems: 'center', justifyContent: 'center' },
});
