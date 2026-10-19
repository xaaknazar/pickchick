import { Text, TextInput, View } from 'react-native';
import { colors, fonts, useMetrics } from '../theme';
import { copy, type Locale } from '../i18n';
import type { StaffPinError } from '../model';
import { fixedText } from './Body';

/**
 * Staff code entry inside a white dialog (audit 19.10: demo mode, «Начать заново» on a QR that
 * may be scanned, service reset). Hidden digits on the number pad; the code is checked only by the
 * server and never kept by the kiosk. A failed check shows its reason under the field.
 */
export function StaffPinField({
  value,
  onChange,
  locale,
  error = null,
  busy = false,
}: {
  value: string;
  onChange: (value: string) => void;
  locale: Locale;
  error?: StaffPinError | null;
  busy?: boolean;
}) {
  const { px } = useMetrics();
  const t = copy(locale);
  return (
    <View style={{ gap: px(10) }}>
      <Text
        {...fixedText}
        style={{ fontFamily: fonts.heavy, fontSize: Math.max(17, px(19)), color: colors.navy }}
      >
        {t.staffPin}
      </Text>
      <TextInput
        {...fixedText}
        testID="kiosk-staff-pin"
        accessibilityLabel={t.staffPin}
        value={value}
        onChangeText={(text) => onChange(text.replace(/\D/g, '').slice(0, 8))}
        editable={!busy}
        secureTextEntry
        keyboardType="number-pad"
        inputMode="numeric"
        autoComplete="off"
        textContentType="none"
        autoCorrect={false}
        maxLength={8}
        style={{
          minHeight: Math.max(64, px(72)),
          borderRadius: px(18),
          borderWidth: 2,
          borderColor: error ? colors.error : colors.border,
          backgroundColor: colors.background,
          paddingHorizontal: px(22),
          fontFamily: fonts.heavy,
          fontSize: px(32),
          letterSpacing: 6,
          color: colors.navy,
          opacity: busy ? 0.7 : 1,
          outlineWidth: 0,
        }}
      />
      {error ? (
        <Text
          {...fixedText}
          accessibilityRole="alert"
          testID="kiosk-staff-pin-error"
          style={{
            fontFamily: fonts.bold,
            fontSize: Math.max(16, px(17)),
            lineHeight: Math.max(22, px(24)),
            color: colors.error,
          }}
        >
          {t[`staffErr_${error}`]}
        </Text>
      ) : null}
    </View>
  );
}
