import { useEffect, useRef, useState } from 'react';
import { Animated, Pressable, Text, View } from 'react-native';
import { PhotoImage } from './PhotoImage';
import { money } from '../cart';
import type { KioskProduct } from '../model';
import { copy, displayCopy, type Locale } from '../i18n';
import { productPhoto, productArtworkId } from '../assets';
import { colors, fonts, useMetrics } from '../theme';
import { Icon } from './Icon';
import { ProductArtwork } from './ProductArtwork';
import { motion } from './motion';
import { useMotionPreference } from './useMotionPreference';
/**
 * v3 menu card: full studio photo on its own tile colour, name, two-line
 * description, big price and a peach "pick" pill (the quick-add path).
 * The card squeezes to 0.96 with an orange ring while pressed.
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
}: {
  product: KioskProduct;
  onOpen: () => void;
  onAdd: () => void;
  prefix?: string;
  busy?: boolean;
  variant?: 'catalog' | 'recommendation';
  locale?: Locale;
  tag?: 'hit' | 'new';
}) {
  const { v } = useMetrics();
  const t = copy(locale);
  const reduced = useMotionPreference();
  const [pressed, setPressed] = useState(false);
  const squeeze = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const animation = Animated.timing(squeeze, {
      toValue: pressed && !reduced ? 1 : 0,
      duration: reduced ? 0 : motion.press,
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [pressed, reduced, squeeze]);
  const imageId = productArtworkId(product);
  const photo = productPhoto(imageId);
  const tile = photo?.tile ?? colors.cream;
  const unavailable = product.available === false;
  const blocked = busy || unavailable;
  const amount = money(product.price_minor).replace(/\s₸$/, '');
  const compact = variant === 'recommendation';
  return (
    <Animated.View
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
        <Pressable
          testID={prefix + '-' + product.id}
          accessibilityRole="button"
          onPress={onOpen}
          onPressIn={() => setPressed(true)}
          onPressOut={() => setPressed(false)}
        >
          {photo ? (
            <View
              style={{
                width: '100%',
                aspectRatio: compact ? 1.6 : 1,
                backgroundColor: tile,
                padding: photo.cutout ? v(22) : 0,
                overflow: 'hidden',
              }}
            >
              <Animated.View
                style={{
                  flex: 1,
                  transform: [
                    {
                      scale: squeeze.interpolate({ inputRange: [0, 1], outputRange: [1, 1.05] }),
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
                style={{
                  fontFamily: fonts.heavy,
                  fontSize: v(12),
                  letterSpacing: 0.8,
                  color: tag === 'new' ? colors.blue : colors.orangeInk,
                }}
              >
                {tag === 'new' ? (locale === 'ru' ? 'НОВИНКА' : 'ЖАҢА') : 'ХИТ'}
              </Text>
            </View>
          ) : null}
          <View style={{ paddingTop: v(2), paddingHorizontal: v(16), gap: v(6) }}>
            <Text
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
            onPressIn={() => setPressed(true)}
            onPressOut={() => setPressed(false)}
            style={{ flex: 1, minWidth: 0 }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: v(4) }}>
              <Text
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
              <Text style={{ fontFamily: fonts.heavy, fontSize: v(18), color: colors.muted }}>
                ₸
              </Text>
            </View>
            {unavailable ? (
              <Text
                style={{
                  fontFamily: fonts.medium,
                  fontSize: Math.max(13, v(13)),
                  color: colors.error,
                }}
              >
                Нет в наличии
              </Text>
            ) : null}
          </Pressable>
          <Pressable
            testID={prefix + '-plus-' + product.id}
            accessibilityRole="button"
            accessibilityLabel={'+ ' + product.name + ', ' + t.pick}
            accessibilityState={{ disabled: blocked }}
            disabled={blocked}
            onPress={onAdd}
            style={({ pressed: down }) => ({
              minHeight: Math.max(44, v(44)),
              paddingLeft: v(16),
              paddingRight: v(10),
              borderRadius: 999,
              backgroundColor: colors.peach,
              flexDirection: 'row',
              alignItems: 'center',
              gap: v(2),
              opacity: blocked ? 0.45 : 1,
              transform: [{ scale: down ? 0.94 : 1 }],
            })}
          >
            <Text style={{ fontFamily: fonts.heavy, fontSize: v(16), color: colors.orangeInk }}>
              {t.pick}
            </Text>
            <Icon name="chevron-forward" size="small" tone="deep" />
          </Pressable>
        </View>
      </View>
      <View
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
          opacity: pressed ? 1 : 0,
        }}
      />
    </Animated.View>
  );
}
