import { useState } from 'react';
import { Alert, Pressable, StyleSheet, Switch, TextInput, View } from 'react-native';
import { colors, font } from '../theme';
import type { ScreenProps } from '../model';
import { FeatureTile, LoyaltyCard } from '../components/Brand';
import {
  Body,
  Button,
  Caption,
  Card,
  Empty,
  Heading,
  Icon,
  NavRow,
  Notice,
  Page,
  Row,
  styles as ui,
} from '../components/UI';

export function Phone(props: ScreenProps) {
  return (
    <Page props={props} title="Вход">
      <View style={s.avatar}>
        <Icon name="phone-portrait-outline" size={36} color={colors.accent} />
      </View>
      <Heading>Ваш номер —{`\n`}ключ к любимому</Heading>
      <Body muted>Отправим код, чтобы сохранять ваши заказы и Чики.</Body>
      <View style={{ gap: 10 }}>
        <Caption>НОМЕР ТЕЛЕФОНА</Caption>
        <View style={s.phoneInput}>
          <Body style={{ fontFamily: font.bold }}>KZ +7</Body>
          <View style={s.phoneDivider} />
          <TextInput
            accessibilityLabel="Номер телефона, ввод пока недоступен"
            testID="phone-input-disabled"
            editable={false}
            placeholder="7__ ___ __ __"
            placeholderTextColor={colors.muted}
            keyboardType="phone-pad"
            style={[ui.input, { flex: 1, borderWidth: 0, paddingHorizontal: 0 }]}
          />
        </View>
      </View>
      <Button title="Получить код" disabled testID="request-otp-disabled" />
      <Notice warning title="Вход пока подключается">
        SMS-сервис ещё не готов. Номер сейчас не запрашиваем и не отправляем.
      </Notice>
      <Caption>После подключения вход будет доступен по казахстанскому мобильному номеру.</Caption>
      <NavRow title="Условия и конфиденциальность" onPress={() => props.navigate('M33')} />
      <Button title="Продолжить без входа" secondary onPress={() => props.navigate('M06')} />
    </Page>
  );
}
export function Otp(props: ScreenProps) {
  return (
    <Page props={props} title="Подтверждение">
      <Heading>Код из SMS</Heading>
      <Body muted>
        {props.preview
          ? 'Так будет выглядеть подтверждение номера.'
          : 'Запроса на отправку кода пока нет.'}
      </Body>
      <View style={s.otpRow}>
        {Array.from({ length: 6 }, (_, index) => (
          <View key={index} style={s.otpCell}>
            <Body style={{ fontSize: 25, color: colors.muted }}>—</Body>
          </View>
        ))}
      </View>
      <TextInput
        testID="otp-input-disabled"
        accessibilityLabel="Код из SMS, ввод пока недоступен"
        editable={false}
        placeholder="Код подтверждения"
        placeholderTextColor={colors.muted}
        keyboardType="number-pad"
        textContentType="oneTimeCode"
        autoComplete="sms-otp"
        maxLength={6}
        style={ui.input}
      />
      <Button title="Подтвердить номер" disabled />
      <Button title="Отправить код повторно" secondary disabled />
      <Notice warning>
        SMS-провайдер ещё не подключён. Проверка кода и регистрация не выполняются.
      </Notice>
      <Button title="Назад к номеру" secondary onPress={() => props.navigate('M02')} />
    </Page>
  );
}
export function Onboarding(props: ScreenProps) {
  const [nickname, setNickname] = useState(props.model.nickname);
  const [saved, setSaved] = useState(false);
  return (
    <Page props={props} title="Знакомство">
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
          Здесь появится временный код после входа
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
export function Profile(props: ScreenProps) {
  return (
    <Page props={props} title="Профиль" noBack>
      <Row>
        <View style={ui.flex}>
          <Caption>ЛИЧНЫЙ КАБИНЕТ</Caption>
          <Heading style={{ marginTop: 5 }}>
            Привет,{`\n`}
            {props.model.nickname || 'гость'}!
          </Heading>
        </View>
        <View style={s.avatar}>
          <Icon name="person-outline" size={34} color={colors.accent} />
        </View>
      </Row>
      <Body muted>Твой вкус. Твои Чики. Твой пик.</Body>
      <LoyaltyCard preview={props.preview} onPress={() => props.navigate('M23')} />
      <Row>
        <FeatureTile
          title="Мой QR"
          subtitle="Показать на кассе"
          icon="qr-code-outline"
          onPress={() => props.navigate('M29')}
        />
        <FeatureTile
          title="Мои награды"
          subtitle="На пути к новому пику"
          icon="star-outline"
          orange
          onPress={() => props.navigate('M25')}
        />
      </Row>
      <View>
        <NavRow
          title="Мои заказы"
          subtitle="История и чеки"
          onPress={() => props.navigate('M19')}
        />
        <NavRow
          title="Личные данные"
          subtitle="Ник на этом устройстве"
          onPress={() => props.navigate('M04')}
        />
        <NavRow
          title="Уведомления и язык"
          subtitle="Русский · настройки push"
          onPress={() => props.navigate('M34')}
        />
        <NavRow title="Помощь" subtitle="Мы рядом" onPress={() => props.navigate('M31')} />
        <NavRow
          title="Документы"
          subtitle="Условия и конфиденциальность"
          onPress={() => props.navigate('M33')}
        />
        <NavRow
          title="Управление данными"
          subtitle="Аккаунт и данные устройства"
          onPress={() => props.navigate('M32')}
        />
      </View>
      <Button title="Войти по номеру" secondary onPress={() => props.navigate('M02')} />
      <Caption style={{ textAlign: 'center' }}>Pick Chick · приложение в тестировании</Caption>
    </Page>
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
  const [cleared, setCleared] = useState(false);
  const reset = () =>
    Alert.alert(
      'Очистить данные устройства?',
      'Будут удалены локальный ник и корзина. Серверного аккаунта в этой версии ещё нет.',
      [
        { text: 'Оставить', style: 'cancel' },
        {
          text: 'Очистить',
          style: 'destructive',
          onPress: () => {
            props.model.resetLocalData();
            setCleared(true);
          },
        },
      ],
    );
  return (
    <Page props={props} title="Управление данными">
      <Heading>Всё под вашим{`\n`}контролем</Heading>
      <Card>
        <Heading small>Аккаунт</Heading>
        <Body muted>Вы не вошли в аккаунт. Регистрация по номеру ещё не подключена.</Body>
        <Button title="Удалить аккаунт" disabled />
      </Card>
      <Card>
        <Heading small>На этом устройстве</Heading>
        <Body muted>
          Можно очистить локальный ник и корзину. Эти данные не являются банковскими операциями или
          историей заказов.
        </Body>
        <Button
          title="Очистить локальные данные"
          secondary
          testID="clear-local-data"
          onPress={reset}
        />
      </Card>
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
          Корзина и ник хранятся локально. Телефон не запрашивается; платежи и бонусные операции не
          выполняются.
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
  avatar: {
    width: 76,
    height: 76,
    borderRadius: 28,
    backgroundColor: colors.raised,
    alignItems: 'center',
    justifyContent: 'center',
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
  otpRow: { flexDirection: 'row', gap: 7, marginVertical: 20 },
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
