import { useEffect, useRef } from 'react';
import { Animated, Text, View } from 'react-native';
import { colors, fonts, useMetrics } from '../theme';
import { copy, type Locale } from '../i18n';
import { Heading, Body, Icon, Wrapper } from './UI';
import { useMotionPreference } from './useMotionPreference';
export function OrderTicket({
  number,
  status,
  confirmed,
  showBoard,
  receipt,
  locale,
}: {
  number: string;
  status: string;
  confirmed: boolean;
  showBoard: boolean;
  receipt: string;
  locale: Locale;
}) {
  const { px, width } = useMetrics();
  const t = copy(locale);
  const reduced = useMotionPreference();
  const scale = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (confirmed && !reduced) {
      scale.setValue(0.92);
      Animated.spring(scale, {
        toValue: 1,
        stiffness: 220,
        damping: 20,
        useNativeDriver: true,
      }).start();
    }
    return () => {
      scale.stopAnimation();
      scale.setValue(1);
    };
  }, [confirmed, reduced, scale]);
  const numberSize = Math.min(
    px(230),
    Math.floor((width - px(160)) / Math.max(1, number.length) / 0.72),
  );
  return (
    <Wrapper align="center" gap={28}>
      <Animated.View style={{ transform: [{ scale }] }}>
        <View
          style={{
            width: 80,
            height: 80,
            borderRadius: 40,
            backgroundColor: confirmed ? colors.orange : 'rgba(255,255,255,.14)',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Icon
            name={confirmed ? 'checkmark' : 'time-outline'}
            size="large"
            tone={confirmed ? 'default' : 'inverse'}
          />
        </View>
      </Animated.View>
      <Body tone="inverse">{t.yourNumber}</Body>
      <View
        style={{
          backgroundColor: colors.white,
          borderRadius: 24,
          paddingHorizontal: px(48),
          paddingVertical: px(20),
        }}
      >
        <Text
          testID="kiosk-order-number"
          style={{
            fontFamily: fonts.heavy,
            fontVariant: ['tabular-nums'],
            fontSize: numberSize,
            lineHeight: numberSize * 1.2,
            letterSpacing: -numberSize * 0.025,
            color: colors.blue,
            textAlign: 'center',
          }}
        >
          {number}
        </Text>
      </View>
      <Heading testID="kiosk-order-state" size="title" tone="inverse" align="center">
        {status}
      </Heading>
      {showBoard ? (
        <Body tone="inverse" align="center">
          {t.board}
        </Body>
      ) : null}
      <Body tone="inverse" variant="caption" align="center">
        {receipt}
      </Body>
    </Wrapper>
  );
}
