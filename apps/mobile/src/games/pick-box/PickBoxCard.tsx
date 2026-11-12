import type { ImageSourcePropType } from 'react-native';
import { useRouter } from 'expo-router';
import { useLocale } from '../../i18n';
import { GamePosterCard } from '../GamePosterCard';
import { pickBoxCopy } from './copy';

export const pickBoxCover =
  require('../../../assets/games/pick-box/cover-alex-2d.png') as ImageSourcePropType;
export function PickBoxCard() {
  const router = useRouter();
  const copy = pickBoxCopy(useLocale());
  return (
    <GamePosterCard
      name="Pick Box"
      subtitle={copy.subtitle}
      description={copy.description}
      cover={pickBoxCover}
      onPress={() => router.push('/games/pick-box')}
      testID="pick-box-open"
    />
  );
}
