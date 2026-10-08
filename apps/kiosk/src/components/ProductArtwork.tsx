import { View, StyleSheet } from 'react-native';
import { Image } from 'expo-image';
import { isDrinkArtwork, productImage } from '../assets';
import { colors, useMetrics } from '../theme';
import { Icon } from './Icon';
export function ProductArtwork({
  imageId,
  variant = 'tile',
}: {
  imageId: string;
  variant?: 'tile' | 'feature' | 'recommendation' | 'thumbnail' | 'rail' | 'option';
}) {
  const { px } = useMetrics();
  const small = variant === 'thumbnail' || variant === 'rail' || variant === 'option';
  const dim = px(variant === 'option' ? 64 : variant === 'rail' ? 72 : 124);
  const drink = isDrinkArtwork(imageId);
  return (
    <View
      testID={`kiosk-artwork-${imageId}-${variant}`}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        overflow: 'hidden',
        backgroundColor: colors.light,
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
      }}
    >
      {imageId === 'generic-drink' ? (
        <View style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center' }]}>
          <Icon name="water-outline" size={small ? 'regular' : 'hero'} tone="brand" />
        </View>
      ) : imageId === 'drink:piko' ? (
        <View
          style={{ flexDirection: 'row', width: '100%', height: '100%', padding: small ? 4 : 12 }}
        >
          {['drink:piko-apple', 'drink:piko-orange'].map((id) => (
            <Image
              key={id}
              accessible={false}
              accessibilityLabel=""
              source={productImage(id)}
              contentFit="contain"
              style={{ width: '50%', height: '100%' }}
            />
          ))}
        </View>
      ) : (
        <Image
          accessible={false}
          accessibilityLabel=""
          source={productImage(imageId)}
          recyclingKey={imageId}
          contentFit={drink ? 'contain' : 'cover'}
          style={
            drink
              ? { width: '100%', height: '100%' }
              : { width: '128%', height: '128%', marginLeft: '-14%', marginTop: '-14%' }
          }
        />
      )}
    </View>
  );
}
