import { KeyboardAvoidingView, Platform, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { copy, type Locale } from '../i18n';
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
  const t = copy(locale);
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
        <Heading>{t.enrollTitle}</Heading>
        <Body>{t.enrollBody}</Body>
        <DeviceField
          name="id"
          label={t.enrollId}
          value={deviceId}
          onChange={onDeviceId}
          busy={busy}
        />
        <DeviceField
          name="key"
          label={t.enrollKey}
          value={deviceKey}
          onChange={onDeviceKey}
          busy={busy}
        />
        {error ? (
          <Body accessibilityRole="alert" tone="danger">
            {t.enrollError}
          </Body>
        ) : null}
        <Button
          testID="kiosk-enrollment-submit"
          label={t.enrollSubmit}
          disabled={!valid}
          busy={busy}
          onPress={onSubmit}
        />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
