import type { ComponentProps } from 'react';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { tones, useMetrics, type Tone } from '../theme';
import { layero } from './layero';
export type IconName = ComponentProps<typeof Ionicons>['name'];
const mapped: Partial<Record<IconName, keyof typeof layero>> = {
  'arrow-forward': 'arrow-right',
  'arrow-back': 'arrow-left',
  checkmark: 'check',
  'fast-food-outline': 'hamburger',
  'restaurant-outline': 'bowl-food',
};
export function Icon({
  name,
  size = 'regular',
  tone = 'default',
}: {
  name: IconName;
  size?: 'small' | 'regular' | 'large' | 'hero';
  tone?: Tone;
}) {
  const { px } = useMetrics();
  const dim = px({ small: 22, regular: 30, large: 44, hero: 80 }[size]);
  const key = mapped[name];
  return key ? (
    <Image
      source={{
        uri:
          'data:image/svg+xml;utf8,' +
          encodeURIComponent(layero[key].replace(/currentColor|#000000|#000|black/g, tones[tone])),
      }}
      contentFit="contain"
      style={{ width: dim, height: dim }}
      accessible={false}
      accessibilityLabel=""
    />
  ) : (
    <Ionicons name={name} size={dim} color={tones[tone]} accessible={false} />
  );
}
