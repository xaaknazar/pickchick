import { glassSurface } from './glassSurface';
import { useRef, useState } from 'react';
import { Animated, Pressable, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { money } from '../cart';
import type { KioskProduct } from '../model';
import { copy, type Locale } from '../i18n';
import { assets, productArtworkId, productPhoto } from '../assets';
import { fitTitle } from '../menu-presentation';
import { colors, fonts, redesign, useMetrics } from '../theme';
import { Badge } from './Badge';
import { PhotoImage } from './PhotoImage';
import { useEnter, usePopIn, usePress } from './motion';
import { noteProductOrigin } from './reveal';
import { fixedText } from './Body';
import { ownerOrange } from './ownerOrange';
/** Share of the tile's width given to the product photo (right side). */
const PHOTO = 0.56;
/**
 * The section's hit, the first and full-width tile of the bento menu (kiosk redesign
 * 2026-10-13, README section 3): the illustrated cream banner (billboard-master) with the
 * product photo on the right 56 % (contain, multiplied onto the banner like the design), and
 * on the left the red label (turned -2deg), the name (Montserrat 900, 46), the price (38) and
 * the orange "Выбрать". Tapping the tile opens the product; "Выбрать" adds it (or opens it when
 * it has choices, decided by the menu). On arrival the photo floats in and the label pops
 * (static under reduced motion); a blue badge counts the units already in the bag.
 */
export function Billboard({
  product,
  label,
  locale,
  busy = false,
  inCart = 0,
  arriving = false,
  onOpen,
  onAdd,
  testID = 'kiosk-billboard',
}: {
  product: KioskProduct;
  /** The hit's label in the guest's language («ХИТ НЕДЕЛИ», «ФИРМЕННЫЙ» ...). */
  label: string;
  locale: Locale;
  busy?: boolean;
  inCart?: number;
  /** Its photo is still flying to the bag: the count waits for the landing. */
  arriving?: boolean;
  onOpen: () => void;
  onAdd: () => void;
  testID?: string;
}) {
  const { px } = useMetrics();
  const t = copy(locale);
  // Begin only when visible; short, non-overshooting arrivals do not compete with the cover.
  const float = useEnter(0, 640);
  const pop = useEnter(100, 380);
  const choose = usePress(0.95);
  const tile = useRef<View>(null);
  const imageId = productArtworkId(product);
  const shot = productPhoto(imageId);
  // A published photo on a coloured backdrop keeps it (rounded) instead of multiplying.
  const tinted = !!shot && !/^#F/i.test(shot.tile);
  const unavailable = product.available === false;
  const blocked = busy || unavailable;
  const amount = money(product.price_minor).replace(/\s₸$/, '');
  // Long catalog names («Фирменный лимонад 0.5 л») step down so two lines hold them, never
  // breaking a word or ending in an ellipsis.
  const [width, setWidth] = useState(0);
  const column = width * (1 - PHOTO + 0.02) - px(28);
  const title = fitTitle(product.name, width ? column : 0, px(46), px(30));
  return (
    <View
      testID={testID}
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      style={{
        flex: 1,
        borderRadius: px(32),
        backgroundColor: '#F6F0E4',
        shadowColor: '#020A1F',
        shadowOpacity: 0.25,
        shadowRadius: px(15),
        shadowOffset: { width: 0, height: px(14) },
        elevation: 8,
      }}
    >
      <View style={{ flex: 1, borderRadius: px(32), overflow: 'hidden' }}>
        <Pressable
          ref={tile}
          testID={'kiosk-product-' + product.id}
          accessibilityRole="button"
          accessibilityLabel={`${label}. ${product.name}, ${money(product.price_minor)}`}
          onPress={onOpen}
          // The product page opens as a circle from the tile.
          onPressIn={() => noteProductOrigin(tile.current)}
          style={({ pressed }) => ({
            position: 'absolute',
            left: 0,
            right: 0,
            top: 0,
            bottom: 0,
            backgroundColor: '#F6F0E4',
            transform: [{ scale: pressed ? 0.99 : 1 }],
          })}
        >
          <Image
            accessible={false}
            accessibilityLabel=""
            source={assets.billboard}
            contentFit="cover"
            contentPosition="right bottom"
            style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 }}
          />
          <Animated.View
            style={{
              position: 'absolute',
              right: px(12),
              top: px(14),
              bottom: px(14),
              width: `${PHOTO * 100}%`,
              // The white studio shot melts into the banner (design multiply).
              mixBlendMode: tinted ? 'normal' : 'multiply',
              backgroundColor: tinted ? shot.tile : undefined,
              borderRadius: tinted ? px(28) : 0,
              overflow: 'hidden',
              opacity: float.interpolate({
                inputRange: [0, 1],
                outputRange: [0.2, unavailable ? 0.45 : 1],
              }),
              transform: [
                { translateX: float.interpolate({ inputRange: [0, 1], outputRange: [px(60), 0] }) },
                { scale: float.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1] }) },
                {
                  rotate: float.interpolate({ inputRange: [0, 1], outputRange: ['4deg', '0deg'] }),
                },
              ],
            }}
          >
            <PhotoImage imageId={imageId} />
          </Animated.View>
        </Pressable>
        <View
          pointerEvents="box-none"
          style={{
            position: 'absolute',
            left: px(28),
            top: px(24),
            width: `${(1 - PHOTO) * 100 + 2}%`,
            gap: px(8),
          }}
        >
          <Animated.View
            pointerEvents="none"
            style={{
              alignSelf: 'flex-start',
              opacity: pop.interpolate({
                inputRange: [0, 1],
                outputRange: [0, 1],
                extrapolate: 'clamp',
              }),
              transform: [
                { scale: pop.interpolate({ inputRange: [0, 1], outputRange: [0.3, 1] }) },
              ],
            }}
          >
            <Badge label={label} shape="tag" />
          </Animated.View>
          <Text
            {...fixedText}
            pointerEvents="none"
            numberOfLines={title.lines}
            style={{
              fontFamily: fonts.black,
              fontSize: title.size,
              lineHeight: Math.round(title.size * 1.06),
              letterSpacing: -0.5,
              color: redesign.cardInk,
            }}
          >
            {product.name}
          </Text>
          <View pointerEvents="box-none" style={{ alignItems: 'flex-start', gap: px(12) }}>
            <View
              pointerEvents="none"
              testID="kiosk-billboard-price"
              style={{ flexDirection: 'row', alignItems: 'baseline', gap: px(5) }}
            >
              <Text
                {...fixedText}
                numberOfLines={1}
                style={{
                  fontFamily: fonts.black,
                  fontSize: px(38),
                  letterSpacing: -0.5,
                  color: redesign.cardInk,
                  fontVariant: ['tabular-nums'],
                }}
              >
                {amount}
              </Text>
              <Text
                {...fixedText}
                style={{ fontFamily: fonts.heavy, fontSize: px(24), color: redesign.cardInk }}
              >
                ₸
              </Text>
            </View>
            <Animated.View style={{ transform: [{ scale: choose.scale }] }}>
              <Pressable
                testID={'kiosk-product-plus-' + product.id}
                {...ownerOrange}
                accessibilityRole="button"
                accessibilityLabel={t.pick + ': ' + product.name}
                accessibilityState={{ disabled: blocked }}
                disabled={blocked}
                onPress={onAdd}
                onPressIn={() => {
                  choose.onPressIn();
                  noteProductOrigin(tile.current);
                }}
                onPressOut={choose.onPressOut}
                style={{
                  height: Math.max(48, px(54)),
                  paddingHorizontal: px(24),
                  borderRadius: 999,
                  ...glassSurface('accent'),
                  justifyContent: 'center',
                  opacity: blocked ? 0.4 : 1,
                  shadowColor: redesign.cta,
                  shadowOpacity: blocked ? 0 : 0.5,
                  shadowRadius: px(13),
                  shadowOffset: { width: 0, height: px(10) },
                }}
              >
                <Text
                  {...fixedText}
                  numberOfLines={1}
                  style={{ fontFamily: fonts.heavy, fontSize: px(19), color: colors.white }}
                >
                  {t.pick}
                </Text>
              </Pressable>
            </Animated.View>
          </View>
          {unavailable ? (
            <Text
              {...fixedText}
              pointerEvents="none"
              style={{ fontFamily: fonts.medium, fontSize: px(16), color: colors.error }}
            >
              {t.unavailableShort}
            </Text>
          ) : null}
        </View>
      </View>
      {inCart > 0 ? <Count count={inCart} hold={arriving} /> : null}
    </View>
  );
}
/** Blue count of the units already in the bag; pops when it changes, waits while `hold`. */
function Count({ count, hold }: { count: number; hold: boolean }) {
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
