import { TextInput, View } from 'react-native';
import { colors, fonts, useMetrics } from '../theme';
import type { Locale } from '../i18n';
import { Body } from './Body';

export function InvoicePhoneField({
  value,
  onChange,
  busy,
  locale,
}: {
  value: string;
  onChange: (value: string) => void;
  busy: boolean;
  locale: Locale;
}) {
  const { px } = useMetrics();
  const label = locale === 'ru' ? 'Номер телефона Kaspi' : 'Kaspi телефон нөмірі';
  return (
    <View style={{ gap: 10 }}>
      <Body variant="label">{label}</Body>
      <TextInput
        testID="kiosk-invoice-phone"
        accessibilityLabel={label}
        value={value}
        onChangeText={onChange}
        editable={!busy}
        keyboardType="phone-pad"
        inputMode="tel"
        autoComplete="off"
        textContentType="none"
        autoCorrect={false}
        maxLength={20}
        placeholder="+7 (7XX) XXX-XX-XX"
        placeholderTextColor={colors.muted}
        style={{
          minHeight: px(72),
          padding: px(20),
          borderWidth: 2,
          borderColor: colors.border,
          borderRadius: 16,
          backgroundColor: colors.white,
          color: colors.ink,
          fontFamily: fonts.body,
          fontSize: px(24),
        }}
      />
      <Body variant="caption" tone="muted">
        {locale === 'ru'
          ? 'Введите номер, к которому привязан Kaspi.kz. Подтвердите счёт в приложении на своём телефоне.'
          : 'Kaspi.kz тіркелген нөмірді енгізіңіз. Шотты телефоныңыздағы қосымшада растаңыз.'}
      </Body>
    </View>
  );
}
