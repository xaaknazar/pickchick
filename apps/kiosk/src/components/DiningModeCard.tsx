import { useEffect, useRef, type ReactNode } from 'react';
import { Animated, Pressable, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { assets } from '../assets';
import { copy, type Locale } from '../i18n';
import { colors, fonts, useMetrics } from '../theme';
import { fixedText } from './Body';
import { Icon } from './Icon';
import { motion, useEnter, useLoop } from './motion';
import { armReveal, trackRevealTile } from './reveal';
import { useMotionPreference } from './useMotionPreference';
/** v3 02 question above the dining choice, fading up on arrival. */
export function DiningModeTitle({ children }: { children?: ReactNode }) {
  const { v } = useMetrics();
  const enter = useEnter(0, motion.rise);
  return (
    <Animated.View
      style={{
        paddingTop: v(44),
        paddingHorizontal: v(48),
        opacity: enter,
        transform: [
          { translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [v(22), 0] }) },
        ],
      }}
    >
      <Text
        {...fixedText}
        accessibilityRole="header"
        style={{
          fontFamily: fonts.black,
          fontSize: v(62),
          lineHeight: v(68),
          letterSpacing: -v(1),
          color: colors.white,
        }}
      >
        {children}
      </Text>
    </Animated.View>
  );
}
/**
 * v3 dining tile: a blue (here) or orange (to go) slab with a soft glow, the
 * chef sliding in from the right and bobbing, a glass tag and a white arrow disc.
 */
