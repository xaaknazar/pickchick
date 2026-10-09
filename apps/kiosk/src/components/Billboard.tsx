import { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, Easing, Pressable, Text, View } from 'react-native';
import { Image } from 'expo-image';
import type { KioskProduct } from '../model';
import { copy, displayCopy, type Locale } from '../i18n';
import { assets, productPhoto } from '../assets';
import { colors, fonts, useMetrics } from '../theme';
import { ProductArtwork } from './ProductArtwork';
import { curve, useTimingTo, type Curve } from './motion';
import { noteProductOrigin } from './reveal';
import { useMotionPreference } from './useMotionPreference';
/** Approved v3 `bill`: 1100 ms cubic-bezier(.65,0,.35,1), a slide every 9 s. */
const slideTime = 1100;
const slideCurve = Easing.bezier(0.65, 0, 0.35, 1);
const every = 9000;
/** The clone snaps back to the first slide 1150 ms after it was reached. */
const snapAfter = 1150;
type Kind = 'master' | 'promo';
/** Track: Master, 7+1 and a Master clone so the loop always slides forward. */
const track: Kind[] = ['master', 'promo', 'master'];
/**
 * v3 menu billboard: the featured combo, cut out and laid straight on the
 * illustrated cream banner (multiply, like the design), with a
 * tilted orange "hit" tag. With `onPromo` it becomes the prototype carousel:
 * Master Combo and the 7 + 1 loyalty offer glide past every 9 s (a clone of the
 * first slide keeps the loop moving forward) and two dots switch slides. The
 * slide that arrives floats its photo in and pops its tag. Under reduced motion
 * it stays on the current slide and the dots switch instantly.
 */
