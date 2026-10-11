import { Animated, Text, TextInput, View } from 'react-native';
import { colors, fonts, useMetrics } from '../theme';
import { copy, type Locale } from '../i18n';
import { Icon } from './Icon';
import { useEnter, useTimingTo } from './motion';
import { fixedText } from './Body';
import { useScrollTarget } from './scroll';
/** ScrollArea `focus` target id of the field (brought into view above the keyboard). */
export const INVOICE_PHONE_TARGET = 'kiosk-invoice-phone';
/**
 * v3 phone field for the Kaspi.kz invoice, drawn for the blue review screen:
 * white 26-pt field with an orange ring and big 40-pt digits. Uses the system
 * phone keypad; the value is passed through unchanged. Once `valid`, the ring
 * crossfades to green over 260 ms (prototype `.phone.full`).
 */
export function InvoicePhoneField({
  value,
  onChange,
  busy,
  locale,
  valid = false,
  onFocus,
}: {
  value: string;
  onChange: (value: string) => void;
  busy: boolean;
  locale: Locale;
  valid?: boolean;
  /** The keypad is opening: the screen scrolls the field into view. */
  onFocus?: () => void;
}) {
  const target = useScrollTarget(INVOICE_PHONE_TARGET);
  const { v } = useMetrics();
  const enter = useEnter(100);
  const full = useTimingTo(valid ? 1 : 0, 260, 'css');
  const radius = v(26);
  const t = copy(locale);
  const label = t.kaspiPhone;
  return (
    <Animated.View
      ref={target}
      collapsable={false}
      style={{
        gap: v(12),
        opacity: enter,
        transform: [
          { translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [v(22), 0] }) },
        ],
      }}
    >
      <Text
        {...fixedText}
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
          borderRadius: radius,
          borderWidth: 3,
          borderColor: colors.orange,
          backgroundColor: colors.white,
          shadowColor: valid ? colors.ok : colors.orange,
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
        <Animated.View
          pointerEvents="none"
          style={{
            position: 'absolute',
            top: -3,
            left: -3,
            right: -3,
            bottom: -3,
            borderRadius: radius,
            borderWidth: 3,
            borderColor: colors.ok,
            opacity: full,
          }}
        />
        <Icon name="phone-portrait-outline" tone="accent" />
        <TextInput
          {...fixedText}
          testID="kiosk-invoice-phone"
          accessibilityLabel={label}
          value={value}
          onChangeText={onChange}
          onFocus={onFocus}
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
        {...fixedText}
        style={{
          fontFamily: fonts.body,
          fontSize: Math.max(16, v(17)),
          lineHeight: Math.max(23, v(24)),
          color: colors.onBlueMuted,
        }}
      >
        {t.kaspiPhoneHint}
      </Text>
    </Animated.View>
  );
}
