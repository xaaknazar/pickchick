import { useState } from 'react';
import { View } from 'react-native';
import { Image } from 'expo-image';
import { heroPhoto, optionPhoto, photoCandidates, productPhoto } from '../assets';
/**
 * A complete photograph (or the two Piko packs), within its owning component's stage.
 * A published remote photo comes first (disk-cached); if it cannot load, the bundled photo
 * for the same image key, then the mockup shot, then the logo is shown instead.
 */
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
  const chain =
    variant === 'option' && photo
      ? [photo.secondarySource ? [photo.source, photo.secondarySource] : [photo.source]]
      : photoCandidates(imageId, variant === 'hero' || variant === 'cart' ? 'hero' : 'card');
  // Failures are remembered per photo, so a newly published photo starts at the remote source.
  const chainKey = `${imageId}:${variant}:${photo?.sha256 ?? ''}`;
  const [failed, setFailed] = useState({ key: '', count: 0 });
  const step = Math.min(failed.key === chainKey ? failed.count : 0, chain.length - 1);
  const sources = chain[step]!;
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
          key={`${imageId}-${step}-${index}`}
          accessible={false}
          accessibilityLabel=""
          recyclingKey={
            step === 0 && photo?.sha256 ? photo.sha256 : `${imageId}-${variant}-${step}-${index}`
          }
          source={source}
          cachePolicy="disk"
          onError={() =>
            setFailed((current) => ({
              key: chainKey,
              count: Math.max(current.key === chainKey ? current.count : 0, step + 1),
            }))
          }
          contentFit={cover ? 'cover' : 'contain'}
          style={{ width: sources.length === 2 ? '50%' : '100%', height: '100%' }}
        />
      ))}
    </View>
  );
}
