import type { ReactNode } from 'react';
import { Text, View } from 'react-native';
import { colors, fonts, useMetrics } from '../theme';
import { fixedText } from './Body';
/**
 * A smart upsell row (kiosk redesign 2026-10-13): the white heading (Montserrat 900 26) with an
 * optional note («- к любому заказу», 18, 75% white) over a row of cards 274 high with 16 between
 * them. The row takes its share of spare screen height, so the board fills taller iPads.
 * Children are the cards, each in a Wrapper that sets its width share.
 */
export function UpsellSection({
  title,
  note,
  testID,
  children,
}: {
  title: string;
  note?: string;
  testID?: string;
  children?: ReactNode;
}) {
  const { px } = useMetrics();
  return (
    <View testID={testID} style={{ flexGrow: 274, flexShrink: 0, gap: px(14) }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'baseline',
          gap: px(12),
          paddingHorizontal: px(14),
        }}
      >
        <Text
          {...fixedText}
          accessibilityRole="header"
          numberOfLines={1}
          style={{
            fontFamily: fonts.black,
            fontSize: px(26),
            lineHeight: px(32),
            letterSpacing: -0.3,
            color: colors.white,
          }}
        >
          {title}
        </Text>
        {note ? (
          <Text
            {...fixedText}
            numberOfLines={1}
            style={{
              flexShrink: 1,
              fontFamily: fonts.medium,
              fontSize: Math.max(14, px(18)),
              color: 'rgba(255,255,255,.75)',
            }}
          >
            {note}
          </Text>
        ) : null}
      </View>
      <View style={{ flexGrow: 1, minHeight: px(274), flexDirection: 'row', gap: px(16) }}>
        {children}
      </View>
    </View>
  );
}