export function Billboard({
  product,
  locale,
  onOpen,
  onPromo,
  slide = 0,
  onSlide,
  testID = 'kiosk-billboard',
}: {
  product: KioskProduct;
  locale: Locale;
  onOpen: () => void;
  /** Tapping the 7 + 1 slide; without it only the featured slide is shown. */
  onPromo?: () => void;
  /** Slide shown first (0 featured, 1 promo), to resume where the guest was. */
  slide?: 0 | 1;
  onSlide?: (slide: 0 | 1) => void;
  testID?: string;
}) {
  const { v } = useMetrics();
  const t = copy(locale);
  const reduced = useMotionPreference();
  const slides = onPromo ? track : track.slice(0, 1);
  const first: number = onPromo ? slide : 0;
  const [width, setWidth] = useState(0);
  // `quiet`: the clone just snapped back, so the first slide must not replay.
  const [state, setState] = useState({ index: first, quiet: false });
  const current = useRef(first);
  const position = useRef(new Animated.Value(first)).current;
  const report = useRef(onSlide);
  useEffect(() => {
    report.current = onSlide;
  }, [onSlide]);
  const go = useCallback(
    (index: number, animate: boolean, quiet = false) => {
      current.current = index;
      setState({ index, quiet });
      report.current?.(index === 1 ? 1 : 0);
      position.stopAnimation();
      if (!animate || reduced) {
        position.setValue(index);
        return;
      }
      Animated.timing(position, {
        toValue: index,
        duration: slideTime,
        easing: slideCurve,
        useNativeDriver: true,
      }).start();
    },
    [position, reduced],
  );
  // Reduced motion lands any glide in progress on its slide (never the clone).
  useEffect(() => {
    if (!reduced) return;
    position.stopAnimation();
    if (current.current === 2) go(0, false, true);
    else position.setValue(current.current);
  }, [go, position, reduced]);
  useEffect(() => {
    if (state.index !== 2) return;
    const timer = setTimeout(() => go(0, false, true), snapAfter);
    return () => clearTimeout(timer);
  }, [go, state.index]);
  useEffect(() => {
    if (!onPromo || reduced) return;
    const timer = setInterval(() => go((current.current % 2) + 1, true), every);
    return () => clearInterval(timer);
  }, [go, onPromo, reduced]);
  useEffect(() => () => position.stopAnimation(), [position]);
  return (
    <View
      style={{
        height: v(250),
        borderRadius: v(28),
        backgroundColor: '#F6F0E4',
        shadowColor: '#020A28',
        shadowOpacity: 0.25,
        shadowRadius: 30,
        shadowOffset: { width: 0, height: 14 },
        elevation: 8,
      }}
    >
      <View
        style={{ flex: 1, borderRadius: v(28), overflow: 'hidden' }}
        onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      >
        <Animated.View
          style={{
            flexDirection: 'row',
            height: '100%',
            width: width ? width * slides.length : `${slides.length * 100}%`,
            transform: [
              {
                translateX: position.interpolate({
                  inputRange: [0, 2],
                  outputRange: [0, -2 * width],
                }),
              },
            ],
          }}
        >
          {slides.map((kind, index) => (
            <Slide
              key={index}
              kind={kind}
              clone={index === 2}
              span={width || `${100 / slides.length}%`}
              active={state.index === index}
              quiet={state.index === index && state.quiet}
              product={product}
              locale={locale}
              testID={index === 0 ? testID : index === 1 ? testID + '-promo' : undefined}
              onPress={kind === 'promo' && onPromo ? onPromo : onOpen}
            />
          ))}
        </Animated.View>
        {onPromo ? (
          <Dots
            dot={state.index === 1 ? 1 : 0}
            label={t.slide}
            onPick={(index) => {
              if (index !== current.current) go(index, true);
            }}
          />
        ) : null}
      </View>
    </View>
  );
}
/** Re-plays 0 -> 1 each time `active` turns on (prototype `.slide.cur`). */
function useArrival(
  active: boolean,
  quiet: boolean,
  duration: number,
  delay: number,
  shape: Curve,
) {
  const reduced = useMotionPreference();
  const value = useRef(new Animated.Value(active && !reduced ? 0 : 1)).current;
  useEffect(() => {
    value.stopAnimation();
    if (!active || quiet || reduced) {
      value.setValue(1);
      return;
    }
    value.setValue(0);
    const animation = Animated.timing(value, {
      toValue: 1,
      duration,
      delay,
      easing: curve(shape),
      useNativeDriver: true,
    });
    animation.start();
    return () => {
      animation.stop();
      value.setValue(1);
    };
  }, [active, delay, duration, quiet, reduced, shape, value]);
  return value;
}
function Slide({
  kind,
  clone,
  span,
  active,
  quiet,
  product,
  locale,
  testID,
  onPress,
}: {
  kind: Kind;
  clone: boolean;
  span: number | `${number}%`;
  active: boolean;
  quiet: boolean;
  product: KioskProduct;
  locale: Locale;
  testID?: string;
  onPress: () => void;
}) {
  const { v } = useMetrics();
  const t = copy(locale);
  // Prototype `bbIn` (900 ms --ease) and the tag `pop` (480 ms after 200 ms, --spring).
  const float = useArrival(active, quiet, 900, 0, 'ease');
  const pop = useArrival(active, quiet, 480, 200, 'spring');
  const photo = productPhoto(product.image_id);
  const plate = v(230);
  // A photo shot on a coloured tile keeps its tile; white shots multiply away.
  const tinted = !!photo && !/^#F/i.test(photo.tile);
  const promo = kind === 'promo';
  const slide = useRef<View>(null);
  return (
    <Pressable
      ref={slide}
      testID={testID}
      accessibilityRole="button"
      // No override: the name comes from the visible tag, name and description
      // (WCAG 2.5.3 label in name). The loop clone is hidden from assistive tech.
      accessibilityElementsHidden={clone}
      importantForAccessibility={clone ? 'no-hide-descendants' : 'auto'}
      aria-hidden={clone || undefined}
      focusable={!clone}
      tabIndex={clone ? -1 : undefined}
      onPress={onPress}
      // The featured product's page opens as a circle from the billboard.
      onPressIn={promo ? undefined : () => noteProductOrigin(slide.current)}
      style={({ pressed }) => ({
        width: span,
        height: '100%',
        overflow: 'hidden',
        backgroundColor: promo ? '#F6EBDD' : '#F6F0E4',
        transform: [{ scale: pressed ? 0.98 : 1 }],
      })}
    >
      <Image
        accessible={false}
        accessibilityLabel=""
        source={promo ? assets.billboardPromo : assets.billboard}
        contentFit="cover"
        contentPosition={promo ? 'right center' : { left: '72%', top: '50%' }}
        style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 }}
      />
      {promo ? null : (
        <Animated.View
          style={{
            position: 'absolute',
            right: v(79),
            top: v(1),
            width: plate,
            height: plate,
            // The white studio shot melts into the illustration (design multiply).
            mixBlendMode: tinted ? 'normal' : 'multiply',
            backgroundColor: tinted ? photo.tile : undefined,
            borderRadius: tinted ? v(28) : 0,
            overflow: 'hidden',
            opacity: float.interpolate({ inputRange: [0, 1], outputRange: [0.2, 1] }),
            transform: [
              { translateX: float.interpolate({ inputRange: [0, 1], outputRange: [v(50), 0] }) },
              { scale: float.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1] }) },
              { rotate: float.interpolate({ inputRange: [0, 1], outputRange: ['4deg', '0deg'] }) },
            ],
          }}
        >
          {photo ? (
            <Image
              accessible={false}
              accessibilityLabel=""
              source={photo.source}
              contentFit="contain"
              style={{ width: '100%', height: '100%' }}
            />
          ) : (
            <ProductArtwork imageId={product.image_id} variant="feature" />
          )}
        </Animated.View>
      )}
      <Animated.View
        style={{
          position: 'absolute',
          left: v(22),
          top: v(20),
          height: v(40),
          paddingHorizontal: v(16),
          borderRadius: v(12),
          backgroundColor: colors.orange,
          justifyContent: 'center',
          shadowColor: colors.orange,
          shadowOpacity: 0.35,
          shadowRadius: 14,
          shadowOffset: { width: 0, height: 6 },
          opacity: pop.interpolate({
            inputRange: [0, 1],
            outputRange: [0, 1],
            extrapolate: 'clamp',
          }),
          transform: [
            { rotate: '-4deg' },
            { scale: pop.interpolate({ inputRange: [0, 1], outputRange: [0.3, 1] }) },
          ],
        }}
      >
        <Text
          style={{
            fontFamily: fonts.black,
            fontSize: v(15),
            letterSpacing: 1.4,
            color: colors.white,
          }}
        >
          {promo ? '7 + 1' : t.hit}
        </Text>
      </Animated.View>
      <View
        style={{
          position: 'absolute',
          left: v(26),
          top: v(76),
          bottom: v(22),
          width: v(promo ? 330 : 300),
          gap: v(promo ? 8 : 6),
        }}
      >
        {promo ? (
          <Text
            numberOfLines={2}
            adjustsFontSizeToFit
            style={{
              fontFamily: fonts.black,
              fontSize: v(30),
              lineHeight: v(34),
              letterSpacing: -0.4,
              color: colors.navy,
            }}
          >
            {t.p7Title + '\n'}
            <Text style={{ color: colors.orange }}>{t.p7Gift}</Text>
          </Text>
        ) : (
          <Text
            numberOfLines={1}
            adjustsFontSizeToFit
            style={{
              fontFamily: fonts.black,
              fontSize: v(34),
              lineHeight: v(38),
              letterSpacing: -0.5,
              color: colors.navy,
            }}
          >
            {product.name}
          </Text>
        )}
        <Text
          numberOfLines={3}
          style={{
            fontFamily: fonts.body,
            fontSize: Math.max(15, v(15)),
            lineHeight: Math.max(21, v(21)),
            color: colors.muted,
          }}
        >
          {promo ? t.p7Sub : displayCopy(product.description)}
        </Text>
      </View>
    </Pressable>
  );
}
/** Dot geometry in pt: 8 pt dots, 6 pt apart, the current one 26 pt long. */
const dotSize = 8;
const dotLong = 26;
const dotGap = 6;
const stretch = dotLong - dotSize;
const dotsWidth = dotLong + dotGap + dotSize;
type Value = Animated.AnimatedInterpolation<number>;
/**
 * Prototype `.dots`: the current dot stretches from 8 to 26 pt and darkens over
 * 300 ms (navy, orange while the 7 + 1 slide is shown). The stretch is drawn as
 * two round caps and a middle bar scaled on the X axis, so only transforms and
 * opacity animate.
 */
