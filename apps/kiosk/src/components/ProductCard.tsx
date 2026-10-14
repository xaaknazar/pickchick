import { glassSurface } from './glassSurface';
import { useRef, useState } from 'react';
import { Animated, Pressable, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { PhotoImage } from './PhotoImage';
import { money } from '../cart';
import type { KioskProduct } from '../model';
import { copy, displayCopy, type Locale } from '../i18n';
import { fitTitle, type BadgeKind, type CardSize } from '../menu-presentation';
import {
  cardBackgroundRatio,
  cardBackgrounds,
  heroPhoto,
  productArtworkId,
  productPhoto,
} from '../assets';
import { colors, fonts, redesign, useMetrics } from '../theme';
import { Badge } from './Badge';
import { usePopIn, usePress, useTimingTo } from './motion';
import { noteProductOrigin } from './reveal';
import { useMotionPreference } from './useMotionPreference';
import { fixedText } from './Body';
/** Share of a horizontal (`wide`) card given to its photo. */
const WIDE_PHOTO = 0.58;
/** A studio photo shot on (near) white: it multiplies onto the cream card like the design. */
const lightTile = (tile: string) =>
  /^#[0-9A-F]{6}$/i.test(tile) &&
  [1, 3, 5].every((at) => parseInt(tile.slice(at, at + 2), 16) >= 0xf0);
/**
 * Bento menu card (kiosk redesign 2026-10-13, README "Карточка позиции"): a cream #FEF8F0 card
 * (radius 32, shadow 0 14 30 navy .25) on one of the bg1-bg4 illustrations (by position,
 * right-top at 190 %). The photo takes all the room above the text strip (contain) and
 * multiplies onto the cream like the design's `mix-blend-mode: multiply`; a `wide` card puts
 * the photo on the left 58 % and the text on the right.
 * - `large`: name Montserrat 900 27, description 15/20, price 30, a 54 pt orange "+";
 * - `medium`: the same type without the description;
 * - `small` (3 columns) and `wide`: name 24, price 28, a 50 pt "+" (`wide` keeps one line of
 *   description).
 * Tapping the card opens the product; "+" adds it (or opens it when it has choices, decided by
 * the menu). The card squeezes to .96 with an orange ring while pressed, a blue badge counts
 * the units already in the bag, and a stopped product dims its photo and its "+".
 */
export function ProductCard({
  product,
  onOpen,
  onAdd,
  prefix = 'kiosk-product',
  busy = false,
  size = 'large',
  locale = 'ru',
  badge,
  inCart = 0,
  arriving = false,
  index = 0,
}: {
  product: KioskProduct;
  onOpen: () => void;
  onAdd: () => void;
  prefix?: string;
  busy?: boolean;
  size?: CardSize;
  locale?: Locale;
  badge?: BadgeKind;
  /** Units of this product already in the bag (the blue count badge). */
  inCart?: number;
  /** Its photo is still flying to the bag: the badge waits for the landing. */
  arriving?: boolean;
  /** Position in its section: picks the illustration (i % 4). */
  index?: number;
}) {
  const { px } = useMetrics();
  const t = copy(locale);
  const reduced = useMotionPreference();
  const [pressed, setPressed] = useState(false);
  // Prototype `.card:active`: the card squeezes over 150 ms (CSS ease) with the
  // orange ring, while the photo zooms to 1.05 over 500 ms on --ease.
  const squeeze = useTimingTo(pressed && !reduced ? 1 : 0, 150, 'css');
  const zoom = useTimingTo(pressed && !reduced ? 1 : 0, 500, 'ease');
  const ring = useTimingTo(pressed ? 1 : 0, 150, 'css');
  const imageId = productArtworkId(product);
  const largePick = product.id === 'pick-combo';
  const shot = largePick ? heroPhoto(imageId) : productPhoto(imageId);
  // A published photo on a coloured backdrop keeps that backdrop instead of multiplying.
  const blend = !shot || lightTile(shot.tile);
  const unavailable = product.available === false;
  const blocked = busy || unavailable;
  const amount = money(product.price_minor).replace(/\s₸$/, '');
  const wide = size === 'wide';
  const big = size === 'large' || size === 'medium';
  const describe = (size === 'large' || wide) && !!product.description;
  const plus = px(big ? 54 : 50);
  // The name steps down (to .8 of its size) rather than break a word or lose a line to an
  // ellipsis in a narrow column; a name that still does not fit gets a third line.
  const [cardWidth, setCardWidth] = useState(0);
  const column = cardWidth * (wide ? 1 - WIDE_PHOTO : 1) - px(wide ? 22 : 36);
  const base = px(big ? 27 : 24);
  const title = fitTitle(product.name, cardWidth ? column : 0, base, base * 0.8);
  const pick = usePress(0.92);
  // The product page opens as a circle from this card's centre.
  const card = useRef<View>(null);
  const hold = () => {
    setPressed(true);
    noteProductOrigin(card.current);
  };
  const badgeLabel =
    badge === 'hit'
      ? t.hitTag
      : badge === 'new'
        ? t.newTag
        : badge === 'spicy'
          ? t.spicyTag
          : badge === 'recipe'
            ? t.recipeTag
            : null;
  const photo = (
    <View
      style={{
        // The photo multiplies onto its own copy of the illustration, aligned with the card's
        // (every web view is its own stacking context).
        ...(wide ? { width: `${WIDE_PHOTO * 100}%` as const, height: '100%' } : { flex: 1 }),
        minHeight: 0,
        overflow: 'hidden',
        backgroundColor: shot?.cutout ? 'transparent' : blend ? colors.white : shot?.tile,
        paddingTop: px(largePick ? 4 : wide ? 18 : 20),
        paddingBottom: px(largePick ? 0 : wide ? 18 : 4),
        paddingHorizontal: px(largePick ? 6 : wide ? 18 : 14),
      }}
    >
      <Animated.View
        style={{
          flex: 1,
          zIndex: 1,
          opacity: unavailable ? 0.45 : 1,
          transform: [{ scale: zoom.interpolate({ inputRange: [0, 1], outputRange: [1, 1.05] }) }],
        }}
      >
        <PhotoImage imageId={imageId} variant={largePick ? 'hero' : 'card'} />
      </Animated.View>
    </View>
  );
  const name = (
    <Text
      {...fixedText}
      numberOfLines={title.lines}
      style={{
        fontFamily: fonts.black,
        fontSize: title.size,
        lineHeight: Math.round(title.size * 1.16),
        letterSpacing: -0.2,
        color: redesign.cardInk,
      }}
    >
      {product.name}
    </Text>
  );
  const note = unavailable ? (
    <Text
      {...fixedText}
      numberOfLines={1}
      style={{
        fontFamily: fonts.medium,
        fontSize: px(15),
        lineHeight: px(20),
        color: colors.error,
      }}
    >
      {t.unavailableShort}
    </Text>
  ) : describe ? (
    <Text
      {...fixedText}
      numberOfLines={2}
      style={{
        fontFamily: fonts.body,
        fontSize: px(15),
        lineHeight: px(20),
        color: redesign.cardMuted,
      }}
    >
      {displayCopy(product.description)}
    </Text>
  ) : null;
  return (
    <Animated.View
      ref={card}
      onLayout={(e) => setCardWidth(e.nativeEvent.layout.width)}
      style={{
        flex: 1,
        borderRadius: px(32),
        backgroundColor: redesign.cream,
        shadowColor: '#020A1F',
        shadowOpacity: 0.25,
        shadowRadius: px(15),
        shadowOffset: { width: 0, height: px(14) },
        elevation: 6,
        transform: [{ scale: squeeze.interpolate({ inputRange: [0, 1], outputRange: [1, 0.96] }) }],
      }}
    >
      <View style={{ flex: 1, borderRadius: px(32), overflow: 'hidden' }}>
        <Illustration index={index} part={1} />
        <Pressable
          testID={prefix + '-' + product.id}
          accessibilityRole="button"
          onPress={onOpen}
          onPressIn={hold}
          onPressOut={() => setPressed(false)}
          style={{ flex: 1, flexDirection: wide ? 'row' : 'column', minHeight: 0 }}
        >
          {photo}
          <View
            style={{
              ...(wide ? { flex: 1, justifyContent: 'flex-end' } : null),
              paddingTop: px(wide ? 0 : 2),
              paddingLeft: px(wide ? 4 : 18),
              paddingRight: px(18),
              // Room for the price row, which sits on its own at the bottom.
              paddingBottom: px(16) + plus + px(6),
              gap: px(4),
            }}
          >
            {name}
            {note}
          </View>
        </Pressable>
        <View
          pointerEvents="box-none"
          style={{
            position: 'absolute',
            left: wide ? `${WIDE_PHOTO * 100}%` : 0,
            right: 0,
            bottom: 0,
            paddingLeft: px(wide ? 4 : 18),
            paddingRight: px(16),
            paddingBottom: px(16),
            flexDirection: 'row',
            alignItems: 'center',
            gap: px(10),
          }}
        >
          <Pressable
            accessible={false}
            importantForAccessibility="no"
            onPress={onOpen}
            onPressIn={hold}
            onPressOut={() => setPressed(false)}
            style={{
              flex: 1,
              minWidth: 0,
              flexDirection: 'row',
              alignItems: 'baseline',
              gap: px(5),
            }}
          >
            <Text
              {...fixedText}
              numberOfLines={1}
              style={{
                fontFamily: fonts.black,
                fontSize: px(big ? 30 : 28),
                letterSpacing: -0.4,
                color: redesign.cardInk,
                fontVariant: ['tabular-nums'],
              }}
            >
              {amount}
            </Text>
            <Text
              {...fixedText}
              style={{
                fontFamily: fonts.heavy,
                fontSize: px(big ? 20 : 19),
                color: redesign.cardInk,
              }}
            >
              ₸
            </Text>
          </Pressable>
          <Animated.View style={{ transform: [{ scale: pick.scale }] }}>
            <Pressable
              testID={prefix + '-plus-' + product.id}
              accessibilityRole="button"
              accessibilityLabel={'+ ' + product.name + ', ' + t.pick}
              accessibilityState={{ disabled: blocked }}
              disabled={blocked}
              onPress={onAdd}
              onPressIn={() => {
                pick.onPressIn();
                // "+" opens the page for products with choices.
                noteProductOrigin(card.current);
              }}
              onPressOut={pick.onPressOut}
              hitSlop={px(8)}
              style={{
                width: plus,
                height: plus,
                borderRadius: plus / 2,
                ...glassSurface('accent'),
                alignItems: 'center',
                justifyContent: 'center',
                opacity: blocked ? 0.4 : 1,
                shadowColor: redesign.cta,
                shadowOpacity: blocked ? 0 : 0.5,
                shadowRadius: px(13),
                shadowOffset: { width: 0, height: px(10) },
              }}
            >
              <Plus size={big ? 22 : 20} />
            </Pressable>
          </Animated.View>
        </View>
      </View>
      {badgeLabel ? (
        <View pointerEvents="none" style={{ position: 'absolute', left: px(16), top: px(16) }}>
          <Badge label={badgeLabel} tone={badge === 'hit' ? 'hit' : 'new'} />
        </View>
      ) : null}
      <Animated.View
        pointerEvents="none"
        style={{
          position: 'absolute',
          left: -px(4),
          right: -px(4),
          top: -px(4),
          bottom: -px(4),
          borderRadius: px(36),
          borderWidth: px(4),
          borderColor: redesign.cta,
          opacity: ring,
        }}
      />
      {inCart > 0 ? <InBag count={inCart} hold={arriving} /> : null}
    </Animated.View>
  );
}
/** The bold white "+" of the design (two 3 pt bars); the icon font's plus is too thin. */
function Plus({ size }: { size: number }) {
  const { px } = useMetrics();
  const bar = { position: 'absolute' as const, borderRadius: px(2), backgroundColor: colors.white };
  return (
    <View pointerEvents="none" style={{ width: px(size), height: px(size) }}>
      <View style={{ ...bar, left: 0, right: 0, top: (px(size) - px(3)) / 2, height: px(3) }} />
      <View style={{ ...bar, top: 0, bottom: 0, left: (px(size) - px(3)) / 2, width: px(3) }} />
    </View>
  );
}
/**
 * Design card background: bg1-bg4 by position, `right top / 190% auto no-repeat` of the card.
 * `part` is the share of the card's width the owning view spans from the left, so the photo's
 * copy lines up with the card's own illustration.
 */
function Illustration({ index, part }: { index: number; part: number }) {
  const scale = 1.9 / part;
  return (
    <Image
      accessible={false}
      accessibilityLabel=""
      source={cardBackgrounds[index % cardBackgrounds.length]}
      contentFit="cover"
      style={{
        position: 'absolute',
        top: 0,
        right: part === 1 ? 0 : `${-((1 - part) / part) * 100}%`,
        width: `${scale * 100}%`,
        aspectRatio: cardBackgroundRatio,
      }}
    />
  );
}
/**
 * Prototype `.inbag`: blue count badge at the card's top-right that pops (420 ms
 * --spring, scale .3 -> 1) whenever the count changes. While `hold` it stays
 * hidden and pops on release. Decorative: the card's name is unchanged.
 */
function InBag({ count, hold }: { count: number; hold: boolean }) {
  const { px } = useMetrics();
  const pop = usePopIn(hold ? 'hold' : count);
  return (
    <Animated.View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      aria-hidden
      style={{
        position: 'absolute',
        right: px(16),
        top: px(16),
        minWidth: px(36),
        height: px(36),
        paddingHorizontal: px(10),
        borderRadius: px(18),
        backgroundColor: colors.blue,
        alignItems: 'center',
        justifyContent: 'center',
        shadowColor: colors.blue,
        shadowOpacity: 0.35,
        shadowRadius: 10,
        shadowOffset: { width: 0, height: 4 },
        opacity: hold ? 0 : pop.opacity,
        transform: [{ scale: pop.scale }],
      }}
    >
      <Text
        {...fixedText}
        style={{ fontFamily: fonts.black, fontSize: px(17), color: colors.white }}
      >
        {count}
      </Text>
    </Animated.View>
  );
}
