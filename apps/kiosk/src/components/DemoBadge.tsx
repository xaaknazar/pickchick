import { Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { copy, type Locale } from '../i18n';
import { colors, fonts, useMetrics } from '../theme';
import { fixedText } from './Body';
/**
 * Staff demo mode marker (owner decision 2026-10-11): a thin deep-orange tab hanging from the top
 * edge of every screen (clear of the centred header titles), "ДЕМО" with its own "Выйти из демо" button. It floats above the screen and
 * takes touches only on itself.
 */
export function DemoBadge({
  locale,
  onExit,
  testID = 'kiosk-demo-badge',
}: {
  locale: Locale;
  onExit: () => void;
  testID?: string;
}) {
  const { v } = useMetrics();
  const safe = useSafeAreaInsets();
  const t = copy(locale);
  return (
    <View
      pointerEvents="box-none"
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        alignItems: 'center',
        zIndex: 50,
        elevation: 50,
      }}
    >
      <View
        testID={testID}
        accessibilityRole="text"
        accessibilityLabel={t.demoBadge}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: v(10),
          paddingTop: safe.top + v(3),
          paddingBottom: v(3),
          paddingLeft: v(16),
          paddingRight: v(3),
          borderBottomLeftRadius: v(16),
          borderBottomRightRadius: v(16),
          backgroundColor: colors.orangeInk,
          shadowColor: '#020A28',
          shadowOpacity: 0.25,
          shadowRadius: 12,
          shadowOffset: { width: 0, height: 4 },
        }}
      >
        <Text
          {...fixedText}
          style={{
            fontFamily: fonts.black,
            fontSize: v(15),
            letterSpacing: v(15) * 0.12,
            color: colors.white,
          }}
        >
          {t.demoBadge}
        </Text>
        <Pressable
          testID="kiosk-demo-exit"
          accessibilityRole="button"
          accessibilityLabel={t.demoExit}
          onPress={onExit}
          // A thin strip keeps the centred screen titles clear; the slop keeps a 44 pt target.
          hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
          style={{
            minHeight: v(24),
            justifyContent: 'center',
            paddingHorizontal: v(12),
            borderRadius: 999,
            // Navy pill: white text keeps AA contrast (a white tint over orangeInk was 3.95:1).
            backgroundColor: colors.navy,
          }}
        >
          <Text
            {...fixedText}
            numberOfLines={1}
            style={{ fontFamily: fonts.medium, fontSize: v(13), color: colors.white }}
          >
            {t.demoExit}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}
