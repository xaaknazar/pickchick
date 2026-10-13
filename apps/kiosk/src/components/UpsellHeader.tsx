import { Animated, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { copy, type Locale } from '../i18n';
import { colors, fonts, useMetrics } from '../theme';
import { fixedText } from './Body';
import { GlassPanel } from './GlassPanel';
import { Icon } from './Icon';
import { Language } from './Language';
import { usePress } from './motion';
/**
 * Smart upsell header (kiosk redesign 2026-10-13, 1024-pt layout): a row 80 high at the top 24
 * with the glass «‹ Меню» pill (64), the white title (Montserrat 900 30) over the rule's
 * subtitle (17, 75% white), the language switch (as on the menu) and a glass «?» disc (64). The
 * back pill and the disc are the owner's glass. The title column gives way first, so the
 * language and help never leave the screen; a long subtitle takes a second line inside the row
 * instead of being cut.
 */
export function UpsellHeader({
  locale,
  setLocale,
  title,
  subtitle,
  onBack,
  onHelp,
}: {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  title: string;
  subtitle?: string;
  onBack: () => void;
  onHelp: () => void;
}) {
  const { px } = useMetrics();
  const safe = useSafeAreaInsets();
  const t = copy(locale);
  const back = usePress(0.96);
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
        <Animated.View style={{ transform: [{ scale: back.scale }] }}>
          <GlassPanel>
            <Pressable
              testID="kiosk-header-back"
              accessibilityRole="button"
              accessibilityLabel={t.menu}
              onPress={onBack}
              onPressIn={back.onPressIn}
              onPressOut={back.onPressOut}
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
                {t.menu}
              </Text>
            </Pressable>
          </GlassPanel>
        </Animated.View>
        <View style={{ flex: 1, minWidth: 0, gap: px(2) }}>
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
              testID="kiosk-upsell-subtitle"
              // A long order (or the 8.3-inch iPad) takes a second line inside the 80-pt row
              // rather than cutting the products off.
              numberOfLines={2}
              style={{
                fontFamily: fonts.medium,
                fontSize: Math.max(13, px(17)),
                lineHeight: Math.max(16, px(20)),
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
              testID="kiosk-upsell-help"
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
