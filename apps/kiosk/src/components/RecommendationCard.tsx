import { Animated, Pressable, Text, View } from 'react-native';
import { Image } from 'expo-image';
import type { KioskProduct } from '../model';
import { money } from '../cart';
import { copy, type Locale } from '../i18n';
import { productImage, productPhoto, type Photo } from '../assets';
import { colors, fonts, useMetrics } from '../theme';
import { Icon } from './Icon';
import { usePop, useStagger } from './motion';
/**
 * v3 "С этим часто берут" card: white 26-pt card, 150-pt photo on its own tile,
 * name and orange price. The round orange + on the photo turns green with a check
 * (and pops) once the product is in the cart; the card gains a green ring.
 */
export function RecommendationCard({
  product,
  position,
  added,
  busy,
  locale,
  onAdd,
}: {
  product: KioskProduct;
  position: number;
  added: boolean;
  busy: boolean;
  locale: Locale;
  onAdd: () => void;
}) {
  const { v } = useMetrics();
  const t = copy(locale);
  const rise = useStagger(position);
  const pop = usePop(added);
  const photo: Photo = productPhoto(product.image_id) ?? {
    source: productImage(product.image_id),
    tile: colors.cream,
    cutout: false,
  };
  const blocked = busy || product.available === false;
  const badge = Math.max(48, v(52));
  return (
    <Animated.View
      testID={'kiosk-recommendation-' + product.id}
      style={{
        flexGrow: 1,
        opacity: rise,
        transform: [
          { translateY: rise.interpolate({ inputRange: [0, 1], outputRange: [v(34), 0] }) },
          { scale: rise.interpolate({ inputRange: [0, 1], outputRange: [0.97, 1] }) },
        ],
        borderRadius: v(26),
        backgroundColor: colors.white,
        shadowColor: '#020A28',
        shadowOpacity: 0.2,
        shadowRadius: 22,
        shadowOffset: { width: 0, height: 10 },
        elevation: 6,
      }}
    >
      <Pressable
        testID={'kiosk-upsell-' + product.id}
        accessibilityRole="button"
        onPress={onAdd}
        style={({ pressed }) => ({
          flexGrow: 1,
          paddingTop: v(10),
          paddingHorizontal: v(10),
          paddingBottom: v(14),
          gap: v(10),
          transform: [{ scale: pressed ? 0.97 : 1 }],
        })}
      >
        <View
          style={{
            height: v(150),
            borderRadius: v(20),
            backgroundColor: photo.tile,
            padding: photo.cutout ? v(14) : 0,
            overflow: 'hidden',
          }}
        >
          <Image
            accessible={false}
            accessibilityLabel=""
            source={photo.source}
            contentFit="contain"
            style={{ width: '100%', height: '100%' }}
          />
        </View>
        <View style={{ gap: v(2), paddingHorizontal: v(6) }}>
          <Text
            numberOfLines={2}
            style={{
              fontFamily: fonts.medium,
              fontSize: Math.max(15, v(16)),
              lineHeight: Math.max(19, v(20)),
              color: colors.navy,
            }}
          >
            {product.name}
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: v(10) }}>
            <Text
              style={{
                fontFamily: fonts.heavy,
                fontSize: Math.max(19, v(18)),
                color: colors.orangeInk,
                fontVariant: ['tabular-nums'],
              }}
            >
              {money(product.price_minor)}
            </Text>
            <Text
              accessibilityLiveRegion="polite"
              numberOfLines={1}
              style={{
                flexShrink: 1,
                fontFamily: fonts.bold,
                fontSize: Math.max(15, v(15)),
                color: colors.ok,
              }}
            >
              {added ? t.selected : ' '}
            </Text>
          </View>
        </View>
      </Pressable>
      <Animated.View
        style={{
          position: 'absolute',
          right: v(18),
          top: v(10) + v(150) - v(8) - badge,
          transform: [{ scale: pop }],
        }}
      >
        <Pressable
          testID={'kiosk-upsell-plus-' + product.id}
          accessibilityRole="button"
          accessibilityLabel={'+ ' + product.name}
          accessibilityState={{ disabled: blocked }}
          disabled={blocked}
          onPress={onAdd}
          style={({ pressed }) => ({
            width: badge,
            height: badge,
            borderRadius: badge / 2,
            backgroundColor: added ? colors.ok : colors.orange,
            alignItems: 'center',
            justifyContent: 'center',
            shadowColor: '#04143A',
            shadowOpacity: 0.3,
            shadowRadius: 14,
            shadowOffset: { width: 0, height: 6 },
            elevation: 4,
            opacity: blocked ? 0.6 : 1,
            transform: [{ scale: pressed ? 0.9 : 1 }],
          })}
        >
          <Icon name={added ? 'checkmark' : 'add'} tone="inverse" />
        </Pressable>
      </Animated.View>
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: 0,
          bottom: 0,
          borderRadius: v(26),
          borderWidth: 3,
          borderColor: added ? colors.ok : 'transparent',
        }}
      />
    </Animated.View>
  );
}
