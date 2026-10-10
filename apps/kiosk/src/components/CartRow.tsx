import { useEffect, useMemo, useRef } from 'react';
import { Animated, Pressable, Text, View } from 'react-native';
import { PhotoImage } from './PhotoImage';
import type { KioskCartLine } from '../model';
import { money } from '../cart';
import { copy, type Locale } from '../i18n';
import { heroPhoto, productImage, productPhoto, productArtworkId, type Photo } from '../assets';
import { colors, fonts, useMetrics } from '../theme';
import { Icon } from './Icon';
import { isSingleItem } from './categories';
import { ease, usePopIn, usePress, useStagger } from './motion';
import { useMotionPreference } from './useMotionPreference';
import { fixedText } from './Body';
/**
 * One line per chosen option, in the same wording as the summary ("Соус × 2"); a paid
 * extra shows its price per item ("+690 ₸").
 */
function selectionLines(line: KioskCartLine) {
  return line.selections
    .map((selection) => {
      const option = line.product.modifier_groups
        .find((g) => g.id === selection.group_id)
        ?.options.find((o) => o.id === selection.option_id);
      if (!option) return '';
      const delta = BigInt(option.price_delta_minor) * BigInt(selection.quantity);
      return `${option.label}${selection.quantity > 1 ? ` × ${selection.quantity}` : ''}${
        delta > 0n ? `  +${money(delta.toString())}` : ''
      }`;
    })
    .filter(Boolean);
}
/**
 * v3 cart line: white 30-pt card, 140-pt photo tile (blue studio shot for combos,
 * duos and sets), name, chosen options with blue checks, the "Изменить" capsule
 * (05-cart.png; products with choices reopen their page with this line), the line
 * total and a soft capsule stepper (white minus, orange plus). Rows rise in stagger.
 * Removing the line (minus at 1) slides it out at once (prototype
 * `.line.gone`: fade, -80 pt, scale .96, 280 ms) while the cart updates; a line
 * that is still there afterwards slides back. `leaving` keeps a removed line on
 * screen, untouchable and without ids, until that exit ends (`onLeft`).
 */
