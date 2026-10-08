import { Animated, View, StyleSheet } from 'react-native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { heroPhoto, productImage, productPhoto, type Photo } from '../assets';
import { colors, useMetrics } from '../theme';
import { Icon } from './Icon';
import { useEnter } from './motion';
import { PhotoImage } from './PhotoImage';
/**
 * Product photography. `hero` is the v3 product-page stage: the photo sits on its own
 * tile colour (blue studio shot for combos, warm tile for singles) and scales in once.
 * Other variants show the v3 card photo on its tile, or the original mockup shot.
 */
export function ProductArtwork({
  imageId,
  variant = 'tile',
}: {
  imageId: string;
  variant?: 'hero' | 'tile' | 'feature' | 'recommendation' | 'thumbnail' | 'rail' | 'option';
}) {
  const { px, v } = useMetrics();
  const hero = variant === 'hero';
  const enter = useEnter(0, hero ? 760 : 0);
  const photo: Photo | null = hero ? heroPhoto(imageId) : productPhoto(imageId);
  if (hero) {
    const tile = photo?.tile ?? colors.cream;
    const size = v(photo?.cutout ? 520 : 600);
    // Blue studio heroes (#0...) get soft side fades so the photo edge never shows.
    const blue = !!photo && !photo.cutout && /^#0/.test(tile);
    return (
      <View
        testID={`kiosk-artwork-${imageId}-${variant}`}
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{
          height: v(600),
          width: '100%',
          backgroundColor: tile,
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
        }}
      >
        <Animated.View
          style={{
            width: size,
            height: size,
            opacity: enter.interpolate({ inputRange: [0, 1], outputRange: [0.3, 1] }),
            transform: [
              { scale: enter.interpolate({ inputRange: [0, 1], outputRange: [0.85, 1] }) },
              {
                rotate: enter.interpolate({ inputRange: [0, 1], outputRange: ['-5deg', '0deg'] }),
              },
            ],
          }}
        >
          {imageId === 'generic-drink' && !photo ? (
            <View
              style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center' }]}
            >
              <Icon name="water-outline" size="hero" tone="brand" />
            </View>
          ) : (
            <PhotoImage imageId={imageId} variant="hero" />
          )}
          {blue ? (
            <>
              <LinearGradient
                pointerEvents="none"
                colors={[tile, tile + '00']}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 0 }}
                style={{ position: 'absolute', left: -1, top: 0, bottom: 0, width: size * 0.08 }}
              />
              <LinearGradient
                pointerEvents="none"
                colors={[tile + '00', tile]}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 0 }}
                style={{ position: 'absolute', right: -1, top: 0, bottom: 0, width: size * 0.08 }}
              />
            </>
          ) : null}
        </Animated.View>
        {blue ? (
          // Melt the studio floor into the bright blue body below the stage.
          <LinearGradient
            pointerEvents="none"
            colors={[tile + '00', colors.blueBright]}
            style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: v(90) }}
          />
        ) : null}
      </View>
    );
  }
  const small = variant === 'thumbnail' || variant === 'rail' || variant === 'option';
  const dim = px(variant === 'option' ? 64 : variant === 'rail' ? 72 : 124);
  return (
    <View
      testID={`kiosk-artwork-${imageId}-${variant}`}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        overflow: 'hidden',
        backgroundColor: photo?.tile ?? colors.light,
        borderRadius: variant === 'rail' ? 12 : 16,
        width: small ? dim : '100%',
        height: small ? dim : undefined,
        aspectRatio: small
          ? undefined
          : variant === 'recommendation'
            ? 1.8
            : variant === 'feature'
              ? 1.6
              : 1.35,
        flexShrink: 0,
        padding: photo?.cutout ? (small ? 6 : 12) : 0,
      }}
    >
      {photo ? (
        <PhotoImage imageId={imageId} />
      ) : imageId === 'generic-drink' ? (
        <View style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center' }]}>
          <Icon name="water-outline" size={small ? 'regular' : 'hero'} tone="brand" />
        </View>
      ) : (
        <Image
          accessible={false}
          accessibilityLabel=""
          source={productImage(imageId)}
          contentFit="cover"
          style={{ width: '128%', height: '128%', marginLeft: '-14%', marginTop: '-14%' }}
        />
      )}
    </View>
  );
}
