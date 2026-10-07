import { View, StyleSheet } from 'react-native';
import { Image } from 'expo-image';
import { productImage } from '../assets';
import { colors, useMetrics } from '../theme';
import { Icon } from './Icon';
export function ProductArtwork({
  imageId,
  variant = 'tile',
}: {
  imageId: string;
  variant?: 'tile' | 'feature' | 'recommendation' | 'thumbnail' | 'rail';
}) {
  const { px } = useMetrics();
  const small = variant === 'thumbnail' || variant === 'rail';
  const dim = px(variant === 'rail' ? 72 : 124);
  return (
    <View
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
      ) : (
        <Image
          source={productImage(imageId)}
          contentFit="cover"
          style={{ width: '128%', height: '128%', marginLeft: '-14%', marginTop: '-14%' }}
        />
      )}
    </View>
  );
}
