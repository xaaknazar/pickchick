import { useEffect, useRef } from 'react';
import { ActivityIndicator, Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { money } from '../cart';
import { copy, type Locale } from '../i18n';
import { colors, fonts, useMetrics } from '../theme';
import { Button } from './Button';
import { Footer } from './Footer';
import { Heading } from './Heading';
import { IconButton } from './IconButton';
import { motion, useEnter, useLoop, usePopIn, useTimingTo, useTween } from './motion';
import { useMotionPreference } from './useMotionPreference';
/**
 * v3 product action bar on blue: a glass quantity capsule with white discs and the
 * orange 96-pt "to cart" pill with a slow shine. Waiting states fade the pill pale
 * (220 ms); the price in its label counts to each new total (380 ms). Tapping the
 * pale pill while a choice is missing calls `onAttention` instead of adding.
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
  onAttention,
}: {
  locale: Locale;
  quantity: number;
  /** Line total in minor units, or null while a required choice is missing. */
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
  /** The guest tapped the pale pill: point them at the missing choice. */
  onAttention?: () => void;
}) {
  const { v } = useMetrics();
  const t = copy(locale);
  const reduced = useMotionPreference();
  const rise = useEnter(220, 480);
  const shine = useLoop(3600);
  // Prototype `.stp output.tick`: the count pops (300 ms --spring) on change.
  const pop = usePopIn(quantity, 300, 0, false);
  const press = useRef(new Animated.Value(1)).current;
  // A reduced-motion switch must also release a press that is already held.
  useEffect(() => {
    press.stopAnimation();
    press.setValue(1);
  }, [reduced, press]);
  const disabled = !valid || !available;
  const blocked = disabled || busy;
  const label = price ? `${t.toCart} · ${money(price)}` : t.required;
  // Prototype `tween()` on #pctaSum: counts up from 0 whenever the price appears,
  // then to each new total; whole tenge while counting.
  const target = price ? Number(price) : 0;
  const counted = useTween(target, motion.enter, 0);
  const shown =
    !price || counted === target
      ? label
      : `${t.toCart} · ${money(String(Math.round(counted / 100) * 100))}`;
  const wait = useTimingTo(disabled ? 1 : 0, 220, 'css');
  // Missing choices keep the pill tappable for feedback only; busy and sold-out do not.
  const attention = !valid && available && !busy && !!onAttention;
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
                // Design keeps the white minus disc at full strength at 1, but the
                // control is still disabled there (VoiceOver announces it as such).
                disabled={quantity <= 1 || busy}
                dim={busy}
                onPress={onMinus}
              />
              <Animated.View
                style={{
                  minWidth: v(44),
                  alignItems: 'center',
                  opacity: pop.opacity,
                  transform: [{ scale: pop.scale }],
                }}
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
                  // Large white label: the accessible orangeCta (#FF6900 is 2.88:1).
                  backgroundColor: colors.orangeCta,
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
                <Animated.View
                  pointerEvents="none"
                  style={{
                    position: 'absolute',
                    left: 0,
                    top: 0,
                    right: 0,
                    bottom: 0,
                    borderRadius: height / 2,
                    backgroundColor: '#FFA466',
                    opacity: wait,
                  }}
                />
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
                  {shown}
                </Text>
              </Pressable>
              {attention ? (
                // Silent layer over the pale pill: a tap points at the missing choice.
                <Pressable
                  accessible={false}
                  importantForAccessibility="no"
                  tabIndex={-1}
                  onPress={onAttention}
                  onPressIn={() => pressTo(0.98)}
                  onPressOut={() => pressTo(1)}
                  style={StyleSheet.absoluteFill}
                />
              ) : null}
            </Animated.View>
          </View>
        )}
      </Footer>
    </Animated.View>
  );
}
