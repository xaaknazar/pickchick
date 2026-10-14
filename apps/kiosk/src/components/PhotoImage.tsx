import { useState } from 'react';
import { View } from 'react-native';
import { Image } from 'expo-image';
import { heroPhoto, optionPhoto, photoCandidates, productPhoto, saucePhotoBounds } from '../assets';
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
  const [stage, setStage] = useState({ width: 0, height: 0 });
  const step = Math.min(failed.key === chainKey ? failed.count : 0, chain.length - 1);
  const sources = chain[step]!;
  const cup = sources.length === 1 ? saucePhotoBounds(sources[0]!) : undefined;
  // All four cups have the same visible width, centered by the food rather than the canvas.
  // Preserve the photograph's proportions and leave room for the tallest cup (h/w < .9).
  const cupSide = cup ? Math.min(stage.width * 0.9, stage.height / 0.9) / cup[2] : 0;
  const cover = variant === 'cart' && photo && !photo.cutout && /^#0/.test(photo.tile);
  return (
    <View
      testID={`kiosk-photo-${variant}-${imageId}`}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      onLayout={cup ? (event) => setStage(event.nativeEvent.layout) : undefined}
      style={{ width: '100%', height: '100%', flexDirection: 'row', overflow: 'hidden' }}
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
          cachePolicy="memory-disk"
          allowDownscaling={false}
          onError={() =>
            setFailed((current) => ({
              key: chainKey,
              count: Math.max(current.key === chainKey ? current.count : 0, step + 1),
            }))
          }
          contentFit={cover ? 'cover' : 'contain'}
          style={
            cup && cupSide > 0
              ? {
                  position: 'absolute',
                  width: cupSide,
                  height: cupSide,
                  left: stage.width / 2 - cupSide * (cup[0] + cup[2] / 2),
                  top: stage.height / 2 - cupSide * (cup[1] + cup[3] / 2),
                }
              : { width: sources.length === 2 ? '50%' : '100%', height: '100%' }
          }
        />
      ))}
    </View>
  );
}
