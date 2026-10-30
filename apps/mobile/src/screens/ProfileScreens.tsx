import { TextInput } from '../components/LocalizedText';
import { useNotifications } from '../notifications/provider';
import { t, localize, useLocale } from '../i18n';
import { MotionPressable as Pressable, MotionModal as Modal } from '../components/Motion';
import { useState } from 'react';
import { useRouter } from 'expo-router';
import * as Linking from 'expo-linking';
import { Alert, Platform, ScrollView, StyleSheet, Switch, View } from 'react-native';
import { colors } from '../theme';
import type { ScreenProps } from '../model';
import { useAccount } from '../useAccount';
import { SupportContact } from '../components/SupportContact';
import { pushSettingsShown } from '../store-build';
import { restaurantLocation } from '../restaurant-location';
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

// App Store audit 14.10: the screen offered a draft form that sent nothing. It now shows the
// build's real contact (EXPO_PUBLIC_SUPPORT_URL) or sends the customer to the restaurant staff.
export function Support(props: ScreenProps) {
  useLocale();
  const location = restaurantLocation(props.model.branch?.id);
  return (
    <Page props={props} title={t('Помощь')}>
      <Heading>{t('Мы рядом')}</Heading>
      <Body muted>
        {t(
          'Вопрос по заказу или оплате? Подойдите к кассе ресторана и назовите номер заказа. Никому не сообщайте код входа.',
        )}
      </Body>
      {/* Review 29.10.2026: the card looked like a button and did nothing, and the old intro
          («...данные карты») implied a chat and card payments. It is a plain information card
          now; the build's own contact (EXPO_PUBLIC_SUPPORT_URL: phone, e-mail or page) is its
          button when the release sets one. */}
      <Card>
        <Row>
          <View style={s.supportIcon}>
            <Icon name="storefront-outline" color={colors.accent} size={28} />
          </View>
          <View style={ui.flex}>
            <Heading small>{t('Поддержка в ресторане')}</Heading>
            <Caption testID="support-contact-fallback">
              {t('Поддержка работает в ресторане: обратитесь к сотруднику на кассе.')}
            </Caption>
          </View>
        </Row>
        <SupportContact fallback={null} />
      </Card>
      {/* Owner 29.10.2026: no message form that sends nothing; the restaurant itself (address,
          map and hours on «Наши рестораны») is the real contact. */}
      {location ? (
        <NavRow
          testID="support-restaurant"
          title={t(location.name)}
          subtitle={`${t(location.city)}, ${t(location.address)}`}
          icon="location-outline"
          onPress={() => props.navigate('M05')}
        />
      ) : null}
      {/* Review 29.10.2026: it opened the payment screen (M14), which without a pending order is
          the basket with «Оплатить» right under «do not pay again». «Заказы» shows whether each
          order is paid. */}
      <NavRow
        testID="support-payment-unclear"
        title={t('Неясен результат оплаты?')}
        subtitle={t('Статус оплаты каждого заказа - в «Заказах». Не оплачивайте заказ повторно.')}
        onPress={() => props.navigate('M19')}
      />
    </Page>
  );
}
export function DeleteAccount(props: ScreenProps) {
  useLocale();
  const demo = useAccount();
  const [deleteConfirmVisible, setDeleteConfirmVisible] = useState(false);
  // Review 29.10.2026: after «Удалить аккаунт» the screen says that the account is gone.
  const [deleted, setDeleted] = useState(false);
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
    Alert.alert(localize('Очистить данные устройства?'), localize(clearDescription), [
      { text: 'Оставить', style: 'cancel' },
      {
        text: 'Очистить',
        style: 'destructive',
        onPress: clearPreferences,
      },
    ]);
  };
  return (
    <Page props={props} title={t('Удалить аккаунт')}>
      <Modal
        visible={deleteConfirmVisible}
        transparent
        animationType="none"
        onRequestClose={() => setDeleteConfirmVisible(false)}
      >
        <ScrollView style={{ flex: 1 }} contentContainerStyle={s.confirmBackdrop}>
          <View testID="server-delete-confirmation" accessibilityViewIsModal style={s.confirmCard}>
            <Heading small>{t('Удалить аккаунт Pick Chick?')}</Heading>
            <Body>
              {t(
                'Профиль и доступ на всех ваших устройствах будут удалены. Необходимые документы по заказам обрабатываются по политике хранения данных.',
              )}
            </Body>
            <Button
              title={t('Оставить аккаунт')}
              secondary
              disabled={demo.busy}
              onPress={() => setDeleteConfirmVisible(false)}
            />
            <Button
              title={localize(demo.busy ? 'Удаляем…' : 'Удалить аккаунт')}
              testID="confirm-server-delete"
              disabled={props.preview || demo.busy}
              onPress={() => {
                void demo.deleteAccount().then((success) => {
                  if (success) {
                    props.model.setNickname('');
                    setDeleteConfirmVisible(false);
                    setDeleted(true);
                  }
                });
              }}
            />
            {demo.error ? <Body style={s.authError}>{localize(demo.error)}</Body> : null}
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
              <Heading small>{t('Очистить данные устройства?')}</Heading>
              <Body>{localize(clearDescription)}</Body>
              <Button
                title={t('Оставить данные')}
                secondary
                onPress={() => setConfirmVisible(false)}
              />
              <Button
                title={t('Очистить')}
                testID="confirm-clear-local-data"
                onPress={clearPreferences}
              />
            </View>
          </ScrollView>
        </Modal>
      ) : null}
      <Heading>
        {t('Всё под вашим')}
        {localize(`\n`)}
        {t('контролем')}
      </Heading>
      {deleted && !demo.account ? (
        <View testID="account-deleted" accessibilityLiveRegion="polite">
          <Notice title={t('Аккаунт удалён')}>
            {t('Профиль и доступ на всех ваших устройствах удалены.')}
          </Notice>
        </View>
      ) : null}
      <Card>
        <Heading small>{t('Аккаунт')}</Heading>
        <Body muted>
          {localize(
            demo.mode === 'server'
              ? demo.account
                ? 'Данные хранятся в вашем аккаунте. Удаление уберёт профиль и отзовёт доступ на всех устройствах.'
                : 'Войдите по своему номеру, чтобы управлять аккаунтом.'
              : demo.account
                ? 'Ваш профиль хранится на этом устройстве. Можно удалить номер, дату рождения и другие данные профиля; заказы этого устройства сохранятся.'
                : 'Профиля на устройстве нет.',
          )}
        </Body>
        <Button
          title={localize(
            demo.mode === 'server' ? 'Удалить аккаунт' : 'Удалить профиль на устройстве',
          )}
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
        <Heading small>{t('На этом устройстве')}</Heading>
        <Body muted>
          {localize(
            demo.mode === 'server'
              ? 'Очистка локальных настроек выполнит выход на этом устройстве. Сам аккаунт сохранится. Незавершённые запросы заказа сохраняются отдельно.'
              : 'Можно очистить профиль на устройстве, номер, ник, дату рождения, пол и корзину. История заказов и незавершённые запросы сохранятся.',
          )}
        </Body>
        <Button
          title={t('Очистить локальные данные')}
          secondary
          testID="clear-local-data"
          disabled={props.preview || !demo.ready || demo.busy}
          onPress={reset}
        />
      </Card>
      {demo.error ? <Body style={s.authError}>{localize(demo.error)}</Body> : null}
      {cleared ? <Notice title={t('Готово')}>{t('Локальные данные очищены.')}</Notice> : null}
      {demo.mode === 'demo' ? (
        <Caption>
          {t(
            'Когда появится аккаунт, удалить его можно будет здесь после подтверждения личности. Обязательные сроки хранения документов будут описаны в политике.',
          )}
        </Caption>
      ) : null}
    </Page>
  );
}
export function Legal(props: ScreenProps) {
  useLocale();
  const account = useAccount();
  const [linkError, setLinkError] = useState(false);
  const [opened, setOpened] = useState<string | null>(null);
  const documents = ['Условия заказа', 'Политика конфиденциальности', 'Правила программы Чиков'];
  if (account.mode === 'server')
    return (
      <Page props={props} title={t('Документы')}>
        <Heading>
          {t('Открыто')}
          {localize(`\n`)}
          {t('и понятно')}
        </Heading>
        {account.legal ? (
          <>
            <Body muted>
              {t('Документы Pick Chick · версия {p0}', { p0: account.legal.version })}
            </Body>
            {[
              { title: 'Условия заказа', url: account.legal.termsUrl },
              { title: 'Политика конфиденциальности', url: account.legal.privacyUrl },
            ].map((document) => (
              <NavRow
                key={document.title}
                title={localize(document.title)}
                subtitle={t('Открыть документ')}
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
            {t(
              'Документы сейчас недоступны, поэтому вход по номеру телефона закрыт. Попробуйте позже.',
            )}
          </Notice>
        )}
        {linkError ? (
          <Notice warning>
            {t('Не удалось открыть документ. Проверьте подключение и попробуйте ещё раз.')}
          </Notice>
        ) : null}
        {/* Review 29.10.2026: no «согласие на сообщения об акциях запрашивается отдельно»: this
            build asks for no such consent. */}
        <NavRow title={t('Управлять аккаунтом и данными')} onPress={() => props.navigate('M32')} />
      </Page>
    );
  return (
    <Page props={props} title={t('Документы')}>
      <Heading>
        {t('Открыто')}
        {localize(`\n`)}
        {t('и понятно')}
      </Heading>
      <Body muted>{t('Здесь будут актуальные документы Pick Chick и дата каждой версии.')}</Body>
      <View>
        {documents.map((title) => (
          <View key={title}>
            <NavRow
              title={localize(title)}
              subtitle={t('На подготовке')}
              icon={opened === title ? 'chevron-up' : 'chevron-down'}
              onPress={() => setOpened(opened === title ? null : title)}
            />
            {opened === title ? (
              <Notice>
                {t(
                  'Документ ещё не утверждён и не опубликован компанией Pick Chick. Здесь нет действующей оферты или условий программы.',
                )}
              </Notice>
            ) : null}
          </View>
        ))}
      </View>
      <Notice warning>
        {t(
          'Оплата и чеки - в процессе подключения. В приложении можно выбрать блюда и следить за заказом.',
        )}
      </Notice>
      <Card>
        <Heading small>{t('Данные этой версии')}</Heading>
        <Body muted>
          {t(
            'Номер профиля, ник, дата рождения, пол и корзина хранятся только на устройстве. Код входа не подтверждает владение номером; SMS не отправляется. Заказы хранятся на сервере отдельно от номера. Реальные платежи и бонусные операции не выполняются.',
          )}
        </Body>
        <NavRow title={t('Управлять локальными данными')} onPress={() => props.navigate('M32')} />
      </Card>
    </Page>
  );
}
export function Settings(props: ScreenProps) {
  const router = useRouter();
  const notifications = useNotifications();
  useLocale();
  // App Store build (owner 29.10.2026): while the server's push service is not connected there
  // are no disabled switches and no «ещё не подключён». The screen holds the language, privacy and
  // «Как проходит заказ»: it is «Настройки», like the gear and the App Review notes (review 29.10).
  const push = pushSettingsShown(notifications.connected);
  return (
    <Page props={props} title={t('Настройки')}>
      <Heading small>{t('Язык приложения')}</Heading>
      <Card>
        {(['kk', 'ru', 'en'] as const).map((language) => (
          <Pressable
            key={language}
            testID={`language-${language}`}
            accessibilityRole="radio"
            accessibilityState={{ checked: props.model.locale === language }}
            aria-checked={props.model.locale === language}
            accessibilityLabel={{ kk: 'Қазақша', ru: 'Русский', en: 'English' }[language]}
            onPress={() => props.model.setLocale(language)}
            style={s.settingRow}
          >
            <Body style={ui.flex}>{{ kk: 'Қазақша', ru: 'Русский', en: 'English' }[language]}</Body>
            <Icon
              name={props.model.locale === language ? 'checkmark-circle' : 'ellipse-outline'}
              color={props.model.locale === language ? colors.accent : colors.muted}
            />
          </Pressable>
        ))}
      </Card>
      {push ? <PushSettings preview={props.preview} /> : null}
      <NavRow
        title={t('Конфиденциальность')}
        subtitle={t('Документы и ваши данные')}
        onPress={() => props.navigate('M33')}
      />
      <NavRow
        title={t('Удалить аккаунт')}
        icon="trash-outline"
        testID="settings-delete-account"
        onPress={() => props.navigate('M32')}
      />
      <NavRow
        title={t('Как проходит заказ')}
        subtitle={t('Демонстрация - без оплаты')}
        onPress={() => router.push('/demo-order')}
      />
    </Page>
  );
}
function PushSettings({ preview }: { preview: boolean }) {
  const notifications = useNotifications();
  useLocale();
  return (
    <>
      <Heading small>{t('Уведомления')}</Heading>
      <Card>
        {[
          {
            id: 'orders' as const,
            title: 'О моих заказах',
            detail: 'Статус приготовления и выдачи',
          },
          {
            id: 'promotions' as const,
            title: 'События и предложения',
            detail: 'Только с вашего отдельного согласия',
          },
        ].map((setting) => (
          <Row key={setting.title} style={{ paddingVertical: 8 }}>
            <View style={ui.flex}>
              <Body>{localize(setting.title)}</Body>
              <Caption style={{ marginTop: 4 }}>{localize(setting.detail)}</Caption>
            </View>
            <Switch
              testID={`push-${setting.id}`}
              value={notifications.preferences[setting.id]}
              disabled={preview || notifications.busy || !notifications.available}
              onValueChange={(enabled) => {
                void notifications.change(setting.id, enabled);
              }}
              accessibilityLabel={t(setting.title)}
              trackColor={{ false: colors.border, true: colors.action }}
            />
          </Row>
        ))}
      </Card>
      <Notice>
        {notifications.reason === 'web'
          ? t('Push-уведомления доступны в приложении на iPhone и Android.')
          : notifications.reason === 'login'
            ? t('Войдите в аккаунт, чтобы настроить уведомления.')
            : notifications.reason === 'service'
              ? t('Сервис уведомлений ещё не подключён. Статусы заказов доступны в приложении.')
              : t(
                  'Уведомления о заказах и предложениях включаются отдельно. Их можно отключить в любое время.',
                )}
      </Notice>
      {notifications.error ? <Body muted>{t(notifications.error)}</Body> : null}
      {notifications.error ? (
        <Button
          title={t('Повторить')}
          secondary
          disabled={notifications.busy}
          onPress={() => {
            void notifications.refresh();
          }}
        />
      ) : null}
      {notifications.denied ? (
        <Button
          title={t('Открыть настройки устройства')}
          secondary
          onPress={() => {
            void notifications.openSettings();
          }}
        />
      ) : null}
    </>
  );
}
export function Rating(props: ScreenProps) {
  useLocale();
  const [rating, setRating] = useState(0);
  return (
    <Page props={props} title={t('Как всё прошло?')}>
      <View style={s.ratingHero}>
        <Icon name="heart-outline" size={54} color={colors.accent} />
        <Heading style={{ textAlign: 'center' }}>{t('Было хрустяще?')}</Heading>
        <Body muted style={{ textAlign: 'center' }}>
          {localize(
            props.preview
              ? 'Оцените пример заказа №083'
              : 'Отзыв появится здесь после получения заказа',
          )}
        </Body>
      </View>
      <Row style={{ justifyContent: 'center', gap: 5 }}>
        {[1, 2, 3, 4, 5].map((value) => (
          <Pressable
            key={value}
            testID={`rating-${value}`}
            accessibilityRole="radio"
            accessibilityState={{ selected: rating === value, disabled: !props.preview }}
            accessibilityLabel={localize(t('{p0} из 5', { p0: value }))}
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
        accessibilityLabel={t('Комментарий к оценке')}
        maxLength={2000}
        multiline
        placeholder={t('Что особенно понравилось?')}
        placeholderTextColor={colors.muted}
        textAlignVertical="top"
        style={[ui.input, { minHeight: 125 }]}
      />
      <Button title={t('Отправка пока недоступна')} disabled />
      <Notice>
        {t(
          'Оценка в просмотре дизайна не отправляется. Реальный отзыв можно оставить только после выданного заказа.',
        )}
      </Notice>
      <Button title={t('Нужна помощь с заказом')} secondary onPress={() => props.navigate('M31')} />
    </Page>
  );
}
export function UnknownScreen(props: ScreenProps) {
  useLocale();
  return (
    <Page props={props} title="Pick Chick">
      <Empty
        title={t('Экран не найден')}
        detail={t('Вернитесь к меню и продолжите знакомство.')}
        action={<Button title={t('В меню')} onPress={() => props.navigate('M06')} />}
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
