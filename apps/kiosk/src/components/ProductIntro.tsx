import { Children, type ReactNode } from 'react';
import { Animated, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import type { KioskProduct } from '../model';
import { copy, displayCopy, type Locale } from '../i18n';
import { colors, fonts, useMetrics } from '../theme';
import { productArtworkId } from '../assets';
import { ProductArtwork } from './ProductArtwork';
import { ProductNutrition } from './ProductNutrition';
import { useEnter } from './motion';
import { fixedText } from './Body';
/** Fade-up for each block of the product body (v3 .pbody > * cascade). */
function Rise({ index, children }: { index: number; children?: ReactNode }) {
  const enter = useEnter([0, 80, 140, 200, 250][Math.min(index, 4)], 520);
  return (
    <Animated.View
      style={{
        opacity: enter,
        transform: [
          { translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [22, 0] }) },
        ],
      }}
    >
      {children}
    </Animated.View>
  );
}
/**
 * v3 product page body: the photo stage (with the HIT tag for Pick Combo), then the
 * name, serving, description and KBJU tiles in white on blue. Children (option groups,
 * details) follow in the same padded column and fade up one after another.
 */
export function ProductIntro({
  product,
  locale,
  children,
}: {
  product: KioskProduct;
  locale: Locale;
  children?: ReactNode;
}) {
  const { v } = useMetrics();
  const t = copy(locale);
  // By id: the name is localized in the commercial catalog.
  const hit = product.id === 'pick-combo';
  // Prototype `.ptag`: pop (scale .3 -> 1, fade in) 500 ms after 380 ms, --spring.
  const tag = useEnter(380, 500, 'spring');
  return (
    <View testID="kiosk-product-intro">
      <View>
        <ProductArtwork imageId={productArtworkId(product)} variant="hero" />
        {hit ? (
          <Animated.View
            pointerEvents="none"
            style={{
              position: 'absolute',
              top: v(40),
              right: v(32),
              opacity: tag.interpolate({
                inputRange: [0, 1],
                outputRange: [0, 1],
                extrapolate: 'clamp',
              }),
              transform: [
                { rotate: '4deg' },
                { scale: tag.interpolate({ inputRange: [0, 1], outputRange: [0.3, 1] }) },
              ],
              backgroundColor: colors.orangeInk,
              borderRadius: v(11),
              paddingVertical: v(9),
              paddingHorizontal: v(14),
            }}
          >
            <Text
              {...fixedText}
              style={{
                fontFamily: fonts.black,
                fontSize: v(16),
                letterSpacing: 1.2,
                color: colors.white,
              }}
            >
              {t.hit}
            </Text>
          </Animated.View>
        ) : null}
      </View>
      <View
        style={{
          paddingTop: v(34),
          paddingHorizontal: v(36),
          paddingBottom: v(40),
          gap: v(34),
        }}
      >
        <LinearGradient
          pointerEvents="none"
          colors={[colors.blueBright, colors.blue]}
          style={{ position: 'absolute', left: 0, right: 0, top: 0, height: v(160) }}
        />
        <Rise index={0}>
          <View style={{ gap: v(12) }}>
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'baseline',
                justifyContent: 'space-between',
                gap: v(16),
              }}
            >
              <Text
                {...fixedText}
                accessibilityRole="header"
                style={{
                  flexShrink: 1,
                  fontFamily: fonts.black,
                  fontSize: v(48),
                  lineHeight: v(52),
                  letterSpacing: -0.8,
                  color: colors.white,
                }}
              >
                {product.name}
              </Text>
              <Text
                {...fixedText}
                style={{
                  fontFamily: fonts.medium,
                  fontSize: Math.max(15, v(18)),
                  color: 'rgba(255,255,255,.72)',
                }}
              >
                {product.serving_label}
              </Text>
            </View>
            {product.description ? (
              <Text
                {...fixedText}
                style={{
                  fontFamily: fonts.body,
                  fontSize: Math.max(17, v(20)),
                  lineHeight: Math.max(24, v(28)),
                  color: 'rgba(255,255,255,.85)',
                }}
              >
                {displayCopy(product.description)}
              </Text>
            ) : null}
            <View style={{ marginTop: v(6) }}>
              <ProductNutrition product={product} locale={locale} part="facts" />
            </View>
          </View>
        </Rise>
        {Children.toArray(children).map((child, index) => (
          <Rise key={(child as { key?: string }).key ?? index} index={index + 1}>
            {child}
          </Rise>
        ))}
      </View>
    </View>
  );
}
