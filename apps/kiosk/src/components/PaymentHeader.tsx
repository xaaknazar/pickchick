import { Animated, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { copy, type Locale } from '../i18n';
import { colors, fonts, useMetrics } from '../theme';
import { fixedText } from './Body';
import { GlassPanel } from './GlassPanel';
import { Language } from './Language';
import { Logo } from './Logo';
import { usePress } from './motion';
/**
 * Kaspi QR header (kiosk redesign 2026-10-13, product-and-payment.md §4, 1024-pt layout): a row
 * 80 high at the top 24 with the logo, «Оплата» (Montserrat 900 30) over «Заказ № 42 · С собой»
 * (17, 75 % white), the glass language switch and the glass «?» disc (64) that opens help. There
 * is no way back: the order exists and its QR cannot be revoked. The title column gives way
 * first, so the language and help never leave the screen.
 */
export function PaymentHeader({
  locale,
  setLocale,
  title,
  subtitle,
  onHelp,
}: {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  title: string;
  subtitle?: string;
  onHelp: () => void;
}) {
  const { px } = useMetrics();
  const safe = useSafeAreaInsets();
  const t = copy(locale);
  const help = usePress(0.92);
  const control = Math.max(48, px(64));
  return (
    <View
      style={{
        paddingTop: safe.top + px(24),
        paddingLeft: Math.max(safe.left, px(24)),
        paddingRight: Math.max(safe.right, px(24)),
      }}
    >
      <View style={{ minHeight: px(80), flexDirection: 'row', alignItems: 'center', gap: px(14) }}>
        <Logo size="regular" />
        <View style={{ flex: 1, minWidth: px(120), gap: px(2) }}>
          <Text
            {...fixedText}
            accessibilityRole="header"
            numberOfLines={1}
            style={{
              fontFamily: fonts.black,
              fontSize: px(30),
              lineHeight: px(36),
              letterSpacing: -0.3,
              color: colors.white,
            }}
          >
            {title}
          </Text>
          {subtitle ? (
            <Text
              {...fixedText}
              testID="kiosk-header-subtitle"
              numberOfLines={2}
              style={{
                fontFamily: fonts.medium,
                fontSize: Math.max(13, px(17)),
                lineHeight: Math.max(16, px(21)),
                color: 'rgba(255,255,255,.75)',
              }}
            >
              {subtitle}
            </Text>
          ) : null}
        </View>
        <Language locale={locale} onChange={setLocale} tone="glass" />
        <Animated.View style={{ transform: [{ scale: help.scale }] }}>
          <GlassPanel shape="circle">
            <Pressable
              testID="kiosk-header-help"
              accessibilityRole="button"
              accessibilityLabel={t.help}
              onPress={onHelp}
              onPressIn={help.onPressIn}
              onPressOut={help.onPressOut}
              style={{
                width: control,
                height: control,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Text
                {...fixedText}
                style={{ fontFamily: fonts.black, fontSize: px(24), color: colors.white }}
              >
                ?
              </Text>
            </Pressable>
          </GlassPanel>
        </Animated.View>
      </View>
    </View>
  );
}
