import { KeyboardAvoidingView, Platform, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Locale } from '../i18n';
import { colors, useMetrics } from '../theme';
import { Body, Button, Heading, Language } from './UI';
import { DeviceField } from './DeviceField';
export function EnrollmentForm({
  locale,
  onLocale,
  deviceId,
  onDeviceId,
  deviceKey,
  onDeviceKey,
  busy,
  error,
  valid,
  onSubmit,
}: {
  locale: Locale;
  onLocale: (v: Locale) => void;
  deviceId: string;
  onDeviceId: (v: string) => void;
  deviceKey: string;
  onDeviceKey: (v: string) => void;
  busy: boolean;
  error: boolean;
  valid: boolean;
  onSubmit: () => void;
}) {
  const { px } = useMetrics();
  const safe = useSafeAreaInsets();
  const ru = locale === 'ru';
  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: colors.background }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          flexGrow: 1,
          justifyContent: 'center',
          padding: px(40),
          paddingTop: safe.top + px(40),
          paddingBottom: safe.bottom + px(40),
          gap: px(24),
        }}
      >
        <Language locale={locale} onChange={onLocale} tone="light" />
        <Heading>{ru ? 'Настройка киоска' : 'Киоскті баптау'}</Heading>
        <Body>
          {ru
            ? 'Сотрудник ресторана вводит данные устройства, полученные от администратора.'
            : 'Мейрамхана қызметкері әкімшіден алынған құрылғы деректерін енгізеді.'}
        </Body>
        <DeviceField
          name="id"
          label={ru ? 'ID устройства' : 'Құрылғы ID'}
          value={deviceId}
          onChange={onDeviceId}
          busy={busy}
        />
        <DeviceField
          name="key"
          label={ru ? 'Ключ устройства' : 'Құрылғы кілті'}
          value={deviceKey}
          onChange={onDeviceKey}
          busy={busy}
        />
        {error ? (
          <Body accessibilityRole="alert" tone="danger">
            {ru
              ? 'Не удалось проверить или сохранить настройку. Проверьте данные и соединение. Для замены регистрации обратитесь к администратору.'
              : 'Баптау тексерілмеді немесе сақталмады. Деректер мен байланысты тексеріңіз. Тіркеуді ауыстыру үшін әкімшіге хабарласыңыз.'}
          </Body>
        ) : null}
        <Button
          testID="kiosk-enrollment-submit"
          label={ru ? 'Подключить киоск' : 'Киоскті қосу'}
          disabled={!valid}
          busy={busy}
          onPress={onSubmit}
        />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
