import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Pressable, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { copy, itemCount, type Locale } from '../i18n';
import { money } from '../cart';
import type { KioskCartLine } from '../model';
import { productArtworkId, productImage, productPhoto } from '../assets';
import { colors, fonts, useMetrics } from '../theme';
import { Icon } from './Icon';
import { measureRect, motion, useBump, useFly, usePop, useTimingTo, useTween } from './motion';
import { useMotionPreference } from './useMotionPreference';
import { ownerOrange } from './ownerOrange';
const positions = (n: number, locale: Locale) => itemCount(n, locale);
const minorOf = (total: string) => (/^[0-9]{1,15}$/.test(total) ? Number(total) : 0);
/**
 * v3 floating cart pill: blue bag with an orange count badge, item count and
 * total, and the orange checkout pill. When `arrival` was just added on the
 * product screen its photo arcs from the top of the screen into the bag
 * (prototype `fly()`, 780 ms) and the bag bumps as it lands; any other addition
 * bumps the bag at once. The total counts up to its new value (380 ms) and the
 * checkout pill fades between grey and orange. Counts, total and actions are
 * always current; the motion never holds them back.
 */
export function CartBar({
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
}: {
  quantity: number;
  previousQuantity?: number;
  total: string;
  /** Total the bar last showed (minor units), so the new total counts up from it. */
  previousTotal?: string;
  valid: boolean;
  empty: boolean;
  busy: boolean;
  locale: Locale;
  /** Line just added on the product screen: its photo flies into the bag. */
  arrival?: Pick<KioskCartLine, 'product' | 'selections'> | null;
  /** The flying photo reached the bag (at once when nothing flies). */
  onLanded?: () => void;
  onCheckout: () => void;
}) {
  const { v, width } = useMetrics();
  const safe = useSafeAreaInsets();
  const t = copy(locale);
  const start = useRef(previousQuantity ?? quantity);
  const previous = useRef(start.current);
  const [added, setAdded] = useState(false);
  const press = useRef(new Animated.Value(1)).current;
  const reduced = useMotionPreference();
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
  const { flight, launch } = useFly(v(60));
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
  // Prototype start: a 300 pt disc centred 140 pt below the top of the screen.
  const disc = v(300);
  const top = v(140);
  const launched = useRef(false);
  useEffect(() => {
    if (landed.current || launched.current) return;
    let live = true;
    // Measured after the first frame, in this bar's own coordinates.
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
  // Prototype `.cbar .go`: grey while empty, fading 200 ms; dimmed while busy.
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
  const photo = flyer ? productPhoto(flyer) : null;
  return (
    <View
      ref={host}
      testID="kiosk-cart-bar"
      style={{
        paddingTop: v(14),
        paddingBottom: Math.max(safe.bottom, v(22)),
        paddingLeft: Math.max(safe.left, v(20)),
        paddingRight: Math.max(safe.right, v(20)),
      }}
    >
      <View
        style={{
          minHeight: v(100),
          borderRadius: v(50),
          backgroundColor: colors.white,
          shadowColor: '#020A28',
          shadowOpacity: 0.35,
          shadowRadius: 34,
          shadowOffset: { width: 0, height: 14 },
          elevation: 10,
          flexDirection: 'row',
          alignItems: 'center',
          gap: v(16),
          paddingLeft: v(14),
          paddingRight: v(10),
          paddingVertical: v(10),
        }}
      >
        <Animated.View style={{ transform: [{ scale: bump.scale }, { rotate: bump.rotate }] }}>
          <View
            ref={bag}
            collapsable={false}
            style={{
              width: v(76),
              height: v(76),
              borderRadius: v(38),
              backgroundColor: colors.blue,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Icon name="bag-handle-outline" tone="inverse" />
          </View>
          <Animated.View
            style={{
              position: 'absolute',
              top: -v(4),
              right: -v(4),
              minWidth: v(30),
              height: v(30),
              paddingHorizontal: v(4),
              borderRadius: v(15),
              backgroundColor: colors.orangeInk,
              borderWidth: 3,
              borderColor: colors.white,
              alignItems: 'center',
              justifyContent: 'center',
              transform: [{ scale: badge }],
            }}
          >
            <Text style={{ fontFamily: fonts.black, fontSize: v(15), color: colors.white }}>
              {quantity}
            </Text>
          </Animated.View>
        </Animated.View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text
            testID="kiosk-cart-feedback"
            accessibilityLiveRegion="polite"
            numberOfLines={1}
            style={{
              fontFamily: fonts.body,
              fontSize: Math.max(15, v(15)),
              color: added ? colors.orangeInk : colors.muted,
            }}
          >
            {added ? t.selected : quantity ? positions(quantity, locale) : t.cart}
          </Text>
          <Text
            numberOfLines={1}
            adjustsFontSizeToFit
            accessibilityLabel={valid ? money(total) : undefined}
            style={{
              fontFamily: fonts.black,
              fontSize: valid ? v(32) : v(22),
              color: valid ? colors.navy : colors.error,
              fontVariant: ['tabular-nums'],
            }}
          >
            {valid ? display : t.checkCart}
          </Text>
        </View>
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
              minHeight: Math.max(52, v(80)),
              paddingHorizontal: v(32),
              borderRadius: 999,
              backgroundColor: colors.orangeCta,
              shadowColor: colors.orange,
              shadowOpacity: empty ? 0 : 0.4,
              shadowRadius: 18,
              shadowOffset: { width: 0, height: 8 },
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              gap: v(10),
            }}
          >
            <Animated.View
              pointerEvents="none"
              style={{
                position: 'absolute',
                left: 0,
                right: 0,
                top: 0,
                bottom: 0,
                borderRadius: 999,
                backgroundColor: '#C9D2E3',
                opacity: grey,
              }}
            />
            {busy ? (
              <ActivityIndicator accessibilityLabel={t.checkout} color={colors.white} />
            ) : null}
            <Text
              style={{
                fontFamily: fonts.black,
                fontSize: Math.max(24, v(21)),
                color: colors.white,
              }}
            >
              {t.checkout}
            </Text>
          </Pressable>
        </Animated.View>
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
            borderRadius: v(150),
            padding: v(6),
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
              borderRadius: v(150),
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
