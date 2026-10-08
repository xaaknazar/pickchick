import { useEffect, useRef } from 'react';
import { ActivityIndicator, Animated, Pressable, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { copy, type Locale } from '../i18n';
import { colors, fonts, useMetrics } from '../theme';
import { Button } from './Button';
import { Footer } from './Footer';
import { Heading } from './Heading';
import { IconButton } from './IconButton';
import { motion, useEnter, useLoop, usePop } from './motion';
import { useMotionPreference } from './useMotionPreference';
/**
 * v3 product action bar on blue: a glass quantity capsule with white discs and the
 * orange 96-pt "to cart" pill with a slow shine. Waiting states turn the pill pale.
 */
export function ProductActions({
  locale,
  quantity,
  price,
  valid,
  available,
  busy,
  next,
  requiredValid,
  onNext,
  onMinus,
  onPlus,
  onAdd,
}: {
  locale: Locale;
  quantity: number;
  price: string | null;
  valid: boolean;
  available: boolean;
  busy: boolean;
  next: boolean;
  requiredValid: boolean;
  onNext: () => void;
  onMinus: () => void;
  onPlus: () => void;
  onAdd: () => void;
}) {
  const { v } = useMetrics();
  const t = copy(locale);
  const reduced = useMotionPreference();
  const rise = useEnter(220, 480);
  const shine = useLoop(3600);
  const pop = usePop(quantity);
  const press = useRef(new Animated.Value(1)).current;
  // A reduced-motion switch must also release a press that is already held.
  useEffect(() => {
    press.stopAnimation();
    press.setValue(1);
  }, [reduced, press]);
  const disabled = !valid || !available;
  const blocked = disabled || busy;
  const label = price ? `${t.toCart} · ${price}` : t.required;
  const pressTo = (to: number) => {
    press.stopAnimation();
    Animated.timing(press, {
      toValue: reduced ? 1 : to,
      duration: reduced ? 0 : motion.press,
      useNativeDriver: true,
    }).start();
  };
  const height = Math.max(64, v(96));
  const band = v(120);
  return (
    <Animated.View
      style={{
        transform: [
          { translateY: rise.interpolate({ inputRange: [0, 1], outputRange: [v(160), 0] }) },
        ],
      }}
    >
      <Footer tone="brand">
        {next ? (
          <Button
            label={t.next}
            icon="arrow-forward"
            disabled={!requiredValid}
            onPress={onNext}
            testID="kiosk-set-next"
            fullWidth
          />
        ) : (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: v(20) }}>
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: v(8),
                padding: v(6),
                borderRadius: 999,
                backgroundColor: 'rgba(255,255,255,.08)',
                borderWidth: 1,
                borderColor: colors.glass,
              }}
            >
              <IconButton
                testID="kiosk-product-decrement"
                name="remove"
                label="-"
                tone="light"
                size="large"
                disabled={quantity <= 1 || busy}
                onPress={onMinus}
              />
              <Animated.View
                style={{ minWidth: v(44), alignItems: 'center', transform: [{ scale: pop }] }}
              >
                <Heading testID="kiosk-product-quantity" size="section" tone="inverse">
                  {quantity}
                </Heading>
              </Animated.View>
              <IconButton
                testID="kiosk-product-increment"
                name="add"
                label="+"
                tone="light"
                size="large"
                disabled={quantity >= 20 || busy}
                onPress={onPlus}
              />
            </View>
            <Animated.View style={{ flex: 1, transform: [{ scale: press }] }}>
              <Pressable
                testID="kiosk-product-add"
                accessibilityRole="button"
                accessibilityLabel={label}
                accessibilityState={{ disabled: blocked, busy }}
                disabled={blocked}
                onPress={onAdd}
                onPressIn={() => pressTo(0.98)}
                onPressOut={() => pressTo(1)}
                style={{
                  height,
                  borderRadius: height / 2,
                  backgroundColor: disabled ? '#FFA466' : colors.orangeCta,
                  shadowColor: colors.orange,
                  shadowOpacity: disabled ? 0 : 0.35,
                  shadowRadius: 26,
                  shadowOffset: { width: 0, height: 12 },
                  opacity: busy ? 0.75 : 1,
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: v(12),
                  paddingHorizontal: v(24),
                }}
              >
                {disabled ? null : (
                  <View
                    pointerEvents="none"
                    style={{
                      position: 'absolute',
                      left: 0,
                      top: 0,
                      right: 0,
                      bottom: 0,
                      borderRadius: height / 2,
                      overflow: 'hidden',
                    }}
                  >
                    <Animated.View
                      style={{
                        position: 'absolute',
                        top: -height / 2,
                        bottom: -height / 2,
                        width: band,
                        opacity: shine.interpolate({
                          inputRange: [0, 0.05, 0.55, 1],
                          outputRange: [0, 1, 1, 0],
                        }),
                        transform: [
                          {
                            translateX: shine.interpolate({
                              inputRange: [0, 0.55, 1],
                              outputRange: [-band * 1.4, band * 6.2, band * 6.2],
                            }),
                          },
                          { rotate: '20deg' },
                        ],
                      }}
                    >
                      <LinearGradient
                        colors={[
                          'rgba(255,255,255,0)',
                          'rgba(255,255,255,.3)',
                          'rgba(255,255,255,0)',
                        ]}
                        start={{ x: 0, y: 0 }}
                        end={{ x: 1, y: 0 }}
                        style={{ flex: 1 }}
                      />
                    </Animated.View>
                  </View>
                )}
                {busy ? (
                  <ActivityIndicator accessibilityLabel={label} color={colors.white} />
                ) : null}
                <Text
                  numberOfLines={1}
                  style={{
                    flexShrink: 1,
                    fontFamily: fonts.black,
                    fontSize: Math.max(18, v(26)),
                    fontVariant: ['tabular-nums'],
                    color: colors.white,
                    textAlign: 'center',
                  }}
                >
                  {label}
                </Text>
              </Pressable>
            </Animated.View>
          </View>
        )}
      </Footer>
    </Animated.View>
  );
}
