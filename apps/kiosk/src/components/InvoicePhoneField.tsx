import { Animated, Text, TextInput, View } from 'react-native';
import { colors, fonts, useMetrics } from '../theme';
import type { Locale } from '../i18n';
import { Icon } from './Icon';
import { useEnter } from './motion';
/**
 * v3 phone field for the Kaspi.kz invoice, drawn for the blue review screen:
 * white 26-pt field with an orange ring and big 40-pt digits. Uses the system
 * phone keypad; the value is passed through unchanged.
 */
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
  const { v } = useMetrics();
  const enter = useEnter(100);
  const label = locale === 'ru' ? 'Номер телефона Kaspi' : 'Kaspi телефон нөмірі';
  return (
    <Animated.View
      style={{
        gap: v(12),
        opacity: enter,
        transform: [
          { translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [v(22), 0] }) },
        ],
      }}
    >
      <Text
        style={{
          fontFamily: fonts.heavy,
          fontSize: Math.max(18, v(20)),
          color: colors.white,
        }}
      >
        {label}
      </Text>
      <View
        style={{
          minHeight: Math.max(80, v(100)),
          borderRadius: v(26),
          borderWidth: 3,
          borderColor: colors.orange,
          backgroundColor: colors.white,
          shadowColor: colors.orange,
          shadowOpacity: 0.25,
          shadowRadius: 30,
          shadowOffset: { width: 0, height: 12 },
          paddingHorizontal: v(28),
          flexDirection: 'row',
          alignItems: 'center',
          gap: v(16),
          opacity: busy ? 0.7 : 1,
        }}
      >
        <Icon name="phone-portrait-outline" tone="accent" />
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
          placeholderTextColor="rgba(4,20,58,.32)"
          style={{
            flex: 1,
            minWidth: 0,
            paddingVertical: v(14),
            fontFamily: fonts.heavy,
            fontSize: v(40),
            letterSpacing: 1,
            color: colors.navy,
            fontVariant: ['tabular-nums'],
            // The orange field ring is the focus frame; no extra browser outline on web.
            outlineWidth: 0,
          }}
        />
      </View>
      <Text
        style={{
          fontFamily: fonts.body,
          fontSize: Math.max(16, v(17)),
          lineHeight: Math.max(23, v(24)),
          color: colors.onBlueMuted,
        }}
      >
        {locale === 'ru'
          ? 'Введите номер, к которому привязан Kaspi.kz. Подтвердите счёт в приложении на своём телефоне.'
          : 'Kaspi.kz тіркелген нөмірді енгізіңіз. Шотты телефоныңыздағы қосымшада растаңыз.'}
      </Text>
    </Animated.View>
  );
}
