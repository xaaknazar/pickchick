import { View } from 'react-native';
import { Image } from 'expo-image';
import { heroPhoto, optionPhoto, productImage, productPhoto } from '../assets';
/** A complete photograph (or the two Piko packs), within its owning component's stage. */
export function PhotoImage({
  imageId,
  variant = 'card',
}: {
  imageId: string;
  variant?: 'card' | 'hero' | 'option' | 'cart';
}) {
  const photo =
    variant === 'option'
      ? optionPhoto(imageId)
      : variant === 'hero' || variant === 'cart'
        ? heroPhoto(imageId)
        : productPhoto(imageId);
  const sources = photo?.secondarySource
    ? [photo.source, photo.secondarySource]
    : [photo?.source ?? productImage(imageId)];
  const cover = variant === 'cart' && photo && !photo.cutout && /^#0/.test(photo.tile);
  return (
    <View
      testID={`kiosk-photo-${variant}-${imageId}`}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ width: '100%', height: '100%', flexDirection: 'row' }}
    >
      {sources.map((source, index) => (
        <Image
          key={`${imageId}-${index}`}
          accessible={false}
          accessibilityLabel=""
          recyclingKey={`${imageId}-${variant}-${index}`}
          source={source}
          contentFit={cover ? 'cover' : 'contain'}
          style={{ width: sources.length === 2 ? '50%' : '100%', height: '100%' }}
        />
      ))}
    </View>
  );
}
