import { Image } from 'expo-image';
import { assets } from '../assets';
import { useMetrics } from '../theme';
/** The supplied Pick Chick sticker mark, transparent, on any v3 surface. */
export function Logo({ size = 'regular' }: { size?: 'regular' | 'large' | 'hero' }) {
  const { v } = useMetrics();
  const height = v(size === 'hero' ? 128 : size === 'large' ? 76 : 58);
  return (
    <Image
      source={assets.logo}
      contentFit="contain"
      style={{ height, width: Math.round(height * 1.08) }}
      accessibilityLabel="Pick Chick"
    />
  );
}
