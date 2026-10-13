import { Animated, Platform, Text, View, type ViewStyle } from 'react-native';
import type { Locale } from '../i18n';
import { paymentCopy } from '../paymentCopy';
import { colors, fonts, redesign, useMetrics } from '../theme';
import { fixedText } from './Body';
import { useEnter } from './motion';
import { ownerOrange } from './ownerOrange';
const glassWeb =
  Platform.OS === 'web'
    ? ({
        backdropFilter: 'blur(18px) saturate(150%)',
        WebkitBackdropFilter: 'blur(18px) saturate(150%)',
      } as unknown as ViewStyle)
    : null;
function StepTile({ index, title, caption }: { index: number; title: string; caption: string }) {
  const { px } = useMetrics();
  const enter = useEnter(160 + index * 45, 340);
  const disc = Math.max(36, px(52));
  return (
    <Animated.View
      testID={`kiosk-payment-step-${index + 1}`}
      accessible
      accessibilityLabel={`${index + 1}. ${title} ${caption}`}
      style={[
        {
          flex: 1,
          minWidth: 0,
          minHeight: px(149),
          borderRadius: px(28),
          backgroundColor: redesign.glass,
          borderWidth: 1,
          borderColor: redesign.glassLine,
          borderTopColor: 'rgba(255,255,255,.26)',
          paddingVertical: px(18),
          paddingLeft: px(22),
          paddingRight: px(16),
          flexDirection: 'row',
          alignItems: 'center',
          gap: px(16),
          boxShadow: `inset 0 1px 0 ${redesign.glassHighlight}, 0 ${px(10)}px ${px(30)}px ${redesign.glassShadow}`,
          opacity: enter,
          transform: [
            { translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) },
          ],
        },
        glassWeb,
      ]}
    >
      <View
        {...ownerOrange}
        style={{
          width: disc,
          height: disc,
          borderRadius: disc / 2,
          backgroundColor: redesign.cta,
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow: `0 ${px(6)}px ${px(16)}px ${redesign.ctaShadow}`,
        }}
      >
        <Text
          {...fixedText}
          style={{ fontFamily: fonts.black, fontSize: Math.max(17, px(24)), color: colors.white }}
        >
          {index + 1}
        </Text>
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: px(4) }}>
        <Text
          {...fixedText}
          style={{
            fontFamily: fonts.heavy,
            fontSize: Math.max(15, px(21)),
            lineHeight: Math.max(19, px(26)),
            color: colors.white,
          }}
        >
          {title}
        </Text>
        <Text
          {...fixedText}
          style={{
            fontFamily: fonts.medium,
            fontSize: Math.max(13, px(15)),
            lineHeight: Math.max(17, px(20)),
            color: 'rgba(255,255,255,.75)',
          }}
        >
          {caption}
        </Text>
      </View>
    </Animated.View>
  );
}
/**
 * The three Kaspi steps under the QR (kiosk redesign 2026-10-13, product-and-payment.md §4):
 * glass tiles 149 high, 16 apart, each with an orange number disc (52), a bold line (Montserrat
 * 800 21) and a caption (15, 75 % white): «Откройте Kaspi.kz / на своём телефоне», «Нажмите
 * «Kaspi QR» / на главном экране», «Наведите камеру / на код выше». They arrive in a short
 * cascade (static under reduced motion); a long line wraps inside its tile, never cut.
 */
export function QrStepTiles({ locale }: { locale: Locale }) {
  const { px } = useMetrics();
  const t = paymentCopy(locale);
  return (
    <View
      testID="kiosk-payment-steps"
      style={{ width: '100%', flexDirection: 'row', alignItems: 'stretch', gap: px(16) }}
    >
      {t.steps.map(([title, caption], index) => (
        <StepTile key={index} index={index} title={title} caption={caption} />
      ))}
    </View>
  );
}
