import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, TextInput, View } from 'react-native';
import { provisionCommercialKiosk } from '../storage';
import { Body, Button, Heading, Language, layout } from '../components/UI';
import { colors, useMetrics } from '../theme';
import type { Locale } from '../i18n';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export function EnrollmentScreen({ onComplete }: { onComplete(): void }) {
  const [locale, setLocale] = useState<Locale>('ru');
  const [deviceId, setDeviceId] = useState('');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const ru = locale === 'ru';
  const { px } = useMetrics();
  const safe = useSafeAreaInsets();
  const valid =
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(deviceId.trim()) &&
    /^[a-f0-9]{64}$/.test(key.trim());
  const enroll = async () => {
    if (busy || !valid) return;
    setBusy(true);
    setError(false);
    try {
      await provisionCommercialKiosk(deviceId.trim(), key.trim());
      setDeviceId('');
      setKey('');
      onComplete();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <KeyboardAvoidingView
      style={layout.screen}
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
        <View
          style={{
            alignSelf: 'flex-start',
            backgroundColor: colors.blue,
            borderRadius: px(16),
            padding: px(4),
          }}
        >
          <Language locale={locale} onChange={setLocale} />
        </View>
        <Heading size={42}>{ru ? 'Настройка киоска' : 'Киоскті баптау'}</Heading>
        <Body>
          {ru
            ? 'Сотрудник ресторана вводит данные устройства, полученные от администратора.'
            : 'Мейрамхана қызметкері әкімшіден алынған құрылғы деректерін енгізеді.'}
        </Body>
        {(
          [
            ['id', ru ? 'ID устройства' : 'Құрылғы ID', deviceId, setDeviceId],
            ['key', ru ? 'Ключ устройства' : 'Құрылғы кілті', key, setKey],
          ] as const
        ).map(([name, label, value, setter]) => (
          <View key={name} style={{ gap: px(8) }}>
            <Body>{label}</Body>
            <TextInput
              testID={`kiosk-enrollment-${name}`}
              accessibilityLabel={label}
              value={value}
              onChangeText={setter}
              editable={!busy}
              secureTextEntry={name === 'key'}
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              textContentType="none"
              maxLength={name === 'key' ? 64 : 36}
              style={{
                minHeight: 56,
                padding: px(18),
                borderWidth: 2,
                borderColor: colors.border,
                borderRadius: px(16),
                fontSize: 20,
                color: colors.ink,
                backgroundColor: colors.white,
              }}
            />
          </View>
        ))}
        {error ? (
          <Body accessibilityRole="alert" style={{ color: colors.error }}>
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
          onPress={() => void enroll()}
        />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
