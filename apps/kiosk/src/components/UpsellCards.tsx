import { glassSurface } from './glassSurface';
import { useMemo, type ReactNode } from 'react';
import {
  Animated,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from 'react-native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import type { KioskProduct } from '../model';
import type { UpsellBadgeKind } from '../smartUpsell';
import { money } from '../cart';
import { copy, displayCopy, type Locale } from '../i18n';
import { cardBackgroundRatio, cardBackgrounds, productArtworkId, productPhoto } from '../assets';
import { colors, fonts, redesign, useMetrics } from '../theme';
import { fixedText } from './Body';
import { Icon } from './Icon';
import { PhotoImage } from './PhotoImage';
import { ownerOrange } from './ownerOrange';
import { useEnter, usePress, usePulse, useTimingTo } from './motion';
/** A studio photo shot on (near) white multiplies onto the cream card, as on the menu. */
const lightTile = (tile: string) =>
  /^#[0-9A-F]{6}$/i.test(tile) &&
  [1, 3, 5].every((at) => parseInt(tile.slice(at, at + 2), 16) >= 0xf0);
/**
 * Smart upsell cards (kiosk redesign 2026-10-13, README §4), sizes in the 1024-pt layout:
 * - `UpsellHero`: the full-width suggestion on top (329 high): label at the corner, the photo on
 *   the left half, title (Montserrat 900 44), a short reason, price 40 and the round 70 toggle;
 * - `UpsellTile`: a row card (about 270 high). `tall` puts the photo on top with the name 24,
 *   price 28 and the 50 toggle; `wide` (the lemonade, or a row of one or two) puts a large photo
 *   on the left and name, description and price on the right.
 * Both are the cream menu card (#FEF8F0, radius 32, shadow 0 14 30 rgba(2,10,31,.25)). Only the
 * row tiles carry the bg1-bg4 illustration (190% from the top right); the hero is plain cream
 * (owner update of `images/upsell-*.webp`, product-and-payment.md). The whole card and the
 * round button toggle: the orange «+» adds one, and once in the order the card gets the green
 * 4-pt ring and a green check that takes it out again. Cards rise in after the header, squeeze
 * while pressed and pulse on a tap; all of it is static under reduced motion.
 */
export function UpsellHero({
  product,
  badge,
  title,
  body,
  added,
  busy,
  locale,
  onAdd,
  controls,
}: {
  product: KioskProduct;
  badge: UpsellBadgeKind;
  title: string;
  body: string;
  added: boolean;
  busy: boolean;
  locale: Locale;
  onAdd: () => void;
  controls?: ReactNode;
}) {
  const { px } = useMetrics();
  const toggle = Math.max(52, px(70));
  return (
    <Card
      testID="kiosk-upsell-hero"
      product={product}
      label={product.name}
      art={null}
      position={0}
      added={added}
      busy={busy}
      locale={locale}
      onAdd={onAdd}
      controls={controls}
      grow={0}
      minHeight={px(329)}
      toggle={toggle}
      inset={px(26)}
    >
      {(photo) => (
        <>
          {/* The design's photo is larger than the card: it bleeds past the top and bottom. */}
          {photo({
            position: 'absolute',
            left: '8%',
            width: '44%',
            top: px(28),
            bottom: px(28),
          })}
          <View
            style={{
              flex: 1,
              marginLeft: '53%',
              paddingTop: px(30),
              paddingRight: px(26),
              paddingBottom: px(26),
              justifyContent: 'flex-end',
            }}
          >
            <Text
              {...fixedText}
              numberOfLines={2}
              style={{
                fontFamily: fonts.black,
                fontSize: px(44),
                lineHeight: px(53),
                letterSpacing: -0.5,
                color: redesign.cardInk,
              }}
            >
              {title}
            </Text>
            <Text
              {...fixedText}
              numberOfLines={2}
              style={{
                marginTop: px(8),
                fontFamily: fonts.body,
                fontSize: Math.max(14, px(18)),
                lineHeight: Math.max(19, px(25)),
                color: redesign.cardMuted,
              }}
            >
              {body}
            </Text>
            <View
              style={{
                marginTop: px(16),
                minHeight: toggle,
                paddingRight: controls ? 0 : toggle + px(12),
                justifyContent: 'center',
              }}
            >
              <Price minor={product.price_minor} size={40} />
            </View>
          </View>
          <Badge kind={badge} locale={locale} placement="corner" />
        </>
      )}
    </Card>
  );
}
export function UpsellTile({
  product,
  name,
  badge = null,
  description,
  layout = 'tall',
  art = 1,
  position = 1,
  added,
  busy,
  locale,
  onAdd,
  controls,
}: {
  product: KioskProduct;
  /** The short name the design gives the tile («Фирменный», «Холодный чай»). */
  name: string;
  badge?: UpsellBadgeKind | null;
  description?: string;
  layout?: 'tall' | 'wide';
  /** Card illustration bg1-bg4 (i % 4). */
  art?: number;
  /** Order on the screen: staggers the rise. */
  position?: number;
  added: boolean;
  busy: boolean;
  locale: Locale;
  onAdd: () => void;
  controls?: ReactNode;
}) {
  const { px } = useMetrics();
  const toggle = Math.max(44, px(50));
  const wide = layout === 'wide';
  const nameText = (
    <Text
      {...fixedText}
      numberOfLines={2}
      style={{
        fontFamily: fonts.black,
        fontSize: px(24),
        lineHeight: px(29),
        letterSpacing: -0.3,
        color: redesign.cardInk,
      }}
    >
      {name}
    </Text>
  );
  const price = (
    <View
      style={{
        marginTop: px(wide ? 12 : 6),
        minHeight: toggle,
        paddingRight: controls ? 0 : toggle + px(10),
        justifyContent: 'center',
      }}
    >
      <Price minor={product.price_minor} size={28} />
    </View>
  );
  return (
    <Card
      testID={'kiosk-upsell-tile-' + product.id}
      product={product}
      label={name}
      art={art}
      position={position}
      added={added}
      busy={busy}
      locale={locale}
      onAdd={onAdd}
      controls={controls}
      grow={0}
      minHeight={px(342)}
      toggle={toggle}
      inset={px(20)}
    >
      {(photo) =>
        wide ? (
          <>
            {photo({
              position: 'absolute',
              left: -px(34),
              top: px(34),
              bottom: px(4),
              aspectRatio: 1,
            })}
            <View
              style={{
                flex: 1,
                marginLeft: '43%',
                paddingTop: px(60),
                paddingRight: px(20),
                paddingBottom: px(20),
                justifyContent: 'flex-end',
              }}
            >
              {nameText}
              {description ? (
                <Text
                  {...fixedText}
                  numberOfLines={2}
                  style={{
                    marginTop: px(6),
                    fontFamily: fonts.body,
                    fontSize: Math.max(13, px(16)),
                    lineHeight: Math.max(17, px(21)),
                    color: redesign.cardMuted,
                  }}
                >
                  {description}
                </Text>
              ) : null}
              {price}
            </View>
            {badge ? (
              <Badge
                kind={badge}
                locale={locale}
                placement={badge === 'lemonade' ? 'inset' : 'corner'}
              />
            ) : null}
          </>
        ) : (
          <>
            {photo({
              height: px(150),
              flexShrink: 0,
              marginTop: px(18),
              marginHorizontal: px(22),
              marginBottom: px(6),
            })}
            <View style={{ paddingHorizontal: px(20), paddingBottom: px(20) }}>
              {nameText}
              {price}
            </View>
            {badge ? <Badge kind={badge} locale={locale} placement="corner" /> : null}
          </>
        )
      }
    </Card>
  );
}
/**
 * Shared card: entrance, shadow, the cream clip with its illustration, the whole-card toggle,
 * the round toggle and the green ring. `children` lays out the inside and places `photo`, which
 * multiplies onto the cream (it must stay a direct layer of the clip on the web, where every
 * view is its own stacking context).
 */
function Card({
  testID,
  product,
  label,
  art,
  position,
  added,
  busy,
  locale,
  onAdd,
  controls,
  grow,
  minHeight,
  toggle,
  inset,
  children,
}: {
  testID: string;
  product: KioskProduct;
  label: string;
  /** Illustration bg1-bg4 (i % 4), or null for the plain cream hero. */
  art: number | null;
  position: number;
  added: boolean;
  busy: boolean;
  locale: Locale;
  onAdd: () => void;
  controls?: ReactNode;
  grow: number;
  minHeight?: number;
  toggle: number;
  inset: number;
  children: (photo: (place: ViewStyle) => ReactNode) => ReactNode;
}) {
  const { px } = useMetrics();
  const t = copy(locale);
  const rise = useEnter(160 + Math.min(position, 8) * 55, 520);
  const press = usePress(0.97);
  const pulse = usePulse(0.94, 1.03, 360, 'out');
  const scale = useMemo(() => Animated.multiply(press.scale, pulse.scale), [press, pulse]);
  const ring = useTimingTo(added ? 1 : 0, 200, 'css');
  const radius = px(32);
  const imageId = productArtworkId(product);
  const shot = productPhoto(imageId);
  const blend = !shot || lightTile(shot.tile);
  const tap = () => {
    pulse.play();
    onAdd();
  };
  const shadow = (
    Platform.OS === 'web'
      ? { boxShadow: `0 ${px(14)}px ${px(30)}px ${redesign.cardShadow}` }
      : {
          shadowColor: '#020A1F',
          shadowOpacity: 0.25,
          shadowRadius: px(15),
          shadowOffset: { width: 0, height: px(14) },
          elevation: 8,
        }
  ) as ViewStyle;
  // A direct layer of the clip, so its multiply sees the cream and the illustration.
  const photo = (place: ViewStyle) => (
    <View
      style={[
        place,
        {
          borderRadius: blend ? 0 : px(20),
          overflow: 'hidden',
          backgroundColor: shot?.cutout ? 'transparent' : (shot?.tile ?? colors.white),
          zIndex: 1,
        },
      ]}
    >
      <PhotoImage imageId={imageId} />
    </View>
  );
  return (
    <Animated.View
      testID={testID}
      style={{
        // A row tile fills its column; the hero keeps its 329 and takes a share of spare height.
        flexGrow: grow,
        flexShrink: 0,
        flexBasis: 'auto',
        width: '100%',
        minHeight,
        opacity: rise,
        transform: [
          { translateY: rise.interpolate({ inputRange: [0, 1], outputRange: [px(28), 0] }) },
          { scale },
        ],
      }}
    >
      <View style={[{ flex: 1, borderRadius: radius, backgroundColor: redesign.cream }, shadow]}>
        <Pressable
          testID={'kiosk-upsell-' + product.id}
          accessibilityRole="button"
          // Named by its visible texts (label, name, price), so speech input matches them.
          accessibilityState={{ selected: added, disabled: busy }}
          disabled={busy}
          onPress={tap}
          onPressIn={press.onPressIn}
          onPressOut={press.onPressOut}
          style={{
            flex: 1,
            borderRadius: radius,
            overflow: 'hidden',
            backgroundColor: redesign.cream,
          }}
        >
          {art === null ? null : (
            <Image
              accessible={false}
              accessibilityLabel=""
              source={cardBackgrounds[art % cardBackgrounds.length]}
              contentFit="cover"
              style={{
                position: 'absolute',
                right: 0,
                top: 0,
                width: '190%',
                aspectRatio: cardBackgroundRatio,
              }}
            />
          )}
          {children(photo)}
        </Pressable>
        {controls ?? (
          <Toggle
            testID={'kiosk-upsell-plus-' + product.id}
            label={(added ? t.removeOne + ': ' : '+ ') + label}
            added={added}
            busy={busy}
            size={toggle}
            inset={inset}
            scale={pulse.scale}
            onPress={tap}
          />
        )}
      </View>
      <Animated.View
        pointerEvents="none"
        style={{
          position: 'absolute',
          left: -Math.max(3, px(4)),
          right: -Math.max(3, px(4)),
          top: -Math.max(3, px(4)),
          bottom: -Math.max(3, px(4)),
          borderRadius: radius + Math.max(3, px(4)),
          borderWidth: Math.max(3, px(4)),
          borderColor: redesign.added,
          opacity: ring,
        }}
      />
    </Animated.View>
  );
}
/** Round orange «+» that turns into a green check (and spins once) when the item is added. */
function Toggle({
  testID,
  label,
  added,
  busy,
  size,
  inset,
  scale,
  onPress,
}: {
  testID: string;
  label: string;
  added: boolean;
  busy: boolean;
  size: number;
  inset: number;
  scale: Animated.AnimatedInterpolation<number>;
  onPress: () => void;
}) {
  const { px } = useMetrics();
  const press = usePress(0.9);
  const green = useTimingTo(added ? 1 : 0, 220, 'css');
  const turn = useTimingTo(added ? 1 : 0, 300, 'spring');
  const both = useMemo(() => Animated.multiply(press.scale, scale), [press, scale]);
  const glow = (
    Platform.OS === 'web'
      ? {
          boxShadow: added
            ? `0 ${px(8)}px ${px(20)}px rgba(46,158,91,.35)`
            : `0 ${px(10)}px ${px(26)}px ${redesign.ctaShadow}`,
        }
      : {
          shadowColor: added ? redesign.added : redesign.cta,
          shadowOpacity: 0.45,
          shadowRadius: px(13),
          shadowOffset: { width: 0, height: px(10) },
        }
  ) as ViewStyle;
  return (
    <Animated.View
      style={{
        position: 'absolute',
        right: inset,
        bottom: inset,
        transform: [
          { scale: both },
          { rotate: turn.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] }) },
        ],
      }}
    >
      <Pressable
        testID={testID}
        {...(added ? {} : ownerOrange)}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ selected: added, disabled: busy }}
        disabled={busy}
        onPress={onPress}
        onPressIn={press.onPressIn}
        onPressOut={press.onPressOut}
        style={[
          {
            width: size,
            height: size,
            borderRadius: size / 2,
            ...glassSurface('accent'),
            alignItems: 'center',
            justifyContent: 'center',
            opacity: busy ? 0.7 : 1,
          },
          glow,
        ]}
      >
        <Animated.View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            { borderRadius: size / 2, backgroundColor: redesign.added, opacity: green },
          ]}
        />
        <Icon name={added ? 'checkmark' : 'add'} tone="inverse" />
      </Pressable>
    </Animated.View>
  );
}
/** «2 390 ₸»: Montserrat 900 amount with a smaller tenge sign, on the card ink. */
function Price({ minor, size }: { minor: string; size: number }) {
  const { px } = useMetrics();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: px(5) }}>
      <Text
        {...fixedText}
        numberOfLines={1}
        style={{
          fontFamily: fonts.black,
          fontSize: px(size),
          lineHeight: px(size * 1.2),
          letterSpacing: -0.4,
          color: redesign.cardInk,
          fontVariant: ['tabular-nums'],
        }}
      >
        {money(minor).replace(/\s₸$/, '')}
      </Text>
      <Text
        {...fixedText}
        style={{
          fontFamily: fonts.heavy,
          fontSize: px(size * 0.7),
          color: redesign.cardInk,
        }}
      >
        ₸
      </Text>
    </View>
  );
}
/**
 * Card labels: «ХИТ», «ОСТРО» and the pairing labels on the red gradient (135°, #FF3B1F →
 * #D7141A), «НОВЫЙ» on brand blue, «НАШ ЛИМОНАД» on lemonade yellow with navy text. Montserrat
 * 800 14 with 0.1 em tracking. `corner` sits flush in the card's top-left corner (the card's
 * rounding clips it), `inset` 20 pt in from it.
 */
