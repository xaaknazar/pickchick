import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { copy, type Locale } from '../i18n';
import { money } from '../cart';
import type { KioskCartLine } from '../model';
import { productArtworkId, productImage, productPhoto } from '../assets';
import { colors, fonts, redesign, useMetrics } from '../theme';
import { GlassPanel } from './GlassPanel';
import { Icon } from './Icon';
import { PhotoImage } from './PhotoImage';
import {
  measureRect,
  motion,
  useBump,
  useFly,
  usePop,
  usePress,
  useTimingTo,
  useTween,
} from './motion';
import { useMotionPreference } from './useMotionPreference';
import { ownerOrange } from './ownerOrange';
import { fixedText } from './Body';
const minorOf = (total: string) => (/^[0-9]{1,15}$/.test(total) ? Number(total) : 0);
/** Cart photos shown in the panel; the orange counter carries the whole quantity. */
const THUMBS = 3;
/**
 * Bento menu checkout panel (kiosk redesign 2026-10-13, README "Нижняя панель"): a glass bar
 * (16 pt from the sides, 22 pt from the bottom, 112 high, radius 56) under a 220 pt darkening
 * that lets the grid scroll beneath it. On the left the round photos of the cart lines (74 pt,
 * overlapping by 22) with the orange item counter, the line names (17, 75 % white) and the total
 * (Montserrat 900, 36): together a button that opens the cart page to change quantities. On the
 * right the orange "Оформить заказ →" (88 high, Montserrat 900 27), disabled while the cart is
 * empty or busy. When `arrival` was just added on the product screen its photo arcs from the top
 * of the screen onto the photos (prototype `fly()`, 780 ms), which bump as it lands; any other
 * addition bumps them at once. The total counts up to its new value (380 ms). Counts, total and
 * actions are always current; the motion never holds them back, and none plays under reduced
 * motion.
 */
