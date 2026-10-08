import { Animated, Pressable, Text, View } from 'react-native';
import { Image } from 'expo-image';
import type { KioskProduct } from '../model';
import { copy, displayCopy, type Locale } from '../i18n';
import { assets, productPhoto } from '../assets';
import { colors, fonts, useMetrics } from '../theme';
import { ProductArtwork } from './ProductArtwork';
import { useEnter } from './motion';
/**
 * v3 menu billboard: the featured combo on the illustrated cream banner with a
 * tilted orange "hit" tag. The photo floats in on mount; the tag pops after it.
 */
export function Billboard({
  product,
  locale,
  onOpen,
  testID = 'kiosk-billboard',
}: {
  product: KioskProduct;
  locale: Locale;
  onOpen: () => void;
  testID?: string;
}) {
  const { v } = useMetrics();
  const t = copy(locale);
  const float = useEnter(0, 900);
  const pop = useEnter(200, 480);
  const photo = productPhoto(product.image_id);
  const plate = v(224);
  return (
    <View
      style={{
        height: v(250),
        borderRadius: v(28),
        backgroundColor: '#F6F0E4',
        shadowColor: '#020A28',
        shadowOpacity: 0.25,
        shadowRadius: 30,
        shadowOffset: { width: 0, height: 14 },
        elevation: 8,
      }}
    >
      <Pressable
        testID={testID}
        accessibilityRole="button"
        // No override: the name comes from the visible tag, name and description
        // (WCAG 2.5.3 label in name).
        onPress={onOpen}
        style={({ pressed }) => ({
          flex: 1,
          borderRadius: v(28),
          overflow: 'hidden',
          transform: [{ scale: pressed ? 0.98 : 1 }],
        })}
      >
        <Image
          accessible={false}
          accessibilityLabel=""
          source={assets.billboard}
          contentFit="cover"
          style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 }}
        />
        <Animated.View
          style={{
            position: 'absolute',
            right: v(64),
            top: (v(250) - plate) / 2,
            width: plate,
            height: plate,
            borderRadius: plate / 2,
            backgroundColor: photo?.tile ?? colors.white,
            overflow: 'hidden',
            padding: v(24),
            opacity: float.interpolate({ inputRange: [0, 1], outputRange: [0.2, 1] }),
            transform: [
              { translateX: float.interpolate({ inputRange: [0, 1], outputRange: [v(50), 0] }) },
              { scale: float.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1] }) },
              { rotate: float.interpolate({ inputRange: [0, 1], outputRange: ['4deg', '0deg'] }) },
            ],
          }}
        >
          {photo ? (
            <Image
              accessible={false}
              accessibilityLabel=""
              source={photo.source}
              contentFit="contain"
              style={{ width: '100%', height: '100%' }}
            />
          ) : (
            <ProductArtwork imageId={product.image_id} variant="feature" />
          )}
        </Animated.View>
        <Animated.View
          style={{
            position: 'absolute',
            left: v(22),
            top: v(20),
            height: v(40),
            paddingHorizontal: v(16),
            borderRadius: v(12),
            backgroundColor: colors.orangeInk,
            justifyContent: 'center',
            shadowColor: colors.orange,
            shadowOpacity: 0.35,
            shadowRadius: 14,
            shadowOffset: { width: 0, height: 6 },
            opacity: pop.interpolate({ inputRange: [0, 0.4, 1], outputRange: [0, 1, 1] }),
            transform: [
              { rotate: '-4deg' },
              { scale: pop.interpolate({ inputRange: [0, 0.7, 1], outputRange: [0.3, 1.08, 1] }) },
            ],
          }}
        >
          <Text
            style={{
              fontFamily: fonts.black,
              fontSize: v(15),
              letterSpacing: 1.4,
              color: colors.white,
            }}
          >
            {t.hit}
          </Text>
        </Animated.View>
        <View
          style={{
            position: 'absolute',
            left: v(26),
            top: v(76),
            bottom: v(22),
            width: v(300),
            gap: v(6),
          }}
        >
          <Text
            numberOfLines={1}
            adjustsFontSizeToFit
            style={{
              fontFamily: fonts.black,
              fontSize: v(34),
              lineHeight: v(38),
              letterSpacing: -0.5,
              color: colors.navy,
            }}
          >
            {product.name}
          </Text>
          <Text
            numberOfLines={3}
            style={{
              fontFamily: fonts.body,
              fontSize: Math.max(15, v(15)),
              lineHeight: Math.max(21, v(21)),
              color: colors.muted,
            }}
          >
            {displayCopy(product.description)}
          </Text>
        </View>
      </Pressable>
    </View>
  );
}