function Badge({
  kind,
  locale,
  placement,
}: {
  kind: UpsellBadgeKind;
  locale: Locale;
  placement: 'corner' | 'inset';
}) {
  const { px } = useMetrics();
  const t = copy(locale);
  const label: Record<UpsellBadgeKind, string> = {
    hit: t.hitTag,
    hot: t.smartTagHot,
    new: t.smartTagNew,
    lemonade: t.smartTagLemonade,
    toFingers: t.smartTagToFingers,
    toBurger: t.smartTagToBurger,
  };
  const red = kind !== 'new' && kind !== 'lemonade';
  const at = placement === 'corner' ? 0 : px(20);
  return (
    <View
      pointerEvents="none"
      testID={'kiosk-upsell-badge-' + kind}
      style={{
        position: 'absolute',
        left: at,
        top: at,
        height: Math.max(26, px(31)),
        paddingHorizontal: px(14),
        borderRadius: 999,
        overflow: 'hidden',
        justifyContent: 'center',
        backgroundColor: red
          ? redesign.hit[1]
          : kind === 'new'
            ? redesign.newBadge
            : redesign.lemonadeBadge,
      }}
    >
      {red ? (
        <LinearGradient
          colors={redesign.hit}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
      ) : null}
      <Text
        {...fixedText}
        numberOfLines={1}
        style={{
          fontFamily: fonts.heavy,
          fontSize: Math.max(12, px(14)),
          letterSpacing: Math.max(1.2, px(1.4)),
          color: kind === 'lemonade' ? redesign.cardInk : colors.white,
        }}
      >
        {displayCopy(label[kind])}
      </Text>
    </View>
  );
}