export function CartRow({
  line,
  locale,
  busy,
  onQuantity,
  onEdit,
  position = 0,
  leaving = false,
  onLeft,
}: {
  line: KioskCartLine;
  locale: Locale;
  busy: boolean;
  onQuantity: (quantity: number) => void;
  /** Reopens the product page with this line's choice (shown when it has choices). */
  onEdit?: () => void;
  position?: number;
  /** Already removed from the cart: finish the exit, then call `onLeft`. */
  leaving?: boolean;
  onLeft?: () => void;
}) {
  const { v } = useMetrics();
  const t = copy(locale);
  const reduced = useMotionPreference();
  const rise = useStagger(position);
  // Prototype `.stp output.tick`: the count pops (300 ms --spring) on change.
  const tick = usePopIn(line.quantity, 300, 0, false);
  const gone = useRef(new Animated.Value(0)).current;
  const state = useRef({ departing: false, out: false, leaving, busy, onLeft });
  state.current.leaving = leaving;
  state.current.busy = busy;
  state.current.onLeft = onLeft;
  const left = () => {
    if (state.current.leaving) state.current.onLeft?.();
  };
  const settle = () => {
    state.current.departing = false;
    state.current.out = false;
    gone.stopAnimation();
    if (reduced) gone.setValue(0);
    else
      Animated.spring(gone, {
        toValue: 0,
        stiffness: 260,
        damping: 22,
        useNativeDriver: true,
      }).start();
  };
  const depart = () => {
    if (reduced || state.current.departing) return;
    state.current.departing = true;
    state.current.out = false;
    gone.stopAnimation();
    Animated.timing(gone, { toValue: 1, duration: 280, easing: ease, useNativeDriver: true }).start(
      ({ finished }) => {
        if (!finished) return;
        state.current.out = true;
        left();
      },
    );
  };
  // Nothing removed the line for a while (no update ran): slide back.
  const fallback = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (fallback.current) clearTimeout(fallback.current);
    },
    [],
  );
  const change = (quantity: number) => {
    if (quantity <= 0 && !reduced) {
      if (fallback.current) clearTimeout(fallback.current);
      fallback.current = setTimeout(() => {
        if (!state.current.leaving && !state.current.busy && state.current.departing) settle();
      }, 1500);
    }
    if (quantity <= 0) depart();
    onQuantity(quantity);
  };
  // Removed from the cart: make sure the exit runs (or has run), then let go.
  useEffect(() => {
    if (!leaving) return;
    if (reduced) {
      state.current.onLeft?.();
      return;
    }
    if (state.current.out) state.current.onLeft?.();
    else depart();
    // Only a change of `leaving` or motion re-runs this; `depart` reads refs.
  }, [leaving, reduced]);
  // The update finished but the line is still here (it failed): slide back.
  useEffect(() => {
    if (busy || leaving || !state.current.departing) return;
    const timer = setTimeout(() => {
      if (!state.current.leaving && !state.current.busy && state.current.departing) settle();
    }, 320);
    return () => clearTimeout(timer);
  }, [busy, leaving]);
  // Reduced motion mid-exit: rest at once.
  useEffect(() => {
    if (!reduced) return;
    gone.stopAnimation();
    gone.setValue(0);
    state.current.departing = false;
  }, [gone, reduced]);
  const opacity = useMemo(
    () => Animated.multiply(rise, gone.interpolate({ inputRange: [0, 1], outputRange: [1, 0] })),
    [gone, rise],
  );
  const scale = useMemo(
    () =>
      Animated.multiply(
        rise.interpolate({ inputRange: [0, 1], outputRange: [0.97, 1] }),
        gone.interpolate({ inputRange: [0, 1], outputRange: [1, 0.96] }),
      ),
    [gone, rise],
  );
  const editPress = usePress(0.95);
  const minusPress = usePress(0.9);
  const plusPress = usePress(0.9);
  const product = line.product;
  const set = !isSingleItem(product);
  const imageId = productArtworkId(product, line.selections);
  const photo: Photo = (set ? heroPhoto(imageId) : productPhoto(imageId)) ?? {
    source: productImage(imageId),
    tile: colors.cream,
    cutout: false,
  };
  const options = selectionLines(line);
  const prefix = 'kiosk-cart-line-' + line.lineId;
  // A leaving copy keeps no automation ids, so tests only ever see live lines.
  const id = (suffix: string) => (leaving ? undefined : prefix + suffix);
  const max = 20;
  const step = Math.max(48, v(54));
  return (
    <Animated.View
      testID={id('')}
      pointerEvents={leaving ? 'none' : 'auto'}
      accessibilityElementsHidden={leaving}
      importantForAccessibility={leaving ? 'no-hide-descendants' : 'auto'}
      style={{
        opacity,
        transform: [
          { translateY: rise.interpolate({ inputRange: [0, 1], outputRange: [v(34), 0] }) },
          { translateX: gone.interpolate({ inputRange: [0, 1], outputRange: [0, -80] }) },
          { scale },
        ],
        borderRadius: v(30),
        backgroundColor: colors.white,
        shadowColor: '#020A28',
        shadowOpacity: 0.22,
        shadowRadius: 28,
        shadowOffset: { width: 0, height: 12 },
        elevation: 6,
        padding: v(16),
        flexDirection: 'row',
        alignItems: 'stretch',
        gap: v(20),
      }}
    >
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{
          width: v(140),
          height: v(140),
          borderRadius: v(22),
          backgroundColor: photo.tile,
          padding: photo.cutout ? v(12) : 0,
          overflow: 'hidden',
        }}
      >
        <PhotoImage imageId={imageId} variant={set ? 'cart' : 'card'} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: v(8), paddingVertical: v(4) }}>
        <Text
          {...fixedText}
          accessibilityRole="header"
          style={{
            fontFamily: fonts.heavy,
            fontSize: v(25),
            lineHeight: v(29),
            letterSpacing: -0.2,
            color: colors.navy,
          }}
        >
          {product.name}
        </Text>
        {options.length ? (
          <View style={{ gap: v(4) }}>
            {options.map((option, index) => (
              <View
                key={option + index}
                style={{ flexDirection: 'row', alignItems: 'center', gap: v(8) }}
              >
                <Icon name="checkmark" size="small" tone="brand" />
                <Text
                  {...fixedText}
                  style={{
                    flexShrink: 1,
                    fontFamily: fonts.body,
                    fontSize: Math.max(15, v(16)),
                    lineHeight: Math.max(20, v(20)),
                    color: colors.muted,
                  }}
                >
                  {option}
                </Text>
              </View>
            ))}
          </View>
        ) : null}
        {onEdit && product.modifier_groups.length ? (
          <Animated.View
            style={{
              marginTop: 'auto',
              alignSelf: 'flex-start',
              transform: [{ scale: editPress.scale }],
            }}
          >
            <Pressable
              testID={leaving ? undefined : 'kiosk-cart-edit-' + position}
              accessibilityRole="button"
              accessibilityLabel={`${t.edit}: ${product.name}`}
              accessibilityState={{ disabled: busy }}
              disabled={busy}
              onPress={onEdit}
              onPressIn={editPress.onPressIn}
              onPressOut={editPress.onPressOut}
              style={{
                minHeight: Math.max(44, v(46)),
                paddingLeft: v(14),
                paddingRight: v(18),
                borderRadius: 999,
                borderWidth: 2,
                borderColor: '#E3E9F5',
                flexDirection: 'row',
                alignItems: 'center',
                gap: v(8),
                opacity: busy ? 0.45 : 1,
              }}
            >
              <Icon name="pencil-outline" size="small" tone="accent" />
              <Text
                {...fixedText}
                style={{
                  fontFamily: fonts.bold,
                  fontSize: Math.max(15, v(16)),
                  color: colors.navy,
                }}
              >
                {t.edit}
              </Text>
            </Pressable>
          </Animated.View>
        ) : null}
      </View>
      <View
        style={{
          alignItems: 'flex-end',
          justifyContent: 'space-between',
          gap: v(12),
          paddingTop: v(6),
          paddingRight: v(4),
        }}
      >
        <Text
          {...fixedText}
          numberOfLines={1}
          style={{
            fontFamily: fonts.black,
            fontSize: v(27),
            letterSpacing: -0.3,
            color: colors.navy,
            fontVariant: ['tabular-nums'],
          }}
        >
          {money(line.lineTotalMinor)}
        </Text>
        {line.quantity > 1 ? (
          // Price per item, so the line total explains itself.
          <Text
            {...fixedText}
            testID={id('-unit')}
            numberOfLines={1}
            style={{
              marginTop: -v(8),
              fontFamily: fonts.medium,
              fontSize: Math.max(15, v(15)),
              color: colors.muted,
              fontVariant: ['tabular-nums'],
            }}
          >
            {`${money(line.unitPriceMinor)} × ${line.quantity}`}
          </Text>
        ) : null}
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: v(6),
            padding: v(5),
            borderRadius: 999,
            backgroundColor: colors.soft,
          }}
        >
          <Animated.View style={{ transform: [{ scale: minusPress.scale }] }}>
            <Pressable
              testID={id('-minus')}
              accessibilityRole="button"
              accessibilityLabel={t.decrease}
              accessibilityState={{ disabled: busy }}
              disabled={busy}
              onPress={() => change(line.quantity - 1)}
              onPressIn={minusPress.onPressIn}
              onPressOut={minusPress.onPressOut}
              style={{
                width: step,
                height: step,
                borderRadius: step / 2,
                backgroundColor: colors.white,
                alignItems: 'center',
                justifyContent: 'center',
                opacity: busy ? 0.35 : 1,
              }}
            >
              <Icon name="remove" tone="navy" />
            </Pressable>
          </Animated.View>
          <Animated.Text
            {...fixedText}
            testID={id('-quantity')}
            style={{
              minWidth: v(30),
              textAlign: 'center',
              fontFamily: fonts.black,
              fontSize: v(23),
              color: colors.navy,
              fontVariant: ['tabular-nums'],
              opacity: tick.opacity,
              transform: [{ scale: tick.scale }],
            }}
          >
            {line.quantity}
          </Animated.Text>
          <Animated.View style={{ transform: [{ scale: plusPress.scale }] }}>
            <Pressable
              testID={id('-plus')}
              accessibilityRole="button"
              accessibilityLabel={t.increase}
              accessibilityState={{ disabled: busy || line.quantity >= max }}
              disabled={busy || line.quantity >= max}
              onPress={() => change(line.quantity + 1)}
              onPressIn={plusPress.onPressIn}
              onPressOut={plusPress.onPressOut}
              style={{
                width: step,
                height: step,
                borderRadius: step / 2,
                backgroundColor: colors.orange,
                alignItems: 'center',
                justifyContent: 'center',
                opacity: busy || line.quantity >= max ? 0.35 : 1,
              }}
            >
              <Icon name="add" tone="inverse" />
            </Pressable>
          </Animated.View>
        </View>
      </View>
    </Animated.View>
  );
}