function Dots({
  dot,
  label,
  onPick,
}: {
  dot: 0 | 1;
  label: string;
  onPick: (index: 0 | 1) => void;
}) {
  const k = useTimingTo(dot, 300, 'css');
  const range = (a: number, b: number) =>
    k.interpolate({ inputRange: [0, 1], outputRange: [a, b] });
  // Dot 0 spans [0, 26 - 18k]; dot 1 spans [32 - 18k, 40].
  const firstDot = { left: range(0, 0), length: range(dotLong, dotSize) };
  const secondDot = {
    left: range(dotLong + dotGap, dotSize + dotGap),
    length: range(dotSize, dotLong),
  };
  return (
    <View
      style={{
        position: 'absolute',
        right: 18,
        bottom: 16,
        width: dotsWidth,
        height: dotSize,
      }}
    >
      {/* Design: the idle dot is navy .3 on the cream slide, white .6 on the 7 + 1 slide. */}
      <Pill {...firstDot} tint={colors.navy} opacity={range(1, 0)} />
      <Pill {...firstDot} tint={colors.white} opacity={range(0, 0.6)} />
      <Pill {...secondDot} tint={colors.navy} opacity={range(0.3, 0)} />
      <Pill {...secondDot} tint={colors.orange} opacity={range(0, 1)} />
      {([0, 1] as const).map((index) => (
        <Pressable
          key={index}
          testID={'kiosk-billboard-dot-' + index}
          accessibilityRole="button"
          accessibilityLabel={label + ' ' + (index + 1)}
          accessibilityState={{ selected: dot === index }}
          onPress={() => onPick(index)}
          hitSlop={8}
          style={{
            position: 'absolute',
            top: -12,
            bottom: -12,
            left: index ? dotsWidth / 2 : -6,
            right: index ? -6 : dotsWidth / 2,
          }}
        />
      ))}
    </View>
  );
}
function Pill({
  left,
  length,
  tint,
  opacity,
}: {
  left: Value;
  length: Value;
  tint: string;
  opacity: Value;
}) {
  const cap = {
    position: 'absolute' as const,
    top: 0,
    left: 0,
    width: dotSize,
    height: dotSize,
    borderRadius: dotSize / 2,
    backgroundColor: tint,
  };
  return (
    <Animated.View
      pointerEvents="none"
      needsOffscreenAlphaCompositing
      style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, opacity }}
    >
      <Animated.View style={{ ...cap, transform: [{ translateX: left }] }} />
      <Animated.View
        style={{
          ...cap,
          transform: [{ translateX: Animated.add(left, Animated.add(length, -dotSize)) }],
        }}
      />
      {/* Middle bar: `stretch` pt wide at x = 4, scaled about its centre. */}
      <Animated.View
        style={{
          position: 'absolute',
          top: 0,
          left: dotSize / 2,
          width: stretch,
          height: dotSize,
          backgroundColor: tint,
          transform: [
            {
              translateX: Animated.add(
                Animated.add(left, Animated.multiply(length, 0.5)),
                -(dotSize / 2 + stretch / 2),
              ),
            },
            {
              scaleX: Animated.add(length, -dotSize).interpolate({
                inputRange: [0, stretch],
                outputRange: [0.001, 1],
              }),
            },
          ],
        }}
      />
    </Animated.View>
  );
}
