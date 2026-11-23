import { useState } from 'react';
import { Animated, Pressable, Text, View } from 'react-native';
import { Image } from 'expo-image';
import type { KioskProduct, KioskSelection } from '../model';
import { copy, displayCopy, type Locale } from '../i18n';
import { productCopy } from '../productCopy';
import { fitTitle } from '../menu-presentation';
import { compositionPills, hasNutrition, productBadge, servingLine } from '../product-presentation';
import {
  cardBackgroundRatio,
  cardBackgrounds,
  heroPhoto,
  productArtworkId,
  productPhoto,
  shownPhotoBounds,
} from '../assets';
import { colors, fonts, redesign, useMetrics } from '../theme';
import { Badge } from './Badge';
import { PhotoImage } from './PhotoImage';
import { useEnter, usePress } from './motion';
import { fixedText } from './Body';
/** A studio photo shot on (near) white: it multiplies onto the cream like the design. */
const lightTile = (tile: string) =>
  /^#[0-9A-F]{6}$/i.test(tile) &&
  [1, 3, 5].every((at) => parseInt(tile.slice(at, at + 2), 16) >= 0xf0);
/** Share of the hero given to the photo (design: text from x 533 of 1024; 0.54 since owner 23.11). */
const PHOTO = 0.54;
/** Hero height in design points (design 380). */
const HERO_HEIGHT = 424;
/**
 * Product card hero (kiosk redesign 2026-10-13, product-and-payment.md §1): a cream #FEF8F0
 * card (radius 32, shadow 0 14 30 navy .25, at least 380 high) on the bg1 illustration. The
 * photo sits on the left (contain, multiplied onto the cream where the platform blends); on the
 * right the label (ХИТ НЕДЕЛИ and the like), the name in Montserrat 900 52 (stepping down to 36
 * rather than breaking a word), the composition as white 36-pt pills, the «520 г · 1240 ккал»
 * line and the outline «КБЖУ и состав ›» button. A description that is prose, not a list, is
 * shown as text instead of pills.
 */
