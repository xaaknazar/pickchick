import { useEffect, useRef, useState } from 'react';
import { Animated, Text, View } from 'react-native';
import { copy, type Locale } from '../i18n';
import { money } from '../cart';
import { colors, fonts, useMetrics } from '../theme';
import { Footer, Wrapper, Body, Heading, Button, Icon } from './UI';
import { useMotionPreference } from './useMotionPreference';
export function CartBar({
  quantity,
  previousQuantity,
  total,
  valid,
  empty,
  busy,
  locale,
  onCheckout,
}: {
  quantity: number;
  previousQuantity?: number;
  total: string;
  valid: boolean;
  empty: boolean;
  busy: boolean;
  locale: Locale;
  onCheckout: () => void;
}) {
  const { px } = useMetrics();
  const t = copy(locale);
  const previous = useRef(previousQuantity ?? quantity);
  const [added, setAdded] = useState(false);
  const scale = useRef(new Animated.Value(1)).current;
  const reduced = useMotionPreference();
  const [pulse, setPulse] = useState(0);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (quantity > previous.current) {
      setAdded(true);
      setPulse((value) => value + 1);
      timer = setTimeout(() => setAdded(false), 1800);
    } else setAdded(false);
    previous.current = quantity;
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [quantity]);
  useEffect(() => {
    scale.stopAnimation();
    scale.setValue(1);
    if (pulse && !reduced)
      Animated.sequence([
        Animated.timing(scale, { toValue: 1.12, duration: 120, useNativeDriver: true }),
        Animated.spring(scale, { toValue: 1, damping: 18, stiffness: 240, useNativeDriver: true }),
      ]).start();
    return () => {
      scale.stopAnimation();
      scale.setValue(1);
    };
  }, [pulse, reduced, scale]);
  return (
    <Footer testID="kiosk-cart-bar">
      <Wrapper dir="row" align="center" gap={20}>
        <Animated.View style={{ transform: [{ scale }] }}>
          <View
            style={{
              width: Math.max(52, px(64)),
              height: Math.max(52, px(64)),
              borderRadius: 16,
              backgroundColor: colors.blue,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {quantity ? (
              <Text style={{ fontFamily: fonts.bold, fontSize: 24, color: colors.white }}>
                {quantity}
              </Text>
            ) : (
              <Icon name="bag-outline" tone="inverse" />
            )}
          </View>
        </Animated.View>
        <Wrapper flex={1} gap={4}>
          <Body variant="caption" tone="muted" testID="kiosk-cart-feedback" announce>
            {added ? t.selected : t.cart}
          </Body>
          <Heading size="section">
            {valid ? money(total) : locale === 'ru' ? 'Проверьте корзину' : 'Себетті тексеріңіз'}
          </Heading>
        </Wrapper>
        <Button
          label={t.checkout}
          icon="arrow-forward"
          onPress={onCheckout}
          testID="kiosk-menu-checkout"
          disabled={empty}
          busy={busy}
        />
      </Wrapper>
    </Footer>
  );
}