export function DiningModeCard({
  mode,
  locale,
  busy,
  onSelect,
}: {
  mode: 'dine_in' | 'takeaway';
  locale: Locale;
  busy: boolean;
  onSelect: () => void;
}) {
  const { v, width, height } = useMetrics();
  const reduced = useMotionPreference();
  const t = copy(locale);
  const here = mode === 'dine_in';
  // Large white headings use the accessible orange surface; the glow stays brand orange.
  const tint = here ? colors.blue : colors.orangeCta;
  const rise = useEnter(here ? 90 : 180, 620);
  // Prototype `chefIn` (700 ms, spring curve): slides in from 120 pt at 8deg, overshoots.
  const chef = useEnter(here ? 320 : 420, 700, 'spring');
  // Prototype `bob` 3.4 s: here waits 1 s, to go starts .8 s into its cycle, so
  // the two chefs alternate.
  const bob = useLoop(3400, here ? 1000 : 0, true, here ? 0 : 800);
  const glow = useLoop(4000, 0, true);
  const nudge = useLoop(1400, 0, true);
  const scale = useRef(new Animated.Value(1)).current;
  // The tile's window rectangle seeds the zoom fill that opens the menu.
  const tile = useRef<View>(null);
  // Measure once the entrance has settled (and again after a resize), so even a
  // tap quicker than an asynchronous measurement starts the fill from the tile.
  useEffect(() => {
    const timer = setTimeout(() => trackRevealTile(mode, tile.current), 1000);
    return () => clearTimeout(timer);
  }, [height, mode, width]);
  // A reduced-motion switch must also release a press that is already held.
  useEffect(() => {
    scale.stopAnimation();
    scale.setValue(1);
  }, [reduced, scale]);
  const press = (pressed: boolean) => {
    scale.stopAnimation();
    Animated.timing(scale, {
      toValue: pressed && !reduced ? 0.96 : 1,
      duration: reduced ? 0 : motion.press,
      useNativeDriver: true,
    }).start();
  };
  const radius = v(44);
  const glowSize = v(620);
  const chefSize = v(380);
  const go = v(88);
  return (
    <Animated.View
      ref={tile}
      style={{
        flex: 1,
        minHeight: Math.max(240, v(300)),
        borderRadius: radius,
        backgroundColor: tint,
        shadowColor: here ? '#000000' : colors.orange,
        shadowOpacity: 0.35,
        shadowRadius: v(22),
        shadowOffset: { width: 0, height: v(20) },
        opacity: rise,
        transform: [
          { translateY: rise.interpolate({ inputRange: [0, 1], outputRange: [v(34), 0] }) },
          { scale: rise.interpolate({ inputRange: [0, 1], outputRange: [0.97, 1] }) },
          { scale },
        ],
      }}
    >
      <Pressable
        testID={'kiosk-mode-' + (here ? 'dine-in' : 'takeaway')}
        accessibilityRole="button"
        accessibilityState={{ disabled: busy }}
        disabled={busy}
        onPress={() => {
          armReveal(mode, tile.current);
          onSelect();
        }}
        onPressIn={() => {
          trackRevealTile(mode, tile.current);
          press(true);
        }}
        onPressOut={() => press(false)}
        style={{
          flex: 1,
          borderRadius: radius,
          backgroundColor: tint,
          borderWidth: here ? 1 : 0,
          borderColor: 'rgba(255,255,255,.14)',
          overflow: 'hidden',
          opacity: busy ? 0.8 : 1,
        }}
      >
        <Animated.View
          pointerEvents="none"
          style={{
            position: 'absolute',
            right: -v(120),
            top: -v(90),
            width: glowSize,
            height: glowSize,
            alignItems: 'center',
            justifyContent: 'center',
            opacity: glow.interpolate({ inputRange: [0, 1], outputRange: [0.75, 1] }),
            transform: [
              { scale: glow.interpolate({ inputRange: [0, 1], outputRange: [1, 1.06] }) },
            ],
          }}
        >
          {[1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2].map((size) => (
            <View
              key={size}
              style={{
                position: 'absolute',
                width: glowSize * size,
                height: glowSize * size,
                borderRadius: (glowSize * size) / 2,
                backgroundColor: here ? 'rgba(255,255,255,.026)' : 'rgba(255,255,255,.03)',
              }}
            />
          ))}
        </Animated.View>
        <Animated.View
          pointerEvents="none"
          style={{
            position: 'absolute',
            right: -v(40),
            bottom: -v(30),
            width: chefSize,
            height: chefSize,
            opacity: chef.interpolate({
              inputRange: [0, 1],
              outputRange: [0, 1],
              extrapolate: 'clamp',
            }),
            transform: [
              { translateX: chef.interpolate({ inputRange: [0, 1], outputRange: [v(120), 0] }) },
              { rotate: chef.interpolate({ inputRange: [0, 1], outputRange: ['8deg', '0deg'] }) },
              { translateY: bob.interpolate({ inputRange: [0, 1], outputRange: [0, -v(12)] }) },
            ],
          }}
        >
          <Image
            accessible={false}
            accessibilityLabel=""
            source={here ? assets.chefTray : assets.chefBag}
            contentFit="contain"
            style={{ width: chefSize, height: chefSize }}
          />
        </Animated.View>
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            left: v(44),
            top: v(40),
            height: v(44),
            paddingHorizontal: v(18),
            borderRadius: 999,
            backgroundColor: here ? 'rgba(255,255,255,.18)' : colors.orangeInk,
            justifyContent: 'center',
          }}
        >
          <Text
            {...fixedText}
            style={{
              fontFamily: fonts.heavy,
              fontSize: v(15),
              letterSpacing: v(15) * 0.08,
              color: colors.white,
            }}
          >
            {here ? t.hereTag : t.togoTag}
          </Text>
        </View>
        <View
          pointerEvents="none"
          style={{ position: 'absolute', left: v(44), bottom: v(44), right: v(44), gap: v(10) }}
        >
          <Text
            {...fixedText}
            numberOfLines={1}
            adjustsFontSizeToFit
            style={{
              fontFamily: fonts.black,
              fontSize: v(70),
              lineHeight: v(74),
              letterSpacing: -v(1),
              color: colors.white,
              textTransform: 'uppercase',
            }}
          >
            {here ? t.here : t.togo}
          </Text>
          <Text
            {...fixedText}
            style={{
              fontFamily: fonts.body,
              fontSize: v(28),
              lineHeight: v(34),
              color: here ? 'rgba(255,255,255,.9)' : colors.white,
            }}
          >
            {here ? t.hereSub : t.togoSub}
          </Text>
          <View
            style={{
              width: go,
              height: go,
              marginTop: v(14),
              borderRadius: go / 2,
              backgroundColor: colors.white,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Animated.View
              style={{
                transform: [
                  { translateX: nudge.interpolate({ inputRange: [0, 1], outputRange: [0, v(7)] }) },
                ],
              }}
            >
              <Icon name="arrow-forward" size="large" tone={here ? 'brand' : 'accent'} />
            </Animated.View>
          </View>
        </View>
      </Pressable>
    </Animated.View>
  );
}
