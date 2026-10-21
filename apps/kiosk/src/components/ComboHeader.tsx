import { Animated, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { type Locale } from '../i18n';
import { colors, fonts, useMetrics } from '../theme';
import { fixedText } from './Body';
import { GlassPanel } from './GlassPanel';
import { Icon } from './Icon';
import { Language } from './Language';
import { usePress } from './motion';
/**
 * Product card header (kiosk redesign 2026-10-13, product-and-payment.md §1; 1024-pt layout):
 * a row 80 high at the top 24 with the glass «‹ Меню» pill (64), the product name (Montserrat
 * 900 30) over its caption «Комбо · 520 г» (17, 75% white), the glass language switch and the
 * glass «?» disc (64), as on the smart upsell. The name gives way first, so the language and
 * help never leave the screen.
 */
export function ComboHeader({
  locale,
  setLocale,
  title,
  subtitle,
  back,
  onBack,
}: {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  title: string;
  subtitle?: string;
  /** Caption of the back pill: «Меню», or «Назад» when the card was opened from the order. */
  back: string;
  onBack: () => void;
  onHelp: () => void;
}) {
  const { px } = useMetrics();
  const safe = useSafeAreaInsets();
  const press = usePress(0.96);
  const control = Math.max(48, px(64));
  return (
    <View
      style={{
        paddingTop: safe.top + px(24),
        paddingLeft: Math.max(safe.left, px(24)),
        paddingRight: Math.max(safe.right, px(24)),
      }}
    >
      <View style={{ height: px(80), flexDirection: 'row', alignItems: 'center', gap: px(14) }}>
        <Animated.View style={{ transform: [{ scale: press.scale }] }}>
          <GlassPanel>
            <Pressable
              testID="kiosk-product-close"
              accessibilityRole="button"
              accessibilityLabel={back}
              onPress={onBack}
              onPressIn={press.onPressIn}
              onPressOut={press.onPressOut}
              style={{
                minHeight: control,
                paddingLeft: px(16),
                paddingRight: px(24),
                flexDirection: 'row',
                alignItems: 'center',
                gap: px(6),
              }}
            >
              <Icon name="chevron-back" size="small" tone="inverse" />
              <Text
                {...fixedText}
                numberOfLines={1}
                style={{ fontFamily: fonts.heavy, fontSize: px(19), color: colors.white }}
              >
                {back}
              </Text>
            </Pressable>
          </GlassPanel>
        </Animated.View>
        <View style={{ flex: 1, minWidth: 0, gap: px(2) }}>
          <Text
            {...fixedText}
            testID="kiosk-product-title"
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
              testID="kiosk-product-caption"
              numberOfLines={1}
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
      </View>
    </View>
  );
}
