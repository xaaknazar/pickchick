import { useRef, useState } from 'react';
import { Animated, Pressable, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { PhotoImage } from './PhotoImage';
import { money } from '../cart';
import type { KioskProduct } from '../model';
import { copy, displayCopy, type Locale } from '../i18n';
import { cardBackgroundRatio, cardBackgrounds, productPhoto, productArtworkId } from '../assets';
import { colors, fonts, useMetrics } from '../theme';
import { Icon } from './Icon';
import { ProductArtwork } from './ProductArtwork';
import { usePopIn, usePress, useTimingTo } from './motion';
import { noteProductOrigin } from './reveal';
import { useMotionPreference } from './useMotionPreference';
import { fixedText } from './Body';
/** A studio photo shot on (near) white: it multiplies onto the cream card like the design. */
const lightTile = (tile: string) =>
  /^#[0-9A-F]{6}$/i.test(tile) &&
  [1, 3, 5].every((at) => parseInt(tile.slice(at, at + 2), 16) >= 0xf0);
/**
 * v3 menu card (approved iPad v3 design, `.card`): a cream #FEF8F0 card; combo, duo
 * and set cards carry the bg1-bg4 illustration (by position, right-top at 190%) with
 * the photo inset 34/10/0 on it. White studio photos multiply onto the cream, as the
 * design's `mix-blend-mode: multiply`; a photo on a coloured tile keeps that tile. Name, two-line
 * description, big price and a peach "pick" pill (the quick-add path).
 * The card squeezes to 0.96 with an orange ring while pressed, and a blue
 * badge counts how many are already in the bag.
 */
export function ProductCard({
  product,
  onOpen,
  onAdd,
  prefix = 'kiosk-product',
  busy = false,
  variant = 'catalog',
  locale = 'ru',
  tag,
  inCart = 0,
  arriving = false,
  index = 0,
  illustrated = false,
}: {
  product: KioskProduct;
  onOpen: () => void;
  onAdd: () => void;
  prefix?: string;
  busy?: boolean;
  variant?: 'catalog' | 'recommendation';
  locale?: Locale;
  tag?: 'hit' | 'new';
  /** Units of this product already in the bag (the blue count badge). */
  inCart?: number;
  /** Its photo is still flying to the bag: the badge waits for the landing. */
  arriving?: boolean;
  /** Position in its category: picks the illustration (i % 4). */
  index?: number;
  /** Combo, duo and set cards carry the card illustration. */
  illustrated?: boolean;
}) {
  const { v } = useMetrics();
  const t = copy(locale);
  const reduced = useMotionPreference();
  const [pressed, setPressed] = useState(false);
  // Prototype `.card:active`: the card squeezes over 150 ms (CSS ease) with the
  // orange ring, while the photo zooms to 1.05 over 500 ms on --ease.
  const squeeze = useTimingTo(pressed && !reduced ? 1 : 0, 150, 'css');
  const zoom = useTimingTo(pressed && !reduced ? 1 : 0, 500, 'ease');
  const ring = useTimingTo(pressed ? 1 : 0, 150, 'css');
  const imageId = productArtworkId(product);
  const photo = productPhoto(imageId);
  const blend = !photo || lightTile(photo.tile);
  const tile = blend ? colors.cream : photo.tile;
  const unavailable = product.available === false;
  const blocked = busy || unavailable;
  const amount = money(product.price_minor).replace(/\s₸$/, '');
  const compact = variant === 'recommendation';
  const art = illustrated && blend && !compact;
  const pick = usePress(0.94);
  // The product page opens as a circle from this card's centre.
  const card = useRef<View>(null);
  const hold = () => {
    setPressed(true);
    noteProductOrigin(card.current);
  };
  return (
    <Animated.View
      ref={card}
      style={{
        flex: 1,
        borderRadius: v(28),
        backgroundColor: tile,
        shadowColor: '#020A28',
        shadowOpacity: 0.22,
        shadowRadius: 26,
        shadowOffset: { width: 0, height: 12 },
        elevation: 6,
        transform: [{ scale: squeeze.interpolate({ inputRange: [0, 1], outputRange: [1, 0.96] }) }],
      }}
    >
      <View style={{ flex: 1, borderRadius: v(28), overflow: 'hidden' }}>
        {art ? <Illustration index={index} /> : null}
        <Pressable
          testID={prefix + '-' + product.id}
          accessibilityRole="button"
          onPress={onOpen}
          onPressIn={hold}
          onPressOut={() => setPressed(false)}
        >
          {photo ? (
            <View
              style={{
                width: '100%',
                // Design `aspect-ratio:1/1; padding:34px 10px 0` (content box): a square
                // photo inset 10 pt at the sides and 34 pt from the top.
                aspectRatio: art ? undefined : compact ? 1.6 : 1,
                paddingTop: art ? v(34) : 0,
                paddingHorizontal: art ? v(10) : 0,
                backgroundColor: tile,
                overflow: 'hidden',
              }}
            >
              {/* The photo multiplies onto its own backdrop: the same illustration, aligned
                  with the card's (every web view is its own stacking context). */}
              {art ? <Illustration index={index} /> : null}
              <Animated.View
                style={{
                  ...(art ? { width: '100%', aspectRatio: 1 } : { flex: 1 }),
                  mixBlendMode: blend ? 'multiply' : 'normal',
                  transform: [
                    {
                      scale: zoom.interpolate({ inputRange: [0, 1], outputRange: [1, 1.05] }),
                    },
                  ],
                }}
              >
                <PhotoImage imageId={imageId} />
              </Animated.View>
            </View>
          ) : (
            <ProductArtwork imageId={imageId} variant={compact ? 'recommendation' : 'tile'} />
          )}
          {tag ? (
            <View
              style={{
                position: 'absolute',
                left: v(14),
                top: v(14),
                height: v(30),
                paddingHorizontal: v(12),
                borderRadius: v(15),
                backgroundColor: tag === 'new' ? colors.sky : colors.peach,
                justifyContent: 'center',
              }}
            >
              <Text
                {...fixedText}
                style={{
                  fontFamily: fonts.heavy,
                  fontSize: v(12),
                  letterSpacing: 0.8,
                  color: tag === 'new' ? colors.blue : colors.orangeInk,
                }}
              >
                {tag === 'new' ? t.newTag : t.hitTag}
              </Text>
            </View>
          ) : null}
          <View style={{ paddingTop: v(2), paddingHorizontal: v(16), gap: v(6) }}>
            <Text
              {...fixedText}
              numberOfLines={2}
              style={{
                fontFamily: fonts.heavy,
                fontSize: v(21),
                lineHeight: v(25),
                color: colors.navy,
              }}
            >
              {product.name}
            </Text>
            <Text
              {...fixedText}
              numberOfLines={compact ? 1 : 2}
              style={{
                fontFamily: fonts.body,
                fontSize: Math.max(14, v(14)),
                lineHeight: Math.max(20, v(20)),
                color: colors.muted,
              }}
            >
              {displayCopy(product.description)}
            </Text>
          </View>
        </Pressable>
        <View
          style={{
            marginTop: 'auto',
            paddingTop: v(10),
            paddingBottom: v(14),
            paddingLeft: v(16),
            paddingRight: v(14),
            flexDirection: 'row',
            alignItems: 'center',
            gap: v(10),
          }}
        >
          <Pressable
            accessible={false}
            importantForAccessibility="no"
            onPress={onOpen}
            onPressIn={hold}
            onPressOut={() => setPressed(false)}
            style={{ flex: 1, minWidth: 0 }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: v(4) }}>
              <Text
                {...fixedText}
                numberOfLines={1}
                style={{
                  fontFamily: fonts.black,
                  fontSize: v(26),
                  lineHeight: v(28),
                  letterSpacing: -0.4,
                  color: colors.navy,
                  fontVariant: ['tabular-nums'],
                }}
              >
                {amount}
              </Text>
              <Text
                {...fixedText}
                style={{ fontFamily: fonts.heavy, fontSize: v(18), color: colors.muted }}
              >
                ₸
              </Text>
            </View>
            {unavailable ? (
              <Text
                {...fixedText}
                style={{
                  fontFamily: fonts.medium,
                  fontSize: Math.max(13, v(13)),
                  color: colors.error,
                }}
              >
                {t.unavailableShort}
              </Text>
            ) : null}
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
                // "Pick" opens the page for products with choices.
                noteProductOrigin(card.current);
              }}
              onPressOut={pick.onPressOut}
              style={{
                minHeight: Math.max(44, v(44)),
                paddingLeft: v(16),
                paddingRight: v(10),
                borderRadius: 999,
                backgroundColor: colors.peach,
                flexDirection: 'row',
                alignItems: 'center',
                gap: v(2),
                opacity: blocked ? 0.45 : 1,
              }}
            >
              <Text
                {...fixedText}
                style={{ fontFamily: fonts.heavy, fontSize: v(16), color: colors.orangeInk }}
              >
                {t.pick}
              </Text>
              <Icon name="chevron-forward" size="small" tone="deep" />
            </Pressable>
          </Animated.View>
        </View>
      </View>
      <Animated.View
        pointerEvents="none"
        style={{
          position: 'absolute',
          left: -v(4),
          right: -v(4),
          top: -v(4),
          bottom: -v(4),
          borderRadius: v(32),
          borderWidth: v(4),
          borderColor: colors.orange,
          opacity: ring,
        }}
      />
      {inCart > 0 ? <InBag count={inCart} hold={arriving} /> : null}
    </Animated.View>
  );
}
/** Design card background: bg1-bg4 by position, `right top / 190% auto no-repeat`. */
function Illustration({ index }: { index: number }) {
  return (
    <Image
      accessible={false}
      accessibilityLabel=""
      source={cardBackgrounds[index % cardBackgrounds.length]}
      contentFit="cover"
      style={{
        position: 'absolute',
        right: 0,
        top: 0,
        width: '190%',
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
  const { v } = useMetrics();
  const pop = usePopIn(hold ? 'hold' : count);
  return (
    <Animated.View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      aria-hidden
      style={{
        position: 'absolute',
        right: v(14),
        top: v(14),
        minWidth: v(36),
        height: v(36),
        paddingHorizontal: v(10),
        borderRadius: v(18),
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
        style={{ fontFamily: fonts.black, fontSize: v(16), color: colors.white }}
      >
        {count}
      </Text>
    </Animated.View>
  );
}
