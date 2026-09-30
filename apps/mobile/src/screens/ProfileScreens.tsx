import { MotionPressable as Pressable, MotionModal as Modal } from '../components/Motion';
import { useState } from 'react';
import * as Linking from 'expo-linking';
import { Alert, Platform, ScrollView, StyleSheet, Switch, TextInput, View } from 'react-native';
import { colors } from '../theme';
import type { ScreenProps } from '../model';
import { useAccount } from '../useAccount';
export { Phone, Otp } from './AuthScreens';
export { Onboarding } from './RegistrationScreen';
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

export { Profile } from './ProfileScreen';

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
        defaultValue=""
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
  const demo = useAccount();
  const [deleteConfirmVisible, setDeleteConfirmVisible] = useState(false);
  const [cleared, setCleared] = useState(false);
  const [confirmVisible, setConfirmVisible] = useState(false);
  const clearDescription =
    demo.mode === 'server'
      ? 'Будет выполнен выход на этом устройстве, локальные настройки и корзина будут очищены. Аккаунт на сервере и незавершённые запросы заказа сохранятся.'
      : 'С устройства будут удалены профиль, номер, ник, дата рождения, пол и корзина. Заказы и незавершённые запросы сохранятся.';
  const clearPreferences = () => {
    if (props.preview) return;
    void demo.signOut().then((success) => {
      if (!success) return;
      props.model.resetLocalData();
      setConfirmVisible(false);
      setCleared(true);
    });
  };
  const reset = () => {
    if (props.preview) return;
    if (Platform.OS === 'web') {
      setConfirmVisible(true);
      return;
    }
    Alert.alert('Очистить данные устройства?', clearDescription, [
      { text: 'Оставить', style: 'cancel' },
      {
        text: 'Очистить',
        style: 'destructive',
        onPress: clearPreferences,
      },
    ]);
  };
  return (
    <Page props={props} title="Управление данными">
      <Modal
        visible={deleteConfirmVisible}
        transparent
        animationType="none"
        onRequestClose={() => setDeleteConfirmVisible(false)}
      >
        <ScrollView style={{ flex: 1 }} contentContainerStyle={s.confirmBackdrop}>
          <View testID="server-delete-confirmation" accessibilityViewIsModal style={s.confirmCard}>
            <Heading small>Удалить аккаунт Pick Chick?</Heading>
            <Body>
              Профиль и доступ на всех ваших устройствах будут удалены. Необходимые документы по
              заказам обрабатываются по политике хранения данных.
            </Body>
            <Button
              title="Оставить аккаунт"
              secondary
              disabled={demo.busy}
              onPress={() => setDeleteConfirmVisible(false)}
            />
            <Button
              title={demo.busy ? 'Удаляем…' : 'Удалить аккаунт'}
              testID="confirm-server-delete"
              disabled={props.preview || demo.busy}
              onPress={() => {
                void demo.deleteAccount().then((success) => {
                  if (success) {
                    props.model.setNickname('');
                    setDeleteConfirmVisible(false);
                  }
                });
              }}
            />
            {demo.error ? <Body style={s.authError}>{demo.error}</Body> : null}
          </View>
        </ScrollView>
      </Modal>
      {Platform.OS === 'web' ? (
        <Modal
          visible={confirmVisible}
          transparent
          animationType="none"
          onRequestClose={() => setConfirmVisible(false)}
        >
          <ScrollView style={{ flex: 1 }} contentContainerStyle={s.confirmBackdrop}>
            <View testID="local-clear-confirmation" accessibilityViewIsModal style={s.confirmCard}>
              <Heading small>Очистить данные устройства?</Heading>
              <Body>{clearDescription}</Body>
              <Button title="Оставить данные" secondary onPress={() => setConfirmVisible(false)} />
              <Button
                title="Очистить"
                testID="confirm-clear-local-data"
                onPress={clearPreferences}
              />
            </View>
          </ScrollView>
        </Modal>
      ) : null}
      <Heading>Всё под вашим{`\n`}контролем</Heading>
      <Card>
        <Heading small>Аккаунт</Heading>
        <Body muted>
          {demo.mode === 'server'
            ? demo.account
              ? 'Данные хранятся в вашем аккаунте. Удаление уберёт профиль и отзовёт доступ на всех устройствах.'
              : 'Войдите по своему номеру, чтобы управлять аккаунтом.'
            : demo.account
              ? 'Ваш профиль хранится на этом устройстве. Можно удалить номер, дату рождения и другие данные профиля; заказы этого устройства сохранятся.'
              : 'Профиля на устройстве нет. Регистрация с настоящей SMS готовится.'}
        </Body>
        <Button
          title={demo.mode === 'server' ? 'Удалить аккаунт' : 'Удалить профиль на устройстве'}
          testID="delete-demo-profile"
          disabled={props.preview || !demo.ready || !demo.account || demo.busy}
          onPress={() => {
            if (props.preview) return;
            if (demo.mode === 'server') {
              setDeleteConfirmVisible(true);
              return;
            }
            void demo.deleteAccount().then((success) => {
              if (success) props.model.setNickname('');
            });
          }}
        />
      </Card>
      <Card>
        <Heading small>На этом устройстве</Heading>
        <Body muted>
          {demo.mode === 'server'
            ? 'Очистка локальных настроек выполнит выход на этом устройстве. Сам аккаунт сохранится. Незавершённые запросы заказа сохраняются отдельно.'
            : 'Можно очистить профиль на устройстве, номер, ник, дату рождения, пол и корзину. История заказов и незавершённые запросы сохранятся.'}
        </Body>
        <Button
          title="Очистить локальные данные"
          secondary
          testID="clear-local-data"
          disabled={props.preview || !demo.ready || demo.busy}
          onPress={reset}
        />
      </Card>
      {demo.error ? <Body style={s.authError}>{demo.error}</Body> : null}
      {cleared ? <Notice title="Готово">Локальные данные очищены.</Notice> : null}
      {demo.mode === 'demo' ? (
        <Caption>
          Когда появится аккаунт, удалить его можно будет здесь после подтверждения личности.
          Обязательные сроки хранения документов будут описаны в политике.
        </Caption>
      ) : null}
    </Page>
  );
}
export function Legal(props: ScreenProps) {
  const account = useAccount();
  const [linkError, setLinkError] = useState(false);
  const [opened, setOpened] = useState<string | null>(null);
  const documents = ['Условия заказа', 'Политика конфиденциальности', 'Правила программы Чиков'];
  if (account.mode === 'server')
    return (
      <Page props={props} title="Документы">
        <Heading>Открыто{`\n`}и понятно</Heading>
        {account.legal ? (
          <>
            <Body muted>Документы Pick Chick · версия {account.legal.version}</Body>
            {[
              { title: 'Условия заказа', url: account.legal.termsUrl },
              { title: 'Политика конфиденциальности', url: account.legal.privacyUrl },
            ].map((document) => (
              <NavRow
                key={document.title}
                title={document.title}
                subtitle="Открыть документ"
                icon="open-outline"
                onPress={() => {
                  if (!props.preview) {
                    setLinkError(false);
                    void Linking.openURL(document.url).catch(() => setLinkError(true));
                  }
                }}
              />
            ))}
          </>
        ) : (
          <Notice>
            Документы ещё не опубликованы. Вход по SMS станет доступен после их утверждения.
          </Notice>
        )}
        {linkError ? (
          <Notice warning>
            Не удалось открыть документ. Проверьте подключение и попробуйте ещё раз.
          </Notice>
        ) : null}
        <Body muted>
          Согласие на сообщения об акциях запрашивается отдельно. Для регистрации оно не требуется.
        </Body>
        <NavRow title="Управлять аккаунтом и данными" onPress={() => props.navigate('M32')} />
      </Page>
    );
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
        Оплата и чеки - в процессе подключения. В приложении можно выбрать блюда и следить за
        заказом.
      </Notice>
      <Card>
        <Heading small>Данные этой версии</Heading>
        <Body muted>
          Номер профиля, ник, дата рождения, пол и корзина хранятся только на устройстве. Код входа
          не подтверждает владение номером; SMS не отправляется. Заказы хранятся на сервере отдельно
          от номера. Реальные платежи и бонусные операции не выполняются.
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
        defaultValue=""
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
  confirmBackdrop: {
    flexGrow: 1,
    paddingHorizontal: 24,
    paddingVertical: 48,
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
  authError: { color: '#FFB0AB', fontSize: 14, lineHeight: 21 },
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