export function ComboHero({
  product,
  selections = [],
  locale,
  onDetails,
}: {
  product: KioskProduct;
  selections?: readonly KioskSelection[];
  locale: Locale;
  /** The «КБЖУ и состав» button: the nutrition and ingredients sheet. */
  onDetails: () => void;
}) {
  const { px } = useMetrics();
  const t = copy(locale);
  const tp = productCopy(locale);
  const enter = useEnter(60, 520);
  const details = usePress(0.95);
  const imageId = productArtworkId(product, selections);
  const largePick = product.id === 'pick-combo';
  const shot = largePick ? heroPhoto(imageId) : productPhoto(imageId);
  // A published photo on a coloured backdrop keeps that backdrop instead of multiplying.
  const blend = !shot || lightTile(shot.tile);
  const fitted = !!shownPhotoBounds(imageId, largePick ? 'hero' : 'card');
  const badge = productBadge(product.id);
  const pills = compositionPills(product.ingredients || product.description);
  const [column, setColumn] = useState(0);
  const title = fitTitle(product.name, column, px(52), px(36), 2);
  const description = pills.length ? '' : displayCopy(product.description);
  return (
    <Animated.View
      testID="kiosk-product-hero"
      style={{
        // Owner 23.11.2026 «комбо увеличивай»: taller than the design's 380 for a bigger dish,
        // still on one screen with the drinks and sauces.
        minHeight: px(HERO_HEIGHT),
        borderRadius: px(32),
        backgroundColor: redesign.cream,
        shadowColor: '#020A1F',
        shadowOpacity: 0.25,
        shadowRadius: px(15),
        shadowOffset: { width: 0, height: px(14) },
        opacity: enter,
        transform: [
          { translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [24, 0] }) },
        ],
      }}
    >
      <View
        style={{
          flex: 1,
          flexDirection: 'row',
          borderRadius: px(32),
          overflow: 'hidden',
          backgroundColor: redesign.cream,
        }}
      >
        <Image
          accessible={false}
          accessibilityLabel=""
          source={cardBackgrounds[0]}
          contentFit="cover"
          pointerEvents="none"
          style={{
            position: 'absolute',
            top: 0,
            right: 0,
            width: '160%',
            aspectRatio: cardBackgroundRatio,
          }}
        />
        <View
          style={{
            width: `${PHOTO * 100}%`,
            // Owner 23.11.2026: «фото по больше на странице комбо» - the dish takes the whole
            // left half, scaled past the photo's own white (or clear 5 %) margin.
            paddingVertical: px(largePick ? 0 : 6),
            paddingLeft: px(largePick ? 8 : 10),
            paddingRight: px(largePick ? 8 : 0),
            // A direct layer of the clip, so its multiply sees the cream and the illustration
            // (every web view is its own stacking context).
            zIndex: 1,
          }}
        >
          <View
            style={{
              flex: 1,
              minHeight: px(HERO_HEIGHT - 80),
              borderRadius: blend ? 0 : px(24),
              overflow: 'hidden',
              backgroundColor: blend ? 'transparent' : (shot?.tile ?? redesign.cream),
            }}
          >
            <View
              style={{
                flex: 1,
                transform: [{ scale: fitted || largePick ? 1 : shot?.cutout ? 1 / 0.9 : 1.12 }],
              }}
            >
              <PhotoImage imageId={imageId} variant={largePick ? 'hero' : 'card'} fit={fitted} />
            </View>
          </View>
        </View>
        <View
          onLayout={(event) => setColumn(Math.round(event.nativeEvent.layout.width - px(40)))}
          style={{
            flex: 1,
            minWidth: 0,
            justifyContent: 'center',
            gap: px(14),
            paddingTop: px(32),
            paddingBottom: px(32),
            paddingLeft: px(4),
            paddingRight: px(36),
          }}
        >
          {badge ? <Badge label={t[badge.label]} tone={badge.tone} shape="tag" /> : null}
          <Text
            {...fixedText}
            accessibilityRole="header"
            numberOfLines={title.lines}
            style={{
              fontFamily: fonts.black,
              fontSize: title.size,
              lineHeight: Math.round(title.size * 1.12),
              letterSpacing: -title.size * 0.012,
              color: redesign.cardInk,
            }}
          >
            {product.name}
          </Text>
          {pills.length ? (
            <View
              testID="kiosk-product-composition"
              accessibilityRole="text"
              accessibilityLabel={pills.join(', ')}
              style={{ flexDirection: 'row', flexWrap: 'wrap', gap: px(8) }}
            >
              {pills.map((item) => (
                <View
                  key={item}
                  style={{
                    height: px(36),
                    paddingHorizontal: px(16),
                    borderRadius: 999,
                    backgroundColor: colors.white,
                    justifyContent: 'center',
                    shadowColor: '#020A1F',
                    shadowOpacity: 0.08,
                    shadowRadius: px(4),
                    shadowOffset: { width: 0, height: px(2) },
                  }}
                >
                  <Text
                    {...fixedText}
                    numberOfLines={1}
                    style={{
                      fontFamily: fonts.medium,
                      fontSize: px(16),
                      lineHeight: px(20),
                      color: redesign.cardInk,
                    }}
                  >
                    {item}
                  </Text>
                </View>
              ))}
            </View>
          ) : description ? (
            <Text
              {...fixedText}
              numberOfLines={3}
              style={{
                fontFamily: fonts.body,
                fontSize: px(17),
                lineHeight: px(24),
                color: redesign.cardMuted,
              }}
            >
              {description}
            </Text>
          ) : null}
          <View
            style={{
              flexDirection: 'row',
              flexWrap: 'wrap',
              alignItems: 'center',
              columnGap: px(12),
              rowGap: px(8),
              marginTop: px(2),
            }}
          >
            <Text
              {...fixedText}
              testID="kiosk-product-nutrition"
              numberOfLines={1}
              style={{
                fontFamily: fonts.medium,
                fontSize: px(16),
                lineHeight: px(20),
                color: redesign.cardMuted,
                fontVariant: ['tabular-nums'],
              }}
            >
              {servingLine(product, t.kcal)}
            </Text>
            {/* Owner 23.11.2026: no KBJU button while KBJU is zeros; the ingredients alone
                still open the sheet under «Состав». */}
            {hasNutrition(product) || product.ingredients?.trim() ? (
              <Animated.View style={{ transform: [{ scale: details.scale }] }}>
                <Pressable
                  testID="kiosk-product-details-open"
                  accessibilityRole="button"
                  accessibilityLabel={hasNutrition(product) ? tp.nutritionButton : t.ingredients}
                  onPress={onDetails}
                  onPressIn={details.onPressIn}
                  onPressOut={details.onPressOut}
                  hitSlop={px(8)}
                  style={{
                    height: px(36),
                    paddingHorizontal: px(14),
                    borderRadius: 999,
                    borderWidth: Math.max(1, px(1.5)),
                    borderColor: 'rgba(21,33,58,.18)',
                    backgroundColor: 'rgba(255,255,255,.7)',
                    flexDirection: 'row',
                    alignItems: 'center',
                  }}
                >
                  <Text
                    {...fixedText}
                    numberOfLines={1}
                    style={{
                      fontFamily: fonts.heavy,
                      fontSize: px(14),
                      lineHeight: px(18),
                      color: redesign.cardInk,
                    }}
                  >
                    {(hasNutrition(product) ? tp.nutritionButton : t.ingredients) + ' ›'}
                  </Text>
                </Pressable>
              </Animated.View>
            ) : null}
          </View>
        </View>
      </View>
    </Animated.View>
  );
}