export function CartBar({
  lines,
  quantity,
  previousQuantity,
  total,
  previousTotal,
  valid,
  empty,
  busy,
  locale,
  arrival,
  onLanded,
  onCheckout,
  onOpenCart,
}: {
  /** Cart lines in order (photos and names). */
  lines: readonly KioskCartLine[];
  quantity: number;
  previousQuantity?: number;
  total: string;
  /** Total the bar last showed (minor units), so the new total counts up from it. */
  previousTotal?: string;
  valid: boolean;
  empty: boolean;
  busy: boolean;
  locale: Locale;
  /** Line just added on the product screen: its photo flies onto the cart photos. */
  arrival?: Pick<KioskCartLine, 'product' | 'selections'> | null;
  /** The flying photo landed (at once when nothing flies). */
  onLanded?: () => void;
  onCheckout: () => void;
  /** The order summary was tapped: the cart page, to change or remove lines. */
  onOpenCart: () => void;
}) {
  const { px, width } = useMetrics();
  const safe = useSafeAreaInsets();
  const t = copy(locale);
  const start = useRef(previousQuantity ?? quantity);
  const previous = useRef(start.current);
  const [added, setAdded] = useState(false);
  const press = useRef(new Animated.Value(1)).current;
  const reduced = useMotionPreference();
  const summaryPress = usePress(0.98);
  // A reduced-motion switch must also release a press that is already held.
  useEffect(() => {
    press.stopAnimation();
    press.setValue(1);
  }, [reduced, press]);
  const badge = usePop(quantity);
  // Prototype `.bagc.bump` (520 ms --spring): after the flight lands, or at once.
  const [bumps, setBumps] = useState(0);
  const bump = useBump(bumps);
  const host = useRef<View>(null);
  const bag = useRef<View>(null);
  const { flight, launch } = useFly(px(74));
  const [flyer] = useState(() =>
    arrival && quantity > start.current
      ? productArtworkId(arrival.product, arrival.selections)
      : null,
  );
  const landed = useRef(!flyer);
  const landedCallback = useRef(onLanded);
  useEffect(() => {
    landedCallback.current = onLanded;
  }, [onLanded]);
  const land = useCallback(() => {
    if (landed.current) return;
    landed.current = true;
    setBumps((value) => value + 1);
    landedCallback.current?.();
  }, []);
  // Prototype start: a 375 pt disc centred 175 pt below the top of the screen.
  const disc = px(375);
  const top = px(175);
  const launched = useRef(false);
  useEffect(() => {
    if (landed.current || launched.current) return;
    let live = true;
    // Measured after the first frame, in this panel's own coordinates.
    const frame = requestAnimationFrame(() => {
      void Promise.all([measureRect(host.current), measureRect(bag.current)]).then(
        ([box, target]) => {
          if (!live || launched.current) return;
          launched.current = true;
          if (!box || !target || !target.width) {
            land();
            return;
          }
          const from = {
            x: width / 2 - disc / 2 - box.x,
            y: top - box.y,
            width: disc,
            height: disc,
          };
          const to = { ...target, x: target.x - box.x, y: target.y - box.y };
          void launch(from, to).then(land);
        },
      );
    });
    return () => {
      live = false;
      cancelAnimationFrame(frame);
    };
  }, [disc, land, launch, top, width]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (quantity > previous.current) {
      setAdded(true);
      if (landed.current) setBumps((value) => value + 1);
      timer = setTimeout(() => setAdded(false), 1800);
    } else setAdded(false);
    previous.current = quantity;
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [quantity]);
  // Prototype `tween()`: the total counts to its new value; whole tenge only.
  const minor = minorOf(total);
  const shown = useTween(minor, motion.enter, minorOf(previousTotal ?? total));
  const display = shown === minor ? money(total) : money(String(Math.round(shown / 100) * 100));
  // Disabled look while empty, fading 200 ms; dimmed while busy.
  const grey = useTimingTo(empty ? 1 : 0, 200, 'css');
  const dim = useTimingTo(busy ? 0.7 : 1, 200, 'css');
  const blocked = empty || busy;
  const squeeze = (down: boolean) => {
    press.stopAnimation();
    Animated.timing(press, {
      toValue: down && !reduced ? 0.97 : 1,
      duration: reduced ? 0 : motion.press,
      useNativeDriver: true,
    }).start();
  };
  const names = [...new Set(lines.map((line) => line.product.name))].join(', ');
  const shownLines = lines.slice(0, THUMBS);
  const thumb = px(74);
  const photo = flyer ? productPhoto(flyer) : null;
  const caption = added ? t.selected : names || (empty ? t.emptyCartHint : t.checkCart);
  return (
    <View
      ref={host}
      testID="kiosk-cart-bar"
      pointerEvents="box-none"
      style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: px(220) }}
    >
      <LinearGradient
        pointerEvents="none"
        colors={[redesign.scrim[0], redesign.scrim[1]]}
        locations={[0, 0.75]}
        style={StyleSheet.absoluteFill}
      />
      <View
        style={{
          position: 'absolute',
          left: Math.max(safe.left, px(16)),
          right: Math.max(safe.right, px(16)),
          bottom: Math.max(safe.bottom, px(22)),
        }}
      >
        <GlassPanel shape="bar">
          <View
            style={{
              flex: 1,
              height: px(110),
              flexDirection: 'row',
              alignItems: 'center',
              gap: px(16),
              paddingLeft: px(16),
              paddingRight: px(11),
            }}
          >
            <Animated.View
              style={{ flex: 1, minWidth: 0, transform: [{ scale: summaryPress.scale }] }}
            >
              <Pressable
                testID="kiosk-cart-open"
                accessibilityRole="button"
                // No label override: the name is the visible count, lines and total (WCAG 2.5.3
                // label in name); the hint says what the tap does.
                accessibilityHint={t.cartOpen}
                accessibilityState={{ disabled: empty }}
                disabled={empty}
                onPress={onOpenCart}
                onPressIn={summaryPress.onPressIn}
                onPressOut={summaryPress.onPressOut}
                style={{ flexDirection: 'row', alignItems: 'center', gap: px(16), minWidth: 0 }}
              >
                <Animated.View
                  style={{
                    marginRight: quantity ? px(18) : 0,
                    transform: [{ scale: bump.scale }, { rotate: bump.rotate }],
                  }}
                >
                  <View ref={bag} collapsable={false} style={{ flexDirection: 'row' }}>
                    {shownLines.length ? (
                      shownLines.map((line, index) => (
                        <View
                          key={line.lineId}
                          style={{
                            width: thumb,
                            height: thumb,
                            marginLeft: index ? -px(22) : 0,
                            borderRadius: thumb / 2,
                            backgroundColor: colors.white,
                            borderWidth: px(2),
                            borderColor: 'rgba(255,255,255,.9)',
                            overflow: 'hidden',
                            padding: px(4),
                          }}
                        >
                          <PhotoImage imageId={productArtworkId(line.product, line.selections)} />
                        </View>
                      ))
                    ) : (
                      <View
                        style={{
                          width: thumb,
                          height: thumb,
                          borderRadius: thumb / 2,
                          backgroundColor: 'rgba(255,255,255,.10)',
                          borderWidth: 1,
                          borderColor: redesign.glassLine,
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        <Icon name="bag-handle-outline" tone="inverse" />
                      </View>
                    )}
                  </View>
                  {quantity ? (
                    <Animated.View
                      {...ownerOrange}
                      style={{
                        position: 'absolute',
                        top: px(2),
                        right: -px(20),
                        minWidth: px(34),
                        height: px(34),
                        paddingHorizontal: px(6),
                        borderRadius: px(17),
                        backgroundColor: redesign.cta,
                        borderWidth: px(2),
                        borderColor: colors.white,
                        alignItems: 'center',
                        justifyContent: 'center',
                        transform: [{ scale: badge }],
                      }}
                    >
                      <Text
                        {...fixedText}
                        style={{ fontFamily: fonts.black, fontSize: px(16), color: colors.white }}
                      >
                        {quantity}
                      </Text>
                    </Animated.View>
                  ) : null}
                </Animated.View>
                <View style={{ flex: 1, minWidth: 0, gap: px(2) }}>
                  <Text
                    {...fixedText}
                    testID="kiosk-cart-feedback"
                    accessibilityLiveRegion="polite"
                    numberOfLines={1}
                    style={{
                      fontFamily: fonts.medium,
                      fontSize: px(17),
                      lineHeight: px(22),
                      color: added ? colors.orangeOnBlue : 'rgba(255,255,255,.75)',
                    }}
                  >
                    {caption}
                  </Text>
                  <Text
                    {...fixedText}
                    numberOfLines={1}
                    accessibilityLabel={valid ? money(total) : undefined}
                    style={{
                      fontFamily: fonts.black,
                      fontSize: valid ? px(36) : px(24),
                      lineHeight: valid ? px(42) : px(30),
                      letterSpacing: -0.4,
                      color: valid ? colors.white : colors.orangeOnBlue,
                      fontVariant: ['tabular-nums'],
                    }}
                  >
                    {valid ? display : t.checkCart}
                  </Text>
                </View>
              </Pressable>
            </Animated.View>
            <Animated.View style={{ opacity: dim, transform: [{ scale: press }] }}>
              <Pressable
                testID="kiosk-menu-checkout"
                {...ownerOrange}
                accessibilityRole="button"
                accessibilityLabel={t.checkout}
                accessibilityState={{ disabled: blocked, busy }}
                disabled={blocked}
                onPress={onCheckout}
                onPressIn={() => squeeze(true)}
                onPressOut={() => squeeze(false)}
                style={{
                  height: Math.max(52, px(88)),
                  paddingLeft: px(34),
                  paddingRight: px(30),
                  borderRadius: 999,
                  backgroundColor: redesign.cta,
                  shadowColor: redesign.cta,
                  shadowOpacity: empty ? 0 : 0.5,
                  shadowRadius: px(13),
                  shadowOffset: { width: 0, height: px(10) },
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: px(14),
                }}
              >
                {/* Empty cart: a quiet slate pill instead of the orange call to action. */}
                <Animated.View
                  pointerEvents="none"
                  style={{
                    position: 'absolute',
                    left: 0,
                    right: 0,
                    top: 0,
                    bottom: 0,
                    borderRadius: 999,
                    backgroundColor: '#3E4C6E',
                    opacity: grey,
                  }}
                />
                {busy ? (
                  <ActivityIndicator accessibilityLabel={t.checkout} color={colors.white} />
                ) : null}
                <Text
                  {...fixedText}
                  numberOfLines={1}
                  style={{
                    fontFamily: fonts.black,
                    fontSize: px(27),
                    color: empty ? 'rgba(255,255,255,.6)' : colors.white,
                  }}
                >
                  {t.checkout}
                </Text>
                <Icon name="arrow-forward" size="small" tone={empty ? 'onBlue' : 'inverse'} />
              </Pressable>
            </Animated.View>
          </View>
        </GlassPanel>
      </View>
      {flight && flyer ? (
        // Prototype `.flyer`: a white-ringed photo disc; decorative, never touchable.
        <Animated.View
          key={flight.id}
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          aria-hidden
          style={{
            ...flight.style,
            zIndex: 20,
            borderRadius: px(190),
            padding: px(8),
            backgroundColor: colors.white,
            shadowColor: '#020A28',
            shadowOpacity: 0.35,
            shadowRadius: 36,
            shadowOffset: { width: 0, height: 18 },
            elevation: 20,
          }}
        >
          <View
            style={{
              flex: 1,
              borderRadius: px(190),
              overflow: 'hidden',
              backgroundColor: photo?.tile ?? colors.white,
            }}
          >
            <Image
              accessible={false}
              accessibilityLabel=""
              source={photo?.source ?? productImage(flyer)}
              contentFit="cover"
              style={{ width: '100%', height: '100%' }}
            />
          </View>
        </Animated.View>
      ) : null}
    </View>
  );
}
